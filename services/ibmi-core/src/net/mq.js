// IBM MQ para IBM i (simplificado): un gestor de colas interno (QM por omisión = nombre del sistema) persistente en Db2,
// expuesto por SQL (MQSEND/MQREAD/MQRECEIVE), mandatos CL (CRTMQMQ, DLTMQMQ, WRKMQMQ, PUTMQMSG/GETMQMSG),
// la API REST de mensajería de IBM MQ (/ibmmq/rest/v3/messaging/...) y WebSocket.
// Si MQ_REST_URL está definida (p. ej. https://mq:9443/ibmmq/rest/v3/messaging/qmgr/QM1), las colas se reenvían a un IBM MQ real.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { gw, ts } from '../objects.js';
import { SYS } from '../system.js';
import { CLError } from '../messages.js';

export const mqEvents = new EventEmitter();
mqEvents.setMaxListeners(200);

export const QMGR = () => (process.env.MQ_QMGR || `QM${SYS.name}`).slice(0, 48).toUpperCase();
const DEFAULT_QUEUE = 'DB2.DEFAULT.QUEUE';

const DDL = [
  `CREATE TABLE QSYS.MQQUEUE (QNAME VARCHAR(48) NOT NULL PRIMARY KEY, DESCR VARCHAR(64) NOT NULL DEFAULT '', MAXDEPTH INTEGER NOT NULL DEFAULT 5000,
     MAXMSGL INTEGER NOT NULL DEFAULT 4194304, QTYPE VARCHAR(8) NOT NULL DEFAULT '*LCL', CREATED TIMESTAMP, PUTCOUNT BIGINT NOT NULL DEFAULT 0, GETCOUNT BIGINT NOT NULL DEFAULT 0)`,
  `CREATE TABLE QSYS.MQMSG (QNAME VARCHAR(48) NOT NULL, SEQ BIGINT NOT NULL, MSGID VARCHAR(48) NOT NULL, CORRELID VARCHAR(48) NOT NULL DEFAULT '',
     PRIORITY INTEGER NOT NULL DEFAULT 0, FORMAT VARCHAR(8) NOT NULL DEFAULT 'MQSTR', PUTUSER VARCHAR(12) NOT NULL DEFAULT '', PUTTIME TIMESTAMP,
     REPLYTOQ VARCHAR(48) NOT NULL DEFAULT '', DATA CLOB(4M), PRIMARY KEY (QNAME, SEQ))`,
];
export const DEFAULT_QUEUES = [
  [DEFAULT_QUEUE, 'Cola por omision de MQSEND/MQRECEIVE'],
  ['SYSTEM.DEFAULT.LOCAL.QUEUE', 'Default local queue'],
  ['DEV.QUEUE.1', 'Cola de desarrollo 1'],
  ['DEV.QUEUE.2', 'Cola de desarrollo 2'],
  ['DEV.DEAD.LETTER.QUEUE', 'Cola de mensajes no entregables'],
  ['BANCO.TRANSFERENCIAS', 'Core bancario: transferencias entrantes'],
  ['BANCO.NOTIFICACIONES', 'Core bancario: eventos de cuentas'],
  ['BANCO.RESPUESTAS', 'Core bancario: respuestas'],
];

export async function initMq() {
  const t = await gw.tables('QSYS');
  if (!Array.isArray(t)) throw new Error(`catálogo no disponible: ${t?.error}`);
  for (const sql of DDL) {
    const name = /QSYS\.(\w+)/.exec(sql)[1];
    if (!t.some((x) => x.name === name)) { const r = await gw.sql(sql); if (r.error && r.sqlstate !== '42710') throw new Error(r.error); }
  }
  for (const [q, d] of DEFAULT_QUEUES) if (!(await queueInfo(q))) await createQueue(q, { descr: d });
}

const remote = () => (process.env.MQ_REST_URL || '').replace(/\/$/, '');
const remoteHeaders = () => ({
  'ibm-mq-rest-csrf-token': 'as400',
  Authorization: `Basic ${Buffer.from(`${process.env.MQ_USER || 'app'}:${process.env.MQ_PASSWORD || 'passw0rd'}`).toString('base64')}`,
});
const normQ = (q) => String(q || DEFAULT_QUEUE).trim().toUpperCase() === 'DB2.DEFAULT.SERVICE' ? DEFAULT_QUEUE : String(q || DEFAULT_QUEUE).trim().toUpperCase();

export async function createQueue(qname, { descr = '', maxdepth = 5000, maxmsgl = 4194304 } = {}) {
  const q = normQ(qname);
  if (!/^[A-Z0-9._%/]{1,48}$/.test(q)) throw new CLError('CPF9898', `AMQ8226: queue name ${q} not valid.`);
  if (await queueInfo(q)) throw new CLError('CPF9898', `AMQ8150: IBM MQ object ${q} already exists.`);
  await gw.exec(`INSERT INTO QSYS.MQQUEUE (QNAME, DESCR, MAXDEPTH, MAXMSGL, CREATED) VALUES (?, ?, ?, ?, ?)`, [q, String(descr).slice(0, 64), maxdepth, maxmsgl, ts()]);
}
export async function deleteQueue(qname, { purge = false } = {}) {
  const q = normQ(qname);
  if (!(await queueInfo(q))) throw new CLError('CPF9898', `AMQ8147: IBM MQ object ${q} not found.`);
  const depth = await queueDepth(q);
  if (depth && !purge) throw new CLError('CPF9898', `AMQ8143: IBM MQ queue ${q} not empty (${depth} messages).`);
  await gw.exec(`DELETE FROM QSYS.MQMSG WHERE QNAME = ?`, [q]);
  await gw.exec(`DELETE FROM QSYS.MQQUEUE WHERE QNAME = ?`, [q]);
}
export async function queueInfo(qname) {
  const r = await gw.rows(`SELECT * FROM QSYS.MQQUEUE WHERE QNAME = ?`, [normQ(qname)]);
  return r[0] || null;
}
export async function listQueues() {
  const rows = await gw.rows(`SELECT Q.QNAME, Q.DESCR, Q.MAXDEPTH, Q.CREATED, Q.PUTCOUNT, Q.GETCOUNT, (SELECT COUNT(*) FROM QSYS.MQMSG M WHERE M.QNAME = Q.QNAME) AS DEPTH FROM QSYS.MQQUEUE Q ORDER BY Q.QNAME`);
  return rows.map((r) => ({ name: r.QNAME, description: r.DESCR, maxDepth: Number(r.MAXDEPTH), depth: Number(r.DEPTH), created: r.CREATED, puts: Number(r.PUTCOUNT), gets: Number(r.GETCOUNT) }));
}
export async function queueDepth(q) {
  const r = await gw.rows(`SELECT COUNT(*) AS N FROM QSYS.MQMSG WHERE QNAME = ?`, [normQ(q)]);
  return Number(r[0]?.N || 0);
}

let seq = null;
const waiters = new Map();
const lock = { p: Promise.resolve() };
const serial = (fn) => { const p = lock.p.then(fn, fn); lock.p = p.catch(() => {}); return p; };

/** MQPUT. Devuelve {messageId, correlationId}. */
export async function mqSend(qname, data, { correlId = '', user = '', priority = 0, replyTo = '', format = 'MQSTR' } = {}) {
  const q = normQ(qname);
  const text = data === null || data === undefined ? '' : String(data);
  if (remote()) {
    const r = await fetch(`${remote()}/queue/${encodeURIComponent(q)}/message`, { method: 'POST', headers: { ...remoteHeaders(), 'Content-Type': 'text/plain;charset=utf-8', ...(correlId ? { 'ibm-mq-md-correlationId': correlId } : {}) }, body: text });
    if (!r.ok) throw new CLError('CPF9898', `IBM MQ REST ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { messageId: r.headers.get('ibm-mq-md-messageId') || '', correlationId: correlId };
  }
  const info = await queueInfo(q);
  if (!info) throw new CLError('CPF9898', `AMQ2085: MQRC_UNKNOWN_OBJECT_NAME (${q}).`);
  const messageId = crypto.randomBytes(24).toString('hex');
  const msg = { queue: q, messageId, correlationId: String(correlId || ''), data: text, putUser: user, putTime: new Date().toISOString(), priority, format, replyTo };
  // Entrega directa a un MQGET en espera
  const list = waiters.get(q) || [];
  const wi = list.findIndex((w) => !w.correlId || w.correlId === msg.correlationId);
  mqEvents.emit('put', msg);
  await gw.exec(`UPDATE QSYS.MQQUEUE SET PUTCOUNT = PUTCOUNT + 1 WHERE QNAME = ?`, [q]);
  if (wi >= 0) {
    const [w] = list.splice(wi, 1);
    await gw.exec(`UPDATE QSYS.MQQUEUE SET GETCOUNT = GETCOUNT + 1 WHERE QNAME = ?`, [q]);
    w.resolve(msg);
    return { messageId, correlationId: msg.correlationId };
  }
  const depth = await queueDepth(q);
  if (depth >= Number(info.MAXDEPTH)) throw new CLError('CPF9898', `AMQ2053: MQRC_Q_FULL (${q}).`);
  await serial(async () => {
    if (seq === null) { const r = await gw.rows(`SELECT MAX(SEQ) AS M FROM QSYS.MQMSG`); seq = Number(r[0]?.M || 0); }
    seq++;
    await gw.exec(`INSERT INTO QSYS.MQMSG (QNAME, SEQ, MSGID, CORRELID, PRIORITY, FORMAT, PUTUSER, PUTTIME, REPLYTOQ, DATA) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [q, seq, messageId, msg.correlationId.slice(0, 48), priority, format, String(user).slice(0, 12), ts(), replyTo, text]);
  });
  return { messageId, correlationId: msg.correlationId };
}

async function take(q, { correlId, messageId, browse }) {
  const where = ['QNAME = ?'];
  const p = [q];
  if (correlId) { where.push('CORRELID = ?'); p.push(correlId); }
  if (messageId) { where.push('MSGID = ?'); p.push(messageId); }
  const rows = await gw.rows(`SELECT SEQ, MSGID, CORRELID, PRIORITY, FORMAT, PUTUSER, PUTTIME, REPLYTOQ, DATA FROM QSYS.MQMSG WHERE ${where.join(' AND ')} ORDER BY PRIORITY DESC, SEQ FETCH FIRST 1 ROWS ONLY`, p);
  if (!rows.length) return null;
  const r = rows[0];
  if (!browse) {
    await gw.exec(`DELETE FROM QSYS.MQMSG WHERE QNAME = ? AND SEQ = ?`, [q, r.SEQ]);
    await gw.exec(`UPDATE QSYS.MQQUEUE SET GETCOUNT = GETCOUNT + 1 WHERE QNAME = ?`, [q]);
  }
  return { queue: q, messageId: r.MSGID, correlationId: r.CORRELID, data: String(r.DATA ?? ''), putUser: r.PUTUSER, putTime: r.PUTTIME, priority: Number(r.PRIORITY), format: r.FORMAT, replyTo: r.REPLYTOQ };
}

/** MQGET destructivo; wait en segundos (0 = no esperar). */
export async function mqReceive(qname, { wait = 0, correlId, messageId, signal } = {}) {
  const q = normQ(qname);
  if (remote()) {
    const qs = new URLSearchParams();
    if (wait) qs.set('wait', String(wait * 1000));
    if (correlId) qs.set('correlationId', correlId);
    const r = await fetch(`${remote()}/queue/${encodeURIComponent(q)}/message?${qs}`, { method: 'DELETE', headers: remoteHeaders() });
    if (r.status === 204) return null;
    if (!r.ok) throw new CLError('CPF9898', `IBM MQ REST ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { queue: q, messageId: r.headers.get('ibm-mq-md-messageId') || '', correlationId: r.headers.get('ibm-mq-md-correlationId') || '', data: await r.text() };
  }
  if (!(await queueInfo(q))) throw new CLError('CPF9898', `AMQ2085: MQRC_UNKNOWN_OBJECT_NAME (${q}).`);
  const m = await serial(() => take(q, { correlId, messageId }));
  if (m || !wait) return m;
  return new Promise((resolve) => {
    const w = { correlId, resolve: (x) => { clearTimeout(t); resolve(x); } };
    if (!waiters.has(q)) waiters.set(q, []);
    waiters.get(q).push(w);
    const drop = () => { const l = waiters.get(q) || []; const i = l.indexOf(w); if (i >= 0) l.splice(i, 1); resolve(null); };
    const t = wait > 0 ? setTimeout(drop, wait * 1000) : null;
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); drop(); }, { once: true });
  });
}

export async function mqBrowse(qname, { correlId, messageId } = {}) {
  const q = normQ(qname);
  if (remote()) {
    const r = await fetch(`${remote()}/queue/${encodeURIComponent(q)}/message${correlId ? `?correlationId=${encodeURIComponent(correlId)}` : ''}`, { headers: remoteHeaders() });
    if (r.status === 204) return null;
    return { queue: q, data: await r.text(), messageId: r.headers.get('ibm-mq-md-messageId') || '' };
  }
  return take(q, { correlId, messageId, browse: true });
}

export async function mqMessages(qname, limit = 200) {
  const rows = await gw.rows(`SELECT SEQ, MSGID, CORRELID, PRIORITY, PUTUSER, PUTTIME, DATA FROM QSYS.MQMSG WHERE QNAME = ? ORDER BY PRIORITY DESC, SEQ FETCH FIRST ${Number(limit)} ROWS ONLY`, [normQ(qname)]);
  return rows.map((r) => ({ messageId: r.MSGID, correlationId: r.CORRELID, priority: Number(r.PRIORITY), putUser: r.PUTUSER, putTime: r.PUTTIME, data: String(r.DATA ?? '') }));
}

export async function clearQueue(qname) { await gw.exec(`DELETE FROM QSYS.MQMSG WHERE QNAME = ?`, [normQ(qname)]); }
