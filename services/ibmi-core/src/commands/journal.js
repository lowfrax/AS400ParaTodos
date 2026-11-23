// Mandatos de diario: CRTJRNRCV, DLTJRNRCV, DSPJRNRCVA, CRTJRN, DLTJRN, CHGJRN, WRKJRNA, DSPJRN, STRJRNPF,
// ENDJRNPF, APYJRNCHG, RMVJRNCHG, SNDJRNE.
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { Panel, padR, padL } from '../panel.js';
import * as J from '../journal.js';
import { sysDate, sysTime } from '../system.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const up = (s) => String(s ?? '').trim().toUpperCase();
const QUAL = (kw, prompt, o = {}) => P(kw, prompt, 'qual', 10, { req: true, lib: '*CURLIB', ...o });
const libOf = (ctx, q, dft = '*CURLIB') => (!q.lib || q.lib === '*LIBL' ? null : ctx.resolveLib(q.lib === '*CURLIB' ? dft : q.lib));

async function find(ctx, q, type, notFound) {
  const lib = libOf(ctx, q);
  const o = await obj.findObject(gw, up(q.obj), type, lib || '*LIBL', ctx.libl);
  if (!o) throw new CLError(notFound, up(q.obj), lib || '*LIBL');
  return o;
}
const sec = () => import('../security.js');

// ---------- Receptores ----------
def('CRTJRNRCV', 'Create Journal Receiver', [QUAL('JRNRCV', 'Journal receiver'), P('THRESHOLD', 'Threshold (K)', 'int', 10, { dft: '1500000' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' })], async (ctx, a) => {
  const lib = ctx.resolveLib(a.JRNRCV.lib === '*LIBL' ? '*CURLIB' : a.JRNRCV.lib);
  if (!(await obj.libExists(lib))) throw new CLError('CPF2110', lib);
  await J.createReceiver(lib, up(a.JRNRCV.obj), { text: a.TEXT === '*BLANK' ? '' : a.TEXT, threshold: Number(a.THRESHOLD) || 1500000 });
  return { id: 'CPC7001', text: `Journal receiver ${up(a.JRNRCV.obj)} created in library ${lib}.` };
});
def('DLTJRNRCV', 'Delete Journal Receiver', [QUAL('JRNRCV', 'Journal receiver', { lib: '*LIBL' })], async (ctx, a) => {
  const o = await find(ctx, a.JRNRCV, '*JRNRCV', 'CPF7019');
  const d = (await obj.objectData(gw, o.LIB, o.NAME, '*JRNRCV')) || {};
  if (d.attached) throw new CLError('CPF7022', o.NAME, o.LIB);
  await obj.deleteObject(o.LIB, o.NAME, '*JRNRCV');
  // Las entradas que estaban en el receptor desaparecen con él
  await gw.exec('DELETE FROM QSYS.JRNENT WHERE RCVLIB = ? AND RCV = ?', [o.LIB, o.NAME]);
  return { id: 'CPC7004', text: `Journal receiver ${o.NAME} in ${o.LIB} deleted.` };
});
def('DSPJRNRCVA', 'Display Journal Receiver Attributes', [QUAL('JRNRCV', 'Journal receiver', { lib: '*LIBL' })], async (ctx, a) => {
  const o = await find(ctx, a.JRNRCV, '*JRNRCV', 'CPF7019');
  const d = (await obj.objectData(gw, o.LIB, o.NAME, '*JRNRCV')) || {};
  const n = await gw.rows('SELECT COUNT(*) AS N, MIN(SEQ) AS F, MAX(SEQ) AS L FROM QSYS.JRNENT WHERE RCVLIB = ? AND RCV = ?', [o.LIB, o.NAME]);
  return { text: [`Receiver . . . . . . . :   ${o.NAME}`, `  Library  . . . . . . :     ${o.LIB}`, `Journal  . . . . . . . :   ${d.attached || '*NONE'}`,
    `Status . . . . . . . . :   ${d.attached ? 'ATTACHED' : d.detached ? 'ONLINE' : 'EMPTY'}`, `Threshold (K) . . . . :   ${d.threshold}`,
    `Number of entries  . . :   ${n[0].N}`, `First sequence number  :   ${n[0].F ?? ''}`, `Last sequence number . :   ${n[0].L ?? ''}`,
    `Attached . . . . . . . :   ${d.created || ''}`, `Detached . . . . . . . :   ${d.detached || ''}`].join('\n') };
});

// ---------- Diarios ----------
def('CRTJRN', 'Create Journal', [QUAL('JRN', 'Journal'), QUAL('JRNRCV', 'Journal receiver', { lib: '*LIBL' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' }), P('MNGRCV', 'Manage receivers', 'name', 7, { dft: '*SYSTEM', choices: '*SYSTEM, *USER' }), P('DLTRCV', 'Delete receivers', 'char', 4, { dft: '*NO' })], async (ctx, a) => {
  const lib = ctx.resolveLib(a.JRN.lib === '*LIBL' ? '*CURLIB' : a.JRN.lib);
  const r = await find(ctx, a.JRNRCV, '*JRNRCV', 'CPF7019');
  await J.createJournal(lib, up(a.JRN.obj), r.LIB, r.NAME, { text: a.TEXT === '*BLANK' ? '' : a.TEXT });
  return { id: 'CPC7002', text: `Journal ${up(a.JRN.obj)} created in library ${lib}.` };
});
def('DLTJRN', 'Delete Journal', [QUAL('JRN', 'Journal', { lib: '*LIBL' })], async (ctx, a) => {
  const o = await find(ctx, a.JRN, '*JRN', 'CPF7002');
  const used = await gw.rows('SELECT LIB, FILE FROM QSYS.JRNPF WHERE JRNLIB = ? AND JRN = ?', [o.LIB, o.NAME]);
  if (used.length) throw new CLError('CPF7021', o.NAME, o.LIB);
  const d = await J.journalData(o.LIB, o.NAME);
  await obj.deleteObject(o.LIB, o.NAME, '*JRN');
  await gw.exec('DELETE FROM QSYS.JRNATT WHERE JRNLIB = ? AND JRN = ?', [o.LIB, o.NAME]);
  // El receptor conectado queda desconectado (ONLINE)
  const cur = d.current;
  const ro = cur && (await obj.findObject(gw, cur.name, '*JRNRCV', cur.lib, []));
  if (ro) { const rd = (await obj.objectData(gw, cur.lib, cur.name, '*JRNRCV')) || {}; rd.attached = null; rd.detached = new Date().toISOString(); await obj.putObject(cur.lib, cur.name, '*JRNRCV', '', ro.TEXT, rd, ro.OWNER); }
  await gw.sql(`DROP SEQUENCE QSYS."JQ_${o.LIB}_${o.NAME}"`);
  return { id: 'CPC7005', text: `Journal ${o.NAME} in ${o.LIB} deleted.` };
});
def('CHGJRN', 'Change Journal', [QUAL('JRN', 'Journal', { lib: '*LIBL' }), P('JRNRCV', 'Journal receiver', 'qual', 10, { dft: '*SAME', choices: 'Name, *SAME, *GEN' }), P('SEQOPT', 'Sequence option', 'name', 6, { dft: '*CONT', choices: '*CONT, *RESET' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*SAME' })], async (ctx, a) => {
  const o = await find(ctx, a.JRN, '*JRN', 'CPF7002');
  const rq = a.JRNRCV && a.JRNRCV.obj ? up(a.JRNRCV.obj) : '*SAME';
  if (rq === '*SAME') { if (a.TEXT !== '*SAME') await gw.exec('UPDATE QSYS.OBJECTS SET TEXT = ? WHERE LIB = ? AND NAME = ? AND TYPE = ?', [a.TEXT, o.LIB, o.NAME, '*JRN']); return { text: `Journal ${o.NAME} changed.` }; }
  let rcvLib = null; let rcv = null;
  if (rq !== '*GEN') { const r = await find(ctx, a.JRNRCV, '*JRNRCV', 'CPF7019'); rcvLib = r.LIB; rcv = r.NAME; }
  const res = await J.changeReceiver(ctx.job, o.LIB, o.NAME, { rcvLib, rcv, reset: a.SEQOPT === '*RESET' });
  return { id: 'CPF7020', text: `Receiver ${res.rcv} in ${res.rcvLib} attached to journal ${o.NAME}.`, sev: 0 };
});
async function jrnaText(o) {
  const d = await J.journalData(o.LIB, o.NAME);
  const files = await gw.rows('SELECT LIB, FILE, IMAGES FROM QSYS.JRNPF WHERE JRNLIB = ? AND JRN = ? ORDER BY LIB, FILE', [o.LIB, o.NAME]);
  return [`Journal  . . . . . . :   ${o.NAME}          Library  . . . . . . :   ${o.LIB}`, `Attached receiver  . :   ${d.current.name}      Library  . . . . . . :   ${d.current.lib}`,
    `Text . . . . . . . . :   ${o.TEXT || ''}`, '', 'Journaled files:', '  File        Library     Images', ...files.map((f) => `  ${padR(f.FILE, 12)}${padR(f.LIB, 12)}${f.IMAGES}`),
    '', 'Receiver directory:', '  Receiver    Library     Attached', ...d.receivers.map((r) => `  ${padR(r.name, 12)}${padR(r.lib, 12)}${String(r.attachedAt).slice(0, 19)}`)];
}
def('WRKJRNA', 'Work with Journal Attributes', [QUAL('JRN', 'Journal', { lib: '*LIBL' }), P('OUTPUT', 'Output', 'char', 6, { dft: '*', choices: '*, *PRINT' })], async (ctx, a) => {
  const o = await find(ctx, a.JRN, '*JRN', 'CPF7002');
  const lines = await jrnaText(o);
  if (!ctx.interactive || a.OUTPUT === '*PRINT') { if (a.OUTPUT === '*PRINT') await obj.createSpool(ctx.job, 'QPDSPJNA', lines, { usrdta: 'WRKJRNA' }); return { text: lines.join('\n') }; }
  const p = new Panel({ fn: 'CMD-WRKJRNA', keys: ['F3', 'F12'] });
  p.title('Work with Journal Attributes');
  lines.slice(0, 18).forEach((l, i) => p.text(3 + i, 2, l, /^(Journaled|Receiver directory)/.test(l) ? 'w' : 'g'));
  p.fkeys('F3=Exit   F12=Cancel   F17=Display attached files   F19=Display journaled objects');
  await ctx.display(p);
  return null;
});

// ---------- STRJRNPF / ENDJRNPF ----------
def('STRJRNPF', 'Start Journal Physical File', [P('FILE', 'Physical file to be journaled', 'list', 100, { req: true }), QUAL('JRN', 'Journal', { lib: '*LIBL' }), P('IMAGES', 'Record images', 'name', 7, { dft: '*AFTER', choices: '*AFTER, *BOTH' }), P('OMTJRNE', 'Journal entries to be omitted', 'name', 8, { dft: '*NONE', choices: '*NONE, *OPNCLO' })], async (ctx, a) => {
  const jo = await find(ctx, a.JRN, '*JRN', 'CPF7002');
  let n = 0;
  for (const f of [].concat(a.FILE)) {
    const [l, nm] = String(f).toUpperCase().includes('/') ? String(f).toUpperCase().split('/') : ['*LIBL', String(f).toUpperCase()];
    const fo = await obj.findObject(gw, nm, '*FILE', l === '*LIBL' ? '*LIBL' : ctx.resolveLib(l), ctx.libl);
    if (!fo) throw new CLError('CPF9812', nm, l);
    if (!['PF', 'PF-DTA'].includes(fo.ATTR)) throw new CLError('CPF7031', nm, fo.LIB);
    await (await sec()).checkAuthority(ctx, fo, ['*OBJMGT']);
    await J.startJournal(ctx.job, fo.LIB, nm, jo.LIB, jo.NAME, { images: a.IMAGES, omtjrne: a.OMTJRNE });
    n++;
  }
  return { id: 'CPC7031', text: `${n} of ${n} files have started journaling.` };
});
def('ENDJRNPF', 'End Journal Physical File', [P('FILE', 'Journaled physical file', 'list', 100, { req: true, choices: 'Name, *ALL' }), P('JRN', 'Journal', 'qual', 10, { dft: '*FILE' })], async (ctx, a) => {
  const files = [].concat(a.FILE).map((x) => String(x).toUpperCase());
  let list;
  if (files[0] === '*ALL') {
    const jo = await find(ctx, a.JRN, '*JRN', 'CPF7002');
    list = await gw.rows('SELECT LIB, FILE FROM QSYS.JRNPF WHERE JRNLIB = ? AND JRN = ?', [jo.LIB, jo.NAME]);
  } else {
    list = [];
    for (const f of files) {
      const [l, nm] = f.includes('/') ? f.split('/') : ['*LIBL', f];
      const fo = await obj.findObject(gw, nm, '*FILE', l === '*LIBL' ? '*LIBL' : ctx.resolveLib(l), ctx.libl);
      if (!fo) throw new CLError('CPF9812', nm, l);
      list.push({ LIB: fo.LIB, FILE: nm });
    }
  }
  for (const f of list) await J.endJournal(ctx.job, f.LIB, f.FILE);
  return { id: 'CPC7032', text: `${list.length} of ${list.length} files have ended journaling.` };
});

// ---------- DSPJRN ----------
const ENTRY_TEXT = { PT: 'Record added', UB: 'Before-image of record updated', UP: 'After-image of record updated', DL: 'Record deleted', PR: 'Previous receiver', JM: 'Start journaling for file', EJ: 'End journaling for file' };
function entryFilter(ctx, a) {
  const f = a.FILE && [].concat(a.FILE)[0] && ![].concat(a.FILE)[0].startsWith('*') ? String([].concat(a.FILE)[0]).toUpperCase() : null;
  const codes = [].concat(a.JRNCDE || '*ALL').map(up).filter((x) => x !== '*ALL');
  const types = [].concat(a.ENTTYP || '*ALL').map(up).filter((x) => x !== '*ALL' && x !== '*RCD');
  if ([].concat(a.ENTTYP || '').map(up).includes('*RCD')) types.push('PT', 'UB', 'UP', 'DL');
  return { f, codes, types };
}
const ts = (t) => { const d = new Date(String(t).replace(' ', 'T')); return Number.isNaN(d.getTime()) ? String(t).slice(0, 19) : `${sysDate(d)} ${sysTime(d)}`; };

def('DSPJRN', 'Display Journal', [
  QUAL('JRN', 'Journal', { lib: '*LIBL' }),
  P('FILE', 'File (library/file)', 'list', 40, { dft: '*ALLFILE' }),
  P('RCVRNG', 'Range of journal receivers', 'list', 40, { dft: '*CURRENT', choices: '*CURRENT, *CURCHAIN' }),
  P('FROMENT', 'Starting sequence number', 'char', 20, { dft: '*FIRST' }),
  P('TOENT', 'Ending sequence number', 'char', 20, { dft: '*LAST' }),
  P('JRNCDE', 'Journal codes', 'list', 40, { dft: '*ALL' }),
  P('ENTTYP', 'Journal entry types', 'list', 40, { dft: '*ALL' }),
  P('OUTPUT', 'Output', 'name', 8, { dft: '*', choices: '*, *PRINT, *OUTFILE' }),
  P('OUTFILE', 'File to receive output', 'qual', 10, { dft: '*NONE' }),
  P('OUTMBR', 'Output member options', 'list', 30, { dft: '*FIRST *REPLACE' }),
], async (ctx, a) => {
  const jo = await find(ctx, a.JRN, '*JRN', 'CPF7002');
  await (await sec()).checkAuthority(ctx, jo, ['*OBJOPR']);
  const d = await J.journalData(jo.LIB, jo.NAME);
  const { f, codes, types } = entryFilter(ctx, a);
  let file = null;
  if (f) { const [l, nm] = f.includes('/') ? f.split('/') : ['*LIBL', f]; const fo = await obj.findObject(gw, nm, '*FILE', l === '*LIBL' ? '*LIBL' : ctx.resolveLib(l), ctx.libl); if (!fo) throw new CLError('CPF9812', nm, l); file = { lib: fo.LIB, name: nm }; }
  const rng = up([].concat(a.RCVRNG)[0]);
  const receivers = rng === '*CURRENT' ? [`${d.current.lib}/${d.current.name}`] : null;
  const list = await J.entries(jo.LIB, jo.NAME, { file, codes, types, receivers, fromSeq: /^\d+$/.test(a.FROMENT) ? Number(a.FROMENT) : null, toSeq: /^\d+$/.test(a.TOENT) ? Number(a.TOENT) : null });
  const line = (e) => `${padL(e.SEQ, 10)}  ${e.CODE}     ${e.ENTT}    ${padR(e.OBJ || '', 10)}  ${padR(e.OBJLIB || '', 10)}  ${padR(e.JOB ? e.JOB.split('/').pop() : '', 10)}  ${padR(e.USR || '', 10)}  ${padR(e.PGM || '', 10)}  ${ts(e.TS)}`;
  if (a.OUTPUT === '*OUTFILE') {
    if (!a.OUTFILE || !a.OUTFILE.obj || a.OUTFILE.obj === '*NONE') throw new CLError('CPD0072', 'OUTFILE');
    const lib = ctx.resolveLib(a.OUTFILE.lib === '*LIBL' ? '*CURLIB' : a.OUTFILE.lib);
    const t = `${lib}.${up(a.OUTFILE.obj)}`;
    // Formato de salida QADSPJRN (JOENTL … JOESD)
    const ex = await obj.findObject(gw, up(a.OUTFILE.obj), '*FILE', lib, []);
    if (!ex) await gw.exec(`CREATE TABLE ${t} (JOENTL DECIMAL(5, 0), JOSEQN DECIMAL(10, 0), JOCODE CHAR(1), JOENTT CHAR(2), JODATE CHAR(6), JOTIME DECIMAL(6, 0), JOJOB CHAR(10), JOUSER CHAR(10), JONBR DECIMAL(6, 0), JOPGM CHAR(10), JOOBJ CHAR(10), JOLIB CHAR(10), JOMBR CHAR(10), JOCTRR DECIMAL(10, 0), JOFLAG CHAR(1), JOCCID DECIMAL(10, 0), JOUSPF CHAR(10), JOSYNM CHAR(8), JOESD VARCHAR(4000))`);
    else if (!/\*ADD/.test([].concat(a.OUTMBR).join(' '))) await gw.exec(`DELETE FROM ${t} WHERE 1 = 1`);
    const stmts = list.map((e) => {
      const dt = new Date(String(e.TS).replace(' ', 'T'));
      const [nbr, usr, job] = String(e.JOB || '').split('/');
      const p2 = (n) => String(n).padStart(2, '0');
      return { sql: `INSERT INTO ${t} (JOENTL, JOSEQN, JOCODE, JOENTT, JODATE, JOTIME, JOJOB, JOUSER, JONBR, JOPGM, JOOBJ, JOLIB, JOMBR, JOCTRR, JOFLAG, JOCCID, JOUSPF, JOSYNM, JOESD) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`,
        params: [125 + String(e.DATA || '').length, e.SEQ, e.CODE, e.ENTT, `${p2(dt.getMonth() + 1)}${p2(dt.getDate())}${String(dt.getFullYear()).slice(2)}`, Number(`${p2(dt.getHours())}${p2(dt.getMinutes())}${p2(dt.getSeconds())}`), job || '', usr || e.USR || '', Number(nbr) || 0, e.PGM || '', e.OBJ || '', e.OBJLIB || '', e.MBR || '', e.ENTT === 'UB' ? '1' : '0', e.USR || '', 'AS400TDS', String(e.DATA || '').slice(0, 4000)] };
    });
    for (let i = 0; i < stmts.length; i += 200) await gw.batch(stmts.slice(i, i + 200), []);
    await obj.syncSqlTables(lib);
    return { id: 'CPF7062', text: `${list.length} entries converted from journal ${jo.NAME} to file ${up(a.OUTFILE.obj)} in ${lib}.`, sev: 0 };
  }
  const head = ['  Sequence  Code  Type  Object      Library     Job         User        Program     Time'];
  if (!ctx.interactive || a.OUTPUT === '*PRINT') {
    const lines = [`Journal . . . . . :   ${jo.NAME}    Library . . . . . :   ${jo.LIB}`, '', ...head, ...list.map(line)];
    if (a.OUTPUT === '*PRINT') await obj.createSpool(ctx.job, 'QPDSPJRN', lines, { usrdta: 'DSPJRN' });
    return { text: lines.join('\n') };
  }
  let top = 0;
  for (;;) {
    const p = new Panel({ fn: 'CMD-DSPJRN', keys: ['F3', 'F12', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Display Journal Entries');
    p.info(3, 2, 'Journal', jo.NAME, 20); p.info(3, 42, 'Library', jo.LIB, 16);
    p.text(5, 2, 'Type options, press Enter.', 'b'); p.text(6, 4, '5=Display entire entry', 'b');
    p.text(8, 2, 'Opt  Sequence  Code  Type  Object      Library     Job         Time', 'w');
    const page = list.slice(top, top + 12);
    page.forEach((e, i) => { p.input(`O${i}`, 9 + i, 3, 1, {}); p.text(9 + i, 7, `${padL(e.SEQ, 8)}  ${e.CODE}     ${e.ENTT}    ${padR(e.OBJ || '', 10)}  ${padR(e.OBJLIB || '', 10)}  ${padR(e.JOB ? e.JOB.split('/').pop() : '', 10)}  ${ts(e.TS).slice(9)}`); });
    if (!list.length) p.text(9, 7, '(No entries selected)');
    p.more(21, top + 12 < list.length);
    p.fkeys('F3=Exit   F12=Cancel');
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'PAGEDOWN') { if (top + 12 < list.length) top += 12; continue; }
    if (r.aid === 'PAGEUP') { top = Math.max(0, top - 12); continue; }
    const i = page.findIndex((_, k) => (r.fields[`O${k}`] || '').trim() === '5');
    if (i < 0) continue;
    const e = page[i];
    const q = new Panel({ fn: 'CMD-DSPJRNE', keys: ['F3', 'F12'] });
    q.title('Display Journal Entry');
    [['Object', `${e.OBJ || ''}  Library ${e.OBJLIB || ''}  Member ${e.MBR || ''}`], ['Sequence', String(e.SEQ)], ['Code', `${e.CODE} - ${e.CODE === 'R' ? 'Operation on specific record' : e.CODE === 'J' ? 'Journal or journal receiver operation' : e.CODE === 'F' ? 'Database file member operation' : 'User-generated'}`],
      ['Type', `${e.ENTT} - ${ENTRY_TEXT[e.ENTT] || ''}`], ['Date / time', ts(e.TS)], ['Job', e.JOB || ''], ['User profile', e.USR || ''], ['Program', e.PGM || ''], ['Receiver', `${e.RCV || ''} in ${e.RCVLIB || ''}`]]
      .forEach(([k, v], j) => q.info(3 + j, 2, k, v, 22));
    q.text(13, 2, 'Entry specific data', 'w');
    const data = String(e.DATA || '');
    for (let j = 0; j < 7; j++) q.text(14 + j, 4, data.slice(j * 74, (j + 1) * 74));
    q.fkeys('F3=Exit   F12=Cancel');
    await ctx.display(q);
  }
});

// ---------- APYJRNCHG / RMVJRNCHG / SNDJRNE ----------
for (const [cmd, title, undo] of [['APYJRNCHG', 'Apply Journaled Changes', false], ['RMVJRNCHG', 'Remove Journaled Changes', true]]) {
  def(cmd, title, [QUAL('JRN', 'Journal', { lib: '*LIBL' }), P('FILE', 'Journaled file (library/file)', 'list', 40, { req: true }), P('RCVRNG', 'Range of journal receivers', 'list', 40, { dft: '*LASTSAVE' }), P('FROMENT', 'Starting sequence number', 'char', 20, { dft: undo ? '*LAST' : '*LASTSAVE' }), P('TOENT', 'Ending sequence number', 'char', 20, { dft: undo ? '*FIRST' : '*LASTRST' })], async (ctx, a) => {
    const jo = await find(ctx, a.JRN, '*JRN', 'CPF7002');
    const f = String([].concat(a.FILE)[0]).toUpperCase();
    const [l, nm] = f.includes('/') ? f.split('/') : ['*LIBL', f];
    const fo = await obj.findObject(gw, nm, '*FILE', l === '*LIBL' ? '*LIBL' : ctx.resolveLib(l), ctx.libl);
    if (!fo) throw new CLError('CPF9812', nm, l);
    await (await sec()).checkAuthority(ctx, fo, ['*OBJEXIST', '*OBJOPR', '*ADD', '*UPD', '*DLT']);
    const num = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
    let from = num(a.FROMENT);
    let to = num(a.TOENT);
    // *LASTSAVE: desde la entrada siguiente al último salvado del archivo (SAVOBJ/SAVLIB lo anotan)
    if (!undo && (a.FROMENT === '*LASTSAVE' || a.FROMENT === '*FIRST')) {
      const fd = (await obj.objectData(gw, fo.LIB, nm, '*FILE').catch(() => null)) || {};
      from = a.FROMENT === '*LASTSAVE' && fd.lastSaveSeq ? fd.lastSaveSeq + 1 : null;
    }
    // La propia restauración no se vuelve a aplicar: hasta la última entrada anterior a RSTOBJ (*LASTRST = todas)
    let list = await J.entries(jo.LIB, jo.NAME, { file: { lib: fo.LIB, name: nm }, codes: ['R'], fromSeq: undo ? null : from, toSeq: undo ? null : to });
    if (undo) list = list.filter((e) => (from === null || e.SEQ <= from) && (to === null || e.SEQ >= to));
    if (!undo && to === null) {
      const fd = (await obj.objectData(gw, fo.LIB, nm, '*FILE').catch(() => null)) || {};
      if (fd.restoredAtSeq) list = list.filter((e) => e.SEQ <= fd.restoredAtSeq);
    }
    list = list.filter((e) => e.ENTT !== 'UB');
    // Los cambios aplicados no vuelven a anotarse como cambios del usuario: se registran, como en IBM i
    const n = await J.applyChanges(fo.LIB, nm, list, { undo });
    return { id: undo ? 'CPC7062' : 'CPC7060', text: `${n} entries ${undo ? 'removed' : 'applied'} for file ${nm} in ${fo.LIB}.`, sev: 0 };
  });
}
def('SNDJRNE', 'Send Journal Entry', [QUAL('JRN', 'Journal', { lib: '*LIBL' }), P('TYPE', 'Journal entry type', 'char', 2, { dft: '00' }), P('ENTDTA', 'Entry data', 'text', 512, { dft: '*BLANK' }), P('OBJ', 'Journaled object (library/file)', 'list', 40, { dft: '*NONE' })], async (ctx, a) => {
  const jo = await find(ctx, a.JRN, '*JRN', 'CPF7002');
  const o = [].concat(a.OBJ)[0];
  const [ol, on] = o && o !== '*NONE' ? (String(o).includes('/') ? String(o).toUpperCase().split('/') : [ctx.curlib, String(o).toUpperCase()]) : [null, null];
  await J.writeEntry(ctx.job, jo.LIB, jo.NAME, 'U', up(a.TYPE).padEnd(2, '0').slice(0, 2), { objLib: ol, obj: on, data: a.ENTDTA === '*BLANK' ? '' : String(a.ENTDTA) });
  return { text: `Journal entry sent to journal ${jo.NAME}.` };
});
