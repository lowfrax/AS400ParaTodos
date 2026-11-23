// Acceso al "sistema de objetos" del IBM i almacenado en Db2.
import crypto from 'node:crypto';
import { createGateway } from '../../../shared/gateway.js';
import { describeFile, findObject as findCatalogObject, objectData, readMember, findMember } from '../../../shared/catalog.js';
import { CLError } from './messages.js';

export const gw = createGateway(process.env.GATEWAY_URL || 'http://localhost:5252', 'ibmi-core');
export { describeFile, objectData, readMember, findMember };

export const SYSTEM_LIBS = ['QSYS', 'QSYS2', 'QHLPSYS', 'QUSRSYS'];

/**
 * Busca un objeto en QSYS.OBJECTS. Una tabla o vista creada con SQL (también por DRDA/JDBC directo a Db2) es un *FILE
 * desde el momento en que existe, como en IBM i: si no se encuentra un *FILE se registran las tablas SQL de las
 * bibliotecas de usuario buscadas y se repite la búsqueda.
 */
export async function findObject(g, name, type, lib, libl = []) {
  const o = await findCatalogObject(g, name, type, lib, libl);
  if (o || type !== '*FILE') return o;
  const libs = (!lib || lib === '*LIBL' ? libl : [lib]).filter((l) => l && !SYSTEM_LIBS.includes(l));
  if (!libs.length) return null;
  for (const l of libs) await syncSqlTables(l).catch(() => {});
  return findCatalogObject(g, name, type, lib, libl);
}

/** Tras un DROP TABLE/VIEW por SQL el objeto *FILE deja de existir. */
export async function forgetSqlObject(lib, name) {
  await gw.exec(`DELETE FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = '*FILE' AND ATTR IN ('PF', 'PF-DTA', 'LF')`, [lib, name]).catch(() => {});
}
// Marca de tiempo en hora local del sistema (como QDATE/QTIME), formato Db2 'YYYY-MM-DD HH:MM:SS.ffffff'.
const now = () => {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000`;
};
export const ts = now;

const DDL = [
  `CREATE TABLE QSYS.OBJECTS (LIB VARCHAR(10) NOT NULL, NAME VARCHAR(10) NOT NULL, TYPE VARCHAR(10) NOT NULL,
     ATTR VARCHAR(10) NOT NULL DEFAULT '', TEXT VARCHAR(50) NOT NULL DEFAULT '', OWNER VARCHAR(10) NOT NULL DEFAULT 'QSYS',
     CREATED TIMESTAMP, CHANGED TIMESTAMP, OBJSIZE INTEGER NOT NULL DEFAULT 0, DATA CLOB(20M), PRIMARY KEY (LIB, NAME, TYPE))`,
  `CREATE TABLE QSYS.MEMBERS (LIB VARCHAR(10) NOT NULL, SRCF VARCHAR(10) NOT NULL, MBR VARCHAR(10) NOT NULL,
     TYPE VARCHAR(10) NOT NULL DEFAULT '', TEXT VARCHAR(50) NOT NULL DEFAULT '', CREATED TIMESTAMP, CHANGED TIMESTAMP,
     NLINES INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (LIB, SRCF, MBR))`,
  `CREATE TABLE QSYS.SOURCE (LIB VARCHAR(10) NOT NULL, SRCF VARCHAR(10) NOT NULL, MBR VARCHAR(10) NOT NULL,
     SEQ DECIMAL(6, 2) NOT NULL, DAT DECIMAL(6, 0) NOT NULL DEFAULT 0, SRCDTA VARCHAR(240) NOT NULL DEFAULT '',
     PRIMARY KEY (LIB, SRCF, MBR, SEQ))`,
  `CREATE TABLE QSYS.USRPRF (NAME VARCHAR(10) NOT NULL PRIMARY KEY, PWDHASH VARCHAR(128) NOT NULL DEFAULT '', PWDTOKEN VARCHAR(256) NOT NULL DEFAULT '',
     USRCLS VARCHAR(10) NOT NULL DEFAULT '*USER', TEXT VARCHAR(50) NOT NULL DEFAULT '', CURLIB VARCHAR(10) NOT NULL DEFAULT '*CRTDFT',
     INLMNU VARCHAR(10) NOT NULL DEFAULT 'MAIN', INLPGM VARCHAR(21) NOT NULL DEFAULT '*NONE', STATUS VARCHAR(10) NOT NULL DEFAULT '*ENABLED',
     CREATED TIMESTAMP, LASTSIGN TIMESTAMP, INVALID INTEGER NOT NULL DEFAULT 0, SIGNONS INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE QSYS.SPLF (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(10) NOT NULL, JOBNAME VARCHAR(10) NOT NULL,
     JOBUSER VARCHAR(10) NOT NULL, JOBNBR VARCHAR(6) NOT NULL, SPLNBR INTEGER NOT NULL, USRDTA VARCHAR(10) NOT NULL DEFAULT '',
     OUTQ VARCHAR(10) NOT NULL DEFAULT 'PRT01', STATUS VARCHAR(4) NOT NULL DEFAULT 'RDY', PAGES INTEGER NOT NULL DEFAULT 1,
     NLINES INTEGER NOT NULL DEFAULT 0, CREATED TIMESTAMP, DATA CLOB(20M))`,
  `CREATE TABLE QSYS.MSGQ (ID INTEGER NOT NULL PRIMARY KEY, QUEUE VARCHAR(10) NOT NULL, MSGID VARCHAR(7) NOT NULL DEFAULT '',
     MSGTYPE VARCHAR(10) NOT NULL DEFAULT '*INFO', SEV INTEGER NOT NULL DEFAULT 0, TEXT VARCHAR(512) NOT NULL DEFAULT '',
     FROMUSR VARCHAR(10) NOT NULL DEFAULT '', FROMJOB VARCHAR(28) NOT NULL DEFAULT '', SENT TIMESTAMP,
     REPLY VARCHAR(132) NOT NULL DEFAULT '', STATUS VARCHAR(10) NOT NULL DEFAULT 'NEW')`,
  `CREATE TABLE QSYS.SYSVAL (NAME VARCHAR(10) NOT NULL PRIMARY KEY, SVALUE VARCHAR(256) NOT NULL DEFAULT '', TEXT VARCHAR(50) NOT NULL DEFAULT '')`,
];

export const SYSVALS = [
  ['QMODEL', '42A', 'System model number'],
  ['QSRLNBR', '78A1B2C', 'System serial number'],
  ['QMAXSIGN', '3', 'Maximum sign-on attempts allowed'],
  ['QSECURITY', '40', 'System security level'],
  ['QPWDLVL', '0', 'Password level'],
  ['QDATFMT', 'MDY', 'Date format'],
  ['QDATSEP', '/', 'Date separator'],
  ['QTIMSEP', ':', 'Time separator'],
  ['QCCSID', '37', 'Coded character set identifier'],
  ['QLANGID', 'ENU', 'Language identifier'],
  ['QCNTRYID', 'US', 'Country or region identifier'],
  ['QSYSLIBL', 'QSYS QSYS2 QHLPSYS QUSRSYS', 'System part of the library list'],
  ['QUSRLIBL', 'QGPL QTEMP', 'User part of the library list'],
  ['QATNPGM', '*ASSIST', 'Attention program'],
  ['QINACTITV', '*NONE', 'Inactive job time-out'],
  ['QAUTOVRT', '0', 'Autoconfigure virtual devices'],
];

// Contadores de identificadores (spool / mensajes)
const counters = { SPLF: 0, MSGQ: 0 };
async function nextId(table) {
  if (!counters[table]) {
    const r = await gw.rows(`SELECT MAX(ID) AS M FROM QSYS.${table}`);
    counters[table] = Number(r[0]?.M || 0);
  }
  return ++counters[table];
}

export function hashPassword(user, pwd) {
  return crypto.createHash('sha256').update(`${user.toUpperCase()}:${String(pwd).toUpperCase()}:as400`).digest('hex');
}

// Token SHA-1 de IBM i (QPWDLVL 2/3) que usan los servidores host (jt400, ODBC, ACS): SHA1(usuario UTF-16BE de 10 + contraseña UTF-16BE).
// Las contraseñas del sistema no distinguen mayúsculas, así que se guardan las variantes MAYÚSCULAS, minúsculas y Capitalizada.
const utf16be = (s) => Buffer.from(String(s), 'utf16le').swap16();
export function shaPasswordToken(user, pwd) {
  return crypto.createHash('sha1').update(Buffer.concat([utf16be(String(user).toUpperCase().padEnd(10).slice(0, 10)), utf16be(String(pwd).trim())])).digest();
}
export function passwordTokens(user, pwd) {
  const p = String(pwd ?? '').trim();
  if (!p || p === '*NONE') return '';
  const variants = [...new Set([p.toUpperCase(), p.toLowerCase(), p[0].toUpperCase() + p.slice(1).toLowerCase(), p])];
  return variants.map((v) => shaPasswordToken(user, v).toString('hex')).join(',');
}

export async function initSchema() {
  const schemas = await gw.schemas();
  const names = new Set((Array.isArray(schemas) ? schemas : []).map((s) => s.name));
  for (const lib of ['QSYS', 'QSYS2', 'QHLPSYS', 'QUSRSYS', 'QGPL', 'QTEMP']) {
    if (!names.has(lib)) await gw.schema(lib).catch(() => {});
  }
  // Solo se crean las tablas del catálogo que falten: así un re-IPL no genera errores SQL0601N en el gateway.
  const existing = await gw.tables('QSYS');
  if (!Array.isArray(existing)) throw new Error(`catálogo no disponible: ${existing?.error}`);
  const have = new Set(existing.map((t) => t.name));
  const missing = DDL.filter((sql) => !have.has(/^CREATE TABLE QSYS\.(\w+)/.exec(sql)[1]));
  const r = missing.length ? await gw.batch(missing, ['42710']) : { results: [] };
  const bad = r.results.find((x) => !x.ok);
  if (bad) throw new Error(`Error creando catálogo del sistema: ${bad.error}`);
  // Migración: tokens SHA-1 de contraseña para los servidores host (versiones anteriores no tenían la columna)
  const cols = await gw.columns('QSYS', 'USRPRF');
  if (Array.isArray(cols) && !cols.some((c) => c.name === 'PWDTOKEN')) {
    const r = await gw.sql(`ALTER TABLE QSYS.USRPRF ADD COLUMN PWDTOKEN VARCHAR(256) NOT NULL DEFAULT ''`);
    if (r.error && r.sqlstate !== '42711') throw new Error(`QSYS.USRPRF: ${r.error}`);
  }
  for (const [name, value, text] of SYSVALS) {
    const ex = await gw.rows(`SELECT NAME FROM QSYS.SYSVAL WHERE NAME = ?`, [name]);
    if (!ex.length) await gw.exec(`INSERT INTO QSYS.SYSVAL (NAME, SVALUE, TEXT) VALUES (?, ?, ?)`, [name, value, text]);
  }
  for (const lib of ['QSYS', 'QSYS2', 'QHLPSYS', 'QUSRSYS', 'QGPL', 'QTEMP']) {
    await ensureLibObject(lib, { QSYS: 'System Library', QSYS2: 'System Library for CPI\'s', QHLPSYS: 'Help library', QUSRSYS: 'System Library for Users', QGPL: 'General Purpose Library', QTEMP: 'Temporary library' }[lib], lib.startsWith('Q') && lib !== 'QGPL' && lib !== 'QTEMP' ? 'QSYS' : 'QSYS');
  }
}

async function ensureLibObject(lib, text, owner = 'QSYS') {
  const ex = await gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'`, [lib]);
  if (!ex.length) {
    await gw.exec(`INSERT INTO QSYS.OBJECTS (LIB, NAME, TYPE, ATTR, TEXT, OWNER, CREATED, CHANGED) VALUES ('QSYS', ?, '*LIB', 'PROD', ?, ?, ?, ?)`,
      [lib, text || '', owner, now(), now()]);
  }
}

// ---------- Bibliotecas ----------
export async function libraries() {
  return gw.rows(`SELECT NAME, ATTR, TEXT, OWNER, CREATED FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND TYPE = '*LIB' ORDER BY NAME`);
}
export async function libExists(lib) {
  const r = await gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'`, [lib]);
  return r.length > 0;
}
export async function createLibrary(lib, text = '', type = 'PROD', owner = 'QSECOFR') {
  if (await libExists(lib)) throw new CLError('CPF2111', lib);
  const r = await gw.schema(lib);
  if (r.error && r.sqlstate !== '42710') throw new CLError('CPF9898', r.error);
  await gw.exec(`INSERT INTO QSYS.OBJECTS (LIB, NAME, TYPE, ATTR, TEXT, OWNER, CREATED, CHANGED) VALUES ('QSYS', ?, '*LIB', ?, ?, ?, ?, ?)`,
    [lib, type.replace('*', ''), text, owner, now(), now()]);
}
export async function deleteLibrary(lib) {
  if (!(await libExists(lib))) throw new CLError('CPF2110', lib);
  if (SYSTEM_LIBS.includes(lib) || lib === 'QGPL') throw new CLError('CPF2165', lib);
  await gw.schema(lib, true).catch(() => {});
  await gw.exec(`DELETE FROM QSYS.OBJECTS WHERE LIB = ?`, [lib]);
  await gw.exec(`DELETE FROM QSYS.MEMBERS WHERE LIB = ?`, [lib]);
  await gw.exec(`DELETE FROM QSYS.SOURCE WHERE LIB = ?`, [lib]);
  // Entradas de las colas de datos de la biblioteca (QSYS.DTAQE existe desde el IPL)
  await gw.sql(`DELETE FROM QSYS.DTAQE WHERE LIB = ?`, [lib]);
  await gw.exec(`DELETE FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'`, [lib]);
}
export async function clearLibrary(lib) {
  const objs = await listObjects(lib);
  for (const o of objs) await deleteObject(lib, o.NAME, o.TYPE);
}

// ---------- Objetos ----------
export async function listObjects(lib, name = '*ALL', type = '*ALL') {
  const cond = ['LIB = ?'];
  const params = [lib];
  if (name && name !== '*ALL') {
    if (name.endsWith('*')) { cond.push('NAME LIKE ?'); params.push(name.slice(0, -1) + '%'); } else { cond.push('NAME = ?'); params.push(name); }
  }
  if (type && type !== '*ALL') { cond.push('TYPE = ?'); params.push(type); }
  return gw.rows(`SELECT LIB, NAME, TYPE, ATTR, TEXT, OWNER, CREATED, CHANGED, OBJSIZE FROM QSYS.OBJECTS WHERE ${cond.join(' AND ')} ORDER BY NAME, TYPE`, params);
}

export async function putObject(lib, name, type, attr, text, data, owner = 'QSECOFR') {
  const json = data === undefined ? null : JSON.stringify(data);
  const ex = await gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [lib, name, type]);
  if (ex.length) {
    await gw.exec(`UPDATE QSYS.OBJECTS SET ATTR = ?, TEXT = ?, CHANGED = ?, OBJSIZE = ?, DATA = ? WHERE LIB = ? AND NAME = ? AND TYPE = ?`,
      [attr, text || '', now(), json ? json.length : 0, json, lib, name, type]);
  } else {
    await gw.exec(`INSERT INTO QSYS.OBJECTS (LIB, NAME, TYPE, ATTR, TEXT, OWNER, CREATED, CHANGED, OBJSIZE, DATA) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [lib, name, type, attr, text || '', owner, now(), now(), json ? json.length : 0, json]);
  }
}

export async function deleteObject(lib, name, type) {
  const o = await gw.rows(`SELECT ATTR FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [lib, name, type]);
  if (!o.length) throw new CLError('CPF2105', name, lib, type);
  if (type === '*FILE' && ['PF', 'PF-DTA'].includes(o[0].ATTR)) {
    // Como en IBM i, no se puede borrar un físico con lógicos que dependen de él
    const deps = await dependentLogicals(lib, name);
    if (deps.length) throw new CLError('CPF3220', name, lib, deps[0].NAME, deps[0].LIB);
    await gw.exec(`DROP TABLE ${lib}.${name}`).catch(() => {});
  }
  if (type === '*FILE' && o[0].ATTR === 'LF') await gw.exec(`DROP VIEW ${lib}.${name}`).catch(() => {});
  if (type === '*FILE' && o[0].ATTR === 'PF-SRC') {
    await gw.exec(`DELETE FROM QSYS.SOURCE WHERE LIB = ? AND SRCF = ?`, [lib, name]);
    await gw.exec(`DELETE FROM QSYS.MEMBERS WHERE LIB = ? AND SRCF = ?`, [lib, name]);
  }
  if (type === '*DTAQ') await gw.sql(`DELETE FROM QSYS.DTAQE WHERE LIB = ? AND NAME = ?`, [lib, name]);
  await gw.exec(`DELETE FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [lib, name, type]);
}

/** Archivos lógicos basados en un físico (DSPDBR). */
export async function dependentLogicals(lib, name) {
  const rows = await gw.rows(`SELECT LIB, NAME, DATA FROM QSYS.OBJECTS WHERE TYPE = '*FILE' AND ATTR = 'LF'`, []);
  return rows.filter((r) => {
    try { return (JSON.parse(r.DATA).pfiles || []).some((p) => p.file === name && (p.lib || r.LIB) === lib); } catch { return false; }
  });
}

export async function resolveObject(name, type, lib, libl) {
  const o = await findObject(gw, name, type, lib, libl);
  return o;
}

// Las tablas creadas con SQL aparecen como *FILE PF aunque no estén en QSYS.OBJECTS.
export async function syncSqlTables(lib) {
  const tables = await gw.tables(lib);
  if (!Array.isArray(tables)) return;
  const objs = await gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = ? AND TYPE = '*FILE'`, [lib]);
  const known = new Set(objs.map((o) => o.NAME));
  for (const t of tables) {
    if (!known.has(t.name) && t.name.length <= 10) {
      await gw.exec(`INSERT INTO QSYS.OBJECTS (LIB, NAME, TYPE, ATTR, TEXT, OWNER, CREATED, CHANGED) VALUES (?, ?, '*FILE', ?, ?, 'QSECOFR', ?, ?)`,
        [lib, t.name, t.type === 'VIEW' ? 'LF' : 'PF', t.text || '', now(), now()]).catch(() => {});
    }
  }
}

// ---------- Archivos fuente y miembros ----------
export async function createSourceFile(lib, file, rcdlen = 112, text = '') {
  if (!(await libExists(lib))) throw new CLError('CPF2110', lib);
  const ex = await gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = '*FILE'`, [lib, file]);
  if (ex.length) throw new CLError('CPF2112', file, lib, '*FILE');
  await putObject(lib, file, '*FILE', 'PF-SRC', text || 'Source physical file', { kind: 'SRCPF', rcdlen });
}

export async function listMembers(lib, file) {
  return gw.rows(`SELECT MBR, TYPE, TEXT, CREATED, CHANGED, NLINES FROM QSYS.MEMBERS WHERE LIB = ? AND SRCF = ? ORDER BY MBR`, [lib, file]);
}

export async function addMember(lib, file, mbr, type, text) {
  const ex = await gw.rows(`SELECT MBR FROM QSYS.MEMBERS WHERE LIB = ? AND SRCF = ? AND MBR = ?`, [lib, file, mbr]);
  if (ex.length) throw new CLError('CPF3213', mbr, file, lib);
  await gw.exec(`INSERT INTO QSYS.MEMBERS (LIB, SRCF, MBR, TYPE, TEXT, CREATED, CHANGED, NLINES) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [lib, file, mbr, type || '', text || '', now(), now()]);
}

export async function removeMember(lib, file, mbr) {
  await gw.exec(`DELETE FROM QSYS.SOURCE WHERE LIB = ? AND SRCF = ? AND MBR = ?`, [lib, file, mbr]);
  await gw.exec(`DELETE FROM QSYS.MEMBERS WHERE LIB = ? AND SRCF = ? AND MBR = ?`, [lib, file, mbr]);
}

export async function updateMemberInfo(lib, file, mbr, { type, text }) {
  await gw.exec(`UPDATE QSYS.MEMBERS SET TYPE = ?, TEXT = ?, CHANGED = ? WHERE LIB = ? AND SRCF = ? AND MBR = ?`, [type, text, now(), lib, file, mbr]);
}

/** Guarda las líneas de un miembro: [{seq, dat, text}] */
export async function writeMember(lib, file, mbr, lines) {
  await gw.exec(`DELETE FROM QSYS.SOURCE WHERE LIB = ? AND SRCF = ? AND MBR = ?`, [lib, file, mbr]);
  const stmts = lines.map((l) => ({
    sql: `INSERT INTO QSYS.SOURCE (LIB, SRCF, MBR, SEQ, DAT, SRCDTA) VALUES (?, ?, ?, ?, ?, ?)`,
    params: [lib, file, mbr, l.seq, l.dat || 0, (l.text || '').replace(/\s+$/, '')],
  }));
  for (let i = 0; i < stmts.length; i += 200) {
    const r = await gw.batch(stmts.slice(i, i + 200), []);
    const bad = r.results.find((x) => !x.ok);
    if (bad) throw new CLError('CPF9898', `Error saving member ${mbr}: ${bad.error}`);
  }
  await gw.exec(`UPDATE QSYS.MEMBERS SET CHANGED = ?, NLINES = ? WHERE LIB = ? AND SRCF = ? AND MBR = ?`, [now(), lines.length, lib, file, mbr]);
}

// ---------- Spool ----------
export async function createSpool(job, name, lines, { usrdta = '', outq = 'PRT01', pageLen = 60, hold = false } = {}) {
  outq = outq || 'PRT01';
  const id = await nextId('SPLF');
  job.spoolSeq = (job.spoolSeq || 0) + 1;
  const pages = Math.max(1, Math.ceil(lines.length / (pageLen || 60)));
  await gw.exec(`INSERT INTO QSYS.SPLF (ID, NAME, JOBNAME, JOBUSER, JOBNBR, SPLNBR, USRDTA, OUTQ, STATUS, PAGES, NLINES, CREATED, DATA)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${hold ? "'HLD'" : "'RDY'"}, ?, ?, ?, ?)`,
  [id, name.slice(0, 10), job.name, job.user, job.number, job.spoolSeq, usrdta.slice(0, 10), outq, pages, lines.length, now(), lines.join('\n')]);
  return id;
}
export async function listSpool(user) {
  const where = user && user !== '*ALL' ? 'WHERE JOBUSER = ?' : '';
  return gw.rows(`SELECT ID, NAME, JOBNAME, JOBUSER, JOBNBR, SPLNBR, USRDTA, OUTQ, STATUS, PAGES, NLINES, CREATED FROM QSYS.SPLF ${where} ORDER BY ID`, user && user !== '*ALL' ? [user] : []);
}
export async function spoolData(id) {
  const r = await gw.rows(`SELECT DATA FROM QSYS.SPLF WHERE ID = ?`, [id]);
  return r.length ? String(r[0].DATA || '').split('\n') : null;
}
export async function deleteSpool(id) { await gw.exec(`DELETE FROM QSYS.SPLF WHERE ID = ?`, [id]); }
export async function setSpoolStatus(id, st) { await gw.exec(`UPDATE QSYS.SPLF SET STATUS = ? WHERE ID = ?`, [st, id]); }

// ---------- Colas de mensajes ----------
export async function sendToQueue(queue, text, { msgid = '', type = '*INFO', sev = 0, from = 'QSYS', fromJob = '' } = {}) {
  const id = await nextId('MSGQ');
  await gw.exec(`INSERT INTO QSYS.MSGQ (ID, QUEUE, MSGID, MSGTYPE, SEV, TEXT, FROMUSR, FROMJOB, SENT, STATUS) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW')`,
    [id, queue, msgid, type, sev, String(text).slice(0, 512), from, fromJob, now()]);
  return id;
}
export async function queueMessages(queue) {
  return gw.rows(`SELECT ID, MSGID, MSGTYPE, SEV, TEXT, FROMUSR, FROMJOB, SENT, STATUS FROM QSYS.MSGQ WHERE QUEUE = ? ORDER BY ID`, [queue]);
}
export async function newMessageCount(queue) {
  const r = await gw.rows(`SELECT COUNT(*) AS N FROM QSYS.MSGQ WHERE QUEUE = ? AND STATUS = 'NEW'`, [queue]);
  return Number(r[0]?.N || 0);
}
export async function markQueueRead(queue) { await gw.exec(`UPDATE QSYS.MSGQ SET STATUS = 'OLD' WHERE QUEUE = ? AND STATUS = 'NEW'`, [queue]); }
export async function removeMessage(id) { await gw.exec(`DELETE FROM QSYS.MSGQ WHERE ID = ?`, [id]); }
export async function clearQueue(queue) { await gw.exec(`DELETE FROM QSYS.MSGQ WHERE QUEUE = ?`, [queue]); }

// ---------- Perfiles de usuario ----------
export async function getUser(name) {
  const r = await gw.rows(`SELECT * FROM QSYS.USRPRF WHERE NAME = ?`, [name]);
  return r[0] || null;
}
export async function listUsers() { return gw.rows(`SELECT NAME, USRCLS, TEXT, STATUS, CURLIB, LASTSIGN FROM QSYS.USRPRF ORDER BY NAME`); }
export async function createUser({ name, password, usrcls = '*USER', text = '', curlib = '*CRTDFT', inlmnu = 'MAIN', inlpgm = '*NONE' }) {
  if (await getUser(name)) throw new CLError('CPF2214', name, 'QSYS', '*USRPRF');
  await gw.exec(`INSERT INTO QSYS.USRPRF (NAME, PWDHASH, PWDTOKEN, USRCLS, TEXT, CURLIB, INLMNU, INLPGM, STATUS, CREATED) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '*ENABLED', ?)`,
    [name, password && password !== '*NONE' ? hashPassword(name, password) : '', password && password !== '*NONE' ? passwordTokens(name, password) : '', usrcls, text, curlib, inlmnu, inlpgm, now()]);
  await putObject('QSYS', name, '*USRPRF', '', text, undefined, 'QSECOFR');
  await putObject('QUSRSYS', name, '*MSGQ', '', `Message queue for ${name}`, undefined, name);
}
export async function updateUser(name, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await gw.exec(`UPDATE QSYS.USRPRF SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE NAME = ?`, [...keys.map((k) => fields[k]), name]);
}
export async function deleteUser(name) {
  await gw.exec(`DELETE FROM QSYS.USRPRF WHERE NAME = ?`, [name]);
  await gw.exec(`DELETE FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*USRPRF'`, [name]);
}

// ---------- Valores del sistema ----------
export async function sysval(name) {
  const r = await gw.rows(`SELECT SVALUE AS VALUE FROM QSYS.SYSVAL WHERE NAME = ?`, [name]);
  return r[0]?.VALUE ?? null;
}
export async function sysvals() { return gw.rows(`SELECT NAME, SVALUE AS VALUE, TEXT FROM QSYS.SYSVAL ORDER BY NAME`); }
export async function setSysval(name, value) { await gw.exec(`UPDATE QSYS.SYSVAL SET SVALUE = ? WHERE NAME = ?`, [value, name]); }
