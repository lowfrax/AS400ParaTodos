// Semántica de tipos de datos RPG: inicialización, conversión, truncamiento y fechas.

export class RpgError extends Error {
  constructor(status, msgId, message) {
    super(message);
    this.status = status;
    this.msgId = msgId;
  }
}

export const Fig = (v) => ({ fig: v });
export const isFig = (v) => v && typeof v === 'object' && 'fig' in v;
export const isDur = (v) => v && typeof v === 'object' && 'dur' in v;

export function isNumType(t) { return ['packed', 'zoned', 'int', 'uns', 'float'].includes(t.t); }
export function isCharType(t) { return t.t === 'char' || t.t === 'varchar'; }

export function blank(t) {
  switch (t.t) {
    case 'char': return ' '.repeat(t.len);
    case 'varchar': return '';
    case 'packed': case 'zoned': case 'int': case 'uns': case 'float': return 0;
    case 'ind': return '0';
    case 'date': return '0001-01-01';
    case 'time': return '00.00.00';
    case 'timestamp': return '0001-01-01-00.00.00.000000';
    default: return null;
  }
}

export function charLen(t) {
  switch (t.t) {
    case 'char': case 'varchar': return t.len;
    case 'packed': case 'zoned': return t.digits;
    case 'int': case 'uns': return t.bits === 8 ? 3 : t.bits === 16 ? 5 : t.bits === 32 ? 10 : 20;
    case 'ind': return 1;
    case 'date': return 10;
    case 'time': return 8;
    case 'timestamp': return 26;
    case 'float': return 8;
    default: return 0;
  }
}

function maxFor(t) {
  if (t.t === 'packed' || t.t === 'zoned') return Number((Math.pow(10, t.digits - t.dec) - Math.pow(10, -t.dec)).toFixed(t.dec));
  if (t.t === 'int') return 2 ** (t.bits - 1) - 1;
  if (t.t === 'uns') return 2 ** t.bits - 1;
  return Number.MAX_VALUE;
}
function minFor(t) {
  if (t.t === 'uns') return 0;
  if (t.t === 'int') return -(2 ** (t.bits - 1));
  return -maxFor(t);
}

export function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  if (isFig(v)) {
    if (v.fig === '*HIVAL') return Number.MAX_SAFE_INTEGER;
    if (v.fig === '*LOVAL') return -Number.MAX_SAFE_INTEGER;
    return 0;
  }
  const s = String(v).trim();
  if (s === '') return 0;
  const n = Number(s.replace(/,/g, ''));
  if (Number.isNaN(n)) throw new RpgError('00105', 'RNX0105', 'A character representation of a numeric value is in error.');
  return n;
}

export function toStr(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return numToChar(v);
  if (v === null || v === undefined) return '';
  if (isFig(v)) return v.fig === '*ZEROS' || v.fig === '*ZERO' ? '0' : '';
  return String(v);
}

export function numToChar(n, dec) {
  if (dec === undefined) {
    if (Number.isInteger(n)) return String(n);
    let s = String(+n.toFixed(10));
    if (s.startsWith('0.')) s = s.slice(1);
    if (s.startsWith('-0.')) s = '-' + s.slice(2);
    return s;
  }
  let s = Math.abs(n).toFixed(dec);
  if (s.startsWith('0.')) s = s.slice(1);
  return (n < 0 ? '-' : '') + s;
}

export function truthy(v) {
  if (typeof v === 'boolean') return v;
  if (v === '1') return true;
  if (v === '0') return false;
  if (isFig(v)) return v.fig === '*ON';
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim() === '1';
  return !!v;
}

function scale(v, dec, half) {
  const f = 10 ** dec;
  const x = Number((v * f).toFixed(6));
  const r = half ? Math.sign(x) * Math.round(Math.abs(x)) : Math.trunc(x);
  return r / f;
}

// Convierte un valor al tipo destino con la semántica de asignación de RPG.
export function coerce(t, v, opts = {}) {
  if (isFig(v)) return figValue(t, v.fig);
  if (v && typeof v === 'object' && 'all' in v) {
    if (isCharType(t)) {
      const len = t.t === 'char' ? t.len : t.len;
      return v.all.repeat(Math.ceil(len / Math.max(v.all.length, 1))).slice(0, len);
    }
    return toNumber(v.all);
  }
  switch (t.t) {
    case 'char': {
      let s = toStr(v);
      if (opts.right) return s.length >= t.len ? s.slice(s.length - t.len) : s.padStart(t.len);
      return s.length >= t.len ? s.slice(0, t.len) : s.padEnd(t.len);
    }
    case 'varchar': { const s = toStr(v); return s.length > t.len ? s.slice(0, t.len) : s; }
    case 'packed': case 'zoned': {
      const n = scale(toNumber(v), t.dec, opts.half);
      if (Math.abs(n) > maxFor(t)) throw new RpgError('00103', 'RNX0103', 'The target for a numeric operation is too small to hold the result.');
      return n === 0 ? 0 : n;
    }
    case 'int': case 'uns': {
      const raw = toNumber(v);
      const n = opts.half ? Math.round(raw) : Math.trunc(raw);
      if (n > maxFor(t) || n < minFor(t)) throw new RpgError('00103', 'RNX0103', 'The target for a numeric operation is too small to hold the result.');
      return n === 0 ? 0 : n;
    }
    case 'float': return toNumber(v);
    case 'ind': return truthy(v) ? '1' : '0';
    case 'date': return v ? toDate(v) : blank(t);
    case 'time': return v ? toTime(v) : blank(t);
    case 'timestamp': return v ? toTimestamp(v) : blank(t);
    default: return v;
  }
}

export function figValue(t, fig) {
  switch (fig) {
    case '*BLANK': case '*BLANKS': return isCharType(t) ? (t.t === 'char' ? ' '.repeat(t.len) : '') : blank(t);
    case '*ZERO': case '*ZEROS': return isCharType(t) ? '0'.repeat(t.len) : (t.t === 'ind' ? '0' : blank(t));
    case '*ON': return t.t === 'ind' ? '1' : isCharType(t) ? coerce(t, '1') : 1;
    case '*OFF': return t.t === 'ind' ? '0' : isCharType(t) ? coerce(t, '0') : 0;
    case '*HIVAL': return isNumType(t) ? maxFor(t) : isCharType(t) ? '￿'.repeat(t.len) : t.t === 'date' ? '9999-12-31' : blank(t);
    case '*LOVAL': return isNumType(t) ? minFor(t) : isCharType(t) ? '\u0000'.repeat(t.len) : t.t === 'date' ? '0001-01-01' : blank(t);
    case '*NULL': return blank(t);
    case '*INZDFT': return blank(t);
    case '*SYS': case '*JOB':
      if (t.t === 'date') return toDate(new Date());
      if (t.t === 'time') return toTime(new Date());
      if (t.t === 'timestamp') return toTimestamp(new Date());
      return blank(t);
    default: return blank(t);
  }
}

// ---------- Fechas (formato interno *ISO) ----------
const pad = (n, l = 2) => String(n).padStart(l, '0');

export function toDate(v, fmt = '*ISO') {
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number') {
    const s = String(Math.trunc(v));
    return parseDateStr(s, fmt.endsWith('0') ? fmt : fmt + '0');
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return validDate(s.slice(0, 10));
  return parseDateStr(s, fmt);
}

function validDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new RpgError('00112', 'RNX0112', 'Date, Time or Timestamp value is not valid.');
  }
  return iso;
}

function parseDateStr(s, fmt) {
  const f = fmt.toUpperCase().replace(/0$/, '');
  const digits = s.replace(/[^0-9]/g, '');
  let y, m, d;
  const yy = (v) => { const n = Number(v); return n < 40 ? 2000 + n : 1900 + n; };
  switch (f) {
    case '*ISO': case '*JIS': y = digits.slice(0, 4); m = digits.slice(4, 6); d = digits.slice(6, 8); break;
    case '*USA': m = digits.slice(0, 2); d = digits.slice(2, 4); y = digits.slice(4, 8); break;
    case '*EUR': d = digits.slice(0, 2); m = digits.slice(2, 4); y = digits.slice(4, 8); break;
    case '*MDY': m = digits.slice(0, 2); d = digits.slice(2, 4); y = yy(digits.slice(4, 6)); break;
    case '*DMY': d = digits.slice(0, 2); m = digits.slice(2, 4); y = yy(digits.slice(4, 6)); break;
    case '*YMD': y = yy(digits.slice(0, 2)); m = digits.slice(2, 4); d = digits.slice(4, 6); break;
    case '*CYMD': y = 1900 + Number(digits[0]) * 100 + Number(digits.slice(1, 3)); m = digits.slice(3, 5); d = digits.slice(5, 7); break;
    default: throw new RpgError('00112', 'RNX0112', 'Date, Time or Timestamp value is not valid.');
  }
  return validDate(`${pad(Number(y), 4)}-${pad(Number(m))}-${pad(Number(d))}`);
}

export function toTime(v) {
  if (v instanceof Date) return `${pad(v.getHours())}.${pad(v.getMinutes())}.${pad(v.getSeconds())}`;
  const s = String(v).trim();
  const m = /^(\d{1,2})[.:]?(\d{2})[.:]?(\d{2})/.exec(s.length > 8 && s.includes('-') ? s.slice(11) : s);
  if (!m) throw new RpgError('00112', 'RNX0112', 'Date, Time or Timestamp value is not valid.');
  return `${pad(Number(m[1]))}.${m[2]}.${m[3]}`;
}

export function toTimestamp(v) {
  if (v instanceof Date) {
    return `${toDate(v)}-${pad(v.getHours())}.${pad(v.getMinutes())}.${pad(v.getSeconds())}.${pad(v.getMilliseconds(), 3)}000`;
  }
  const s = String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[-T ](\d{2})[.:](\d{2})[.:](\d{2})(?:[.,](\d{1,6}))?)?/.exec(s);
  if (!m) throw new RpgError('00112', 'RNX0112', 'Date, Time or Timestamp value is not valid.');
  return `${m[1]}-${m[2] || '00'}.${m[3] || '00'}.${m[4] || '00'}.${(m[5] || '0').padEnd(6, '0')}`;
}

export function dateToJs(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const t = iso.length > 10 ? iso.slice(11).split('.').map(Number) : [0, 0, 0, 0];
  return new Date(Date.UTC(y, m - 1, d, t[0] || 0, t[1] || 0, t[2] || 0, Math.floor((t[3] || 0) / 1000)));
}

export function fmtDate(iso, fmt = '*ISO') {
  const [y, m, d] = iso.slice(0, 10).split('-');
  const f = fmt.toUpperCase();
  const noSep = f.endsWith('0');
  const base = f.replace(/0$/, '');
  const j = (parts, sep) => parts.join(noSep ? '' : sep);
  switch (base) {
    case '*USA': return j([m, d, y], '/');
    case '*EUR': return j([d, m, y], '.');
    case '*MDY': return j([m, d, y.slice(2)], '/');
    case '*DMY': return j([d, m, y.slice(2)], '/');
    case '*YMD': return j([y.slice(2), m, d], '/');
    case '*CYMD': return j([String(Number(y) >= 2000 ? 1 : 0) + y.slice(2), m, d], '/');
    default: return j([y, m, d], '-');
  }
}

export function addDuration(base, dur, sign = 1) {
  const n = dur.dur * sign;
  const isTs = base.length > 10 && base[4] === '-';
  const isTime = base.length === 8 && base[2] === '.';
  if (isTime) {
    const [h, mi, s] = base.split('.').map(Number);
    let secs = h * 3600 + mi * 60 + s;
    secs += n * ({ '*HOURS': 3600, '*MINUTES': 60, '*SECONDS': 1 }[dur.unit] || 0);
    secs = ((secs % 86400) + 86400) % 86400;
    return `${pad(Math.floor(secs / 3600))}.${pad(Math.floor((secs % 3600) / 60))}.${pad(secs % 60)}`;
  }
  const dt = dateToJs(base);
  switch (dur.unit) {
    case '*DAYS': dt.setUTCDate(dt.getUTCDate() + n); break;
    case '*MONTHS': case '*YEARS': {
      // RPG ajusta al último día del mes si el día no existe (31-ene + 1 mes = 29-feb).
      const months = dur.unit === '*MONTHS' ? n : n * 12;
      const day = dt.getUTCDate();
      dt.setUTCDate(1);
      dt.setUTCMonth(dt.getUTCMonth() + months);
      const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
      dt.setUTCDate(Math.min(day, last));
      break;
    }
    case '*HOURS': dt.setUTCHours(dt.getUTCHours() + n); break;
    case '*MINUTES': dt.setUTCMinutes(dt.getUTCMinutes() + n); break;
    case '*SECONDS': dt.setUTCSeconds(dt.getUTCSeconds() + n); break;
    case '*MSECONDS': dt.setUTCMilliseconds(dt.getUTCMilliseconds() + Math.round(n / 1000)); break;
    default: break;
  }
  const iso = `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  if (!isTs) return iso;
  return `${iso}-${pad(dt.getUTCHours())}.${pad(dt.getUTCMinutes())}.${pad(dt.getUTCSeconds())}.${base.slice(20, 26) || '000000'}`;
}

export function diffDates(a, b, unit) {
  const da = dateToJs(a), db = dateToJs(b);
  const ms = da - db;
  switch (unit) {
    case '*DAYS': case '*D': return Math.trunc(ms / 86400000);
    case '*MONTHS': case '*M': {
      let months = (da.getUTCFullYear() - db.getUTCFullYear()) * 12 + (da.getUTCMonth() - db.getUTCMonth());
      if (months > 0 && da.getUTCDate() < db.getUTCDate()) months--;
      if (months < 0 && da.getUTCDate() > db.getUTCDate()) months++;
      return months;
    }
    case '*YEARS': case '*Y': return Math.trunc(diffDates(a, b, '*MONTHS') / 12);
    case '*HOURS': case '*H': return Math.trunc(ms / 3600000);
    case '*MINUTES': case '*MN': return Math.trunc(ms / 60000);
    case '*SECONDS': case '*S': return Math.trunc(ms / 1000);
    default: return Math.trunc(ms / 86400000);
  }
}

// %EDITC con los códigos de edición más comunes.
export function editc(n, code, t) {
  const dec = t && (t.t === 'packed' || t.t === 'zoned') ? t.dec : (Number.isInteger(n) ? 0 : 2);
  const digits = t && t.digits ? t.digits : 15;
  const neg = n < 0;
  const abs = Math.abs(n);
  const c = String(code).toUpperCase();
  if (c === 'X') {
    const s = String(Math.round(abs * 10 ** dec)).padStart(digits, '0');
    return s;
  }
  if (c === 'Y') {
    const s = String(Math.trunc(abs)).padStart(6, '0');
    return `${s.slice(0, 2)}/${s.slice(2, 4)}/${s.slice(4, 6)}`;
  }
  const commas = ['1', '2', 'A', 'B', 'J', 'K', 'N', 'O'].includes(c);
  const zeroBlank = ['2', '4', 'B', 'D', 'K', 'M', 'O', 'Q', 'Z'].includes(c);
  const minus = ['J', 'K', 'L', 'M'].includes(c) ? 'trailing' : ['N', 'O', 'P', 'Q'].includes(c) ? 'leading' : c === 'Z' ? 'none' : ['A', 'B', 'C', 'D'].includes(c) ? 'CR' : 'none';
  let s;
  if (c === 'Z') s = String(Math.trunc(abs));
  else s = abs.toFixed(dec);
  if (commas) {
    const [ip, fp] = s.split('.');
    s = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fp !== undefined ? '.' + fp : '');
  }
  if (s.startsWith('0.') && c !== 'Z') s = s.slice(1);
  if (abs === 0 && zeroBlank) s = '';
  const width = digits + (dec ? 1 : 0) + (commas ? Math.floor((digits - dec - 1) / 3) : 0) + (minus !== 'none' ? (minus === 'CR' ? 2 : 1) : 0);
  if (neg && minus === 'trailing') s += '-';
  else if (neg && minus === 'leading') s = '-' + s;
  else if (neg && minus === 'CR') s += 'CR';
  else if (minus !== 'none' && minus !== 'leading') s += minus === 'CR' ? '  ' : ' ';
  return s.padStart(Math.max(width, s.length));
}

// Conversión de tipos SQL (catálogo Db2) a tipos RPG.
export function sqlTypeToRpg(c) {
  const ty = String(c.type).toUpperCase();
  switch (ty) {
    case 'CHAR': case 'CHARACTER': case 'GRAPHIC': return { t: 'char', len: c.length || 1 };
    case 'VARCHAR': case 'VARGRAPHIC': case 'CLOB': case 'LONG VARCHAR': case 'TEXT': return { t: 'varchar', len: c.length || 32740 };
    case 'DECIMAL': case 'DEC': return { t: 'packed', digits: c.length || 15, dec: c.scale || 0 };
    case 'NUMERIC': return { t: 'zoned', digits: c.length || 15, dec: c.scale || 0 };
    case 'SMALLINT': return { t: 'int', bits: 16 };
    case 'INTEGER': case 'INT': return { t: 'int', bits: 32 };
    case 'BIGINT': return { t: 'int', bits: 64 };
    case 'DOUBLE': case 'FLOAT': case 'REAL': case 'DECFLOAT': return { t: 'float' };
    case 'DATE': return { t: 'date' };
    case 'TIME': return { t: 'time' };
    case 'TIMESTAMP': return { t: 'timestamp' };
    default: return { t: 'varchar', len: c.length || 256 };
  }
}
