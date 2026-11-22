// Almacenamiento de estructuras de datos como bytes, con la representación interna de IBM i:
//   CHAR     EBCDIC (CCSID 37), relleno X'40'          VARCHAR  longitud de 2 bytes + datos
//   ZONED    un dígito por byte, zona F (D si negativo en el último byte)
//   PACKED   BCD, signo F (positivo) / D (negativo) en el último medio byte
//   INT/UNS  binario big-endian (1, 2, 4 u 8 bytes)     FLOAT 4/8 bytes IEEE big-endian
//   IND      '0'/'1' (X'F0'/X'F1')                     DATE/TIME/TIMESTAMP en formato *ISO
import { toEbcdic, fromEbcdic } from '../ebcdic.js';
import { RpgError, toNumber, toStr, toDate, toTime, toTimestamp } from './types.js';

export function byteLen(t) {
  switch (t.t) {
    case 'char': return t.len;
    case 'varchar': return t.len + 2;
    case 'zoned': return t.digits;
    case 'packed': return Math.floor(t.digits / 2) + 1;
    case 'int': case 'uns': return (t.bits || 32) / 8;
    case 'float': return t.len === 4 ? 4 : 8;
    case 'ind': return 1;
    case 'date': return 10;
    case 'time': return 8;
    case 'timestamp': return 26;
    case 'pointer': return 16;
    default: return 0;
  }
}

const decimalError = (what) => new RpgError('00907', 'RNX0907', `Decimal-data error occurred (${what}).`);

export function encodeInto(buf, off, t, v) {
  switch (t.t) {
    case 'char': {
      const s = toStr(v).padEnd(t.len).slice(0, t.len);
      toEbcdic(s).copy(buf, off);
      return;
    }
    case 'varchar': {
      const s = toStr(v).slice(0, t.len);
      buf.writeUInt16BE(s.length, off);
      buf.fill(0x40, off + 2, off + 2 + t.len);
      toEbcdic(s).copy(buf, off + 2);
      return;
    }
    case 'zoned': {
      const n = toNumber(v);
      const ds = String(Math.round(Math.abs(n) * 10 ** (t.dec || 0))).padStart(t.digits, '0').slice(-t.digits);
      for (let i = 0; i < t.digits; i++) buf[off + i] = 0xF0 | Number(ds[i]);
      if (n < 0) buf[off + t.digits - 1] = 0xD0 | Number(ds[t.digits - 1]);
      return;
    }
    case 'packed': {
      const n = toNumber(v);
      const len = byteLen(t);
      const nd = len * 2 - 1;
      const ds = String(Math.round(Math.abs(n) * 10 ** (t.dec || 0))).padStart(nd, '0').slice(-nd);
      const nib = [...ds].map(Number);
      nib.push(n < 0 ? 0xD : 0xF);
      for (let i = 0; i < len; i++) buf[off + i] = (nib[i * 2] << 4) | nib[i * 2 + 1];
      return;
    }
    case 'int': case 'uns': {
      const n = Math.trunc(toNumber(v));
      const b = (t.bits || 32) / 8;
      if (b === 1) t.t === 'int' ? buf.writeInt8(n, off) : buf.writeUInt8(n & 0xFF, off);
      else if (b === 2) t.t === 'int' ? buf.writeInt16BE(n, off) : buf.writeUInt16BE(n & 0xFFFF, off);
      else if (b === 4) t.t === 'int' ? buf.writeInt32BE(n, off) : buf.writeUInt32BE(n >>> 0, off);
      else t.t === 'int' ? buf.writeBigInt64BE(BigInt(n), off) : buf.writeBigUInt64BE(BigInt(Math.max(0, n)), off);
      return;
    }
    case 'float': if (byteLen(t) === 4) buf.writeFloatBE(toNumber(v), off); else buf.writeDoubleBE(toNumber(v), off); return;
    case 'ind': buf[off] = String(v) === '1' || v === true ? 0xF1 : 0xF0; return;
    case 'date': toEbcdic(toDate(v).padEnd(10).slice(0, 10)).copy(buf, off); return;
    case 'time': toEbcdic(toTime(v).padEnd(8).slice(0, 8)).copy(buf, off); return;
    case 'timestamp': toEbcdic(toTimestamp(v).padEnd(26).slice(0, 26)).copy(buf, off); return;
    default: return;
  }
}

export function decodeFrom(buf, off, t, name = '') {
  switch (t.t) {
    case 'char': return fromEbcdic(buf, 37, off, off + t.len);
    case 'varchar': {
      const n = Math.min(buf.readUInt16BE(off), t.len);
      return fromEbcdic(buf, 37, off + 2, off + 2 + n);
    }
    case 'zoned': {
      let s = '';
      let neg = false;
      for (let i = 0; i < t.digits; i++) {
        const b = buf[off + i];
        const d = b & 0x0F;
        const z = b >> 4;
        if (d > 9 || (i < t.digits - 1 && z !== 0xF) || (i === t.digits - 1 && z < 0xA)) {
          // Un campo en blanco (X'40') o con zona inválida produce error de datos decimales, como en IBM i
          throw decimalError(`zoned field ${name}`);
        }
        if (i === t.digits - 1 && (z === 0xD || z === 0xB)) neg = true;
        s += d;
      }
      const n = Number(s) / 10 ** (t.dec || 0);
      return neg ? -n : n;
    }
    case 'packed': {
      const len = byteLen(t);
      let s = '';
      for (let i = 0; i < len; i++) {
        const b = buf[off + i];
        const hi = b >> 4;
        const lo = b & 0x0F;
        if (hi > 9) throw decimalError(`packed field ${name}`);
        s += hi;
        if (i < len - 1) { if (lo > 9) throw decimalError(`packed field ${name}`); s += lo; } else if (lo < 0xA) throw decimalError(`packed field ${name}`);
      }
      const sign = buf[off + len - 1] & 0x0F;
      const n = Number(s) / 10 ** (t.dec || 0);
      return sign === 0xD || sign === 0xB ? -n : n;
    }
    case 'int': case 'uns': {
      const b = (t.bits || 32) / 8;
      if (b === 1) return t.t === 'int' ? buf.readInt8(off) : buf.readUInt8(off);
      if (b === 2) return t.t === 'int' ? buf.readInt16BE(off) : buf.readUInt16BE(off);
      if (b === 4) return t.t === 'int' ? buf.readInt32BE(off) : buf.readUInt32BE(off);
      return Number(t.t === 'int' ? buf.readBigInt64BE(off) : buf.readBigUInt64BE(off));
    }
    case 'float': return byteLen(t) === 4 ? buf.readFloatBE(off) : buf.readDoubleBE(off);
    case 'ind': return buf[off] === 0xF1 ? '1' : '0';
    case 'date': { const s = fromEbcdic(buf, 37, off, off + 10); return s.trim() ? toDate(s) : s; }
    case 'time': { const s = fromEbcdic(buf, 37, off, off + 8); return s.trim() ? toTime(s) : s; }
    case 'timestamp': { const s = fromEbcdic(buf, 37, off, off + 26); return s.trim() ? toTimestamp(s) : s; }
    default: return null;
  }
}

/** Disposición de subcampos: desplazamiento (base 0) y tamaño de cada uno; longitud total. */
export function layout(tmpl, { len } = {}) {
  let next = 0;
  let max = 0;
  const byName = new Map();
  const nextOverlay = new Map();
  for (const f of tmpl) {
    const elem = f.nested ? f.nested.$len ?? 0 : byteLen(f.type);
    const dim = f.dim || 1;
    let off;
    let stride = elem;
    if (f.pos) off = f.pos - 1;
    else if (f.overlay) {
      const base = byName.get(f.overlay.name);
      if (!base) off = (f.overlay.pos === '*NEXT' ? 0 : (Number(f.overlay.pos) || 1) - 1); // OVERLAY(ds:pos)
      else {
        const rel = f.overlay.pos === '*NEXT' ? (nextOverlay.get(f.overlay.name) ?? 0) : (Number(f.overlay.pos) || 1) - 1;
        off = base.off + rel;
        if (base.dim > 1) stride = base.stride; // sobre un array: mismo paso que sus elementos
        nextOverlay.set(f.overlay.name, rel + elem);
      }
    } else off = next;
    f.$off = off;
    f.$elem = elem;
    f.$stride = stride;
    const end = off + (dim - 1) * stride + elem;
    if (!f.overlay) next = Math.max(next, end);
    max = Math.max(max, end);
    byName.set(f.name, { off, dim, stride, end });
  }
  const total = Math.max(max, len || 0);
  tmpl.$len = total;
  return total;
}
