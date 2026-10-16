// Parses .lrc synced lyrics ("[01:23.45] line"). Plain text without timestamps is returned unsynced.

export function parseLyrics(text) {
  if (!text) return null;
  let offset = 0;
  const lines = [];
  const plain = [];
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) { offset = +off[1] / 1000; continue; }
    if (/^\[(ti|ar|al|au|by|length|re|ve|#):/i.test(raw)) continue;
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    const content = raw.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    if (stamps.length) {
      for (const s of stamps) lines.push({ t: +s[1] * 60 + parseFloat(s[2].replace(':', '.')), text: content });
    } else if (raw.trim()) {
      plain.push(raw.trim());
    }
  }
  if (lines.length >= 3) {
    lines.sort((a, b) => a.t - b.t);
    for (const l of lines) l.t = Math.max(0, l.t - offset);
    return { synced: true, lines };
  }
  const all = plain.length ? plain : lines.map(l => l.text);
  return all.length ? { synced: false, lines: all.map(text => ({ t: null, text })) } : null;
}

/** Index of the line being sung at time t (or -1 before the first line). */
export function activeLine(lyr, t) {
  if (!lyr?.synced) return -1;
  let lo = 0, hi = lyr.lines.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (lyr.lines[m].t <= t + 0.25) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}
