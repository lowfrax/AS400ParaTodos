// Mandatos de uso diario: archivos en spool (CPYSPLF, DLTSPLF, HLDSPLF, RLSSPLF, CHGSPLFA), RUNSQLSTM,
// objetos (CRTDUPOBJ, RNMOBJ, MOVOBJ, CHGOBJD, CPYSRCF, RNMM) y planificador de trabajos
// (ADDJOBSCDE, RMVJOBSCDE, HLDJOBSCDE, RLSJOBSCDE, WRKJOBSCDE) en QUSRSYS/QDFTJOBSCD.
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { logJob, qualifiedJob, sysDate, sysTime } from '../system.js';
import { createSpool } from '../objects.js';
import * as ifs from '../ifs.js';
import { invalidateTables } from '../ctx.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const LIBQ = (kw, prompt, o = {}) => P(kw, prompt, 'qual', 10, { req: true, ...o });
const TEXT = P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' });
const textVal = (t) => (!t || t === '*BLANK' ? '' : t);
const libOf = (ctx, l) => (l === '*LIBL' || !l ? '*LIBL' : ctx.resolveLib(l));
const up = (s) => String(s || '').toUpperCase();

// ---------- Archivos en spool ----------
async function findSplf(ctx, a) {
  const name = up(a.FILE);
  const job = up([].concat(a.JOB || '*').join(''));
  let rows = await gw.rows(`SELECT ID, NAME, JOBNAME, JOBUSER, JOBNBR, SPLNBR, STATUS, OUTQ, USRDTA, PAGES FROM QSYS.SPLF WHERE NAME = ? ORDER BY ID`, [name]);
  if (job === '*' || !job) rows = rows.filter((r) => r.JOBNBR === ctx.job.number);
  else {
    const [nbr, user, jn] = job.split('/');
    rows = rows.filter((r) => (!nbr || r.JOBNBR === nbr.padStart(6, '0') || r.JOBNBR === nbr) && (!user || r.JOBUSER === user) && (!jn || r.JOBNAME === jn));
  }
  const nbrSel = up(a.SPLNBR || '*ONLY');
  if (!rows.length) throw new CLError('CPF3309', `No files named ${name} are active (job ${job}).`);
  if (nbrSel === '*LAST') return rows[rows.length - 1];
  if (nbrSel === '*ONLY') { if (rows.length > 1) throw new CLError('CPF3492', `More than one spooled file named ${name}; specify SPLNBR.`); return rows[0]; }
  const r = rows.find((x) => Number(x.SPLNBR) === Number(nbrSel));
  if (!r) throw new CLError('CPF3344', `Spooled file ${name} number ${nbrSel} not found.`);
  return r;
}
const SPLF = [P('FILE', 'Spooled file', 'name', 10, { req: true }), P('JOB', 'Job name', 'list', 28, { dft: '*' }), P('SPLNBR', 'Spooled file number', 'name', 6, { dft: '*ONLY', choices: 'Number, *ONLY, *LAST' })];

def('CPYSPLF', 'Copy Spooled File', [
  P('FILE', 'Spooled file', 'name', 10, { req: true }),
  LIBQ('TOFILE', 'To data base file'),
  P('JOB', 'Job name', 'list', 28, { dft: '*' }), P('SPLNBR', 'Spooled file number', 'name', 6, { dft: '*ONLY' }),
  P('TOMBR', 'To member', 'name', 10, { dft: '*FIRST' }), P('MBROPT', 'Replace or add records', 'char', 8, { dft: '*REPLACE', choices: '*REPLACE, *ADD' }),
  P('CTLCHAR', 'Control character', 'name', 7, { dft: '*NONE' }),
  P('TOSTMF', 'To stream file', 'text', 256, { dft: '*NONE' }),
  P('STMFOPT', 'Stream file option', 'name', 10, { dft: '*NONE', choices: '*NONE, *REPLACE, *ADD' }),
], async (ctx, a) => {
  const s = await findSplf(ctx, a);
  const lines = (await obj.spoolData(s.ID)) || [];
  if (up(a.TOFILE.obj) === '*TOSTMF') {
    if (!a.TOSTMF || a.TOSTMF === '*NONE') throw new CLError('CPD0084', 'TOSTMF must be specified with TOFILE(*TOSTMF).');
    const p = ifs.normPath(a.TOSTMF, ctx.job.cwd || '/');
    if ((await ifs.stat(p)) && a.STMFOPT === '*NONE') throw new CLError('CPFA0A0', `Object ${p} already exists.`);
    await ifs.writeFile(p, `${lines.join('\n')}\n`, { append: a.STMFOPT === '*ADD' });
    return [{ id: 'CPC3363', text: `${lines.length} records copied from spooled file ${s.NAME} to ${p}.`, sev: 0 }];
  }
  const d = await obj.describeFile(gw, `${libOf(ctx, a.TOFILE.lib)}/${a.TOFILE.obj}`, ctx.libl).catch(() => { throw new CLError('CPF2817', `To-file ${a.TOFILE.obj} in ${a.TOFILE.lib} not found.`); });
  const f = d.fields[0];
  const width = f.length || (f.type && f.type.len) || 132;
  if (a.MBROPT !== '*ADD') await gw.exec(`DELETE FROM ${d.schema}.${d.table}`);
  const stmts = lines.map((l) => ({ sql: `INSERT INTO ${d.schema}.${d.table} ("${f.name}") VALUES (?)`, params: [String(l).slice(0, width)] }));
  for (let i = 0; i < stmts.length; i += 200) await gw.batch(stmts.slice(i, i + 200), []);
  return [{ id: 'CPC3363', text: `${lines.length} records copied to member ${a.TOFILE.obj} of file ${a.TOFILE.obj} in ${d.lib}.`, sev: 0 }];
});

def('DLTSPLF', 'Delete Spooled File', SPLF, async (ctx, a) => {
  const s = await findSplf(ctx, a);
  await obj.deleteSpool(s.ID);
  return [{ id: 'CPC3305', text: `Spooled file ${s.NAME} number ${s.SPLNBR} deleted.`, sev: 0 }];
});
def('HLDSPLF', 'Hold Spooled File', SPLF, async (ctx, a) => {
  const s = await findSplf(ctx, a);
  await obj.setSpoolStatus(s.ID, 'HLD');
  return [{ id: 'CPC3302', text: `Spooled file ${s.NAME} number ${s.SPLNBR} held.`, sev: 0 }];
});
def('RLSSPLF', 'Release Spooled File', SPLF, async (ctx, a) => {
  const s = await findSplf(ctx, a);
  await obj.setSpoolStatus(s.ID, 'RDY');
  return [{ id: 'CPC3303', text: `Spooled file ${s.NAME} number ${s.SPLNBR} released.`, sev: 0 }];
});
def('CHGSPLFA', 'Change Spooled File Attributes', [...SPLF, P('OUTQ', 'Output queue', 'qual', 10, { dft: '*SAME' }), P('USRDTA', 'User data', 'text', 10, { dft: '*SAME' }), P('SAVE', 'Save after printing', 'char', 4, { dft: '*SAME' })], async (ctx, a) => {
  const s = await findSplf(ctx, a);
  if (a.OUTQ && a.OUTQ.obj && a.OUTQ.obj !== '*SAME') await gw.exec(`UPDATE QSYS.SPLF SET OUTQ = ? WHERE ID = ?`, [up(a.OUTQ.obj), s.ID]);
  if (a.USRDTA && a.USRDTA !== '*SAME') await gw.exec(`UPDATE QSYS.SPLF SET USRDTA = ? WHERE ID = ?`, [String(a.USRDTA).slice(0, 10), s.ID]);
  return [{ id: 'CPC3310', text: `Attributes of spooled file ${s.NAME} changed.`, sev: 0 }];
});

// ---------- RUNSQLSTM ----------
/** Divide un guion SQL en sentencias (respeta literales, comentarios -- y /* *\/, y bloques BEGIN…END). */
export function splitSql(text) {
  const out = [];
  let cur = '';
  let i = 0;
  let depth = 0;
  const s = String(text);
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < s.length) { if (s[j] === q && s[j + 1] === q) { j += 2; continue; } if (s[j] === q) break; j++; }
      cur += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '-' && s[i + 1] === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i + 2); i = j < 0 ? s.length : j + 2; continue; }
    const word = /^[A-Za-z]+/.exec(s.slice(i));
    if (word && (i === 0 || !/[\w$#@]/.test(s[i - 1]))) {
      const w = word[0].toUpperCase();
      if (w === 'BEGIN') depth++;
      else if (w === 'END' && depth > 0 && !/^END\s+(IF|LOOP|WHILE|FOR|CASE|REPEAT)\b/i.test(s.slice(i))) depth--;
      cur += word[0]; i += word[0].length; continue;
    }
    if (c === ';' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

def('RUNSQLSTM', 'Run SQL Statements', [
  LIBQ('SRCFILE', 'Source file', { req: false, dft: '*NONE' }), P('SRCMBR', 'Source member', 'name', 10, { dft: '*NONE' }),
  P('SRCSTMF', 'Source stream file', 'text', 256, { dft: '*NONE' }),
  P('COMMIT', 'Commitment control', 'name', 6, { dft: '*CHG', choices: '*CHG, *UR, *CS, *ALL, *RS, *NONE, *NC' }),
  P('NAMING', 'Naming', 'name', 4, { dft: '*SYS', choices: '*SYS, *SQL' }),
  P('ERRLVL', 'Severity level', 'int', 2, { dft: '10' }),
  P('DFTRDBCOL', 'Default collection', 'name', 10, { dft: '*NONE' }),
  P('OUTPUT', 'Listing output', 'name', 6, { dft: '*NONE', choices: '*NONE, *PRINT' }),
], async (ctx, a) => {
  let text;
  let srcName;
  if (a.SRCSTMF && a.SRCSTMF !== '*NONE') {
    const p = ifs.normPath(a.SRCSTMF, ctx.job.cwd || '/');
    text = String(await ifs.readFile(p).catch(() => { throw new CLError('CPFA0A9', `Object ${p} not found.`); }));
    srcName = p;
  } else {
    if (!a.SRCFILE || !a.SRCFILE.obj || a.SRCFILE.obj === '*NONE' || !a.SRCMBR || a.SRCMBR === '*NONE') throw new CLError('CPD0084', 'SRCFILE and SRCMBR, or SRCSTMF, must be specified.');
    const m = await obj.findMember(gw, a.SRCFILE.lib === '*LIBL' ? null : ctx.resolveLib(a.SRCFILE.lib), a.SRCFILE.obj, a.SRCMBR, ctx.libl);
    if (!m) throw new CLError('CPF9815', a.SRCMBR, a.SRCFILE.obj, a.SRCFILE.lib);
    text = (await obj.readMember(gw, m.LIB, a.SRCFILE.obj, a.SRCMBR)).map((l) => l.text).join('\n');
    srcName = `${m.LIB}/${a.SRCFILE.obj}(${a.SRCMBR})`;
  }
  const stmts = splitSql(text);
  const listing = [`5770SS1 V7R5M0  220415   Run SQL Statements   ${srcName}   ${sysDate()} ${sysTime()}`, ''];
  let maxSev = 0;
  let n = 0;
  const useTx = a.COMMIT !== '*NONE' && a.COMMIT !== '*NC' && !ctx.job.cmt;
  if (useTx) await ctx.startCommit(a.COMMIT);
  const prevCur = ctx.job.curlib;
  if (a.DFTRDBCOL && a.DFTRDBCOL !== '*NONE') ctx.job.curlib = a.DFTRDBCOL;
  try {
    for (const st of stmts) {
      n++;
      listing.push(`  ${String(n).padStart(4)}  ${st.replace(/\s+/g, ' ').slice(0, 110)}`);
      const r = await ctx.sql(st.replace(/^(\w+)\/(\w+)/, '$1.$2'));
      if (r.error) {
        const sev = /^01|^02/.test(r.sqlstate || '') ? 10 : 30;
        maxSev = Math.max(maxSev, sev);
        const id = `SQL${String(Math.abs(r.sqlcode || 0)).padStart(4, '0')}`;
        listing.push(`  ${id}  ${sev}  ${r.error}`);
        logJob(ctx.job, id, '*DIAG', `${r.error} (statement ${n})`, { sev });
        if (sev > Number(a.ERRLVL || 10)) break;
      } else listing.push(`        ${r.columns.length ? `${r.rows.length} rows selected` : `${r.rowCount < 0 ? 0 : r.rowCount} rows affected`}`);
    }
    if (maxSev > Number(a.ERRLVL || 10)) { if (useTx) await ctx.rollback(); } else if (useTx) await ctx.commit();
  } finally {
    if (useTx) await ctx.endCommit().catch(() => {});
    ctx.job.curlib = prevCur;
  }
  invalidateTables();
  listing.push('', `  ${n} statements processed; highest severity ${maxSev}.`);
  if (a.OUTPUT === '*PRINT' || maxSev) await createSpool(ctx.job, String(a.SRCMBR && a.SRCMBR !== '*NONE' ? a.SRCMBR : 'QSYSPRT'), listing, { usrdta: 'RUNSQLSTM' });
  if (maxSev > Number(a.ERRLVL || 10)) throw new CLError('SQL9010', `RUNSQLSTM command failed: ${n} statements processed, highest severity ${maxSev}.`);
  return [{ id: 'SQL7985', text: `${stmts.length} statements processed by RUNSQLSTM. Highest severity ${maxSev}.`, sev: 0 }];
});

// ---------- Objetos ----------
async function objRow(ctx, q, type) {
  const o = await obj.findObject(gw, up(q.obj), type, libOf(ctx, q.lib), ctx.libl);
  if (!o) throw new CLError('CPF2105', q.obj, q.lib || '*LIBL', type);
  return o;
}

async function copySourceFile(fromLib, fromFile, toLib, toFile) {
  await gw.exec(`INSERT INTO QSYS.MEMBERS (LIB, SRCF, MBR, TYPE, TEXT, CREATED, CHANGED, NLINES) SELECT ?, ?, MBR, TYPE, TEXT, CREATED, CHANGED, NLINES FROM QSYS.MEMBERS WHERE LIB = ? AND SRCF = ?`, [toLib, toFile, fromLib, fromFile]);
  await gw.exec(`INSERT INTO QSYS.SOURCE (LIB, SRCF, MBR, SEQ, DAT, SRCDTA) SELECT ?, ?, MBR, SEQ, DAT, SRCDTA FROM QSYS.SOURCE WHERE LIB = ? AND SRCF = ?`, [toLib, toFile, fromLib, fromFile]);
}

def('CRTDUPOBJ', 'Create Duplicate Object', [
  P('OBJ', 'From object', 'name', 10, { req: true }), P('FROMLIB', 'From library', 'name', 10, { req: true }),
  P('OBJTYPE', 'Object type', 'list', 30, { req: true }), P('TOLIB', 'To library', 'name', 10, { dft: '*FROMLIB' }),
  P('NEWOBJ', 'New object', 'name', 10, { dft: '*OBJ' }), P('DATA', 'Duplicate data', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }),
], async (ctx, a) => {
  const fromLib = ctx.resolveLib(a.FROMLIB);
  const toLib = a.TOLIB === '*FROMLIB' ? fromLib : ctx.resolveLib(a.TOLIB);
  const type = up([].concat(a.OBJTYPE)[0]);
  const src = await objRow(ctx, { lib: fromLib, obj: a.OBJ }, type);
  const newName = a.NEWOBJ === '*OBJ' ? src.NAME : up(a.NEWOBJ);
  if (toLib === fromLib && newName === src.NAME) throw new CLError('CPF2130', `Object ${src.NAME} not duplicated: same name and library.`);
  if (await obj.findObject(gw, newName, type, toLib, [])) throw new CLError('CPF2130', `Object ${newName} type ${type} already exists in library ${toLib}.`);
  const data = await obj.objectData(gw, fromLib, src.NAME, type);
  if (type === '*FILE' && (src.ATTR === 'PF' || src.ATTR === 'PF-DTA')) {
    const r = await gw.sql(`CREATE TABLE ${toLib}.${newName} LIKE ${fromLib}.${src.NAME} INCLUDING COLUMN DEFAULTS`);
    if (r.error) throw new CLError('CPF2130', `File ${newName} not duplicated: ${r.error}`);
    if (data && data.keys && data.keys.length && data.unique) await gw.sql(`ALTER TABLE ${toLib}.${newName} ADD PRIMARY KEY (${data.keys.map((k) => `"${k}"`).join(', ')})`);
    if (a.DATA === '*YES') await gw.sql(`INSERT INTO ${toLib}.${newName} SELECT * FROM ${fromLib}.${src.NAME}`);
    invalidateTables(toLib);
  } else if (type === '*FILE' && src.ATTR === 'PF-SRC') {
    await obj.createSourceFile(toLib, newName, (data && data.rcdlen) || 112, src.TEXT);
    await copySourceFile(fromLib, src.NAME, toLib, newName);
    return [{ id: 'CPC2130', text: `1 objects duplicated.`, sev: 0 }];
  } else if (type === '*FILE' && src.ATTR === 'LF') throw new CLError('CPF2130', `Logical file ${src.NAME} not duplicated; re-create it with CRTLF.`);
  if (type === '*DTAQ') await obj.putObject(toLib, newName, type, src.ATTR, src.TEXT, data, ctx.job.user);
  else await obj.putObject(toLib, newName, type, src.ATTR, src.TEXT, data, ctx.job.user);
  return [{ id: 'CPC2130', text: `1 objects duplicated.`, sev: 0 }];
});

def('RNMOBJ', 'Rename Object', [LIBQ('OBJ', 'Object'), P('OBJTYPE', 'Object type', 'name', 10, { req: true }), P('NEWOBJ', 'New object', 'name', 10, { req: true })], async (ctx, a) => {
  const type = up(a.OBJTYPE);
  const o = await objRow(ctx, a.OBJ, type);
  const nn = up(a.NEWOBJ);
  if (await obj.findObject(gw, nn, type, o.LIB, [])) throw new CLError('CPF2112', nn, o.LIB, type);
  if (type === '*FILE' && (o.ATTR === 'PF' || o.ATTR === 'PF-DTA')) {
    const deps = await obj.dependentLogicals(o.LIB, o.NAME);
    if (deps.length) throw new CLError('CPF3220', o.NAME, o.LIB, deps[0].NAME, deps[0].LIB);
    const r = await gw.sql(`RENAME TABLE ${o.LIB}.${o.NAME} TO ${nn}`);
    if (r.error) throw new CLError('CPF2160', `Object ${o.NAME} not renamed: ${r.error}`);
    invalidateTables(o.LIB);
  }
  if (type === '*FILE' && o.ATTR === 'PF-SRC') {
    await gw.exec(`UPDATE QSYS.MEMBERS SET SRCF = ? WHERE LIB = ? AND SRCF = ?`, [nn, o.LIB, o.NAME]);
    await gw.exec(`UPDATE QSYS.SOURCE SET SRCF = ? WHERE LIB = ? AND SRCF = ?`, [nn, o.LIB, o.NAME]);
  }
  await gw.exec(`UPDATE QSYS.OBJECTS SET NAME = ? WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [nn, o.LIB, o.NAME, type]);
  return [{ id: 'CPC2192', text: `Object ${o.NAME} in ${o.LIB} type ${type} renamed ${nn}.`, sev: 0 }];
});

def('MOVOBJ', 'Move Object', [LIBQ('OBJ', 'Object'), P('OBJTYPE', 'Object type', 'name', 10, { req: true }), P('TOLIB', 'To library', 'name', 10, { req: true })], async (ctx, a) => {
  const type = up(a.OBJTYPE);
  const o = await objRow(ctx, a.OBJ, type);
  const to = ctx.resolveLib(a.TOLIB);
  if (!(await obj.libExists(to))) throw new CLError('CPF2110', to);
  if (await obj.findObject(gw, o.NAME, type, to, [])) throw new CLError('CPF2112', o.NAME, to, type);
  if (type === '*FILE' && (o.ATTR === 'PF' || o.ATTR === 'PF-DTA')) {
    const deps = await obj.dependentLogicals(o.LIB, o.NAME);
    if (deps.length) throw new CLError('CPF3220', o.NAME, o.LIB, deps[0].NAME, deps[0].LIB);
    const r1 = await gw.sql(`CREATE TABLE ${to}.${o.NAME} LIKE ${o.LIB}.${o.NAME} INCLUDING COLUMN DEFAULTS`);
    if (r1.error) throw new CLError('CPF2163', `Object ${o.NAME} not moved: ${r1.error}`);
    await gw.sql(`INSERT INTO ${to}.${o.NAME} SELECT * FROM ${o.LIB}.${o.NAME}`);
    await gw.sql(`DROP TABLE ${o.LIB}.${o.NAME}`);
    invalidateTables(o.LIB); invalidateTables(to);
  }
  if (type === '*FILE' && o.ATTR === 'PF-SRC') {
    await gw.exec(`UPDATE QSYS.MEMBERS SET LIB = ? WHERE LIB = ? AND SRCF = ?`, [to, o.LIB, o.NAME]);
    await gw.exec(`UPDATE QSYS.SOURCE SET LIB = ? WHERE LIB = ? AND SRCF = ?`, [to, o.LIB, o.NAME]);
  }
  await gw.exec(`UPDATE QSYS.OBJECTS SET LIB = ? WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [to, o.LIB, o.NAME, type]);
  return [{ id: 'CPC7001', text: `Object ${o.NAME} in ${o.LIB} type ${type} moved to library ${to}.`, sev: 0 }];
});

def('CHGOBJD', 'Change Object Description', [LIBQ('OBJ', 'Object'), P('OBJTYPE', 'Object type', 'name', 10, { req: true }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*SAME' })], async (ctx, a) => {
  const o = await objRow(ctx, a.OBJ, up(a.OBJTYPE));
  if (a.TEXT !== '*SAME') await gw.exec(`UPDATE QSYS.OBJECTS SET TEXT = ? WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [textVal(a.TEXT), o.LIB, o.NAME, o.TYPE]);
  return [{ id: 'CPC2103', text: `Object description of ${o.NAME} changed.`, sev: 0 }];
});

def('CPYSRCF', 'Copy Source File', [
  LIBQ('FROMFILE', 'From file'), LIBQ('TOFILE', 'To file'), P('FROMMBR', 'From member', 'name', 10, { req: true, choices: 'Name, generic*, *ALL' }),
  P('TOMBR', 'To member or label', 'name', 10, { dft: '*FROMMBR' }), P('MBROPT', 'Replace or add records', 'char', 8, { dft: '*REPLACE', choices: '*REPLACE, *ADD' }),
], async (ctx, a) => {
  const fl = (await objRow(ctx, a.FROMFILE, '*FILE')).LIB;
  const tlo = a.TOFILE.lib === '*LIBL' ? (await obj.findObject(gw, a.TOFILE.obj, '*FILE', '*LIBL', ctx.libl)) : null;
  const tl = tlo ? tlo.LIB : ctx.resolveLib(a.TOFILE.lib);
  if (!(await obj.findObject(gw, a.TOFILE.obj, '*FILE', tl, []))) throw new CLError('CPF2817', `To-file ${a.TOFILE.obj} in ${tl} not found.`);
  const all = await obj.listMembers(fl, a.FROMFILE.obj);
  const pat = up(a.FROMMBR);
  const mbrs = pat === '*ALL' ? all : pat.endsWith('*') ? all.filter((m) => m.MBR.startsWith(pat.slice(0, -1))) : all.filter((m) => m.MBR === pat);
  if (!mbrs.length) throw new CLError('CPF9815', a.FROMMBR, a.FROMFILE.obj, fl);
  const existing = new Set((await obj.listMembers(tl, a.TOFILE.obj)).map((m) => m.MBR));
  for (const m of mbrs) {
    const to = a.TOMBR === '*FROMMBR' || mbrs.length > 1 ? m.MBR : up(a.TOMBR);
    const lines = await obj.readMember(gw, fl, a.FROMFILE.obj, m.MBR);
    if (!existing.has(to)) await obj.addMember(tl, a.TOFILE.obj, to, m.TYPE, m.TEXT);
    const prev = a.MBROPT === '*ADD' && existing.has(to) ? await obj.readMember(gw, tl, a.TOFILE.obj, to) : [];
    const merged = [...prev, ...lines].map((l, i) => ({ seq: (i + 1) * 100, dat: l.dat || 0, text: l.text }));
    await obj.writeMember(tl, a.TOFILE.obj, to, merged);
  }
  return [{ id: 'CPC2955', text: `${mbrs.length} member(s) copied to file ${a.TOFILE.obj} in ${tl}.`, sev: 0 }];
});

def('RNMM', 'Rename Member', [LIBQ('FILE', 'Database file'), P('MBR', 'Member', 'name', 10, { req: true }), P('NEWMBR', 'New member', 'name', 10, { req: true })], async (ctx, a) => {
  const lib = (await objRow(ctx, a.FILE, '*FILE')).LIB;
  const nn = up(a.NEWMBR);
  if ((await obj.listMembers(lib, a.FILE.obj)).some((m) => m.MBR === nn)) throw new CLError('CPF3213', nn, a.FILE.obj, lib);
  await gw.exec(`UPDATE QSYS.MEMBERS SET MBR = ? WHERE LIB = ? AND SRCF = ? AND MBR = ?`, [nn, lib, a.FILE.obj, up(a.MBR)]);
  await gw.exec(`UPDATE QSYS.SOURCE SET MBR = ? WHERE LIB = ? AND SRCF = ? AND MBR = ?`, [nn, lib, a.FILE.obj, up(a.MBR)]);
  return [{ id: 'CPC3201', text: `Member ${up(a.MBR)} renamed to ${nn}.`, sev: 0 }];
});

// ---------- Planificador de trabajos (QUSRSYS/QDFTJOBSCD) ----------
async function scdData() {
  return (await obj.objectData(gw, 'QUSRSYS', 'QDFTJOBSCD', '*JOBSCD').catch(() => null)) || { entries: [], seq: 0 };
}
async function saveScd(d) { await obj.putObject('QUSRSYS', 'QDFTJOBSCD', '*JOBSCD', '', 'Default job schedule', d, 'QSYS'); }

const DAYS = ['*SUN', '*MON', '*TUE', '*WED', '*THU', '*FRI', '*SAT'];
/** Próxima ejecución de una entrada a partir de `from`. */
export function nextRun(e, from = new Date()) {
  const [hh, mm, ss] = [e.time.slice(0, 2), e.time.slice(2, 4), e.time.slice(4, 6) || '00'].map(Number);
  for (let add = 0; add <= 400; add++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + add, hh, mm, ss);
    if (d <= from) continue;
    if (e.date && e.date !== '*CURRENT' && e.date !== '*NONE' && e.frq === '*ONCE') {
      const t = new Date(`${e.date}T00:00:00`);
      if (d.toDateString() !== t.toDateString()) continue;
    }
    if (e.frq === '*WEEKLY' || e.frq === '*ONCE') { if (e.days.length && !e.days.includes('*ALL') && !e.days.includes(DAYS[d.getDay()])) continue; }
    if (e.frq === '*MONTHLY' && e.date && /^\d{4}-\d{2}-(\d{2})$/.test(e.date) && d.getDate() !== Number(e.date.slice(8))) continue;
    return d.toISOString();
  }
  return null;
}

function parseScdDate(v) {
  const s = String(v || '*CURRENT').toUpperCase();
  if (s.startsWith('*')) return s;
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(s.replace(/\D/g, ''));
  if (!m) return s;
  // MMDDAA o MMDDAAAA (formato de fecha *MDY del trabajo)
  const year = m[4] ? Number(m[3] + m[4]) : 2000 + Number(m[3]);
  return `${year}-${m[1]}-${m[2]}`;
}

def('ADDJOBSCDE', 'Add Job Schedule Entry', [
  P('JOB', 'Job name', 'name', 10, { req: true }), P('CMD', 'Command to run', 'cmd', 512, { req: true }),
  P('FRQ', 'Frequency', 'name', 8, { req: true, choices: '*ONCE, *WEEKLY, *MONTHLY' }),
  P('SCDDATE', 'Schedule date', 'name', 10, { dft: '*CURRENT', choices: 'Date, *CURRENT, *MONTHSTR, *MONTHEND, *NONE' }),
  P('SCDDAY', 'Schedule day', 'list', 40, { dft: '*NONE', choices: '*NONE, *ALL, *MON, *TUE, *WED, *THU, *FRI, *SAT, *SUN' }),
  P('SCDTIME', 'Schedule time', 'char', 8, { dft: '*CURRENT', choices: 'Time, *CURRENT' }),
  P('JOBQ', 'Job queue', 'qual', 10, { dft: 'QBATCH' }), P('USER', 'User', 'name', 10, { dft: '*CURRENT' }), TEXT,
], async (ctx, a) => {
  const d = await scdData();
  const name = up(a.JOB);
  // SCDTIME(*CURRENT): la hora actual; con SCDDATE(*CURRENT) el trabajo se envía en el siguiente ciclo del planificador
  const nowTime = up(a.SCDTIME) === '*CURRENT';
  const t = nowTime ? (() => { const n = new Date(); return [n.getHours(), n.getMinutes(), n.getSeconds()].map((x) => String(x).padStart(2, '0')).join(''); })() :String(a.SCDTIME).replace(/[:.]/g, '').padEnd(6, '0');
  const e = {
    name, seq: ++d.seq, cmd: a.CMD, frq: a.FRQ, date: parseScdDate(a.SCDDATE), days: [].concat(a.SCDDAY || '*NONE').filter((x) => x !== '*NONE'),
    time: t, user: a.USER === '*CURRENT' ? ctx.job.user : up(a.USER), status: 'SCD', text: textVal(a.TEXT), created: new Date().toISOString(), last: null,
  };
  e.next = nowTime && e.frq === '*ONCE' && (e.date === '*CURRENT' || e.date === '*NONE') ? new Date().toISOString() : nextRun(e);
  d.entries.push(e);
  await saveScd(d);
  return [{ id: 'CPC1238', text: `Job schedule entry ${name} number ${String(e.seq).padStart(6, '0')} added.`, sev: 0 }];
});

const SCDE = [P('JOB', 'Job name', 'name', 10, { req: true }), P('ENTRYNBR', 'Entry number', 'name', 6, { dft: '*ONLY' })];
async function scdEntries(a) {
  const d = await scdData();
  const name = up(a.JOB);
  const list = d.entries.filter((e) => (name === '*ALL' || e.name === name || (name.endsWith('*') && e.name.startsWith(name.slice(0, -1)))) && (a.ENTRYNBR === '*ONLY' || a.ENTRYNBR === '*ALL' || Number(a.ENTRYNBR) === e.seq));
  if (!list.length) throw new CLError('CPF1628', `Job schedule entry ${name} not found.`);
  return { d, list };
}
def('RMVJOBSCDE', 'Remove Job Schedule Entry', SCDE, async (ctx, a) => {
  const { d, list } = await scdEntries(a);
  d.entries = d.entries.filter((e) => !list.includes(e));
  await saveScd(d);
  return [{ id: 'CPC1239', text: `${list.length} job schedule entries removed.`, sev: 0 }];
});
def('HLDJOBSCDE', 'Hold Job Schedule Entry', SCDE, async (ctx, a) => {
  const { d, list } = await scdEntries(a);
  for (const e of list) e.status = 'HLD';
  await saveScd(d);
  return [{ id: 'CPC1240', text: `${list.length} job schedule entries held.`, sev: 0 }];
});
def('RLSJOBSCDE', 'Release Job Schedule Entry', SCDE, async (ctx, a) => {
  const { d, list } = await scdEntries(a);
  for (const e of list) { e.status = 'SCD'; e.next = nextRun(e); }
  await saveScd(d);
  return [{ id: 'CPC1241', text: `${list.length} job schedule entries released.`, sev: 0 }];
});
const fmtNext = (iso) => (iso ? `${sysDate(new Date(iso))} ${sysTime(new Date(iso))}` : '');
const fmtTime = (t) => `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
const nbr = (e) => String(e.seq).padStart(6, '0');
function scdDetail(e) {
  return [
    `Job  . . . . . . . . . . . . . . :   ${e.name}`, `Entry number . . . . . . . . . . :   ${nbr(e)}`, `Status . . . . . . . . . . . . . :   ${e.status}`,
    `Command  . . . . . . . . . . . . :   ${e.cmd}`, `Frequency  . . . . . . . . . . . :   ${e.frq}`, `Schedule date  . . . . . . . . . :   ${e.date}`,
    `Schedule day . . . . . . . . . . :   ${e.days.length ? e.days.join(' ') : '*NONE'}`, `Schedule time  . . . . . . . . . :   ${fmtTime(e.time)}`,
    `Next submit date . . . . . . . . :   ${fmtNext(e.next)}`, `Last submitted . . . . . . . . . :   ${fmtNext(e.last)}`,
    `User . . . . . . . . . . . . . . :   ${e.user}`, 'Job queue  . . . . . . . . . . . :   QGPL/QBATCH', `Text . . . . . . . . . . . . . . :   ${e.text || ''}`,
  ];
}

def('WRKJOBSCDE', 'Work with Job Schedule Entries', [P('JOB', 'Job name', 'name', 10, { dft: '*ALL' })], async (ctx, a) => {
  const sel = up(a.JOB);
  const load = async () => (await scdData()).entries.filter((e) => sel === '*ALL' || e.name === sel || (sel.endsWith('*') && e.name.startsWith(sel.slice(0, -1))));
  if (!ctx.interactive) {
    const rows = await load();
    return { text: ['Job         Number  Status  Frequency  Schedule Time  Next Submit Date     Command', ...rows.map((e) => `${e.name.padEnd(12)}${nbr(e).padEnd(8)}${e.status.padEnd(8)}${e.frq.padEnd(11)}${fmtTime(e.time).padEnd(15)}${fmtNext(e.next).padEnd(21)}${String(e.cmd).slice(0, 40)}`)].join('\n') };
  }
  const { workWith, viewText, execFromLine } = await import('../screens/common.js');
  const change = async (list, status) => {
    const d = await scdData();
    for (const s of list) { const e = d.entries.find((x) => x.seq === s.seq); if (e) { e.status = status; if (status === 'SCD') e.next = nextRun(e); } }
    await saveScd(d);
  };
  await workWith(ctx, {
    fn: 'CMD-WRKJOBSCDE',
    title: 'Work with Job Schedule Entries',
    opts: ['2=Change   3=Hold   4=Remove   5=Display details   6=Release'],
    colHead2: '                                   -----Schedule------',
    colHead: 'Opt  Job         Status   Date      Time      Frequency    Next Submit',
    load,
    key: (e) => e.seq,
    row: (e) => `${e.name.padEnd(10)}  ${e.status.padEnd(7)}  ${(e.date === '*NONE' || !e.date ? 'USER DEF' : e.date).slice(0, 8).padEnd(8)}  ${fmtTime(e.time)}  ${e.frq.padEnd(11)}  ${e.next ? sysDate(new Date(e.next)) : ''}`,
    empty: '(No job schedule entries)',
    cmd: false,
    keys: { F6: (c) => execFromLine(c, 'ADDJOBSCDE', true) },
    fkeys: ['F3=Exit   F5=Refresh   F6=Add   F12=Cancel'],
    act: async (sels, c) => {
      for (const s of sels) {
        if (s.opt === '2') { const m = await execFromLine(c, `CHGJOBSCDE JOB(${s.item.name}) ENTRYNBR(${s.item.seq})`, true); if (m && m.text) return m; }
        if (s.opt === '5') await viewText(c, { fn: 'CMD-WRKJOBSCDE', title: 'Display Job Schedule Entry Details', lines: scdDetail(s.item) });
      }
      const by = (o) => sels.filter((s) => s.opt === o).map((s) => s.item);
      if (by('3').length) await change(by('3'), 'HLD');
      if (by('6').length) await change(by('6'), 'SCD');
      if (by('4').length) { const d = await scdData(); const rm = new Set(by('4').map((e) => e.seq)); d.entries = d.entries.filter((e) => !rm.has(e.seq)); await saveScd(d); }
      return null;
    },
  });
  return null;
});

def('CHGJOBSCDE', 'Change Job Schedule Entry', [
  ...SCDE, P('CMD', 'Command to run', 'cmd', 512, { dft: '*SAME' }), P('FRQ', 'Frequency', 'name', 8, { dft: '*SAME', choices: '*SAME, *ONCE, *WEEKLY, *MONTHLY' }),
  P('SCDDATE', 'Schedule date', 'name', 10, { dft: '*SAME' }), P('SCDDAY', 'Schedule day', 'list', 40, { dft: '*SAME' }),
  P('SCDTIME', 'Schedule time', 'char', 8, { dft: '*SAME' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*SAME' }),
], async (ctx, a) => {
  const { d, list } = await scdEntries(a);
  const same = (v) => v === undefined || v === '*SAME' || (Array.isArray(v) && v[0] === '*SAME');
  for (const e of list) {
    if (!same(a.CMD)) e.cmd = a.CMD;
    if (!same(a.FRQ)) e.frq = a.FRQ;
    if (!same(a.SCDDATE)) e.date = parseScdDate(a.SCDDATE);
    if (!same(a.SCDDAY)) e.days = [].concat(a.SCDDAY).filter((x) => x !== '*NONE');
    if (!same(a.SCDTIME)) e.time = String(a.SCDTIME).replace(/[:.]/g, '').padEnd(6, '0');
    if (!same(a.TEXT)) e.text = textVal(a.TEXT);
    if (e.status === 'SCD') e.next = nextRun(e);
  }
  await saveScd(d);
  return [{ id: 'CPC1235', text: `Job schedule entry ${list[0].name} number ${nbr(list[0])} changed.`, sev: 0 }];
});

// Entradas del planificador anterior (/QIBM/UserData/OS/jobscde.json) y entrada por omisión del cierre del banco
async function migrateScd() {
  const d = await scdData();
  let changed = false;
  const OLD = '/QIBM/UserData/OS/jobscde.json';
  try {
    const old = JSON.parse(String(await ifs.readFile(OLD)));
    for (const o of Array.isArray(old) ? old : []) {
      if (o.status === 'SCD-DONE' || d.entries.some((e) => e.name === o.job)) continue;
      const e = {
        name: o.job, seq: ++d.seq, cmd: o.cmd, frq: o.frq, date: o.scddate || '*NONE', days: (o.scdday || []).filter((x) => x !== '*NONE'),
        time: String(o.scdtime || '000000'), user: o.user || 'QSECOFR', status: o.status === 'HLD' ? 'HLD' : 'SCD', text: o.text || '', created: o.created || new Date().toISOString(), last: null,
      };
      e.next = nextRun(e);
      d.entries.push(e);
    }
    await ifs.rename(OLD, `${OLD}.migrated`).catch(() => {});
    changed = true;
  } catch { /* no había planificador anterior */ }
  if (!d.entries.some((e) => e.name === 'CIERREBNK')) {
    const e = { name: 'CIERREBNK', seq: ++d.seq, cmd: 'CALL PGM(BANCO/BNKCIERRE)', frq: '*WEEKLY', date: '*NONE', days: ['*ALL'], time: '230000', user: 'QSECOFR', status: 'HLD', text: 'Cierre diario del banco', created: new Date().toISOString(), last: null };
    e.next = nextRun(e);
    d.entries.push(e);
    changed = true;
  }
  if (changed) await saveScd(d);
}

/** Bucle del planificador (QSYSSCD): envía los trabajos que han llegado a su hora. */
export function startScheduler() {
  const tick = async () => {
    try {
      const d = await scdData();
      const now = new Date();
      let changed = false;
      for (const e of d.entries) {
        if (e.status !== 'SCD' || !e.next || new Date(e.next) > now) continue;
        const { serverCtx, endServerCtx } = await import('../svc/jobs.js');
        const { submitJob } = await import('../runtime/build.js');
        const ctx = await serverCtx(e.user, { name: 'QSYSSCD', subsystem: 'QCTL', type: 'BCH' }).catch(() => null);
        if (ctx) {
          await submitJob(ctx, e.cmd, e.name).catch(() => {});
          logJob(ctx.job, 'CPI1E23', '*INFO', `Job ${e.name} submitted by job schedule entry ${nbr(e)}.`);
          console.log(`[scd] ${e.name} ${nbr(e)}: ${e.cmd}`);
          setTimeout(() => endServerCtx(ctx), 2000);
        }
        e.last = now.toISOString();
        e.next = e.frq === '*ONCE' ? null : nextRun(e, now);
        if (e.frq === '*ONCE') e.status = 'SAV';
        changed = true;
      }
      if (changed) { d.entries = d.entries.filter((x) => x.status !== 'SAV'); await saveScd(d); }
    } catch { /* el siguiente ciclo lo reintenta */ }
  };
  migrateScd().catch((e) => console.error(`[scd] ${e.message}`));
  const t = setInterval(tick, Number(process.env.JOBSCD_INTERVAL_MS || 15000));
  t.unref();
  return t;
}

void qualifiedJob;
