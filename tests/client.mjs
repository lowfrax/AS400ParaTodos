// Cliente 5250 sin interfaz para pruebas: renderiza pantallas como texto y envía teclas AID.
import { WebSocket } from 'ws';

export class Term {
  constructor(url = 'ws://localhost:5250/ws') { this.url = url; this.screen = null; this.waiters = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (m.t === 'screen' && !m.lock) {
          this.screen = m;
          const w = this.waiters.splice(0);
          w.forEach((f) => f(m));
        }
      });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }
  next(timeout = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout esperando pantalla. Última:\n${this.text()}`)), timeout);
      this.waiters.push((m) => { clearTimeout(t); resolve(m); });
    });
  }
  async waitFor(re, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (this.screen && re.test(this.text())) return this.screen;
      await this.next(end - Date.now()).catch(() => {});
    }
    throw new Error(`No apareció ${re} en pantalla:\n${this.text()}`);
  }
  text() {
    const m = this.screen;
    if (!m) return '';
    const g = Array.from({ length: 24 }, () => Array(80).fill(' '));
    for (const [r, c, s] of m.texts) for (let i = 0; i < s.length && c - 1 + i < 80; i++) g[r - 1][c - 1 + i] = s[i];
    for (const f of m.fields) {
      const start = (f.r - 1) * 80 + f.c - 1;
      for (let i = 0; i < f.l; i++) {
        const p = start + i;
        if (p < 1920) g[Math.floor(p / 80)][p % 80] = f.nd ? ' ' : (f.v[i] || '_');
      }
    }
    if (m.msg) { const t = ` ${m.msg}`.padEnd(80).slice(0, 80); g[23] = t.split(''); }
    return g.map((r) => r.join('')).join('\n');
  }
  // Envía una tecla AID con valores de campos (por nombre o el primer campo por omisión).
  async send(aid = 'ENTER', values = {}, opts = {}) {
    const fields = {};
    for (const f of this.screen.fields) fields[f.n] = f.v;
    Object.assign(fields, values);
    const p = this.next(opts.timeout || 20000);
    this.ws.send(JSON.stringify({ t: 'aid', aid, cursor: opts.cursor || [1, 1], fields }));
    return p;
  }
  cmdField() { return this.screen.fields.find((f) => f.n === 'CMD'); }
  async cmd(text, aid = 'ENTER') { return this.send(aid, { CMD: text }); }
  close() { this.ws.close(); }
}
