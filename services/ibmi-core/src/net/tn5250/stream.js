// Flujo de datos 5250 (5494 Functions Reference / RFC 1205 / RFC 2877): convierte los paneles del núcleo
// (texto + campos de entrada) en registros GDS con órdenes WTD/SBA/SF/IC y decodifica las respuestas (AID + campos MDT).
import { toEbcdic, fromEbcdic } from './ebcdic.js';

export const ESC = 0x04;
export const CMD = { CLEAR_UNIT: 0x40, CLEAR_UNIT_ALT: 0x20, WTD: 0x11, READ_MDT: 0x52, READ_INPUT: 0x42, READ_IMMEDIATE: 0x72, WSF: 0xf3, SAVE: 0x02, RESTORE: 0x12, ROLL: 0x23 };
export const ORDER = { SOH: 0x01, RA: 0x02, EA: 0x03, TD: 0x10, SBA: 0x11, WEA: 0x12, IC: 0x13, MC: 0x14, WDSF: 0x15, SF: 0x1d };
export const OPCODE = { NOOP: 0, INVITE: 1, OUTPUT_ONLY: 2, PUT_GET: 3, SAVE: 4, RESTORE: 5, READ_IMMED: 6, READ_SCR: 8, CANCEL_INVITE: 10, MSG_ON: 11, MSG_OFF: 12 };
export const FLAG = { ERR: 0x80, ATN: 0x40, SRQ: 0x04, TRQ: 0x02, HLP: 0x01 };
export const CC2 = { IC_ULOCK: 0x40, CLR_BLINK: 0x20, SET_BLINK: 0x10, UNLOCK: 0x08, ALARM: 0x04, MSG_OFF: 0x02, MSG_ON: 0x01 };

export const AID = {
  0xf1: 'ENTER', 0xf3: 'HELP', 0xf4: 'PAGEUP', 0xf5: 'PAGEDOWN', 0xf6: 'PRINT', 0xf8: 'RECBKSP', 0xbd: 'CLEAR',
  0x31: 'F1', 0x32: 'F2', 0x33: 'F3', 0x34: 'F4', 0x35: 'F5', 0x36: 'F6', 0x37: 'F7', 0x38: 'F8', 0x39: 'F9', 0x3a: 'F10', 0x3b: 'F11', 0x3c: 'F12',
  0xb1: 'F13', 0xb2: 'F14', 0xb3: 'F15', 0xb4: 'F16', 0xb5: 'F17', 0xb6: 'F18', 0xb7: 'F19', 0xb8: 'F20', 0xb9: 'F21', 0xba: 'F22', 0xbb: 'F23', 0xbc: 'F24',
  0x88: 'SFREPLY', 0x3f: 'INQUIRY',
};

// FFW (Field Format Word)
const FFW = { BASE: 0x4000, BYPASS: 0x2000, DUP: 0x1000, MDT: 0x0800, ALPHA_SHIFT: 0x0000, ALPHA_ONLY: 0x0100, NUM_SHIFT: 0x0200, NUM_ONLY: 0x0300, DIGITS: 0x0500, AUTO_ENTER: 0x0080, FER: 0x0040, MONOCASE: 0x0020, MANDATORY: 0x0008, RIGHT_ZERO: 0x0005, RIGHT_BLANK: 0x0006 };

/** Atributo de pantalla del núcleo (g/w/b/r/t/y/p + u/v/k/n) → byte de atributo 5250 (0x20–0x3F). */
export function attrByte(a = 'g') {
  const s = String(a || 'g');
  if (s.includes('n')) return 0x27;
  const u = s.includes('u'), v = s.includes('v'), k = s.includes('k');
  switch (s[0]) {
    case 'w': return u ? 0x26 : v ? 0x23 : 0x22;
    case 'r': return u ? (v ? 0x2d : k ? 0x2e : 0x2c) : v ? (k ? 0x2b : 0x29) : k ? 0x2a : 0x28;
    case 't': return u ? (v ? 0x35 : 0x34) : v ? 0x31 : 0x30;
    case 'y': return u ? 0x36 : v ? 0x33 : 0x32;
    case 'p': return u ? (v ? 0x3d : 0x3c) : v ? 0x39 : 0x38;
    case 'b': return u ? 0x3e : v ? 0x3b : 0x3a;
    default: return u ? (v ? 0x25 : 0x24) : v ? 0x21 : 0x20;
  }
}
const PLAIN = new Set([0x20, 0x22, 0x28, 0x30, 0x32, 0x38, 0x3a]);

/** Cabecera GDS + datos (sin escapar IAC). */
export function record(opcode, data = Buffer.alloc(0), flags = 0) {
  const len = 10 + data.length;
  const h = Buffer.from([(len >> 8) & 0xff, len & 0xff, 0x12, 0xa0, 0x00, 0x00, 0x04, flags, 0x00, opcode]);
  return Buffer.concat([h, data]);
}

/**
 * Panel (toJSON del núcleo) → bytes del comando 5250 (ESC CU + ESC WTD … + ESC READ MDT).
 * Devuelve {data, fields: [{n, row, col, len, value, num}]} — los campos se usan luego para interpretar la respuesta.
 */
export function encodeScreen(m, { ccsid = 37, mw = false, rows = 24, cols = 80 } = {}) {
  const SIZE = rows * cols;
  const chars = new Array(SIZE).fill(null); // carácter o null (vacío)
  const attrs = new Array(SIZE).fill(null); // código de atributo del núcleo para cada carácter
  const put = (r, c, s, a) => {
    const pos = (r - 1) * cols + (c - 1);
    for (let i = 0; i < s.length && pos + i < SIZE; i++) if (pos + i >= 0) { chars[pos + i] = s[i]; attrs[pos + i] = a; }
  };
  for (const [r, c, s, a] of m.texts || []) put(r, c, String(s), a || 'g');
  const inputs = [];
  for (const f of m.fields || []) {
    if (f.pr) { put(f.r, f.c, String(f.v || '').padEnd(f.l).slice(0, f.l), f.nd ? 'gn' : (f.a || 'g').replace('u', '')); continue; }
    inputs.push(f);
  }
  if (m.msg) put(rows, 1, ` ${m.msg}`.padEnd(cols).slice(0, cols), 'w');

  // Mapa de campos de entrada: posición de atributo, inicio y fin
  const fieldAt = new Int32Array(SIZE).fill(-1);
  const fieldAttrPos = new Map(); // pos atributo -> índice campo
  const endAttr = new Set(); // pos del atributo 0x20 que el terminal escribe tras el campo
  const flist = [];
  inputs.forEach((f, i) => {
    const start = (f.r - 1) * cols + (f.c - 1);
    const len = Math.max(1, Math.min(f.l, SIZE - start));
    for (let k = 0; k < len; k++) fieldAt[start + k] = i;
    if (start - 1 >= 0) fieldAttrPos.set(start - 1, i);
    endAttr.add((start + len) % SIZE);
    flist.push({ n: f.n, row: f.r, col: f.c, start, len, value: String(f.v ?? '').slice(0, len), num: !!f.num, nd: !!f.nd, lc: !!f.lc, f });
  });

  const out = [];
  const push = (...b) => { for (const x of b) out.push(x); };
  const ebc = (s) => toEbcdic(s, ccsid);
  push(ESC, CMD.CLEAR_UNIT);
  // WTD: CC1 = 0x00 (sin bloquear), CC2 = desbloquear teclado (+ alarma, + MW)
  let cc2 = m.lock ? 0 : CC2.UNLOCK;
  if (m.alarm) cc2 |= CC2.ALARM;
  cc2 |= mw ? CC2.MSG_ON : CC2.MSG_OFF;
  push(ESC, CMD.WTD, 0x00, cc2);
  push(ORDER.SBA, 1, 1);

  // Recorrido lineal de la pantalla: atributos, caracteres y SF de los campos.
  let cur = 0x20; // atributo vigente
  let pos = 0;
  const writeAttrAt = (p, byte) => { out.push(byte); cur = byte; return p + 1; };
  while (pos < SIZE) {
    if (fieldAttrPos.has(pos)) {
      const fi = fieldAttrPos.get(pos);
      const fl = flist[fi];
      const f = fl.f;
      let ffw = FFW.BASE;
      if (fl.num) ffw |= FFW.NUM_ONLY;
      if (!fl.lc) ffw |= FFW.MONOCASE;
      if (f.req) ffw |= FFW.MANDATORY;
      if (f.rj) ffw |= FFW.RIGHT_BLANK;
      if (f.fe) ffw |= FFW.FER;
      const at = fl.nd ? 0x27 : attrByte(f.a || 'gu');
      push(ORDER.SF, (ffw >> 8) & 0xff, ffw & 0xff, at, (fl.len >> 8) & 0xff, fl.len & 0xff);
      cur = at;
      // Datos iniciales del campo: el valor y nulos hasta el final (los nulos finales no se reenvían).
      const v = fl.value;
      const bytes = ebc(v);
      for (let k = 0; k < fl.len; k++) out.push(k < bytes.length ? safe(bytes[k]) : 0x00);
      pos = fl.start + fl.len;
      // El terminal pone por su cuenta un atributo 0x20 tras el campo: se reescribe para mantener la posición.
      if (pos < SIZE && !fieldAttrPos.has(pos)) { pos = writeAttrAt(pos, 0x20); }
      continue;
    }
    if (fieldAt[pos] >= 0) {
      // Campo en la posición 1,1 (sin celda previa para su atributo): no se puede definir; se deja en blanco.
      out.push(0x40);
      pos++;
      continue;
    }
    const ch = chars[pos];
    if (ch === null) {
      // Celda vacía: si el atributo vigente se ve (subrayado/inverso), se cierra con un atributo normal.
      if (!PLAIN.has(cur) && cur !== 0x27) { pos = writeAttrAt(pos, 0x20); continue; }
      out.push(0x40);
      pos++;
      continue;
    }
    const want = attrByte(attrs[pos]);
    if (want !== cur) {
      // El atributo necesita una celda: se usa la anterior si está vacía; si no, se sacrifica esta posición
      // (el carácter se pierde, como ocurre en un terminal real cuando dos campos de color se tocan).
      if (pos > 0 && chars[pos - 1] === null && fieldAt[pos - 1] < 0 && !endAttr.has(pos - 1) && !fieldAttrPos.has(pos - 1) && out.length && out[out.length - 1] === 0x40) {
        out[out.length - 1] = want;
        cur = want;
      } else {
        pos = writeAttrAt(pos, want);
        continue;
      }
    }
    out.push(safe(ebc(ch)[0]));
    pos++;
  }
  // Cursor
  const [cr, cc] = m.cursor || [1, 1];
  push(ORDER.IC, Math.max(1, Math.min(rows, cr)), Math.max(1, Math.min(cols, cc)));
  if (!m.lock) push(ESC, CMD.READ_MDT, 0x00, 0x00);
  return { data: Buffer.from(out), fields: flist };
}

// Los bytes < 0x40 son órdenes 5250: en el texto se sustituyen por blancos.
const safe = (b) => (b < 0x40 ? 0x40 : b);

/** 5250 Query (Write Structured Field) para conocer las capacidades del terminal. */
export function queryCommand() {
  return Buffer.from([ESC, CMD.WSF, 0x00, 0x05, 0xd9, 0x70, 0x00]);
}

/**
 * Decodifica un registro entrante. Devuelve {flags, opcode, aid, cursor:[r,c], mdt: [{row, col, text}]}.
 */
export function decodeRecord(buf, { ccsid = 37 } = {}) {
  if (buf.length < 10) return null;
  const varLen = buf[6];
  const flags = buf[7];
  const opcode = buf[9];
  const d = buf.subarray(6 + varLen);
  const res = { flags, opcode, aid: null, aidByte: 0, cursor: [1, 1], mdt: [] };
  if (d.length >= 3) {
    res.cursor = [d[0], d[1]];
    res.aidByte = d[2];
    res.aid = AID[d[2]] || null;
    let i = 3;
    while (i < d.length) {
      if (d[i] !== ORDER.SBA || i + 2 >= d.length) { i++; continue; }
      const row = d[i + 1], col = d[i + 2];
      let j = i + 3;
      while (j < d.length && d[j] !== ORDER.SBA) j++;
      res.mdt.push({ row, col, text: fromEbcdic(d, ccsid, i + 3, j).replace(/\u0000/g, ' ') });
      i = j;
    }
  }
  return res;
}
