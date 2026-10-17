// Decodes audio on the main thread (the only place browsers allow it) and hands the PCM to a worker.
//
// Memory matters on iPhone: decoding a whole song makes a full uncompressed copy of it, and iOS kills the page if
// memory piles up (which it did when 100+ songs were analyzed back to back). So: decode at a modest sample rate,
// reuse one decoder instead of creating a new audio context per song, and keep only one mono copy around.

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./analysis-worker.js', import.meta.url));
  worker.onmessage = e => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
  };
  return worker;
}

// One decoding context per sample rate, reused for every song (decoding doesn't depend on rendering).
const decoders = new Map();
function decoder(sr) {
  if (!decoders.has(sr)) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    decoders.set(sr, new Ctx(1, sr, sr));
  }
  return decoders.get(sr);
}

/** Decodes a blob to a mono Float32Array at the given sample rate. */
export async function decodeMono(blob, sr) {
  let buf = await blob.arrayBuffer();
  let ab = await new Promise((res, rej) => {
    const p = decoder(sr).decodeAudioData(buf, res, rej);
    if (p && p.then) p.then(res, rej);
  });
  buf = null; // the compressed bytes aren't needed any more
  const n = ab.length;
  const chs = ab.numberOfChannels;
  const out = new Float32Array(n);
  if (chs === 1) out.set(ab.getChannelData(0));
  else {
    const L = ab.getChannelData(0);
    const R = ab.getChannelData(1);
    for (let i = 0; i < n; i++) out[i] = (L[i] + R[i]) * 0.5;
  }
  ab = null; // let the big stereo buffer go before the next step
  return out;
}

/** Sample rate for analysis: plenty for tempo, loudness, silence and the EQ bands; lower for very long tracks. */
const rateFor = durationSec => (durationSec > 600 ? 11025 : 22050);

export async function analyzeBlob(blob, durationSec = 0) {
  const sr = rateFor(durationSec || blob.size / 16000); // ~128 kbps estimate when the length isn't known yet
  const pcm = await decodeMono(blob, sr);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, pcm, sr }, [pcm.buffer]); // hand the samples over without copying
  });
}
