// Diarios (journals) de IBM i sobre Db2:
//   *JRNRCV receptores, *JRN diarios (con su receptor conectado y la cadena de receptores), STRJRNPF/ENDJRNPF.
//   Cada archivo registrado en un diario tiene desencadenantes de Db2 que escriben las entradas en QSYS.JRNENT:
//   R/PT (grabación), R/UB y R/UP (antes/después de actualizar), R/DL (supresión), con usuario, trabajo y programa
//   (registros CLIENT_* que fija el gateway), así que también quedan registrados los cambios hechos por DRDA/JDBC.
//   Además: J/PR (receptor anterior al cambiar con CHGJRN), F/JM y F/EJ (inicio/fin del registro), U/xx (SNDJRNE).
import { gw, objectData, putObject, findObject } from './objects.js';
import { CLError } from './messages.js';
import { qualifiedJob } from './system.js';


const seqName = (lib, jrn) => `QSYS."JQ_${lib}_${jrn}"`;
const trigName = (file, op) => `"QJRN_${file}_${op}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---------- Archivos registrados (caché para SQL7008) ----------
let journaled = null;
export async function journaledFiles() {
  if (!journaled) {
    const rows = await gw.rows('SELECT LIB, FILE, JRNLIB, JRN, IMAGES FROM QSYS.JRNPF').catch(() => []);
    journaled = new Map(rows.map((r) => [`${r.LIB}/${r.FILE}`, r]));
  }
  return journaled;
}
export const invalidateJournaled = () => { journaled = null; };
export async function journalOf(lib, file) { return (await journaledFiles()).get(`${lib}/${file}`) || null; }

// ---------- Receptores y diarios ----------
export async function createReceiver(lib, name, { text = '', threshold = 1500000, owner } = {}) {
  if (await findObject(gw, name, '*JRNRCV', lib, [])) throw new CLError('CPF7010', name, lib);
  await putObject(lib, name, '*JRNRCV', '', text, { threshold, attached: null, created: new Date().toISOString(), firstSeq: null, lastSeq: null, detached: null }, owner);
}

export async function journalData(lib, name) {
  const d = await objectData(gw, lib, name, '*JRN').catch(() => null);
  if (!d) throw new CLError('CPF7002', name, lib);
  return d;
}

async function attach(lib, jrn, rcvLib, rcv) {
  const rd = await objectData(gw, rcvLib, rcv, '*JRNRCV');
  if (!rd) throw new CLError('CPF7019', rcv, rcvLib);
  if (rd.attached) throw new CLError('CPF7011', rcv, rcvLib);
  rd.attached = `${lib}/${jrn}`;
  const o = await findObject(gw, rcv, '*JRNRCV', rcvLib, []);
  await putObject(rcvLib, rcv, '*JRNRCV', '', o.TEXT, rd, o.OWNER);
  await gw.exec('DELETE FROM QSYS.JRNATT WHERE JRNLIB = ? AND JRN = ?', [lib, jrn]);
  await gw.exec('INSERT INTO QSYS.JRNATT (JRNLIB, JRN, RCVLIB, RCV) VALUES (?, ?, ?, ?)', [lib, jrn, rcvLib, rcv]);
}

export async function createJournal(lib, name, rcvLib, rcv, { text = '', owner } = {}) {
  if (await findObject(gw, name, '*JRN', lib, [])) throw new CLError('CPF7010', name, lib);
  const r = await gw.sql(`CREATE SEQUENCE ${seqName(lib, name)} AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE CACHE 20`);
  if (r.error && r.sqlstate !== '42710') throw new CLError('CPF9898', r.error);
  if (r.sqlstate === '42710' || !r.error) await gw.sql(`ALTER SEQUENCE ${seqName(lib, name)} RESTART WITH 1`);
  await putObject(lib, name, '*JRN', '', text, { receivers: [{ lib: rcvLib, name: rcv, attachedAt: new Date().toISOString() }], current: { lib: rcvLib, name: rcv } }, owner);
  await attach(lib, name, rcvLib, rcv);
}

/** Entrada escrita por el sistema (no por un desencadenante). */
export async function writeEntry(job, lib, jrn, code, type, { objLib = null, obj = null, data = null, pgm = null, tx = null, ccid = null } = {}) {
  const att = await gw.rows('SELECT RCVLIB, RCV FROM QSYS.JRNATT WHERE JRNLIB = ? AND JRN = ?', [lib, jrn]);
  await gw.exec(`INSERT INTO QSYS.JRNENT (JRNLIB, JRN, SEQ, CODE, ENTT, TS, JOB, USR, PGM, OBJLIB, OBJ, MBR, RCVLIB, RCV, DATA, CCID)
                 VALUES (?, ?, NEXT VALUE FOR ${seqName(lib, jrn)}, ?, ?, CURRENT TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [lib, jrn, code, type, job ? qualifiedJob(job) : null, job ? job.user : 'QSYS', pgm || (job ? job.name : 'QSYS'), objLib, obj, obj, att[0]?.RCVLIB || null, att[0]?.RCV || null, data === null ? null : typeof data === 'string' ? data : JSON.stringify(data), ccid], tx ? { tx } : undefined);
}

/** COMMIT: entrada C/CM en cada diario con cambios del ciclo de compromiso (dentro de la misma transacción). */
export async function commitEntries(job, tx) {
  const js = await gw.rows('SELECT DISTINCT JRNLIB, JRN FROM QSYS.JRNENT WHERE CCID = ?', [tx], { tx }).catch(() => []);
  for (const j of js) await writeEntry(job, j.JRNLIB, j.JRN, 'C', 'CM', { tx, ccid: tx });
}

/** Entradas del ciclo que se va a deshacer (antes del ROLLBACK de Db2). */
export async function pendingEntries(tx) {
  return (await gw.rows('SELECT JRNLIB, JRN, SEQ, CODE, ENTT, TS, JOB, USR, PGM, OBJLIB, OBJ, MBR, RCVLIB, RCV, DATA, CCID FROM QSYS.JRNENT WHERE CCID = ? ORDER BY SEQ', [tx], { tx }).catch(() => []))
    .map((r) => ({ ...r, DATA: r.DATA === null || r.DATA === undefined ? null : String(r.DATA) }));
}

/** Tras el ROLLBACK: como en IBM i, las entradas permanecen y se añaden las de retrotracción y C/RB. */
export async function rollbackEntries(job, tx, list) {
  if (!list.length) return;
  for (const e of list) {
    await gw.exec(`INSERT INTO QSYS.JRNENT (JRNLIB, JRN, SEQ, CODE, ENTT, TS, JOB, USR, PGM, OBJLIB, OBJ, MBR, RCVLIB, RCV, DATA, CCID) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.JRNLIB, e.JRN, e.SEQ, e.CODE, e.ENTT, e.TS, e.JOB, e.USR, e.PGM, e.OBJLIB, e.OBJ, e.MBR, e.RCVLIB, e.RCV, e.DATA, tx]).catch(() => {});
  }
  // DR = grabación deshecha; BR/UR = actualización deshecha (antes/después); PX = supresión deshecha (se vuelve a añadir)
  for (const e of [...list].reverse()) {
    if (e.CODE !== 'R') continue;
    const d = (() => { try { return JSON.parse(e.DATA); } catch { return null; } })();
    const opts = { objLib: e.OBJLIB, obj: e.OBJ, ccid: tx, pgm: e.PGM };
    if (e.ENTT === 'PT') await writeEntry(job, e.JRNLIB, e.JRN, 'R', 'DR', { ...opts, data: e.DATA });
    else if (e.ENTT === 'UP' && d) { await writeEntry(job, e.JRNLIB, e.JRN, 'R', 'BR', { ...opts, data: d.$after }); await writeEntry(job, e.JRNLIB, e.JRN, 'R', 'UR', { ...opts, data: d.$before }); }
    else if (e.ENTT === 'DL') await writeEntry(job, e.JRNLIB, e.JRN, 'R', 'PX', { ...opts, data: e.DATA });
  }
  for (const j of new Map(list.map((e) => [`${e.JRNLIB}/${e.JRN}`, e])).values()) await writeEntry(job, j.JRNLIB, j.JRN, 'C', 'RB', { ccid: tx });
}

/** En el IPL: vuelve a crear los desencadenantes de todos los archivos registrados (versión actual). */
export async function refreshTriggers() {
  const rows = await gw.rows('SELECT LIB, FILE, JRNLIB, JRN, IMAGES, OMTJRNE FROM QSYS.JRNPF').catch(() => []);
  for (const r of rows) await startJournal(null, r.LIB, r.FILE, r.JRNLIB, r.JRN, { images: r.IMAGES, omtjrne: r.OMTJRNE, refresh: true }).catch(() => {});
  return rows.length;
}

/** CHGJRN JRNRCV(*GEN|nombre) SEQOPT(*CONT|*RESET): conecta un receptor nuevo. */
export async function changeReceiver(job, lib, jrn, { rcvLib, rcv, reset = false }) {
  const d = await journalData(lib, jrn);
  const cur = d.current;
  if (!rcv) {
    // *GEN: incrementa el número final del nombre del receptor (QSQJRN0001 → QSQJRN0002)
    const m = /^(.*?)(\d+)$/.exec(cur.name);
    const base = m ? m[1] : cur.name.slice(0, 6);
    let n = m ? Number(m[2]) + 1 : 1;
    const width = m ? m[2].length : 4;
    rcvLib = cur.lib;
    do { rcv = `${base}${String(n).padStart(width, '0')}`.slice(-10); n++; } while (await findObject(gw, rcv, '*JRNRCV', rcvLib, []));
    await createReceiver(rcvLib, rcv, { text: `Receiver for journal ${jrn}` });
  }
  const last = await gw.rows('SELECT MAX(SEQ) AS S FROM QSYS.JRNENT WHERE JRNLIB = ? AND JRN = ?', [lib, jrn]);
  const curObj = await findObject(gw, cur.name, '*JRNRCV', cur.lib, []);
  const cd = (await objectData(gw, cur.lib, cur.name, '*JRNRCV')) || {};
  cd.attached = null;
  cd.detached = new Date().toISOString();
  cd.lastSeq = last[0]?.S ?? null;
  if (curObj) await putObject(cur.lib, cur.name, '*JRNRCV', '', curObj.TEXT, cd, curObj.OWNER);
  await attach(lib, jrn, rcvLib, rcv);
  if (reset) await gw.sql(`ALTER SEQUENCE ${seqName(lib, jrn)} RESTART WITH 1`);
  d.receivers.push({ lib: rcvLib, name: rcv, attachedAt: new Date().toISOString() });
  d.current = { lib: rcvLib, name: rcv };
  const jo = await findObject(gw, jrn, '*JRN', lib, []);
  await putObject(lib, jrn, '*JRN', '', jo.TEXT, d, jo.OWNER);
  await writeEntry(job, lib, jrn, 'J', 'PR', { data: { previous: `${cur.lib}/${cur.name}` } });
  return { rcvLib, rcv };
}

// ---------- STRJRNPF / ENDJRNPF ----------
async function columnsOf(lib, file) {
  const cols = await gw.columns(lib, file);
  if (!Array.isArray(cols) || !cols.length) throw new CLError('CPF7030', file, lib);
  return cols.filter((c) => !/LOB|XML|BINARY|GRAPHIC/i.test(String(c.type || '')));
}
const jsonOf = (alias, cols) => `JSON_OBJECT(${cols.map((c) => `KEY ${lit(c.name)} VALUE CAST(${alias}."${c.name}" AS VARCHAR(4000))`).join(', ')} NULL ON NULL)`;

export async function startJournal(job, lib, file, jrnLib, jrn, { images = '*AFTER', omtjrne = '*OPNCLO', refresh = false } = {}) {
  if (!refresh && (await journalOf(lib, file))) throw new CLError('CPF7030', file, lib);
  await journalData(jrnLib, jrn);
  const cols = await columnsOf(lib, file);
  const ins = (code, alias) => `INSERT INTO QSYS.JRNENT (JRNLIB, JRN, SEQ, CODE, ENTT, TS, JOB, USR, PGM, OBJLIB, OBJ, MBR, RCVLIB, RCV, DATA, CCID)
      SELECT ${lit(jrnLib)}, ${lit(jrn)}, NEXT VALUE FOR ${seqName(jrnLib, jrn)}, 'R', ${lit(code)}, CURRENT TIMESTAMP,
        NULLIF(CURRENT CLIENT_ACCTNG, ''), NULLIF(CURRENT CLIENT_USERID, ''), NULLIF(CURRENT CLIENT_APPLNAME, ''), ${lit(lib)}, ${lit(file)}, ${lit(file)},
        A.RCVLIB, A.RCV, ${alias}, NULLIF(CURRENT CLIENT_WRKSTNNAME, 'AS400TDS') FROM QSYS.JRNATT A WHERE A.JRNLIB = ${lit(jrnLib)} AND A.JRN = ${lit(jrn)}`;
  const tbl = `"${lib}"."${file}"`;
  const stmts = [
    `CREATE OR REPLACE TRIGGER "${lib}".${trigName(file, 'I')} AFTER INSERT ON ${tbl} REFERENCING NEW AS N FOR EACH ROW ${ins('PT', jsonOf('N', cols))}`,
    `CREATE OR REPLACE TRIGGER "${lib}".${trigName(file, 'D')} AFTER DELETE ON ${tbl} REFERENCING OLD AS O FOR EACH ROW ${ins('DL', jsonOf('O', cols))}`,
    // La imagen anterior va siempre dentro de la entrada UP (la necesitan APYJRNCHG/RMVJRNCHG); IMAGES(*BOTH) añade UB
    images === '*BOTH'
      ? `CREATE OR REPLACE TRIGGER "${lib}".${trigName(file, 'U')} AFTER UPDATE ON ${tbl} REFERENCING OLD AS O NEW AS N FOR EACH ROW BEGIN ATOMIC ${ins('UB', jsonOf('O', cols))}; ${ins('UP', `JSON_OBJECT(KEY '$after' VALUE ${jsonOf('N', cols)} FORMAT JSON, KEY '$before' VALUE ${jsonOf('O', cols)} FORMAT JSON)`)}; END`
      : `CREATE OR REPLACE TRIGGER "${lib}".${trigName(file, 'U')} AFTER UPDATE ON ${tbl} REFERENCING OLD AS O NEW AS N FOR EACH ROW ${ins('UP', `JSON_OBJECT(KEY '$after' VALUE ${jsonOf('N', cols)} FORMAT JSON, KEY '$before' VALUE ${jsonOf('O', cols)} FORMAT JSON)`)}`,
  ];
  for (const s of stmts) {
    const r = await gw.sql(s);
    if (r.error) throw new CLError('CPF9898', `Journaling not started for file ${file}: ${r.error}`);
  }
  if (refresh) return;
  await gw.exec('INSERT INTO QSYS.JRNPF (LIB, FILE, JRNLIB, JRN, IMAGES, OMTJRNE, STARTED) VALUES (?, ?, ?, ?, ?, ?, CURRENT TIMESTAMP)', [lib, file, jrnLib, jrn, images, omtjrne]);
  invalidateJournaled();
  await writeEntry(job, jrnLib, jrn, 'F', 'JM', { objLib: lib, obj: file });
}

export async function endJournal(job, lib, file) {
  const j = await journalOf(lib, file);
  if (!j) throw new CLError('CPF7032', file, lib);
  for (const op of ['I', 'D', 'U']) await gw.sql(`DROP TRIGGER "${lib}".${trigName(file, op)}`);
  await gw.exec('DELETE FROM QSYS.JRNPF WHERE LIB = ? AND FILE = ?', [lib, file]);
  invalidateJournaled();
  await writeEntry(job, j.JRNLIB, j.JRN, 'F', 'EJ', { objLib: lib, obj: file });
  return j;
}

// ---------- Entradas ----------
export async function entries(lib, jrn, { file = null, fromSeq = null, toSeq = null, codes = null, types = null, receivers = null, limit = 10000, order = 'ASC' } = {}) {
  const where = ['JRNLIB = ?', 'JRN = ?'];
  const p = [lib, jrn];
  if (file) { where.push('OBJLIB = ? AND OBJ = ?'); p.push(file.lib, file.name); }
  if (fromSeq) { where.push('SEQ >= ?'); p.push(fromSeq); }
  if (toSeq) { where.push('SEQ <= ?'); p.push(toSeq); }
  if (codes && codes.length) { where.push(`CODE IN (${codes.map(() => '?').join(', ')})`); p.push(...codes); }
  if (types && types.length) { where.push(`ENTT IN (${types.map(() => '?').join(', ')})`); p.push(...types); }
  if (receivers && receivers.length) { where.push(`(RCVLIB || '/' || RCV) IN (${receivers.map(() => '?').join(', ')})`); p.push(...receivers); }
  const rows = await gw.rows(`SELECT SEQ, CODE, ENTT, TS, JOB, USR, PGM, OBJLIB, OBJ, MBR, RCVLIB, RCV, DATA, CCID FROM QSYS.JRNENT WHERE ${where.join(' AND ')} ORDER BY SEQ ${order} FETCH FIRST ${Number(limit)} ROWS ONLY`, p);
  return rows.map((r) => ({ ...r, DATA: r.DATA === null || r.DATA === undefined ? null : String(r.DATA) }));
}

// ---------- APYJRNCHG / RMVJRNCHG ----------
function rowCond(cols, img) {
  const parts = [];
  const params = [];
  for (const c of cols) {
    const v = img[c.name];
    if (v === null || v === undefined) parts.push(`"${c.name}" IS NULL`);
    else { parts.push(`CAST("${c.name}" AS VARCHAR(4000)) = ?`); params.push(v); }
  }
  return { sql: parts.join(' AND '), params };
}
const parse = (d) => { try { return JSON.parse(d); } catch { return null; } };

/** Aplica (APYJRNCHG) o deshace (RMVJRNCHG) las entradas de registro de un archivo. Devuelve el número de cambios. */
export async function applyChanges(lib, file, list, { undo = false } = {}) {
  const cols = await columnsOf(lib, file);
  const tbl = `"${lib}"."${file}"`;
  const names = cols.map((c) => `"${c.name}"`).join(', ');
  const valsOf = (img) => cols.map((c) => (img[c.name] === undefined ? null : img[c.name]));
  let n = 0;
  // Las entradas de ciclos de compromiso deshechos (C/RB) no se aplican ni se deshacen (CMTBDY(*YES))
  const rb = new Set((await gw.rows("SELECT DISTINCT CCID FROM QSYS.JRNENT WHERE ENTT = 'RB' AND CCID IS NOT NULL").catch(() => [])).map((r) => r.CCID));
  const seq = (undo ? [...list].reverse() : list).filter((e) => !(e.CCID && rb.has(e.CCID)));
  for (const e of seq) {
    if (e.CODE !== 'R') continue;
    const d = parse(e.DATA);
    if (!d) continue;
    let r = null;
    if (e.ENTT === 'PT') {
      r = undo
        ? await (async () => { const w = rowCond(cols, d); return gw.sql(`DELETE FROM (SELECT * FROM ${tbl} WHERE ${w.sql} FETCH FIRST 1 ROWS ONLY)`, w.params); })()
        : await gw.sql(`INSERT INTO ${tbl} (${names}) VALUES (${cols.map(() => '?').join(', ')})`, valsOf(d));
    } else if (e.ENTT === 'DL') {
      r = undo
        ? await gw.sql(`INSERT INTO ${tbl} (${names}) VALUES (${cols.map(() => '?').join(', ')})`, valsOf(d))
        : await (async () => { const w = rowCond(cols, d); return gw.sql(`DELETE FROM (SELECT * FROM ${tbl} WHERE ${w.sql} FETCH FIRST 1 ROWS ONLY)`, w.params); })();
    } else if (e.ENTT === 'UP' && d.$before && d.$after) {
      const from = undo ? d.$after : d.$before;
      const to = undo ? d.$before : d.$after;
      const w = rowCond(cols, from);
      r = await gw.sql(`UPDATE (SELECT * FROM ${tbl} WHERE ${w.sql} FETCH FIRST 1 ROWS ONLY) SET ${cols.map((c) => `"${c.name}" = ?`).join(', ')}`, [...w.params, ...valsOf(to)]);
    } else continue;
    if (r && r.error) throw new CLError('CPF7049', file, lib, String(e.SEQ), r.error);
    n++;
  }
  return n;
}

// ---------- Esquemas SQL (CREATE SCHEMA): diario QSQJRN y registro automático de las tablas ----------
/** Crea QSQJRN/QSQJRN0001 en la biblioteca si no existen y registra (IMAGES(*BOTH)) las tablas aún no registradas. */
export async function ensureSqlJournal(job, lib, { journalExisting = true } = {}) {
  if (!(await findObject(gw, 'QSQJRN0001', '*JRNRCV', lib, [])) && !(await findObject(gw, 'QSQJRN', '*JRN', lib, []))) await createReceiver(lib, 'QSQJRN0001', { text: 'SQL journal receiver' });
  if (!(await findObject(gw, 'QSQJRN', '*JRN', lib, []))) await createJournal(lib, 'QSQJRN', lib, 'QSQJRN0001', { text: 'SQL journal' });
  const lo = await gw.rows("SELECT DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'", [lib]);
  const d = lo[0] && lo[0].DATA ? JSON.parse(lo[0].DATA) : {};
  if (!d.autoJournal) { d.autoJournal = 'QSQJRN'; d.sqlSchema = true; await gw.exec("UPDATE QSYS.OBJECTS SET DATA = ? WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'", [JSON.stringify(d), lib]); }
  if (!journalExisting) return;
  const files = await gw.rows("SELECT NAME FROM QSYS.OBJECTS WHERE LIB = ? AND TYPE = '*FILE' AND ATTR IN ('PF', 'PF-DTA')", [lib]);
  for (const f of files) if (!(await journalOf(lib, f.NAME))) await startJournal(job, lib, f.NAME, lib, 'QSQJRN', { images: '*BOTH' }).catch(() => {});
}

/** Tabla nueva en una biblioteca con diario automático (esquema SQL): se registra en su QSQJRN. */
export async function autoJournal(job, lib, file) {
  const lo = await gw.rows("SELECT DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'", [lib]).catch(() => []);
  const d = lo[0] && lo[0].DATA ? JSON.parse(lo[0].DATA) : {};
  if (!d.autoJournal || (await journalOf(lib, file))) return;
  await startJournal(job, lib, file, lib, d.autoJournal, { images: '*BOTH' }).catch(() => {});
}
