// Library intelligence: artist splitting, genre families, moods, auto playlists, radio, shuffle, daily mixes,
// duplicates, genre suggestions, tag cleanup and per-song EQ recommendations. Pure functions over track objects.
import { INSTRUMENTAL, langName } from './lang.js';

export const fold = s => String(s || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
export const normName = s => fold(s).replace(/[^\p{L}\p{N}]+/gu, '');
export function normTitle(s) {
  const base = fold(s)
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/\s+-\s+.*\b(remaster|remastered|version|edit|live|mix|mono|stereo|radio|acoustic|feat)\b.*$/, '')
    .replace(/\bfeat\.?.*$|\bft\.?\s.*$/, '');
  return base.replace(/[^\p{L}\p{N}]+/gu, '') || normName(s);
}

function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) {
  let a = typeof seed === 'number' ? seed : hashStr(seed);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- artists ----------

// Always split on these. "&", "and", "+" and Persian "و" split too, unless the whole name is a known act
// (it appears as an album artist somewhere) or the song is marked "don't split".
const HARD = /\s*(?:,|;|\s\/\s|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s|\bwith\s|\s[xX×]\s|\bvs\.?\s)\s*/i;
const SOFT = /\s+(?:&|and|\+|و)\s+/i;

export function splitArtists(name, knownActs = null) {
  if (!name) return [];
  const out = [];
  for (const part of name.split(HARD)) {
    const p = part.trim();
    if (!p) continue;
    if (knownActs && knownActs.has(normName(p))) { out.push(p); continue; }
    out.push(...p.split(SOFT).map(x => x.trim()).filter(Boolean));
  }
  return [...new Set(out)];
}

export function trackArtists(t, knownActs) {
  if (t.noSplit) return [t.artist || t.albumArtist || 'Unknown artist'];
  const list = splitArtists(t.artist, knownActs);
  if (t.albumArtist && !t.artist) list.push(...splitArtists(t.albumArtist, knownActs));
  return list.length ? list : ['Unknown artist'];
}
export const primaryArtist = (t, knownActs) => t.albumArtist || trackArtists(t, knownActs)[0];

// ---------- genres ----------

export const FAMILIES = [
  { id: 'hiphop', name: 'Hip-Hop & Rap', color: '#bc5900', kw: ['hip hop', 'hip-hop', 'hiphop', 'rap', 'trap', 'drill', 'grime', 'boom bap'] },
  { id: 'rnb', name: 'R&B & Soul', color: '#8d67ab', kw: ['r&b', 'rnb', 'r and b', 'soul', 'funk', 'motown', 'disco', 'gospel'] },
  { id: 'metal', name: 'Metal', color: '#535353', kw: ['metal', 'metalcore', 'deathcore', 'hardcore', 'thrash'] },
  { id: 'indie', name: 'Indie & Alternative', color: '#477d95', kw: ['indie', 'alternative', 'alt-', 'shoegaze', 'post-punk', 'emo', 'dream pop'] },
  { id: 'rock', name: 'Rock', color: '#e13300', kw: ['rock', 'punk', 'grunge'] },
  { id: 'electronic', name: 'Electronic & Dance', color: '#0d73ec', kw: ['electronic', 'edm', 'house', 'techno', 'trance', 'dubstep', 'drum and bass', 'drum & bass', 'dnb', 'electro', 'dance', 'garage', 'synthwave', 'hardstyle', 'idm', 'breakbeat'] },
  { id: 'chill', name: 'Chill & Ambient', color: '#27856a', kw: ['ambient', 'chill', 'lo-fi', 'lofi', 'downtempo', 'trip-hop', 'trip hop', 'new age', 'meditat', 'sleep', 'relax'] },
  { id: 'jazz', name: 'Jazz & Blues', color: '#1e3264', kw: ['jazz', 'blues', 'swing', 'bossa', 'bebop'] },
  { id: 'classical', name: 'Classical & Score', color: '#7d4b32', kw: ['classical', 'orchestra', 'symphon', 'piano', 'opera', 'baroque', 'soundtrack', 'score', 'instrumental', 'cinematic', 'chamber'] },
  { id: 'latin', name: 'Latin', color: '#e91429', kw: ['latin', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'merengue', 'tango', 'flamenco', 'urbano'] },
  { id: 'country', name: 'Country & Folk', color: '#ba5d07', kw: ['country', 'folk', 'bluegrass', 'americana', 'acoustic', 'singer-songwriter', 'singer songwriter'] },
  { id: 'reggae', name: 'Reggae', color: '#148a08', kw: ['reggae', 'ska', 'dancehall', 'dub'] },
  { id: 'pop', name: 'Pop', color: '#e8115b', kw: ['pop', 'k-pop', 'j-pop', 'synthpop'] },
  { id: 'world', name: 'World & Traditional', color: '#8c1932', kw: ['traditional', 'world', 'persian', 'iranian', 'arabic', 'turkish', 'bollywood', 'indian', 'afro', 'ethnic', 'kurdish', 'maqam', 'sonati'] },
];
export const familyById = Object.fromEntries(FAMILIES.map(f => [f.id, f]));

export const splitGenres = g => String(g || '').split(/[,;/]/).map(x => x.trim()).filter(Boolean);

export function familyOfGenre(g) {
  const s = ' ' + fold(g) + ' ';
  return FAMILIES.find(f => f.kw.some(k => s.includes(k))) || null;
}
export const familiesOf = t => [...new Set(splitGenres(t.genre).map(familyOfGenre).filter(Boolean))];

// ---------- audio features & moods ----------

function ranker(values) {
  const sorted = values.filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  return v => {
    if (!sorted.length || v == null) return 0.5;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
    return sorted.length === 1 ? 0.5 : lo / (sorted.length - 1);
  };
}

/** Energy and brightness (0..1, relative to the library) for every analyzed track. */
export function features(tracks) {
  const an = tracks.filter(t => t.an);
  const rOn = ranker(an.map(t => t.an.onsetRate));
  const rLoud = ranker(an.map(t => t.an.loudness));
  const rCent = ranker(an.map(t => t.an.centroid));
  const out = new Map();
  for (const t of an) {
    const energy = 0.5 * rOn(t.an.onsetRate) + 0.3 * rLoud(t.an.loudness) + 0.2 * rCent(t.an.centroid);
    out.set(t.id, { energy, bright: rCent(t.an.centroid), bpm: t.an.bpm || 0 });
  }
  return out;
}

export const MOODS = [
  { id: 'energetic', name: 'Energy Boost', color: '#e13300', desc: 'Fast, punchy songs to get you moving' },
  { id: 'feelgood', name: 'Feel Good', color: '#ba5d07', desc: 'Bright, upbeat songs' },
  { id: 'chill', name: 'Chill', color: '#27856a', desc: 'Laid-back, low-energy songs' },
  { id: 'focus', name: 'Focus', color: '#1e3264', desc: 'Steady, mostly instrumental music' },
  { id: 'latenight', name: 'Late Night', color: '#503750', desc: 'Dark, mellow songs for after hours' },
];

export function moodsOf(t, f) {
  if (!f) return [];
  const fams = familiesOf(t).map(x => x.id);
  const m = [];
  if (f.energy >= 0.65 && f.bpm >= 105) m.push('energetic');
  if (f.bright >= 0.55 && f.energy >= 0.4 && f.energy <= 0.85 && f.bpm >= 95 && f.bpm <= 135) m.push('feelgood');
  if (f.energy <= 0.4 && f.bpm <= 115) m.push('chill');
  if (f.energy >= 0.15 && f.energy <= 0.6 && (t.lang?.code === INSTRUMENTAL || fams.some(x => ['classical', 'chill', 'jazz', 'electronic'].includes(x)))) m.push('focus');
  if (f.bright <= 0.4 && f.energy <= 0.55) m.push('latenight');
  return m;
}

// ---------- shuffle & radio ----------

/** Weighted shuffle (liked/played songs a little more often) with no same artist twice in a row. */
export function smartShuffle(ids, byId, artistKey) {
  const r = Math.random;
  const keyed = ids.map(id => {
    const t = byId.get(id);
    const w = 1 + (t?.liked ? 0.6 : 0) + Math.min(t?.plays || 0, 20) * 0.03;
    return [id, -Math.log(r() || 1e-9) / w];
  }).sort((a, b) => a[1] - b[1]).map(x => x[0]);
  return spreadArtists(keyed, byId, artistKey);
}

export function spreadArtists(ids, byId, artistKey) {
  const out = ids.slice();
  const art = id => artistKey(byId.get(id));
  for (let i = 1; i < out.length; i++) {
    if (art(out[i]) !== art(out[i - 1])) continue;
    for (let j = i + 1; j < out.length; j++) {
      if (art(out[j]) !== art(out[i - 1])) { [out[i], out[j]] = [out[j], out[i]]; break; }
    }
  }
  return out;
}

/** Similarity score between two tracks for radio and genre suggestions. */
export function similarity(a, b, fa, fb, artistsA, artistsB) {
  let s = 0;
  const famA = familiesOf(a).map(f => f.id), famB = familiesOf(b).map(f => f.id);
  if (famA.some(x => famB.includes(x))) s += 3;
  const ga = splitGenres(a.genre).map(fold), gb = splitGenres(b.genre).map(fold);
  if (ga.some(x => gb.includes(x))) s += 2;
  if (a.lang?.code && a.lang.code === b.lang?.code) s += 2;
  if (artistsA.some(x => artistsB.includes(x))) s += 2.5;
  if (fa && fb) {
    if (fa.bpm && fb.bpm) s += Math.max(0, 1.5 - Math.abs(fa.bpm - fb.bpm) / 12);
    s += Math.max(0, 1.5 - Math.abs(fa.energy - fb.energy) * 5);
    s += Math.max(0, 0.8 - Math.abs(fa.bright - fb.bright) * 3);
  }
  return s;
}

export function radio(seed, tracks, feats, artistsOf, exclude = new Set(), n = 40) {
  const sa = artistsOf(seed);
  const fs = feats.get(seed.id);
  const scored = tracks
    .filter(t => t.id !== seed.id && !exclude.has(t.id))
    .map(t => [t, similarity(seed, t, fs, feats.get(t.id), sa, artistsOf(t)) + (t.liked ? 0.6 : 0) + Math.random() * 1.2])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(x => x[0].id);
  return scored;
}

// ---------- smart playlists & daily mixes ----------

export const SMART = [
  { id: 'most', name: 'Most Played', color: '#e8115b', desc: 'Your all-time favourites' },
  { id: 'repeat', name: 'On Repeat', color: '#0d73ec', desc: 'What you’ve played most in the last 14 days' },
  { id: 'recent', name: 'Recently Added', color: '#148a08', desc: 'Your newest songs' },
  { id: 'forgotten', name: 'Forgotten Favourites', color: '#8d67ab', desc: 'Liked songs you haven’t played in a month' },
  { id: 'memories', name: 'Songs With Memories', color: '#ba5d07', desc: 'Songs you’ve written a note on' },
];

const DAY = 864e5;
export function smartList(id, tracks, recentPlays) {
  const now = Date.now();
  switch (id) {
    case 'most': return tracks.filter(t => t.plays > 0).sort((a, b) => b.plays - a.plays).slice(0, 50);
    case 'repeat': return tracks.filter(t => recentPlays.get(t.id) >= 2).sort((a, b) => recentPlays.get(b.id) - recentPlays.get(a.id)).slice(0, 30);
    case 'recent': return tracks.filter(t => now - (t.added || 0) < 30 * DAY).sort((a, b) => b.added - a.added).slice(0, 50);
    case 'forgotten': return tracks.filter(t => t.liked && (!t.lastPlayed || now - t.lastPlayed > 30 * DAY)).sort((a, b) => (a.lastPlayed || 0) - (b.lastPlayed || 0)).slice(0, 50);
    case 'memories': return tracks.filter(t => t.memory?.text).sort((a, b) => (b.memory.at || 0) - (a.memory.at || 0));
  }
  return [];
}

const MIX_COLORS = ['#e13300', '#0d73ec', '#8d67ab', '#148a08', '#bc5900', '#dc148c'];

/** 3–6 mixes for today, grouped by genre family (and language), seeded by the date so they stay stable all day. */
export function dailyMixes(tracks, artistOf, dateKey) {
  const groups = new Map();
  for (const t of tracks) {
    const fam = familiesOf(t)[0]?.id || 'misc';
    const key = fam + '|' + (t.lang?.code && t.lang.code !== INSTRUMENTAL ? t.lang.code : '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  let clusters = [...groups.entries()].filter(([, l]) => l.length >= 5);
  if (clusters.length < 3) {
    const byFam = new Map();
    for (const t of tracks) { const k = familiesOf(t)[0]?.id || 'misc'; if (!byFam.has(k)) byFam.set(k, []); byFam.get(k).push(t); }
    clusters = [...byFam.entries()].filter(([, l]) => l.length >= 5);
  }
  if (!clusters.length && tracks.length >= 8) clusters = [['all', tracks]];
  const weight = t => 1 + Math.min(t.plays || 0, 30) * 0.15 + (t.liked ? 2 : 0);
  clusters.sort((a, b) => b[1].reduce((n, t) => n + weight(t), 0) - a[1].reduce((n, t) => n + weight(t), 0));
  return clusters.slice(0, 6).map(([key, list], i) => {
    const r = rng(dateKey + key);
    const ids = list
      .map(t => [t, -Math.log(r() || 1e-9) / (weight(t) + (t.plays ? 0 : 0.8))])
      .sort((a, b) => a[1] - b[1])
      .slice(0, 40)
      .map(x => x[0]);
    const artists = [];
    for (const t of ids) { const a = artistOf(t); if (!artists.includes(a)) artists.push(a); if (artists.length === 3) break; }
    return { id: String(i + 1), name: `Daily Mix ${i + 1}`, color: MIX_COLORS[i], ids: ids.map(t => t.id), sub: artists.join(', ') + (artists.length >= 3 ? ' and more' : '') };
  });
}

// ---------- duplicates ----------

const FORMAT_RANK = { flac: 4, wav: 4, aiff: 4, aif: 4, m4a: 3, aac: 3, mp4: 3, ogg: 2, opus: 2, mp3: 1 };
export const extOf = name => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
export function qualityOf(t) {
  const kbps = t.duration ? Math.round((t.size * 8) / t.duration / 1000) : 0;
  return { kbps, format: extOf(t.fileName).toUpperCase() || '?', score: (FORMAT_RANK[extOf(t.fileName)] || 1) * 1000 + kbps };
}

export function findDuplicates(tracks, artistOf) {
  const groups = new Map();
  for (const t of tracks) {
    const k = normTitle(t.title) + '|' + normName(artistOf(t));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // split into clusters of similar length (a live version or remix is not a duplicate)
    const used = new Set();
    for (const t of list) {
      if (used.has(t.id)) continue;
      const c = list.filter(o => !used.has(o.id) && (!t.duration || !o.duration || Math.abs(o.duration - t.duration) < 3));
      c.forEach(o => used.add(o.id));
      if (c.length > 1) out.push(c.sort((a, b) => qualityOf(b).score - qualityOf(a).score));
    }
  }
  return out;
}

// ---------- genre suggestions ----------

const titleCase = s => s.replace(/\b\p{L}/gu, c => c.toUpperCase()).replace(/\bR&b\b/, 'R&B').replace(/\bEdm\b/, 'EDM').replace(/\bHip Hop\b/, 'Hip-Hop');

export function suggestGenresOffline(t, tracks, feats, artistsOf, albumKeyOf) {
  const score = new Map();
  const add = (g, w, why) => {
    const k = fold(g);
    const e = score.get(k) || { genre: g, w: 0, why: new Set() };
    e.w += w;
    e.why.add(why);
    score.set(k, e);
  };
  const ak = albumKeyOf(t);
  const myArtists = artistsOf(t);
  const ft = feats.get(t.id);
  const near = [];
  for (const o of tracks) {
    if (o.id === t.id || !o.genre) continue;
    const gs = splitGenres(o.genre);
    if (albumKeyOf(o) === ak) gs.forEach(g => add(g, 3, 'Same album'));
    else if (artistsOf(o).some(a => myArtists.includes(a))) gs.forEach(g => add(g, 2, 'Same artist'));
    const fo = feats.get(o.id);
    // Only songs in the same language count as "similar" (a Persian rap song isn't like an English synth track).
    if (t.lang?.code && o.lang?.code && t.lang.code !== o.lang.code) continue;
    if (ft && fo) {
      const s = similarity(t, o, ft, fo, myArtists, artistsOf(o));
      if (s >= 3) near.push([o, s]);
    }
  }
  near.sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([o, s]) => splitGenres(o.genre).forEach(g => add(g, 0.25 + s * 0.12, 'Sounds similar')));

  // Style guesses from the song's language and its energy.
  const lc = t.lang?.code;
  if (lc && lc !== INSTRUMENTAL) {
    const name = langName(lc);
    const energetic = ft ? ft.energy > 0.55 || t.an?.onsetRate > 3.2 : false;
    add(`${name} ${energetic ? 'Hip-Hop' : 'Pop'}`, 0.5, 'From the language & sound');
    add(`${name} ${energetic ? 'Pop' : 'Hip-Hop'}`, 0.4, 'From the language & sound');
    if (ft && ft.energy < 0.35) add(`${name} Traditional`, 0.3, 'From the language & sound');
  }
  if (ft && score.size < 3) {
    if (lc === INSTRUMENTAL && ft.energy < 0.45) add('Instrumental', 0.6, 'From the sound');
    if (ft.energy > 0.7 && ft.bpm > 118) add('Dance', 0.5, 'From the sound');
    if (ft.energy < 0.35) add('Chill', 0.5, 'From the sound');
  }
  return [...score.values()].sort((a, b) => b.w - a.w).slice(0, 5).map(e => ({ genre: e.genre, why: [...e.why][0], source: 'library' }));
}

const NOT_GENRE = /^(\d{2,4}s?|seen live|favorites?|favourites?|male vocalists?|female vocalists?|usa|uk|british|american|english|german|french|spanish|iranian|persian|canadian|swedish|australian|japanese|korean)$|band|group|duo|producer|rapper|singer|composer|label|musician|instrumentalist|artist|romanian|nationality/i;

// MusicBrainz allows about one request per second per user; space every request out, app-wide.
let mbNext = 0;
async function mbSlot() {
  const wait = mbNext - Date.now();
  mbNext = Math.max(Date.now(), mbNext) + 1100;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

/** Asks MusicBrainz (free, public) for genre tags of the recording, falling back to the artist. */
export async function suggestGenresOnline(t, artist) {
  const q = s => `"${String(s).replace(/["\\]/g, ' ')}"`;
  const get = async url => {
    await mbSlot();
    let r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (r.status === 503) { // rate limited: wait once and retry
      await new Promise(res => setTimeout(res, 2500));
      await mbSlot();
      r = await fetch(url, { headers: { Accept: 'application/json' } });
    }
    if (!r.ok) throw new Error('MusicBrainz ' + r.status);
    return r.json();
  };
  const tags = new Map();
  const take = (list, w) => {
    for (const x of list || []) {
      const name = String(x.name || '').trim();
      if (!name || NOT_GENRE.test(name) || name.length > 30) continue;
      tags.set(fold(name), { genre: titleCase(name), w: (tags.get(fold(name))?.w || 0) + w * (x.count || 1) });
    }
  };
  // Search scores are generous ("Octave" scores 100 against "Octave One"), so names must match exactly.
  const same = (a, b) => normName(a) === normName(b);
  const rec = await get(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(`recording:${q(t.title)} AND artist:${q(artist)}`)}&fmt=json&limit=5`);
  let found = false;
  for (const r of rec.recordings || []) {
    const credited = (r['artist-credit'] || []).some(c => same(c.name || c.artist?.name, artist));
    if ((r.score || 0) >= 80 && credited) { found = true; take(r.tags, 2); }
  }
  // Artist-level tags only when this song was found under that artist; otherwise a namesake
  // (e.g. a different "Octave") could hand us the wrong genres.
  if (found && tags.size < 2 && artist) {
    const ar = await get(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:${q(artist)}`)}&fmt=json&limit=3`);
    const a = (ar.artists || []).find(x => same(x.name, artist));
    if (a) take(a.tags, 1);
  }
  return [...tags.values()].sort((a, b) => b.w - a.w).slice(0, 5).map(e => ({ genre: e.genre, why: 'MusicBrainz', source: 'online' }));
}

// ---------- tag cleaner ----------

const JUNK = [
  /\s*[([](?:official\s*)?(?:music\s*)?(?:video|audio|lyric(?:s)?(?:\s*video)?|visuali[sz]er|clip(?:\s*officiel)?|videoclip)(?:\s*official)?[)\]]/gi,
  /\s*[([](?:hd|hq|4k|1080p|720p|explicit|clean|audio|lyrics?|free download|out now|new|premiere|\d{2,3}\s*kbps)[)\]]/gi,
  /\s*-\s*(?:official\s*(?:music\s*)?video|lyrics?|audio)\s*$/i,
  /\s*\b\d{2,3}\s*kbps\b/gi,
  /\s*(?:www\.)?[a-z0-9-]+\.(?:com|net|org|ir|me|io|co|info|biz)\b\S*/gi,
];
const isAllCapsLatin = s => /[A-Z]{3}/.test(s) && s === s.toUpperCase() && /^[\x00-\x7F\u00C0-\u024F\s\d\W]+$/.test(s);
const smartTitleCase = s => s.toLowerCase().replace(/(^|[\s(\[\-"'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

function clean(s) {
  if (!s) return s;
  let o = s.replace(/_/g, ' ');
  for (const re of JUNK) o = o.replace(re, '');
  o = o.replace(/\s{2,}/g, ' ').replace(/^[\s\-–|.]+|[\s\-–|]+$/g, '').trim();
  // Long ALL-CAPS titles are usually sloppy tagging; short ones ("BORO", "SHAH") are the artist's own style.
  if (isAllCapsLatin(o) && o.split(/\s+/).length >= 3) o = smartTitleCase(o);
  return o || s;
}

/** Proposed fixes for one track, or null when it already looks clean. */
export function proposeCleanup(t) {
  const next = { title: clean(t.title), artist: clean(t.artist || ''), album: clean(t.album || '') };
  next.title = next.title.replace(/^\d{1,3}\s*[-.)]\s+/, '');
  if (!next.artist) {
    const m = next.title.match(/^(.+?)\s+[-–]\s+(.+)$/);
    if (m) { next.artist = m[1].trim(); next.title = m[2].trim(); }
  } else if (fold(next.title).startsWith(fold(next.artist) + ' - ')) {
    next.title = next.title.slice(next.artist.length + 3).trim();
  }
  const feat = next.title.match(/\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+([^)\]]+?)\s*[)\]]?\s*$/i);
  if (feat) {
    next.title = next.title.slice(0, feat.index).trim();
    if (!fold(next.artist).includes(fold(feat[1]))) next.artist = next.artist ? `${next.artist}, ${feat[1].trim()}` : feat[1].trim();
  }
  const changes = {};
  for (const k of ['title', 'artist', 'album']) if ((next[k] || '') !== (t[k] || '') && next[k]) changes[k] = next[k];
  return Object.keys(changes).length ? changes : null;
}

// ---------- equalizer ----------

export const EQ_PRESETS = {
  flat: { name: 'Flat', g: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { name: 'Bass Booster', g: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  treble: { name: 'Treble Booster', g: [0, 0, 0, 0, 0, 0, 1, 3, 4, 5] },
  vocal: { name: 'Vocal Booster', g: [-2, -2, -1, 0, 2, 3, 3, 2, 0, -1] },
  pop: { name: 'Pop', g: [-1, 1, 2, 3, 2, 0, -1, -1, 0, 1] },
  rock: { name: 'Rock', g: [4, 3, 1, -1, -2, -1, 1, 3, 4, 4] },
  hiphop: { name: 'Hip-Hop', g: [5, 4, 2, 1, -1, -1, 1, 0, 1, 2] },
  electronic: { name: 'Electronic', g: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5] },
  jazz: { name: 'Jazz', g: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  classical: { name: 'Classical', g: [3, 2, 1, 0, 0, 0, -1, 1, 2, 3] },
  acoustic: { name: 'Acoustic', g: [3, 2, 1, 1, 1, 1, 2, 2, 2, 1] },
  latenight: { name: 'Late Night', g: [5, 3, 0, 0, -1, 0, 0, 1, 3, 4] },
  spoken: { name: 'Spoken Word', g: [-4, -3, -1, 1, 3, 4, 3, 1, -1, -3] },
};
const FAMILY_PRESET = { hiphop: 'hiphop', rnb: 'pop', metal: 'rock', indie: 'rock', rock: 'rock', electronic: 'electronic', chill: 'latenight', jazz: 'jazz', classical: 'classical', latin: 'pop', country: 'acoustic', reggae: 'hiphop', pop: 'pop', world: 'acoustic' };
export const genrePreset = t => FAMILY_PRESET[familiesOf(t)[0]?.id] || null;

// Typical spectral balance of a well-mastered song (relative dB per band), used as the reference.
const TARGET = [-3, 0, -2, -5, -8, -11, -14.5, -18.5, -23, -30];
const REGION = ['deep bass', 'bass', 'warmth', 'body', 'low mids', 'mids', 'presence', 'vocal clarity', 'detail', 'air'];

/** A unique EQ curve for one song from its measured frequency balance, nudged toward its genre. */
export function recommendEQ(t) {
  const presetId = genrePreset(t);
  const preset = presetId ? EQ_PRESETS[presetId].g : EQ_PRESETS.flat.g;
  if (!t.an?.bands) {
    return { gains: preset.map(g => g * 0.6), reasons: [presetId ? `Based on the genre (${EQ_PRESETS[presetId].name}). It gets more precise once the song has been analyzed.` : 'The song hasn’t been analyzed yet, so this stays flat for now.'] };
  }
  const m = t.an.bands;
  const mid = a => a.slice(2, 9).reduce((x, y) => x + y, 0) / 7;
  const mm = mid(m), tm = mid(TARGET);
  let r = m.map((v, i) => Math.max(-5, Math.min(5, ((TARGET[i] - tm) - (v - mm)) * 0.5)));
  r[0] = Math.max(-4, Math.min(3, r[0]));
  r[9] = Math.max(-4, Math.min(2, r[9])); // MP3s often have nothing above 16 kHz; don't chase it
  r = r.map((v, i) => 0.25 * (r[i - 1] ?? v) + 0.5 * v + 0.25 * (r[i + 1] ?? v));
  let g = r.map((v, i) => 0.7 * v + 0.3 * preset[i]);
  const avg = g.reduce((a, b) => a + b, 0) / 10;
  if (avg > 0) g = g.map(v => v - avg);
  g = g.map(v => Math.round(v * 2) / 2);

  const reasons = [];
  const maxI = g.indexOf(Math.max(...g));
  const minI = g.indexOf(Math.min(...g));
  const f = i => (i >= 5 ? `${EQ_FREQS_LABEL[i]}` : `${EQ_FREQS_LABEL[i]}`);
  if (g[maxI] >= 1.5) reasons.push(`This song is a little light on ${REGION[maxI]}, so it lifts ${f(maxI)} by ${g[maxI]} dB.`);
  if (g[minI] <= -1.5) reasons.push(`It’s heavy around ${f(minI)} (${REGION[minI]}), so that’s lowered by ${Math.abs(g[minI])} dB to keep it clean.`);
  if (!reasons.length) reasons.push('This song is already well balanced, so only gentle tweaks are applied.');
  if (presetId) reasons.push(`Flavoured toward the ${EQ_PRESETS[presetId].name} sound of its genre.`);
  return { gains: g, reasons };
}
export const EQ_FREQS_LABEL = ['32 Hz', '64 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz', '16 kHz'];
