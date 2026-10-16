// Spotify Web API access (Authorization Code + PKCE, no server needed).
// Only playlist names and track lists are read; Spotify never provides audio files.

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';

const K = {
  client: 'stash.sp.client', verifier: 'stash.sp.verifier', state: 'stash.sp.state',
  access: 'stash.sp.access', refresh: 'stash.sp.refresh', expires: 'stash.sp.expires',
};
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

export const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
export const getClientId = () => lsGet(K.client) || '';
export const setClientId = id => lsSet(K.client, id.trim());
export const isConnected = () => !!lsGet(K.refresh);
export const hasPendingLogin = () => !!lsGet(K.verifier);

function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const v = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(v, x => chars[x % chars.length]).join('');
}

async function challengeFor(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function beginLogin() {
  const verifier = randomString(64);
  const state = randomString(16);
  lsSet(K.verifier, verifier);
  lsSet(K.state, state);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: getClientId(),
    scope: SCOPES,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    state,
  });
  location.href = `${AUTH_URL}?${q}`;
}

/**
 * Call on startup. Returns null when the page wasn't opened by a Spotify redirect,
 * {ok:true} once connected, {error} on failure, or {needsPaste, code} when this browser
 * context doesn't hold the login secret (iOS sometimes finishes the login in a separate
 * Safari view). The user then copies the code back into the home-screen app.
 */
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const error = q.get('error');
  if (!code && !error) return null;
  history.replaceState(null, '', location.pathname);
  if (error) return { error: error === 'access_denied' ? 'you cancelled the login' : error };
  if (lsGet(K.verifier) && q.get('state') === lsGet(K.state)) {
    await exchange(code);
    return { ok: true };
  }
  return { needsPaste: true, code };
}

export async function exchange(code) {
  const verifier = lsGet(K.verifier);
  if (!verifier) throw new Error('Start the connection again first');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
      client_id: getClientId(), code_verifier: verifier,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error_description || j.error || `Spotify error ${res.status}`);
  saveToken(j);
  lsSet(K.verifier, null);
  lsSet(K.state, null);
}

function saveToken(j) {
  lsSet(K.access, j.access_token);
  if (j.refresh_token) lsSet(K.refresh, j.refresh_token);
  lsSet(K.expires, String(Date.now() + (j.expires_in - 60) * 1000));
}

async function refresh() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: lsGet(K.refresh), client_id: getClientId() }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error('Spotify session expired');
    e.status = 401;
    if (j.error === 'invalid_grant') disconnect();
    throw e;
  }
  saveToken(j);
}

async function token() {
  if (!lsGet(K.access) || Date.now() > +lsGet(K.expires)) await refresh();
  return lsGet(K.access);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, retry = true) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
  if (res.status === 401 && retry) { await refresh(); return api(path, false); }
  if (res.status === 429 && retry) { await sleep((+res.headers.get('Retry-After') || 2) * 1000); return api(path, false); }
  if (!res.ok) {
    const e = new Error(`Spotify error ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

export function disconnect() {
  for (const k of [K.access, K.refresh, K.expires, K.verifier, K.state]) lsSet(k, null);
}

export const me = () => api('/me');

export async function playlists() {
  const out = [];
  let url = '/me/playlists?limit=50';
  while (url) {
    const j = await api(url);
    for (const p of j.items || []) {
      if (!p) continue;
      out.push({
        id: p.id,
        name: p.name,
        image: p.images?.[0]?.url || null,
        total: p.tracks?.total ?? p.items?.total ?? null,
        owner: p.owner?.display_name || '',
      });
    }
    url = j.next;
  }
  return out;
}

/** All tracks of a playlist ('liked' = the user's Liked Songs), as plain metadata. */
export async function playlistTracks(id, onProgress) {
  const candidates = id === 'liked'
    ? ['/me/tracks?limit=50']
    : [`/playlists/${id}/items?limit=100`, `/playlists/${id}/tracks?limit=100`];
  let j;
  for (const path of candidates) {
    try { j = await api(path); break; } catch (e) {
      if (path === candidates.at(-1) || e.status !== 404) throw e;
    }
  }
  const out = [];
  for (;;) {
    for (const it of j.items || []) {
      const t = it?.item || it?.track;
      if (!t || (t.type && t.type !== 'track')) continue;
      out.push({
        title: t.name || '',
        artists: (t.artists || []).map(a => a.name).filter(Boolean),
        album: t.album?.name || '',
        durationMs: t.duration_ms || 0,
        spId: t.id || null,
      });
    }
    onProgress?.(out.length);
    if (!j.next) break;
    j = await api(j.next);
  }
  return out;
}
