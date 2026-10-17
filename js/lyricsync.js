// Syncs plain (untimed) lyrics to a song without a big AI model:
//  1. vocal activity over time (from analysis-worker) → sung phrases
//  2. fit the lyric lines onto phrase starts so each line's time matches its length (syllables)
//  3. the listener taps a few lines while it plays; untapped lines are re-spaced between those anchors

/** Rough syllable count; works for Latin script (incl. Finglish) and Arabic/Persian script. */
export function syllables(line) {
  const s = String(line || '').toLowerCase();
  const arabic = (s.match(/[؀-ۿ]/g) || []).length;
  if (arabic) return Math.max(1, Math.round(arabic / 2.2));
  const groups = (s.match(/[aeiouyàáâäãåèéêëìíîïòóôöõùúûüýœæ]+/g) || []).length;
  if (groups) return groups;
  return Math.max(1, Math.round(s.replace(/\s+/g, '').length / 3));
}

/** Plain lyrics → { lines: [{ text, br }] } where br marks a blank line (section break) before it. */
export function splitLines(text) {
  const out = [];
  let br = false;
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const t = raw.replace(/\[[0-9:.]+\]/g, '').trim();
    if (!t) { br = out.length > 0; continue; }
    if (/^\[(ti|ar|al|by|offset|length):/i.test(raw)) continue;
    out.push({ text: t, br });
    br = false;
  }
  return out;
}

/** Sung phrases: [{ a, b }] in seconds, from the smoothed vocal score. */
export function phrases(score, hop, { from = 0, to = Infinity } = {}) {
  const n = score.length;
  const i0 = Math.max(0, Math.floor(from / hop));
  const i1 = Math.min(n, Math.ceil(Math.min(to, n * hop) / hop));
  // Pick the threshold so that roughly 55% of the song (between first and last sound) counts as singing.
  const vals = Array.from(score.slice(i0, i1)).sort((x, y) => x - y);
  const thr = vals[Math.floor(vals.length * 0.45)] ?? 0;
  const segs = [];
  let start = -1;
  for (let i = i0; i < i1; i++) {
    const on = score[i] > thr;
    if (on && start < 0) start = i;
    if ((!on || i === i1 - 1) && start >= 0) { segs.push({ a: start * hop, b: (on ? i + 1 : i) * hop }); start = -1; }
  }
  // Merge tiny gaps (breaths inside a phrase), drop blips.
  const merged = [];
  for (const s of segs) {
    const last = merged.at(-1);
    if (last && s.a - last.b < 0.35) last.b = s.b;
    else merged.push({ ...s });
  }
  return merged.filter(s => s.b - s.a >= 0.45);
}

/** Phrase starts, plus extra candidate starts at dips inside long phrases (continuous singing). */
function onsetCandidates(segs, score, hop, want) {
  const cands = segs.map(s => ({ t: s.a, gap: 0, strength: 2 }));
  for (let k = 1; k < segs.length; k++) cands[k].gap = segs[k].a - segs[k - 1].b;
  if (cands.length) cands[0].gap = 99;
  if (cands.length < want) {
    const dips = [];
    for (const s of segs) {
      const a = Math.ceil(s.a / hop) + 6, b = Math.floor(s.b / hop) - 6;
      for (let i = a; i < b; i++) {
        if (score[i] < score[i - 1] && score[i] <= score[i + 1]) {
          const around = Math.min(Math.max(...score.slice(i - 6, i)), Math.max(...score.slice(i + 1, i + 7)));
          const depth = around - score[i];
          if (depth > 0.15) dips.push({ t: (i + 1) * hop, gap: 0, strength: depth });
        }
      }
    }
    dips.sort((x, y) => y.strength - x.strength);
    cands.push(...dips.slice(0, Math.max(0, Math.round(want * 1.6) - cands.length)));
  }
  return cands.sort((x, y) => x.t - y.t);
}

/**
 * Times (seconds) for each line. `lines` from splitLines(); `va` from vocalActivity(); `song` = { intro, outro, duration }.
 * Dynamic programming: each line gets a candidate start, in order, so that the time until the next line's start
 * matches the line's expected length (syllables × the song's singing pace). Section breaks prefer real pauses.
 */
export function autoSync(lines, va, song = {}) {
  const n = lines.length;
  if (!n) return [];
  const dur = song.duration || va.score.length * va.hop;
  const from = song.intro || 0;
  const to = song.outro || dur;
  const segs = phrases(va.score, va.hop, { from, to });
  const syl = lines.map(l => syllables(l.text));
  const totalSyl = syl.reduce((a, b) => a + b, 0);
  const singing = segs.reduce((a, s) => a + (s.b - s.a), 0);
  // Fallback: nothing usable detected → spread lines evenly by length between first and last sound.
  if (!segs.length) {
    let acc = 0;
    return syl.map(s => { const t = from + ((to - from) * acc) / totalSyl; acc += s; return t; });
  }
  const pace = singing / totalSyl; // seconds per syllable while singing
  const cands = onsetCandidates(segs, va.score, va.hop, n);
  const m = cands.length;
  const endOfSinging = segs.at(-1).b;
  // cost of line i starting at candidate j and lasting until candidate k (or the end of singing)
  const sungBetween = (t0, t1) => segs.reduce((a, s) => a + Math.max(0, Math.min(s.b, t1) - Math.max(s.a, t0)), 0);
  const lineCost = (i, j, tEnd) => {
    const expect = syl[i] * pace;
    const sung = sungBetween(cands[j].t, tEnd);
    const span = tEnd - cands[j].t;
    let c = ((sung - expect) ** 2) / (expect + 1);
    if (span - sung > 5) c += (span - sung - 5) * 0.8; // a line shouldn't stretch over a long instrumental part
    if (lines[i].br && cands[j].gap < 1.2) c += 1.5; // a new section usually starts after a pause
    if (cands[j].strength < 2) c += 0.25; // dips are less certain than real phrase starts
    return c;
  };
  if (m < n) {
    // Not enough candidates: fall back to length-proportional placement along the singing time.
    const out = [];
    let acc = 0;
    for (let i = 0; i < n; i++) { out.push(timeAtSinging(segs, (singing * acc) / totalSyl)); acc += syl[i]; }
    return out;
  }
  // D[i][j]: best cost for lines 0..i with line i starting at candidate j
  const INF = 1e18;
  const D = Array.from({ length: n }, () => new Float64Array(m).fill(INF));
  const P = Array.from({ length: n }, () => new Int32Array(m).fill(-1));
  for (let j = 0; j <= m - n; j++) D[0][j] = j * 0.6; // prefer starting at the first phrases
  for (let i = 1; i < n; i++) {
    for (let j = i; j <= m - (n - i); j++) {
      let best = INF, arg = -1;
      for (let k = i - 1; k < j; k++) {
        if (D[i - 1][k] >= INF) continue;
        const c = D[i - 1][k] + lineCost(i - 1, k, cands[j].t);
        if (c < best) { best = c; arg = k; }
      }
      D[i][j] = best;
      P[i][j] = arg;
    }
  }
  let bj = -1, bc = INF;
  for (let j = n - 1; j < m; j++) {
    if (D[n - 1][j] >= INF) continue;
    const c = D[n - 1][j] + lineCost(n - 1, j, endOfSinging);
    if (c < bc) { bc = c; bj = j; }
  }
  const pick = new Array(n);
  for (let i = n - 1, j = bj; i >= 0; i--) { pick[i] = j; j = P[i][j]; }
  return pick.map(j => Math.round(cands[j].t * 100) / 100);
}

function timeAtSinging(segs, x) {
  let left = x;
  for (const s of segs) {
    const len = s.b - s.a;
    if (left <= len) return s.a + left;
    left -= len;
  }
  return segs.at(-1).b;
}

/**
 * Applies the listener's taps: anchors = Map(lineIndex → seconds). Lines between two anchors are re-spaced
 * proportionally to the automatic timing; lines before the first / after the last shift with it.
 */
export function applyAnchors(auto, anchors) {
  const n = auto.length;
  const keys = [...anchors.keys()].filter(k => k >= 0 && k < n).sort((a, b) => a - b);
  if (!keys.length) return auto.slice();
  const out = auto.slice();
  for (const k of keys) out[k] = anchors.get(k);
  // before the first anchor: shift
  const k0 = keys[0];
  for (let i = 0; i < k0; i++) out[i] = auto[i] + (anchors.get(k0) - auto[k0]);
  // between anchors: proportional
  for (let a = 0; a < keys.length - 1; a++) {
    const ka = keys[a], kb = keys[a + 1];
    const A = anchors.get(ka), B = anchors.get(kb);
    const span = auto[kb] - auto[ka];
    for (let i = ka + 1; i < kb; i++) out[i] = span > 0.01 ? A + ((auto[i] - auto[ka]) / span) * (B - A) : A + ((i - ka) / (kb - ka)) * (B - A);
  }
  // after the last anchor: shift
  const kl = keys.at(-1);
  for (let i = kl + 1; i < n; i++) out[i] = auto[i] + (anchors.get(kl) - auto[kl]);
  // keep them in order and non-negative
  for (let i = 0; i < n; i++) out[i] = Math.max(0, i ? Math.max(out[i], out[i - 1] + 0.2) : out[i]);
  return out.map(v => Math.round(v * 100) / 100);
}

const stamp = s => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `[${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}]`;
};

/** Synced .lrc text from lines and times. */
export function toLRC(lines, times) {
  return lines.map((l, i) => `${stamp(times[i] ?? 0)}${l.text}`).join('\n') + '\n';
}
