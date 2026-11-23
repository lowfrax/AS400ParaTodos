// Flujos de datos de los servidores host de IBM i ("Client Access data streams"): cabecera de 20 bytes,
// plantilla y parámetros LL/CP. Utilidades de EBCDIC, RLE y tipos numéricos para los servidores de jt400/ODBC/ACS.
import crypto from 'node:crypto';
import { toEbcdic, fromEbcdic } from '../../../../../shared/ebcdic.js';

export const SERVER_ID = { CENTRAL: 0xe000, FILE: 0xe002, NETPRT: 0xe003, DATABASE: 0xe004, DTAQ: 0xe007, RMTCMD: 0xe008, SIGNON: 0xe009 };
export const SERVICES = {
  'as-central': 8470, 'as-database': 8471, 'as-dtaq': 8472, 'as-file': 8473, 'as-netprt': 8474, 'as-rmtcmd': 8475, 'as-signon': 8476,
};

/** Cabecera de 20 bytes: longitud, id de cabecera, id de servidor, instancia CS, correlación, longitud de plantilla, id de petición/respuesta. */
export function header(totalLen, serverId, reqRepId, templateLen, req) {
  const h = Buffer.alloc(20);
  h.writeUInt32BE(totalLen, 0);
  h.writeUInt16BE(req ? req.readUInt16BE(4) & 0 : 0, 4);
  h.writeUInt16BE(serverId, 6);
  h.writeUInt32BE(req ? req.readUInt32BE(8) : 0, 8);
  h.writeUInt32BE(req ? req.readUInt32BE(12) : 0, 12);
  h.writeUInt16BE(templateLen, 16);
  h.writeUInt16BE(reqRepId, 18);
  return h;
}

/** Construye una respuesta: plantilla (Buffer) + parámetros [cp, Buffer] codificados como LL(4) CP(2) datos. */
export function reply(req, serverId, reqRepId, template = Buffer.alloc(0), params = []) {
  const parts = params.map(([cp, data]) => { const b = Buffer.alloc(6); b.writeUInt32BE(6 + data.length, 0); b.writeUInt16BE(cp, 4); return Buffer.concat([b, data]); });
  const body = Buffer.concat([template, ...parts]);
  return Buffer.concat([header(20 + body.length, serverId, reqRepId, template.length, req), body]);
}

/** Recorre parámetros LL/CP desde offset: devuelve Map(cp → Buffer de datos). */
export function parseCPs(buf, offset) {
  const m = new Map();
  let o = offset;
  while (o + 6 <= buf.length) {
    const ll = buf.readUInt32BE(o);
    if (ll < 6 || o + ll > buf.length) break;
    const cp = buf.readUInt16BE(o + 4);
    if (!m.has(cp)) m.set(cp, buf.subarray(o + 6, o + ll));
    o += ll;
  }
  return m;
}

/** Lee tramas con longitud de 4 bytes y llama a onFrame(buf) en orden. */
export function frameReader(socket, onFrame) {
  let buf = Buffer.alloc(0);
  let chain = Promise.resolve();
  socket.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= 20) {
      const len = buf.readUInt32BE(0);
      if (len < 20 || len > 64 * 1024 * 1024) { socket.destroy(); return; }
      if (buf.length < len) break;
      const frame = Buffer.from(buf.subarray(0, len));
      buf = buf.subarray(len);
      chain = chain.then(() => onFrame(frame)).catch((e) => { console.error('[hostsvr]', e); socket.destroy(); });
    }
  });
}

export const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
export const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
export const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n | 0); return b; };
export const ebc = (s, len) => { const b = toEbcdic(len ? String(s ?? '').padEnd(len).slice(0, len) : String(s ?? ''), 37); return b; };
export const unebc = (b) => fromEbcdic(b, 37);
export const utf16be = (s) => Buffer.from(String(s ?? ''), 'utf16le').swap16();
export const fromUtf16be = (b) => Buffer.from(b).swap16().toString('utf16le');
export const seed = () => crypto.randomBytes(8);

/** Texto según CCSID (1200/13488 = UTF-16BE; 1208 = UTF-8; el resto EBCDIC 37/500/273/1140). */
export function decodeText(buf, ccsid) {
  if (ccsid === 1200 || ccsid === 13488 || ccsid === 61952) return fromUtf16be(buf);
  if (ccsid === 1208) return buf.toString('utf8');
  if (ccsid === 819 || ccsid === 367 || ccsid === 1252) return buf.toString('latin1');
  return fromEbcdic(buf, [37, 500, 273, 1140].includes(ccsid) ? ccsid : 37);
}
export function encodeText(str, ccsid) {
  if (ccsid === 1200 || ccsid === 13488 || ccsid === 61952) return utf16be(str);
  if (ccsid === 1208) return Buffer.from(String(str), 'utf8');
  return toEbcdic(String(str), [37, 500, 273, 1140].includes(ccsid) ? ccsid : 37);
}

/** RLE de los servidores host (escape 0x1B): 1B 1B = 1B; 1B b1 b2 nn nn = (b1 b2) repetido nn veces. */
export function decompressRLE(src, outLen) {
  const out = Buffer.alloc(outLen);
  let i = 0, j = 0;
  while (i < src.length && j < outLen) {
    if (src[i] === 0x1b && i + 1 < src.length) {
      if (src[i + 1] === 0x1b) { out[j++] = 0x1b; i += 2; continue; }
      const b1 = src[i + 1], b2 = src[i + 2], n = (src[i + 3] << 8) | src[i + 4];
      for (let k = 0; k < n && j + 1 < outLen + 1; k++) { out[j++] = b1; if (j < outLen) out[j++] = b2; }
      i += 5;
      continue;
    }
    out[j++] = src[i++];
  }
  return out;
}

// ---------- Tipos de datos de IBM i ----------
export function packDecimal(value, digits, dec) {
  const n = Math.round(Math.abs(Number(value) || 0) * 10 ** dec);
  const s = String(n).padStart(digits, '0').slice(-digits);
  const nibbles = (digits % 2 === 0 ? `0${s}` : s) + (Number(value) < 0 ? 'D' : 'F');
  return Buffer.from(nibbles, 'hex');
}
export function unpackDecimal(buf, dec) {
  const h = buf.toString('hex').toUpperCase();
  const sign = h.slice(-1);
  const digits = h.slice(0, -1).replace(/[^0-9]/g, '0');
  const v = Number(digits || 0) / 10 ** dec;
  return sign === 'D' || sign === 'B' ? -v : v;
}
export function zonedDecimal(value, digits, dec) {
  const n = Math.round(Math.abs(Number(value) || 0) * 10 ** dec);
  const s = String(n).padStart(digits, '0').slice(-digits);
  const b = Buffer.from([...s].map((c) => 0xf0 | Number(c)));
  if (Number(value) < 0) b[b.length - 1] = 0xd0 | (b[b.length - 1] & 0x0f);
  return b;
}
export function unzonedDecimal(buf, dec) {
  let s = '';
  for (const x of buf) s += String(x & 0x0f);
  const v = Number(s || 0) / 10 ** dec;
  return (buf[buf.length - 1] & 0xf0) === 0xd0 ? -v : v;
}

/** Longitud en bytes de un tipo RPG en memoria (parámetros de programa). */
export function byteLength(t) {
  switch (t.t) {
    case 'packed': return Math.floor(t.digits / 2) + 1;
    case 'zoned': return t.digits;
    case 'int': case 'uns': return (t.bits || 32) / 8;
    case 'float': return 8;
    case 'ind': return 1;
    case 'date': return 10;
    case 'time': return 8;
    case 'timestamp': return 26;
    case 'varchar': return (t.len || 1) + 2;
    default: return t.len || 1;
  }
}

/** Bytes (EBCDIC/binario) → valor JS según el tipo RPG. */
export function decodeParam(buf, t) {
  switch (t.t) {
    case 'packed': return unpackDecimal(buf.subarray(0, byteLength(t)), t.dec || 0);
    case 'zoned': return unzonedDecimal(buf.subarray(0, t.digits), t.dec || 0);
    case 'int': return t.bits === 16 ? buf.readInt16BE(0) : t.bits === 64 ? Number(buf.readBigInt64BE(0)) : t.bits === 8 ? buf.readInt8(0) : buf.readInt32BE(0);
    case 'uns': return t.bits === 16 ? buf.readUInt16BE(0) : t.bits === 64 ? Number(buf.readBigUInt64BE(0)) : t.bits === 8 ? buf.readUInt8(0) : buf.readUInt32BE(0);
    case 'float': return buf.length >= 8 ? buf.readDoubleBE(0) : buf.readFloatBE(0);
    case 'varchar': { const n = buf.readUInt16BE(0); return unebc(buf.subarray(2, 2 + n)); }
    default: return unebc(buf.subarray(0, byteLength(t)));
  }
}
/** Valor JS → bytes según el tipo RPG. */
export function encodeParam(v, t) {
  switch (t.t) {
    case 'packed': return packDecimal(v, t.digits, t.dec || 0);
    case 'zoned': return zonedDecimal(v, t.digits, t.dec || 0);
    case 'int': case 'uns': { const n = byteLength(t); const b = Buffer.alloc(n); if (n === 2) b.writeInt16BE(Number(v) | 0); else if (n === 8) b.writeBigInt64BE(BigInt(Math.trunc(Number(v) || 0))); else if (n === 1) b.writeInt8(Number(v) | 0); else b.writeInt32BE(Number(v) | 0); return b; }
    case 'float': { const b = Buffer.alloc(8); b.writeDoubleBE(Number(v) || 0); return b; }
    case 'varchar': { const s = ebc(String(v ?? '')); const b = Buffer.alloc(2 + (t.len || s.length)); b.writeUInt16BE(Math.min(s.length, t.len || s.length)); s.copy(b, 2); return b; }
    default: return ebc(String(v ?? ''), byteLength(t));
  }
}

/** Fecha de los servidores host: año(2) mes día hora minuto segundo (+ relleno). */
export function hostDate(d = new Date()) {
  const b = Buffer.alloc(8);
  b.writeUInt16BE(d.getFullYear(), 0);
  b[2] = d.getMonth() + 1; b[3] = d.getDate(); b[4] = d.getHours(); b[5] = d.getMinutes(); b[6] = d.getSeconds(); b[7] = 0;
  return b;
}
