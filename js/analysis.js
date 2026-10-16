// Decodes audio on the main thread (the only place browsers allow it) and hands the PCM to a worker.

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

/** Decodes a blob to a mono Float32Array at the given sample rate. */
export async function decodeMono(blob, sr) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, sr, sr);
  const ab = await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(buf, res, rej);
    if (p && p.then) p.then(res, rej);
  });
  const n = ab.length;
  const out = new Float32Array(n);
  const chs = ab.numberOfChannels;
  for (let c = 0; c < chs; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / chs;
  }
  return out;
}

const SR = 32000;

export async function analyzeBlob(blob) {
  const pcm = await decodeMono(blob, SR);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, pcm, sr: SR }, [pcm.buffer]);
  });
}
