// Legal free music from the Internet Archive (archive.org): only recordings marked free to share —
// Creative Commons / public-domain licences, netlabel releases, and live concerts from bands that allow taping.

const IA = 'https://archive.org';

export const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'netlabels', label: 'Netlabels', q: 'collection:netlabels' },
  { id: 'live', label: 'Live concerts', q: 'collection:etree' },
  { id: 'electronic', label: 'Electronic', q: 'subject:(electronic OR electronica OR techno OR house)' },
  { id: 'ambient', label: 'Ambient', q: 'subject:(ambient OR chillout OR downtempo)' },
  { id: 'hiphop', label: 'Hip-Hop', q: 'subject:("hip hop" OR hiphop OR rap)' },
  { id: 'rock', label: 'Rock', q: 'subject:(rock OR punk OR indie)' },
  { id: 'jazz', label: 'Jazz', q: 'subject:jazz' },
  { id: 'classical', label: 'Classical', q: 'subject:(classical OR orchestral OR piano)' },
];

// Only things that are clearly free to share. (General community uploads without a licence are left out.)
const FREE = '(licenseurl:(*creativecommons* OR *publicdomain*) OR collection:(netlabels OR etree))';
// Music only: the Archive's music collections, without audiobooks, podcasts or radio shows.
const MUSIC = 'collection:(audio_music OR netlabels OR etree) AND NOT collection:(librivoxaudio OR podcasts OR radioprograms OR oldtimeradio OR audio_bookspoetry) AND NOT subject:(audiobook OR librivox OR podcast OR "spoken word")';

const clean = s => String(s || '').replace(/[:()[\]{}^~*?\\"!]/g, ' ').trim();
const first = v => (Array.isArray(v) ? v[0] : v) || '';

export const thumbUrl = id => `${IA}/services/img/${encodeURIComponent(id)}`;
export const pageUrl = id => `${IA}/details/${encodeURIComponent(id)}`;

export function licenseLabel(meta) {
  const url = String(first(meta.licenseurl) || '').toLowerCase();
  const coll = [].concat(meta.collection || []).map(String);
  if (url.includes('publicdomain')) return { short: 'Public domain', long: 'Public domain: free to use for anything' };
  const cc = url.match(/creativecommons\.org\/licenses\/([a-z-]+)/);
  if (cc) {
    const kind = cc[1].toUpperCase();
    return { short: `CC ${kind}`, long: `Creative Commons ${kind}: free to download and share${kind.includes('NC') ? ' (not for commercial use)' : ''}${kind.includes('BY') ? ', credit the artist' : ''}` };
  }
  if (coll.includes('etree')) return { short: 'Live · free to share', long: 'Live recording from a band that allows taping and non-commercial sharing' };
  if (coll.includes('netlabels')) return { short: 'Netlabel · free', long: 'Free release from an independent netlabel' };
  return { short: 'Free', long: 'Shared for free on the Internet Archive' };
}

/** Search albums/recordings. Returns [{ id, title, creator, year, downloads, license }]. */
export async function search(text, catId = 'all', page = 1) {
  const parts = ['mediatype:audio', FREE, MUSIC];
  const q = clean(text);
  if (q) parts.push(`(${q})`);
  const cat = CATEGORIES.find(c => c.id === catId);
  if (cat?.q) parts.push(cat.q);
  const params = new URLSearchParams({ q: parts.join(' AND '), rows: '30', page: String(page), output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'date', 'downloads', 'licenseurl', 'collection']) params.append('fl[]', f);
  if (!q) params.append('sort[]', 'downloads desc');
  const res = await fetch(`${IA}/advancedsearch.php?${params}`);
  if (!res.ok) throw new Error(`Internet Archive ${res.status}`);
  const j = await res.json();
  return (j.response?.docs || []).map(d => ({
    id: d.identifier,
    title: first(d.title) || d.identifier,
    creator: first(d.creator),
    year: String(first(d.date) || '').slice(0, 4),
    downloads: d.downloads || 0,
    license: licenseLabel(d),
  }));
}

/** A readable title from a file name like "tcp_d1_02_counting_cia_irdial.mp3" → "Counting Cia". */
function niceTitle(name, id) {
  const tokens = name.replace(/^.*\//, '').replace(/\.mp3$/i, '').split(/[_\s]+/).filter(Boolean);
  // drop leading disc/track codes ("tcp", "d1", "02", "t01")
  while (tokens.length > 1 && (/\d/.test(tokens[0]) || /^\W+$/.test(tokens[0]) || (tokens[0].length <= 3 && /\d/.test(tokens[1] || '')))) tokens.shift();
  // drop a trailing label tag that matches the item id ("irdial" in item "ird059")
  const idWord = (id.match(/^[a-z]+/i) || [''])[0].toLowerCase();
  if (tokens.length > 1 && idWord.length >= 3 && tokens.at(-1).toLowerCase().startsWith(idWord)) tokens.pop();
  const s = tokens.join(' ').trim();
  return s === s.toLowerCase() ? s.replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : s;
}

const toSeconds = v => {
  if (v == null) return 0;
  const s = String(v);
  if (s.includes(':')) return s.split(':').reduce((a, x) => a * 60 + (parseFloat(x) || 0), 0);
  return parseFloat(s) || 0;
};

/** One album/recording with its playable MP3 tracks and cover. */
export async function item(id) {
  const res = await fetch(`${IA}/metadata/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Internet Archive ${res.status}`);
  const m = await res.json();
  const meta = m.metadata || {};
  const files = m.files || [];
  const dl = name => `${IA}/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;
  // Prefer the uploader's own MP3s; otherwise the Archive's full-quality MP3 copies (skip the 64 kbps duplicates).
  let mp3 = files.filter(f => /\.mp3$/i.test(f.name) && f.source === 'original');
  if (!mp3.length) mp3 = files.filter(f => /\.mp3$/i.test(f.name) && !/64Kbps/i.test(f.format || '') && !/_64kb\.mp3$/i.test(f.name));
  const album = first(meta.title) || id;
  const creator = first(meta.creator);
  const tracks = mp3
    .map(f => ({
      name: f.name,
      title: f.title || niceTitle(f.name, id),
      artist: f.artist || f.creator || creator,
      album: f.album || album,
      track: parseInt(f.track, 10) || 0,
      length: toSeconds(f.length),
      size: +f.size || 0,
      url: dl(f.name),
    }))
    .sort((a, b) => (a.track || 999) - (b.track || 999) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .slice(0, 200);
  const imgs = files.filter(f => /\.(jpe?g|png)$/i.test(f.name) && !/thumb|_itemimage|__ia_thumb/i.test(f.name));
  const cover = imgs.find(f => /cover|front|folder|art/i.test(f.name)) || imgs.find(f => f.source === 'original') || imgs[0];
  const desc = String(first(meta.description) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    id,
    title: album,
    creator,
    year: String(first(meta.date) || '').slice(0, 4),
    description: desc.length > 280 ? desc.slice(0, 277) + '…' : desc,
    license: licenseLabel(meta),
    coverUrl: cover ? dl(cover.name) : null,
    tracks,
  };
}
