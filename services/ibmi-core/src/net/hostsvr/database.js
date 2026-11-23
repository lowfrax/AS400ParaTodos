// as-database (servidor de base de datos de IBM i, trabajos QZDASOINIT): el protocolo que usan el controlador JDBC de
// jt400 (IBM Toolbox for Java / JTOpen), IBM i Access ODBC, ACS "Ejecutar scripts SQL", DBeaver, Squirrel, .NET…
// Implementa atributos del servidor, RPB (bloques de parámetros de petición), PREPARE / DESCRIBE / OPEN / FETCH /
// EXECUTE / EXECUTE IMMEDIATE / CLOSE, marcadores de parámetro, COMMIT / ROLLBACK y la recuperación de mensajes de error.
// Formatos: descripción de columnas "extended data format" (CP 0x380C/0x380D) y datos "extended result data" (0x380E).
import { reply, parseCPs, u16, u32, ebc, decodeText, encodeText, packDecimal, unpackDecimal, zonedDecimal, unzonedDecimal, decompressRLE } from './ds.js';
import { SYS, qualifiedJob } from '../../system.js';
import { tagConnection } from '../servers.js';

const ORS = { RETURN_DATA: 0x80000000, MESSAGE_ID: 0x40000000, FIRST_LEVEL: 0x20000000, SECOND_LEVEL: 0x10000000, DATA_FORMAT: 0x08000000, RESULT_DATA: 0x04000000, SQLCA: 0x02000000, SERVER_ATTRIBUTES: 0x01000000, PARAMETER_MARKER_FORMAT: 0x00800000 };
const FN = {
  PREPARE: 0x1800, DESCRIBE: 0x1801, DESCRIBE_PARM: 0x1802, PREPARE_DESCRIBE: 0x1803, OPEN_DESCRIBE: 0x1804, EXECUTE: 0x1805, EXECUTE_IMMEDIATE: 0x1806,
  COMMIT: 0x1807, ROLLBACK: 0x1808, CONNECT: 0x1809, CLOSE: 0x180A, FETCH: 0x180B, PREPARE_EXECUTE: 0x180D, OPEN_DESCRIBE_FETCH: 0x180E,
  EXECUTE_OPEN_DESCRIBE: 0x1812, END_STREAM_FETCH: 0x1813, RETURN_PACKAGE: 0x1815, CANCEL: 0x1818,
  CREATE_RPB: 0x1D00, CREATE_RPB_BASED_ON: 0x1D01, DELETE_RPB: 0x1D02, CHANGE_RPB: 0x1D03, RESET_RPB: 0x1D04,
  CHANGE_DESCRIPTOR: 0x1E00, DELETE_DESCRIPTOR: 0x1E01, SEND_RESULTS_SET: 0x1F00, DELETE_RESULTS_SET: 0x1F01,
  SET_ATTRIBUTES: 0x1F80, RETRIEVE_ATTRIBUTES: 0x1F81, TEST_CONNECTION: 0x0000,
};
const PARAM_CCSID = 13488; // los marcadores de parámetro se piden al cliente como VARCHAR UTF-16 (Db2 convierte implícitamente)
const PARAM_LEN = 8192;    // bytes (4096 caracteres)

// ---------- Utilidades ----------
const str = (b) => {
  if (!b || b.length < 2) return '';
  const ccsid = b.readUInt16BE(0);
  if (b.length >= 4) {
    const n = b.readUInt16BE(2);
    if (4 + n <= b.length) return decodeText(b.subarray(4, 4 + n), ccsid);
  }
  return decodeText(b.subarray(2), ccsid);
};
const str4 = (b) => (b && b.length >= 6 ? decodeText(b.subarray(6, 6 + b.readUInt32BE(2)), b.readUInt16BE(0)) : '');
const maskSql = (s) => s.replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));
const countMarkers = (sql) => (maskSql(sql).match(/\?/g) || []).length;
const isQuery = (sql) => /^\s*(\(\s*)*(SELECT|WITH|VALUES)\b/i.test(maskSql(sql));

/** Nomenclatura *SYS (BIB/TABLA) → SQL (BIB.TABLA), fuera de literales. */
function systemNaming(sql) {
  const m = maskSql(sql);
  let out = '';
  let last = 0;
  const re = /\b([A-Za-z#@$][\w#@$]{0,9})\/([A-Za-z#@$][\w#@$]*)/g;
  let x;
  while ((x = re.exec(m))) { out += sql.slice(last, x.index) + `${x[1]}.${x[2]}`; last = x.index + x[0].length; }
  return out + sql.slice(last);
}

// ---------- Descripción de columnas (formato extendido) ----------
function fieldOf(c, rows, i) {
  const t = String(c.type || 'VARCHAR').toUpperCase();
  const len = Number(c.length || 0);
  const maxData = () => rows.reduce((mx, r) => Math.max(mx, r[i] == null ? 0 : Buffer.byteLength(String(r[i]))), 1);
  switch (t) {
    case 'CHAR': case 'CHARACTER': case 'GRAPHIC': return { sql: 452, len: Math.max(1, len), ccsid: 37, kind: 'char', n: Math.max(1, len) };
    case 'VARCHAR': case 'VARGRAPHIC': case 'LONG VARCHAR': { const n = Math.min(32739, Math.max(1, len || maxData())); return { sql: 448, len: n + 2, ccsid: 37, kind: 'varchar', n }; }
    case 'CLOB': case 'DBCLOB': case 'XML': case 'LONG VARGRAPHIC': { const n = Math.min(32739, maxData()); return { sql: 448, len: n + 2, ccsid: 37, kind: 'varchar', n }; }
    case 'BLOB': case 'VARBINARY': case 'BINARY': { const n = Math.min(32739, Math.max(1, len || maxData())); return { sql: 448, len: n + 2, ccsid: 65535, kind: 'binary', n }; }
    case 'DECIMAL': case 'DEC': { const p = Math.max(1, Math.min(63, Number(c.precision || 15))); return { sql: 484, len: Math.floor(p / 2) + 1, prec: p, scale: Number(c.scale || 0), kind: 'packed' }; }
    case 'NUMERIC': { const p = Math.max(1, Math.min(63, Number(c.precision || 15))); return { sql: 488, len: p, prec: p, scale: Number(c.scale || 0), kind: 'zoned' }; }
    case 'INTEGER': case 'INT': return { sql: 496, len: 4, prec: 10, kind: 'int' };
    case 'SMALLINT': case 'BOOLEAN': return { sql: 500, len: 2, prec: 5, kind: 'int' };
    case 'BIGINT': return { sql: 492, len: 8, prec: 19, kind: 'int' };
    case 'REAL': return { sql: 480, len: 4, prec: 24, kind: 'float' };
    case 'DOUBLE': case 'FLOAT': case 'DECFLOAT': return { sql: 480, len: 8, prec: 53, kind: 'float' };
    case 'DATE': return { sql: 384, len: 10, ccsid: 37, kind: 'date' };
    case 'TIME': return { sql: 388, len: 8, ccsid: 37, kind: 'time' };
    case 'TIMESTAMP': return { sql: 392, len: 26, ccsid: 37, kind: 'timestamp' };
    default: { const n = Math.min(32739, Math.max(1, len || maxData())); return { sql: 448, len: n + 2, ccsid: 37, kind: 'varchar', n }; }
  }
}

function dataFormat(fields, names) {
  const b = Buffer.alloc(16 + fields.length * 64);
  b.writeInt32BE(1, 0);
  b.writeInt32BE(fields.length, 4);
  b.writeInt32BE(fields.reduce((s, f) => s + f.len, 0), 12);
  fields.forEach((f, i) => {
    const o = 16 + i * 64;
    b.writeUInt16BE(64, o);
    b.writeUInt16BE(f.sql | 1, o + 2); // siempre admite nulos
    b.writeUInt32BE(f.len, o + 4);
    b.writeUInt16BE(f.scale || 0, o + 8);
    b.writeUInt16BE(f.prec || 0, o + 10);
    b.writeUInt16BE(f.ccsid || 0, o + 12);
    b[o + 14] = f.paramType || 0;
    const nm = ebc(String(names[i] || '').slice(0, 30));
    b.writeUInt16BE(nm.length, o + 30);
    b.writeUInt16BE(37, o + 32);
    nm.copy(b, o + 34);
  });
  return b;
}

function encodeValue(f, v) {
  const b = Buffer.alloc(f.len);
  if (v === null || v === undefined) return b;
  switch (f.kind) {
    case 'char': ebc(String(v), f.n).copy(b); return b;
    case 'varchar': case 'binary': {
      const d = f.kind === 'binary' ? Buffer.from(String(v), 'latin1') : ebc(String(v));
      const n = Math.min(d.length, f.n);
      b.writeUInt16BE(n, 0);
      d.copy(b, 2, 0, n);
      return b;
    }
    case 'packed': packDecimal(v, f.prec, f.scale).copy(b); return b;
    case 'zoned': zonedDecimal(v, f.prec, f.scale).copy(b); return b;
    case 'int': if (f.len === 2) b.writeInt16BE(Number(v) | 0); else if (f.len === 8) b.writeBigInt64BE(BigInt(Math.trunc(Number(v) || 0))); else b.writeInt32BE(Number(v) | 0); return b;
    case 'float': if (f.len === 4) b.writeFloatBE(Number(v)); else b.writeDoubleBE(Number(v)); return b;
    case 'date': ebc(String(v).slice(0, 10), 10).copy(b); return b;
    case 'time': ebc(String(v).replace(/:/g, '.').slice(0, 8), 8).copy(b); return b;
    case 'timestamp': {
      const s = String(v).replace('T', ' ').replace('Z', '');
      const m = /^(\d{4}-\d{2}-\d{2})[ -](\d{2})[:.](\d{2})[:.](\d{2})(?:\.(\d+))?/.exec(s);
      ebc(m ? `${m[1]}-${m[2]}.${m[3]}.${m[4]}.${(m[5] || '').padEnd(6, '0').slice(0, 6)}` : s, 26).copy(b);
      return b;
    }
    default: ebc(String(v), f.len).copy(b); return b;
  }
}

function resultData(fields, rows) {
  const rowSize = fields.reduce((s, f) => s + f.len, 0);
  const head = Buffer.alloc(20);
  head.writeInt32BE(1, 0);
  head.writeInt32BE(rows.length, 4);
  head.writeUInt16BE(fields.length, 8);
  head.writeUInt16BE(2, 10);
  head.writeInt32BE(rowSize, 16);
  const ind = Buffer.alloc(rows.length * fields.length * 2);
  const data = [];
  rows.forEach((r, ri) => {
    fields.forEach((f, ci) => { if (r[ci] === null || r[ci] === undefined) ind.writeInt16BE(-1, (ri * fields.length + ci) * 2); });
    data.push(Buffer.concat(fields.map((f, ci) => encodeValue(f, r[ci]))));
  });
  return Buffer.concat([head, ind, ...data]);
}

// Datos de marcadores de parámetro enviados por el cliente (formato extendido 0x381F u original 0x3811)
function decodeParamData(buf, fields, extended) {
  if (!buf) return [];
  const rowCount = buf.readInt32BE(4);
  const cols = buf.readUInt16BE(8);
  const indSize = buf.readUInt16BE(10);
  const hdr = extended ? 20 : 14;
  const rowSize = extended ? buf.readInt32BE(16) : buf.readUInt16BE(12);
  const indOff = hdr;
  const dataOff = indOff + rowCount * cols * indSize;
  const out = [];
  for (let r = 0; r < Math.max(1, rowCount); r++) {
    const vals = [];
    let o = dataOff + r * rowSize;
    for (let c = 0; c < cols; c++) {
      const f = fields[c] || { kind: 'varchar', len: PARAM_LEN + 2, ccsid: PARAM_CCSID };
      const isNull = indSize && buf.readInt16BE(indOff + (r * cols + c) * indSize) < 0;
      const d = buf.subarray(o, o + f.len);
      o += f.len;
      if (isNull) { vals.push(null); continue; }
      if (f.kind === 'varchar') vals.push(decodeText(d.subarray(2, 2 + d.readUInt16BE(0)), f.ccsid));
      else if (f.kind === 'packed') vals.push(unpackDecimal(d, f.scale || 0));
      else if (f.kind === 'zoned') vals.push(unzonedDecimal(d, f.scale || 0));
      else if (f.kind === 'int') vals.push(f.len === 2 ? d.readInt16BE(0) : f.len === 8 ? Number(d.readBigInt64BE(0)) : d.readInt32BE(0));
      else if (f.kind === 'float') vals.push(f.len === 4 ? d.readFloatBE(0) : d.readDoubleBE(0));
      else vals.push(decodeText(d, f.ccsid || 37).trimEnd());
    }
    out.push(vals);
  }
  return out;
}

/** Lee un formato de datos extendido (16 + n * 64) enviado por el cliente. */
function parseFormat(b) {
  const n = b.readInt32BE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 16 + i * 64;
    if (o + 34 > b.length) break;
    const sql = b.readUInt16BE(o + 2) & 0xfffe;
    const len = b.readUInt32BE(o + 4);
    const scale = b.readUInt16BE(o + 8);
    const prec = b.readUInt16BE(o + 10);
    const ccsid = b.readUInt16BE(o + 12);
    const kind = sql === 448 || sql === 456 || sql === 464 ? 'varchar' : sql === 484 ? 'packed' : sql === 488 ? 'zoned' : [492, 496, 500].includes(sql) ? 'int' : sql === 480 ? 'float' : 'char';
    out.push({ sql, len, scale, prec, ccsid, kind, n: kind === 'varchar' ? len - 2 : len });
  }
  return out;
}

function paramFormat(n) {
  return Array.from({ length: n }, () => ({ sql: 448, len: PARAM_LEN + 2, ccsid: PARAM_CCSID, kind: 'varchar', n: PARAM_LEN, paramType: 0xf0 }));
}

// ---------- SQLCA y respuestas ----------
function sqlca({ sqlcode = 0, sqlstate = '00000', rows = 0, errmc = '', results = 0 } = {}) {
  const b = Buffer.alloc(136);
  ebc('SQLCA   ').copy(b, 0);
  b.writeInt32BE(136, 8);
  b.writeInt32BE(sqlcode, 12);
  const mc = ebc(String(errmc).slice(0, 70));
  b.writeInt16BE(mc.length, 16);
  mc.copy(b, 18);
  ebc('QSQ     ').copy(b, 88);
  b.writeInt32BE(0, 96);
  b.writeInt32BE(results, 100); // SQLERRD(2): conjuntos de resultados de un CALL
  b.writeInt32BE(rows, 104); // SQLERRD(3): filas afectadas / obtenidas
  ebc(String(sqlstate).padEnd(5).slice(0, 5)).copy(b, 131);
  return b;
}

function template(fn, errorClass = 0, rc = 0) {
  const t = Buffer.alloc(20);
  t.writeUInt16BE(fn, 10);
  t.writeUInt16BE(errorClass, 14);
  t.writeInt32BE(rc, 16);
  return t;
}

function serverAttributes(st) {
  const b = Buffer.alloc(118, 0);
  b.writeUInt16BE(5, 0); // fecha *ISO
  b.writeUInt16BE(1, 2); // separador '-'
  b.writeUInt16BE(2, 4); // hora *ISO
  b.writeUInt16BE(1, 6); // separador '.'
  b.writeUInt16BE(0, 8); // separador decimal '.'
  b.writeUInt16BE(st.db.naming, 10);
  b.writeUInt16BE(0, 12);
  b.writeUInt16BE(st.db.commitLevel, 14);
  b.writeUInt16BE(1, 16);
  b[18] = 0xf0;
  b.writeUInt16BE(37, 19);
  b.writeUInt16BE(0, 21);
  ebc('ENU').copy(b, 23);
  ebc('*HEX', 10).copy(b, 26);
  ebc('', 10).copy(b, 36);
  ebc('2924').copy(b, 46);
  ebc(`${SYS.release.slice(0, 6)}0010`).copy(b, 50); // nivel funcional: V7R5M00010
  ebc(SYS.name, 18).copy(b, 60);
  ebc(st.db.defaultLib || '*LIBL', 10).copy(b, 78);
  const [num, user, name] = qualifiedJob(st.ctx.job).split('/');
  ebc(`${name.padEnd(10).slice(0, 10)}${user.padEnd(10).slice(0, 10)}${num.padStart(6, '0')}`).copy(b, 88);
  const schema = ebc(st.db.defaultLib || '');
  b.writeUInt16BE(schema.length, 114);
  return Buffer.concat([b.subarray(0, 116), schema]);
}

// ---------- Ejecución ----------
async function runStatement(st, sql, params) {
  const text = st.db.naming === 1 ? systemNaming(sql) : sql;
  const U = maskSql(text).trim().toUpperCase();
  if (/^COMMIT\b/.test(U)) { const r = await st.ctx.commit(); return r?.error ? r : { columns: [], rows: [], rowCount: 0 }; }
  if (/^ROLLBACK\b/.test(U)) { const r = await st.ctx.rollback(); return r?.error ? r : { columns: [], rows: [], rowCount: 0 }; }
  if (/^SET\s+(SCHEMA|CURRENT\s+SCHEMA|PATH|CURRENT\s+PATH)\b/.test(U)) {
    const m = /=?\s*([A-Z#@$][\w#@$]*)\s*$/i.exec(text.trim());
    if (m && /SCHEMA/.test(U)) { st.db.defaultLib = m[1].toUpperCase(); st.ctx.job.curlib = st.db.defaultLib; }
    return { columns: [], rows: [], rowCount: 0 };
  }
  return st.ctx.sql(text, params);
}

function errorOf(r) {
  const code = Number(r.sqlcode ?? -901) || -901;
  return { sqlcode: code, sqlstate: r.sqlstate || '58004', text: String(r.error || 'SQL error').replace(/^SQL\d+N\s*/, ''), msgid: `SQL${String(Math.abs(code)).padStart(4, '0')}` };
}

export async function handleDatabase(st, f, write) {
  if (!st.db) {
    st.db = { rpbs: new Map(), naming: 0, commitLevel: 0, autocommit: true, defaultLib: st.ctx.job.curlib || '', lastError: null, blocking: 200 };
    st.onClose = () => { for (const r of st.db.rpbs.values()) r.cursor = null; };
  }
  const db = st.db;
  const fn = f.readUInt16BE(18);
  const serverId = f.readUInt16BE(6);
  const ors = f.readUInt32BE(20) >>> 0;
  const rpbId = f.readUInt16BE(34);
  let cps = parseCPs(f, 40);
  // Parámetros comprimidos con RLE (CP 0x3832: longitud descomprimida + datos)
  if (cps.has(0x3832)) {
    const z = cps.get(0x3832);
    cps = parseCPs(decompressRLE(z.subarray(4), z.readUInt32BE(0)), 0);
  }
  const wantReply = (ors & ORS.RETURN_DATA) !== 0;
  if (!db.rpbs.has(rpbId)) db.rpbs.set(rpbId, { sql: '', cursor: null, fields: null, names: null, pfields: [] });
  const rpb = db.rpbs.get(rpbId);
  const out = [];
  let errorClass = 0;
  let rc = 0;
  let ca = null;

  const fail = (r) => {
    const e = errorOf(r);
    db.lastError = e;
    errorClass = 2;
    rc = e.sqlcode;
    ca = { sqlcode: e.sqlcode, sqlstate: e.sqlstate, errmc: e.text };
  };
  const stmtText = () => {
    if (cps.has(0x3831)) return str4(cps.get(0x3831));
    if (cps.has(0x3807)) return str(cps.get(0x3807));
    return rpb.sql;
  };
  const params = () => {
    const pd = cps.get(0x381f) || cps.get(0x3811);
    if (!pd) return [[]];
    const pmd = f.readUInt16BE(36);
    const fmt = (pmd && db.descriptors?.get(pmd)) || (rpb.pfields.length ? rpb.pfields : paramFormat(countMarkers(rpb.sql)));
    return decodeParamData(pd, fmt, cps.has(0x381f));
  };
  const describe = (fields, names) => {
    if (ors & ORS.DATA_FORMAT) out.push([0x380c, dataFormat(fields, names)]);
  };
  const sendRows = () => {
    const c = rpb.cursor;
    const n = Math.max(1, Number(cps.has(0x380c) ? cps.get(0x380c).readUInt32BE(0) : db.blocking) || db.blocking);
    const rows = c.rows.slice(c.pos, c.pos + n);
    c.pos += rows.length;
    if (rows.length) out.push([0x380e, resultData(c.fields, rows)]);
    ca = { rows: rows.length };
    if (c.pos >= c.rows.length) { errorClass = rows.length ? 2 : 1; rc = rows.length ? 701 : 100; }
  };
  const open = async () => {
    const sql = stmtText();
    rpb.sql = sql || rpb.sql;
    const p = params()[0] || [];
    const r = await runStatement(st, rpb.sql, p);
    if (r.error) { fail(r); return false; }
    const fields = r.columns.map((c, i) => fieldOf(c, r.rows, i));
    rpb.fields = fields;
    rpb.names = r.columns.map((c) => c.name);
    rpb.cursor = { rows: r.rows, pos: 0, fields };
    describe(fields, rpb.names);
    return true;
  };

  tagConnection(st.conn, { detail: `SQL ${fn.toString(16)}` });
  if (process.env.HOSTSVR_TRACE) console.log(`[db] fn=${fn.toString(16)} rpb=${rpbId} ors=${ors.toString(16)} pmd=${f.readUInt16BE(36)} cps=${[...cps.keys()].map((k) => `${k.toString(16)}(${cps.get(k).length})`).join(',')}`);
  switch (fn) {
    case FN.SET_ATTRIBUTES: {
      if (cps.has(0x380c)) db.naming = cps.get(0x380c).readUInt16BE(0);
      if (cps.has(0x380f)) { db.defaultLib = str(cps.get(0x380f)).trim().toUpperCase(); if (db.defaultLib) st.ctx.job.curlib = db.defaultLib; }
      if (cps.has(0x380e)) db.commitLevel = cps.get(0x380e).readUInt16BE(0);
      if (cps.has(0x3824)) db.autocommit = cps.get(0x3824)[0] !== 0xd5;
      // Sin autocommit y con nivel de compromiso: control de compromiso real (una transacción en el gateway)
      const lvl = ['*NONE', '*CHG', '*CS', '*ALL', '*RR'][db.commitLevel] || '*NONE';
      if (!db.autocommit && lvl !== '*NONE' && !st.ctx.job.cmt) await st.ctx.startCommit(lvl);
      if (db.autocommit && st.ctx.job.cmt) await st.ctx.endCommit({ commit: true }).catch(() => {});
      if (ors & ORS.SERVER_ATTRIBUTES) out.push([0x3804, Buffer.concat([u16(0), serverAttributes(st)])]);
      break;
    }
    case FN.RETRIEVE_ATTRIBUTES: out.push([0x3804, Buffer.concat([u16(0), serverAttributes(st)])]); break;
    case FN.CREATE_RPB: case FN.CREATE_RPB_BASED_ON: case FN.CHANGE_RPB: case FN.RESET_RPB:
      if (cps.has(0x3807) || cps.has(0x3831)) rpb.sql = stmtText();
      break;
    case FN.DELETE_RPB: db.rpbs.delete(rpbId); break;
    case FN.CHANGE_DESCRIPTOR: // formato de marcadores que usará el cliente (formato de datos extendido)
      if (cps.has(0x381e)) { rpb.pfields = parseFormat(cps.get(0x381e)); db.descriptors = db.descriptors || new Map(); db.descriptors.set(f.readUInt16BE(36), rpb.pfields); }
      break;
    case FN.DELETE_DESCRIPTOR: break;
    case FN.PREPARE: case FN.PREPARE_DESCRIBE: case FN.DESCRIBE: case FN.DESCRIBE_PARM: {
      if (fn !== FN.DESCRIBE && fn !== FN.DESCRIBE_PARM) { rpb.sql = stmtText(); rpb.cursor = null; rpb.prefetched = null; }
      const n = countMarkers(rpb.sql);
      rpb.pfields = paramFormat(n);
      if ((ors & ORS.PARAMETER_MARKER_FORMAT) && n) out.push([0x380d, dataFormat(rpb.pfields, rpb.pfields.map((_, i) => `P${i + 1}`))]);
      if ((ors & ORS.DATA_FORMAT) && isQuery(rpb.sql)) {
        // Descripción: sin marcadores se ejecuta ya y el resultado se guarda para el OPEN siguiente
        const r = n ? await runStatement(st, `SELECT * FROM (${rpb.sql}) AS QZDA FETCH FIRST 0 ROWS ONLY`, Array(n).fill(null)) : await runStatement(st, rpb.sql, []);
        if (r.error && !n) { fail(r); break; }
        if (!r.error) {
          const fields = r.columns.map((c, i) => fieldOf(c, r.rows, i));
          if (!n) rpb.prefetched = { r, fields, at: Date.now() };
          rpb.fields = fields;
          rpb.names = r.columns.map((c) => c.name);
          describe(fields, rpb.names);
        }
      }
      break;
    }
    case FN.OPEN_DESCRIBE: case FN.OPEN_DESCRIBE_FETCH: case FN.EXECUTE_OPEN_DESCRIBE: {
 const pre = rpb.prefetched;
      rpb.prefetched = null;
      if (rpb.callResult && !cps.has(0x3807) && !cps.has(0x3831)) {
        // Conjunto de resultados devuelto por un CALL (procedimientos de metadatos SYSIBM.SQLTABLES…)
        rpb.cursor = rpb.callResult;
        rpb.callResult = null;
        describe(rpb.cursor.fields, rpb.cursor.names);
      } else if (pre && !cps.has(0x3807) && !cps.has(0x3831) && !cps.get(0x381f) && Date.now() - pre.at < 30000) {
        rpb.cursor = { rows: pre.r.rows, pos: 0, fields: pre.fields };
        describe(pre.fields, pre.r.columns.map((c) => c.name));
      } else if (!(await open())) break;
      if (fn === FN.OPEN_DESCRIBE_FETCH) sendRows();
      break;
    }
    case FN.FETCH:
      if (!rpb.cursor) { errorClass = 1; rc = 100; break; }
      sendRows();
      break;
    case FN.CLOSE: rpb.cursor = null; break;
    case FN.EXECUTE: case FN.EXECUTE_IMMEDIATE: case FN.PREPARE_EXECUTE: {
      if (fn !== FN.EXECUTE || cps.has(0x3807) || cps.has(0x3831)) rpb.sql = stmtText();
      if (fn !== FN.EXECUTE) rpb.pfields = paramFormat(countMarkers(rpb.sql));
      rpb.callResult = null;
      let total = 0;
      for (const p of params()) {
        const r = await runStatement(st, rpb.sql, p);
        if (r.error) { fail(r); break; }
        total += r.columns.length ? r.rows.length : r.rowCount;
        if (r.columns.length) {
          const fields = r.columns.map((c, i) => fieldOf(c, r.rows, i));
          rpb.callResult = { rows: r.rows, pos: 0, fields, names: r.columns.map((c) => c.name) };
        }
      }
      if (!errorClass) ca = { rows: rpb.callResult ? 0 : total, results: rpb.callResult ? 1 : 0 };
      break;
    }
    case FN.COMMIT: { const r = await st.ctx.commit(); if (r?.error) fail(r); break; }
    case FN.ROLLBACK: { const r = await st.ctx.rollback(); if (r?.error) fail(r); break; }
    case FN.SEND_RESULTS_SET: {
      // El cliente pide el mensaje del último error (id, texto y SQLCA)
      const e = db.lastError || { msgid: 'SQL0000', text: '', sqlcode: 0, sqlstate: '00000' };
      if (ors & ORS.MESSAGE_ID) out.push([0x3801, Buffer.concat([u16(37), ebc(e.msgid)])]);
      if (ors & ORS.FIRST_LEVEL) { const t = ebc(e.text); out.push([0x3802, Buffer.concat([u16(37), u16(t.length), t])]); }
      if (ors & ORS.SECOND_LEVEL) { const t = ebc(e.text); out.push([0x3803, Buffer.concat([u16(37), u16(t.length), t])]); }
      ca = { sqlcode: e.sqlcode, sqlstate: e.sqlstate, errmc: e.text };
      break;
    }
    case FN.DELETE_RESULTS_SET: case FN.END_STREAM_FETCH: case FN.CANCEL: case FN.RETURN_PACKAGE: case FN.TEST_CONNECTION: case FN.CONNECT: break;
    default:
      errorClass = 0;
  }
  if (!wantReply) return;
  if ((ors & ORS.SQLCA) || errorClass === 2) out.push([0x3807, sqlca(ca || {})]);
  if (errorClass === 2 && rc < 0 && (ors & ORS.MESSAGE_ID) && db.lastError) out.push([0x3801, Buffer.concat([u16(37), ebc(db.lastError.msgid)])]);
  if (errorClass === 2 && rc < 0 && (ors & ORS.FIRST_LEVEL) && db.lastError) { const t = ebc(db.lastError.text); out.push([0x3802, Buffer.concat([u16(37), u16(t.length), t])]); }
  write(reply(f, serverId, 0x2800, template(fn, errorClass, rc), out));
}

export { encodeText };
