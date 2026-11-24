// Sesión de terminal 5250 (un dispositivo QPADEVxxxx) y su trabajo interactivo.
import { Panel } from './panel.js';
import { SYS, setStatus, sysDate, sysTime } from './system.js';
import { msgText, msgHelp } from './messages.js';
import { RpgCancel } from '../../../shared/rpg/interpreter.js';

export class Disconnected extends Error { constructor() { super('Device disconnected'); this.disconnected = true; } }
export class SignOff extends Error { constructor() { super('Sign off'); this.signoff = true; } }

const devices = new Set();
export const sessions = new Set();

function allocDevice() {
  for (let i = 1; i < 10000; i++) {
    const n = `QPADEV${String(i).padStart(4, '0')}`;
    if (!devices.has(n)) { devices.add(n); return n; }
  }
  return 'QPADEV9999';
}

export class Session {
  constructor(ws, remote, opts = {}) {
    this.ws = ws;
    this.remote = remote;
    this.kind = opts.kind || 'web';
    this.termType = opts.termType || 'WEB-5250';
    this.secure = !!opts.tls;
    const want = opts.device && /^[A-Z#@$][A-Z0-9_#@$]{0,9}$/.test(opts.device) && !devices.has(opts.device) ? opts.device : null;
    if (want) devices.add(want);
    this.device = want || allocDevice();
    this.job = null;
    this.user = null;
    this.libl = [];
    this.curlib = null;
    this.history = [];
    this.pending = null;
    this.sysreqPending = null;
    this.screen = null;
    this.mw = false;
    this.connectedAt = Date.now();
    this.screens = 0;
    this.closed = false;
    sessions.add(this);
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.close());
    ws.on('error', () => this.close());
  }

  get usrlibl() { return this.libl; }

  send(obj) {
    if (this.closed) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { /* conexión cerrada */ }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    devices.delete(this.device);
    sessions.delete(this);
    if (this.pending) { const p = this.pending; this.pending = null; p.reject(new Disconnected()); }
    if (this.sysreqPending) { const p = this.sysreqPending; this.sysreqPending = null; p.reject(new Disconnected()); }
  }

  onMessage(data) {
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m.t === 'aid') {
      if (this.sysreqPending) { const p = this.sysreqPending; this.sysreqPending = null; p.resolve(m); return; }
      if (this.pending) { const p = this.pending; this.pending = null; p.resolve(m); }
      return;
    }
    if (m.t === 'sysreq' || m.t === 'attn') this.systemRequest().catch(() => {});
    if (m.t === 'print') this.printScreen().catch(() => {});
  }

  waitAid() {
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  setMessageWaiting(on) {
    if (this.mw === on) return;
    this.mw = on;
    this.send({ t: 'mw', on });
  }

  // Muestra un panel y espera la respuesta (tecla AID + campos).
  async display(panel) {
    for (;;) {
      if (this.closed) throw new Disconnected();
      this.screen = panel;
      this.screens++;
      if (this.job) setStatus(this.job, 'DSPW', panel.fn || undefined);
      const shownMsg = panel.message;
      this.send({ ...panel.toJSON(), mw: this.mw, dev: this.device, sys: SYS.name });
      const r = await this.waitAid();
      if (this.job) {
        setStatus(this.job, 'RUN');
        if (this.job.cancel) { this.job.cancel = false; throw new RpgCancel(); }
      }
      panel.setValues(r.fields || {});
      panel.message = null;
      panel.alarm = false;
      const fields = {};
      for (const f of panel.fields) fields[f.n] = f.v;
      const res = { aid: r.aid, fields, cursor: r.cursor || [1, 1], changed: r.changed || [] };
      const cursorOnMsg = res.cursor[0] === 24;
      if ((r.aid === 'F1' || r.aid === 'HELP') && !(panel.keys && panel.keys.includes('F1'))) {
        if (shownMsg && shownMsg.id && (cursorOnMsg || !panel.help)) {
          await this.messageHelp(shownMsg);
          panel.message = shownMsg;
          continue;
        }
        await this.helpScreen(panel);
        continue;
      }
      if (r.aid === 'PRINT') { await this.printScreen(); continue; }
      if (panel.keys && r.aid !== 'ENTER' && !panel.keys.includes(r.aid)) {
        panel.msg({ id: 'CPD9861', text: msgText('CPD9861'), sev: 30 }, true);
        continue;
      }
      return res;
    }
  }

  /**
   * Pantalla que interrumpe a la que está esperando (el depurador de un trabajo servido con STRSRVJOB): las teclas
   * van a esta pantalla; al terminar, restoreScreen() vuelve a mostrar la anterior. Se atienden de una en una.
   */
  async overlay(panel) {
    const prev = this.overlayLock || Promise.resolve();
    let release;
    this.overlayLock = new Promise((r) => { release = r; });
    await prev;
    try {
      for (;;) {
        if (this.closed) throw new Disconnected();
        this.send({ ...panel.toJSON(), mw: this.mw, dev: this.device, sys: SYS.name });
        const r = await new Promise((resolve, reject) => { this.sysreqPending = { resolve, reject }; });
        panel.setValues(r.fields || {});
        panel.message = null;
        panel.alarm = false;
        const fields = {};
        for (const f of panel.fields) fields[f.n] = f.v;
        if (panel.keys && r.aid !== 'ENTER' && !panel.keys.includes(r.aid)) { panel.msg({ id: 'CPD9861', text: msgText('CPD9861'), sev: 30 }, true); continue; }
        return { aid: r.aid, fields, cursor: r.cursor || [1, 1], changed: r.changed || [] };
      }
    } finally { release(); }
  }
  restoreScreen() {
    if (this.closed) return;
    if (this.pending && this.screen) this.send({ ...this.screen.toJSON(), mw: this.mw, dev: this.device, sys: SYS.name });
    else this.send({ t: 'lock' });
  }

  async messageHelp(m) {
    const h = msgHelp(m.id);
    const p = new Panel({ fn: 'CMD-DSPMSGD', keys: ['F3', 'F12', 'F6', 'F9', 'F21'] });
    p.title('Additional Message Information');
    p.info(3, 2, 'Message ID', m.id, 24); p.info(3, 42, 'Severity', String(m.sev ?? 0).padStart(2, '0'), 24);
    p.info(4, 2, 'Message type', (m.sev || 0) >= 30 ? 'Diagnostic' : 'Information', 24);
    const d = new Date(m.time || Date.now());
    p.info(5, 2, 'Date sent', sysDate(d), 24); p.info(5, 42, 'Time sent', sysTime(d), 24);
    let row = 7;
    const put = (label, text) => {
      const lines = wrapText(text, 58);
      p.label(row, 2, label, 17);
      p.text(row, 19, ':', 'g');
      lines.forEach((l, i) => p.text(row + i, 22, l, 'w'));
      row += lines.length + 1;
    };
    put('Message', m.text);
    put('Cause', h.cause);
    put('Recovery', h.recovery);
    p.more(Math.min(row, 20), false);
    p.text(21, 2, 'Press Enter to continue.', 'b');
    p.fkeys('F3=Exit   F6=Print   F9=Display message details   F12=Cancel', 'F21=Select assistance level');
    await this.display(p);
  }

  async helpScreen(panel) {
    const p = new Panel({ fn: 'CMD-HELP', keys: ['F3', 'F12'] });
    p.title('Help');
    const lines = typeof panel.help === 'string' ? panel.help.split('\n') : [
      'This display is part of the AS400 para Todos IBM i clone.',
      '',
      'Keys: Enter=submit, F3=Exit, F12=Cancel, F4=Prompt (command lines),',
      'F9=Retrieve previous command, PageUp/PageDown=Roll, Esc=Reset,',
      'Shift+Esc=System Request, Ctrl+P=Print screen.',
      '',
      'Place the cursor on a message and press F1 to see its second-level text.',
    ];
    lines.slice(0, 17).forEach((l, i) => p.text(3 + i, 2, l, 'g'));
    p.more(20, false);
    p.fkeys('F3=Exit help   F12=Cancel');
    await this.display(p);
  }

  async printScreen() {
    if (!this.job || !this.screen) return;
    const grid = Array.from({ length: 24 }, () => Array(80).fill(' '));
    const json = this.screen.toJSON();
    for (const [r, c, s] of json.texts) for (let i = 0; i < s.length && c - 1 + i < 80; i++) grid[r - 1][c - 1 + i] = s[i];
    for (const f of json.fields) {
      if (f.nd) continue;
      const start = (f.r - 1) * 80 + (f.c - 1);
      for (let i = 0; i < f.l; i++) { const pos = start + i; if (pos < 1920) grid[Math.floor(pos / 80)][pos % 80] = f.v[i] || ' '; }
    }
    const { createSpool } = await import('./objects.js');
    await createSpool(this.job, 'QSYSPRT', grid.map((r) => r.join('').replace(/\s+$/, '')), { usrdta: 'PRTSCN' });
    this.send({ t: 'notice', text: 'Print screen sent to QSYSPRT.' });
  }

  // Petición al sistema (Shift+Esc): permite terminar la petición en curso.
  async systemRequest() {
    if (!this.job || this.sysreqPending) return;
    const p = new Panel({ fn: 'CMD-SYSREQ', keys: ['F3', 'F12'] });
    p.title('System Request');
    p.sysName();
    p.text(3, 2, 'Select one of the following:', 'b');
    const opts = [[1, 'Display sign on for alternative job'], [2, 'End previous request'], [3, 'Display current job'],
      [4, 'Display messages'], [5, 'Send a message'], [6, 'Display system operator messages'], [7, 'Display work station user']];
    opts.forEach(([n, t], i) => p.text(5 + i, 6, `${String(n).padStart(3)}. ${t}`, 'g'));
    p.text(13, 6, ' 80. Disconnect job', 'g');
    p.text(14, 6, ' 90. Sign off', 'g');
    p.more(17, false);
    p.text(19, 2, 'Selection', 'g');
    p.text(20, 2, '===>', 'g');
    p.input('SEL', 20, 7, 4, {});
    p.fkeys('F3=Exit   F12=Cancel');
    p.text(24, 2, '(C) COPYRIGHT IBM CORP. 1980, 2009.', 'w');
    this.send({ ...p.toJSON(), mw: this.mw, dev: this.device });
    let r;
    try {
      r = await new Promise((resolve, reject) => { this.sysreqPending = { resolve, reject }; });
    } catch { return; }
    const sel = String((r.fields || {}).SEL || '').trim();
    if (r.aid === 'ENTER' && sel === '2') {
      this.job.cancel = true;
      if (this.pending) {
        const pend = this.pending;
        this.pending = null;
        pend.reject(new RpgCancel());
        return;
      }
      this.send({ t: 'lock' });
      return;
    }
    if (r.aid === 'ENTER' && (sel === '90' || sel === '80')) {
      this.forceSignoff = true;
      this.job.cancel = true;
      if (this.pending) { const pend = this.pending; this.pending = null; pend.reject(new SignOff()); }
      return;
    }
    // Volver a la pantalla anterior
    if (this.pending && this.screen) {
      if (sel && r.aid === 'ENTER') this.screen.msg({ id: 'CPD6A01', text: msgText('CPD6A01', sel), sev: 30 });
      this.send({ ...this.screen.toJSON(), mw: this.mw, dev: this.device });
    } else this.send({ t: 'lock' });
  }
}

export function wrapText(text, width) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let cur = '';
    for (const w of para.split(/\s+/)) {
      if (!w) continue;
      if ((cur ? cur.length + 1 : 0) + w.length > width) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
    }
    out.push(cur);
  }
  return out;
}

export { SYS };
