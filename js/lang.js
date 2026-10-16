// Song language: a quick guess from the text (title/artist/album), and on-device AI that listens to the vocals.
import { decodeMono } from './analysis.js';

export const INSTRUMENTAL = 'zxx';

let names;
export function langName(code) {
  if (!code) return 'Unknown';
  if (code === INSTRUMENTAL) return 'Instrumental';
  const fix = { jw: 'jv', haw: 'haw' }[code] || code;
  try {
    names ||= new Intl.DisplayNames(['en'], { type: 'language' });
    const n = names.of(fix);
    if (n && n !== fix) return n;
  } catch {}
  return code.toUpperCase();
}

export const COMMON_LANGS = ['en', 'fa', 'ar', 'tr', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'uk', 'ko', 'ja', 'zh', 'hi', 'ur', 'he', 'el', 'nl', 'sv', 'pl', 'ku', 'az', 'hy', INSTRUMENTAL];

const WORDS = {
  en: 'the you me my love i and of in to your it is we dont im baby night all oh be on that this for with feel heart never',
  es: 'el la los las de que y mi tu amor corazon por para con una sin te quiero yo eres como mas noche vida',
  pt: 'nao voce meu minha coracao saudade uma com do da eu te amo vida noite tudo sem',
  fr: 'le la les des je tu et pour mon ma toi moi une est pas dans amour coeur nuit qui sur',
  de: 'der die das und ich du nicht mein ein mit liebe ist wir auf dich mich herz nacht',
  it: 'il la che di non per sono ti amo mio cuore una amore della notte tu io',
  tr: 'ben sen bir ve bu ne aşk seni beni gibi yok için değil gece',
  nl: 'de het een en ik je niet van mijn liefde jij wij',
  sv: 'jag du och en det att inte min kärlek är',
  // Persian written in Latin letters ("Finglish"), very common in Iranian song titles
  fa: 'man to ma shoma oon in dige mikonam mikham mikhay mikhad khoob khob bi ba az ke del delam eshgh shab shaba ghalb bezar nist hast boro bia mese vaghti hame khastam gol gole sangam paeiz rooz roozi chi chera hala beri miram baram barat tanha tanhaei azizam joon jan khaste ashegh ghasedak dooset doostet daram nadaram zendegi donya cheshmat cheshmam bekhand gerye yadet yadam bargard mano toro maman baba khoda kheili sakhte nemitoonam nemikham ki kojaei bahar zemestoon barf baroon khaterat khatere asheghi delbar yar dokhtar pesar',
};
const WORDSETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

/** Best guess from text. Returns { code, conf } or null. Confident for non-Latin scripts, weak for Latin ones. */
export function detectFromText(...parts) {
  const s = parts.filter(Boolean).join(' ');
  if (!s.trim()) return null;
  const count = re => (s.match(re) || []).length;
  const arabic = count(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g);
  if (arabic > 1) {
    if (/[ٹڈڑںےۓ]/.test(s)) return { code: 'ur', conf: 0.8 };
    if (/[پچژگ]/.test(s) || /[یک]/.test(s)) return { code: 'fa', conf: 0.75 };
    return { code: 'ar', conf: 0.7 };
  }
  const scripts = [
    [/[֐-׿]/g, 'he'], [/[Ͱ-Ͽ]/g, 'el'], [/[぀-ヿ]/g, 'ja'], [/[가-힯ᄀ-ᇿ]/g, 'ko'],
    [/[一-鿿]/g, 'zh'], [/[฀-๿]/g, 'th'], [/[ऀ-ॿ]/g, 'hi'], [/[԰-֏]/g, 'hy'],
    [/[Ⴀ-ჿ]/g, 'ka'], [/[ঀ-৿]/g, 'bn'], [/[஀-௿]/g, 'ta'], [/[਀-੿]/g, 'pa'],
  ];
  for (const [re, code] of scripts) if (count(re) > 1) return { code, conf: 0.8 };
  if (count(/[Ѐ-ӿ]/g) > 1) return { code: /[іїєґІЇЄҐ]/.test(s) ? 'uk' : 'ru', conf: 0.75 };

  const lower = s.toLowerCase();
  const score = {};
  const add = (k, v) => { score[k] = (score[k] || 0) + v; };
  if (/[ğış]/.test(lower)) add('tr', 3);
  if (/[ñ¿¡]/.test(lower)) add('es', 3);
  if (/[ãõ]/.test(lower)) add('pt', 3);
  if (/ß/.test(lower)) add('de', 3);
  if (/[œçèêë]/.test(lower)) add('fr', 1.5);
  if (/[äöü]/.test(lower)) { add('de', 1); add('tr', 0.5); add('sv', 0.5); }
  const words = lower.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zğışç\s']/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
  for (const w of words) {
    for (const [k, set] of Object.entries(WORDSETS)) if (set.has(w)) add(k, 1);
    if (/(kh|gh|zh)[aeiou]/.test(w) && !/ght/.test(w)) add('fa', 0.6); // Finglish spellings like "khastam", "ghasedak"
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] >= 1) return { code: best[0], conf: Math.min(0.55, 0.25 + best[1] * 0.1) };
  if (/^[\x00-\x7F]*$/.test(s) && /[a-z]/i.test(s)) return { code: 'en', conf: 0.2 };
  return null;
}

// ---------- AI ----------

let worker = null;
let seq = 0;
const pending = new Map();
const progressFns = new Set();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./lang-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'progress') { progressFns.forEach(fn => fn(m.p)); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  };
  worker.onerror = e => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Language model failed to start'));
    pending.clear();
    worker = null;
  };
  return worker;
}

function call(msg, transfer) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...msg }, transfer || []);
  });
}

export const onModelProgress = fn => { progressFns.add(fn); return () => progressFns.delete(fn); };
export const loadModel = () => call({ type: 'load' });

/** Listens to up to five 30-second parts of the song. Returns { top, code, conf, noSpeech, noSpeechMin }. */
export async function detectFromAudio(blob) {
  const sr = 16000;
  const pcm = await decodeMono(blob, sr);
  const seg = 30 * sr;
  // Middle parts first (most likely to have vocals); the outer two are only used when the answer is unclear.
  const starts = pcm.length <= seg * 1.5 ? [0] : [0.5, 0.35, 0.65, 0.2, 0.8].map(f => Math.floor(pcm.length * f - seg / 2));
  const segments = starts.map(s => pcm.slice(Math.max(0, s), Math.max(0, s) + seg));
  return call({ type: 'detect', segments }, segments.map(x => x.buffer));
}
