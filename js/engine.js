// Playback engine. Two <audio> "decks" so one song can fade into the next.
// Safe mode: plain media elements (most reliable for background playback on iPhone).
// Enhanced mode: elements are routed through Web Audio for EQ, karaoke, effects, leveling and real crossfades.
// iPhone mutes Web Audio while the app isn't on screen (the element keeps "playing", silently), so there
// playback moves to a spare pair of plain decks while the app is hidden and comes back when it's visible.

export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const listeners = {};
export const on = (type, fn) => (listeners[type] ||= []).push(fn);
const emit = (type, detail) => (listeners[type] || []).forEach(fn => fn(detail));

let decks = [];
let parked = []; // the other pair: plain spares while enhanced audio is live, the routed pair while it's bypassed
let bypass = false;
let active = 0;
let ctx = null;
let wantEnhanced = false;
let graph = null;
let xfade = null; // running crossfade { from, to, timer }
let rate = 1;
let eqGains = new Array(10).fill(0);
let karaoke = false;
let effect = 'none';
let fading = null;

const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const SILENT = (() => {
  const n = 800;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();

const FORWARD = ['play', 'pause', 'timeupdate', 'ended', 'loadedmetadata', 'error', 'seeked'];

function makeDeck() {
  const el = document.createElement('audio');
  el.preload = 'auto';
  el.setAttribute('playsinline', '');
  el.setAttribute('x-webkit-airplay', 'allow'); // lets iPhone offer AirPlay/Bluetooth outputs for this element
  el.preservesPitch = el.webkitPreservesPitch = el.mozPreservesPitch = true;
  document.body.appendChild(el);
  const deck = { el, url: null, src: null, gain: null, level: 1, unlocked: false };
  for (const type of FORWARD) {
    el.addEventListener(type, () => {
      if (el.src === SILENT || !el.src || deck.priming) return;
      if (decks[active] !== deck) return; // ignore the outgoing deck during a crossfade
      if (type === 'pause' && xfade) return;
      emit(type);
    });
  }
  return deck;
}

export function init() {
  decks.push(makeDeck(), makeDeck());
  const away = () => { if (IOS && graph && !bypass) swapPairs(); };
  document.addEventListener('visibilitychange', () => (document.hidden ? away() : comeBack()));
  window.addEventListener('pagehide', away);
}

const cur = () => decks[active];
const routed = () => !!graph && !bypass;
export const el = () => cur().el;
export const isEnhanced = routed;
export const enhancedWanted = () => wantEnhanced;
export const hasSource = () => !!cur().url;

/** Must be called synchronously inside a user tap: unlocks both decks (iOS) and builds the audio graph if wanted. */
export function prime() {
  if (wantEnhanced && !graph) buildGraph();
  for (const d of [...decks, ...parked]) {
    if (d.unlocked) continue;
    d.unlocked = true;
    if (!d.url) {
      d.el.src = SILENT;
      d.el.play().then(() => { if (d.el.src === SILENT) d.el.pause(); }, () => { d.unlocked = false; });
    } else if (d.el.paused) {
      // A song is already loaded (e.g. restored after reopening): a muted play/pause unlocks it silently.
      d.priming = true;
      d.el.muted = true;
      d.el.play().then(() => { if (d.priming) d.el.pause(); }, () => { d.unlocked = false; })
        .finally(() => setTimeout(() => { d.el.muted = false; d.priming = false; }, 0));
    }
  }
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  comeBack();
}

/** Moves the current song (position, play state, level) onto the other pair of decks. */
function swapPairs() {
  finishXfade();
  const from = cur();
  const playing = !from.el.paused && !from.priming;
  [decks, parked] = [parked, decks];
  bypass = !bypass;
  const to = cur();
  if (to.url) URL.revokeObjectURL(to.url);
  to.url = from.url;
  from.url = null;
  to.level = from.level;
  to.el.playbackRate = rate;
  if (to.url) {
    const t = from.el.currentTime;
    to.el.src = to.url;
    to.el.addEventListener('loadedmetadata', () => { to.el.currentTime = t; }, { once: true });
  }
  if (routed()) {
    to.gain.gain.cancelScheduledValues(ctx.currentTime);
    to.gain.gain.value = to.level;
    decks[1 - active].gain.gain.value = 0;
  } else {
    to.el.volume = Math.min(1, to.level);
  }
  if (playing) playEl(to);
  from.el.pause(); // ignored by the event forwarding: this deck is parked now
  if (bypass) ctx.suspend().catch(() => {});
}

/** Back on screen: return to the enhanced decks once the audio engine is running again. */
function comeBack() {
  if (!bypass || document.hidden) return;
  ctx.resume().then(() => { if (bypass && !document.hidden && ctx.state === 'running') swapPairs(); }, () => {});
}

// ---------- graph ----------

function impulse(seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function buildGraph() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    ctx = new Ctx({ latencyHint: 'playback' });
  } catch {
    ctx = new Ctx();
  }
  const g = {};
  g.mix = ctx.createGain();

  // Karaoke: dry path, or (L − R) "side" signal (removes centred vocals) plus the bass, which is also centred.
  g.kOut = ctx.createGain();
  g.kDry = ctx.createGain();
  g.mix.connect(g.kDry).connect(g.kOut);
  const split = ctx.createChannelSplitter(2);
  const gl = ctx.createGain();
  const gr = ctx.createGain();
  gr.gain.value = -1;
  g.kSide = ctx.createGain();
  g.mix.connect(split);
  split.connect(gl, 0);
  split.connect(gr, 1);
  gl.connect(g.kSide);
  gr.connect(g.kSide);
  g.kSide.connect(g.kOut);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 160;
  g.kBass = ctx.createGain();
  g.mix.connect(lp).connect(g.kBass).connect(g.kOut);

  // 10-band equalizer
  g.eq = EQ_FREQS.map((f, i) => {
    const b = ctx.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
    b.frequency.value = f;
    b.Q.value = 1.3;
    return b;
  });
  g.eq.reduce((prev, b) => (prev.connect(b), b), g.kOut);

  // Effects
  g.fxIn = g.eq[9];
  g.fxOut = ctx.createGain();
  g.panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  g.lfo = ctx.createOscillator();
  g.lfo.frequency.value = 0.11;
  g.lfoDepth = ctx.createGain();
  g.lfoDepth.gain.value = 0.85;
  g.lfo.connect(g.lfoDepth);
  if (g.panner) g.lfoDepth.connect(g.panner.pan);
  g.lfo.start();
  g.conv = ctx.createConvolver();
  g.conv.buffer = impulse(2.8, 3);
  g.wet = ctx.createGain();
  g.dry = ctx.createGain();
  g.night = ctx.createDynamicsCompressor();
  g.night.threshold.value = -34;
  g.night.knee.value = 12;
  g.night.ratio.value = 5;
  g.night.attack.value = 0.01;
  g.night.release.value = 0.35;
  g.makeup = ctx.createGain();
  g.makeup.gain.value = 1.9;

  // Safety limiter so EQ/leveling boosts never clip
  g.limiter = ctx.createDynamicsCompressor();
  g.limiter.threshold.value = -1.5;
  g.limiter.knee.value = 0;
  g.limiter.ratio.value = 20;
  g.limiter.attack.value = 0.003;
  g.limiter.release.value = 0.12;
  g.master = ctx.createGain();
  g.fxOut.connect(g.limiter).connect(g.master).connect(ctx.destination);

  parked = [makeDeck(), makeDeck()];
  for (const d of decks) {
    d.src = ctx.createMediaElementSource(d.el);
    d.gain = ctx.createGain();
    d.gain.gain.value = d === cur() ? d.level : 0;
    d.src.connect(d.gain).connect(g.mix);
    d.el.volume = 1;
  }
  graph = g;
  applyKaraoke();
  applyEQ();
  applyEffect();
  ctx.addEventListener?.('statechange', () => {
    if (!graph) return;
    if (IOS && document.hidden && !bypass && ctx.state !== 'running') swapPairs();
    emit('ctxstate', ctx.state);
  });
}

function applyKaraoke() {
  if (!graph) return;
  const t = ctx.currentTime;
  graph.kDry.gain.setTargetAtTime(karaoke ? 0 : 1, t, 0.05);
  graph.kSide.gain.setTargetAtTime(karaoke ? 1 : 0, t, 0.05);
  graph.kBass.gain.setTargetAtTime(karaoke ? 1 : 0, t, 0.05);
}

function applyEQ() {
  if (!graph) return;
  graph.eq.forEach((b, i) => b.gain.setTargetAtTime(eqGains[i] || 0, ctx.currentTime, 0.04));
}

function applyEffect() {
  if (!graph) return;
  const g = graph;
  for (const n of [g.fxIn, g.panner, g.conv, g.wet, g.dry, g.night, g.makeup]) { try { n && n.disconnect(); } catch {} }
  if (effect === '8d' && g.panner) {
    g.fxIn.connect(g.panner).connect(g.fxOut);
  } else if (effect === 'hall') {
    g.dry.gain.value = 0.85;
    g.wet.gain.value = 0.42;
    g.fxIn.connect(g.dry).connect(g.fxOut);
    g.fxIn.connect(g.conv).connect(g.wet).connect(g.fxOut);
  } else if (effect === 'night') {
    g.fxIn.connect(g.night).connect(g.makeup).connect(g.fxOut);
  } else {
    g.fxIn.connect(g.fxOut);
  }
}

export function setEQ(gains) { eqGains = gains.slice(); applyEQ(); }
export function setKaraoke(on) { karaoke = on; applyKaraoke(); }
export function setEffect(name) { effect = name; applyEffect(); }

export function setRate(r) {
  rate = r;
  for (const d of [...decks, ...parked]) d.el.playbackRate = r;
}

/** Per-track loudness gain (linear). Only audible in enhanced mode; desktop browsers also honour el.volume. */
export function setLevel(lin) {
  const d = cur();
  d.level = lin;
  if (routed() && !xfade) d.gain.gain.setTargetAtTime(lin, ctx.currentTime, 0.08);
  else if (!routed()) d.el.volume = Math.min(1, lin);
}

/**
 * Switches between safe and enhanced mode. Turning enhanced on takes effect at the next tap (prime()).
 * Turning it off moves to the plain spare decks, because an element can't leave an AudioContext once routed.
 */
export function setEnhanced(on) {
  wantEnhanced = on;
  if (on || !graph) return;
  if (!bypass) swapPairs();
  for (const d of parked) { d.el.pause(); d.el.remove(); if (d.url) URL.revokeObjectURL(d.url); }
  parked = [];
  bypass = false;
  try { ctx.close(); } catch {}
  ctx = null;
  graph = null;
}

// ---------- transport ----------

function loadInto(d, blob, startAt) {
  if (d.url) URL.revokeObjectURL(d.url);
  d.url = URL.createObjectURL(blob);
  d.el.src = d.url;
  d.el.playbackRate = rate;
  if (startAt > 0) d.el.addEventListener('loadedmetadata', () => { d.el.currentTime = startAt; }, { once: true });
}

export function load(blob, { startAt = 0, level = 1, play = true } = {}) {
  finishXfade();
  const d = cur();
  loadInto(d, blob, startAt);
  d.level = level;
  if (routed()) { d.gain.gain.cancelScheduledValues(ctx.currentTime); d.gain.gain.value = level; }
  else d.el.volume = Math.min(1, level);
  if (play) return playEl(d);
}

function playEl(d) {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  if (d.priming) {
    d.priming = false;
    d.el.muted = false;
    if (!d.el.paused) { setTimeout(() => emit('play'), 0); return Promise.resolve(); }
  }
  return d.el.play().catch(e => { emit('blocked', e); });
}

export function play() { return playEl(cur()); }

export function pause() {
  finishXfade();
  cur().el.pause();
}

export const paused = () => cur().el.paused || !!cur().priming;
export const time = () => cur().el.currentTime || 0;
export const duration = () => { const d = cur().el.duration; return isFinite(d) ? d : 0; };
export function seek(t) { cur().el.currentTime = Math.max(0, t); }
export const isFading = () => !!xfade;

/**
 * Starts the next song on the other deck and fades between them (equal-power curve).
 * In safe mode, or with seconds <= 0, it simply switches.
 */
export function crossfadeTo(blob, { startAt = 0, level = 1, seconds = 6 } = {}) {
  finishXfade();
  const from = cur();
  const to = decks[1 - active];
  loadInto(to, blob, startAt);
  to.level = level;
  if (!routed() || seconds <= 0.2) {
    active = 1 - active; // switch first so the old deck's pause event is ignored
    from.el.pause();
    if (!routed()) to.el.volume = Math.min(1, level);
    else { to.gain.gain.cancelScheduledValues(ctx.currentTime); to.gain.gain.value = level; from.gain.gain.value = 0; }
    playEl(to);
    emit('switched');
    return;
  }
  const now = ctx.currentTime;
  const steps = 64;
  const outC = new Float32Array(steps);
  const inC = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const x = i / (steps - 1);
    outC[i] = Math.cos((x * Math.PI) / 2) * from.level;
    inC[i] = Math.sin((x * Math.PI) / 2) * level;
  }
  from.gain.gain.cancelScheduledValues(now);
  to.gain.gain.cancelScheduledValues(now);
  to.gain.gain.value = 0;
  from.gain.gain.setValueCurveAtTime(outC, now, seconds);
  to.gain.gain.setValueCurveAtTime(inC, now, seconds);
  active = 1 - active;
  // If iOS refuses to play two elements at once, the old one pauses itself; then just finish the switch.
  const onOldPause = () => finishXfade();
  from.el.addEventListener('pause', onOldPause, { once: true });
  xfade = { from, to, onOldPause, timer: setTimeout(finishXfade, seconds * 1000 + 100) };
  playEl(to);
  emit('switched');
}

function finishXfade() {
  if (!xfade) return;
  const { from, to, onOldPause, timer } = xfade;
  xfade = null;
  clearTimeout(timer);
  from.el.removeEventListener('pause', onOldPause);
  from.el.pause();
  if (routed()) {
    const now = ctx.currentTime;
    from.gain.gain.cancelScheduledValues(now);
    to.gain.gain.cancelScheduledValues(now);
    from.gain.gain.value = 0;
    to.gain.gain.value = to.level;
  }
}

/** Gently fades out over `seconds`, pauses, then restores the volume (sleep timer). */
export function fadeOutAndPause(seconds) {
  return new Promise(resolve => {
    clearInterval(fading);
    const d = cur();
    if (routed()) {
      const now = ctx.currentTime;
      graph.master.gain.cancelScheduledValues(now);
      graph.master.gain.setValueAtTime(graph.master.gain.value, now);
      graph.master.gain.linearRampToValueAtTime(0.0001, now + seconds);
      setTimeout(() => {
        pause();
        graph.master.gain.cancelScheduledValues(ctx.currentTime);
        graph.master.gain.value = 1;
        resolve();
      }, seconds * 1000);
      return;
    }
    const start = d.el.volume;
    const t0 = Date.now();
    fading = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / (seconds * 1000));
      d.el.volume = Math.max(0, start * (1 - k)); // ignored by iOS, works elsewhere
      if (k >= 1) {
        clearInterval(fading);
        pause();
        d.el.volume = start;
        resolve();
      }
    }, 200);
  });
}

/**
 * Lets the listener choose where the sound plays (Bluetooth headphones/speakers, AirPlay, built-in speaker).
 * iPhone/Safari: the system output picker. Chrome/Edge/Firefox: the browser's speaker chooser.
 * Returns 'picker' when a picker was shown, 'chosen' when an output was switched, or 'unsupported'.
 */
export async function chooseOutput() {
  const e = cur().el;
  if (typeof e.webkitShowPlaybackTargetPicker === 'function') {
    e.webkitShowPlaybackTargetPicker();
    return 'picker';
  }
  if (navigator.mediaDevices?.selectAudioOutput) {
    const dev = await navigator.mediaDevices.selectAudioOutput();
    for (const d of [...decks, ...parked]) await d.el.setSinkId?.(dev.deviceId);
    if (ctx?.setSinkId) await ctx.setSinkId(dev.deviceId).catch(() => {});
    return 'chosen';
  }
  return 'unsupported';
}

export function stop() {
  finishXfade();
  for (const d of [...decks, ...parked]) {
    d.el.pause();
    d.el.removeAttribute('src');
    if (d.url) URL.revokeObjectURL(d.url);
    d.url = null;
  }
}
