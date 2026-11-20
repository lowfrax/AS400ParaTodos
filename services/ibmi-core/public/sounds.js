// Sonidos del terminal: clic de teclado (tipo IBM Model M), alarma 5250 y error de teclado.
// Si existen /sounds/keyclick.wav, /sounds/alarm.wav o /sounds/error.wav se usan en lugar de la síntesis.
let ac = null;
const samples = {};
const settings = {
  click: localGet('as400.click', '1') === '1',
  alarm: localGet('as400.alarm', '1') === '1',
};

function localGet(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* modo privado */ } }

function ctx() {
  if (!ac) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ac = new C();
    loadSamples();
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

async function loadSamples() {
  for (const name of ['keyclick', 'alarm', 'error']) {
    try {
      const r = await fetch(`/sounds/${name}.wav`);
      if (!r.ok) continue;
      samples[name] = await ac.decodeAudioData(await r.arrayBuffer());
    } catch { /* sin muestra: se sintetiza */ }
  }
}

function playSample(name, gain = 0.6) {
  const a = ctx();
  if (!a || !samples[name]) return false;
  const src = a.createBufferSource();
  const g = a.createGain();
  g.gain.value = gain;
  src.buffer = samples[name];
  src.connect(g).connect(a.destination);
  src.start();
  return true;
}

let noiseBuf = null;
function noise(a) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = a.createBuffer(1, a.sampleRate * 0.05, a.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

// Clic de muelle flexible: chasquido agudo + golpe grave de la tecla al tocar fondo.
export function keyClick() {
  if (!settings.click) return;
  if (playSample('keyclick', 0.5)) return;
  const a = ctx();
  if (!a) return;
  const t = a.currentTime;
  const src = a.createBufferSource();
  src.buffer = noise(a);
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2800 + Math.random() * 600;
  bp.Q.value = 1.4;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.55, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.022);
  src.connect(bp).connect(g).connect(a.destination);
  src.start(t);
  src.stop(t + 0.05);
  const o = a.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(190, t + 0.012);
  o.frequency.exponentialRampToValueAtTime(90, t + 0.06);
  const g2 = a.createGain();
  g2.gain.setValueAtTime(0.0001, t + 0.01);
  g2.gain.exponentialRampToValueAtTime(0.25, t + 0.014);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  o.connect(g2).connect(a.destination);
  o.start(t + 0.01);
  o.stop(t + 0.08);
}

// Alarma del 5250 (orden ALARM del flujo de datos / mensajes de error).
export function alarm() {
  if (!settings.alarm) return;
  if (playSample('alarm', 0.6)) return;
  const a = ctx();
  if (!a) return;
  const t = a.currentTime;
  const o = a.createOscillator();
  o.type = 'square';
  o.frequency.value = 1046;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 3000;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.18, t + 0.008);
  g.gain.setValueAtTime(0.18, t + 0.16);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  o.connect(f).connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + 0.22);
}

// Error de operador (teclado inhibido: X II).
export function keyError() {
  if (!settings.alarm) return;
  if (playSample('error', 0.6)) return;
  const a = ctx();
  if (!a) return;
  const t = a.currentTime;
  for (const [freq, start] of [[392, 0], [392, 0.11]]) {
    const o = a.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t + start);
    g.gain.exponentialRampToValueAtTime(0.12, t + start + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.09);
    o.connect(g).connect(a.destination);
    o.start(t + start);
    o.stop(t + start + 0.1);
  }
}

// Encendido del monitor CRT (desmagnetización) en el modo clásico.
export function powerOn() {
  const a = ctx();
  if (!a || !settings.alarm) return;
  const t = a.currentTime;
  const o = a.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(60, t);
  const lp = a.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 400;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  o.connect(lp).connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + 1);
  const src = a.createBufferSource();
  src.buffer = noise(a);
  src.loop = true;
  const hp = a.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 6000;
  const g2 = a.createGain();
  g2.gain.setValueAtTime(0.0001, t);
  g2.gain.exponentialRampToValueAtTime(0.05, t + 0.05);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  src.connect(hp).connect(g2).connect(a.destination);
  src.start(t);
  src.stop(t + 0.7);
}

export function unlockAudio() { ctx(); }
export function getSound(k) { return settings[k]; }
export function setSound(k, v) { settings[k] = v; localSet(`as400.${k}`, v ? '1' : '0'); }
