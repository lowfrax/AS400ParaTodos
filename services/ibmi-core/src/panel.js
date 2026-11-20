// Construcción de pantallas 5250 (24x80) que se envían al emulador web.
// Atributos: g=verde w=blanco b=azul r=rojo t=turquesa y=amarillo p=rosa;
// modificadores: u=subrayado v=inverso k=parpadeo n=no visualizar.
import { SYS } from './system.js';

export class Panel {
  constructor({ fn = '', keys = null, help = null, rows = 24, cols = 80 } = {}) {
    this.fn = fn;
    this.rows = rows;
    this.cols = cols;
    this.texts = [];
    this.fields = [];
    this.cursor = null;
    this.message = null;
    this.alarm = false;
    this.keys = keys; // AID permitidos además de ENTER (null = todos)
    this.help = help;
  }

  text(row, col, str, attr = 'g') {
    if (str === undefined || str === null || str === '') return this;
    const s = String(str);
    if (col + s.length - 1 > this.cols) this.texts.push([row, col, s.slice(0, this.cols - col + 1), attr]);
    else this.texts.push([row, col, s, attr]);
    return this;
  }

  center(row, str, attr = 'w') {
    const s = String(str);
    return this.text(row, Math.max(1, Math.floor((this.cols - s.length) / 2) + 1), s, attr);
  }

  input(name, row, col, len, opts = {}) {
    const f = {
      n: name, r: row, c: col, l: len, v: opts.value === undefined || opts.value === null ? '' : String(opts.value),
      a: opts.attr || 'gu', num: !!opts.num, nd: !!opts.nd, lc: opts.lower !== undefined ? !!opts.lower : false,
      pr: !!opts.protect, req: !!opts.required, fe: !!opts.fe, rj: !!opts.rightAdjust,
    };
    if (f.v.length > len) f.v = f.v.slice(0, len);
    this.fields.push(f);
    if (opts.cursor) this.cursor = [row, col];
    return this;
  }

  field(name) { return this.fields.find((f) => f.n === name); }
  setValues(values = {}) {
    for (const f of this.fields) if (values[f.n] !== undefined) f.v = values[f.n];
  }
  cursorTo(name) { const f = this.field(name); if (f) this.cursor = [f.r, f.c]; return this; }

  // Mensaje en la línea 24 (texto de primer nivel; F1 muestra la ayuda de segundo nivel).
  msg(m, alarm = false) {
    if (!m) return this;
    this.message = typeof m === 'string' ? { text: m } : m;
    if (alarm || (this.message.sev || 0) >= 30) this.alarm = true;
    return this;
  }

  // ---- Elementos estándar de las pantallas de IBM i ----
  title(t) { return this.center(1, t, 'w'); }
  sysName(row = 2, col = 62) { return this.text(row, col, 'System:', 'w').text(row, col + 10, SYS.name, 'w'); }
  sysRight(row = 1) { return this.text(row, 72, SYS.name, 'w'); }
  fkeys(...lines) {
    lines.forEach((l, i) => this.text(22 + i, 2, l, 'b'));
    return this;
  }
  more(row, isMore) { return this.text(row, 72, isMore ? 'More...' : 'Bottom', 'w'); }
  label(row, col, label, width = 32, attr = 'g') {
    return this.text(row, col, dots(label, width, col), attr);
  }
  // "Etiqueta . . . . :   valor" de solo salida
  info(row, col, label, value, width = 22, attr = 'w') {
    // Los dos puntos ocupan la última posición de la guía de puntos: "Library . . . . :   QGPL"
    const s = dots(label, width, col);
    const k = s.lastIndexOf('.');
    const lab = k > label.length ? `${s.slice(0, k)}:` : `${label} :`;
    this.text(row, col, lab, 'g');
    return this.text(row, col + width + 2, value, attr);
  }
  cmdLine(row = 20, name = 'CMD', len = 153, value = '', label = null) {
    if (label) this.text(row - 1, 2, label, 'g');
    this.text(row, 2, '===>', 'g');
    return this.input(name, row, 7, len, { value, lower: true });
  }

  toJSON() {
    return {
      t: 'screen', rows: this.rows, cols: this.cols, texts: this.texts, fields: this.fields,
      cursor: this.cursor || (this.fields.find((f) => !f.pr) ? [this.fields.find((f) => !f.pr).r, this.fields.find((f) => !f.pr).c] : [1, 1]),
      msg: this.message ? this.message.text : null, alarm: this.alarm,
    };
  }
}

// Utilidades de formato
export const padR = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
export const padL = (s, n) => String(s ?? '').padStart(n).slice(-n);
// Los puntos guía de IBM caen siempre en columnas pares para que queden alineados entre filas.
export function dots(label, width, col = 2) {
  let s = label + ' ';
  while (s.length < width) s += (col + s.length) % 2 === 0 ? '.' : ' ';
  return s.slice(0, width);
}

// Ajuste de texto en líneas de un ancho dado.
export function wrap(text, width) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!w) continue;
    if ((cur + ' ' + w).trim().length > width) { if (cur) lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
