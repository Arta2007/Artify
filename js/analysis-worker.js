// Runs off the main thread. Input: mono PCM + sample rate. Output: loudness, silence bounds, fade-out point,
// tempo, energy-related features and the average level in each of the 10 equalizer bands.

const FFT_N = 1024;
const HOP = 512;
const BAND_CENTERS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function makeFFT(n) {
  const levels = Math.log2(n);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
    rev[i] = r;
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

const db = x => 10 * Math.log10(Math.max(x, 1e-12));

function analyze(x, sr) {
  const n = x.length;
  const dur = n / sr;

  // --- peak, gated loudness (400 ms blocks), silence bounds (50 ms blocks) ---
  let peak = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }

  const blk = Math.round(sr * 0.4);
  const energies = [];
  for (let s = 0; s + blk <= n; s += blk >> 1) {
    let e = 0;
    for (let i = s; i < s + blk; i++) e += x[i] * x[i];
    energies.push(e / blk);
  }
  const abs = energies.filter(e => db(e) > -70);
  const mean = abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length);
  const gated = abs.filter(e => db(e) > db(mean) - 10);
  const loudness = db(gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length)) - 0.691 + 3; // ≈ LUFS for typical music

  const sb = Math.round(sr * 0.05);
  const thr = Math.pow(10, -48 / 20);
  let intro = 0;
  let outro = dur;
  for (let s = 0; s + sb <= n; s += sb) {
    let e = 0;
    for (let i = s; i < s + sb; i++) e += x[i] * x[i];
    if (Math.sqrt(e / sb) > thr) { intro = s / sr; break; }
  }
  for (let s = n - sb; s >= 0; s -= sb) {
    let e = 0;
    for (let i = s; i < s + sb; i++) e += x[i] * x[i];
    if (Math.sqrt(e / sb) > thr) { outro = (s + sb) / sr; break; }
  }

  // Fade-out start: walking back from the end, the last 1 s window that is still within 9 dB of the song's loudness.
  const w = sr;
  let fadeStart = outro;
  for (let s = Math.floor(outro * sr) - w; s > n * 0.5; s -= w >> 1) {
    let e = 0;
    for (let i = s; i < s + w; i++) e += x[i] * x[i];
    if (db(e / w) > loudness - 9 - 3) { fadeStart = Math.min(outro, (s + w) / sr); break; }
  }

  // --- spectral pass: band levels, centroid, spectral flux for tempo/onsets ---
  const fft = makeFFT(FFT_N);
  const win = new Float64Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
  const re = new Float64Array(FFT_N);
  const im = new Float64Array(FFT_N);
  const binHz = sr / FFT_N;
  const edges = BAND_CENTERS.map((c, i) => [i === 0 ? 20 : c / Math.SQRT2, Math.min(sr / 2, c * Math.SQRT2)]);
  const bandBins = edges.map(([lo, hi]) => [Math.max(1, Math.floor(lo / binHz)), Math.max(1, Math.ceil(hi / binHz))]);
  const bandPow = new Float64Array(10);
  let centroidSum = 0;
  let centroidW = 0;
  const flux = [];
  let prev = new Float64Array(FFT_N / 2);
  let cur = new Float64Array(FFT_N / 2);
  let frames = 0;

  for (let s = 0; s + FFT_N <= n; s += HOP) {
    for (let i = 0; i < FFT_N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let f = 0;
    let frameE = 0;
    for (let k = 1; k < FFT_N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      const m = Math.sqrt(p);
      cur[k] = m;
      const d = Math.log1p(m) - Math.log1p(prev[k]);
      if (d > 0) f += d;
      frameE += p;
      centroidSum += k * binHz * p;
      centroidW += p;
    }
    if (db(frameE / FFT_N) > -60) {
      frames++;
      for (let b = 0; b < 10; b++) {
        const [lo, hi] = bandBins[b];
        let e = 0;
        for (let k = lo; k <= hi && k < FFT_N / 2; k++) e += cur[k] * cur[k];
        bandPow[b] += e / Math.max(1, hi - lo + 1);
      }
    }
    flux.push(f);
    [prev, cur] = [cur, prev];
  }
  const bands = Array.from(bandPow, p => Math.round(db(p / Math.max(1, frames)) * 10) / 10);
  const centroid = centroidW ? centroidSum / centroidW : 0;

  // --- tempo from the autocorrelation of the onset (flux) envelope ---
  const fps = sr / HOP;
  const fm = flux.reduce((a, b) => a + b, 0) / Math.max(1, flux.length);
  const env = flux.map(v => Math.max(0, v - fm));
  let best = 0;
  let bestLag = 0;
  const scores = [];
  const minLag = Math.floor((60 * fps) / 200);
  const maxLag = Math.ceil((60 * fps) / 60);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i + lag < env.length; i++) c += env[i] * env[i + lag];
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    scores[lag] = c;
    if (c * prior > best) { best = c * prior; bestLag = lag; }
  }
  let bpm = 0;
  if (bestLag) {
    const a = scores[bestLag - 1] || 0, b = scores[bestLag], c = scores[bestLag + 1] || 0;
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    bpm = (60 * fps) / (bestLag + (Math.abs(shift) < 1 ? shift : 0));
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
  }

  // Onset rate: peaks in the flux envelope above a moving threshold.
  let onsets = 0;
  const half = Math.round(fps * 0.5);
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] <= env[i - 1] || env[i] < env[i + 1]) continue;
    let local = 0;
    const lo = Math.max(0, i - half), hi = Math.min(env.length, i + half);
    for (let j = lo; j < hi; j++) local += env[j];
    if (env[i] > 1.5 * (local / (hi - lo)) && env[i] > fm * 0.5) onsets++;
  }

  return {
    v: 1,
    dur: Math.round(dur * 100) / 100,
    peak: Math.round(db(peak * peak) * 10) / 10,
    loudness: Math.round(loudness * 10) / 10,
    intro: Math.round(intro * 100) / 100,
    outro: Math.round(outro * 100) / 100,
    fade: Math.round(fadeStart * 100) / 100,
    bpm: Math.round(bpm * 10) / 10,
    onsetRate: Math.round((onsets / Math.max(1, dur)) * 100) / 100,
    centroid: Math.round(centroid),
    bands,
  };
}

self.onmessage = e => {
  const { id, pcm, sr } = e.data;
  try {
    self.postMessage({ id, result: analyze(pcm, sr) });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
