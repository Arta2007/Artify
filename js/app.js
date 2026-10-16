import * as db from './db.js';
import { readTags, withID3 } from './tags.js';
import * as sp from './spotify.js';
import { icon } from './icons.js';
import * as eng from './engine.js';
import { analyzeBlob } from './analysis.js';
import * as L from './lang.js';
import * as smart from './smart.js';
import { parseLyrics, activeLine } from './lyrics.js';
import { writeZip, readZip } from './zip.js';

const VERSION = '2.0.0';

// ---------- helpers ----------

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const { fold } = smart;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtLong = s => {
  const m = Math.round((s || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
};
const fmtBytes = b => {
  if (!b) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ls = {
  get(k, d) { try { const v = localStorage.getItem('stash.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stash.' + k, JSON.stringify(v)); } catch {} },
};
const hashStr = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const TILE_COLORS = ['#e13300', '#1e3264', '#8d67ab', '#e8115b', '#148a08', '#bc5900', '#509bf5', '#dc148c', '#477d95', '#ba5d07', '#0d73ec', '#8c1932', '#27856a', '#e91429', '#503750', '#7d4b32'];
const tileColor = s => TILE_COLORS[hashStr(s) % TILE_COLORS.length];
const today = () => new Date().toISOString().slice(0, 10);

const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff' };
const { extOf } = smart;
const isAudio = f => f.type.startsWith('audio/') || extOf(f.name) in MIME;
const isLyricsFile = f => /\.(lrc|txt)$/i.test(f.name);
const baseName = n => n.replace(/\.[^.]+$/, '').toLowerCase();

// ---------- settings ----------

const DEFAULTS = {
  enhanced: false, crossfade: 6, smartTransitions: true, skipSilence: true, leveling: true,
  eqMode: 'off', eqPreset: 'flat', eqCustom: new Array(10).fill(0), karaoke: false, effect: 'none',
  speed: 1, smartShuffle: true, aiLang: null,
};
const CFG = Object.assign({}, DEFAULTS, ls.get('settings', {}));
const saveCfg = () => ls.set('settings', CFG);

// ---------- state ----------

const S = {
  tracks: new Map(),
  playlists: new Map(),
  folders: [], // [{ id, name }] — playlists point to one with p.folderId
  history: [],
  tab: 'home',
  stacks: { home: [{ v: 'home' }], search: [{ v: 'search' }], library: [{ v: 'library' }] },
  libFilter: ls.get('libFilter', 'playlists'),
  query: '',
  queue: [],
  qi: -1,
  ctx: null,
  shuffle: ls.get('shuffle', false),
  repeat: ls.get('repeat', 'off'),
  unshuffled: null,
  recent: ls.get('recent', []),
  radio: null,
  loop: null, // { a, b }
  sleep: null, // { until } or { end: true }
  listen: null, // { id, sec, counted }
  lyrics: null, // { id, data }
  showLyrics: false,
  importing: false,
};

const SEP = ' ␟ ';
let ACTS = null;
function acts() {
  if (ACTS) return ACTS;
  ACTS = new Set();
  for (const t of S.tracks.values()) {
    if (t.albumArtist) ACTS.add(smart.normName(t.albumArtist));
    if (t.noSplit && t.artist) ACTS.add(smart.normName(t.artist));
  }
  return ACTS;
}
const artistsOf = t => smart.trackArtists(t, acts());
const artistOf = t => t.albumArtist || artistsOf(t)[0];
const albumKey = t => artistOf(t) + SEP + (t.album || 'Unknown album');
const byTrackNo = (a, b) => (a.disc || 0) - (b.disc || 0) || (a.track || 0) - (b.track || 0) || a.title.localeCompare(b.title);
const mixOrder = (a, b) => (b.liked ? 1 : 0) - (a.liked ? 1 : 0) || (b.plays || 0) - (a.plays || 0) || (b.added || 0) - (a.added || 0);

let D = null;
function derived() {
  if (D) return D;
  const all = [...S.tracks.values()].sort((a, b) => a.title.localeCompare(b.title));
  const albums = new Map();
  const artists = new Map();
  const genres = new Map();
  const families = new Map();
  const langs = new Map();
  const push = (m, k, t) => { if (!m.has(k)) m.set(k, []); m.get(k).push(t); };
  for (const t of all) {
    const ak = albumKey(t);
    if (!albums.has(ak)) albums.set(ak, { key: ak, title: t.album || 'Unknown album', artist: artistOf(t), year: '', tracks: [], artKey: null, added: 0 });
    const a = albums.get(ak);
    a.tracks.push(t);
    a.artKey ||= t.artKey;
    a.year ||= t.year;
    a.added = Math.max(a.added, t.added || 0);

    const prim = artistOf(t);
    for (const name of new Set([prim, ...artistsOf(t)])) {
      if (!artists.has(name)) artists.set(name, { name, artKey: null, main: [], feat: [] });
      const ar = artists.get(name);
      (name === prim ? ar.main : ar.feat).push(t);
      if (name === prim) ar.artKey ||= t.artKey;
    }
    for (const g of smart.splitGenres(t.genre)) {
      if (!genres.has(g)) genres.set(g, { name: g, artKey: null, count: 0 });
      const ge = genres.get(g);
      ge.artKey ||= t.artKey;
      ge.count++;
    }
    for (const f of smart.familiesOf(t)) push(families, f.id, t);
    if (t.lang?.code) push(langs, t.lang.code, t);
  }
  for (const a of albums.values()) {
    a.tracks.sort(byTrackNo);
    if (!a.tracks[0].album) a.title = a.tracks.length === 1 ? a.tracks[0].title : `${a.artist} (singles)`; // untagged singles
  }
  for (const a of artists.values()) {
    a.count = a.main.length + a.feat.length;
    a.artKey ||= a.feat.find(t => t.artKey)?.artKey || null;
  }
  const feats = smart.features(all);
  const moods = new Map();
  for (const t of all) for (const m of smart.moodsOf(t, feats.get(t.id))) push(moods, m, t);
  D = {
    all,
    albumMap: albums,
    albums: [...albums.values()].sort((a, b) => a.title.localeCompare(b.title)),
    artistMap: artists,
    artists: [...artists.values()].sort((a, b) => a.name.localeCompare(b.name)),
    genreMap: genres,
    genres: [...genres.values()].sort((a, b) => b.count - a.count),
    families, langs, moods, feats,
  };
  return D;
}

function changed() {
  D = null;
  ACTS = null;
  rematchAll();
}

const recentPlays = () => {
  const since = Date.now() - 14 * 864e5;
  const m = new Map();
  for (const h of S.history) if (h.at >= since && h.s >= 30) m.set(h.trackId, (m.get(h.trackId) || 0) + 1);
  return m;
};

// ---------- smart playlist rules ----------

const SMART_FIELDS = {
  genre: { label: 'Genre', ops: { has: 'contains', not: 'doesn’t contain' }, type: 'text' },
  family: { label: 'Genre family', ops: { is: 'is', not: 'is not' }, type: 'family' },
  lang: { label: 'Language', ops: { is: 'is', not: 'is not' }, type: 'lang' },
  mood: { label: 'Mood', ops: { is: 'is', not: 'is not' }, type: 'mood' },
  artist: { label: 'Artist', ops: { has: 'contains', not: 'doesn’t contain' }, type: 'text' },
  album: { label: 'Album', ops: { has: 'contains', not: 'doesn’t contain' }, type: 'text' },
  plays: { label: 'Times played', ops: { gte: 'at least', lte: 'at most' }, type: 'number' },
  lastPlayed: { label: 'Last played', ops: { within: 'in the last (days)', notwithin: 'not in the last (days)' }, type: 'number' },
  added: { label: 'Added', ops: { within: 'in the last (days)', notwithin: 'more than (days) ago' }, type: 'number' },
  liked: { label: 'Liked', ops: { is: 'is' }, type: 'yesno' },
  year: { label: 'Year', ops: { gte: 'from', lte: 'up to' }, type: 'number' },
  bpm: { label: 'Tempo (BPM)', ops: { gte: 'at least', lte: 'at most' }, type: 'number' },
  energy: { label: 'Energy', ops: { is: 'is' }, type: 'energy' },
  duration: { label: 'Length (minutes)', ops: { gte: 'at least', lte: 'at most' }, type: 'number' },
  memory: { label: 'Has a memory', ops: { is: 'is' }, type: 'yesno' },
};
const SMART_SORTS = { custom: 'Best match', random: 'Random', plays: 'Most played', added: 'Recently added', recent: 'Recently played', title: 'Title', bpm: 'Tempo' };

function ruleMatch(t, r, d) {
  const DAY = 864e5;
  const n = parseFloat(r.v);
  const f = d.feats.get(t.id);
  const has = text => fold(text).includes(fold(r.v));
  switch (r.f) {
    case 'genre': return r.op === 'not' ? !has(t.genre) : !!r.v && has(t.genre);
    case 'artist': { const a = artistsOf(t).join(' · '); return r.op === 'not' ? !has(a) : !!r.v && has(a); }
    case 'album': return r.op === 'not' ? !has(t.album) : !!r.v && has(t.album);
    case 'family': { const on = smart.familiesOf(t).some(x => x.id === r.v); return r.op === 'not' ? !on : on; }
    case 'lang': { const on = t.lang?.code === r.v; return r.op === 'not' ? !on : on; }
    case 'mood': { const on = smart.moodsOf(t, f).includes(r.v); return r.op === 'not' ? !on : on; }
    case 'plays': return isNaN(n) || (r.op === 'gte' ? (t.plays || 0) >= n : (t.plays || 0) <= n);
    case 'lastPlayed': { if (isNaN(n)) return true; const recent = t.lastPlayed && Date.now() - t.lastPlayed < n * DAY; return r.op === 'within' ? !!recent : !recent; }
    case 'added': { if (isNaN(n)) return true; const recent = Date.now() - (t.added || 0) < n * DAY; return r.op === 'within' ? recent : !recent; }
    case 'liked': return (r.v === 'no') !== !!t.liked;
    case 'memory': return (r.v === 'no') !== !!t.memory?.text;
    case 'year': { const y = parseInt(t.year, 10); return isNaN(n) || (!isNaN(y) && (r.op === 'gte' ? y >= n : y <= n)); }
    case 'bpm': { const b = t.an?.bpm; return isNaN(n) || (!!b && (r.op === 'gte' ? b >= n : b <= n)); }
    case 'duration': { const m = (t.duration || 0) / 60; return isNaN(n) || (r.op === 'gte' ? m >= n : m <= n); }
    case 'energy': { if (!f) return false; return r.v === 'low' ? f.energy < 0.35 : r.v === 'high' ? f.energy > 0.65 : f.energy >= 0.35 && f.energy <= 0.65; }
  }
  return true;
}

function evalSmart(rules) {
  const d = derived();
  const conds = (rules?.conds || []).filter(r => SMART_FIELDS[r.f]);
  let list = d.all.filter(t => !conds.length || (rules.match === 'any' ? conds.some(r => ruleMatch(t, r, d)) : conds.every(r => ruleMatch(t, r, d))));
  const sorts = {
    random: () => smart.spreadArtists(shuffledStable(list.map(t => t.id), rules.seed || 1), S.tracks, artistOf).map(id => S.tracks.get(id)),
    plays: () => list.sort((a, b) => (b.plays || 0) - (a.plays || 0)),
    added: () => list.sort((a, b) => (b.added || 0) - (a.added || 0)),
    recent: () => list.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)),
    title: () => list.sort((a, b) => a.title.localeCompare(b.title)),
    bpm: () => list.sort((a, b) => (a.an?.bpm || 999) - (b.an?.bpm || 999)),
    custom: () => list.sort(mixOrder),
  };
  list = (sorts[rules?.sort] || sorts.custom)() || list;
  return rules?.limit ? list.slice(0, rules.limit) : list;
}

function shuffledStable(ids, seed) {
  const r = smart.rng(seed);
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** The songs of any playlist: its items, or for a smart playlist whatever currently matches its rules. */
const plTracks = p => (p.source === 'smart' ? evalSmart(p.rules) : p.items.map(it => S.tracks.get(it.trackId)).filter(Boolean));
const plCount = p => (p.source === 'smart' ? plTracks(p).length : p.items.length);
const isEditable = p => p && p.source !== 'spotify' && p.source !== 'smart';

let dailyCache = null;
function dailyMixes() {
  const key = today() + '|' + S.tracks.size;
  if (dailyCache?.key !== key) dailyCache = { key, mixes: smart.dailyMixes(derived().all, artistOf, today()) };
  return dailyCache.mixes;
}

const MIN_AUTO = 3;
function autoLists() {
  const d = derived();
  const out = { daily: [], smart: [], fam: [], mood: [], lang: [] };
  for (const m of dailyMixes()) out.daily.push(ctxOf('auto', 'daily:' + m.id));
  for (const s of smart.SMART) { const c = ctxOf('auto', 'smart:' + s.id); if (c.tracks.length >= (s.id === 'memories' ? 1 : MIN_AUTO)) out.smart.push(c); }
  for (const [id, list] of [...d.families].sort((a, b) => b[1].length - a[1].length)) if (list.length >= MIN_AUTO) out.fam.push(ctxOf('auto', 'fam:' + id));
  for (const m of smart.MOODS) if ((d.moods.get(m.id) || []).length >= MIN_AUTO) out.mood.push(ctxOf('auto', 'mood:' + m.id));
  for (const [code, list] of [...d.langs].sort((a, b) => b[1].length - a[1].length)) if (list.length >= 2) out.lang.push(ctxOf('auto', 'lang:' + code));
  return out;
}

/** Resolves a context descriptor into displayable info and its tracks. */
function ctxOf(v, id) {
  const d = derived();
  switch (v) {
    case 'album': {
      const a = d.albumMap.get(id);
      return a && { v, id, kind: 'Album', title: a.title, sub: a.artist, artKey: a.artKey, tracks: a.tracks, album: a };
    }
    case 'artist': {
      const a = d.artistMap.get(id);
      if (!a) return null;
      const main = a.main.slice().sort((x, y) => (x.album || '').localeCompare(y.album || '') || byTrackNo(x, y));
      return { v, id, kind: 'Artist', title: id, sub: 'Artist', artKey: a.artKey, tracks: [...main, ...a.feat], round: true, featCount: a.feat.length };
    }
    case 'genre': {
      const tracks = d.all.filter(t => smart.splitGenres(t.genre).includes(id));
      if (!tracks.length) return null;
      return { v, id, kind: 'Genre', title: id, sub: 'Genre', artKey: d.genreMap.get(id)?.artKey, tracks };
    }
    case 'liked': {
      const tracks = d.all.filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
      return { v, id: 'liked', kind: 'Playlist', title: 'Liked Songs', sub: 'Playlist', tracks, liked: true };
    }
    case 'songs':
      return { v, id: 'songs', kind: 'Library', title: 'All songs', sub: 'Your library', tracks: d.all, artKey: d.all.find(t => t.artKey)?.artKey };
    case 'playlist': {
      const p = S.playlists.get(id);
      if (!p) return null;
      const tracks = plTracks(p);
      // Cover: your own photo (or Spotify's), else a 2×2 collage of four different song covers, else the first cover.
      const keys = [...new Set(tracks.map(t => t.artKey).filter(Boolean))];
      const collage = !p.artKey && keys.length >= 4 ? keys.slice(0, 4) : null;
      return { v, id, kind: p.source === 'smart' ? 'Smart playlist' : 'Playlist', title: p.name, sub: 'Playlist', artKey: p.artKey || keys[0], collage, tracks, playlist: p, liked: p.spotifyId === 'liked' && !p.artKey };
    }
    case 'radio': {
      const seed = S.tracks.get(id);
      if (!seed) return null;
      if (S.radio?.seed !== id) S.radio = { seed: id, ids: smart.radio(seed, d.all, d.feats, artistsOf) };
      const tracks = [seed, ...S.radio.ids.map(x => S.tracks.get(x)).filter(Boolean)];
      return { v, id, kind: 'Radio', title: `${seed.title} Radio`, sub: `Songs like ${seed.title}, from your library`, artKey: seed.artKey, tracks, radio: true };
    }
    case 'auto': return autoCtx(id);
  }
  return null;
}

function autoCtx(id) {
  const d = derived();
  const [type, key] = id.split(/:(.*)/);
  const base = { v: 'auto', id, kind: 'Made for you', gen: true };
  if (type === 'fam') {
    const f = smart.familyById[key];
    if (!f) return null;
    const tracks = (d.families.get(key) || []).slice().sort(mixOrder);
    const gs = [...new Set(tracks.flatMap(t => smart.splitGenres(t.genre)))].slice(0, 4);
    return { ...base, kind: 'Genre mix', title: f.name, sub: gs.join(', '), color: f.color, tracks };
  }
  if (type === 'mood') {
    const m = smart.MOODS.find(x => x.id === key);
    if (!m) return null;
    return { ...base, kind: 'Mood', title: m.name, sub: m.desc, color: m.color, tracks: (d.moods.get(key) || []).slice().sort(mixOrder) };
  }
  if (type === 'lang') {
    const name = L.langName(key);
    return { ...base, kind: 'Language', title: key === L.INSTRUMENTAL ? 'Instrumentals' : `${name} Songs`, sub: key === L.INSTRUMENTAL ? 'Songs without vocals' : `Songs sung in ${name}`, color: tileColor('lang' + key), tracks: (d.langs.get(key) || []).slice().sort(mixOrder) };
  }
  if (type === 'smart') {
    const s = smart.SMART.find(x => x.id === key);
    if (!s) return null;
    return { ...base, kind: 'Smart playlist', title: s.name, sub: s.desc, color: s.color, tracks: smart.smartList(key, d.all, recentPlays()) };
  }
  if (type === 'daily') {
    const m = dailyMixes().find(x => x.id === key);
    if (!m) return null;
    return { ...base, kind: 'Daily mix', title: m.name, sub: m.sub, color: m.color, tracks: m.ids.map(x => S.tracks.get(x)).filter(Boolean) };
  }
  return null;
}

// ---------- artwork ----------

const artURLs = new Map();
function artURL(key) {
  if (!key) return Promise.resolve(null);
  if (!artURLs.has(key)) artURLs.set(key, db.get('art', key).then(b => (b ? URL.createObjectURL(b) : null)).catch(() => null));
  return artURLs.get(key);
}

const artHTML = (key, cls = '', fallback = 'music') =>
  `<div class="art ${cls}"${key ? ` data-art="${esc(key)}"` : ''}>${icon(fallback)}</div>`;
const likedArt = (cls = '') => `<div class="art liked-art ${cls}">${icon('heart-fill')}</div>`;
const genArt = (c, cls = '') => `<div class="art gen ${cls}" style="--c:${c.color}"><b>${esc(c.title)}</b></div>`;
const collageArt = (keys, cls = '') => `<div class="art collage ${cls}">${keys.map(k => `<div class="art" data-art="${esc(k)}"></div>`).join('')}</div>`;
function ctxArt(c, cls = '') {
  if (c.gen) return genArt(c, cls);
  if (c.liked) return likedArt(cls);
  if (c.collage) return collageArt(c.collage, cls);
  if (c.playlist?.source === 'smart' && !c.artKey) return genArt({ title: c.title, color: '#1e3264' }, cls);
  if (c.radio) return artHTML(c.artKey, cls + ' radio-art').replace(/<\/div>$/, '<span class="radio-badge">RADIO</span></div>');
  return artHTML(c.artKey, cls + (c.round ? ' round' : ''), c.round ? 'user' : 'music');
}

function hydrate(root = document) {
  for (const el of root.querySelectorAll('[data-art]:not([data-hyd])')) {
    el.dataset.hyd = '1';
    artURL(el.dataset.art).then(u => {
      if (!u) return;
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.onload = () => el.classList.add('loaded');
      img.src = u;
      el.prepend(img);
    });
  }
}

const tints = new Map();
function tintOf(key) {
  if (!key) return Promise.resolve(null);
  if (!tints.has(key)) {
    tints.set(key, (async () => {
      const u = await artURL(key);
      if (!u) return null;
      const img = new Image();
      img.src = u;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 12;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, 12, 12);
      const d = x.getImageData(0, 0, 12, 12).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const w = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) + 24;
        r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
      }
      r /= n; g /= n; b /= n;
      const f = 150 / Math.max(r, g, b, 1);
      return `rgb(${Math.round(r * f)}, ${Math.round(g * f)}, ${Math.round(b * f)})`;
    })().catch(() => null));
  }
  return tints.get(key);
}

const ART_DATA = new Map();
function artDataURL(key) {
  if (!ART_DATA.has(key)) {
    ART_DATA.set(key, db.get('art', key).then(b => b && new Promise(res => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res(null);
      fr.readAsDataURL(b);
    })));
  }
  return ART_DATA.get(key);
}

async function shrinkImage(blob, max) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (s === 1 && blob.size < 400_000) { bmp.close?.(); return blob; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise(r => c.toBlob(b => r(b || blob), 'image/jpeg', 0.88));
}

async function artKeyFor(blob) {
  const b = new Uint8Array(await blob.arrayBuffer());
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + '-' + b.length.toString(36);
}

async function saveArt(blob) {
  const key = await artKeyFor(blob);
  if (!(await db.get('art', key))) await db.put('art', await shrinkImage(blob, 1000).catch(() => blob), key);
  return key;
}

async function cleanupArt(key) {
  if (!key) return;
  const used = [...S.tracks.values()].some(t => t.artKey === key) || [...S.playlists.values()].some(p => p.artKey === key);
  if (!used) await db.del('art', key);
}

// ---------- toast ----------

let toastTimer;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function progressToast() {
  const el = $('#toast');
  clearTimeout(toastTimer);
  el.innerHTML = '<div class="msg"></div><div class="bar"><i></i></div>';
  el.classList.add('show');
  return {
    set(msg, frac) { $('.msg', el).textContent = msg; if (frac != null) $('.bar i', el).style.width = `${Math.round(frac * 100)}%`; },
    done() { el.classList.remove('show'); },
  };
}

// ---------- sheets ----------

function dragToClose(panel, close, canStart = () => true) {
  let y0 = null;
  let dy = 0;
  panel.addEventListener('touchstart', e => {
    if (panel.scrollTop > 0 || !canStart(e)) return;
    y0 = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  panel.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 4) { panel.style.transition = 'none'; panel.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    if (y0 == null) return;
    panel.style.transition = '';
    panel.style.transform = '';
    if (dy > 110) close();
    y0 = null;
  });
}

function sheet(html, { cls = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet ${cls}"><div class="grip"></div>${html}</div>`;
  $('#sheets').appendChild(wrap);
  const panel = $('.sheet', wrap);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 300);
  };
  wrap.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  dragToClose(panel, close, e => !e.target.closest('input, textarea, .eq-svg, .no-drag'));
  hydrate(wrap);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  return { el: wrap, close };
}

function menu(head, items) {
  items = items.filter(Boolean);
  const s = sheet(`${head}<div>${items.map((it, i) => `<button class="sheet-item${it.danger ? ' danger' : ''}" data-mi="${i}">${icon(it.icon, it.on ? 'liked' : '')}<span>${esc(it.label)}</span>${it.badge ? `<small class="mi-badge">${esc(it.badge)}</small>` : ''}</button>`).join('')}</div>`);
  s.el.addEventListener('click', e => {
    const b = e.target.closest('[data-mi]');
    if (!b) return;
    s.close();
    items[+b.dataset.mi].run();
  });
  return s;
}

const trackHead = t => `<div class="sheet-head">${artHTML(t.artKey, 'sm')}<div class="meta"><div class="t">${esc(t.title)}</div><div class="s"><span class="txt">${esc(t.artist || 'Unknown artist')}${t.album ? ' · ' + esc(t.album) : ''}</span></div></div></div>`;
const ctxHead = c => `<div class="sheet-head">${ctxArt(c, 'sm')}<div class="meta"><div class="t">${esc(c.title)}</div><div class="s"><span class="txt">${esc(c.kind)} · ${plural(c.tracks.length, 'song')}</span></div></div></div>`;

function promptSheet(title, value, okLabel, onOk, { multiline = false, placeholder = '' } = {}) {
  const field = multiline
    ? `<textarea class="input" id="prompt-in" rows="4" maxlength="500" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
    : `<input class="input" id="prompt-in" value="${esc(value)}" maxlength="120" autocomplete="off" placeholder="${esc(placeholder)}">`;
  const s = sheet(`<div class="sheet-title">${esc(title)}</div><div class="field">${field}</div><button class="btn-primary" data-ok>${esc(okLabel)}</button>`);
  const inp = $('#prompt-in', s.el);
  setTimeout(() => { inp.focus(); if (!multiline) inp.select(); }, 320);
  const ok = () => {
    const v = inp.value.trim();
    if (!v && !multiline) return;
    s.close();
    onOk(v);
  };
  $('[data-ok]', s.el).onclick = ok;
  if (!multiline) inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
  return s;
}

function confirmSheet(title, text, okLabel, onOk, { danger = true, cancel = 'Cancel', onCancel } = {}) {
  const s = sheet(`<div class="sheet-title">${esc(title)}</div><p class="hint" style="text-align:center">${text}</p><button class="btn-primary"${danger ? ' style="background:var(--danger)"' : ''} data-ok>${esc(okLabel)}</button><button class="sheet-item center" data-cancel>${esc(cancel)}</button>`);
  $('[data-ok]', s.el).onclick = () => { s.close(); onOk(); };
  $('[data-cancel]', s.el).onclick = () => { s.close(); onCancel?.(); };
  return s;
}

const sw = (k, on, act = 'cfg-toggle') => `<button class="switch${on ? ' on' : ''}" data-act="${act}" data-k="${k}" role="switch" aria-checked="${!!on}"><i></i></button>`;

// ---------- navigation & rendering ----------

let lists = [];
const regList = (ids, ctx) => lists.push({ ids, ctx }) - 1;
const topOf = () => S.stacks[S.tab].at(-1);

function navigate(v, id) {
  closeNP();
  closeCar();
  const stack = S.stacks[S.tab];
  stack.at(-1).scroll = $('#view').scrollTop;
  stack.push({ v, id });
  render();
}

function back() {
  const stack = S.stacks[S.tab];
  if (stack.length > 1) stack.pop();
  render();
}

function switchTab(tab) {
  closeNP();
  if (tab === S.tab) {
    const stack = S.stacks[tab];
    if (stack.length > 1) stack.splice(1);
    else stack[0].scroll = 0;
  } else {
    S.stacks[S.tab].at(-1).scroll = $('#view').scrollTop;
    S.tab = tab;
  }
  render();
}

function render() {
  const stack = S.stacks[S.tab];
  const top = stack.at(-1);
  lists = [];
  let html;
  try {
    html = VIEWS[top.v](top);
  } catch (e) {
    console.error(e);
    html = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
  }
  if (html == null) {
    stack.pop();
    if (!stack.length) stack.push({ v: S.tab });
    return render();
  }
  const view = $('#view');
  view.innerHTML = html;
  view.scrollTop = top.scroll || 0;
  hydrate(view);
  AFTER[top.v]?.(top);
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === S.tab);
  onScroll();
  syncPlayState();
}

function refresh() {
  const top = topOf();
  if (top.v === 'search' && $('#results')) return updateResults();
  top.scroll = $('#view').scrollTop;
  render();
}

// Background jobs (analysis, AI) update lists; re-render only calm, list-style pages and not too often.
let softTimer = null;
let lastSoft = 0;
function softRefresh(force = false) {
  updateJobStatus();
  const go = () => {
    softTimer = null;
    lastSoft = Date.now();
    if ($('.sheet-wrap') || $('#np.open') || $('#car')) return;
    const v = topOf().v;
    if (['home', 'library', 'auto'].includes(v) || (v === 'search' && !S.query)) refresh();
  };
  if (force) { clearTimeout(softTimer); return go(); }
  if (softTimer) return;
  softTimer = setTimeout(go, Math.max(0, 8000 - (Date.now() - lastSoft)));
}

function onScroll() {
  const tb = $('#view .topbar:not(.plain)');
  if (tb) tb.classList.toggle('solid', $('#view').scrollTop > 210);
}

const topbar = (title, plain = false, right = '') =>
  `<div class="topbar${plain ? ' plain' : ''}"><button class="icon-btn" data-act="back" aria-label="Back">${icon('back')}</button><div class="tb-title">${esc(title)}</div>${right || '<span class="tb-sp"></span>'}</div>`;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const emptyLibrary = () => `<div class="empty"><div class="empty-ic">${icon('music')}</div><h2>Your library is empty</h2><p>Add music files you own from the Files app, iCloud Drive or Downloads. Everything stays on this phone and plays offline.</p><button class="btn-primary inline" data-act="add-files">Add music</button></div>`;

const cardFor = (c, round = false) =>
  `<button class="card${round ? ' round' : ''}" data-act="nav" data-v="${c.v}" data-id="${esc(c.id)}">${ctxArt(c)}<div class="card-t">${esc(c.title)}</div><div class="card-s">${esc(c.sub || c.kind)}</div></button>`;
const card = (v, id, art, title, sub, round = false) =>
  `<button class="card${round ? ' round' : ''}" data-act="nav" data-v="${v}" data-id="${esc(id)}">${art}<div class="card-t">${esc(title)}</div><div class="card-s">${esc(sub)}</div></button>`;
const shelf = (title, cards, sub = '') => (cards.length ? `<section class="shelf"><h2>${esc(title)}</h2>${sub ? `<p class="shelf-sub">${esc(sub)}</p>` : ''}<div class="hscroll">${cards.join('')}</div></section>` : '');
const albumCard = a => card('album', a.key, artHTML(a.artKey), a.title, a.artist);
const artistCard = a => card('artist', a.name, artHTML(a.artKey, 'round', 'user'), a.name, 'Artist', true);

const playsLabel = n => (n ? `${n} ${n === 1 ? 'play' : 'plays'}` : '');

function songRow(t, L, i, o = {}) {
  const sub = o.sub ? o.sub(t) : t.artist || 'Unknown artist';
  const plays = o.noPlays ? '' : playsLabel(t.plays);
  const find = esc(fold([t.title, t.artist, t.album].join(' ')));
  const right = o.reorder
    ? `<button class="icon-btn rm-btn" data-act="pl-remove" data-pi="${o.pi}" aria-label="Remove">${icon('close')}</button><span class="drag" data-drag aria-label="Drag to reorder">${icon('queue')}</span>`
    : `<button class="icon-btn" data-act="song-menu" data-tid="${t.id}"${o.pi != null ? ` data-pi="${o.pi}"` : ''} aria-label="More options">${icon('more')}</button>`;
  return `<div class="row song${o.reorder ? ' reorder' : ''}"${o.reorder ? '' : ` data-act="play" data-list="${L}" data-i="${i}"`} data-tid="${t.id}"${o.pi != null ? ` data-pi="${o.pi}"` : ''} data-find="${find}">
    ${o.num ? `<span class="num">${t.track || i + 1}</span>` : artHTML(t.artKey, 'sm')}
    <div class="meta"><div class="t">${esc(t.title)}</div><div class="s">${t.liked ? `<span class="liked-dot">${icon('heart-fill')}</span>` : ''}${t.memory?.text ? `<span class="liked-dot memo">${icon('note')}</span>` : ''}<span class="txt">${esc(sub)}</span>${plays ? `<span class="plays">${icon('play')}${t.plays}</span>` : ''}</div></div>
    ${right}
  </div>`;
}

// ---------- sort & filter for song lists ----------

const SORTS = { custom: 'Custom order', title: 'Title', artist: 'Artist', album: 'Album', added: 'Recently added', plays: 'Most played', playsAsc: 'Least played', recent: 'Recently played', bpm: 'Tempo', duration: 'Length' };
const VIEWPREFS = ls.get('viewPrefs', {});
const viewPref = (key, defSort) => (VIEWPREFS[key] ||= { sort: defSort, plays: 'any', liked: false, stale: false, lang: '' });
const saveViewPrefs = () => ls.set('viewPrefs', VIEWPREFS);
const filterCount = p => (p.liked ? 1 : 0) + (p.stale ? 1 : 0) + (p.plays !== 'any' ? 1 : 0) + (p.lang ? 1 : 0);
const sortLabel = (pref, isPlaylist) => (pref.sort === 'custom' ? (isPlaylist ? 'Custom order' : 'Default') : SORTS[pref.sort]);

function applyView(tracks, pref, addedAt) {
  let list = tracks.slice();
  if (pref.liked) list = list.filter(t => t.liked);
  if (pref.stale) list = list.filter(t => !t.lastPlayed || Date.now() - t.lastPlayed > 30 * 864e5);
  if (pref.plays === 'never') list = list.filter(t => !t.plays);
  else if (pref.plays !== 'any') list = list.filter(t => (t.plays || 0) >= +pref.plays);
  if (pref.lang) list = list.filter(t => t.lang?.code === pref.lang);
  const cmp = {
    title: (a, b) => a.title.localeCompare(b.title),
    artist: (a, b) => (a.artist || '').localeCompare(b.artist || '') || a.title.localeCompare(b.title),
    album: (a, b) => (a.album || '').localeCompare(b.album || '') || byTrackNo(a, b),
    added: (a, b) => (addedAt ? addedAt(b) - addedAt(a) : (b.added || 0) - (a.added || 0)),
    plays: (a, b) => (b.plays || 0) - (a.plays || 0) || (b.lastPlayed || 0) - (a.lastPlayed || 0),
    playsAsc: (a, b) => (a.plays || 0) - (b.plays || 0),
    recent: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0),
    bpm: (a, b) => (a.an?.bpm || 999) - (b.an?.bpm || 999),
    duration: (a, b) => (a.duration || 0) - (b.duration || 0),
  }[pref.sort];
  if (cmp) list.sort(cmp);
  return list;
}

function sfBar(key, pref, { label, isPlaylist = false, canReorder = false }) {
  const n = filterCount(pref);
  return `<div class="sf-bar">
    <label class="sf-find">${icon('search')}<input data-find-in placeholder="Find in ${esc(label)}" autocomplete="off" autocorrect="off" spellcheck="false"></label>
    <button class="chip sm" data-act="sf-sort" data-key="${esc(key)}" data-pl="${isPlaylist ? 1 : ''}">${icon('sort')}${esc(sortLabel(pref, isPlaylist))}</button>
    <button class="chip sm${n ? ' on' : ''}" data-act="sf-filter" data-key="${esc(key)}">${icon('filter')}Filter${n ? ` · ${n}` : ''}</button>
    ${canReorder ? `<button class="chip sm" data-act="pl-reorder">${icon('queue')}Edit order</button>` : ''}
  </div>`;
}

function sortSheet(key, isPlaylist) {
  const pref = VIEWPREFS[key];
  const opts = Object.entries(SORTS).map(([k, l]) => [k, k === 'custom' ? (isPlaylist ? 'Custom order' : 'Default') : l]);
  menu('<div class="sheet-title">Sort by</div>', opts.map(([k, l]) => ({ icon: pref.sort === k ? 'check' : 'sort', on: pref.sort === k, label: l, run: () => { pref.sort = k; saveViewPrefs(); refresh(); } })));
}

function filterSheet(key) {
  const pref = VIEWPREFS[key];
  const langs = [...derived().langs.keys()];
  const playOpts = [['any', 'Any'], ['never', 'Never played'], ['1', '1+'], ['5', '5+'], ['10', '10+'], ['25', '25+'], ['50', '50+']];
  const s = sheet(`<div class="sheet-title">Filter</div><div class="pad">
    <h3 class="eq-h">Times played</h3><div class="chips wrap">${playOpts.map(([k, l]) => `<button class="chip${pref.plays === k ? ' on' : ''}" data-fp="${k}">${l}</button>`).join('')}</div>
    <div class="set-row">${icon('heart')}<div><b>Liked songs only</b></div>${sw('liked', pref.liked, 'x')}</div>
    <div class="set-row">${icon('timer')}<div><b>Not played in 30 days</b><small>Rediscover songs you’ve been skipping</small></div>${sw('stale', pref.stale, 'x')}</div>
    ${langs.length > 1 ? `<h3 class="eq-h">Language</h3><div class="chips wrap"><button class="chip${!pref.lang ? ' on' : ''}" data-fl="">Any</button>${langs.map(c => `<button class="chip${pref.lang === c ? ' on' : ''}" data-fl="${c}">${esc(L.langName(c))}</button>`).join('')}</div>` : ''}
    <button class="btn-primary" style="width:100%;margin:18px 0 6px" data-done>Show results</button>
    <button class="sheet-item center" data-clear>Clear filters</button></div>`);
  s.el.addEventListener('click', e => {
    const fp = e.target.closest('[data-fp]'), fl = e.target.closest('[data-fl]'), swb = e.target.closest('.switch');
    if (fp) { pref.plays = fp.dataset.fp; $$('[data-fp]', s.el).forEach(b => b.classList.toggle('on', b === fp)); }
    else if (fl) { pref.lang = fl.dataset.fl; $$('[data-fl]', s.el).forEach(b => b.classList.toggle('on', b === fl)); }
    else if (swb) { pref[swb.dataset.k] = !pref[swb.dataset.k]; swb.classList.toggle('on', pref[swb.dataset.k]); }
    else if (e.target.closest('[data-clear]')) { Object.assign(pref, { plays: 'any', liked: false, stale: false, lang: '' }); s.close(); saveViewPrefs(); refresh(); return; }
    else if (e.target.closest('[data-done]')) { s.close(); saveViewPrefs(); refresh(); return; }
    else return;
    saveViewPrefs();
  });
}

/** When "Find in…" is used, play only the songs that are still visible. */
function visibleIds(el) {
  const box = el.closest('.coll, .lib-songs')?.querySelector('.tracklist');
  if (!box?.dataset.q) return null;
  return [...box.querySelectorAll('.song[data-tid]:not([hidden])')].map(r => r.dataset.tid);
}

const missingRow = s => `<div class="row missing" data-act="missing">${artHTML(null, 'sm')}<div class="meta"><div class="t">${esc(s.title)}</div><div class="s"><span class="badge" style="background:#777">MISSING</span><span class="txt">${esc(s.artists.join(', '))}</span></div></div></div>`;

const navRow = (v, id, art, title, sub, extra = '') =>
  `<button class="row" data-act="nav" data-v="${v}" data-id="${esc(id)}">${art}<div class="meta"><div class="t">${esc(title)}</div><div class="s">${extra}<span class="txt">${esc(sub)}</span></div></div></button>`;
const ctxRow = c => navRow(c.v, c.id, ctxArt(c, 'sm'), c.title, `${c.kind} · ${plural(c.tracks.length, 'song')}`);
const PL_BADGE = { spotify: '<span class="badge">SPOTIFY</span>', shared: '<span class="badge" style="background:#509bf5">SHARED</span>', smart: '<span class="badge" style="background:#f0b429">SMART</span>' };
function playlistRow(p) {
  const c = ctxOf('playlist', p.id);
  return navRow('playlist', p.id, ctxArt(c, 'sm'), p.name, `${p.source === 'smart' ? 'Smart playlist' : 'Playlist'} · ${plural(c.tracks.length, 'song')}`, PL_BADGE[p.source] || '');
}
const folderPlaylists = fo => [...S.playlists.values()].filter(p => p.folderId === fo.id).sort((a, b) => (b.updated || 0) - (a.updated || 0));
const folderRow = fo => navRow('folder', fo.id, `<div class="art sm folder-art">${icon('folder')}</div>`, fo.name, `Folder · ${plural(folderPlaylists(fo).length, 'playlist')}`);

/** Songs in the order you last played them (most recent first), including the one playing now. */
function recentlyPlayed(n = 50) {
  const seen = new Set();
  const out = [];
  const add = (id, at) => { if (seen.has(id) || !S.tracks.has(id)) return; seen.add(id); out.push({ t: S.tracks.get(id), at }); };
  if (S.listen && S.listen.sec >= 5) add(S.listen.id, Date.now());
  for (let i = S.history.length - 1; i >= 0 && out.length < n; i--) add(S.history[i].trackId, S.history[i].at);
  return out;
}

function timeAgo(at) {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Yesterday' : d < 7 ? `${d} days ago` : new Date(at).toLocaleDateString();
}

function quickItems() {
  const d = derived();
  const out = [];
  const seen = new Set();
  const add = (v, id) => {
    const k = v + '|' + id;
    if (seen.has(k)) return;
    const c = ctxOf(v, id);
    if (!c || !c.tracks.length) return;
    seen.add(k);
    out.push(c);
  };
  for (const r of S.recent) add(r.v, r.id);
  add('liked', 'liked');
  for (const m of dailyMixes().slice(0, 2)) add('auto', 'daily:' + m.id);
  for (const p of [...S.playlists.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0))) add('playlist', p.id);
  for (const a of [...d.albums].sort((a, b) => b.added - a.added)) add('album', a.key);
  return out.slice(0, 8);
}

const VIEWS = {
  home() {
    const d = derived();
    const head = `<header class="page-head"><button class="avatar" data-act="nav" data-v="settings" aria-label="Settings">${icon('user')}</button><h1>${greeting()}</h1><button class="icon-btn" data-act="nav" data-v="stats" aria-label="Your stats">${icon('stats')}</button></header>`;
    if (!d.all.length) return `<div class="home">${head}${emptyLibrary()}</div>`;
    const quick = quickItems().map(c => `<button class="quick" data-act="nav" data-v="${c.v}" data-id="${esc(c.id)}">${ctxArt(c)}<span>${esc(c.title)}</span></button>`).join('');
    const a = autoLists();
    const recentAlbums = [...d.albums].sort((x, y) => y.added - x.added).slice(0, 12);
    const topArtists = [...d.artists].sort((x, y) => y.count - x.count).slice(0, 12);
    const pls = [...S.playlists.values()].sort((x, y) => (y.updated || 0) - (x.updated || 0)).slice(0, 12).map(p => ctxOf('playlist', p.id));
    const recent = recentlyPlayed(15);
    const RL = regList(recent.map(r => r.t.id), null);
    const recentCards = recent.map(({ t }, i) => `<button class="card" data-act="play" data-list="${RL}" data-i="${i}" data-tid="${t.id}">${artHTML(t.artKey)}<div class="card-t">${esc(t.title)}</div><div class="card-s">${esc(t.artist || 'Unknown artist')}</div></button>`);
    return `<div class="home">${head}<div class="quick-grid">${quick}</div>
      ${recentCards.length ? `<section class="shelf"><div class="shelf-h"><h2>Recently played</h2><button data-act="nav" data-v="history" data-id="history">Show all</button></div><div class="hscroll">${recentCards.join('')}</div></section>` : ''}
      ${shelf('Made for you', [...a.daily, ...a.smart].map(c => cardFor(c)))}
      ${shelf('Your genre mixes', a.fam.map(c => cardFor(c)), 'Similar genres grouped together')}
      ${shelf('Moods', a.mood.map(c => cardFor(c)), 'Picked by listening to each song’s tempo and energy')}
      ${shelf('By language', a.lang.map(c => cardFor(c)))}
      ${shelf('Recently added', recentAlbums.map(albumCard))}
      ${shelf('Your playlists', pls.map(c => cardFor(c)))}
      ${shelf('Your top artists', topArtists.map(artistCard))}</div>`;
  },

  search() {
    return `<header class="page-head"><h1>Search</h1></header>
      <div class="search-wrap"><label class="search-box">${icon('search')}<input id="q" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Songs, artists, memories…" value="${esc(S.query)}"><button class="clear" data-act="clear-q" aria-label="Clear"${S.query ? '' : ' hidden'}>${icon('close')}</button></label></div>
      <div id="results">${searchResults()}</div>`;
  },

  library() {
    const d = derived();
    const f = S.libFilter;
    const chips = [['playlists', 'Playlists'], ['made', 'Made for you'], ['albums', 'Albums'], ['artists', 'Artists'], ['songs', 'Songs']]
      .map(([k, l]) => `<button class="chip${f === k ? ' on' : ''}" data-act="lib-filter" data-f="${k}">${l}</button>`).join('');
    const head = `<div class="lib-head"><header class="page-head"><button class="avatar" data-act="nav" data-v="settings" aria-label="Settings">${icon('user')}</button><h1>Your Library</h1><button class="icon-btn" data-act="add-menu" aria-label="Add">${icon('plus')}</button></header><div class="chips">${chips}</div></div>`;
    let body = '';
    if (f === 'playlists') {
      const liked = ctxOf('liked');
      body = navRow('liked', 'liked', likedArt('sm'), 'Liked Songs', `Playlist · ${plural(liked.tracks.length, 'song')}`);
      if (S.history.length || S.listen) body += navRow('history', 'history', `<div class="art sm hist-art">${icon('timer')}</div>`, 'Recently played', 'Your listening history');
      for (const fo of S.folders) body += folderRow(fo);
      const inFolder = new Set(S.folders.map(x => x.id));
      for (const p of [...S.playlists.values()].filter(p => !inFolder.has(p.folderId)).sort((a, b) => (b.updated || 0) - (a.updated || 0))) body += playlistRow(p);
      body += `<button class="row" data-act="add-menu"><div class="art sm">${icon('plus')}</div><div class="meta"><div class="t">Create playlist, smart playlist or folder</div></div></button>`;
    } else if (!d.all.length) {
      body = emptyLibrary();
    } else if (f === 'made') {
      const a = autoLists();
      const sec = (t, l) => (l.length ? `<h2 class="sec-h">${t}</h2>${l.map(ctxRow).join('')}` : '');
      body = sec('Daily mixes', a.daily) + sec('Smart playlists', a.smart) + sec('Genre mixes', a.fam) + sec('Moods', a.mood) + sec('Languages', a.lang)
        || '<p class="hint">Mixes appear as your library grows and songs get analyzed.</p>';
    } else if (f === 'albums') {
      body = d.albums.map(a => navRow('album', a.key, artHTML(a.artKey, 'sm'), a.title, `Album · ${a.artist}`)).join('');
    } else if (f === 'artists') {
      body = d.artists.map(a => `<div class="round-art">${navRow('artist', a.name, artHTML(a.artKey, 'sm round', 'user'), a.name, `Artist · ${plural(a.count, 'song')}`)}</div>`).join('');
    } else {
      const pref = viewPref('songs:songs', 'title');
      const list = applyView(d.all, pref);
      const L2 = regList(list.map(t => t.id), { v: 'songs', id: 'songs' });
      body = `<div class="lib-songs"><div class="list-tools"><span class="grow">${plural(list.length, 'song')}${list.length !== d.all.length ? ` of ${d.all.length}` : ''}</span><button class="icon-btn${S.shuffle ? ' on' : ''}" data-act="shuffle-play" data-list="${L2}" aria-label="Shuffle">${icon('shuffle')}</button><button class="play-big" data-act="play-list" data-list="${L2}" data-v="songs" data-id="songs" style="width:46px;height:46px">${icon('play')}</button></div>`
        + sfBar('songs:songs', pref, { label: 'your songs' })
        + `<div class="tracklist">${list.map((t, i) => songRow(t, L2, i, { sub: t => [t.artist, t.album].filter(Boolean).join(' · ') || 'Unknown artist' })).join('') || '<div class="empty small"><h3>No songs match these filters</h3></div>'}</div></div>`;
    }
    return head + body;
  },

  album: collection, artist: collection, genre: collection, liked: collection, playlist: collection, songs: collection, auto: collection, radio: collection,

  history() {
    const list = recentlyPlayed(300);
    const L2 = regList(list.map(r => r.t.id), null);
    let html = `${topbar('Recently played', true, `<button class="icon-btn" data-act="history-menu" aria-label="More">${icon('more')}</button>`)}`;
    if (!list.length) return html + '<div class="empty small"><div class="empty-ic">' + icon('timer') + '</div><h3>Nothing played yet</h3><p class="hint">Songs you listen to show up here.</p></div>';
    let day = '';
    list.forEach(({ t, at }, i) => {
      const d = new Date(at);
      const label = d.toDateString() === new Date().toDateString() ? 'Today' : d.toDateString() === new Date(Date.now() - 864e5).toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      if (label !== day) { day = label; html += `<h2 class="sec-h">${esc(label)}</h2>`; }
      html += songRow(t, L2, i, { sub: t => `${t.artist || 'Unknown artist'} · ${timeAgo(at)}` });
    });
    return html;
  },

  folder(top) {
    const fo = S.folders.find(f => f.id === top.id);
    if (!fo) return null;
    const pls = folderPlaylists(fo);
    return `${topbar(fo.name, true, `<button class="icon-btn" data-act="folder-menu" aria-label="More">${icon('more')}</button>`)}
      <div class="folder-hero"><div class="art lg folder-art">${icon('folder')}</div><div><h1>${esc(fo.name)}</h1><p>${plural(pls.length, 'playlist')}</p></div></div>
      ${pls.map(playlistRow).join('')}
      <button class="row" data-act="folder-add"><div class="art sm">${icon('plus')}</div><div class="meta"><div class="t">Add playlists to this folder</div></div></button>`;
  },

  settings() {
    const d = derived();
    const size = d.all.reduce((n, t) => n + (t.size || 0), 0);
    const row = (act, ic, title, sub, extra = '', attrs = '') => `<button class="set-row" data-act="${act}"${attrs}>${icon(ic)}<div><b>${title}</b><small${extra}>${sub}</small></div>${icon('chev', 'chev')}</button>`;
    return `${topbar('Settings', true)}<div class="pad">
      <div class="profile"><div class="avatar">${icon('user')}</div><div><h1>Stash</h1><p>${plural(d.all.length, 'song')} · ${fmtBytes(size)}</p></div></div>
      <div class="group"><h3>Listening</h3>
        ${row('nav', 'speaker', 'Sound', CFG.enhanced ? 'Enhanced audio on' : 'Equalizer, crossfade, effects, karaoke', '', ' data-v="sound"')}
        ${row('nav', 'eq', 'Equalizer', eqSummary(), '', ' data-v="eq"')}
        ${row('nav', 'stats', 'Your stats', 'Top songs, artists, genres and minutes listened', '', ' data-v="stats"')}
      </div>
      <div class="group"><h3>Library</h3>
        <button class="set-row" data-act="add-files">${icon('plus')}<div><b>Add music files</b><small>MP3, M4A, AAC, FLAC, WAV · add .lrc files for lyrics</small></div></button>
        ${row('nav', 'broom', 'Clean up song info', 'Fix messy titles, “feat.” credits and missing genres', '', ' data-v="clean"')}
        ${row('nav', 'dup', 'Find duplicates', 'Same song imported more than once', '', ' data-v="dups"')}
        ${row('backup-menu', 'backup', 'Backup & share', 'Move your library or a playlist to another phone')}
        <div class="set-row">${icon('wave')}<div><b>Song analysis</b><small id="job-an">…</small></div></div>
        <div class="set-row">${icon('globe')}<div><b>AI language detection</b><small id="job-lang">…</small></div>${sw('aiLang', CFG.aiLang === true, 'ai-toggle')}</div>
        <div class="set-row">${icon('storage')}<div><b>Storage</b><small id="st-usage">Checking…</small></div></div>
        <button class="set-row" data-act="persist">${icon('shield')}<div><b>Protect my library</b><small id="st-persist">Asks the browser never to clear your music</small></div></button>
      </div>
      <div class="group"><h3>Connections</h3>
        ${row('nav', 'link', 'Import Spotify playlists', sp.isConnected() ? 'Connected' : 'Copy your playlists’ track lists', '', ' data-v="spotify"')}
      </div>
      <div class="group"><h3>Danger zone</h3>
        <button class="set-row danger" data-act="wipe">${icon('trash')}<div><b>Delete everything</b><small>Removes all songs, playlists and settings from this device</small></div></button>
      </div>
      <p class="foot">Stash ${VERSION}<br>Your music never leaves this device.</p>
    </div>`;
  },

  sound() {
    const enh = CFG.enhanced;
    const dis = enh ? '' : ' disabled-row';
    const fx = [['none', 'None'], ['8d', '8D audio'], ['hall', 'Concert hall'], ['night', 'Night mode']]
      .map(([k, l]) => `<button class="chip${CFG.effect === k ? ' on' : ''}" data-act="cfg-set" data-k="effect" data-val="${k}">${l}</button>`).join('');
    const speeds = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2]
      .map(v => `<button class="chip${CFG.speed === v ? ' on' : ''}" data-act="cfg-set" data-k="speed" data-val="${v}">${v}×</button>`).join('');
    return `${topbar('Sound', true)}<div class="pad">
      <div class="box enh-box">
        <div class="set-row" style="border:0;padding:0">${icon('sparkle')}<div><b>Enhanced audio</b><small>Equalizer, real crossfades, volume leveling, karaoke and effects</small></div>${sw('enhanced', enh)}</div>
        <p class="hint" style="padding:10px 0 0">On iPhone, enhanced audio can make music pause when the screen locks or you switch apps. If that happens, turn it off: songs will still skip silence and change smoothly.</p>
      </div>
      <div class="group"><h3>Transitions</h3>
        <div class="set-row${dis}">${icon('fx')}<div><b>Crossfade</b><small id="xf-label">${CFG.crossfade ? CFG.crossfade + ' seconds' : 'Off'}${enh ? '' : ' · needs enhanced audio'}</small></div></div>
        <input type="range" class="range no-drag" id="xf" min="0" max="12" step="1" value="${CFG.crossfade}" ${enh ? '' : 'disabled'}>
        <div class="set-row">${icon('sparkle')}<div><b>Smart transitions</b><small>No fade between songs of the same album, and fades start where a song naturally fades out</small></div>${sw('smartTransitions', CFG.smartTransitions)}</div>
        <div class="set-row">${icon('wave')}<div><b>Skip silence</b><small>Skips silent seconds at the start and end of songs</small></div>${sw('skipSilence', CFG.skipSilence)}</div>
      </div>
      <div class="group"><h3>Sound</h3>
        <button class="set-row${dis}" data-act="nav" data-v="eq">${icon('eq')}<div><b>Equalizer</b><small>${eqSummary()}</small></div>${icon('chev', 'chev')}</button>
        <div class="set-row${dis}">${icon('speaker')}<div><b>Volume leveling</b><small>Plays every song at a similar loudness</small></div>${sw('leveling', CFG.leveling)}</div>
        <div class="set-row${dis}">${icon('mic')}<div><b>Karaoke mode</b><small>Reduces the vocals so you can sing along</small></div>${sw('karaoke', CFG.karaoke)}</div>
        <div class="set-row${dis}" style="border:0">${icon('fx')}<div><b>Effects</b><small>8D audio works best with headphones</small></div></div>
        <div class="chips wrap${dis}">${fx}</div>
      </div>
      <div class="group"><h3>Playback</h3>
        <div class="set-row" style="border:0">${icon('speed')}<div><b>Playback speed</b><small>Pitch stays natural</small></div></div>
        <div class="chips wrap">${speeds}</div>
        <div class="set-row">${icon('shuffle')}<div><b>Smart shuffle</b><small>Avoids the same artist twice in a row and plays favourites a bit more</small></div>${sw('smartShuffle', CFG.smartShuffle)}</div>
      </div>
    </div>`;
  },

  eq() {
    return `${topbar('Equalizer', true)}<div class="pad">${eqEditorHTML()}</div>`;
  },

  stats(top) {
    const period = top.period || '30';
    const now = Date.now();
    const since = period === 'all' ? 0 : period === 'year' ? new Date(new Date().getFullYear(), 0, 1).getTime() : now - +period * 864e5;
    const hist = S.history.filter(h => h.at >= since);
    const totalSec = hist.reduce((n, h) => n + h.s, 0);
    const chips = [['7', '7 days'], ['30', '30 days'], ['year', 'This year'], ['all', 'All time']]
      .map(([k, l]) => `<button class="chip${period === k ? ' on' : ''}" data-act="stats-period" data-p="${k}">${l}</button>`).join('');
    if (!hist.length) {
      return `${topbar('Your stats', true)}<div class="chips">${chips}</div><div class="empty small"><div class="empty-ic">${icon('stats')}</div><h3>No listening yet</h3><p class="hint">Play some music and your stats will show up here.</p></div>`;
    }
    const bySong = new Map(), byArtist = new Map(), byFam = new Map(), byLang = new Map(), byHour = new Array(24).fill(0);
    const add = (m, k, s) => m.set(k, (m.get(k) || 0) + s);
    for (const h of hist) {
      const t = S.tracks.get(h.trackId);
      byHour[new Date(h.at).getHours()] += h.s;
      if (!t) continue;
      add(bySong, t.id, h.s);
      for (const a of artistsOf(t)) add(byArtist, a, h.s);
      for (const f of smart.familiesOf(t)) add(byFam, f.name, h.s);
      if (t.lang?.code) add(byLang, L.langName(t.lang.code), h.s);
    }
    const top5 = m => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const songs = top5(bySong);
    const L2 = regList(songs.map(([id]) => id), null);
    const bars = m => { const list = top5(m); const max = list[0]?.[1] || 1; return list.map(([k, s]) => `<div class="bar-row"><span>${esc(k)}</span><div class="bar-track"><i style="width:${(s / max) * 100}%"></i></div><small>${fmtLong(s)}</small></div>`).join('') || '<p class="hint" style="padding:0">Not enough info yet.</p>'; };
    // Daily minutes for the chart (last 7 or 30 days), or monthly for longer periods.
    let chart = '';
    const daily = period === '7' || period === '30';
    const buckets = [];
    if (daily) {
      const days = +period;
      for (let i = days - 1; i >= 0; i--) {
        const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - i);
        const s0 = d0.getTime();
        buckets.push([d0.toLocaleDateString(undefined, days === 7 ? { weekday: 'short' } : { day: 'numeric' }), hist.filter(h => h.at >= s0 && h.at < s0 + 864e5).reduce((n, h) => n + h.s, 0)]);
      }
    } else {
      const m = new Map();
      for (const h of hist) { const d0 = new Date(h.at); const k = d0.getFullYear() * 12 + d0.getMonth(); m.set(k, (m.get(k) || 0) + h.s); }
      for (const [k, s] of [...m.entries()].sort((a, b) => a[0] - b[0]).slice(-12)) buckets.push([new Date(Math.floor(k / 12), k % 12, 1).toLocaleDateString(undefined, { month: 'short' }), s]);
    }
    const bmax = Math.max(1, ...buckets.map(b => b[1]));
    chart = `<div class="chart">${buckets.map(([l, s], i) => `<div class="col" title="${esc(l)}: ${fmtLong(s)}"><i style="height:${Math.max(2, (s / bmax) * 100)}%"></i><span>${buckets.length > 14 && i % 5 ? '' : esc(l)}</span></div>`).join('')}</div>`;
    const peakHour = byHour.indexOf(Math.max(...byHour));
    const hourName = new Date(2000, 0, 1, peakHour).toLocaleTimeString(undefined, { hour: 'numeric' });
    const songCount = new Set(hist.map(h => h.trackId)).size;
    return `${topbar('Your stats', true)}<div class="chips">${chips}</div><div class="pad">
      <div class="stat-hero"><div><b>${Math.round(totalSec / 60).toLocaleString()}</b><span>minutes listened</span></div><div><b>${songCount}</b><span>different songs</span></div><div><b>${hourName}</b><span>favourite hour</span></div></div>
      ${chart}
      <h2 class="sec-h" style="margin-left:0">Top songs</h2></div>
      ${songs.map(([id, s], i) => { const t = S.tracks.get(id); return t ? songRow(t, L2, i, { sub: t => `${t.artist || 'Unknown artist'} · ${fmtLong(s)}` }) : ''; }).join('')}
      <div class="pad"><h2 class="sec-h" style="margin-left:0">Top artists</h2>${bars(byArtist)}
      <h2 class="sec-h" style="margin-left:0">Top genres</h2>${bars(byFam)}
      <h2 class="sec-h" style="margin-left:0">Top languages</h2>${bars(byLang)}</div>`;
  },

  dups() {
    const groups = smart.findDuplicates(derived().all, artistOf);
    const head = `${topbar('Duplicates', true)}<div class="pad"><p class="hint" style="padding:0">Songs that look like the same recording imported more than once. The best-quality copy is kept, and its likes, plays, memories and playlist spots are merged.</p></div>`;
    if (!groups.length) return head + `<div class="empty small"><div class="empty-ic">${icon('check')}</div><h3>No duplicates found</h3></div>`;
    return head + `<div class="pad"><button class="btn-primary" style="width:100%;margin:8px 0 4px" data-act="dups-all">Clean up all ${plural(groups.length, 'group')}</button></div>`
      + groups.map((g, gi) => `<div class="dup-group"><div class="dup-h"><b>${esc(g[0].title)}</b><button class="btn-ghost" data-act="dups-one" data-g="${gi}">Keep best</button></div>${g.map((t, i) => { const q = smart.qualityOf(t); return `<div class="row">${artHTML(t.artKey, 'sm')}<div class="meta"><div class="t">${esc(t.title)}</div><div class="s"><span class="badge"${i ? ' style="background:#555;color:#fff"' : ''}>${i ? 'REMOVE' : 'KEEP'}</span><span class="txt">${q.format} · ${q.kbps || '?'} kbps · ${fmtTime(t.duration)} · ${esc(t.fileName)}</span></div></div></div>`; }).join('')}</div>`).join('');
  },

  clean(top) {
    top.proposals ||= derived().all.map(t => ({ t, c: smart.proposeCleanup(t) })).filter(x => x.c);
    const fillable = derived().all.filter(t => !t.genre).map(t => ({ t, g: suggestOffline(t).find(s => s.why === 'Same album' || s.why === 'Same artist') })).filter(x => x.g);
    top.fill ||= fillable;
    const head = `${topbar('Clean up song info', true)}<div class="pad"><p class="hint" style="padding:0">Review the suggested fixes, untick anything you want to keep as it is, then apply.</p></div>`;
    if (!top.proposals.length && !top.fill.length) return head + `<div class="empty small"><div class="empty-ic">${icon('check')}</div><h3>Everything looks tidy</h3></div>`;
    const row = (k, i, t, html) => `<label class="clean-row"><input type="checkbox" data-k="${k}" data-i="${i}" checked><div>${html}</div></label>`;
    const diff = (label, a, b) => `<div class="diff"><small>${label}</small><s>${esc(a || '—')}</s><b>${esc(b)}</b></div>`;
    return head + `<div class="pad">
      ${top.proposals.length ? `<h2 class="sec-h" style="margin-left:0">Titles & artists</h2>` : ''}
      ${top.proposals.map(({ t, c }, i) => row('p', i, t, Object.entries(c).map(([k, v]) => diff(k[0].toUpperCase() + k.slice(1), t[k], v)).join(''))).join('')}
      ${top.fill.length ? `<h2 class="sec-h" style="margin-left:0">Missing genres</h2>` : ''}
      ${top.fill.map(({ t, g }, i) => row('g', i, t, `<div class="diff"><span class="dt">${esc(t.title)} · ${esc(t.artist || '')}</span><b>Genre: ${esc(g.genre)}</b><em>${esc(g.why)}</em></div>`)).join('')}
      <button class="btn-primary" style="width:100%;margin:16px 0" data-act="clean-apply">Apply selected</button></div>`;
  },

  spotify() {
    const connected = sp.isConnected();
    const hero = `<div class="sp-hero"><div class="badge-ic">${icon('link')}</div><h1>Import Spotify playlists</h1><p>Copies the names and track lists of your Spotify playlists. Songs you’ve added to Stash appear in them automatically, and the rest show as missing until you add the files. No audio comes from Spotify.</p></div>`;
    if (connected) {
      return `${topbar('Spotify import', true)}<div class="pad">${hero}
        <div class="sp-acct">${icon('user')}<div>Connected as<b id="sp-acct">…</b></div><button class="btn-ghost" data-act="sp-disconnect">Disconnect</button></div>
        <h2 class="sec-h" style="margin-left:0">Your Spotify playlists</h2>
        <div id="sp-list"><div class="loading">Loading playlists…</div></div></div>`;
    }
    const redirect = sp.redirectUri();
    return `${topbar('Spotify import', true)}<div class="pad">${hero}
      <div class="box">
        <h3>1. Create a Spotify app (one time)</h3>
        <ol class="steps">
          <li>Open <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> and log in with your Spotify account.</li>
          <li>Tap <b>Create app</b>. Any name and description work.</li>
          <li>Under <b>Redirect URIs</b>, add exactly:<div class="copy-row"><code>${esc(redirect)}</code><button class="btn-ghost" data-act="copy" data-text="${esc(redirect)}">Copy</button></div></li>
          <li>Tick <b>Web API</b>, save, then copy the app’s <b>Client ID</b>.</li>
          <li>For family members: add their Spotify email under <b>User Management</b> in the same app.</li>
        </ol>
        <h3>2. Connect</h3>
        <input class="input" id="sp-cid" placeholder="Paste Client ID" value="${esc(sp.getClientId())}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn-primary" data-act="sp-connect">Connect to Spotify</button>
        ${sp.hasPendingLogin() ? `<h3>Got a code instead?</h3><p>If Spotify finished in a separate browser window and showed you a code, paste it here.</p><input class="input" id="sp-code" placeholder="Paste code" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn-primary" style="background:#fff" data-act="sp-code">Finish connecting</button>` : ''}
      </div></div>`;
  },
};

function collection(top) {
  const c = ctxOf(top.v, top.id);
  if (!c) return null;
  const p = c.playlist;
  const sortable = !['album', 'radio'].includes(top.v);
  const pref = sortable ? viewPref(`${top.v}:${top.id}`, top.v === 'songs' ? 'title' : 'custom') : null;
  const plain = !pref || (pref.sort === 'custom' && !filterCount(pref));
  const editable = isEditable(p);
  if (top.reorder && !(editable && plain)) top.reorder = false;
  const shown = plain ? c.tracks : applyView(c.tracks, pref, p && !p.source?.match(/smart/) ? t => p.items.find(it => it.trackId === t.id)?.at || 0 : null);
  const L2 = regList(shown.map(t => t.id), { v: top.v, id: top.id });
  let rows;
  let missing = 0;
  if (p && p.source !== 'smart' && plain) {
    let i = 0;
    rows = p.items.map((it, pi) => {
      const t = S.tracks.get(it.trackId);
      if (t) return songRow(t, L2, i++, { pi, reorder: top.reorder });
      if (it.sp) { missing++; return missingRow(it.sp); }
      return '';
    }).join('');
  } else if (p) {
    const pos = new Map(p.items.map((it, i) => [it.trackId, i]));
    rows = shown.map((t, i) => songRow(t, L2, i, { pi: p.source === 'smart' ? null : pos.get(t.id) })).join('');
    if (!shown.length && c.tracks.length) rows = '<div class="empty small"><h3>No songs match these filters</h3></div>';
  } else if (!plain) {
    rows = shown.map((t, i) => songRow(t, L2, i)).join('') || '<div class="empty small"><h3>No songs match these filters</h3></div>';
  } else if (top.v === 'artist' && c.featCount) {
    const mainN = c.tracks.length - c.featCount;
    rows = c.tracks.slice(0, mainN).map((t, i) => songRow(t, L2, i, { sub: t => t.album || t.artist })).join('')
      + `<h2 class="sec-h">Featured on</h2>` + c.tracks.slice(mainN).map((t, i) => songRow(t, L2, mainN + i)).join('');
  } else {
    rows = c.tracks.map((t, i) => songRow(t, L2, i, { num: top.v === 'album' })).join('');
  }
  const total = c.tracks.reduce((n, t) => n + (t.duration || 0), 0);
  const stats = `${plural(c.tracks.length, 'song')}${total ? ', ' + fmtLong(total) : ''}`;
  let sub = '';
  let meta = '';
  if (top.v === 'album') {
    sub = `<div class="hero-sub">${artHTML(c.artKey, 'round', 'user').replace('class="art', 'style="width:24px;height:24px" class="art')}<button data-act="nav" data-v="artist" data-id="${esc(c.album.artist)}">${esc(c.album.artist)}</button></div>`;
    meta = `Album${c.album.year ? ' · ' + esc(c.album.year) : ''} · ${stats}`;
  } else if (p) {
    const folder = S.folders.find(f => f.id === p.folderId);
    meta = `${p.source === 'spotify' ? 'From Spotify · ' : p.source === 'shared' ? 'Shared with you · ' : p.source === 'smart' ? 'Smart playlist · updates automatically · ' : ''}${folder ? `In ${esc(folder.name)} · ` : ''}${stats}${missing ? ` · ${missing} missing` : ''}`;
  } else if (c.gen || c.radio) {
    sub = `<div class="hero-desc">${esc(c.sub)}</div>`;
    meta = `${esc(c.kind)} · ${stats}`;
  } else {
    meta = `${esc(c.sub)} · ${stats}`;
  }
  const mine = S.ctx && S.ctx.v === top.v && String(S.ctx.id) === String(top.id);
  const moreBtn = top.v !== 'songs' && top.v !== 'liked' ? `<button class="icon-btn" data-act="ctx-menu" aria-label="More">${icon('more')}</button>` : '';
  const emptyMsg = top.v === 'liked'
    ? '<div class="empty small"><h3>Songs you like will appear here</h3><p class="hint">Tap the heart on any song.</p></div>'
    : p?.source === 'smart' ? '<div class="empty small"><h3>No songs match these rules yet</h3><button class="btn-primary inline" data-act="smart-edit">Edit rules</button></div>'
      : p && !p.items.length ? '<div class="empty small"><h3>Let’s find something for your playlist</h3><button class="btn-primary inline" data-act="add-songs">Add songs</button></div>'
        : '<div class="empty small"><h3>Nothing here yet</h3></div>';
  const addRow = editable && p.items.length && !top.reorder ? `<button class="row add-row" data-act="add-songs"><div class="art sm">${icon('plus')}</div><div class="meta"><div class="t">Add songs</div></div></button>` : '';
  const bar = top.reorder
    ? `<div class="sf-bar reorder-bar"><span>${icon('queue')} Drag the handles to reorder</span><button class="btn-primary inline" data-act="pl-reorder-done">Done</button></div>`
    : pref && c.tracks.length ? sfBar(`${top.v}:${top.id}`, pref, { label: p ? 'playlist' : top.v === 'songs' ? 'your songs' : c.title, isPlaylist: !!p && p.source !== 'smart', canReorder: editable && plain && p.items.length > 1 }) : '';
  const tint = c.gen ? ` style="--tint:${c.color}"` : c.liked ? ' style="--tint:#5038a0"' : '';
  return `<div class="coll" data-tint="${c.gen ? '' : esc(c.artKey || '')}"${tint}>
    ${topbar(c.title)}
    <div class="hero">${ctxArt(c, 'xl')}<h1 class="hero-t${c.title.length < 14 ? ' big' : ''}">${esc(c.title)}</h1>${sub}<div class="hero-meta">${meta}</div></div>
    <div class="actions">${moreBtn}<span class="grow"></span>
      <button class="icon-btn${S.shuffle ? ' on' : ''}" data-act="shuffle-play" data-list="${L2}" aria-label="Shuffle play">${icon('shuffle')}</button>
      <button class="play-big" data-act="play-list" data-list="${L2}" data-v="${top.v}" data-id="${esc(top.id)}" aria-label="Play">${icon(mine && !eng.paused() ? 'pause' : 'play')}</button>
    </div>
    ${bar}
    <div class="tracklist">${addRow}${rows || emptyMsg}</div>
    ${missing ? `<p class="coll-foot">${plural(missing, 'song')} from Spotify ${missing === 1 ? 'isn’t' : 'aren’t'} in your library yet. Add the files and they’ll match automatically.</p>` : ''}
  </div>`;
}

function startReorder() {
  const top = topOf();
  const p = S.playlists.get(top.id);
  if (!isEditable(p)) return;
  const pref = viewPref(`playlist:${p.id}`, 'custom');
  if (pref.sort !== 'custom' || filterCount(pref)) {
    Object.assign(pref, { sort: 'custom', plays: 'any', liked: false, stale: false, lang: '' });
    saveViewPrefs();
  }
  top.reorder = true;
  refresh();
}

/** Drag the ≡ handles to reorder a playlist; the new order is saved when you let go. */
function bindReorder(p) {
  const box = $('#view .tracklist');
  const view = $('#view');
  if (!box || !p) return;
  let drag = null;
  let scroller = null;
  const rowsOf = () => [...box.querySelectorAll('.song[data-pi]')];
  box.addEventListener('pointerdown', e => {
    const h = e.target.closest('[data-drag]');
    if (!h) return;
    e.preventDefault();
    const row = h.closest('.row');
    drag = { row, y: e.clientY, lastY: e.clientY };
    row.classList.add('dragging');
    try { h.setPointerCapture(e.pointerId); } catch {}
    // Keep scrolling while the finger rests near the top or bottom edge.
    scroller = setInterval(() => {
      if (!drag) return;
      const vr = view.getBoundingClientRect();
      const dy = drag.lastY < vr.top + 90 ? -10 : drag.lastY > vr.bottom - 170 ? 10 : 0;
      if (dy) { view.scrollTop += dy; drag.y -= dy; move(drag.lastY); }
    }, 16);
  });
  const move = y => {
    const { row } = drag;
    row.style.transform = `translateY(${y - drag.y}px)`;
    const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
    const next = row.nextElementSibling;
    const prev = row.previousElementSibling;
    if (next?.matches('.song') && mid > next.getBoundingClientRect().top + next.offsetHeight / 2) {
      box.insertBefore(next, row);
      drag.y += next.offsetHeight;
      row.style.transform = `translateY(${y - drag.y}px)`;
    } else if (prev?.matches('.song') && mid < prev.getBoundingClientRect().top + prev.offsetHeight / 2) {
      box.insertBefore(row, prev);
      drag.y -= prev.offsetHeight;
      row.style.transform = `translateY(${y - drag.y}px)`;
    }
  };
  box.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.lastY = e.clientY;
    move(e.clientY);
  });
  const end = () => {
    if (!drag) return;
    clearInterval(scroller);
    drag.row.classList.remove('dragging');
    drag.row.style.transform = '';
    drag = null;
    const order = rowsOf().map(r => +r.dataset.pi);
    if (order.length === p.items.length) {
      p.items = order.map(i => p.items[i]);
      p.updated = Date.now();
      db.put('playlists', p);
    }
    rowsOf().forEach((r, i) => { r.dataset.pi = i; r.querySelector('[data-act="pl-remove"]').dataset.pi = i; });
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

const AFTER = {
  album: tintView, artist: tintView, genre: tintView, songs: tintView, radio: tintView,
  playlist(top) {
    tintView();
    if (top.reorder) bindReorder(S.playlists.get(top.id));
  },
  folder() {},

  async settings() {
    updateJobStatus();
    const el = $('#st-usage');
    const pe = $('#st-persist');
    try {
      const est = await navigator.storage?.estimate?.();
      if (est && el) el.textContent = `${fmtBytes(est.usage)} used${est.quota ? ' of ' + fmtBytes(est.quota) + ' available' : ''}`;
      else if (el) el.textContent = 'Unknown';
      if (pe && (await navigator.storage?.persisted?.())) pe.textContent = 'On: the browser won’t clear your music';
    } catch { if (el) el.textContent = 'Unknown'; }
  },

  sound() {
    const xf = $('#xf');
    xf?.addEventListener('input', () => {
      CFG.crossfade = +xf.value;
      saveCfg();
      $('#xf-label').textContent = CFG.crossfade ? CFG.crossfade + ' seconds' : 'Off';
    });
  },

  eq() { bindEq($('#view')); },

  async spotify() {
    if (!sp.isConnected()) return;
    const list = $('#sp-list');
    try {
      const [me, pls] = await Promise.all([sp.me(), sp.playlists()]);
      spPlaylists = pls;
      if (!list.isConnected) return;
      $('#sp-acct').textContent = me.display_name || me.id;
      list.innerHTML = [{ id: 'liked', name: 'Liked Songs', liked: true }, ...pls].map(spRow).join('');
    } catch (e) {
      if (list.isConnected) list.innerHTML = `<p class="hint err" style="padding:0">${esc(spError(e))}</p>`;
    }
  },
};

function tintView() {
  const el = $('#view .coll[data-tint]');
  if (!el || !el.dataset.tint) return;
  tintOf(el.dataset.tint).then(c => { if (c) el.style.setProperty('--tint', c); });
}

// ---------- search ----------

function searchResults() {
  const d = derived();
  const q = fold(S.query.trim());
  if (!q) {
    const tiles = [];
    const tile = (v, id, label, color, art = '') =>
      `<button class="tile" style="--c:${color}" data-act="nav" data-v="${v}" data-id="${esc(id)}"><span>${esc(label)}</span>${art}</button>`;
    if (d.all.length) tiles.push(tile('songs', 'songs', 'All songs', '#148a08', artHTML(d.all.find(t => t.artKey)?.artKey)));
    tiles.push(tile('liked', 'liked', 'Liked Songs', '#5038a0', likedArt()));
    const a = autoLists();
    for (const c of [...a.fam, ...a.mood, ...a.lang]) tiles.push(tile(c.v, c.id, c.title, c.color, artHTML(c.tracks.find(t => t.artKey)?.artKey)));
    for (const g of d.genres.filter(g => !smart.familyOfGenre(g.name)).slice(0, 8)) tiles.push(tile('genre', g.name, g.name, tileColor(g.name), artHTML(g.artKey)));
    return `<h2 class="sec-h">Browse all</h2><div class="tiles">${tiles.join('')}</div>`;
  }
  const has = s => fold(s).includes(q);
  const songs = d.all.filter(t => has(t.title) || has(t.artist) || has(t.album) || has(t.albumArtist) || has(t.memory?.text)).slice(0, 60);
  const artists = d.artists.filter(a => has(a.name)).slice(0, 10);
  const albums = d.albums.filter(a => has(a.title) || has(a.artist)).slice(0, 10);
  const pls = [...S.playlists.values()].filter(p => has(p.name));
  const genres = d.genres.filter(g => has(g.name)).slice(0, 6);
  const al = autoLists();
  const autos = [...al.daily, ...al.smart, ...al.fam, ...al.mood, ...al.lang].filter(c => has(c.title));
  if (!songs.length && !artists.length && !albums.length && !pls.length && !genres.length && !autos.length) {
    return `<div class="empty small"><h3>No results for “${esc(S.query.trim())}”</h3><p class="hint">Check the spelling, or try different keywords.</p></div>`;
  }
  let html = '';
  if (songs.length) {
    const L2 = regList(songs.map(t => t.id), null);
    html += `<h2 class="sec-h">Songs</h2>` + songs.map((t, i) => songRow(t, L2, i, { sub: t => (t.memory?.text && has(t.memory.text) ? `Memory · ${t.memory.text}` : `Song · ${t.artist || 'Unknown artist'}`) })).join('');
  }
  if (artists.length) html += `<h2 class="sec-h">Artists</h2>` + artists.map(a => `<div class="round-art">${navRow('artist', a.name, artHTML(a.artKey, 'sm round', 'user'), a.name, 'Artist')}</div>`).join('');
  if (albums.length) html += `<h2 class="sec-h">Albums</h2>` + albums.map(a => navRow('album', a.key, artHTML(a.artKey, 'sm'), a.title, `Album · ${a.artist}`)).join('');
  if (pls.length || autos.length) html += `<h2 class="sec-h">Playlists</h2>` + pls.map(p => ctxRow(ctxOf('playlist', p.id))).join('') + autos.map(ctxRow).join('');
  if (genres.length) html += `<h2 class="sec-h">Genres</h2>` + genres.map(g => navRow('genre', g.name, artHTML(g.artKey, 'sm'), g.name, `Genre · ${plural(g.count, 'song')}`)).join('');
  return html;
}

function updateResults() {
  lists = [];
  const r = $('#results');
  r.innerHTML = searchResults();
  hydrate(r);
  const clear = $('.search-box .clear');
  if (clear) clear.hidden = !S.query;
  syncPlayState();
}

// ---------- Spotify playlist matching ----------

function matchIndex() {
  const idx = new Map();
  for (const t of S.tracks.values()) {
    const k = smart.normTitle(t.title);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(t);
  }
  return idx;
}

function findMatch(s, idx) {
  const cands = idx.get(smart.normTitle(s.title)) || [];
  if (!cands.length) return null;
  const arts = s.artists.map(smart.normName).filter(Boolean);
  const byArtist = cands.find(t => {
    const a = smart.normName((t.artist || '') + ' ' + (t.albumArtist || ''));
    return a && arts.some(x => a.includes(x) || x.includes(a));
  });
  if (byArtist) return byArtist;
  return cands.find(t => t.duration && s.durationMs && Math.abs(t.duration * 1000 - s.durationMs) < 2500)
    || (cands.length === 1 && !cands[0].artist ? cands[0] : null);
}

function rematchAll() {
  const idx = matchIndex();
  for (const p of S.playlists.values()) {
    let dirty = false;
    for (const it of p.items) {
      if (!it.sp) continue;
      const id = findMatch(it.sp, idx)?.id || null;
      if (id !== it.trackId) { it.trackId = id; dirty = true; }
    }
    if (dirty) db.put('playlists', p);
  }
}

// ---------- audio settings ----------

function eqFor(t) {
  if (CFG.eqMode === 'off') return new Array(10).fill(0);
  if (t?.eqCustom) return t.eqCustom;
  if (CFG.eqMode === 'smart') return t ? smart.recommendEQ(t).gains : new Array(10).fill(0);
  if (CFG.eqMode === 'preset') return (smart.EQ_PRESETS[CFG.eqPreset] || smart.EQ_PRESETS.flat).g;
  return CFG.eqCustom;
}

function eqSummary() {
  if (CFG.eqMode === 'off') return 'Off';
  if (CFG.eqMode === 'smart') return 'Smart: a unique curve for every song';
  if (CFG.eqMode === 'preset') return smart.EQ_PRESETS[CFG.eqPreset]?.name || 'Preset';
  return 'Custom';
}

function levelFor(t) {
  if (!CFG.leveling || !t?.an?.loudness) return 1;
  let dB = -14 - t.an.loudness;
  dB = clamp(dB, -12, 6);
  if (t.an.peak != null) dB = Math.min(dB, -t.an.peak + 3); // the limiter catches the rest
  return Math.pow(10, dB / 20);
}

function applyAudio() {
  const t = cur();
  eng.setEQ(eqFor(t));
  eng.setKaraoke(CFG.karaoke);
  eng.setEffect(CFG.effect);
  eng.setRate(CFG.speed);
  if (t) eng.setLevel(levelFor(t));
}

function setCfg(k, v) {
  CFG[k] = v;
  saveCfg();
  if (k === 'enhanced') {
    eng.setEnhanced(v);
    if (v) eng.prime();
    toast(v ? 'Enhanced audio on' : 'Enhanced audio off');
  }
  applyAudio();
}

// ---------- player ----------

const cur = () => S.tracks.get(S.queue[S.qi]);

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const shuffleRest = ids => (CFG.smartShuffle ? smart.smartShuffle(ids, S.tracks, artistOf) : shuffled(ids));

function startQueue(ids, i, ctx) {
  ids = ids.filter(id => S.tracks.has(id));
  if (!ids.length) return;
  i = clamp(i, 0, ids.length - 1);
  S.ctx = ctx;
  S.unshuffled = ids.slice();
  S.loop = null;
  if (S.shuffle) {
    S.queue = [ids[i], ...shuffleRest(ids.filter((_, k) => k !== i))];
    S.qi = 0;
  } else {
    S.queue = ids.slice();
    S.qi = i;
  }
  if (ctx) addRecent(ctx);
  loadAt(S.qi);
}

const startOffset = t => (CFG.skipSilence && t.an?.intro > 0.3 ? Math.max(0, t.an.intro - 0.05) : 0);

let loadSeq = 0;
/** mode: 'play' | 'paused' | { fade: seconds } (crossfade from the current song) */
async function loadAt(i, mode = 'play', startAt = null) {
  const seq = ++loadSeq;
  commitListen();
  S.qi = i;
  S.loop = null;
  const t = cur();
  if (!t) return;
  updatePlayerUI();
  const blob = await db.get('files', t.id).catch(() => null);
  if (seq !== loadSeq) return;
  if (!blob) { toast(`Couldn’t find the file for “${t.title}”`); return; }
  const at = startAt ?? startOffset(t);
  eng.setEQ(eqFor(t));
  if (typeof mode === 'object') eng.crossfadeTo(blob, { startAt: at, level: levelFor(t), seconds: mode.fade });
  else eng.load(blob, { startAt: at, level: levelFor(t), play: mode === 'play' });
  S.listen = { id: t.id, sec: 0, counted: false };
  setMediaSession(t);
  saveQueue(true);
  loadLyrics(t);
  updatePlayerUI();
}

function toggle() {
  if (!cur()) return;
  if (eng.paused()) {
    if (!eng.hasSource()) loadAt(S.qi);
    else eng.play();
  } else {
    eng.pause();
  }
}

function nextIndex() {
  if (S.qi + 1 < S.queue.length) return S.qi + 1;
  if (S.ctx?.v === 'radio') { extendRadio(); if (S.qi + 1 < S.queue.length) return S.qi + 1; }
  if (S.repeat === 'all') return 0;
  return -1;
}

function extendRadio() {
  const seed = S.tracks.get(S.ctx.id);
  if (!seed) return;
  const d = derived();
  const recent = new Set(S.queue.slice(-60));
  const more = smart.radio(seed, d.all, d.feats, artistsOf, recent, 20);
  S.queue.push(...more);
  S.unshuffled?.push(...more);
}

function next(auto = false) {
  if (!S.queue.length) return;
  if (auto && S.sleep?.end) { S.sleep = null; eng.pause(); updateSleepUI(); toast('Sleep timer: goodnight'); return; }
  if (S.ctx?.v === 'radio' && S.queue.length - S.qi < 4) extendRadio();
  const ni = nextIndex();
  if (ni >= 0) loadAt(ni);
  else if (auto) { eng.seek(0); eng.pause(); }
  else loadAt(0, 'paused');
}

function prev() {
  if (eng.time() > 3 || S.qi <= 0) { eng.seek(startOffset(cur() || {})); return; }
  loadAt(S.qi - 1);
}

function setShuffle(on) {
  S.shuffle = on;
  ls.set('shuffle', on);
  const t = cur();
  if (t) {
    if (on) {
      S.unshuffled = S.queue.slice();
      S.queue = [t.id, ...shuffleRest(S.queue.filter((_, k) => k !== S.qi))];
      S.qi = 0;
    } else if (S.unshuffled) {
      S.queue = S.unshuffled.slice();
      S.qi = Math.max(0, S.queue.indexOf(t.id));
    }
    saveQueue(true);
  }
  updatePlayerUI();
  for (const b of $$('#view [data-act="shuffle-play"]')) b.classList.toggle('on', on);
}

function cycleRepeat() {
  S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat];
  ls.set('repeat', S.repeat);
  updatePlayerUI();
}

function playNext(ids) {
  if (!cur()) return startQueue(ids, 0, null);
  S.queue.splice(S.qi + 1, 0, ...ids);
  if (S.unshuffled) {
    const at = S.unshuffled.indexOf(cur().id);
    S.unshuffled.splice(at + 1, 0, ...ids);
  }
  saveQueue(true);
  toast(ids.length > 1 ? `${ids.length} songs will play next` : 'Playing next');
}

function addToQueue(ids) {
  if (!cur()) return startQueue(ids, 0, null);
  S.queue.push(...ids);
  S.unshuffled?.push(...ids);
  saveQueue(true);
  toast(ids.length > 1 ? `Added ${ids.length} songs to queue` : 'Added to queue');
}

function startRadio(t) {
  S.radio = null;
  const c = ctxOf('radio', t.id);
  startQueue(c.tracks.map(x => x.id), 0, { v: 'radio', id: t.id });
  toast(`Playing ${t.title} Radio`);
}

function addRecent(ctx) {
  if (!ctx || ctx.v === 'songs') return;
  S.recent = [{ v: ctx.v, id: ctx.id }, ...S.recent.filter(r => !(r.v === ctx.v && r.id === ctx.id))].slice(0, 12);
  ls.set('recent', S.recent);
}

let lastSave = 0;
function saveQueue(force = false) {
  if (!force && Date.now() - lastSave < 5000) return;
  lastSave = Date.now();
  ls.set('player', { queue: S.queue.slice(0, 2000), qi: S.qi, ctx: S.ctx, unshuffled: S.unshuffled?.slice(0, 2000) || null, t: eng.time() });
}

function restoreQueue() {
  const p = ls.get('player', null);
  if (!p || !p.queue?.length) return;
  const cid = p.queue[p.qi];
  S.queue = p.queue.filter(id => S.tracks.has(id));
  S.unshuffled = p.unshuffled ? p.unshuffled.filter(id => S.tracks.has(id)) : null;
  S.ctx = p.ctx || null;
  const qi = S.queue.indexOf(cid);
  if (qi < 0) { S.queue = []; return; }
  loadAt(qi, 'paused', p.t || 0);
}

// Listening log: counts a play after 30 s (or half the song), records minutes for stats.
function commitListen() {
  const l = S.listen;
  S.listen = null;
  if (!l || l.sec < 5) return;
  const h = { trackId: l.id, at: Date.now(), s: Math.round(l.sec) };
  S.history.push(h);
  db.put('history', h).catch(() => {});
}

function tickListen(dt) {
  const l = S.listen;
  const t = cur();
  if (!l || !t || l.id !== t.id) return;
  l.sec += dt;
  if (!l.counted && (l.sec >= 30 || (t.duration && l.sec >= t.duration * 0.5))) {
    l.counted = true;
    t.plays = (t.plays || 0) + 1;
    t.lastPlayed = Date.now();
    db.put('tracks', t);
  }
}

// The heartbeat: transitions, A–B loop, lyrics, sleep timer, listening time.
let lastTick = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(1, (now - lastTick) / 1000);
  lastTick = now;
  const t = cur();
  if (!t || eng.paused()) return;
  tickListen(dt * (CFG.speed || 1));
  const pos = eng.time();
  const dur = eng.duration() || t.duration || 0;

  if (S.loop?.b != null && pos >= S.loop.b) { eng.seek(S.loop.a); return; }
  if (S.showLyrics) updateLyrics(pos);
  if (S.sleep?.until && Date.now() >= S.sleep.until) {
    S.sleep = null;
    updateSleepUI();
    eng.fadeOutAndPause(CFG.enhanced ? 12 : 6).then(() => toast('Sleep timer: goodnight'));
    return;
  }
  if (!dur || eng.isFading() || S.repeat === 'one' || S.loop) return;
  maybeTransition(t, pos, dur);
}

function maybeTransition(t, pos, dur) {
  if (S.sleep?.end) return; // let the song end, then stop
  const ni = S.qi + 1 < S.queue.length ? S.qi + 1 : (S.ctx?.v === 'radio' || S.repeat === 'all') ? -2 : -1;
  if (ni === -1) return;
  const end = CFG.skipSilence && t.an?.outro ? Math.min(dur, t.an.outro + 0.15) : dur;
  const nextT = ni >= 0 ? S.tracks.get(S.queue[ni]) : null;
  const sameAlbum = nextT && CFG.smartTransitions && albumKey(nextT) === albumKey(t) && (nextT.track || 0) === (t.track || 0) + 1;
  let fade = eng.isEnhanced() ? CFG.crossfade : 0;
  let startAt = end - fade;
  if (fade && sameAlbum) { fade = 0; startAt = end; }
  else if (fade && CFG.smartTransitions && t.an?.fade && t.an.fade < end - 1 && t.an.fade > end - fade * 2) {
    startAt = t.an.fade; // the song already fades out here; blend over its natural fade
    fade = clamp(end - t.an.fade, 2, 12);
  }
  if (!fade) {
    // Safe mode or gapless: switch exactly where the music stops (when that's before the file ends).
    if (end < dur - 0.4 && pos >= end - 0.12) advance(0);
    return;
  }
  if (pos >= startAt) advance(fade);
}

function advance(fade) {
  if (S.ctx?.v === 'radio' && S.queue.length - S.qi < 4) extendRadio();
  const ni = nextIndex();
  if (ni < 0) return;
  loadAt(ni, fade > 0 ? { fade } : 'play');
}

const ctxLabel = () => {
  const c = S.ctx && ctxOf(S.ctx.v, S.ctx.id);
  if (!c) return ['Playing from', 'Your library'];
  const kinds = { album: 'album', artist: 'artist', playlist: 'playlist', liked: 'playlist', genre: 'genre', songs: 'your library', auto: 'mix', radio: 'radio' };
  return [`Playing from ${kinds[c.v]}`, c.title];
};

let miniArtKey;
let npArtKey;
function updatePlayerUI() {
  const t = cur();
  const mini = $('#mini');
  document.body.classList.toggle('has-mini', !!t);
  mini.hidden = !t;
  if (!t) { closeNP(); return; }
  $('#mini-t').textContent = t.title;
  $('#mini-s').textContent = t.artist || 'Unknown artist';
  if (miniArtKey !== t.artKey) {
    miniArtKey = t.artKey;
    $('#mini-art').innerHTML = artHTML(t.artKey);
    hydrate($('#mini-art'));
  }
  if (npArtKey !== t.artKey) {
    npArtKey = t.artKey;
    $('#np-art').innerHTML = artHTML(t.artKey);
    hydrate($('#np-art'));
  }
  for (const b of $$('[data-act="like-cur"]')) {
    b.classList.toggle('liked', !!t.liked);
    b.innerHTML = icon(t.liked ? 'heart-fill' : 'heart');
  }
  $('#np-t').textContent = t.title;
  $('#np-s').textContent = t.artist || 'Unknown artist';
  const [k, name] = ctxLabel();
  $('#np-ctx-k').textContent = k;
  $('#np-ctx').textContent = name;
  $('#np-shuffle').classList.toggle('on', S.shuffle);
  const rp = $('#np-repeat');
  rp.classList.toggle('on', S.repeat !== 'off');
  rp.innerHTML = icon(S.repeat === 'one' ? 'repeat-one' : 'repeat');
  const memo = $('#np-memory');
  memo.hidden = !t.memory?.text;
  if (t.memory?.text) memo.innerHTML = `${icon('note')}<span>${esc(t.memory.text)}</span>`;
  $('#np-speed-btn').innerHTML = `<span class="speed-txt">${CFG.speed}×</span>`;
  $('#np-speed-btn').classList.toggle('on', CFG.speed !== 1);
  $('#np-eq-btn').classList.toggle('on', CFG.eqMode !== 'off' && eng.isEnhanced());
  updateLoopUI();
  updateSleepUI();
  if ($('#car')) updateCar();
  tintOf(t.artKey).then(c => {
    const col = c || '#535353';
    mini.style.setProperty('--tint', col);
    $('#np').style.setProperty('--tint', col);
    $('#car')?.style.setProperty('--tint', col);
  });
  updateProgress();
  syncPlayState();
}

function syncPlayState() {
  const t = cur();
  const playing = !!t && !eng.paused();
  for (const el of $$('[data-play-icon]')) el.innerHTML = icon(playing ? 'pause' : 'play');
  for (const el of $$('#view .play-big')) {
    const mine = S.ctx && el.dataset.v === S.ctx.v && el.dataset.id === String(S.ctx.id);
    el.innerHTML = icon(mine && playing ? 'pause' : 'play');
  }
  for (const el of $$('.song[data-tid]')) el.classList.toggle('playing', el.dataset.tid === t?.id);
}

let seeking = false;
function updateProgress() {
  const t = cur();
  const dur = eng.duration() || t?.duration || 0;
  const pos = eng.time();
  const frac = dur ? Math.min(1, pos / dur) : 0;
  $('#mini-bar').style.width = `${frac * 100}%`;
  if (!seeking) {
    const seek = $('#seek');
    seek.value = Math.round(frac * 1000);
    seek.style.setProperty('--p', `${frac * 100}%`);
    $('#np-cur').textContent = fmtTime(pos);
  }
  $('#np-dur').textContent = fmtTime(dur);
  const cp = $('#car-bar');
  if (cp) cp.style.width = `${frac * 100}%`;
}

async function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  const art = t.artKey ? await artDataURL(t.artKey) : null;
  if (cur() !== t) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || '',
      album: t.album || '',
      artwork: art ? [{ src: art, sizes: '512x512' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch {}
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = eng.duration();
  if (!d) return;
  try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: CFG.speed || 1, position: Math.min(eng.time(), d) }); } catch {}
}

function setupAudio() {
  eng.init();
  eng.setEnhanced(CFG.enhanced);
  eng.on('play', () => { syncPlayState(); updatePositionState(); lastTick = performance.now(); });
  eng.on('pause', () => { syncPlayState(); saveQueue(true); updatePositionState(); });
  eng.on('timeupdate', () => { updateProgress(); saveQueue(); });
  eng.on('seeked', updatePositionState);
  eng.on('switched', () => { syncPlayState(); applyAudio(); });
  eng.on('loadedmetadata', () => {
    const t = cur();
    const d = eng.duration();
    if (t && d && Math.abs((t.duration || 0) - d) > 1) { t.duration = d; db.put('tracks', t); }
    updateProgress();
    updatePositionState();
  });
  eng.on('ended', () => {
    if (S.repeat === 'one') { eng.seek(startOffset(cur() || {})); eng.play(); return; }
    if (S.loop) { eng.seek(S.loop.a); eng.play(); return; }
    next(true);
  });
  eng.on('error', () => {
    const t = cur();
    toast(t ? `Can’t play “${t.title}” on this device` : 'Playback error');
  });
  eng.on('blocked', () => toast('Tap play to start'));
  setInterval(tick, 200);

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const h = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
    h('play', () => eng.play());
    h('pause', () => eng.pause());
    h('previoustrack', prev);
    h('nexttrack', () => next());
    h('seekto', e => { if (e.seekTime != null) eng.seek(e.seekTime); updatePositionState(); });
  }
}

// ---------- player chrome ----------

function buildChrome() {
  $('#tabs').innerHTML = [['home', 'Home'], ['search', 'Search'], ['library', 'Your Library']]
    .map(([k, l]) => `<button data-act="tab" data-tab="${k}">${icon(k)}<span>${l}</span></button>`).join('');

  $('#mini').innerHTML = `<div id="mini-art"></div>
    <div class="mini-meta"><div class="t" id="mini-t"></div><div class="s" id="mini-s"></div></div>
    <button class="icon-btn" data-act="like-cur" aria-label="Like"></button>
    <button class="icon-btn" data-act="toggle" data-play-icon aria-label="Play or pause"></button>
    <div class="mini-prog"><i id="mini-bar"></i></div>`;

  $('#np').innerHTML = `<div class="np-inner">
    <header class="np-head"><button class="icon-btn" data-act="close-np" aria-label="Close">${icon('down')}</button>
      <div class="np-ctx"><small id="np-ctx-k"></small><b id="np-ctx"></b></div>
      <button class="icon-btn" data-act="np-menu" aria-label="More">${icon('more')}</button></header>
    <div class="np-art-wrap" id="np-stage">
      <div id="np-art"></div>
      <div id="np-lyrics" class="np-lyrics no-drag" hidden></div>
      <div class="heart-pop" id="heart-pop">${icon('heart-fill')}</div>
    </div>
    <button class="np-memory" id="np-memory" data-act="memory-cur" hidden></button>
    <div class="np-info"><div class="np-titles"><div class="np-t" id="np-t"></div><button class="np-s" id="np-s" data-act="np-artist"></button></div>
      <button class="icon-btn" data-act="like-cur" aria-label="Like"></button></div>
    <div class="np-seek"><div class="seek-wrap"><input type="range" id="seek" min="0" max="1000" value="0" aria-label="Seek"><i class="ab-mark" id="ab-a" hidden></i><i class="ab-mark" id="ab-b" hidden></i></div><div class="np-times"><span id="np-cur">0:00</span><span id="np-dur">0:00</span></div></div>
    <div class="np-ctrls">
      <button class="icon-btn" id="np-shuffle" data-act="shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
      <button class="icon-btn skip" data-act="prev" aria-label="Previous">${icon('prev')}</button>
      <button class="play-xl" data-act="toggle" data-play-icon aria-label="Play or pause"></button>
      <button class="icon-btn skip" data-act="next" aria-label="Next">${icon('next')}</button>
      <button class="icon-btn" id="np-repeat" data-act="repeat" aria-label="Repeat">${icon('repeat')}</button>
    </div>
    <div class="np-foot">
      <button class="icon-btn" id="np-lyr-btn" data-act="np-lyrics" aria-label="Lyrics">${icon('lyrics')}</button>
      <button class="icon-btn" id="np-eq-btn" data-act="eq-sheet" aria-label="Equalizer">${icon('eq')}</button>
      <button class="icon-btn" id="np-speed-btn" data-act="speed-sheet" aria-label="Playback speed"></button>
      <button class="icon-btn" id="np-ab-btn" data-act="ab" aria-label="A to B loop">${icon('loop')}</button>
      <button class="icon-btn" id="np-sleep-btn" data-act="sleep-sheet" aria-label="Sleep timer">${icon('moon')}</button>
      <button class="icon-btn" data-act="queue" aria-label="Queue">${icon('queue')}</button>
    </div>
  </div>`;

  const mini = $('#mini');
  mini.addEventListener('click', e => { if (!e.target.closest('button') && !mini.dataset.swiped) openNP(); });
  swipeX(mini, dir => (dir < 0 ? next() : prev()), mini);

  const seek = $('#seek');
  seek.addEventListener('input', () => {
    seeking = true;
    const dur = eng.duration() || cur()?.duration || 0;
    seek.style.setProperty('--p', `${seek.value / 10}%`);
    $('#np-cur').textContent = fmtTime((seek.value / 1000) * dur);
  });
  seek.addEventListener('change', () => {
    const dur = eng.duration();
    if (dur) eng.seek((seek.value / 1000) * dur);
    seeking = false;
  });

  const np = $('#np');
  dragToClose(np, closeNP, e => !e.target.closest('input, .np-ctrls, .np-lyrics, #np-art'));

  // Cover gestures: swipe to change song, double-tap to like.
  const stage = $('#np-art');
  swipeX(stage, dir => (dir < 0 ? next() : prev()), $('#np-art'));
  let lastTap = 0;
  stage.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 320) {
      const t = cur();
      if (t && !t.liked) toggleLike(t);
      const hp = $('#heart-pop');
      hp.classList.remove('go');
      void hp.offsetWidth;
      hp.classList.add('go');
      lastTap = 0;
    } else lastTap = now;
  });
}

/** Horizontal swipe on an element; `moving` gets a little translate feedback. */
function swipeX(el, onSwipe, moving) {
  let x0 = null, y0 = 0, dx = 0, locked = null;
  el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; locked = null; }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (x0 == null) return;
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (locked == null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (locked === 'x') { moving.style.transition = 'none'; moving.style.transform = `translateX(${dx * 0.6}px)`; }
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (x0 == null) return;
    moving.style.transition = '';
    moving.style.transform = '';
    if (locked === 'x' && Math.abs(dx) > 60) {
      el.dataset.swiped = '1';
      setTimeout(() => delete el.dataset.swiped, 350);
      onSwipe(dx < 0 ? -1 : 1);
    }
    x0 = null;
  });
}

function openNP() {
  if (!cur()) return;
  const np = $('#np');
  np.classList.add('anim');
  requestAnimationFrame(() => np.classList.add('open'));
  np.setAttribute('aria-hidden', 'false');
}

function closeNP() {
  const np = $('#np');
  if (!np.classList.contains('open')) return;
  np.classList.remove('open');
  np.setAttribute('aria-hidden', 'true');
  setTimeout(() => { if (!np.classList.contains('open')) np.classList.remove('anim'); }, 350);
}

function queueSheet() {
  const t = cur();
  if (!t) return;
  const qRow = (tr, i, now) => `<div class="row song${now ? ' playing' : ''}" data-qi="${i}" data-tid="${tr.id}">${artHTML(tr.artKey, 'sm')}<div class="meta"><div class="t">${esc(tr.title)}</div><div class="s"><span class="txt">${esc(tr.artist || 'Unknown artist')}</span></div></div>${now ? '' : `<button class="icon-btn" data-qrm aria-label="Remove">${icon('close')}</button>`}</div>`;
  const up = S.queue.slice(S.qi + 1, S.qi + 201).map((id, k) => [S.tracks.get(id), S.qi + 1 + k]).filter(x => x[0]);
  const [, name] = ctxLabel();
  const s = sheet(`<div class="sheet-title">Queue</div><div class="q-sec">Now playing</div>${qRow(t, S.qi, true)}
    <div class="q-sec">Next from: ${esc(name)}</div>${up.length ? up.map(([tr, i]) => qRow(tr, i)).join('') : '<p class="hint">Nothing up next.</p>'}`, { cls: 'tall' });
  s.el.addEventListener('click', e => {
    const r = e.target.closest('[data-qi]');
    if (!r) return;
    const i = +r.dataset.qi;
    if (e.target.closest('[data-qrm]')) {
      const id = S.queue[i];
      S.queue.splice(i, 1);
      if (S.unshuffled) { const u = S.unshuffled.indexOf(id); if (u >= 0) S.unshuffled.splice(u, 1); }
      saveQueue(true);
      r.remove();
      $$('[data-qi]', s.el).forEach(el => { if (+el.dataset.qi > i) el.dataset.qi = +el.dataset.qi - 1; });
      return;
    }
    if (i !== S.qi) loadAt(i);
    s.close();
  });
}

// ---------- lyrics ----------

async function loadLyrics(t) {
  S.lyrics = null;
  if (t.hasLyrics) {
    const text = await db.get('lyrics', t.id).catch(() => null);
    if (cur() !== t) return;
    S.lyrics = { id: t.id, data: parseLyrics(text) };
  }
  $('#np-lyr-btn').classList.toggle('on', !!S.lyrics?.data);
  if (S.showLyrics) renderLyrics();
}

function renderLyrics() {
  const box = $('#np-lyrics');
  const data = S.lyrics?.data;
  if (!data) {
    box.innerHTML = `<div class="lyr-empty">${icon('lyrics')}<p>No lyrics for this song.</p><button class="btn-ghost" data-act="lyrics-add-cur">Add an .lrc or text file</button></div>`;
    return;
  }
  box.innerHTML = `${data.synced ? '' : '<p class="lyr-note">Not synced</p>'}${data.lines.map((l, i) => `<p data-li="${i}"${l.t != null ? ` data-t="${l.t}"` : ''}>${esc(l.text) || '♪'}</p>`).join('')}`;
  box.classList.toggle('static', !data.synced);
  box.dataset.on = '-1';
  updateLyrics(eng.time());
}

function updateLyrics(pos) {
  const data = S.lyrics?.data;
  if (!data?.synced) return;
  const box = $('#np-lyrics');
  const i = activeLine(data, pos);
  if (String(i) === box.dataset.on) return;
  box.dataset.on = String(i);
  $$('p.on', box).forEach(p => p.classList.remove('on'));
  const p = box.querySelector(`p[data-li="${i}"]`);
  if (!p) return;
  p.classList.add('on');
  box.scrollTo({ top: p.offsetTop - box.clientHeight * 0.35, behavior: 'smooth' });
}

function toggleLyricsView() {
  S.showLyrics = !S.showLyrics;
  $('#np-lyrics').hidden = !S.showLyrics;
  $('#np-art').style.visibility = S.showLyrics ? 'hidden' : '';
  $('#np-lyr-btn').classList.toggle('active', S.showLyrics);
  if (S.showLyrics) renderLyrics();
}

async function saveLyrics(t, text) {
  const data = parseLyrics(text);
  if (!data) { toast('That file doesn’t contain any lyrics'); return false; }
  await db.put('lyrics', text, t.id);
  t.hasLyrics = true;
  await db.put('tracks', t);
  if (t === cur()) loadLyrics(t);
  return data;
}

function pickLyrics(t) {
  const inp = $('#lyrics-input');
  inp.onchange = async () => {
    const f = inp.files[0];
    inp.value = '';
    if (!f) return;
    const data = await saveLyrics(t, await f.text());
    if (data) toast(data.synced ? 'Synced lyrics added' : 'Lyrics added (not synced)');
  };
  inp.click();
}

// ---------- A–B loop, speed, sleep ----------

function cycleLoop() {
  const pos = eng.time();
  if (!S.loop) { S.loop = { a: pos, b: null }; toast('Loop start set. Tap again to set the end.'); }
  else if (S.loop.b == null) {
    if (pos <= S.loop.a + 1) { toast('Pick an end point after the start'); return; }
    S.loop.b = pos;
    eng.seek(S.loop.a);
    toast(`Looping ${fmtTime(S.loop.a)} – ${fmtTime(S.loop.b)}`);
  } else { S.loop = null; toast('Loop off'); }
  updateLoopUI();
}

function updateLoopUI() {
  const btn = $('#np-ab-btn');
  const dur = eng.duration() || cur()?.duration || 0;
  btn.classList.toggle('on', !!S.loop);
  btn.innerHTML = S.loop ? `<span class="speed-txt">${S.loop.b == null ? 'A–' : 'A–B'}</span>` : icon('loop');
  for (const [k, id] of [['a', '#ab-a'], ['b', '#ab-b']]) {
    const m = $(id);
    const v = S.loop?.[k];
    m.hidden = v == null || !dur;
    if (v != null && dur) m.style.left = `${(v / dur) * 100}%`;
  }
}

function speedSheet() {
  const speeds = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const s = sheet(`<div class="sheet-title">Playback speed</div><div class="chips wrap center">${speeds.map(v => `<button class="chip${CFG.speed === v ? ' on' : ''}" data-sp="${v}">${v}×</button>`).join('')}</div><p class="hint" style="text-align:center">The pitch stays natural at every speed.</p>`);
  s.el.addEventListener('click', e => {
    const b = e.target.closest('[data-sp]');
    if (!b) return;
    setCfg('speed', +b.dataset.sp);
    updatePlayerUI();
    s.close();
  });
}

function sleepSheet() {
  const opts = [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], ['end', 'End of this song']];
  const items = opts.map(([v, l]) => ({ icon: 'timer', label: l, run: () => { S.sleep = v === 'end' ? { end: true } : { until: Date.now() + v * 60000 }; updateSleepUI(); toast(v === 'end' ? 'Music stops after this song' : `Music stops in ${l}`); } }));
  if (S.sleep) items.unshift({ icon: 'close', label: 'Turn off sleep timer', run: () => { S.sleep = null; updateSleepUI(); toast('Sleep timer off'); } });
  menu(`<div class="sheet-title">Sleep timer${S.sleep?.until ? ` · ${Math.ceil((S.sleep.until - Date.now()) / 60000)} min left` : S.sleep?.end ? ' · end of song' : ''}</div>`, items);
}

function updateSleepUI() {
  const b = $('#np-sleep-btn');
  if (!b) return;
  b.classList.toggle('on', !!S.sleep);
  b.innerHTML = S.sleep?.until ? `<span class="speed-txt">${Math.max(1, Math.ceil((S.sleep.until - Date.now()) / 60000))}m</span>` : icon('moon');
}
setInterval(updateSleepUI, 30000);

// ---------- equalizer UI ----------

const EQ_W = 340, EQ_H = 170, EQ_PAD = 16, EQ_MAX = 12;
const eqX = i => EQ_PAD + (i * (EQ_W - 2 * EQ_PAD)) / 9;
const eqY = g => EQ_H / 2 - (g * (EQ_H / 2 - EQ_PAD)) / EQ_MAX;
function eqPath(g) {
  const pts = g.map((v, i) => [eqX(i), eqY(v)]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d;
}
function eqSVG(g, editable) {
  const labels = ['32', '64', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
  return `<svg class="eq-svg${editable ? ' editable' : ''}" viewBox="0 0 ${EQ_W} ${EQ_H + 22}" aria-label="Equalizer curve">
    ${[-12, -6, 0, 6, 12].map(v => `<line x1="${EQ_PAD}" x2="${EQ_W - EQ_PAD}" y1="${eqY(v)}" y2="${eqY(v)}" class="${v ? 'grid' : 'zero'}"/>`).join('')}
    <path class="eq-fill" d="${eqPath(g)} L${eqX(9)},${eqY(0)} L${eqX(0)},${eqY(0)} Z"/>
    <path class="eq-line" d="${eqPath(g)}"/>
    ${g.map((v, i) => `<circle data-band="${i}" cx="${eqX(i)}" cy="${eqY(v)}" r="${editable ? 8 : 4}"/>`).join('')}
    ${labels.map((l, i) => `<text x="${eqX(i)}" y="${EQ_H + 16}">${l}</text>`).join('')}
  </svg>`;
}

function eqEditorHTML() {
  const t = cur();
  const modes = [['off', 'Off'], ['smart', 'Smart'], ['custom', 'Custom']];
  const presetChips = Object.entries(smart.EQ_PRESETS).map(([k, p]) => `<button class="chip${CFG.eqMode === 'preset' && CFG.eqPreset === k ? ' on' : ''}" data-eq-preset="${k}">${p.name}</button>`).join('');
  const gains = CFG.eqMode === 'off' ? new Array(10).fill(0) : t?.eqCustom && CFG.eqMode !== 'off' ? t.eqCustom : eqFor(t);
  const rec = t ? smart.recommendEQ(t) : null;
  return `<div class="eq-editor">
    ${!CFG.enhanced ? `<div class="box warn">${icon('sparkle')}<div><b>Turn on Enhanced audio to hear the equalizer</b><button class="btn-ghost" data-act="enable-enhanced">Turn on</button></div></div>` : ''}
    <div class="chips wrap">${modes.map(([k, l]) => `<button class="chip${CFG.eqMode === k ? ' on' : ''}" data-eq-mode="${k}">${l}</button>`).join('')}</div>
    <div class="eq-graph">${eqSVG(gains, true)}</div>
    <p class="hint eq-mode-note">${CFG.eqMode === 'smart' ? 'Smart EQ gives every song its own curve, based on how that song actually sounds.' : CFG.eqMode === 'off' ? 'Drag a dot to start a custom curve.' : t?.eqCustom ? 'This song has its own saved EQ.' : 'Drag the dots to shape the sound.'}</p>
    <h3 class="eq-h">Presets</h3><div class="chips scroll">${presetChips}</div>
    ${t ? `<div class="box eq-song">
      <h3>${icon('sparkle')} Recommended for “${esc(t.title)}”</h3>
      ${eqSVG(rec.gains, false)}
      ${rec.reasons.map(r => `<p>${esc(r)}</p>`).join('')}
      <div class="eq-song-btns">
        <button class="btn-ghost" data-act="eq-song-use">Use for this song</button>
        ${t.eqCustom ? '<button class="btn-ghost" data-act="eq-song-clear">Remove this song’s EQ</button>' : '<button class="btn-ghost" data-act="eq-song-save">Save current curve for this song</button>'}
      </div></div>` : '<p class="hint">Play a song to see its personal EQ recommendation.</p>'}
  </div>`;
}

function rerenderEq(root) {
  const ed = $('.eq-editor', root);
  if (!ed) return;
  ed.outerHTML = eqEditorHTML();
  bindEq(root);
}

function bindEq(root) {
  const ed = $('.eq-editor', root);
  if (!ed) return;
  ed.addEventListener('click', e => {
    const m = e.target.closest('[data-eq-mode]');
    const p = e.target.closest('[data-eq-preset]');
    if (m) {
      CFG.eqMode = m.dataset.eqMode;
      if (CFG.eqMode === 'custom' && CFG.eqCustom.every(v => v === 0)) CFG.eqCustom = eqFor(cur()).slice();
    } else if (p) {
      CFG.eqMode = 'preset';
      CFG.eqPreset = p.dataset.eqPreset;
    } else return;
    saveCfg();
    applyAudio();
    rerenderEq(root);
    updatePlayerUI();
  });
  const svg = $('.eq-svg.editable', ed);
  let band = null;
  const toGain = clientY => {
    const r = svg.getBoundingClientRect();
    const y = ((clientY - r.top) / r.height) * (EQ_H + 22);
    return clamp(Math.round(((EQ_H / 2 - y) / (EQ_H / 2 - EQ_PAD)) * EQ_MAX * 2) / 2, -EQ_MAX, EQ_MAX);
  };
  svg.addEventListener('pointerdown', e => {
    const c = e.target.closest('circle[data-band]');
    if (!c) return;
    e.preventDefault();
    band = +c.dataset.band;
    svg.setPointerCapture(e.pointerId);
    if (CFG.eqMode !== 'custom') {
      CFG.eqCustom = eqFor(cur()).slice();
      CFG.eqMode = 'custom';
      $$('[data-eq-mode]', ed).forEach(b => b.classList.toggle('on', b.dataset.eqMode === 'custom'));
      $$('[data-eq-preset]', ed).forEach(b => b.classList.remove('on'));
    }
  });
  svg.addEventListener('pointermove', e => {
    if (band == null) return;
    CFG.eqCustom[band] = toGain(e.clientY);
    const g = CFG.eqCustom;
    $$('circle', svg).forEach((c, i) => c.setAttribute('cy', eqY(g[i])));
    $('.eq-line', svg).setAttribute('d', eqPath(g));
    $('.eq-fill', svg).setAttribute('d', `${eqPath(g)} L${eqX(9)},${eqY(0)} L${eqX(0)},${eqY(0)} Z`);
    eng.setEQ(cur()?.eqCustom ? cur().eqCustom : g);
  });
  const end = () => { if (band != null) { band = null; saveCfg(); } };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

function eqSheet() {
  const s = sheet(`<div class="sheet-title">Equalizer</div><div class="pad">${eqEditorHTML()}</div>`, { cls: 'tall' });
  bindEq(s.el);
  s.el.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (a && ['eq-song-use', 'eq-song-save', 'eq-song-clear', 'enable-enhanced'].includes(a.dataset.act)) setTimeout(() => rerenderEq(s.el), 0);
  });
}

// ---------- car mode ----------

let wakeLock = null;
function openCar() {
  if (!cur() || $('#car')) return;
  closeNP();
  const el = document.createElement('div');
  el.id = 'car';
  el.innerHTML = `<div class="car-inner">
    <header><button class="icon-btn" data-act="close-car" aria-label="Exit car mode">${icon('down')}</button><span>Car mode</span><button class="icon-btn" data-act="like-cur" aria-label="Like"></button></header>
    <div class="car-meta"><div id="car-art"></div><div><div class="car-t" id="car-t"></div><div class="car-s" id="car-s"></div></div></div>
    <div class="car-prog"><i id="car-bar"></i></div>
    <div class="car-ctrls">
      <button data-act="prev" aria-label="Previous">${icon('prev')}</button>
      <button class="car-play" data-act="toggle" data-play-icon aria-label="Play or pause"></button>
      <button data-act="next" aria-label="Next">${icon('next')}</button>
    </div>
    <p class="car-hint">Swipe left or right anywhere to change songs</p></div>`;
  document.body.appendChild(el);
  swipeX(el, dir => (dir < 0 ? next() : prev()), $('.car-meta', el));
  updatePlayerUI();
  navigator.wakeLock?.request('screen').then(l => { wakeLock = l; }).catch(() => {});
}
function updateCar() {
  const t = cur();
  if (!t) return closeCar();
  $('#car-t').textContent = t.title;
  $('#car-s').textContent = t.artist || 'Unknown artist';
  const a = $('#car-art');
  if (a.dataset.k !== (t.artKey || '')) { a.dataset.k = t.artKey || ''; a.innerHTML = artHTML(t.artKey); hydrate(a); }
}
function closeCar() {
  $('#car')?.remove();
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('#car') && !wakeLock) navigator.wakeLock?.request('screen').then(l => { wakeLock = l; }).catch(() => {});
});

// ---------- library actions ----------

function parseName(name) {
  let base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  base = base.replace(/^(\d{1,3}\s*[-.)]\s*|0\d\s+)/, '');
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

async function importFiles(fileList) {
  const all = [...fileList];
  const files = all.filter(isAudio);
  const lrcs = all.filter(f => isLyricsFile(f) && !isAudio(f));
  if (!files.length && !lrcs.length) { toast('No audio files selected'); return; }
  S.importing = true;
  const existing = new Set([...S.tracks.values()].map(t => `${t.size}|${t.fileName}`));
  const lrcByName = new Map(lrcs.map(f => [baseName(f.name), f]));
  let added = 0, skipped = 0, failed = 0, lyricsAdded = 0;
  const prog = progressToast();
  for (const [n, f] of files.entries()) {
    prog.set(`Adding ${n + 1} of ${files.length}…`, n / files.length);
    if (existing.has(`${f.size}|${f.name}`)) { skipped++; continue; }
    try {
      const tags = await readTags(f);
      const fromName = parseName(f.name);
      const artKey = tags.picture?.data?.length ? await saveArt(new Blob([tags.picture.data], { type: tags.picture.mime })).catch(() => null) : null;
      const mime = MIME[extOf(f.name)] || f.type || 'audio/mpeg';
      const blob = new Blob([await f.arrayBuffer()], { type: mime });
      const t = {
        id: uid(),
        title: tags.title || fromName.title || f.name,
        artist: tags.artist || fromName.artist || '',
        album: tags.album || '',
        albumArtist: tags.albumArtist || '',
        genre: tags.genre || '',
        year: tags.year || '',
        track: tags.track || 0,
        disc: tags.disc || 0,
        duration: tags.duration || 0,
        artKey,
        fileName: f.name,
        mime,
        size: f.size,
        added: Date.now() + n,
        liked: false,
        plays: 0,
      };
      const guess = L.detectFromText(t.title, t.album);
      if (guess) t.lang = { ...guess, src: 'text' };
      await db.put('files', blob, t.id);
      const lrc = lrcByName.get(baseName(f.name));
      const lyricText = lrc ? await lrc.text() : tags.lyrics;
      if (lyricText && parseLyrics(lyricText)) { await db.put('lyrics', lyricText, t.id); t.hasLyrics = true; lyricsAdded++; }
      await db.put('tracks', t);
      S.tracks.set(t.id, t);
      existing.add(`${f.size}|${f.name}`);
      added++;
    } catch (e) {
      console.error('Import failed for', f.name, e);
      failed++;
      if (e?.name === 'QuotaExceededError') { toast('Your phone’s storage for Stash is full'); break; }
    }
  }
  // .lrc files picked on their own: match them to songs already in the library by file name or title.
  if (!files.length) {
    for (const f of lrcs) {
      const b = baseName(f.name);
      const t = [...S.tracks.values()].find(x => baseName(x.fileName) === b || smart.normTitle(x.title) === smart.normTitle(parseName(f.name).title));
      if (t && await saveLyrics(t, await f.text())) lyricsAdded++;
    }
  }
  prog.set('Done', 1);
  await sleep(300);
  prog.done();
  S.importing = false;
  changed();
  refresh();
  const bits = [added && `Added ${plural(added, 'song')}`, lyricsAdded && `${lyricsAdded} with lyrics`, skipped && `${skipped} already in library`, failed && `${failed} failed`].filter(Boolean);
  toast(bits.join(' · ') || 'Nothing added', 3200);
  if (added) {
    navigator.storage?.persist?.().catch(() => {});
    runAnalysis();
    if (CFG.aiLang == null) setTimeout(aiConsent, 1200);
    else runLang();
  }
}

function toggleLike(t) {
  t.liked = !t.liked;
  t.likedAt = Date.now();
  db.put('tracks', t);
  D = null;
  toast(t.liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
  if (t === cur()) updatePlayerUI();
  refresh();
}

function createPlaylist(name, ids = [], source = 'local') {
  const p = { id: uid(), name, source, items: ids.map(trackId => ({ trackId, at: Date.now() })), created: Date.now(), updated: Date.now() };
  S.playlists.set(p.id, p);
  db.put('playlists', p);
  return p;
}

function addToPlaylist(p, ids) {
  const have = new Set(p.items.map(it => it.trackId));
  const fresh = ids.filter(id => !have.has(id));
  p.items.push(...fresh.map(trackId => ({ trackId, at: Date.now() })));
  p.updated = Date.now();
  db.put('playlists', p);
  toast(fresh.length ? `Added to ${p.name}` : `Already in ${p.name}`);
  refresh();
}

function addToPlaylistSheet(ids) {
  const pls = [...S.playlists.values()].filter(isEditable).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const s = sheet(`<div class="sheet-title">Add to playlist</div>
    <button class="row" data-new><div class="art sm">${icon('plus')}</div><div class="meta"><div class="t">New playlist</div></div></button>
    ${pls.map(p => `<button class="row" data-pid="${p.id}">${ctxArt(ctxOf('playlist', p.id), 'sm')}<div class="meta"><div class="t">${esc(p.name)}</div><div class="s"><span class="txt">${plural(p.items.length, 'song')}</span></div></div></button>`).join('')}`);
  s.el.addEventListener('click', e => {
    if (e.target.closest('[data-new]')) {
      s.close();
      promptSheet('Give your playlist a name', `My playlist #${S.playlists.size + 1}`, 'Create', name => {
        const p = createPlaylist(name, ids);
        toast(`Added to ${p.name}`);
        refresh();
      });
      return;
    }
    const b = e.target.closest('[data-pid]');
    if (b) { s.close(); addToPlaylist(S.playlists.get(b.dataset.pid), ids); }
  });
}

function removeFromPlaylist(p, pi) {
  p.items.splice(pi, 1);
  p.updated = Date.now();
  db.put('playlists', p);
  toast(`Removed from ${p.name}`);
  refresh();
}

async function removeTracks(ids, { keepFor = null } = {}) {
  const curId = cur()?.id;
  const arts = new Set();
  const gone = new Set(ids);
  for (const id of ids) {
    const t = S.tracks.get(id);
    if (!t) continue;
    arts.add(t.artKey);
    S.tracks.delete(id);
    await db.del('tracks', id);
    await db.del('files', id);
    await db.del('lyrics', id).catch(() => {});
  }
  for (const p of S.playlists.values()) {
    if (p.source === 'spotify') continue;
    const before = JSON.stringify(p.items);
    p.items = p.items.map(it => (gone.has(it.trackId) && keepFor?.[it.trackId] ? { trackId: keepFor[it.trackId] } : it)).filter(it => !gone.has(it.trackId));
    const seen = new Set();
    p.items = p.items.filter(it => (seen.has(it.trackId) ? false : seen.add(it.trackId)));
    if (JSON.stringify(p.items) !== before) db.put('playlists', p);
  }
  const before = S.queue.slice(0, S.qi).filter(id => !gone.has(id)).length;
  S.queue = S.queue.filter(id => !gone.has(id));
  if (gone.has(curId)) {
    eng.stop();
    S.qi = Math.min(before, S.queue.length - 1);
    if (S.queue.length) loadAt(S.qi, 'paused'); else updatePlayerUI();
  } else {
    S.qi = S.queue.indexOf(curId);
  }
  S.unshuffled = S.unshuffled?.filter(id => !gone.has(id)) || null;
  for (const k of arts) await cleanupArt(k);
  changed();
  saveQueue(true);
}

function deleteTracks(ids, label) {
  confirmSheet(ids.length > 1 ? `Delete ${ids.length} songs?` : 'Delete song?', `${esc(label || 'This song')} will be removed from this device. This can’t be undone.`, 'Delete', async () => {
    await removeTracks(ids);
    toast(ids.length > 1 ? `Deleted ${ids.length} songs` : 'Song deleted');
    refresh();
  });
}

const safeName = s => s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'track';

async function shareFiles(files, title, note) {
  const total = files.reduce((n, f) => n + f.size, 0);
  if (navigator.canShare?.({ files })) {
    const s = sheet(`<div class="sheet-title">${esc(title)}</div>
      <p class="hint" style="text-align:center">${files.length === 1 ? esc(files[0].name) : plural(files.length, 'file')} · ${fmtBytes(total)}<br>${note}</p>
      <button class="btn-primary" data-ok>Save to Files / Share</button>`);
    $('[data-ok]', s.el).onclick = () => { navigator.share({ files }).catch(() => {}); s.close(); };
  } else {
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      await sleep(250);
    }
  }
}

async function exportTracks(tracks) {
  const prog = progressToast();
  try {
    const files = [];
    for (const [i, t] of tracks.entries()) {
      prog.set(`Preparing ${i + 1} of ${tracks.length}…`, i / tracks.length);
      const blob = await db.get('files', t.id);
      if (!blob) continue;
      const ext = extOf(t.fileName) || 'mp3';
      let out = blob;
      if (ext === 'mp3') {
        const lyr = t.hasLyrics ? await db.get('lyrics', t.id) : null;
        out = await withID3(blob, t, t.artKey ? await db.get('art', t.artKey) : null, lyr);
      }
      const name = safeName(`${t.artist ? t.artist + ' - ' : ''}${t.title}`) + '.' + ext;
      files.push(new File([out], name, { type: t.mime || out.type || 'application/octet-stream' }));
    }
    prog.done();
    if (!files.length) return toast('Nothing to export');
    shareFiles(files, 'Ready to save', 'Choose <b>Save to Files</b> to keep a copy in the Files app, or send it with any app. MP3s include the song info, cover and lyrics.');
  } catch (e) {
    console.error(e);
    prog.done();
    toast('Couldn’t export');
  }
}

function songMenu(tid, pi, fromNP = false) {
  const t = S.tracks.get(tid);
  if (!t) return;
  const top = topOf();
  const pl = top.v === 'playlist' && pi != null ? S.playlists.get(top.id) : null;
  menu(trackHead(t), [
    { icon: t.liked ? 'heart-fill' : 'heart', on: t.liked, label: t.liked ? 'Remove from Liked Songs' : 'Add to Liked Songs', run: () => toggleLike(t) },
    { icon: 'playlist-add', label: 'Add to playlist', run: () => addToPlaylistSheet([t.id]) },
    pl && pl.source !== 'spotify' && { icon: 'close', label: 'Remove from this playlist', run: () => removeFromPlaylist(pl, pi) },
    { icon: 'radio', label: 'Go to song radio', run: () => navigate('radio', t.id) },
    !fromNP && { icon: 'playnext', label: 'Play next', run: () => playNext([t.id]) },
    !fromNP && { icon: 'addqueue', label: 'Add to queue', run: () => addToQueue([t.id]) },
    fromNP && { icon: 'car', label: 'Car mode', run: openCar },
    fromNP && { icon: 'mic', label: CFG.karaoke ? 'Turn karaoke off' : 'Karaoke mode', on: CFG.karaoke, badge: CFG.enhanced ? '' : 'Enhanced audio', run: () => { if (!CFG.enhanced) setCfg('enhanced', true); setCfg('karaoke', !CFG.karaoke); toast(CFG.karaoke ? 'Karaoke on: vocals reduced' : 'Karaoke off'); } },
    { icon: 'note', label: t.memory?.text ? 'Edit memory' : 'Add a memory', run: () => memorySheet(t) },
    { icon: 'lyrics', label: t.hasLyrics ? 'Replace lyrics' : 'Add lyrics (.lrc or text)', run: () => pickLyrics(t) },
    t.hasLyrics && { icon: 'close', label: 'Remove lyrics', run: async () => { await db.del('lyrics', t.id); t.hasLyrics = false; await db.put('tracks', t); if (t === cur()) loadLyrics(t); toast('Lyrics removed'); } },
    top.v !== 'album' && { icon: 'album', label: 'Go to album', run: () => navigate('album', albumKey(t)) },
    ...artistsOf(t).slice(0, 3).filter(a => !(top.v === 'artist' && top.id === a)).map(a => ({ icon: 'user', label: `Go to ${a}`, run: () => navigate('artist', a) })),
    { icon: 'eq', label: 'Equalizer for this song', run: () => { if (t !== cur()) { toast('Play the song to tune its EQ'); return; } eqSheet(); } },
    { icon: 'edit', label: 'Edit song info', run: () => editSheet([t]) },
    { icon: 'share', label: 'Save to Files / Share', run: () => exportTracks([t]) },
    { icon: 'trash', label: 'Delete from library', danger: true, run: () => deleteTracks([t.id], `“${t.title}”`) },
  ]);
}

function memorySheet(t) {
  const s = promptSheet(t.memory?.text ? 'Edit memory' : 'Add a memory', t.memory?.text || '', 'Save', text => {
    t.memory = text ? { text, at: Date.now() } : null;
    db.put('tracks', t);
    D = null;
    toast(text ? 'Memory saved' : 'Memory removed');
    if (t === cur()) updatePlayerUI();
    refresh();
  }, { multiline: true, placeholder: 'e.g. Our wedding song · Summer 2024 road trip' });
  if (t.memory?.text) {
    const b = document.createElement('button');
    b.className = 'sheet-item center danger';
    b.textContent = 'Delete memory';
    b.onclick = () => { s.close(); t.memory = null; db.put('tracks', t); D = null; toast('Memory removed'); if (t === cur()) updatePlayerUI(); refresh(); };
    $('.sheet', s.el).appendChild(b);
  }
}

function ctxMenu() {
  const top = topOf();
  const c = ctxOf(top.v, top.id);
  if (!c) return;
  const ids = c.tracks.map(t => t.id);
  const p = c.playlist;
  const has = ids.length > 0;
  menu(ctxHead(c), [
    has && { icon: 'playnext', label: 'Play next', run: () => playNext(ids) },
    has && { icon: 'addqueue', label: 'Add to queue', run: () => addToQueue(ids) },
    has && top.v !== 'playlist' && { icon: 'playlist-add', label: 'Add all to playlist', run: () => addToPlaylistSheet(ids) },
    (c.gen || c.radio) && has && { icon: 'plus', label: 'Save as a playlist', run: () => { const np = createPlaylist(c.title, ids); toast(`Saved “${np.name}”`); } },
    c.radio && { icon: 'sync', label: 'Refresh radio', run: () => { S.radio = null; refresh(); } },
    top.v === 'album' && { icon: 'user', label: 'Go to artist', run: () => navigate('artist', c.album.artist) },
    top.v === 'album' && { icon: 'edit', label: 'Edit album info', run: () => editSheet(c.tracks) },
    p && p.source === 'spotify' && { icon: 'sync', label: 'Update from Spotify', run: () => resyncSpotify(p) },
    isEditable(p) && { icon: 'plus', label: 'Add songs', run: () => songPicker(p) },
    isEditable(p) && p.items.length > 1 && { icon: 'queue', label: 'Edit order', run: () => startReorder() },
    p?.source === 'smart' && { icon: 'sparkle', label: 'Edit rules', run: () => smartBuilder(p) },
    p?.source === 'smart' && has && { icon: 'playlist-add', label: 'Save a copy as a regular playlist', run: () => { const np = createPlaylist(`${p.name} (copy)`, ids); toast(`Saved “${np.name}”`); } },
    p && { icon: 'folder', label: p.folderId ? 'Move to another folder' : 'Move to folder', run: () => moveToFolderSheet(p) },
    p && { icon: 'image', label: 'Change cover', run: () => pickCover(p) },
    p?.customArt && { icon: 'close', label: 'Use automatic cover', run: () => removeCover(p) },
    p && { icon: 'edit', label: 'Rename playlist', run: () => promptSheet('Rename playlist', p.name, 'Save', name => { p.name = name; p.updated = Date.now(); db.put('playlists', p); refresh(); }) },
    has && (p || top.v === 'album') && { icon: 'backup', label: 'Share with family (songs included)', run: () => exportBackup({ tracks: c.tracks, playlists: p ? [p] : [], name: c.title }) },
    has && { icon: 'share', label: 'Save all to Files / Share', run: () => exportTracks(c.tracks) },
    p && { icon: 'trash', label: 'Delete playlist', danger: true, run: () => confirmSheet('Delete playlist?', `“${esc(p.name)}” will be deleted. The songs stay in your library.`, 'Delete', async () => {
      S.playlists.delete(p.id);
      await db.del('playlists', p.id);
      await cleanupArt(p.artKey);
      S.recent = S.recent.filter(r => !(r.v === 'playlist' && r.id === p.id));
      ls.set('recent', S.recent);
      toast('Playlist deleted');
      back();
    }) },
    top.v === 'album' && { icon: 'trash', label: 'Delete album from library', danger: true, run: () => deleteTracks(ids, `“${c.title}”`) },
  ]);
}

function addMenu() {
  menu('<div class="sheet-title">Add to your library</div>', [
    { icon: 'import', label: 'Add music files', run: pickFiles },
    { icon: 'playlist-add', label: 'Create playlist', run: newPlaylist },
    { icon: 'sparkle', label: 'Create smart playlist', run: () => smartBuilder() },
    { icon: 'folder', label: 'Create folder', run: () => createFolder() },
    { icon: 'backup', label: 'Import a backup or shared playlist', run: pickBackup },
  ]);
}

const pickFiles = () => $('#file-input').click();
const pickBackup = () => $('#backup-input').click();

function newPlaylist() {
  promptSheet('Give your playlist a name', `My playlist #${S.playlists.size + 1}`, 'Create', name => {
    const p = createPlaylist(name);
    navigate('playlist', p.id);
    if (S.tracks.size) setTimeout(() => songPicker(p), 350); // straight into choosing songs
  });
}

// ---------- song picker (add songs to a playlist) ----------

/** Songs that fit a playlist: similar to what's already in it, or your favourites when it's empty. */
function recommendFor(p, n = 12) {
  const d = derived();
  const have = new Set(p.items.map(it => it.trackId));
  const seeds = p.items.map(it => S.tracks.get(it.trackId)).filter(Boolean).slice(-20);
  const pool = d.all.filter(t => !have.has(t.id));
  if (!seeds.length) {
    return pool.slice().sort((a, b) => (b.liked ? 1 : 0) - (a.liked ? 1 : 0) || (b.plays || 0) - (a.plays || 0) || (b.added || 0) - (a.added || 0)).slice(0, n);
  }
  const seedArtists = seeds.map(artistsOf);
  return pool
    .map(t => {
      const ta = artistsOf(t);
      const ft = d.feats.get(t.id);
      const s = seeds.reduce((sum, sd, i) => sum + smart.similarity(sd, t, d.feats.get(sd.id), ft, seedArtists[i], ta), 0) / seeds.length;
      return [t, s + (t.liked ? 0.4 : 0)];
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(x => x[0]);
}

function songPicker(p) {
  const MAX_ROWS = 300;
  let added = 0;
  let query = '';
  const s = sheet(`<div class="picker-head">
      <div class="sheet-title">Add to “${esc(p.name)}”</div>
      <label class="search-box">${icon('search')}<input id="pick-q" type="search" enterkeyhint="search" placeholder="Search your songs" autocomplete="off" autocorrect="off" spellcheck="false"></label>
    </div>
    <div id="pick-list"></div>
    <div class="picker-foot"><button class="btn-primary" data-done>Done</button></div>`, { cls: 'tall picker' });
  const list = $('#pick-list', s.el);
  const inList = id => p.items.some(it => it.trackId === id);
  const row = t => {
    const on = inList(t.id);
    return `<div class="row pick${on ? ' on' : ''}" data-pick="${t.id}">${artHTML(t.artKey, 'sm')}<div class="meta"><div class="t">${esc(t.title)}</div><div class="s"><span class="txt">${esc([t.artist || 'Unknown artist', t.album].filter(Boolean).join(' · '))}</span></div></div><span class="pick-btn" aria-label="${on ? 'Added' : 'Add'}">${icon(on ? 'check' : 'plus')}</span></div>`;
  };
  const draw = () => {
    const q = fold(query.trim());
    let html = '';
    if (!q) {
      const recs = recommendFor(p);
      if (recs.length) html += `<h2 class="sec-h">${p.items.length ? 'Recommended for this playlist' : 'Suggestions'}</h2><p class="shelf-sub">${p.items.length ? 'Based on the songs you’ve added' : 'Your favourites and newest songs'}</p>${recs.map(row).join('')}`;
    }
    const all = derived().all.filter(t => !q || [t.title, t.artist, t.album, t.albumArtist].some(x => fold(x).includes(q)));
    html += `<h2 class="sec-h">${q ? `Results (${all.length})` : `All songs (${all.length})`}</h2>`;
    html += all.slice(0, MAX_ROWS).map(row).join('') || '<p class="hint">No songs match your search.</p>';
    if (all.length > MAX_ROWS) html += `<p class="hint">Showing the first ${MAX_ROWS}. Search to find the rest.</p>`;
    list.innerHTML = html;
    hydrate(list);
  };
  const updateTitle = () => {
    $('.sheet-title', s.el).textContent = added ? `${plural(added, 'song')} added to “${p.name}”` : `Add to “${p.name}”`;
  };
  list.addEventListener('click', e => {
    const r = e.target.closest('[data-pick]');
    if (!r) return;
    const id = r.dataset.pick;
    const on = inList(id);
    if (on) { p.items = p.items.filter(it => it.trackId !== id); added--; }
    else { p.items.push({ trackId: id, at: Date.now() }); added++; }
    p.updated = Date.now();
    db.put('playlists', p);
    // Same song can be listed twice (Recommended + All): update every copy.
    for (const el of $$(`[data-pick="${id}"]`, list)) {
      el.classList.toggle('on', !on);
      $('.pick-btn', el).innerHTML = icon(on ? 'plus' : 'check');
    }
    updateTitle();
  });
  const inp = $('#pick-q', s.el);
  let timer;
  inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = inp.value; draw(); }, 150); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
  $('[data-done]', s.el).onclick = () => {
    s.close();
    if (added) toast(`${plural(added, 'song')} added to ${p.name}`);
  };
  // Refresh the playlist page whenever the picker closes (Done, swipe down or tap outside).
  new MutationObserver((_, obs) => { if (!s.el.isConnected) { obs.disconnect(); refresh(); } }).observe($('#sheets'), { childList: true });
  draw();
}

// ---------- smart playlist builder ----------

function ruleValueHTML(r) {
  const F = SMART_FIELDS[r.f];
  const sel = (opts, v) => `<select class="input" data-rv>${opts.map(([k, l]) => `<option value="${esc(k)}"${String(v) === String(k) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  switch (F.type) {
    case 'family': return sel(smart.FAMILIES.map(f => [f.id, f.name]), r.v);
    case 'mood': return sel(smart.MOODS.map(m => [m.id, m.name]), r.v);
    case 'lang': return sel([...new Set([...derived().langs.keys(), ...L.COMMON_LANGS])].map(c => [c, L.langName(c)]), r.v);
    case 'yesno': return sel([['yes', 'Yes'], ['no', 'No']], r.v);
    case 'energy': return sel([['low', 'Low (calm)'], ['mid', 'Medium'], ['high', 'High (intense)']], r.v);
    case 'number': return `<input class="input" data-rv inputmode="decimal" value="${esc(r.v ?? '')}" placeholder="Number">`;
    default: return `<input class="input" data-rv value="${esc(r.v ?? '')}" placeholder="Text" autocomplete="off">`;
  }
}

const ruleDefaults = f => {
  const F = SMART_FIELDS[f];
  const v = { family: smart.FAMILIES[0].id, mood: smart.MOODS[0].id, lang: [...derived().langs.keys()][0] || 'en', yesno: 'yes', energy: 'high', number: '', text: '' }[F.type];
  return { f, op: Object.keys(F.ops)[0], v };
};

function smartBuilder(existing = null) {
  const rules = existing ? JSON.parse(JSON.stringify(existing.rules)) : { match: 'all', conds: [{ f: 'plays', op: 'gte', v: '5' }], sort: 'plays', limit: 0, seed: Date.now() % 100000 };
  const ruleRow = (r, i) => `<div class="rule" data-ri="${i}">
    <select class="input" data-rf>${Object.entries(SMART_FIELDS).map(([k, F]) => `<option value="${k}"${r.f === k ? ' selected' : ''}>${esc(F.label)}</option>`).join('')}</select>
    <div class="rule-2"><select class="input" data-ro>${Object.entries(SMART_FIELDS[r.f].ops).map(([k, l]) => `<option value="${k}"${r.op === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${ruleValueHTML(r)}</div>
    <button class="icon-btn" data-rdel aria-label="Remove rule">${icon('close')}</button></div>`;
  const s = sheet(`<div class="sheet-title">${existing ? 'Edit smart playlist' : 'New smart playlist'}</div><div class="pad smart-b">
    <label class="field" style="padding:0 0 10px"><span>Name</span><input class="input" id="sb-name" value="${esc(existing?.name || 'My smart playlist')}" maxlength="80" autocomplete="off"></label>
    <div class="sb-match">Songs that match <select class="input" id="sb-match"><option value="all"${rules.match !== 'any' ? ' selected' : ''}>all</option><option value="any"${rules.match === 'any' ? ' selected' : ''}>any</option></select> of these rules:</div>
    <div id="sb-rules">${rules.conds.map(ruleRow).join('')}</div>
    <button class="btn-ghost" data-radd>${icon('plus')} Add rule</button>
    <div class="sb-opts">
      <label class="field"><span>Order</span><select class="input" id="sb-sort">${Object.entries(SMART_SORTS).map(([k, l]) => `<option value="${k}"${rules.sort === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span>Limit</span><select class="input" id="sb-limit">${[[0, 'No limit'], [10, '10 songs'], [25, '25 songs'], [50, '50 songs'], [100, '100 songs']].map(([k, l]) => `<option value="${k}"${+rules.limit === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="sb-preview" id="sb-preview"></div>
    <button class="btn-primary" style="width:100%;margin:12px 0 4px" data-save>${existing ? 'Save changes' : 'Create smart playlist'}</button>
  </div>`, { cls: 'tall' });
  for (const ic of $$('.btn-ghost .ic', s.el)) ic.style.cssText = 'width:16px;height:16px;vertical-align:-3px';
  const box = $('#sb-rules', s.el);
  const preview = () => {
    const list = evalSmart(rules);
    $('#sb-preview', s.el).innerHTML = `<b>${plural(list.length, 'song')} match</b>${list.length ? `<span>${esc(list.slice(0, 4).map(t => t.title).join(', '))}${list.length > 4 ? '…' : ''}</span>` : ''}`;
  };
  const read = () => {
    rules.match = $('#sb-match', s.el).value;
    rules.sort = $('#sb-sort', s.el).value;
    rules.limit = +$('#sb-limit', s.el).value;
    $$('.rule', box).forEach((row, i) => {
      const r = rules.conds[i];
      r.op = $('[data-ro]', row).value;
      r.v = $('[data-rv]', row).value;
    });
    preview();
  };
  s.el.addEventListener('change', e => {
    const rf = e.target.closest('[data-rf]');
    if (rf) {
      const i = +rf.closest('.rule').dataset.ri;
      rules.conds[i] = ruleDefaults(rf.value);
      box.innerHTML = rules.conds.map(ruleRow).join('');
    }
    read();
  });
  s.el.addEventListener('input', e => { if (e.target.matches('[data-rv]')) read(); });
  s.el.addEventListener('click', e => {
    if (e.target.closest('[data-radd]')) {
      read();
      rules.conds.push(ruleDefaults('lang'));
      box.innerHTML = rules.conds.map(ruleRow).join('');
      preview();
    } else if (e.target.closest('[data-rdel]')) {
      read();
      rules.conds.splice(+e.target.closest('.rule').dataset.ri, 1);
      box.innerHTML = rules.conds.map(ruleRow).join('');
      preview();
    } else if (e.target.closest('[data-save]')) {
      read();
      const name = $('#sb-name', s.el).value.trim() || 'My smart playlist';
      let p = existing;
      if (p) { p.name = name; p.rules = rules; p.updated = Date.now(); db.put('playlists', p); }
      else { p = createPlaylist(name, [], 'smart'); p.rules = rules; db.put('playlists', p); }
      s.close();
      toast(existing ? 'Smart playlist updated' : `Created “${name}”`);
      if (existing) refresh(); else navigate('playlist', p.id);
    }
  });
  preview();
}

// ---------- folders ----------

const saveFolders = () => db.put('kv', S.folders, 'folders');

function createFolder(then) {
  promptSheet('Name your folder', `Folder ${S.folders.length + 1}`, 'Create', name => {
    const fo = { id: uid(), name };
    S.folders.push(fo);
    saveFolders();
    toast(`Created folder “${name}”`);
    then ? then(fo) : refresh();
  });
}

function moveToFolderSheet(p) {
  menu(`<div class="sheet-title">Move “${esc(p.name)}” to…</div>`, [
    { icon: 'plus', label: 'New folder', run: () => createFolder(fo => { p.folderId = fo.id; db.put('playlists', p); refresh(); }) },
    ...S.folders.map(fo => ({ icon: p.folderId === fo.id ? 'check' : 'folder', on: p.folderId === fo.id, label: fo.name, run: () => { p.folderId = fo.id; db.put('playlists', p); toast(`Moved to ${fo.name}`); refresh(); } })),
    p.folderId && { icon: 'close', label: 'Take out of folder', run: () => { delete p.folderId; db.put('playlists', p); toast('Moved out of the folder'); refresh(); } },
  ]);
}

function folderAddSheet(fo) {
  const pls = [...S.playlists.values()].filter(p => p.folderId !== fo.id).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  if (!pls.length) return toast('All your playlists are already in this folder');
  const s = sheet(`<div class="sheet-title">Add to “${esc(fo.name)}”</div>${pls.map(p => `<label class="row pick-pl"><input type="checkbox" value="${p.id}">${ctxArt(ctxOf('playlist', p.id), 'sm')}<div class="meta"><div class="t">${esc(p.name)}</div><div class="s"><span class="txt">${S.folders.find(f => f.id === p.folderId) ? 'In ' + esc(S.folders.find(f => f.id === p.folderId).name) : plural(plCount(p), 'song')}</span></div></div></label>`).join('')}<div class="pad"><button class="btn-primary" style="width:100%;margin:12px 0" data-ok>Add selected</button></div>`, { cls: 'tall' });
  $('[data-ok]', s.el).onclick = () => {
    const ids = $$('input:checked', s.el).map(i => i.value);
    for (const id of ids) { const p = S.playlists.get(id); p.folderId = fo.id; db.put('playlists', p); }
    s.close();
    if (ids.length) toast(`Added ${plural(ids.length, 'playlist')}`);
    refresh();
  };
}

function folderMenu(fo) {
  menu(`<div class="sheet-title">${esc(fo.name)}</div>`, [
    { icon: 'plus', label: 'Add playlists', run: () => folderAddSheet(fo) },
    { icon: 'edit', label: 'Rename folder', run: () => promptSheet('Rename folder', fo.name, 'Save', name => { fo.name = name; saveFolders(); refresh(); }) },
    { icon: 'trash', label: 'Delete folder', danger: true, run: () => confirmSheet('Delete folder?', `The playlists inside “${esc(fo.name)}” are kept and move back to your library.`, 'Delete folder', () => {
      for (const p of S.playlists.values()) if (p.folderId === fo.id) { delete p.folderId; db.put('playlists', p); }
      S.folders = S.folders.filter(f => f !== fo);
      saveFolders();
      toast('Folder deleted');
      back();
    }) },
  ]);
}

// ---------- playlist covers ----------

function pickCover(p) {
  const imgIn = $('#image-input');
  imgIn.onchange = async () => {
    const f = imgIn.files[0];
    imgIn.value = '';
    if (!f) return;
    const old = p.artKey;
    p.artKey = await saveArt(await shrinkImage(f, 1000).catch(() => f));
    p.customArt = true;
    p.updated = Date.now();
    await db.put('playlists', p);
    if (old && old !== p.artKey) await cleanupArt(old);
    toast('Cover updated');
    refresh();
  };
  imgIn.click();
}

async function removeCover(p) {
  const old = p.artKey;
  p.artKey = null;
  p.customArt = false;
  await db.put('playlists', p);
  await cleanupArt(old);
  toast('Back to the automatic cover');
  refresh();
}

// ---------- edit info (with genre & language suggestions) ----------

const EDIT_FIELDS = [
  ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['albumArtist', 'Album artist'],
  ['genre', 'Genre'], ['year', 'Year'], ['track', 'Track number'],
];

const suggestOffline = t => smart.suggestGenresOffline(t, derived().all, derived().feats, artistsOf, albumKey);

function editSheet(tracks) {
  const single = tracks.length === 1;
  const t0 = tracks[0];
  const fields = single ? EDIT_FIELDS : EDIT_FIELDS.filter(([k]) => ['album', 'albumArtist', 'genre', 'year'].includes(k));
  const common = k => {
    const vals = new Set(tracks.map(t => String(t[k] || '')));
    return vals.size === 1 ? [...vals][0] : null;
  };
  const initial = {};
  const inputs = fields.map(([k, label]) => {
    const v = common(k);
    initial[k] = v ?? '';
    const num = k === 'year' || k === 'track';
    let extra = '';
    if (k === 'artist' && single) {
      const parts = smart.splitArtists(t0.artist, acts());
      extra = `<div class="artist-split" id="artist-split">${parts.length > 1 || t0.noSplit ? `<small>Shows up under: ${parts.map(esc).join(' · ')}</small><label class="check"><input type="checkbox" id="nosplit"${t0.noSplit ? ' checked' : ''}> Treat as one artist name</label>` : ''}</div>`;
    }
    if (k === 'genre') extra = '<div class="sugg" id="gsugg"></div>';
    return `<label class="field"><span>${label}</span><input class="input" name="${k}" value="${esc(v === '0' ? '' : v ?? '')}"${v == null ? ' placeholder="Multiple values"' : ''}${num ? ' inputmode="numeric"' : ''} autocomplete="off"></label>${extra}`;
  });
  const langCode = common('lang') == null ? null : t0.lang?.code || '';
  const langOpts = [...new Set([...(langCode ? [langCode] : []), ...L.COMMON_LANGS])].map(c => `<option value="${c}"${c === langCode ? ' selected' : ''}>${esc(L.langName(c))}</option>`).join('');
  const langSrc = single && t0.lang ? { ai: 'detected by listening', text: 'guessed from the text', user: 'set by you' }[t0.lang.src] || '' : '';
  const artKey = common('artKey') || null;
  const s = sheet(`<div class="sheet-title">${single ? 'Edit song info' : 'Edit album info'}</div>
    <div class="edit-art"><div id="edit-art">${artHTML(artKey, 'lg')}</div><button class="btn-ghost" data-pick>${icon('image')} Change cover</button></div>
    ${inputs.join('')}
    <label class="field"><span>Language${langSrc ? ` · <em>${langSrc}</em>` : ''}</span>
      <div class="lang-row"><select class="input" name="lang"><option value=""${!langCode ? ' selected' : ''}>${common('lang') == null && !single ? 'Multiple values' : 'Unknown'}</option>${langOpts}</select>
      ${single ? `<button class="btn-ghost" data-detect>${icon('sparkle')} Listen</button>` : ''}</div></label>
    <button class="btn-primary" data-save>Save</button>
    ${!single ? `<p class="hint">Changes apply to all ${tracks.length} songs on this album.</p>` : ''}`, { cls: 'tall' });
  for (const ic of $$('.btn-ghost .ic', s.el)) ic.style.cssText = 'width:16px;height:16px;vertical-align:-3px';

  // Genre suggestions: from the library immediately, then MusicBrainz when online.
  const gs = $('#gsugg', s.el);
  const genreIn = $('input[name="genre"]', s.el);
  const shown = new Set();
  const addSugg = list => {
    for (const x of list) {
      const k = fold(x.genre);
      if (shown.has(k) || fold(genreIn.value).split(/\s*,\s*/).includes(k)) continue;
      shown.add(k);
      gs.insertAdjacentHTML('beforeend', `<button class="chip sm" data-g="${esc(x.genre)}">${esc(x.genre)}<small>${esc(x.why)}</small></button>`);
    }
    gs.querySelector('.sugg-h') || (gs.children.length && gs.insertAdjacentHTML('afterbegin', `<span class="sugg-h">${icon('sparkle')} Suggested</span>`));
  };
  addSugg(suggestOffline(t0));
  if (navigator.onLine) {
    gs.insertAdjacentHTML('beforeend', '<span class="sugg-load">Looking up online…</span>');
    smart.suggestGenresOnline(t0, artistOf(t0))
      .then(addSugg)
      .catch(() => {})
      .finally(() => { $('.sugg-load', gs)?.remove(); if (!gs.querySelector('[data-g]')) gs.innerHTML = '<span class="sugg-load">No suggestions found</span>'; });
  } else if (!gs.children.length) gs.innerHTML = '<span class="sugg-load">No suggestions yet. Online suggestions need internet.</span>';
  gs.addEventListener('click', e => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    e.preventDefault();
    genreIn.value = b.dataset.g;
    b.remove();
  });

  $('[data-detect]', s.el)?.addEventListener('click', async e => {
    e.preventDefault();
    const btn = e.currentTarget;
    if (CFG.aiLang !== true) { CFG.aiLang = true; saveCfg(); }
    btn.disabled = true;
    btn.textContent = 'Listening…';
    try {
      const r = await detectTrackLanguage(t0);
      const sel = $('select[name="lang"]', s.el);
      if (![...sel.options].some(o => o.value === r.code)) sel.insertAdjacentHTML('beforeend', `<option value="${r.code}">${esc(L.langName(r.code))}</option>`);
      sel.value = r.code;
      toast(r.code === L.INSTRUMENTAL ? 'Sounds instrumental' : `Sounds like ${L.langName(r.code)} (${Math.round(r.conf * 100)}% sure)`);
    } catch (err) {
      toast('Couldn’t run the language AI: ' + err.message, 4000);
    }
    btn.disabled = false;
    btn.innerHTML = `${icon('sparkle')} Listen`;
  });

  let newArt = null;
  const imgIn = $('#image-input');
  $('[data-pick]', s.el).onclick = () => {
    imgIn.onchange = async () => {
      const f = imgIn.files[0];
      imgIn.value = '';
      if (!f) return;
      newArt = await shrinkImage(f, 1000).catch(() => f);
      const u = URL.createObjectURL(newArt);
      $('#edit-art', s.el).innerHTML = `<div class="art lg loaded"><img src="${u}" alt=""></div>`;
    };
    imgIn.click();
  };
  $('[data-save]', s.el).onclick = async () => {
    const changes = {};
    for (const inp of $$('input[name]', s.el)) {
      const k = inp.name;
      const v = inp.value.trim();
      if (v === initial[k]) continue;
      if (!single && v === '' && common(k) == null) continue;
      changes[k] = k === 'track' ? parseInt(v, 10) || 0 : v;
    }
    if (single && changes.title === '') delete changes.title;
    const lang = $('select[name="lang"]', s.el).value;
    if (lang !== (langCode || '') && !(lang === '' && langCode == null)) changes.lang = lang ? { code: lang, src: 'user' } : null;
    const ns = $('#nosplit', s.el);
    if (ns) changes.noSplit = ns.checked || undefined;
    const oldArt = new Set(tracks.map(t => t.artKey));
    if (newArt) changes.artKey = await saveArt(newArt);
    for (const t of tracks) {
      Object.assign(t, changes);
      await db.put('tracks', t);
    }
    if (newArt) for (const k of oldArt) await cleanupArt(k);
    s.close();
    changed();
    const top = topOf();
    if (top.v === 'album') top.id = albumKey(tracks[0]);
    else if (top.v === 'artist' && !derived().artistMap.has(top.id)) top.id = artistOf(tracks[0]);
    if (tracks.includes(cur())) { miniArtKey = npArtKey = undefined; updatePlayerUI(); setMediaSession(cur()); applyAudio(); }
    toast('Saved');
    refresh();
  };
}

// ---------- background jobs: analysis & AI language ----------

const JOBS = { an: { running: false }, lang: { running: false, done: 0 }, model: { state: 'none', pct: 0, err: '' } };

async function runAnalysis() {
  if (JOBS.an.running) return;
  JOBS.an.running = true;
  try {
    for (;;) {
      if (S.importing) { await sleep(1000); continue; }
      const todo = [...S.tracks.values()].filter(t => !t.an && !t.anFailed);
      updateJobStatus();
      if (!todo.length) break;
      const t = todo[0];
      try {
        const blob = await db.get('files', t.id);
        t.an = await analyzeBlob(blob);
        if (t.an.dur && !t.duration) t.duration = t.an.dur;
      } catch (e) {
        console.warn('Analysis failed for', t.title, e);
        t.anFailed = true;
      }
      if (S.tracks.has(t.id)) await db.put('tracks', t);
      if (t === cur()) applyAudio();
      D = null;
      softRefresh();
      await sleep(120);
    }
  } finally {
    JOBS.an.running = false;
    D = null;
    softRefresh(true);
    runLang();
  }
}

function aiConsent() {
  if (CFG.aiLang != null || $('.sheet-wrap')) return;
  confirmSheet('Detect languages by listening?',
    'Stash can listen to each song with an on-device AI to sort your music into language playlists (and spot instrumentals). It downloads a 77 MB model once (best on Wi-Fi); after that it works offline. Your music never leaves the phone.',
    'Download & detect', () => { CFG.aiLang = true; saveCfg(); runLang(); updateJobStatus(); },
    { danger: false, cancel: 'Not now (guess from titles)', onCancel: () => { CFG.aiLang = false; saveCfg(); updateJobStatus(); } });
}

L.onModelProgress(p => {
  if (p.status !== 'progress' || !p.loaded) return;
  modelFiles[p.file] = p.loaded;
  // The model host doesn't always send file sizes, so show megabytes out of the known total (~77 MB).
  JOBS.model.mb = Object.values(modelFiles).reduce((a, x) => a + x, 0) / 1e6;
  updateJobStatus();
});
const modelFiles = {};

async function ensureModel() {
  if (JOBS.model.state === 'ready') return;
  JOBS.model.state = 'loading';
  updateJobStatus();
  try {
    await L.loadModel();
    JOBS.model.state = 'ready';
  } catch (e) {
    JOBS.model.state = 'error';
    JOBS.model.err = e.message;
    throw e;
  } finally { updateJobStatus(); }
}

async function detectTrackLanguage(t) {
  await ensureModel();
  const blob = await db.get('files', t.id);
  return decideLanguage(t, await L.detectFromAudio(blob));
}

/**
 * The tiny on-device model hears music imperfectly (e.g. Persian vs Arabic), so its scores are combined with
 * context: the language of other songs by the same artists, the languages already in the library, and words
 * in the title (including Finglish). Instrumental only when every listened part sounds vocal-free.
 */
function decideLanguage(t, r) {
  // Music scores 0.4–0.6 "no speech" even with vocals, so only call it instrumental when every part is clearly vocal-free.
  if (r.noSpeechMin > 0.8) return { code: L.INSTRUMENTAL, conf: r.noSpeechMin, alt: [] };
  // Mostly vocal-free and no language stands out: also instrumental.
  if (r.noSpeech > 0.75 && r.conf < 0.45) return { code: L.INSTRUMENTAL, conf: r.noSpeech, alt: [r.code] };
  const known = [...S.tracks.values()].filter(x => x !== t && x.lang && x.lang.code !== L.INSTRUMENTAL
    && (x.lang.src === 'user' || (x.lang.src === 'ai' && x.lang.conf >= 0.5)));
  const lib = new Map();
  const byArtist = new Map();
  const mine = new Set(artistsOf(t));
  for (const x of known) {
    lib.set(x.lang.code, (lib.get(x.lang.code) || 0) + 1);
    if (artistsOf(x).some(a => mine.has(a))) byArtist.set(x.lang.code, (byArtist.get(x.lang.code) || 0) + (x.lang.src === 'user' ? 2 : 1));
  }
  const text = L.detectFromText(t.title, t.album);
  const scored = r.top.map(({ code, p }) => {
    let s = p;
    s *= 1 + 1.5 * ((lib.get(code) || 0) / Math.max(1, known.length));
    s *= 1 + Math.min(3, byArtist.get(code) || 0) * 0.8;
    if (text && text.conf >= 0.3 && text.code === code) s *= 1 + 3 * text.conf;
    return { code, s };
  }).sort((a, b) => b.s - a.s);
  const sum = scored.reduce((n, x) => n + x.s, 0) || 1;
  return { code: scored[0].code, conf: scored[0].s / sum, alt: scored.slice(1, 3).map(x => x.code) };
}

/** After a detection pass: unsure songs follow the language their artists confidently sing in. */
function languageConsensus() {
  const votes = new Map();
  for (const t of S.tracks.values()) {
    if (!t.lang || t.lang.code === L.INSTRUMENTAL) continue;
    const w = t.lang.src === 'user' ? 3 : t.lang.src === 'ai' && t.lang.conf >= 0.5 ? 1 : 0;
    if (!w) continue;
    for (const a of artistsOf(t)) {
      if (!votes.has(a)) votes.set(a, new Map());
      votes.get(a).set(t.lang.code, (votes.get(a).get(t.lang.code) || 0) + w);
    }
  }
  let changedAny = false;
  for (const t of S.tracks.values()) {
    if (!t.lang || t.lang.src === 'user' || t.lang.code === L.INSTRUMENTAL) continue;
    if (t.lang.src === 'ai' && t.lang.conf >= 0.5) continue;
    const tally = new Map();
    for (const a of artistsOf(t)) for (const [c, n] of votes.get(a) || []) tally.set(c, (tally.get(c) || 0) + n);
    const best = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2 && best[0] !== t.lang.code) {
      t.lang = { code: best[0], conf: 0.5, src: 'ai', via: 'artist', alt: [t.lang.code] };
      db.put('tracks', t);
      changedAny = true;
    }
  }
  if (changedAny) D = null;
}

async function runLang() {
  if (CFG.aiLang !== true || JOBS.lang.running) return;
  JOBS.lang.running = true;
  try {
    await ensureModel();
    for (;;) {
      if (CFG.aiLang !== true) break;
      if (S.importing || JOBS.an.running) { await sleep(1500); continue; }
      const todo = [...S.tracks.values()].filter(t => (!t.lang || t.lang.src === 'text') && !t.langFailed);
      updateJobStatus();
      if (!todo.length) break;
      const t = todo[0];
      try {
        const r = await detectTrackLanguage(t);
        t.lang = { code: r.code, conf: Math.round(r.conf * 100) / 100, src: 'ai', alt: r.alt };
      } catch (e) {
        console.warn('Language detection failed for', t.title, e);
        t.langFailed = true;
      }
      if (S.tracks.has(t.id)) await db.put('tracks', t);
      D = null;
      softRefresh();
      await sleep(200);
    }
  } catch (e) {
    console.warn('Language AI unavailable', e);
  } finally {
    languageConsensus();
    JOBS.lang.running = false;
    D = null;
    softRefresh(true);
  }
}

function updateJobStatus() {
  const all = [...S.tracks.values()];
  const an = $('#job-an');
  if (an) {
    const done = all.filter(t => t.an).length;
    const failed = all.filter(t => t.anFailed).length;
    an.textContent = !all.length ? 'Add songs to analyze them'
      : done + failed >= all.length ? `All ${all.length} songs analyzed${failed ? ` (${failed} couldn’t be read)` : ''} · powers moods, leveling, smart EQ and transitions`
        : `Analyzing… ${done} of ${all.length} songs`;
  }
  const lg = $('#job-lang');
  if (lg) {
    const ai = all.filter(t => t.lang?.src === 'ai' || t.lang?.src === 'user').length;
    const m = JOBS.model;
    lg.textContent = CFG.aiLang !== true ? 'Off: languages are guessed from song titles'
      : m.state === 'loading' ? (m.mb ? `Downloading the AI model… ${Math.min(77, Math.round(m.mb))} of ~77 MB` : 'Starting the AI model…')
        : m.state === 'error' ? `Couldn’t load the model (${m.err}). It needs internet the first time.`
          : ai >= all.length ? `On · all ${all.length} songs checked by listening`
            : `On · listened to ${ai} of ${all.length} songs`;
  }
}

// ---------- duplicates & cleanup actions ----------

async function mergeDuplicates(group) {
  const [keep, ...rest] = group;
  const keepFor = {};
  for (const t of rest) {
    keepFor[t.id] = keep.id;
    keep.plays = (keep.plays || 0) + (t.plays || 0);
    keep.liked ||= t.liked;
    keep.lastPlayed = Math.max(keep.lastPlayed || 0, t.lastPlayed || 0) || undefined;
    if (!keep.memory && t.memory) keep.memory = t.memory;
    if (!keep.hasLyrics && t.hasLyrics) {
      const text = await db.get('lyrics', t.id);
      if (text) { await db.put('lyrics', text, keep.id); keep.hasLyrics = true; }
    }
    for (const h of S.history) if (h.trackId === t.id) h.trackId = keep.id;
  }
  await db.put('tracks', keep);
  await removeTracks(rest.map(t => t.id), { keepFor });
}

// ---------- backup & family sharing ----------

const TRACK_FIELDS = ['id', 'title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'track', 'disc', 'duration', 'artKey', 'fileName', 'mime', 'size', 'added', 'lang', 'an', 'noSplit', 'hasLyrics'];
const PERSONAL_FIELDS = ['liked', 'likedAt', 'plays', 'lastPlayed', 'memory', 'eqCustom'];

function backupMenu() {
  menu('<div class="sheet-title">Backup & share</div>', [
    { icon: 'backup', label: 'Back up my whole library', run: () => exportBackup({ tracks: derived().all, playlists: [...S.playlists.values()], full: true, name: 'Library' }) },
    { icon: 'import', label: 'Import a backup or shared playlist', run: pickBackup },
  ]);
}

async function exportBackup({ tracks, playlists, full = false, name }) {
  const prog = progressToast();
  try {
    const meta = {
      app: 'stash', version: 1, type: full ? 'library' : 'share', created: Date.now(), name,
      tracks: tracks.map(t => Object.fromEntries([...TRACK_FIELDS, ...(full ? PERSONAL_FIELDS : [])].filter(k => t[k] !== undefined).map(k => [k, t[k]]))),
      playlists: playlists.map(p => ({ ...p, items: p.items.filter(it => it.sp || tracks.some(t => t.id === it.trackId)) })),
      history: full ? S.history.map(({ trackId, at, s }) => ({ trackId, at, s })) : undefined,
      folders: full ? S.folders : undefined,
    };
    const entries = [{ name: 'stash.json', data: JSON.stringify(meta) }];
    const arts = new Set();
    for (const t of tracks) {
      const f = await db.get('files', t.id);
      if (f) entries.push({ name: `files/${t.id}.${extOf(t.fileName) || 'mp3'}`, data: f });
      if (t.artKey) arts.add(t.artKey);
      if (t.hasLyrics) { const l = await db.get('lyrics', t.id); if (l) entries.push({ name: `lyrics/${t.id}.lrc`, data: l }); }
    }
    for (const p of playlists) if (p.artKey) arts.add(p.artKey);
    for (const k of arts) { const a = await db.get('art', k); if (a) entries.push({ name: `art/${k}`, data: a }); }
    const zip = await writeZip(entries, (d, n) => prog.set(`Packing ${d} of ${n}…`, d / n));
    prog.done();
    const fname = safeName(`Stash ${full ? 'backup' : name} ${today()}`) + '.zip';
    shareFiles([new File([zip], fname, { type: 'application/zip' })], full ? 'Backup ready' : 'Ready to share',
      full ? 'Save it to Files or iCloud Drive. To restore, choose “Import a backup” in Your Library › +.'
        : 'AirDrop or send it to a family member. They open Stash › Your Library › + › “Import a backup or shared playlist”.');
  } catch (e) {
    console.error(e);
    prog.done();
    toast(e.message || 'Couldn’t create the backup', 4000);
  }
}

async function importBackup(file) {
  let zip, meta;
  try {
    zip = await readZip(file);
    meta = JSON.parse(await (await zip.get('stash.json').blob()).text());
    if (meta.app !== 'stash') throw new Error();
  } catch {
    toast('That isn’t a Stash backup file');
    return;
  }
  const go = async personal => {
    const prog = progressToast();
    S.importing = true;
    const idMap = {};
    const bySig = new Map([...S.tracks.values()].map(t => [`${t.size}|${t.fileName}`, t]));
    let added = 0;
    try {
      for (const [i, m] of meta.tracks.entries()) {
        prog.set(`Importing ${i + 1} of ${meta.tracks.length}…`, i / meta.tracks.length);
        const existing = S.tracks.get(m.id) || bySig.get(`${m.size}|${m.fileName}`);
        if (existing) {
          idMap[m.id] = existing.id;
          if (personal) { for (const k of PERSONAL_FIELDS) if (m[k] !== undefined) existing[k] = m[k]; await db.put('tracks', existing); }
          continue;
        }
        const entry = zip.get(`files/${m.id}.${extOf(m.fileName) || 'mp3'}`);
        if (!entry) continue;
        const blob = await entry.blob();
        const t = { ...m, id: S.tracks.has(m.id) ? uid() : m.id, added: Date.now() + i };
        if (!personal) { t.liked = false; t.plays = 0; }
        if (m.artKey && !(await db.get('art', m.artKey))) {
          const a = zip.get(`art/${m.artKey}`);
          if (a) await db.put('art', await a.blob(), m.artKey); else t.artKey = null;
        }
        if (m.hasLyrics) {
          const l = zip.get(`lyrics/${m.id}.lrc`);
          if (l) await db.put('lyrics', await (await l.blob()).text(), t.id); else t.hasLyrics = false;
        }
        await db.put('files', new Blob([blob], { type: m.mime || MIME[extOf(m.fileName)] || 'audio/mpeg' }), t.id);
        await db.put('tracks', t);
        S.tracks.set(t.id, t);
        idMap[m.id] = t.id;
        added++;
      }
      let plAdded = 0;
      for (const p of meta.playlists || []) {
        const exists = S.playlists.get(p.id);
        if (exists && personal) continue;
        const np = { ...p, id: exists ? uid() : p.id, source: personal || p.source === 'spotify' || p.source === 'smart' ? p.source : 'shared', updated: Date.now() };
        if (!personal) delete np.folderId;
        if (!personal && [...S.playlists.values()].some(x => x.name === np.name)) np.name += ' (shared)';
        np.items = p.items.map(it => ({ ...it, trackId: idMap[it.trackId] || null })).filter(it => it.trackId || it.sp);
        if (p.artKey && !(await db.get('art', p.artKey))) { const a = zip.get(`art/${p.artKey}`); if (a) await db.put('art', await a.blob(), p.artKey); else np.artKey = null; }
        S.playlists.set(np.id, np);
        await db.put('playlists', np);
        plAdded++;
      }
      if (personal && meta.folders) {
        for (const fo of meta.folders) if (!S.folders.some(f => f.id === fo.id)) S.folders.push(fo);
        await saveFolders();
      }
      if (personal && meta.history) {
        for (const h of meta.history) {
          const e = { trackId: idMap[h.trackId] || h.trackId, at: h.at, s: h.s };
          S.history.push(e);
          await db.put('history', e);
        }
      }
      prog.done();
      toast(`Imported ${plural(added, 'new song')}${plAdded ? ` and ${plural(plAdded, 'playlist')}` : ''}`, 3500);
    } catch (e) {
      console.error(e);
      prog.done();
      toast(e?.name === 'QuotaExceededError' ? 'Not enough storage for this backup' : 'Import stopped: ' + (e.message || 'error'), 4000);
    }
    S.importing = false;
    changed();
    refresh();
    runAnalysis();
  };
  const n = meta.tracks.length;
  if (meta.type === 'library') {
    confirmSheet('Restore backup?', `${plural(n, 'song')} and ${plural(meta.playlists?.length || 0, 'playlist')}. Restoring also brings back likes, play counts, memories and stats.`, 'Restore everything', () => go(true),
      { danger: false, cancel: 'Only add songs & playlists', onCancel: () => go(false) });
  } else {
    confirmSheet(`Import “${esc(meta.name || 'shared music')}”?`, `${plural(n, 'song')}${meta.playlists?.length ? ' and its playlist' : ''}. Songs you already have won’t be duplicated.`, 'Import', () => go(false), { danger: false });
  }
}

// ---------- Spotify import UI ----------

let spPlaylists = [];

function spError(e) {
  if (e?.status === 403) return 'Spotify refused access. If someone else created the Spotify app, ask them to add your Spotify email under User Management in the developer dashboard. Spotify may also only allow reading playlists you own or collaborate on.';
  if (e?.status === 401) return 'Your Spotify session expired. Disconnect and connect again.';
  if (e instanceof TypeError) return 'Couldn’t reach Spotify. Check your internet connection.';
  return e?.message || 'Something went wrong talking to Spotify.';
}

function spRow(p) {
  const imported = [...S.playlists.values()].some(x => x.spotifyId === p.id);
  const art = p.liked ? likedArt('sm') : p.image ? `<div class="art sm loaded"><img src="${esc(p.image)}" alt="" loading="lazy"></div>` : artHTML(null, 'sm');
  const sub = p.liked ? 'Your saved songs' : [p.total != null && plural(p.total, 'song'), p.owner].filter(Boolean).join(' · ');
  return `<div class="row">${art}<div class="meta"><div class="t">${esc(p.name)}</div><div class="s"><span class="txt">${esc(sub)}</span></div></div><button class="btn-ghost${imported ? ' done' : ''}" data-act="sp-import" data-id="${esc(p.id)}">${imported ? 'Update' : 'Import'}</button></div>`;
}

async function importSpotify(meta) {
  const prog = progressToast();
  prog.set(`Loading “${meta.name}”…`);
  try {
    const items = await sp.playlistTracks(meta.id, n => prog.set(`Loading “${meta.name}”… ${n} songs`));
    let artKey = null;
    if (meta.image) {
      try {
        const r = await fetch(meta.image);
        if (r.ok) artKey = await saveArt(await r.blob());
      } catch {}
    }
    let p = [...S.playlists.values()].find(x => x.spotifyId === meta.id);
    const isNew = !p;
    p ||= { id: uid(), source: 'spotify', spotifyId: meta.id, created: Date.now() };
    const oldArt = p.artKey;
    p.name = meta.id === 'liked' ? 'Liked Songs (Spotify)' : meta.name;
    p.items = items.map(s => ({ sp: s, trackId: null }));
    p.updated = Date.now();
    if (artKey) p.artKey = artKey;
    S.playlists.set(p.id, p);
    rematchAll();
    await db.put('playlists', p);
    if (oldArt && oldArt !== p.artKey) await cleanupArt(oldArt);
    prog.done();
    const matched = p.items.filter(it => it.trackId).length;
    toast(`${isNew ? 'Imported' : 'Updated'} “${p.name}” · ${matched} of ${items.length} songs in your library`, 3600);
    return p;
  } catch (e) {
    prog.done();
    toast(spError(e), 5000);
    return null;
  }
}

async function resyncSpotify(p) {
  if (!sp.isConnected()) { toast('Connect Spotify first'); navigate('spotify'); return; }
  let meta = spPlaylists.find(x => x.id === p.spotifyId);
  if (!meta) meta = { id: p.spotifyId, name: p.name.replace(/ \(Spotify\)$/, ''), image: null };
  await importSpotify(meta);
  refresh();
}

function showCodeScreen(code) {
  const el = document.createElement('div');
  el.className = 'codescreen';
  el.innerHTML = `<h1>Almost there</h1><p>Spotify finished the login in a separate window. Copy this code, go back to Stash on your home screen, and paste it under <b>Settings › Import Spotify playlists</b>.</p>
    <code>${esc(code)}</code><button class="btn-primary" data-copy>Copy code</button><button class="sheet-item center" data-x>Close</button>`;
  document.body.appendChild(el);
  $('[data-copy]', el).onclick = () => navigator.clipboard?.writeText(code).then(() => toast('Code copied'), () => toast('Select the code and copy it'));
  $('[data-x]', el).onclick = () => el.remove();
}

// ---------- events ----------

const ACTIONS = {
  nav: el => navigate(el.dataset.v, el.dataset.id),
  back,
  tab: el => switchTab(el.dataset.tab),
  'lib-filter': el => { S.libFilter = el.dataset.f; ls.set('libFilter', S.libFilter); topOf().scroll = 0; render(); },
  'add-menu': addMenu,
  'add-files': pickFiles,
  'new-playlist': newPlaylist,
  'add-songs': () => { const p = S.playlists.get(topOf().id); if (p) songPicker(p); },
  'sf-sort': el => sortSheet(el.dataset.key, !!el.dataset.pl),
  'sf-filter': el => filterSheet(el.dataset.key),
  'pl-reorder': () => startReorder(),
  'pl-reorder-done': () => { topOf().reorder = false; toast('Order saved'); refresh(); },
  'pl-remove': el => {
    const p = S.playlists.get(topOf().id);
    if (!p) return;
    p.items.splice(+el.dataset.pi, 1);
    p.updated = Date.now();
    db.put('playlists', p);
    refresh();
  },
  'smart-edit': () => { const p = S.playlists.get(topOf().id); if (p) smartBuilder(p); },
  'folder-menu': () => { const fo = S.folders.find(f => f.id === topOf().id); if (fo) folderMenu(fo); },
  'folder-add': () => { const fo = S.folders.find(f => f.id === topOf().id); if (fo) folderAddSheet(fo); },
  'history-menu': () => {
    const ids = recentlyPlayed(300).map(r => r.t.id);
    menu('<div class="sheet-title">Recently played</div>', [
      ids.length && { icon: 'plus', label: 'Save as a playlist', run: () => { const p = createPlaylist(`Recently played ${today()}`, ids.slice(0, 100)); toast(`Saved “${p.name}”`); } },
      { icon: 'trash', label: 'Clear listening history', danger: true, run: () => confirmSheet('Clear listening history?', 'This also resets your stats and “On Repeat”. Play counts on songs are kept.', 'Clear history', async () => {
        for (const k of await db.keys('history')) await db.del('history', k);
        S.history = [];
        toast('History cleared');
        refresh();
      }) },
    ]);
  },
  play: el => {
    const l = lists[+el.dataset.list];
    if (!l) return;
    if (l.ctx?.v === 'radio' && +el.dataset.i === 0) return startRadio(S.tracks.get(l.ctx.id));
    const vis = visibleIds(el);
    if (vis) return startQueue(vis, vis.indexOf(el.dataset.tid), l.ctx);
    startQueue(l.ids, +el.dataset.i, l.ctx);
  },
  'play-list': el => {
    const l = lists[+el.dataset.list];
    if (!l || !l.ids.length) return;
    const mine = S.ctx && cur() && el.dataset.v === S.ctx.v && el.dataset.id === String(S.ctx.id);
    if (mine) return toggle();
    const ids = visibleIds(el) || l.ids;
    if (!ids.length) return;
    startQueue(ids, S.shuffle && l.ctx?.v !== 'radio' ? Math.floor(Math.random() * ids.length) : 0, l.ctx);
  },
  'shuffle-play': el => {
    const l = lists[+el.dataset.list];
    if (!l || !l.ids.length) return;
    S.shuffle = true;
    ls.set('shuffle', true);
    const ids = visibleIds(el) || l.ids;
    if (!ids.length) return;
    startQueue(ids, Math.floor(Math.random() * ids.length), l.ctx);
    for (const b of $$('#view [data-act="shuffle-play"]')) b.classList.add('on');
    updatePlayerUI();
  },
  'song-menu': el => songMenu(el.dataset.tid, el.dataset.pi != null ? +el.dataset.pi : null),
  'ctx-menu': ctxMenu,
  missing: () => toast('Not in your library yet. Add the file and it’ll match automatically.', 3200),
  toggle,
  next: () => next(),
  prev,
  shuffle: () => setShuffle(!S.shuffle),
  repeat: cycleRepeat,
  'like-cur': () => { const t = cur(); if (t) toggleLike(t); },
  'open-np': openNP,
  'close-np': closeNP,
  'np-menu': () => { const t = cur(); if (t) songMenu(t.id, null, true); },
  'np-artist': () => { const t = cur(); if (t) navigate('artist', artistOf(t)); },
  'memory-cur': () => { const t = cur(); if (t) memorySheet(t); },
  'np-lyrics': toggleLyricsView,
  'lyrics-add-cur': () => { const t = cur(); if (t) pickLyrics(t); },
  'eq-sheet': eqSheet,
  'speed-sheet': speedSheet,
  ab: cycleLoop,
  'sleep-sheet': sleepSheet,
  'close-car': closeCar,
  queue: queueSheet,
  'clear-q': () => { S.query = ''; const q = $('#q'); q.value = ''; q.focus(); updateResults(); },
  copy: el => navigator.clipboard?.writeText(el.dataset.text).then(() => toast('Copied'), () => toast('Couldn’t copy. Select the text instead.')),
  'cfg-toggle': el => {
    const k = el.dataset.k;
    setCfg(k, !CFG[k]);
    el.classList.toggle('on', CFG[k]);
    el.setAttribute('aria-checked', CFG[k]);
    if (k === 'enhanced') refresh();
  },
  'cfg-set': el => {
    const k = el.dataset.k;
    const v = k === 'speed' ? +el.dataset.val : el.dataset.val;
    setCfg(k, v);
    $$(`[data-act="cfg-set"][data-k="${k}"]`).forEach(b => b.classList.toggle('on', b === el));
    if (k === 'speed') updatePlayerUI();
  },
  'ai-toggle': el => {
    CFG.aiLang = CFG.aiLang === true ? false : true;
    saveCfg();
    el.classList.toggle('on', CFG.aiLang === true);
    updateJobStatus();
    if (CFG.aiLang) runLang();
  },
  'enable-enhanced': () => { setCfg('enhanced', true); if (topOf().v === 'eq') refresh(); },
  'eq-song-use': () => { const t = cur(); if (!t) return; t.eqCustom = smart.recommendEQ(t).gains; db.put('tracks', t); if (CFG.eqMode === 'off') { CFG.eqMode = 'smart'; saveCfg(); } applyAudio(); toast('Saved as this song’s EQ'); if (topOf().v === 'eq') refresh(); },
  'eq-song-save': () => { const t = cur(); if (!t) return; t.eqCustom = eqFor(t).slice(); db.put('tracks', t); toast('Current curve saved for this song'); if (topOf().v === 'eq') refresh(); },
  'eq-song-clear': () => { const t = cur(); if (!t) return; delete t.eqCustom; db.put('tracks', t); applyAudio(); toast('This song follows the main EQ again'); if (topOf().v === 'eq') refresh(); },
  'stats-period': el => { topOf().period = el.dataset.p; render(); },
  'dups-one': async el => {
    const groups = smart.findDuplicates(derived().all, artistOf);
    const g = groups[+el.dataset.g];
    if (!g) return;
    await mergeDuplicates(g);
    toast(`Kept the best copy of “${g[0].title}”`);
    render();
  },
  'dups-all': () => {
    const groups = smart.findDuplicates(derived().all, artistOf);
    confirmSheet('Clean up all duplicates?', `${plural(groups.reduce((n, g) => n + g.length - 1, 0), 'copy')} will be removed. The best copy of each song is kept.`, 'Clean up', async () => {
      for (const g of groups) await mergeDuplicates(g);
      toast('Duplicates cleaned up');
      render();
    });
  },
  'clean-apply': async () => {
    const top = topOf();
    let n = 0;
    for (const cb of $$('.clean-row input:checked')) {
      const i = +cb.dataset.i;
      if (cb.dataset.k === 'p') { const { t, c } = top.proposals[i]; Object.assign(t, c); await db.put('tracks', t); n++; }
      else { const { t, g } = top.fill[i]; t.genre = g.genre; await db.put('tracks', t); n++; }
    }
    top.proposals = null;
    top.fill = null;
    changed();
    toast(n ? `Fixed ${plural(n, 'song')}` : 'Nothing selected');
    updatePlayerUI();
    render();
  },
  'backup-menu': backupMenu,
  persist: async () => {
    const ok = await navigator.storage?.persist?.().catch(() => false);
    toast(ok ? 'Your library is protected' : 'The browser decides this automatically for home-screen apps', 3200);
    AFTER.settings();
  },
  wipe: () => confirmSheet('Delete everything?', 'All songs, playlists and settings will be removed from this device.', 'Delete everything', async () => {
    eng.stop();
    await db.wipe();
    try { Object.keys(localStorage).filter(k => k.startsWith('stash.')).forEach(k => localStorage.removeItem(k)); } catch {}
    location.reload();
  }),
  'sp-connect': async () => {
    const cid = $('#sp-cid').value.trim();
    if (!/^[0-9a-f]{32}$/i.test(cid)) return toast('That doesn’t look like a Client ID (32 letters and numbers)', 3200);
    sp.setClientId(cid);
    try { await sp.beginLogin(); } catch (e) { toast(spError(e)); }
  },
  'sp-code': async () => {
    let code = $('#sp-code').value.trim();
    try { code = new URL(code).searchParams.get('code') || code; } catch {}
    if (!code) return;
    try {
      await sp.exchange(code);
      toast('Spotify connected');
      render();
    } catch (e) { toast(spError(e), 4000); }
  },
  'sp-disconnect': () => { sp.disconnect(); toast('Disconnected from Spotify'); render(); },
  'sp-import': async el => {
    const id = el.dataset.id;
    const meta = id === 'liked' ? { id: 'liked', name: 'Liked Songs', image: null } : spPlaylists.find(p => p.id === id);
    if (!meta) return;
    el.disabled = true;
    el.textContent = '…';
    const p = await importSpotify(meta);
    el.disabled = false;
    el.textContent = p ? 'Update' : 'Import';
    el.classList.toggle('done', !!p);
    D = null;
  },
};

function bindEvents() {
  document.addEventListener('click', e => {
    eng.prime(); // any tap unlocks audio on iPhone (and builds the enhanced audio graph when enabled)
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el, e); }
  }, true);
  $('#view').addEventListener('input', e => {
    if (e.target.matches('[data-find-in]')) {
      // "Find in…": hide non-matching rows in place (keeps the keyboard open).
      const q = fold(e.target.value.trim());
      const box = e.target.closest('.coll, .lib-songs').querySelector('.tracklist');
      box.dataset.q = q;
      for (const r of box.querySelectorAll('.song[data-find]')) r.hidden = !!q && !r.dataset.find.includes(q);
      return;
    }
    if (e.target.id !== 'q') return;
    S.query = e.target.value;
    updateResults();
  });
  $('#view').addEventListener('keydown', e => { if (e.target.id === 'q' && e.key === 'Enter') e.target.blur(); });
  $('#view').addEventListener('scroll', onScroll, { passive: true });
  $('#np-lyrics').addEventListener('click', e => {
    const p = e.target.closest('p[data-t]');
    if (p) eng.seek(+p.dataset.t);
  });
  $('#file-input').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) importFiles(files);
  });
  $('#backup-input').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importBackup(f);
  });
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    if (e.key === 'Escape') { const sh = [...$$('.sheet-wrap.open')].at(-1); if (sh) sh.querySelector('[data-close]').click(); else if ($('#car')) closeCar(); else closeNP(); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) importBackup(files[0]);
    else importFiles(files);
  });
}

// ---------- boot ----------

async function init() {
  buildChrome();
  setupAudio();
  bindEvents();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  let redirect = null;
  try { redirect = await sp.handleRedirect(); } catch (e) { redirect = { error: e.message }; }

  const [tracks, pls, hist, folders] = await Promise.all([db.all('tracks'), db.all('playlists'), db.all('history').catch(() => []), db.get('kv', 'folders').catch(() => null)]);
  for (const t of tracks) S.tracks.set(t.id, t);
  for (const p of pls) S.playlists.set(p.id, p);
  S.history = hist;
  S.folders = folders || [];
  changed();
  applyAudio();
  restoreQueue();

  if (redirect?.ok) {
    S.stacks.home.push({ v: 'settings' }, { v: 'spotify' });
    toast('Spotify connected');
  } else if (redirect?.needsPaste) {
    showCodeScreen(redirect.code);
  } else if (redirect?.error) {
    S.stacks.home.push({ v: 'settings' }, { v: 'spotify' });
    toast(`Spotify: ${redirect.error}`, 4000);
  }
  render();
  updatePlayerUI();
  setTimeout(() => {
    runAnalysis();
    if (CFG.aiLang === true) runLang();
    else if (CFG.aiLang == null && S.tracks.size) aiConsent();
  }, 1500);
}

init().catch(e => {
  console.error(e);
  $('#view').innerHTML = `<div class="empty"><h2>Stash couldn’t start</h2><p>${esc(e.message)}</p></div>`;
});
