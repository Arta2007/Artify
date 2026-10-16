// Reads metadata from audio files (ID3v1/v2 for MP3, MP4 atoms for M4A/AAC, Vorbis comments for FLAC)
// and writes ID3v2.3 tags so exported MP3s carry the edited info and cover.

const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
  'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance',
  'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock', 'Bass',
  'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave',
  'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave',
  'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll',
  'Hard Rock'];

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');

const bytes = async (file, start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());
const str = (b, s, e) => latin1.decode(b.subarray(s, e));
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const synch = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

export async function readTags(file) {
  const out = {};
  try {
    const head = await bytes(file, 0, 12);
    if (str(head, 0, 3) === 'ID3') {
      const end = await readID3v2(file, head, out);
      const next = await bytes(file, end, end + 4);
      if (str(next, 0, 4) === 'fLaC') await readFLAC(file, out, end);
      else if (!out.duration) await mp3Duration(file, end, out);
    } else if (str(head, 0, 4) === 'fLaC') {
      await readFLAC(file, out, 0);
    } else if (str(head, 4, 8) === 'ftyp') {
      await readMP4(file, out);
    } else if (/\.mp3$/i.test(file.name)) {
      await mp3Duration(file, 0, out);
    }
    if (!out.title && file.size > 128) await readID3v1(file, out);
  } catch (e) {
    console.warn('Could not read tags of', file.name, e);
  }
  return tidy(out);
}

function tidy(o) {
  for (const k of Object.keys(o)) if (typeof o[k] === 'string') o[k] = o[k].replace(/\0/g, '').trim();
  // Placeholders some tools write instead of leaving a field empty
  for (const k of ['album', 'artist', 'albumArtist', 'genre']) if (/^(unknown( album| artist)?|<unknown>|untitled)$/i.test(o[k] || '')) o[k] = '';
  if (o.genre) {
    o.genre = o.genre.replace(/^\((\d+)\)(.*)$/, (_, n, rest) => rest.trim() || GENRES[+n] || '');
    if (/^\d+$/.test(o.genre)) o.genre = GENRES[+o.genre] || '';
  }
  if (o.year) o.year = (String(o.year).match(/\d{4}/) || [''])[0];
  for (const k of ['track', 'disc']) if (o[k]) o[k] = parseInt(o[k], 10) || 0;
  return o;
}

// ---------- ID3v2 ----------

function unsync(b) {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

const ID3_FIELDS = {
  TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album',
  TPE2: 'albumArtist', TP2: 'albumArtist', TCON: 'genre', TCO: 'genre', TYER: 'year', TYE: 'year',
  TDRC: 'year', TRCK: 'track', TRK: 'track', TPOS: 'disc', TPA: 'disc',
};

async function readID3v2(file, head, out) {
  const ver = head[3];
  const flags = head[5];
  const size = synch(head, 6);
  let b = await bytes(file, 10, 10 + size);
  if (flags & 0x80 && ver < 4) b = unsync(b);
  let p = 0;
  if (flags & 0x40) p = ver === 3 ? u32(b, 0) + 4 : synch(b, 0);
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;

  while (p + hdrLen <= b.length) {
    const id = str(b, p, p + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const fsize = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : ver === 4 ? synch(b, p + 4) : u32(b, p + 4);
    const fflags = ver === 2 ? 0 : b[p + 9];
    p += hdrLen;
    if (fsize <= 0 || p + fsize > b.length) break;
    let data = b.subarray(p, p + fsize);
    p += fsize;
    if (ver === 4) {
      if (fflags & 0x0c) continue; // compressed or encrypted
      if (fflags & 0x40) data = data.subarray(1);
      if (fflags & 0x01) data = data.subarray(4);
      if (fflags & 0x02) data = unsync(data);
    } else if (ver === 3) {
      if (fflags & 0xc0) continue;
      if (fflags & 0x20) data = data.subarray(1);
    }
    id3Frame(id, data, out);
  }
  return 10 + size + (ver === 4 && flags & 0x10 ? 10 : 0);
}

function decodeText(enc, b) {
  let s;
  if (enc === 1) {
    if (b[0] === 0xfe && b[1] === 0xff) s = utf16be.decode(b.subarray(2));
    else if (b[0] === 0xff && b[1] === 0xfe) s = utf16le.decode(b.subarray(2));
    else s = utf16le.decode(b);
  } else if (enc === 2) s = utf16be.decode(b);
  else if (enc === 3) s = utf8.decode(b);
  else s = latin1.decode(b);
  return s.replace(/[﻿￾]/g, '').split('\0').map(x => x.trim()).filter(Boolean).join(', ');
}

function id3Frame(id, d, out) {
  if ((id === 'USLT' || id === 'ULT') && !out.lyrics && d.length > 5) {
    // encoding, 3-byte language, null-terminated description, then the text
    const enc = d[0];
    let p = 4;
    if (enc === 1 || enc === 2) { while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2; p += 2; }
    else { while (p < d.length && d[p] !== 0) p++; p++; }
    const b = d.subarray(p);
    let s;
    if (enc === 1) s = b[0] === 0xfe ? utf16be.decode(b.subarray(2)) : utf16le.decode(b[0] === 0xff ? b.subarray(2) : b);
    else if (enc === 2) s = utf16be.decode(b);
    else if (enc === 3) s = utf8.decode(b);
    else s = latin1.decode(b);
    out.lyrics = s.replace(/\0/g, '').trim();
    return;
  }
  if (id === 'APIC' || id === 'PIC') {
    const pic = id3Picture(id, d);
    if (pic.data.length && (!out.picture || pic.type === 3)) out.picture = pic;
    return;
  }
  const key = ID3_FIELDS[id];
  if (!key || out[key] || !d.length) return;
  out[key] = decodeText(d[0], d.subarray(1));
}

function id3Picture(id, d) {
  const enc = d[0];
  let p;
  let mime;
  if (id === 'PIC') {
    mime = str(d, 1, 4).toUpperCase() === 'PNG' ? 'image/png' : 'image/jpeg';
    p = 4;
  } else {
    const end = d.indexOf(0, 1);
    mime = str(d, 1, end).toLowerCase() || 'image/jpeg';
    p = end + 1;
  }
  const type = d[p++];
  if (enc === 1 || enc === 2) {
    while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < d.length && d[p] !== 0) p++;
    p++;
  }
  if (!mime.includes('/')) mime = 'image/' + mime.replace('jpg', 'jpeg');
  return { type, mime, data: d.slice(p) };
}

async function readID3v1(file, out) {
  const b = await bytes(file, file.size - 128, file.size);
  if (str(b, 0, 3) !== 'TAG') return;
  const t = s => latin1.decode(s).replace(/\0[\s\S]*$/, '').trim();
  out.title ||= t(b.subarray(3, 33));
  out.artist ||= t(b.subarray(33, 63));
  out.album ||= t(b.subarray(63, 93));
  out.year ||= t(b.subarray(93, 97));
  if (b[125] === 0 && b[126]) out.track ||= b[126];
  if (b[127] < GENRES.length) out.genre ||= GENRES[b[127]];
}

// ---------- MP3 duration (Xing/Info/VBRI header, else CBR estimate) ----------

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

async function mp3Duration(file, start, out) {
  const b = await bytes(file, start, start + 65536);
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (b[i + 1] >> 1) & 3; // 1 = Layer III
    const bri = b[i + 2] >> 4;
    const sri = (b[i + 2] >> 2) & 3;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) continue;
    const mono = (b[i + 3] >> 6) === 3;
    const rate = SR[ver][sri];
    const spf = ver === 3 ? 1152 : 576;
    const side = ver === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const x = i + 4 + side;
    const tag = str(b, x, x + 4);
    if ((tag === 'Xing' || tag === 'Info') && b[x + 7] & 1) {
      out.duration = (u32(b, x + 8) * spf) / rate;
      return;
    }
    if (str(b, i + 36, i + 40) === 'VBRI') {
      out.duration = (u32(b, i + 36 + 14) * spf) / rate;
      return;
    }
    const kbps = (ver === 3 ? BR1 : BR2)[bri];
    out.duration = ((file.size - start - i) * 8) / (kbps * 1000);
    return;
  }
}

// ---------- FLAC ----------

async function readFLAC(file, out, start) {
  let p = start + 4;
  for (let n = 0; n < 128; n++) {
    const h = await bytes(file, p, p + 4);
    if (h.length < 4) break;
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    p += 4;
    if (type === 0 || type === 4 || type === 6) {
      const d = await bytes(file, p, p + len);
      if (type === 0) {
        const rate = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4);
        const total = (d[13] & 0x0f) * 2 ** 32 + u32(d, 14);
        if (rate) out.duration = total / rate;
      } else if (type === 4) {
        vorbisComments(d, out);
      } else {
        const pic = flacPicture(d);
        if (pic.data.length && (!out.picture || pic.type === 3)) out.picture = pic;
      }
    }
    p += len;
    if (last) break;
  }
}

const VORBIS = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist', 'ALBUM ARTIST': 'albumArtist',
  GENRE: 'genre', DATE: 'year', YEAR: 'year', TRACKNUMBER: 'track', DISCNUMBER: 'disc',
  LYRICS: 'lyrics', UNSYNCEDLYRICS: 'lyrics',
};

function vorbisComments(d, out) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let p = 4 + dv.getUint32(0, true);
  const count = dv.getUint32(p, true);
  p += 4;
  for (let i = 0; i < count && p + 4 <= d.length; i++) {
    const len = dv.getUint32(p, true);
    p += 4;
    const s = utf8.decode(d.subarray(p, p + len));
    p += len;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const key = VORBIS[s.slice(0, eq).toUpperCase()];
    const val = s.slice(eq + 1).trim();
    if (!key || !val) continue;
    if (!out[key]) out[key] = val;
    else if (key === 'artist' || key === 'genre') out[key] += ', ' + val;
  }
}

function flacPicture(d) {
  let p = 0;
  const type = u32(d, p); p += 4;
  const ml = u32(d, p); p += 4;
  const mime = str(d, p, p + ml) || 'image/jpeg'; p += ml;
  const dl = u32(d, p); p += 4 + dl + 16;
  const len = u32(d, p); p += 4;
  return { type, mime, data: d.slice(p, p + len) };
}

// ---------- MP4 / M4A ----------

function atoms(b, start, end, cb) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = str(b, p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    cb(type, p + hdr, p + size);
    p += size;
  }
}

async function readMP4(file, out) {
  let p = 0;
  while (p + 8 <= file.size) {
    const h = await bytes(file, p, p + 16);
    let size = u32(h, 0);
    const type = str(h, 4, 8);
    let hdr = 8;
    if (size === 1) { size = u32(h, 8) * 2 ** 32 + u32(h, 12); hdr = 16; }
    else if (size === 0) size = file.size - p;
    if (size < hdr) break;
    if (type === 'moov') {
      const m = await bytes(file, p + hdr, p + size);
      parseMoov(m, out);
      return;
    }
    p += size;
  }
}

const MP4_FIELDS = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', aART: 'albumArtist', '©gen': 'genre', '©day': 'year', '©lyr': 'lyrics' };

function parseMoov(b, out) {
  atoms(b, 0, b.length, (t, s, e) => {
    if (t === 'mvhd') {
      const v1 = b[s] === 1;
      const scale = u32(b, s + (v1 ? 20 : 12));
      const dur = v1 ? u32(b, s + 24) * 2 ** 32 + u32(b, s + 28) : u32(b, s + 16);
      if (scale) out.duration = dur / scale;
    }
    if (t !== 'udta') return;
    atoms(b, s, e, (t, s, e) => {
      if (t !== 'meta') return;
      const first = str(b, s + 4, s + 8) === 'hdlr' ? s : s + 4; // some files omit meta's version/flags
      atoms(b, first, e, (t, s, e) => {
        if (t !== 'ilst') return;
        atoms(b, s, e, (key, s, e) => {
          atoms(b, s, e, (t, ds, de) => { if (t === 'data') mp4Item(key, b.subarray(ds, de), out); });
        });
      });
    });
  });
}

function mp4Item(key, d, out) {
  const type = u32(d, 0) & 0xffffff;
  const v = d.subarray(8);
  if (MP4_FIELDS[key]) out[MP4_FIELDS[key]] ||= utf8.decode(v);
  else if (key === 'trkn' && v.length >= 4) out.track ||= (v[2] << 8) | v[3];
  else if (key === 'disk' && v.length >= 4) out.disc ||= (v[2] << 8) | v[3];
  else if (key === 'gnre' && v.length >= 2) out.genre ||= GENRES[((v[0] << 8) | v[1]) - 1] || '';
  else if (key === 'covr' && !out.picture && v.length) out.picture = { type: 3, mime: type === 14 ? 'image/png' : 'image/jpeg', data: v.slice() };
}

// ---------- ID3v2.3 writer (for MP3 export) ----------

function frame(id, data) {
  const h = new Uint8Array(10);
  for (let i = 0; i < 4; i++) h[i] = id.charCodeAt(i);
  new DataView(h.buffer).setUint32(4, data.length);
  return [h, data];
}

function textFrame(id, value) {
  const s = String(value);
  const b = new Uint8Array(3 + s.length * 2);
  b[0] = 1; b[1] = 0xff; b[2] = 0xfe; // UTF-16 with BOM, so any language works
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[3 + i * 2] = c & 0xff;
    b[4 + i * 2] = c >> 8;
  }
  return frame(id, b);
}

function utf16(s) {
  const b = new Uint8Array(2 + s.length * 2);
  b[0] = 0xff; b[1] = 0xfe;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[2 + i * 2] = c & 0xff; b[3 + i * 2] = c >> 8; }
  return b;
}

/** Returns a new MP3 blob with the track's current metadata (cover, lyrics) as an ID3v2.3 tag. */
export async function withID3(blob, meta, cover, lyrics) {
  const head = await bytes(blob, 0, 10);
  let start = 0;
  if (str(head, 0, 3) === 'ID3') start = 10 + synch(head, 6) + (head[5] & 0x10 ? 10 : 0);
  let end = blob.size;
  if (blob.size > 128 && str(await bytes(blob, blob.size - 128, blob.size - 125), 0, 3) === 'TAG') end -= 128;

  const parts = [];
  const fields = [['TIT2', meta.title], ['TPE1', meta.artist], ['TALB', meta.album], ['TPE2', meta.albumArtist],
    ['TCON', meta.genre], ['TYER', meta.year], ['TRCK', meta.track || ''], ['TPOS', meta.disc || '']];
  for (const [id, v] of fields) if (v) parts.push(...textFrame(id, v));
  if (lyrics) {
    const desc = utf16('');
    const text = utf16(lyrics);
    const b = new Uint8Array(4 + desc.length + 2 + text.length);
    b[0] = 1; b.set([0x58, 0x58, 0x58], 1); // language "XXX" (unknown)
    b.set(desc, 4);
    b.set(text, 4 + desc.length + 2);
    parts.push(...frame('USLT', b));
  }
  if (cover) {
    const img = new Uint8Array(await cover.arrayBuffer());
    const mime = cover.type || 'image/jpeg';
    const b = new Uint8Array(1 + mime.length + 1 + 1 + 1 + img.length);
    let p = 1; // encoding 0 (latin1)
    for (let i = 0; i < mime.length; i++) b[p++] = mime.charCodeAt(i);
    p++; // mime terminator
    b[p++] = 3; // front cover
    p++; // empty description
    b.set(img, p);
    parts.push(...frame('APIC', b));
  }
  const bodyLen = parts.reduce((n, x) => n + x.length, 0);
  const pad = 512;
  const h = new Uint8Array(10);
  h.set([0x49, 0x44, 0x33, 3, 0, 0]);
  const total = bodyLen + pad;
  h[6] = (total >> 21) & 0x7f; h[7] = (total >> 14) & 0x7f; h[8] = (total >> 7) & 0x7f; h[9] = total & 0x7f;
  return new Blob([h, ...parts, new Uint8Array(pad), blob.slice(start, end)], { type: 'audio/mpeg' });
}
