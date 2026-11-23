// Salvar y restaurar (SAVOBJ, SAVLIB, SAVCHGOBJ, SAVSECDTA / RSTOBJ, RSTLIB, RSTUSRPRF) en archivos de salvar (*SAVF).
// El contenido de un *SAVF (objetos, descripción completa de las tablas desde el catálogo de Db2, datos, miembros
// fuente, entradas de colas de datos y autorizaciones) se guarda comprimido en el IFS; FTP en binario lo transfiere.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { gw, objectData, putObject, findObject, libExists, createLibrary } from './objects.js';
import { CLError } from './messages.js';
import * as ifs from './ifs.js';
import { SYS, qualifiedJob } from './system.js';

export const savfPath = (lib, name) => `/QIBM/UserData/OS/SAVF/${lib}/${name}.savf`;
const SAVE_FORMAT = 'AS400TDS-SAVF-1';

// ---------- Archivos de salvar ----------
export async function createSavf(lib, name, text, owner) {
  if (await findObject(gw, name, '*FILE', lib, [])) throw new CLError('CPF7302', name, lib);
  await putObject(lib, name, '*FILE', 'SAVF', text, { kind: 'SAVF', path: savfPath(lib, name), entries: [], savedAt: null }, owner);
}
export async function savfInfo(lib, name) {
  const d = await objectData(gw, lib, name, '*FILE').catch(() => null);
  if (!d || d.kind !== 'SAVF') throw new CLError('CPF9812', name, lib);
  return d;
}
async function writeSavf(lib, name, content, info) {
  const p = ifs.real(savfPath(lib, name));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(content)));
  fs.writeFileSync(p, buf);
  const o = await findObject(gw, name, '*FILE', lib, []);
  await putObject(lib, name, '*FILE', 'SAVF', o.TEXT, { ...info, kind: 'SAVF', path: savfPath(lib, name), size: buf.length }, o.OWNER);
  await gw.exec('UPDATE QSYS.OBJECTS SET OBJSIZE = ? WHERE LIB = ? AND NAME = ? AND TYPE = ?', [buf.length, lib, name, '*FILE']);
}
export function readSavfContent(lib, name) {
  const p = ifs.real(savfPath(lib, name));
  if (!fs.existsSync(p)) return null;
  const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
  if (c.format !== SAVE_FORMAT) throw new CLError('CPF3782', `File ${name} in ${lib} does not contain save data.`);
  return c;
}
export async function clearSavf(lib, name) {
  const d = await savfInfo(lib, name);
  try { fs.unlinkSync(ifs.real(savfPath(lib, name))); } catch { /* vacío */ }
  const o = await findObject(gw, name, '*FILE', lib, []);
  await putObject(lib, name, '*FILE', 'SAVF', o.TEXT, { ...d, entries: [], savedAt: null, size: 0, header: null }, o.OWNER);
}
/** Bytes del SAVF (FTP binario) y su carga (PUT de un SAVF transferido). */
export function savfBytes(lib, name) {
  const p = ifs.real(savfPath(lib, name));
  return fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0);
}
export async function loadSavfBytes(lib, name, buf) {
  const c = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  if (c.format !== SAVE_FORMAT) throw new CLError('CPF3782', `Data is not a save file of this system (${SYS.name}).`);
  await writeSavf(lib, name, c, { entries: c.objects.map(entryOf), header: c.header, savedAt: c.header.savedAt });
}

// ---------- Descripción de tablas desde el catálogo de Db2 ----------
function colType(c) {
  const t = String(c.TYPENAME).trim().toUpperCase();
  switch (t) {
    case 'CHARACTER': return `CHAR(${c.LENGTH})`;
    case 'VARCHAR': return `VARCHAR(${c.LENGTH})`;
    case 'DECIMAL': return `DECIMAL(${c.LENGTH}, ${c.SCALE})`;
    case 'GRAPHIC': return `GRAPHIC(${c.LENGTH})`;
    case 'VARGRAPHIC': return `VARGRAPHIC(${c.LENGTH})`;
    case 'CLOB': case 'BLOB': case 'DBCLOB': return `${t}(${c.LENGTH})`;
    case 'TIMESTAMP': return `TIMESTAMP(${c.SCALE ?? 6})`;
    case 'DECFLOAT': return `DECFLOAT(${Number(c.LENGTH) === 8 ? 16 : 34})`;
    case 'BINARY': case 'VARBINARY': return `${t}(${c.LENGTH})`;
    default: return t;
  }
}
export async function describeTable(lib, name) {
  const cols = await gw.rows('SELECT TRIM(COLNAME) AS NAME, TYPENAME, LENGTH, SCALE, NULLS, DEFAULT, REMARKS FROM SYSCAT.COLUMNS WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY COLNO', [lib, name]);
  if (!cols.length) return null;
  const pk = await gw.rows("SELECT TRIM(K.COLNAME) AS NAME FROM SYSCAT.TABCONST T JOIN SYSCAT.KEYCOLUSE K ON K.CONSTNAME = T.CONSTNAME AND K.TABSCHEMA = T.TABSCHEMA AND K.TABNAME = T.TABNAME WHERE T.TABSCHEMA = ? AND T.TABNAME = ? AND T.TYPE = 'P' ORDER BY K.COLSEQ", [lib, name]);
  const idx = await gw.rows("SELECT TRIM(INDNAME) AS NAME, UNIQUERULE, COLNAMES FROM SYSCAT.INDEXES WHERE TABSCHEMA = ? AND TABNAME = ? AND UNIQUERULE <> 'P' AND INDSCHEMA = TABSCHEMA", [lib, name]);
  const t = await gw.rows('SELECT REMARKS, TYPE FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TABNAME = ?', [lib, name]);
  const defs = cols.map((c) => `"${c.NAME}" ${colType(c)}${c.NULLS === 'N' ? ' NOT NULL' : ''}${c.DEFAULT !== null && c.DEFAULT !== undefined && String(c.DEFAULT).trim() !== '' ? ` DEFAULT ${String(c.DEFAULT).trim()}` : ''}`);
  if (pk.length) defs.push(`PRIMARY KEY (${pk.map((k) => `"${k.NAME}"`).join(', ')})`);
  return {
    columns: cols.map((c) => ({ name: c.NAME, type: colType(c), remarks: c.REMARKS })),
    ddl: `CREATE TABLE "{LIB}"."${name}" (${defs.join(', ')})`,
    indexes: idx.map((i) => ({ name: i.NAME, unique: i.UNIQUERULE === 'U', cols: String(i.COLNAMES).match(/[+-][^+-]+/g).map((x) => `"${x.slice(1)}"${x[0] === '-' ? ' DESC' : ''}`) })),
    remarks: t[0]?.REMARKS || null,
  };
}
async function viewText(lib, name) {
  const v = await gw.rows('SELECT TEXT FROM SYSCAT.VIEWS WHERE VIEWSCHEMA = ? AND VIEWNAME = ?', [lib, name]);
  return v[0] ? String(v[0].TEXT) : null;
}

// ---------- Salvar ----------
const entryOf = (o) => ({ lib: o.lib, name: o.name, type: o.type, attr: o.attr, text: o.text, owner: o.owner, size: o.size || 0, rows: o.table ? o.table.rows.length : undefined });

async function saveObject(row, { pvtaut = false } = {}) {
  const lib = row.LIB;
  const out = { lib, name: row.NAME, type: row.TYPE, attr: row.ATTR || '', text: row.TEXT || '', owner: row.OWNER, created: row.CREATED, changed: row.CHANGED, data: row.DATA ? JSON.parse(row.DATA) : null };
  if (row.TYPE === '*FILE' && ['PF', 'PF-DTA'].includes(row.ATTR)) {
    const t = await describeTable(lib, row.NAME);
    if (t) {
      const r = await gw.sql(`SELECT * FROM "${lib}"."${row.NAME}"`);
      out.table = { ...t, rows: r.rows || [] };
      const j = await gw.rows('SELECT JRNLIB, JRN, IMAGES FROM QSYS.JRNPF WHERE LIB = ? AND FILE = ?', [lib, row.NAME]);
      if (j[0]) {
        out.journal = j[0];
        const s = await gw.rows('SELECT MAX(SEQ) AS S FROM QSYS.JRNENT WHERE JRNLIB = ? AND JRN = ?', [j[0].JRNLIB, j[0].JRN]);
        out.journal.lastSaveSeq = s[0]?.S ?? 0;
      }
    }
  } else if (row.TYPE === '*FILE' && row.ATTR === 'LF') {
    out.view = await viewText(lib, row.NAME);
  } else if (row.TYPE === '*FILE' && row.ATTR === 'PF-SRC') {
    out.members = [];
    for (const m of await gw.rows('SELECT MBR, TYPE, TEXT FROM QSYS.MEMBERS WHERE LIB = ? AND SRCF = ? ORDER BY MBR', [lib, row.NAME])) {
      const lines = await gw.rows('SELECT SEQ, DAT, SRCDTA FROM QSYS.SOURCE WHERE LIB = ? AND SRCF = ? AND MBR = ? ORDER BY SEQ', [lib, row.NAME, m.MBR]);
      out.members.push({ mbr: m.MBR, type: m.TYPE, text: m.TEXT, lines: lines.map((l) => [l.SEQ, l.DAT, l.SRCDTA]) });
    }
  } else if (row.TYPE === '*FILE' && row.ATTR === 'SAVF') {
    try { out.savf = savfBytes(lib, row.NAME).toString('base64'); } catch { /* vacío */ }
  } else if (row.TYPE === '*DTAQ') {
    out.entries = (await gw.rows('SELECT SEQ, DKEY, DATA, SENDER, ENQUEUED FROM QSYS.DTAQE WHERE LIB = ? AND NAME = ? ORDER BY SEQ', [lib, row.NAME]).catch(() => [])).map((e) => ({ ...e, DATA: e.DATA === null ? null : String(e.DATA) }));
  }
  const auts = await gw.rows('SELECT USR, AUT FROM QSYS.OBJAUT WHERE LIB = ? AND NAME = ? AND TYPE = ?', [lib, row.NAME, row.TYPE]).catch(() => []);
  // *PUBLIC y la lista de autorizaciones siempre; las privadas con PVTAUT(*YES)
  out.auth = auts.filter((a) => pvtaut || a.USR === '*PUBLIC' || a.USR === '*AUTL');
  out.size = JSON.stringify(out).length;
  return out;
}

/**
 * Salva objetos de una biblioteca en un *SAVF. sel = { names: ['*ALL'|nombre|genérico*], types: ['*ALL'|tipo], changedSince }.
 * Devuelve { count, skipped }.
 */
export async function saveToSavf(job, lib, sel, savfLib, savfName, { clear = '*NONE', pvtaut = false, cmd = 'SAVOBJ', libDesc = false, append = false } = {}) {
  const info = await savfInfo(savfLib, savfName);
  if (info.entries && info.entries.length && clear === '*NONE' && !append) throw new CLError('CPF3782', `Save file ${savfName} in ${savfLib} already contains data; specify CLEAR(*ALL).`);
  if (!(await libExists(lib))) throw new CLError('CPF2110', lib);
  // Las tablas y vistas creadas por SQL (o por DRDA/JDBC) son objetos *FILE aunque aún no estén en el catálogo
  await (await import('./objects.js')).syncSqlTables(lib).catch(() => {});
  const rows = await gw.rows('SELECT LIB, NAME, TYPE, ATTR, TEXT, OWNER, CREATED, CHANGED, DATA FROM QSYS.OBJECTS WHERE LIB = ? ORDER BY TYPE, NAME', [lib]);
  const names = sel.names.map((x) => String(x).toUpperCase());
  const types = sel.types.map((x) => String(x).toUpperCase());
  const match = (r) => (names.includes('*ALL') || names.includes(r.NAME) || names.some((n) => n.endsWith('*') && r.NAME.startsWith(n.slice(0, -1))))
    && (types.includes('*ALL') || types.includes(r.TYPE))
    && !(r.LIB === savfLib && r.NAME === savfName && r.TYPE === '*FILE')
    && (!sel.changedSince || new Date(String(r.CHANGED).replace(' ', 'T')) > sel.changedSince);
  const objs = [];
  for (const r of rows.filter(match)) objs.push(await saveObject(r, { pvtaut }));
  if (!objs.length && !libDesc) throw new CLError('CPF3770', lib);
  const prev = append && info.entries && info.entries.length ? readSavfContent(savfLib, savfName) : null;
  const libRow = (await gw.rows("SELECT NAME, ATTR, TEXT, OWNER, DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'", [lib]))[0];
  const header = { release: SYS.release || 'V7R5M0', system: SYS.name, savedAt: new Date().toISOString(), savedBy: job ? job.user : 'QSYS', job: job ? qualifiedJob(job) : '', cmd, lib };
  const content = { format: SAVE_FORMAT, header, library: libDesc ? { name: lib, attr: libRow.ATTR, text: libRow.TEXT, owner: libRow.OWNER, data: libRow.DATA ? JSON.parse(libRow.DATA) : null } : prev?.library || null, objects: [...(prev ? prev.objects : []), ...objs] };
  await writeSavf(savfLib, savfName, content, { entries: content.objects.map(entryOf), header, savedAt: header.savedAt });
  // Fecha del último salvado de la biblioteca (SAVCHGOBJ REFDATE(*SAVLIB)) y secuencia de diario de cada archivo
  const ld = libRow.DATA ? JSON.parse(libRow.DATA) : {};
  ld.lastSave = header.savedAt;
  ld.lastSaveSavf = `${savfLib}/${savfName}`;
  await gw.exec("UPDATE QSYS.OBJECTS SET DATA = ? WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'", [JSON.stringify(ld), lib]);
  for (const o of objs) {
    if (!o.journal) continue;
    const d = o.data || {};
    d.lastSaveSeq = o.journal.lastSaveSeq;
    await gw.exec("UPDATE QSYS.OBJECTS SET DATA = ? WHERE LIB = ? AND NAME = ? AND TYPE = '*FILE'", [JSON.stringify(d), o.lib, o.name]);
  }
  return { count: objs.length };
}

// ---------- Restaurar ----------
const replaceLib = (sql, from, to) => (from === to ? sql : String(sql).replace(new RegExp(`"?\\b${from}\\b"?\\s*\\.`, 'gi'), `"${to}".`));

async function dropExisting(lib, o) {
  if (o.type === '*FILE' && ['PF', 'PF-DTA', 'LF'].includes(o.attr)) {
    await gw.sql(`DROP ${o.attr === 'LF' ? 'VIEW' : 'TABLE'} "${lib}"."${o.name}"`);
    await gw.sql('DELETE FROM QSYS.JRNPF WHERE LIB = ? AND FILE = ?', [lib, o.name]);
  }
  if (o.type === '*FILE' && o.attr === 'PF-SRC') {
    await gw.exec('DELETE FROM QSYS.MEMBERS WHERE LIB = ? AND SRCF = ?', [lib, o.name]);
    await gw.exec('DELETE FROM QSYS.SOURCE WHERE LIB = ? AND SRCF = ?', [lib, o.name]);
  }
  if (o.type === '*DTAQ') await gw.sql('DELETE FROM QSYS.DTAQE WHERE LIB = ? AND NAME = ?', [lib, o.name]);
  await gw.exec('DELETE FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = ?', [lib, o.name, o.type]);
}

async function restoreObject(job, o, lib, { mbropt = '*MATCH' } = {}) {
  const exists = await gw.rows('SELECT OWNER FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = ?', [lib, o.name, o.type]);
  const isData = o.type === '*FILE' && o.table;
  if (exists.length && isData && mbropt === '*NEW') return 'skipped';
  if (!exists.length && isData && mbropt === '*OLD') return 'skipped';
  if (exists.length) await dropExisting(lib, o);
  // Propietario: el original si existe en el sistema
  const ownerOk = (await gw.rows('SELECT NAME FROM QSYS.USRPRF WHERE NAME = ?', [o.owner])).length;
  const owner = ownerOk ? o.owner : 'QSECOFR';
  if (o.table) {
    const r = await gw.sql(o.table.ddl.replace('{LIB}', lib));
    if (r.error) throw new CLError('CPF3773', o.name, lib, r.error);
    for (const i of o.table.indexes || []) await gw.sql(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX "${lib}"."${i.name}" ON "${lib}"."${o.name}" (${i.cols.join(', ')})`);
    if (o.table.remarks) await gw.sql(`COMMENT ON TABLE "${lib}"."${o.name}" IS '${String(o.table.remarks).replace(/'/g, "''")}'`);
    const cols = o.table.columns.map((c) => `"${c.name}"`).join(', ');
    const marks = o.table.columns.map(() => '?').join(', ');
    const stmts = o.table.rows.map((row) => ({ sql: `INSERT INTO "${lib}"."${o.name}" (${cols}) VALUES (${marks})`, params: row }));
    for (let i = 0; i < stmts.length; i += 250) {
      const b = await gw.batch(stmts.slice(i, i + 250), []);
      const bad = b.results && b.results.find((x) => !x.ok);
      if (bad) throw new CLError('CPF3773', o.name, lib, bad.error);
    }
  }
  if (o.view) {
    const r = await gw.sql(replaceLib(o.view, o.lib, lib));
    if (r.error) throw new CLError('CPF3773', o.name, lib, r.error);
  }
  const data = o.data ? { ...o.data } : null;
  if (o.type === '*FILE' && o.attr === 'SAVF') { if (data) data.path = savfPath(lib, o.name); }
  if (data && o.journal) { data.lastSaveSeq = o.journal.lastSaveSeq; }
  await gw.exec('INSERT INTO QSYS.OBJECTS (LIB, NAME, TYPE, ATTR, TEXT, OWNER, CREATED, CHANGED, OBJSIZE, DATA) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [lib, o.name, o.type, o.attr, o.text, owner, o.created || null, o.changed || null, o.size || 0, data ? JSON.stringify(data) : null]);
  if (o.members) {
    for (const m of o.members) {
      await gw.exec('INSERT INTO QSYS.MEMBERS (LIB, SRCF, MBR, TYPE, TEXT, CREATED, CHANGED, NLINES) VALUES (?, ?, ?, ?, ?, CURRENT TIMESTAMP, CURRENT TIMESTAMP, ?)', [lib, o.name, m.mbr, m.type, m.text, m.lines.length]);
      const st = m.lines.map(([seq, dat, src]) => ({ sql: 'INSERT INTO QSYS.SOURCE (LIB, SRCF, MBR, SEQ, DAT, SRCDTA) VALUES (?, ?, ?, ?, ?, ?)', params: [lib, o.name, m.mbr, seq, dat, src] }));
      for (let i = 0; i < st.length; i += 250) await gw.batch(st.slice(i, i + 250), []);
    }
  }
  if (o.savf) {
    const p = ifs.real(savfPath(lib, o.name));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(o.savf, 'base64'));
  }
  if (o.entries && o.type === '*DTAQ') {
    for (const e of o.entries) await gw.sql('INSERT INTO QSYS.DTAQE (LIB, NAME, SEQ, DKEY, DATA, SENDER, ENQUEUED) VALUES (?, ?, ?, ?, ?, ?, ?)', [lib, o.name, e.SEQ, e.DKEY, e.DATA, e.SENDER, e.ENQUEUED]);
  }
  await gw.sql('DELETE FROM QSYS.OBJAUT WHERE LIB = ? AND NAME = ? AND TYPE = ?', [lib, o.name, o.type]);
  for (const a of o.auth || []) await gw.sql('INSERT INTO QSYS.OBJAUT (LIB, NAME, TYPE, USR, AUT) VALUES (?, ?, ?, ?, ?)', [lib, o.name, o.type, a.USR, a.AUT]);
  // Un archivo que estaba registrado vuelve a estarlo si su diario existe (sin las entradas de la propia restauración)
  if (o.journal) {
    const J = await import('./journal.js');
    const jl = o.journal.JRNLIB === o.lib ? lib : o.journal.JRNLIB;
    if (await findObject(gw, o.journal.JRN, '*JRN', jl, [])) {
      await J.startJournal(job, lib, o.name, jl, o.journal.JRN, { images: o.journal.IMAGES }).catch(() => {});
      const s = await gw.rows('SELECT MAX(SEQ) AS S FROM QSYS.JRNENT WHERE JRNLIB = ? AND JRN = ?', [jl, o.journal.JRN]);
      const d2 = data || {};
      d2.lastSaveSeq = o.journal.lastSaveSeq;
      d2.restoredAtSeq = s[0]?.S ?? 0;
      await gw.exec("UPDATE QSYS.OBJECTS SET DATA = ? WHERE LIB = ? AND NAME = ? AND TYPE = '*FILE'", [JSON.stringify(d2), lib, o.name]);
    }
  }
  return exists.length ? 'replaced' : 'restored';
}

/** Restaura de un *SAVF. sel = { names, types, savlib }. Devuelve { restored, skipped, failed: [] }. */
export async function restoreFromSavf(job, savfLib, savfName, sel, { rstlib = null, mbropt = '*MATCH', createLib = false } = {}) {
  const c = readSavfContent(savfLib, savfName);
  if (!c || !c.objects) throw new CLError('CPF3782', `File ${savfName} in ${savfLib} does not contain save data.`);
  const savlib = String(sel.savlib || c.header.lib).toUpperCase();
  if (savlib !== c.header.lib && !c.objects.some((o) => o.lib === savlib)) throw new CLError('CPF3781', savlib);
  const lib = rstlib && rstlib !== '*SAVLIB' ? rstlib : savlib;
  if (!(await libExists(lib))) {
    if (!createLib) throw new CLError('CPF2110', lib);
    const L = c.library || {};
    await createLibrary(lib, L.text || '', `*${L.attr || 'PROD'}`, L.owner || (job ? job.user : 'QSECOFR'));
    if (L.data) await gw.exec("UPDATE QSYS.OBJECTS SET DATA = ? WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'", [JSON.stringify({ ...L.data, lastSave: undefined }), lib]);
  }
  const names = (sel.names || ['*ALL']).map((x) => String(x).toUpperCase());
  const types = (sel.types || ['*ALL']).map((x) => String(x).toUpperCase());
  const list = c.objects.filter((o) => o.lib === savlib && (names.includes('*ALL') || names.includes(o.name) || names.some((n) => n.endsWith('*') && o.name.startsWith(n.slice(0, -1)))) && (types.includes('*ALL') || types.includes(o.type)));
  // Orden: físicos antes que lógicos; *JRNRCV y *JRN antes que los archivos registrados
  const rank = (o) => (o.type === '*JRNRCV' ? 0 : o.type === '*JRN' ? 1 : o.type === '*FILE' && o.attr === 'LF' ? 3 : 2);
  list.sort((a, b) => rank(a) - rank(b));
  let restored = 0;
  let skipped = 0;
  const failed = [];
  for (const o of list) {
    try {
      const r = await restoreObject(job, o, lib, { mbropt });
      if (r === 'skipped') skipped++; else restored++;
    } catch (e) { failed.push({ name: o.name, type: o.type, error: e.message }); }
  }
  const { invalidateTables } = await import('./ctx.js');
  invalidateTables(lib);
  (await import('./security.js')).invalidateAuth();
  (await import('./journal.js')).invalidateJournaled();
  return { restored, skipped, failed, lib, savlib };
}

// ---------- Datos de seguridad (SAVSECDTA / RSTUSRPRF / RSTAUT) ----------
export async function saveSecurity(job, savfLib, savfName) {
  const users = await gw.rows('SELECT * FROM QSYS.USRPRF ORDER BY NAME');
  const auts = await gw.rows('SELECT LIB, NAME, TYPE, USR, AUT FROM QSYS.OBJAUT');
  const autl = await gw.rows("SELECT NAME, TEXT, OWNER, DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND TYPE = '*AUTL'");
  const header = { release: SYS.release || 'V7R5M0', system: SYS.name, savedAt: new Date().toISOString(), savedBy: job ? job.user : 'QSYS', cmd: 'SAVSECDTA', lib: 'QSYS' };
  const objects = users.map((u) => ({ lib: 'QSYS', name: u.NAME, type: '*USRPRF', attr: '', text: u.TEXT, owner: 'QSECOFR', profile: { ...u, CREATED: u.CREATED ? String(u.CREATED) : null, LASTSIGN: u.LASTSIGN ? String(u.LASTSIGN) : null } }));
  for (const l of autl) objects.push({ lib: 'QSYS', name: l.NAME, type: '*AUTL', attr: '', text: l.TEXT, owner: l.OWNER, data: l.DATA ? JSON.parse(l.DATA) : null });
  const content = { format: SAVE_FORMAT, header, library: null, objects, privateAuthorities: auts };
  await writeSavf(savfLib, savfName, content, { entries: objects.map(entryOf), header, savedAt: header.savedAt });
  return { users: users.length, auts: auts.length };
}

export async function restoreProfiles(job, savfLib, savfName, names = ['*ALL']) {
  const c = readSavfContent(savfLib, savfName);
  if (!c || c.header.cmd !== 'SAVSECDTA') throw new CLError('CPF3782', `File ${savfName} in ${savfLib} does not contain security data (SAVSECDTA).`);
  const sel = names.map((x) => String(x).toUpperCase());
  let n = 0;
  for (const o of c.objects) {
    if (o.type === '*USRPRF' && (sel.includes('*ALL') || sel.includes(o.name))) {
      const p = o.profile;
      const cols = Object.keys(p);
      await gw.sql('DELETE FROM QSYS.USRPRF WHERE NAME = ?', [p.NAME]);
      await gw.exec(`INSERT INTO QSYS.USRPRF (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((k) => p[k]));
      if (!(await findObject(gw, p.NAME, '*USRPRF', 'QSYS', []))) await putObject('QSYS', p.NAME, '*USRPRF', '', p.TEXT, undefined, 'QSECOFR');
      n++;
    }
    if (o.type === '*AUTL' && sel.includes('*ALL')) await putObject('QSYS', o.name, '*AUTL', '', o.text, o.data, o.owner);
  }
  return n;
}

export async function restoreAuthorities(savfLib, savfName, users = ['*ALL']) {
  const c = readSavfContent(savfLib, savfName);
  if (!c || !c.privateAuthorities) throw new CLError('CPF3782', `File ${savfName} in ${savfLib} does not contain security data (SAVSECDTA).`);
  const sel = users.map((x) => String(x).toUpperCase());
  let n = 0;
  for (const a of c.privateAuthorities) {
    if (!sel.includes('*ALL') && !sel.includes(a.USR)) continue;
    if (!(await gw.rows('SELECT NAME FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = ?', [a.LIB, a.NAME, a.TYPE])).length) continue;
    await gw.sql('DELETE FROM QSYS.OBJAUT WHERE LIB = ? AND NAME = ? AND TYPE = ? AND USR = ?', [a.LIB, a.NAME, a.TYPE, a.USR]);
    await gw.sql('INSERT INTO QSYS.OBJAUT (LIB, NAME, TYPE, USR, AUT) VALUES (?, ?, ?, ?, ?)', [a.LIB, a.NAME, a.TYPE, a.USR, a.AUT]);
    n++;
  }
  (await import('./security.js')).invalidateAuth();
  return n;
}
