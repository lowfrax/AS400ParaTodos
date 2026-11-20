// Emulador 5250 web: buffer de 24x80, campos de entrada, teclas AID, OIA, teclado y sonidos.
import * as snd from './sounds.js';

const ROWS = 24;
const COLS = 80;
const SIZE = ROWS * COLS;
const $ = (s) => document.querySelector(s);
const screenEl = $('#screen');
const cursorEl = $('#cursor');

const st = {
  cells: [],
  fields: [],
  fieldAt: new Int16Array(SIZE).fill(-1),
  cursor: 0,
  locked: true,
  err: null,
  ins: false,
  mw: false,
  connected: false,
  msg: null,
  sel: null,
  cw: 10,
  rh: 20,
  dev: '',
  sys: '',
};
let ws = null;
let manualDisconnect = false;
let ctrlAlone = null;

// ---------------- Conexión ----------------
function connect() {
  manualDisconnect = false;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  setConn('Connecting…', '');
  ws.onopen = () => {
    st.connected = true;
    setConn(`Connected to server/host ${location.hostname} using port ${location.port || (location.protocol === 'https:' ? 443 : 80)}`, 'ok');
    if (document.body.classList.contains('crt')) snd.powerOn();
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    st.connected = false;
    st.locked = true;
    setConn(manualDisconnect ? 'Disconnected' : 'Disconnected from server. Use Communication > Reconnect.', 'err');
    $('#oia-msg').textContent = 'COMMUNICATION CHECK';
    renderOia();
  };
}

function setConn(text, cls) {
  const c = $('#conn');
  c.textContent = text;
  c.className = cls;
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function onMessage(m) {
  if (m.t === 'screen') {
    applyScreen(m);
  } else if (m.t === 'mw') {
    st.mw = m.on;
    renderOia();
  } else if (m.t === 'lock') {
    st.locked = true;
    renderOia();
  } else if (m.t === 'notice') {
    notice(m.text);
  }
}

function notice(text) {
  const n = $('#notice');
  n.textContent = text;
  clearTimeout(notice.t);
  notice.t = setTimeout(() => { n.textContent = ''; }, 6000);
}

// ---------------- Modelo de pantalla ----------------
function applyScreen(m) {
  st.cells = Array.from({ length: SIZE }, () => ({ ch: ' ', a: 'g' }));
  for (const [r, c, s, a] of m.texts) {
    const pos = (r - 1) * COLS + (c - 1);
    for (let i = 0; i < s.length && pos + i < SIZE; i++) st.cells[pos + i] = { ch: s[i], a };
  }
  st.fields = m.fields.map((f) => {
    const val = (f.v || '').padEnd(f.l).slice(0, f.l).split('');
    return { n: f.n, start: (f.r - 1) * COLS + (f.c - 1), len: f.l, val, orig: val.join(''), a: f.a, num: f.num, nd: f.nd, lc: f.lc, pr: f.pr, mdt: false };
  });
  st.fieldAt.fill(-1);
  st.fields.forEach((f, i) => { for (let k = 0; k < f.len && f.start + k < SIZE; k++) st.fieldAt[f.start + k] = i; });
  if (m.msg) {
    const base = 23 * COLS;
    for (let i = 0; i < COLS; i++) st.cells[base + i] = { ch: ' ', a: 'w' };
    const t = ` ${m.msg}`.slice(0, COLS);
    for (let i = 0; i < t.length; i++) st.cells[base + i] = { ch: t[i], a: 'w' };
  }
  st.cursor = Math.max(0, Math.min(SIZE - 1, (m.cursor[0] - 1) * COLS + (m.cursor[1] - 1)));
  st.locked = !!m.lock;
  st.err = null;
  st.ins = false;
  st.sel = null;
  if (typeof m.mw === 'boolean') st.mw = m.mw;
  if (m.dev && m.dev !== st.dev) { st.dev = m.dev; }
  if (m.sys) st.sys = m.sys;
  $('#title').textContent = `${st.sys ? st.sys + ' - ' : ''}Session A - [24 x 80]${st.dev ? ' - ' + st.dev : ''}`;
  $('#oia-msg').textContent = '';
  if (m.alarm) snd.alarm();
  render();
}

// ---------------- Render ----------------
function cellView(pos) {
  const fi = st.fieldAt[pos];
  if (fi >= 0) {
    const f = st.fields[fi];
    const ch = f.nd || f.a.includes('n') ? ' ' : f.val[pos - f.start];
    return { ch, a: f.a };
  }
  const c = st.cells[pos] || { ch: ' ', a: 'g' };
  return { ch: c.a.includes('n') ? ' ' : c.ch, a: c.a };
}

function inSel(pos) {
  if (!st.sel) return false;
  const r = Math.floor(pos / COLS), c = pos % COLS;
  const r1 = Math.min(st.sel.r1, st.sel.r2), r2 = Math.max(st.sel.r1, st.sel.r2);
  const c1 = Math.min(st.sel.c1, st.sel.c2), c2 = Math.max(st.sel.c1, st.sel.c2);
  return r >= r1 && r <= r2 && c >= c1 && c <= c2;
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function render() {
  let html = '';
  for (let r = 0; r < ROWS; r++) {
    html += '<div class="row">';
    let runA = null, runSel = false, runText = '';
    const flush = () => {
      if (!runText) return;
      const a = runA || 'g';
      const cls = [`a-${a[0]}`];
      if (a.includes('u')) cls.push('u');
      if (a.includes('k')) cls.push('k');
      if (runSel) cls.push('sel');
      const rev = a.includes('v');
      if (rev) cls.push('v');
      html += `<span class="${cls.join(' ')}">${rev ? `<i>${esc(runText)}</i>` : esc(runText)}</span>`;
      runText = '';
    };
    for (let c = 0; c < COLS; c++) {
      const pos = r * COLS + c;
      const v = cellView(pos);
      const s = inSel(pos);
      if (v.a !== runA || s !== runSel) { flush(); runA = v.a; runSel = s; }
      runText += v.ch;
    }
    flush();
    html += '</div>';
  }
  screenEl.innerHTML = html;
  placeCursor();
  renderOia();
}

function placeCursor() {
  const r = Math.floor(st.cursor / COLS), c = st.cursor % COLS;
  const h = st.ins ? st.rh : Math.max(2, Math.round(st.rh * 0.14));
  cursorEl.style.left = `${c * st.cw}px`;
  cursorEl.style.top = `${r * st.rh + (st.rh - h)}px`;
  cursorEl.style.width = `${st.cw}px`;
  cursorEl.style.height = `${h}px`;
  cursorEl.className = st.ins ? 'ins' : '';
  $('#ruleH').style.cssText = `left:0;width:${COLS * st.cw}px;top:${(r + 1) * st.rh - 1}px;height:1px`;
  $('#ruleV').style.cssText = `top:0;height:${ROWS * st.rh}px;left:${c * st.cw}px;width:1px`;
  $('#oia-pos').textContent = `${String(r + 1).padStart(2, '0')}/${String(c + 1).padStart(3, '0')}`;
}

function renderOia() {
  const lock = $('#oia-lock');
  if (st.err) { lock.textContent = `X II  ${st.err}`; lock.className = 'err'; }
  else if (st.locked) { lock.textContent = 'X SYSTEM'; lock.className = ''; }
  else { lock.textContent = ''; lock.className = ''; }
  $('#oia-mw').textContent = st.mw ? 'MW' : '';
  $('#oia-ins').textContent = st.ins ? '^' : '';
}

// Ajusta el tamaño de letra para que 80x24 (+ OIA) quepa en el área disponible.
function layout() {
  const stage = $('#stage');
  const W = stage.clientWidth - 16;
  const H = stage.clientHeight - 16;
  const crt = document.body.classList.contains('crt');
  const probe = document.createElement('span');
  probe.style.cssText = `font-family:${getComputedStyle(screenEl).fontFamily};font-size:100px;position:absolute;visibility:hidden;white-space:pre`;
  probe.textContent = 'M'.repeat(80);
  document.body.appendChild(probe);
  const ratio = probe.getBoundingClientRect().width / 8000;
  probe.remove();
  const lh = crt ? 1.18 : 1.3;
  const extra = crt ? 28 : 0;
  const fs = Math.max(6, Math.min((W - extra) / (COLS * ratio), (H - extra) / ((ROWS + 1.3) * lh)));
  st.cw = fs * ratio;
  st.rh = Math.round(fs * lh * 100) / 100;
  screenEl.style.fontSize = `${fs}px`;
  screenEl.style.width = `${st.cw * COLS}px`;
  for (const el of [screenEl]) el.style.lineHeight = `${st.rh}px`;
  document.documentElement.style.setProperty('--rh', `${st.rh}px`);
  const style = document.getElementById('dyn') || Object.assign(document.createElement('style'), { id: 'dyn' });
  style.textContent = `#screen .row{height:${st.rh}px}#oia{font-size:${fs * 0.9}px;height:${st.rh * 1.2}px;width:${st.cw * COLS}px}`;
  document.head.appendChild(style);
  placeCursor();
}

// ---------------- Edición de campos ----------------
const fieldOf = (pos) => (st.fieldAt[pos] >= 0 ? st.fields[st.fieldAt[pos]] : null);
const inputFields = () => st.fields.filter((f) => !f.pr);

function nextField(pos, dir = 1) {
  const fs = inputFields().sort((a, b) => a.start - b.start);
  if (!fs.length) return pos;
  const cur = fieldOf(pos);
  if (dir > 0) {
    const n = fs.find((f) => f.start > pos && f !== cur);
    return (n || fs[0]).start;
  }
  const start = cur ? cur.start : pos;
  const prev = [...fs].reverse().find((f) => f.start < start);
  return (prev || fs[fs.length - 1]).start;
}

function setErr(code) {
  st.err = code;
  snd.keyError();
  renderOia();
}

function canType() {
  if (!st.connected || st.locked) return false;
  if (st.err) { snd.keyError(); return false; }
  return true;
}

function typeChar(ch, silent = false) {
  if (!canType()) return;
  const f = fieldOf(st.cursor);
  if (!f || f.pr) { if (!silent) setErr('0005'); return; }
  if (f.num && !/[0-9+\-., ]/.test(ch)) { if (!silent) setErr('0010'); return; }
  const c = f.lc ? ch : ch.toUpperCase();
  const off = st.cursor - f.start;
  if (st.ins) {
    if (f.val[f.len - 1] !== ' ') { if (!silent) setErr('0012'); return; }
    f.val.splice(off, 0, c);
    f.val.length = f.len;
  } else f.val[off] = c;
  f.mdt = true;
  if (!silent) snd.keyClick();
  if (off + 1 >= f.len) st.cursor = nextField(st.cursor);
  else st.cursor++;
  render();
}

function backspace() {
  if (!canType()) return;
  const f = fieldOf(st.cursor);
  if (!f || f.pr) { st.cursor = (st.cursor - 1 + SIZE) % SIZE; placeCursor(); return; }
  const off = st.cursor - f.start;
  if (off === 0) { snd.keyClick(); return; }
  f.val.splice(off - 1, 1);
  f.val.push(' ');
  f.mdt = true;
  st.cursor--;
  snd.keyClick();
  render();
}

function del() {
  if (!canType()) return;
  const f = fieldOf(st.cursor);
  if (!f || f.pr) { setErr('0005'); return; }
  f.val.splice(st.cursor - f.start, 1);
  f.val.push(' ');
  f.mdt = true;
  snd.keyClick();
  render();
}

function eraseEof() {
  if (!canType()) return;
  const f = fieldOf(st.cursor);
  if (!f || f.pr) { setErr('0005'); return; }
  for (let i = st.cursor - f.start; i < f.len; i++) f.val[i] = ' ';
  f.mdt = true;
  snd.keyClick();
  render();
}

function fieldExit(sign = '') {
  if (!canType()) return;
  const f = fieldOf(st.cursor);
  if (!f || f.pr) { setErr('0005'); return; }
  for (let i = st.cursor - f.start; i < f.len; i++) f.val[i] = ' ';
  if (f.num) {
    const t = f.val.join('').trim();
    const v = sign === '-' && t && !t.startsWith('-') ? `-${t}` : t;
    f.val = v.padStart(f.len).slice(-f.len).split('');
  }
  f.mdt = true;
  snd.keyClick();
  st.cursor = nextField(st.cursor);
  render();
}

function moveCursor(d) {
  if (!st.connected) return;
  st.cursor = (st.cursor + d + SIZE) % SIZE;
  st.sel = null;
  placeCursor();
}

function reset() {
  st.err = null;
  st.ins = false;
  renderOia();
  placeCursor();
}

function aid(key) {
  if (!st.connected) return;
  if (st.locked) return;
  if (st.err) { snd.keyError(); return; }
  const fields = {};
  const changed = [];
  for (const f of st.fields) {
    fields[f.n] = f.val.join('').replace(/\s+$/, '');
    if (f.mdt) changed.push(f.n);
  }
  send({ t: 'aid', aid: key, cursor: [Math.floor(st.cursor / COLS) + 1, (st.cursor % COLS) + 1], fields, changed });
  st.locked = true;
  st.ins = false;
  snd.keyClick();
  renderOia();
}

function sysreq() { if (st.connected) { st.err = null; send({ t: 'sysreq' }); snd.keyClick(); } }
function attn() { if (st.connected) { st.err = null; send({ t: 'attn' }); snd.keyClick(); } }

// ---------------- Teclado ----------------
function overlayOpen() { return !$('#overlay').hidden; }

document.addEventListener('keydown', (e) => {
  if (overlayOpen()) { if (e.key === 'Escape') closeDialog(); return; }
  closeMenus();
  snd.unlockAudio();
  const k = e.key;
  if (k === 'Control') { ctrlAlone = e.location; return; }
  ctrlAlone = null;
  if (/^F([1-9]|1[0-2])$/.test(k)) {
    e.preventDefault();
    const n = Number(k.slice(1)) + (e.shiftKey ? 12 : 0);
    aid(`F${n}`);
    return;
  }
  if (e.ctrlKey && !e.altKey) {
    const lk = k.toLowerCase();
    if (lk === 'c') { e.preventDefault(); copy(); return; }
    if (lk === 'v') { e.preventDefault(); paste(); return; }
    if (lk === 'a') { e.preventDefault(); st.sel = { r1: 0, c1: 0, r2: ROWS - 1, c2: COLS - 1 }; render(); return; }
    if (lk === 'p') { e.preventDefault(); printScreen(); return; }
    if (k === 'Enter') { e.preventDefault(); fieldExit(); return; }
    if (k === 'Escape') { e.preventDefault(); attn(); return; }
    if (k === 'End') { e.preventDefault(); eraseEof(); return; }
    return;
  }
  switch (k) {
    case 'Enter': e.preventDefault(); if (e.shiftKey) fieldExit(); else aid('ENTER'); return;
    case 'PageUp': e.preventDefault(); aid('PAGEUP'); return;
    case 'PageDown': e.preventDefault(); aid('PAGEDOWN'); return;
    case 'Escape': e.preventDefault(); if (e.shiftKey) sysreq(); else reset(); return;
    case 'Tab': e.preventDefault(); st.cursor = nextField(st.cursor, e.shiftKey ? -1 : 1); st.sel = null; placeCursor(); return;
    case 'ArrowLeft': e.preventDefault(); moveCursor(-1); return;
    case 'ArrowRight': e.preventDefault(); moveCursor(1); return;
    case 'ArrowUp': e.preventDefault(); moveCursor(-COLS); return;
    case 'ArrowDown': e.preventDefault(); moveCursor(COLS); return;
    case 'Home': e.preventDefault(); { const fs = inputFields().sort((a, b) => a.start - b.start); if (fs.length) st.cursor = fs[0].start; placeCursor(); } return;
    case 'End': {
      e.preventDefault();
      if (e.shiftKey) { eraseEof(); return; }
      const f = fieldOf(st.cursor);
      if (f) { const t = f.val.join('').replace(/\s+$/, '').length; st.cursor = f.start + Math.min(t, f.len - 1); placeCursor(); }
      return;
    }
    case 'Backspace': e.preventDefault(); backspace(); return;
    case 'Delete': e.preventDefault(); del(); return;
    case 'Insert': e.preventDefault(); if (canType()) { st.ins = !st.ins; placeCursor(); renderOia(); } return;
    case 'Pause': e.preventDefault(); aid('CLEAR'); return;
    default: break;
  }
  if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract') {
    const f = fieldOf(st.cursor);
    if (f && f.num) { e.preventDefault(); fieldExit(e.code === 'NumpadSubtract' ? '-' : '+'); return; }
  }
  if (k.length === 1 && !e.metaKey && !e.altKey) { e.preventDefault(); typeChar(k); }
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'Control' && ctrlAlone !== null) {
    // Distribución de teclado de ACS: Ctrl derecho = Intro, Ctrl izquierdo = Restablecer.
    if (ctrlAlone === 2) aid('ENTER'); else if (ctrlAlone === 1) reset();
  }
  ctrlAlone = null;
});

// Teclado virtual en móviles
const kbd = $('#kbd');
kbd.addEventListener('input', () => {
  for (const ch of kbd.value) typeChar(ch);
  kbd.value = '';
});

// ---------------- Ratón: cursor y selección ----------------
function cellFromEvent(e) {
  const rect = screenEl.getBoundingClientRect();
  const c = Math.max(0, Math.min(COLS - 1, Math.floor((e.clientX - rect.left) / st.cw)));
  const r = Math.max(0, Math.min(ROWS - 1, Math.floor((e.clientY - rect.top) / st.rh)));
  return { r, c };
}
let dragging = null;
screenEl.addEventListener('mousedown', (e) => {
  snd.unlockAudio();
  closeMenus();
  const p = cellFromEvent(e);
  dragging = { r1: p.r, c1: p.c, r2: p.r, c2: p.c, moved: false };
});
window.addEventListener('mousemove', (e) => {
  if (!dragging || !(e.buttons & 1)) return;
  const p = cellFromEvent(e);
  if (p.r !== dragging.r2 || p.c !== dragging.c2) {
    dragging.r2 = p.r; dragging.c2 = p.c; dragging.moved = true;
    st.sel = { ...dragging };
    render();
  }
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  if (!dragging.moved) {
    st.sel = null;
    st.cursor = dragging.r1 * COLS + dragging.c1;
    render();
    if (matchMedia('(pointer: coarse)').matches) kbd.focus();
  }
  dragging = null;
});
screenEl.addEventListener('dblclick', (e) => {
  // Doble clic en una línea con opciones: igual que en ACS, solo coloca el cursor.
  const p = cellFromEvent(e);
  st.cursor = p.r * COLS + p.c;
  placeCursor();
});

function screenText(sel) {
  const lines = [];
  for (let r = 0; r < ROWS; r++) {
    let l = '';
    for (let c = 0; c < COLS; c++) {
      const pos = r * COLS + c;
      if (sel && !inSel(pos)) continue;
      l += cellView(pos).ch;
    }
    if (!sel || l.length) lines.push(l.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

async function copy() {
  const text = screenText(!!st.sel);
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
  notice(st.sel ? 'Selection copied to clipboard.' : 'Screen copied to clipboard.');
}

async function paste() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { notice('Clipboard not available. Use Ctrl+V on the keyboard.'); return; }
  for (const ch of text.replace(/\r/g, '')) {
    if (ch === '\n') { st.cursor = nextField(st.cursor); continue; }
    typeChar(ch, true);
    if (st.err) break;
  }
  render();
}

function printScreen() { send({ t: 'print' }); notice('Print Screen requested (QSYSPRT).'); }

function saveText() {
  const blob = new Blob([screenText(false)], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${st.dev || 'screen'}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------- Menús, barra de herramientas y teclado en pantalla ----------------
function closeMenus() { document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
document.querySelectorAll('.menu > span').forEach((s) => {
  s.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = s.parentElement;
    const was = m.classList.contains('open');
    closeMenus();
    if (!was) m.classList.add('open');
  });
  s.addEventListener('mouseenter', () => {
    if (document.querySelector('.menu.open') && !s.parentElement.classList.contains('open')) { closeMenus(); s.parentElement.classList.add('open'); }
  });
});
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

function setTheme(t) {
  document.body.classList.toggle('crt', t === 'crt');
  try { localStorage.setItem('as400.theme', t); } catch { /* sin almacenamiento */ }
  syncChecks();
  requestAnimationFrame(() => { layout(); render(); });
}

function syncChecks() {
  const crt = document.body.classList.contains('crt');
  for (const b of document.querySelectorAll('[data-act="theme-acs"]')) b.classList.toggle('on', !crt);
  for (const b of document.querySelectorAll('[data-act="theme-crt"]')) b.classList.toggle('on', crt);
  for (const b of document.querySelectorAll('.drop [data-act="click"]')) b.classList.toggle('on', snd.getSound('click'));
  for (const b of document.querySelectorAll('.drop [data-act="alarm"]')) b.classList.toggle('on', snd.getSound('alarm'));
  for (const b of document.querySelectorAll('.drop [data-act="rule"]')) b.classList.toggle('on', document.body.classList.contains('rule'));
  for (const b of document.querySelectorAll('[data-act="keypad"]')) b.classList.toggle('on', !$('#keypad').hidden);
  $('#toolbar [data-act="click"]').classList.toggle('on', snd.getSound('click'));
}

const ACTIONS = {
  print: printScreen,
  savetext: saveText,
  newsession: () => window.open(location.href, '_blank'),
  dashboard: () => window.open('/dashboard/', '_blank'),
  copy, paste,
  selectall: () => { st.sel = { r1: 0, c1: 0, r2: ROWS - 1, c2: COLS - 1 }; render(); },
  keypad: () => { $('#keypad').hidden = !$('#keypad').hidden; syncChecks(); requestAnimationFrame(layout); },
  'theme-acs': () => setTheme('acs'),
  'theme-crt': () => setTheme('crt'),
  theme: () => setTheme(document.body.classList.contains('crt') ? 'acs' : 'crt'),
  rule: () => { document.body.classList.toggle('rule'); syncChecks(); },
  click: () => { snd.setSound('click', !snd.getSound('click')); syncChecks(); },
  alarm: () => { snd.setSound('alarm', !snd.getSound('alarm')); syncChecks(); },
  disconnect: () => { manualDisconnect = true; if (ws) ws.close(); },
  reconnect: () => { if (!st.connected) connect(); },
  reset, sysreq, attn,
  fieldexit: () => fieldExit(),
  erase: eraseEof,
  keymap: showKeymap,
  about: showAbout,
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act],[data-aid]');
  if (!b) return;
  snd.unlockAudio();
  closeMenus();
  if (b.dataset.aid) aid(b.dataset.aid);
  else if (ACTIONS[b.dataset.act]) ACTIONS[b.dataset.act]();
  screenEl.focus();
});

function buildKeypad() {
  const kp = $('#keypad');
  const keys = [];
  for (let i = 1; i <= 24; i++) keys.push([`F${i}`, `F${i}`]);
  const extra = [['Enter', 'ENTER', 'wide'], ['PgUp', 'PAGEUP'], ['PgDn', 'PAGEDOWN'], ['Reset', null, '', 'reset'], ['SysReq', null, '', 'sysreq'],
    ['Attn', null, '', 'attn'], ['FldExit', null, '', 'fieldexit'], ['ErEOF', null, '', 'erase'], ['Clear', 'CLEAR'], ['Print', null, '', 'print'], ['Help', 'F1']];
  kp.innerHTML = keys.map(([t, a]) => `<button data-aid="${a}">${t}</button>`).join('') +
    extra.map(([t, a, cls, act]) => `<button class="${cls || ''}" ${a ? `data-aid="${a}"` : `data-act="${act}"`}>${t}</button>`).join('');
}

// ---------------- Diálogos ----------------
function dialog(title, html) {
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = html;
  $('#overlay').hidden = false;
}
function closeDialog() { $('#overlay').hidden = true; screenEl.focus(); }
$('#dlg-close').onclick = closeDialog;
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeDialog(); });

function showKeymap() {
  const rows = [
    ['Intro / Enter', '<kbd>Enter</kbd>, <kbd>Ctrl</kbd> derecho'],
    ['F1–F12', '<kbd>F1</kbd>…<kbd>F12</kbd>'],
    ['F13–F24', '<kbd>Shift</kbd> + <kbd>F1</kbd>…<kbd>F12</kbd>'],
    ['Roll Up / Roll Down', '<kbd>AvPág</kbd> / <kbd>RePág</kbd>'],
    ['Reset (desbloquear X II)', '<kbd>Esc</kbd>, <kbd>Ctrl</kbd> izquierdo'],
    ['System Request', '<kbd>Shift</kbd> + <kbd>Esc</kbd> (opción 2 = terminar petición)'],
    ['Attention', '<kbd>Ctrl</kbd> + <kbd>Esc</kbd>'],
    ['Field Exit', '<kbd>Ctrl</kbd> + <kbd>Enter</kbd> o <kbd>Shift</kbd> + <kbd>Enter</kbd>'],
    ['Field+ / Field− (numéricos)', '<kbd>+</kbd> / <kbd>−</kbd> del teclado numérico'],
    ['Erase EOF', '<kbd>Shift</kbd> + <kbd>Fin</kbd>'],
    ['Campo siguiente / anterior', '<kbd>Tab</kbd> / <kbd>Shift</kbd> + <kbd>Tab</kbd>'],
    ['Primer campo de entrada', '<kbd>Inicio</kbd>'],
    ['Modo inserción', '<kbd>Insert</kbd> (OIA muestra ^)'],
    ['Imprimir pantalla (spool QSYSPRT)', '<kbd>Ctrl</kbd> + <kbd>P</kbd>'],
    ['Copiar / Pegar', '<kbd>Ctrl</kbd> + <kbd>C</kbd> / <kbd>Ctrl</kbd> + <kbd>V</kbd> (arrastre para seleccionar)'],
    ['Clear', '<kbd>Pausa</kbd>'],
  ];
  dialog('Keyboard Map — 5250', `<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
  <p>Errores del operador en el OIA: <code>X II 0005</code> cursor en área protegida, <code>0010</code> solo numérico, <code>0012</code> sin espacio para insertar. Pulse <kbd>Esc</kbd> para restablecer.</p>`);
}

function showAbout() {
  dialog('About', `<p><b>AS400 para Todos</b> — emulador 5250 web para un clon educativo de IBM i.</p>
  <p>Inicie sesión con <code>DEMO</code>/<code>DEMO</code> o <code>QSECOFR</code>/<code>QSECOFR</code>. Pruebe <code>CALL HELLO</code>, <code>CALL CUSTINQ</code>, <code>CALL CUSTSFL</code>, <code>STRPDM</code>, <code>STRSQL</code>, <code>WRKACTJOB</code>.</p>
  <p>IBM, IBM i, AS/400 y 5250 son marcas de IBM Corp. Este proyecto no está afiliado a IBM.</p>`);
}

// ---------------- Inicio ----------------
let initialTheme = 'acs';
try { initialTheme = localStorage.getItem('as400.theme') || 'acs'; } catch { /* sin almacenamiento */ }
document.body.classList.toggle('crt', initialTheme === 'crt');
buildKeypad();
syncChecks();
st.cells = Array.from({ length: SIZE }, () => ({ ch: ' ', a: 'g' }));
document.fonts.ready.then(() => { layout(); render(); });
window.addEventListener('resize', () => { layout(); });
new ResizeObserver(() => layout()).observe($('#stage'));
layout();
render();
connect();
screenEl.focus();
