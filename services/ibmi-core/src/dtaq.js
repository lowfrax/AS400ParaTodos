// Colas de datos (*DTAQ): FIFO, LIFO o por clave, persistentes en Db2 (QSYS.DTAQE) y con espera bloqueante.
// Son el mecanismo clásico de integración entre programas RPG y aplicaciones externas (Java DataQueue, PHP, Node, Python…).
import { EventEmitter } from 'node:events';
import { gw, putObject, findObject, objectData, deleteObject, ts } from './objects.js';
import { CLError } from './messages.js';

export const dtaqEvents = new EventEmitter();
dtaqEvents.setMaxListeners(200);

const DDL = `CREATE TABLE QSYS.DTAQE (LIB VARCHAR(10) NOT NULL, NAME VARCHAR(10) NOT NULL, SEQ BIGINT NOT NULL,
  DKEY VARCHAR(256) NOT NULL DEFAULT '', DATA CLOB(1M), SENDER VARCHAR(80) NOT NULL DEFAULT '', ENQUEUED TIMESTAMP,
  PRIMARY KEY (LIB, NAME, SEQ))`;

export async function initDtaq() {
  const t = await gw.tables('QSYS');
  if (Array.isArray(t) && !t.some((x) => x.name === 'DTAQE')) {
    const r = await gw.sql(DDL);
    if (r.error && r.sqlstate !== '42710') throw new Error(`QSYS.DTAQE: ${r.error}`);
  }
}

const seqs = new Map();
async function nextSeq(lib, name) {
  const k = `${lib}/${name}`;
  if (!seqs.has(k)) {
    const r = await gw.rows(`SELECT MAX(SEQ) AS M FROM QSYS.DTAQE WHERE LIB = ? AND NAME = ?`, [lib, name]);
    seqs.set(k, Number(r[0]?.M || 0));
  }
  const n = seqs.get(k) + 1;
  seqs.set(k, n);
  return n;
}

// Serializa las operaciones de cada cola (recepción destructiva atómica).
const locks = new Map();
function withLock(k, fn) {
  const prev = locks.get(k) || Promise.resolve();
  const p = prev.then(fn, fn);
  locks.set(k, p.catch(() => {}));
  return p;
}

// Esperas pendientes: k -> [{filter, resolve}]
const waiters = new Map();

export async function createDtaq(lib, name, { maxlen = 100, seq = '*FIFO', keylen = 0, senderInfo = false, text = '', owner = 'QSECOFR', size = '*MAX16MB' } = {}) {
  if (await findObject(gw, name, '*DTAQ', lib, [])) throw new CLError('CPF2112', name, lib, '*DTAQ');
  if (seq === '*KEYED' && !(keylen > 0)) throw new CLError('CPF9898', 'KEYLEN must be specified for a keyed data queue.');
  await gw.sql(`DELETE FROM QSYS.DTAQE WHERE LIB = ? AND NAME = ?`, [lib, name]);
  seqs.delete(`${lib}/${name}`);
  await putObject(lib, name, '*DTAQ', '', text, { maxlen: Number(maxlen), seq, keylen: Number(keylen || 0), senderInfo: !!senderInfo, size }, owner);
}

export async function deleteDtaq(lib, name) {
  await deleteObject(lib, name, '*DTAQ');
  seqs.delete(`${lib}/${name}`);
}


/** Resuelve una cola (lib puede ser *LIBL/*CURLIB). Devuelve {lib, name, ...def}. */
export async function resolveDtaq(name, lib, libl = []) {
  const N = String(name).trim().toUpperCase();
  const L = String(lib || '*LIBL').trim().toUpperCase();
  const o = await findObject(gw, N, '*DTAQ', L === '*LIBL' || !L ? '*LIBL' : L, libl);
  if (!o) throw new CLError('CPF9801', N, L || '*LIBL');
  const d = (await objectData(gw, o.LIB, N, '*DTAQ')) || { maxlen: 64512, seq: '*FIFO', keylen: 0 };
  return { lib: o.LIB, name: N, text: o.TEXT, owner: o.OWNER, created: o.CREATED, ...d };
}

const keyCmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
function keyMatch(order, entryKey, key, keylen) {
  const e = String(entryKey).padEnd(keylen).slice(0, keylen);
  const k = String(key ?? '').padEnd(keylen).slice(0, keylen);
  const c = keyCmp(e, k);
  switch (String(order || 'EQ').toUpperCase().trim()) {
    case 'EQ': return c === 0;
    case 'NE': return c !== 0;
    case 'GT': return c > 0;
    case 'GE': return c >= 0;
    case 'LT': return c < 0;
    case 'LE': return c <= 0;
    default: return c === 0;
  }
}

export async function sendDtaq(q, data, { key = '', sender = '' } = {}) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
  if (Buffer.byteLength(text) > (q.maxlen || 64512)) throw new CLError('CPF9503', q.name, q.lib, q.maxlen);
  const k = `${q.lib}/${q.name}`;
  const dkey = q.seq === '*KEYED' ? String(key).padEnd(q.keylen).slice(0, q.keylen) : '';
  // Si hay un receptor esperando que acepta la entrada, se le entrega directamente (sin pasar por la tabla).
  const list = waiters.get(k) || [];
  const idx = list.findIndex((w) => !w.peek && (q.seq !== '*KEYED' || keyMatch(w.order, dkey, w.key, q.keylen)));
  const entry = { data: text, key: dkey, sender, enqueued: new Date().toISOString() };
  dtaqEvents.emit('send', { lib: q.lib, name: q.name, ...entry });
  if (idx >= 0) {
    const [w] = list.splice(idx, 1);
    w.resolve(entry);
    return { delivered: true };
  }
  await withLock(k, async () => {
    const seq = await nextSeq(q.lib, q.name);
    await gw.exec(`INSERT INTO QSYS.DTAQE (LIB, NAME, SEQ, DKEY, DATA, SENDER, ENQUEUED) VALUES (?, ?, ?, ?, ?, ?, ?)`, [q.lib, q.name, seq, dkey, text, String(sender).slice(0, 80), ts()]);
  });
  // Los que solo miran (peek) reciben la entrada sin consumirla.
  for (const w of list.filter((x) => x.peek)) { list.splice(list.indexOf(w), 1); w.resolve(entry); }
  return { delivered: false };
}

async function takeEntry(q, { order, key, peek }) {
  let where = 'LIB = ? AND NAME = ?';
  const params = [q.lib, q.name];
  if (q.seq === '*KEYED' && key !== undefined && key !== null) {
    const op = { EQ: '=', NE: '<>', GT: '>', GE: '>=', LT: '<', LE: '<=' }[String(order || 'EQ').toUpperCase().trim()] || '=';
    where += ` AND DKEY ${op} ?`;
    params.push(String(key).padEnd(q.keylen).slice(0, q.keylen));
  }
  const ord = q.seq === '*LIFO' ? 'SEQ DESC' : q.seq === '*KEYED' ? 'DKEY, SEQ' : 'SEQ';
  const rows = await gw.rows(`SELECT SEQ, DKEY, DATA, SENDER, ENQUEUED FROM QSYS.DTAQE WHERE ${where} ORDER BY ${ord} FETCH FIRST 1 ROWS ONLY`, params);
  if (!rows.length) return null;
  const r = rows[0];
  if (!peek) await gw.exec(`DELETE FROM QSYS.DTAQE WHERE LIB = ? AND NAME = ? AND SEQ = ?`, [q.lib, q.name, r.SEQ]);
  return { data: String(r.DATA ?? ''), key: r.DKEY, sender: r.SENDER, enqueued: r.ENQUEUED };
}

/**
 * Recibe una entrada. wait: segundos (0 = no esperar, <0 = esperar indefinidamente).
 * Devuelve {data, key, sender} o null si se agota el tiempo. opts.signal permite cancelar.
 */
export async function receiveDtaq(q, { wait = 0, order = 'EQ', key, peek = false, signal } = {}) {
  const k = `${q.lib}/${q.name}`;
  const got = await withLock(k, () => takeEntry(q, { order, key, peek }));
  if (got || !wait) return got;
  return new Promise((resolve) => {
    const w = { order, key, peek, resolve: (e) => { clearTimeout(t); resolve(e); } };
    if (!waiters.has(k)) waiters.set(k, []);
    waiters.get(k).push(w);
    const drop = () => { const l = waiters.get(k) || []; const i = l.indexOf(w); if (i >= 0) l.splice(i, 1); resolve(null); };
    const t = wait > 0 ? setTimeout(drop, wait * 1000) : null;
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); drop(); }, { once: true });
  });
}

export async function clearDtaq(q, { key, order = 'EQ' } = {}) {
  if (q.seq === '*KEYED' && key !== undefined && key !== null && key !== '') {
    const op = { EQ: '=', NE: '<>', GT: '>', GE: '>=', LT: '<', LE: '<=' }[String(order).toUpperCase()] || '=';
    return gw.exec(`DELETE FROM QSYS.DTAQE WHERE LIB = ? AND NAME = ? AND DKEY ${op} ?`, [q.lib, q.name, String(key).padEnd(q.keylen).slice(0, q.keylen)]);
  }
  return gw.exec(`DELETE FROM QSYS.DTAQE WHERE LIB = ? AND NAME = ?`, [q.lib, q.name]);
}

export async function dtaqEntries(q, limit = 500) {
  const ord = q.seq === '*LIFO' ? 'SEQ DESC' : q.seq === '*KEYED' ? 'DKEY, SEQ' : 'SEQ';
  const rows = await gw.rows(`SELECT SEQ, DKEY, DATA, SENDER, ENQUEUED FROM QSYS.DTAQE WHERE LIB = ? AND NAME = ? ORDER BY ${ord} FETCH FIRST ${Number(limit)} ROWS ONLY`, [q.lib, q.name]);
  return rows.map((r, i) => ({ ordinal: i + 1, seq: Number(r.SEQ), key: r.DKEY, data: String(r.DATA ?? ''), sender: r.SENDER, enqueued: r.ENQUEUED }));
}

export async function dtaqCount(q) {
  const r = await gw.rows(`SELECT COUNT(*) AS N FROM QSYS.DTAQE WHERE LIB = ? AND NAME = ?`, [q.lib, q.name]);
  return Number(r[0]?.N || 0);
}

export async function allDtaqs(lib) {
  const where = lib ? `AND LIB = ?` : '';
  return gw.rows(`SELECT LIB, NAME, TEXT, OWNER, CREATED, DATA FROM QSYS.OBJECTS WHERE TYPE = '*DTAQ' ${where} ORDER BY LIB, NAME`, lib ? [lib] : []);
}

export function waitingReceivers(lib, name) { return (waiters.get(`${lib}/${name}`) || []).length; }
