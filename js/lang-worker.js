// Module worker: spoken-language identification with Whisper (base, 8-bit) running fully on the device.
// The model (~77 MB) downloads once from Hugging Face and is cached by the browser for offline use.
// "base" rather than "tiny": on real songs (vocals over beats) tiny got 4/15 right, base 15/15.
import { AutoProcessor, WhisperForConditionalGeneration, Tensor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL = 'onnx-community/whisper-base';
const LANGS = ('en,zh,de,es,ru,ko,fr,ja,pt,tr,pl,ca,nl,ar,sv,it,id,hi,fi,vi,he,uk,el,ms,cs,ro,da,hu,ta,no,th,ur,hr,bg,lt,la,mi,ml,cy,sk,te,fa,lv,bn,sr,az,sl,kn,et,mk,br,eu,is,hy,ne,mn,bs,kk,sq,sw,gl,mr,pa,si,km,sn,yo,so,af,oc,ka,be,tg,sd,gu,am,yi,lo,uz,fo,ht,ps,tk,nn,mt,sa,lb,my,bo,tl,mg,as,tt,haw,ln,ha,ba,jw,su').split(',');
const SOT = 50258;
const FIRST_LANG = 50259;
const NO_SPEECH = 50362;

let loading = null;
const progress = p => self.postMessage({ type: 'progress', p: { status: p.status, file: p.file, loaded: p.loaded, total: p.total } });

function load() {
  return loading ||= (async () => {
    const processor = await AutoProcessor.from_pretrained(MODEL, { progress_callback: progress });
    const model = await WhisperForConditionalGeneration.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback: progress });
    return { processor, model };
  })().catch(e => { loading = null; throw e; });
}

async function detect(segments) {
  const { processor, model } = await load();
  const probs = new Float64Array(LANGS.length);
  let noSpeech = 0;
  let noSpeechMin = 1;
  let weightSum = 0;
  let processed = 0;
  for (const [n, seg] of segments.entries()) {
    // After three parts, stop early when the answer is already clear (saves ~40% of the time per song).
    if (n === 3) {
      let b = 0;
      for (let i = 1; i < LANGS.length; i++) if (probs[i] > probs[b]) b = i;
      if (probs[b] / weightSum >= 0.55 && noSpeechMin < 0.8) break;
    }
    processed++;
    const inputs = await processor(seg);
    const out = await model({
      ...inputs,
      decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(SOT)]), [1, 1]),
    });
    const logits = out.logits.data;
    const vocab = out.logits.dims.at(-1);
    const row = logits.length - vocab; // last (only) position
    // No-speech probability: softmax over the whole vocabulary at the start-of-transcript position.
    let max = -Infinity;
    for (let i = 0; i < vocab; i++) if (logits[row + i] > max) max = logits[row + i];
    let sum = 0;
    for (let i = 0; i < vocab; i++) sum += Math.exp(logits[row + i] - max);
    const ns = Math.exp(logits[row + NO_SPEECH] - max) / sum;
    noSpeech += ns;
    noSpeechMin = Math.min(noSpeechMin, ns);
    // Language probabilities: softmax over the language tokens only. Parts with clear vocals count more.
    let lmax = -Infinity;
    for (let i = 0; i < LANGS.length; i++) lmax = Math.max(lmax, logits[row + FIRST_LANG + i]);
    let lsum = 0;
    const p = new Float64Array(LANGS.length);
    for (let i = 0; i < LANGS.length; i++) { p[i] = Math.exp(logits[row + FIRST_LANG + i] - lmax); lsum += p[i]; }
    const w = 1.15 - ns;
    weightSum += w;
    for (let i = 0; i < LANGS.length; i++) probs[i] += (w * p[i]) / lsum;
  }
  const top = [...probs].map((p, i) => ({ code: LANGS[i], p: p / weightSum })).sort((a, b) => b.p - a.p).slice(0, 10);
  return { top, code: top[0].code, conf: top[0].p, noSpeech: noSpeech / Math.max(1, processed), noSpeechMin, parts: processed };
}

self.onmessage = async e => {
  const { id, type, segments } = e.data;
  try {
    if (type === 'load') { await load(); self.postMessage({ id, result: true }); return; }
    self.postMessage({ id, result: await detect(segments) });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
