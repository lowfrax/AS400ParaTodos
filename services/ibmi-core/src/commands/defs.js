// Definición de los mandatos CL disponibles (parámetros para el prompter + implementación).
import { def } from './registry.js';
import { CLError, msg, msgText } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { SignOff } from '../session.js';
import { logJob } from '../system.js';
import { invalidateTables } from '../ctx.js';
import { compileObject, submitJob } from '../runtime/build.js';
import { callProgram, clearProgramMessages } from '../runtime/call.js';
import { goMenu } from '../screens/menus.js';
import { wrkactjob, wrksyssts, wrksbs } from '../screens/work.js';
import { wrksplf } from '../screens/spool.js';
import { dspmsg, sndmsg, dspjoblog } from '../screens/msgs.js';
import { strpdm, wrklibpdm, wrkobjpdm, wrkmbrpdm } from '../screens/pdm.js';
import { seu } from '../screens/seu.js';
import { strsql } from '../screens/strsql.js';
import { dsplibl, dsplib, dspobjd, dsppfm, dspffd, wrkusrprf, wrksysval, commandEntry } from '../screens/misc.js';
import { refreshMW } from '../mw.js';
import { Panel } from '../panel.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const LIBQ = (kw, prompt, o = {}) => P(kw, prompt, 'qual', 10, { req: true, ...o });
const TEXT = P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' });
const textVal = (t) => (!t || t === '*BLANK' ? '' : t);
const I = { interactive: true };

async function requireLib(ctx, lib) {
  const l = ctx.resolveLib(lib);
  if (!(await obj.libExists(l))) throw new CLError('CPF2110', l);
  return l;
}

async function resolveLibOf(ctx, q, type) {
  if (q.lib !== '*LIBL') return requireLib(ctx, q.lib);
  const o = await obj.findObject(gw, q.obj, type, '*LIBL', ctx.libl);
  if (!o) throw new CLError(type === '*PGM' ? 'CPF9811' : type === '*FILE' ? 'CPF9812' : 'CPF9801', q.obj, '*LIBL');
  return o.LIB;
}

// ---------- Sesión y menús ----------
def('SIGNOFF', 'Sign Off', [P('LOG', 'Job log', 'char', 7, { dft: '*NOLIST', choices: '*NOLIST, *LIST' })], async (ctx, a) => {
  if (a.LOG === '*LIST') await obj.createSpool(ctx.job, 'QPJOBLOG', ctx.job.joblog.map((e) => `${(e.id || '').padEnd(8)} ${e.type.padEnd(8)} ${e.text}`), { usrdta: ctx.job.name, outq: 'QEZJOBLOG' });
  throw new SignOff();
}, I);
def('GO', 'Go to Menu', [P('MENU', 'Menu', 'name', 10, { req: true, choices: 'Name, *ALL' })], async (ctx, a) => {
  const r = await goMenu(ctx, a.MENU);
  return null && r;
}, I);
def('WRKACTJOB', 'Work with Active Jobs', [P('SBS', 'Subsystem', 'name', 10, { dft: '*ALL' })], async (ctx, a) => { await wrkactjob(ctx, a.SBS); }, I);
def('WRKSYSSTS', 'Work with System Status', [], async (ctx) => { await wrksyssts(ctx); }, I);
def('WRKSBS', 'Work with Subsystems', [], async (ctx) => { await wrksbs(ctx); }, I);
def('WRKSPLF', 'Work with Spooled Files', [P('SELECT', 'User', 'name', 10, { dft: '*CURRENT', choices: 'Name, *CURRENT, *ALL' })], async (ctx, a) => {
  await wrksplf(ctx, a.SELECT === '*CURRENT' ? ctx.job.user : a.SELECT);
}, I);
def('WRKOUTQ', 'Work with Output Queue', [P('OUTQ', 'Output queue', 'name', 10, { dft: '*ALL' })], async (ctx) => { await wrksplf(ctx, '*ALL'); }, I);
def('DSPMSG', 'Display Messages', [P('MSGQ', 'Message queue', 'name', 10, { dft: '*WRKUSR', choices: 'Name, *WRKUSR, *SYSOPR' })], async (ctx, a) => {
  await dspmsg(ctx, a.MSGQ === '*WRKUSR' ? ctx.job.user : a.MSGQ === '*SYSOPR' ? 'QSYSOPR' : a.MSGQ);
}, I);
def('SNDMSG', 'Send Message', [
  P('MSG', 'Message text', 'text', 256, { req: true, promptLen: 120 }),
  P('TOUSR', 'To user profile', 'name', 10, { req: true, choices: 'Name, *SYSOPR, *ALLACT' }),
], async (ctx, a) => {
  if (a.TOUSR === '*ALLACT') {
    const { sessions } = await import('../session.js');
    const users = new Set([...sessions].filter((s) => s.job).map((s) => s.job.user));
    for (const u of users) await sndmsg(ctx, a.MSG, u);
  } else {
    if (a.TOUSR !== '*SYSOPR' && a.TOUSR !== 'QSYSOPR' && !(await obj.getUser(a.TOUSR))) throw new CLError('CPF2204', a.TOUSR);
    await sndmsg(ctx, a.MSG, a.TOUSR === '*SYSOPR' ? 'QSYSOPR' : a.TOUSR);
  }
  return null;
});
def('DSPJOBLOG', 'Display Job Log', [P('JOB', 'Job name', 'name', 10, { dft: '*' })], async (ctx) => { await dspjoblog(ctx); }, I);
def('DSPJOB', 'Display Job', [], async (ctx) => { await dspjoblog(ctx); }, I);
def('WRKJOB', 'Work with Job', [], async (ctx) => { await dspjoblog(ctx); }, I);

// ---------- Lista de bibliotecas ----------
// OUTPUT(*) en un trabajo por lotes (o OUTPUT(*PRINT)) imprime la lista en QPRTLIBL, como en IBM i; QSH 'system' la ve en stdout
def('DSPLIBL', 'Display Library List', [P('OUTPUT', 'Output', 'char', 6, { dft: '*', choices: '*, *PRINT' })], async (ctx, a) => {
  if (ctx.interactive && a.OUTPUT !== '*PRINT') { await dsplibl(ctx); return null; }
  const text = new Map((await obj.libraries()).map((l) => [l.NAME, l.TEXT]));
  const sys = ['QSYS', 'QSYS2', 'QHLPSYS', 'QUSRSYS'];
  const lines = ['                                     Library List', '', '  Library     Type      Text Description',
    ...ctx.libl.map((l) => `  ${l.padEnd(10)}  ${(sys.includes(l) ? 'SYS' : l === ctx.job.curlib ? 'CUR' : 'USR').padEnd(8)}  ${text.get(l) || ''}`.replace(/\s+$/, '')),
    '', '                         * * * * *  E N D  O F  L I S T I N G  * * * * *'];
  await obj.createSpool(ctx.job, 'QPRTLIBL', lines, { usrdta: 'DSPLIBL' });
  return { text: lines.join('\n') };
});
def('CHGCURLIB', 'Change Current Library', [P('CURLIB', 'Current library', 'name', 10, { req: true, choices: 'Name, *CRTDFT' })], async (ctx, a) => {
  if (a.CURLIB === '*CRTDFT') ctx.job.curlib = null;
  else { await requireLib(ctx, a.CURLIB); ctx.job.curlib = a.CURLIB; }
  return msg('CPC2198', a.CURLIB);
});
def('ADDLIBLE', 'Add Library List Entry', [
  P('LIB', 'Library', 'name', 10, { req: true }),
  P('POSITION', 'Library list position', 'char', 8, { dft: '*FIRST', choices: '*FIRST, *LAST' }),
], async (ctx, a) => {
  await requireLib(ctx, a.LIB);
  if (ctx.job.libl.includes(a.LIB)) throw new CLError('CPF2103', a.LIB);
  if (a.POSITION === '*LAST') ctx.job.libl.push(a.LIB); else ctx.job.libl.unshift(a.LIB);
  return msg('CPC2196', a.LIB);
});
def('RMVLIBLE', 'Remove Library List Entry', [P('LIB', 'Library', 'name', 10, { req: true })], async (ctx, a) => {
  const i = ctx.job.libl.indexOf(a.LIB);
  if (i < 0) throw new CLError('CPF2104', a.LIB);
  ctx.job.libl.splice(i, 1);
  return msg('CPC2197', a.LIB);
});
def('CHGLIBL', 'Change Library List', [P('LIBL', 'Libraries for current thread', 'list', 60, { req: true }), P('CURLIB', 'Current library', 'name', 10, { dft: '*SAME' })], async (ctx, a) => {
  for (const l of a.LIBL) if (l !== '*NONE') await requireLib(ctx, l);
  ctx.job.libl = a.LIBL.filter((l) => l !== '*NONE');
  if (a.CURLIB !== '*SAME') ctx.job.curlib = a.CURLIB === '*CRTDFT' ? null : a.CURLIB;
  return msg('CPC2101');
});

// ---------- Bibliotecas y objetos ----------
def('CRTLIB', 'Create Library', [
  P('LIB', 'Library', 'name', 10, { req: true }),
  P('TYPE', 'Library type', 'char', 5, { dft: '*PROD', choices: '*PROD, *TEST', values: ['*PROD', '*TEST'] }),
  TEXT,
], async (ctx, a) => {
  if (a.LIB.startsWith('*')) throw new CLError('CPD0078', a.LIB, 'LIB');
  await obj.createLibrary(a.LIB, textVal(a.TEXT), a.TYPE, ctx.job.user);
  return msg('CPC2102', a.LIB);
});
def('DLTLIB', 'Delete Library', [P('LIB', 'Library', 'name', 10, { req: true })], async (ctx, a) => {
  if (ctx.job.curlib === a.LIB || ctx.job.libl.includes(a.LIB)) throw new CLError('CPF2165', a.LIB);
  await obj.deleteLibrary(a.LIB);
  invalidateTables(a.LIB);
  return msg('CPC2160', a.LIB);
});
def('CLRLIB', 'Clear Library', [P('LIB', 'Library', 'name', 10, { req: true })], async (ctx, a) => {
  await requireLib(ctx, a.LIB);
  await obj.clearLibrary(a.LIB);
  invalidateTables(a.LIB);
  return msg('CPC2213', a.LIB);
});
def('DSPLIB', 'Display Library', [P('LIB', 'Library', 'name', 10, { dft: '*LIBL' })], async (ctx, a) => {
  if (a.LIB === '*LIBL') return dsplibl(ctx).then(() => null);
  await dsplib(ctx, ctx.resolveLib(a.LIB));
  return null;
}, I);
def('WRKLIB', 'Work with Libraries', [P('LIB', 'Library', 'name', 10, { dft: '*ALL' })], async (ctx, a) => { await wrklibpdm(ctx, a.LIB); }, I);
def('WRKOBJ', 'Work with Objects', [LIBQ('OBJ', 'Object', { req: false, dft: '*ALL', lib: '*LIBL' }), P('OBJTYPE', 'Object type', 'name', 10, { dft: '*ALL' })], async (ctx, a) => {
  const lib = a.OBJ.lib === '*LIBL' ? ctx.curlib : ctx.resolveLib(a.OBJ.lib);
  await wrkobjpdm(ctx, lib, a.OBJ.obj || '*ALL', a.OBJTYPE);
}, I);
def('DSPOBJD', 'Display Object Description', [LIBQ('OBJ', 'Object'), P('OBJTYPE', 'Object type', 'name', 10, { req: true })], async (ctx, a) => {
  await dspobjd(ctx, a.OBJ.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.OBJ.lib), a.OBJ.obj, a.OBJTYPE);
}, I);
def('DLTOBJ', 'Delete Object', [LIBQ('OBJ', 'Object'), P('OBJTYPE', 'Object type', 'name', 10, { req: true })], async (ctx, a) => {
  const lib = await resolveLibOf(ctx, a.OBJ, a.OBJTYPE);
  await obj.deleteObject(lib, a.OBJ.obj, a.OBJTYPE);
  invalidateTables(lib);
  return msg('CPC2191', a.OBJ.obj, lib, a.OBJTYPE);
});
def('DLTPGM', 'Delete Program', [LIBQ('PGM', 'Program')], async (ctx, a) => {
  const lib = await resolveLibOf(ctx, a.PGM, '*PGM');
  await obj.deleteObject(lib, a.PGM.obj, '*PGM');
  return msg('CPC2191', a.PGM.obj, lib, '*PGM');
});
def('DLTF', 'Delete File', [LIBQ('FILE', 'File')], async (ctx, a) => {
  const lib = await resolveLibOf(ctx, a.FILE, '*FILE');
  await obj.deleteObject(lib, a.FILE.obj, '*FILE');
  invalidateTables(lib);
  return msg('CPC2191', a.FILE.obj, lib, '*FILE');
});
def('CHKOBJ', 'Check Object', [LIBQ('OBJ', 'Object'), P('OBJTYPE', 'Object type', 'name', 10, { req: true })], async (ctx, a) => {
  const o = await obj.findObject(gw, a.OBJ.obj, a.OBJTYPE, a.OBJ.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.OBJ.lib), ctx.libl);
  if (!o) {
    if (a.OBJTYPE === '*LIB' && await obj.libExists(a.OBJ.obj)) return null;
    throw new CLError('CPF9801', a.OBJ.obj, a.OBJ.lib);
  }
  return null;
});

// ---------- Archivos fuente, miembros y SEU ----------
def('CRTSRCPF', 'Create Source Physical File', [
  LIBQ('FILE', 'File', { lib: '*CURLIB', libChoices: 'Name, *CURLIB' }),
  P('RCDLEN', 'Record length', 'int', 5, { dft: '112', choices: 'Number' }),
  P('MBR', 'Member', 'name', 10, { dft: '*NONE', choices: 'Name, *NONE, *FILE' }),
  TEXT,
], async (ctx, a) => {
  const lib = await requireLib(ctx, a.FILE.lib);
  await obj.createSourceFile(lib, a.FILE.obj, a.RCDLEN, textVal(a.TEXT));
  if (a.MBR && a.MBR !== '*NONE') await obj.addMember(lib, a.FILE.obj, a.MBR === '*FILE' ? a.FILE.obj : a.MBR, '', '');
  return msg('CPC7301', a.FILE.obj, lib);
});
def('ADDPFM', 'Add Physical File Member', [
  LIBQ('FILE', 'Physical file'), P('MBR', 'Member', 'name', 10, { req: true }), TEXT,
  P('SRCTYPE', 'Source type', 'name', 10, { dft: '*NONE' }),
], async (ctx, a) => {
  const lib = await resolveLibOf(ctx, a.FILE, '*FILE');
  await obj.addMember(lib, a.FILE.obj, a.MBR, a.SRCTYPE === '*NONE' ? '' : a.SRCTYPE, textVal(a.TEXT));
  return msg('CPC3102', a.MBR, a.FILE.obj, lib);
});
def('RMVM', 'Remove Member', [LIBQ('FILE', 'Database file'), P('MBR', 'Member', 'name', 10, { req: true })], async (ctx, a) => {
  const lib = await resolveLibOf(ctx, a.FILE, '*FILE');
  await obj.removeMember(lib, a.FILE.obj, a.MBR);
  return msg('CPC3101', a.MBR, a.FILE.obj, lib);
});
def('STRSEU', 'Start Source Entry Utility', [
  LIBQ('SRCFILE', 'Source file', { req: false, dft: 'QRPGLESRC' }),
  P('SRCMBR', 'Source member', 'name', 10, { req: true }),
  P('TYPE', 'Source type', 'name', 10, { dft: '*SAME', choices: 'Name, *SAME, RPGLE, SQLRPGLE, RPG, RPG38, RPG36, CLLE, CLP, PF, LF, DSPF, PRTF' }),
  P('OPTION', 'Option', 'char', 1, { dft: '2', choices: '2=Edit, 5=Browse' }),
  P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' }),
], async (ctx, a) => {
  const lib = await resolveLibOf(ctx, a.SRCFILE, '*FILE');
  let type = a.TYPE;
  if (type === '*SAME') {
    const m = await obj.findMember(gw, lib, a.SRCFILE.obj, a.SRCMBR, []);
    type = m ? m.TYPE : ({ QRPGLESRC: 'RPGLE', QRPGSRC: 'RPG', QS36SRC: 'RPG36', QCLLESRC: 'CLLE', QCLSRC: 'CLP', QDDSSRC: 'PF', QSQLSRC: 'SQL' }[a.SRCFILE.obj] || 'TXT');
  }
  return seu(ctx, { lib, file: a.SRCFILE.obj, mbr: a.SRCMBR, type, mode: a.OPTION === '5' ? 'browse' : 'edit', text: textVal(a.TEXT) });
}, I);
def('STRPDM', 'Start PDM', [], async (ctx) => strpdm(ctx), I);
def('WRKLIBPDM', 'Work with Libraries using PDM', [P('LIB', 'Library', 'name', 10, { dft: '*LIBL' })], async (ctx, a) => { await wrklibpdm(ctx, a.LIB); }, I);
def('WRKOBJPDM', 'Work with Objects using PDM', [
  P('LIB', 'Library', 'name', 10, { dft: '*CURLIB' }), P('OBJ', 'Object', 'name', 10, { dft: '*ALL' }), P('OBJTYPE', 'Object type', 'name', 10, { dft: '*ALL' }),
], async (ctx, a) => { await wrkobjpdm(ctx, ctx.resolveLib(a.LIB), a.OBJ, a.OBJTYPE); }, I);
def('WRKMBRPDM', 'Work with Members using PDM', [
  LIBQ('FILE', 'File'), P('MBR', 'Member', 'name', 10, { dft: '*ALL' }), P('MBRTYPE', 'Member type', 'name', 10, { dft: '*ALL' }),
], async (ctx, a) => { await wrkmbrpdm(ctx, a.FILE.lib === '*LIBL' ? null : ctx.resolveLib(a.FILE.lib), a.FILE.obj, a.MBR, a.MBRTYPE); }, I);

// ---------- Compilación ----------
const compileDef = (name, title, type, kw = 'PGM', srcDft = 'QRPGLESRC', extra = []) => def(name, title, [
  LIBQ(kw, kw === 'FILE' ? 'File' : kw === 'OBJ' ? 'Object' : 'Program', { lib: '*CURLIB', libChoices: 'Name, *CURLIB' }),
  LIBQ('SRCFILE', 'Source file', { req: false, dft: srcDft }),
  P('SRCMBR', 'Source member', 'name', 10, { dft: kw === 'FILE' ? '*FILE' : kw === 'MODULE' ? '*MODULE' : '*PGM', choices: 'Name, *PGM' }),
  P('TEXT', "Text 'description'", 'text', 50, { dft: '*SRCMBRTXT' }),
  ...extra,
], async (ctx, a) => compileObject(ctx, {
  type: type || null, obj: a[kw], srcfile: a.SRCFILE, srcmbr: a.SRCMBR, text: a.TEXT, replace: a.REPLACE === '*YES',
  module: name === 'CRTRPGMOD' || (name === 'CRTSQLRPGI' && a.OBJTYPE === '*MODULE'), bnddir: a.BNDDIR, bndsrvpgm: a.BNDSRVPGM, commit: a.COMMIT,
}));
const BND = [
  P('DFTACTGRP', 'Default activation group', 'char', 4, { dft: '*YES', choices: '*YES, *NO' }),
  P('ACTGRP', 'Activation group', 'name', 10, { dft: '*STGMDL', choices: 'Name, *STGMDL, *NEW, *CALLER' }),
  P('BNDDIR', 'Binding directory', 'list', 60, { dft: '*NONE' }),
];
compileDef('CRTBNDRPG', 'Create Bound RPG Program', 'RPGLE', 'PGM', 'QRPGLESRC', BND);
compileDef('CRTRPGMOD', 'Create RPG Module', 'RPGLE', 'MODULE', 'QRPGLESRC');
compileDef('CRTRPGPGM', 'Create RPG Program', 'RPG', 'PGM', 'QRPGSRC');
// COMMIT: en IBM i el valor por omisión es *CHG, que sobre tablas sin diario da SQL7008; aquí las tablas no se registran
// por diario, así que el valor por omisión es *NONE y *CHG/*CS/*ALL/*RR activan el control de compromiso como SET OPTION.
compileDef('CRTSQLRPGI', 'Create SQL ILE RPG Object', 'SQLRPGLE', 'OBJ', 'QRPGLESRC', [P('OBJTYPE', 'Compile type', 'name', 10, { dft: '*PGM', choices: '*PGM, *MODULE, *SRVPGM' }),
  P('COMMIT', 'Commitment control', 'name', 6, { dft: '*NONE', choices: '*CHG, *UR, *CS, *ALL, *RS, *RR, *NONE, *NC' }), ...BND]);
compileDef('CRTBNDCL', 'Create Bound CL Program', 'CLLE', 'PGM', 'QCLLESRC');

// CVTRPGSRC: RPG III / RPG/400 / RPG II → ILE RPG (RPG IV) en columnas fijas
def('CVTRPGSRC', 'Convert RPG Source', [
  LIBQ('FROMFILE', 'From file', { dft: 'QRPGSRC' }),
  P('FROMMBR', 'From member', 'name', 10, { req: true, choices: 'Name, generic*, *ALL' }),
  LIBQ('TOFILE', 'To file', { req: false, dft: 'QRPGLESRC', lib: '*FROMLIB' }),
  P('TOMBR', 'To member', 'name', 10, { dft: '*FROMMBR', choices: 'Name, *FROMMBR' }),
  P('EXPCPY', 'Expand copy member', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }),
  P('LOGFILE', 'Log file', 'name', 10, { dft: '*NONE' }),
], async (ctx, a) => {
  const { cvtrpgsrc } = await import('../../../../shared/rpg/cvtrpgsrc.js');
  const fromLib = await resolveLibOf(ctx, a.FROMFILE, '*FILE');
  const toLib = !a.TOFILE.lib || a.TOFILE.lib === '*FROMLIB' || a.TOFILE.lib === '*LIBL' ? fromLib : ctx.resolveLib(a.TOFILE.lib);
  const toFile = a.TOFILE.obj || 'QRPGLESRC';
  if (!(await obj.findObject(gw, toFile, '*FILE', toLib, []))) throw new CLError('CPF9812', toFile, toLib);
  const all = await obj.listMembers(fromLib, a.FROMFILE.obj);
  const pat = String(a.FROMMBR).toUpperCase();
  const mbrs = pat === '*ALL' ? all : pat.endsWith('*') ? all.filter((m) => m.MBR.startsWith(pat.slice(0, -1))) : all.filter((m) => m.MBR === pat);
  if (!mbrs.length) throw new CLError('CPF9815', a.FROMMBR, a.FROMFILE.obj, fromLib);
  const TYPE_MAP = { RPG: 'RPGLE', RPG38: 'RPGLE', RPG36: 'RPGLE', RPT: 'RPGLE', RPT38: 'RPGLE', SQLRPG: 'SQLRPGLE', '': 'RPGLE' };
  let done = 0;
  for (const m of mbrs) {
    const type = String(m.TYPE || '').toUpperCase();
    if (!(type in TYPE_MAP)) { logJob(ctx.job, 'CPF5D03', '*DIAG', `Member ${m.MBR} not converted: source type ${type} is not RPG.`, { sev: 10 }); continue; }
    const toMbr = a.TOMBR === '*FROMMBR' || !a.TOMBR ? m.MBR : a.TOMBR;
    const src = await obj.readMember(gw, fromLib, a.FROMFILE.obj, m.MBR);
    const { lines } = cvtrpgsrc(src.map((x) => x.text), { name: m.MBR });
    const existing = await obj.listMembers(toLib, toFile);
    if (existing.some((x) => x.MBR === toMbr)) throw new CLError('CPF3213', toMbr, toFile, toLib);
    await obj.addMember(toLib, toFile, toMbr, TYPE_MAP[type], m.TEXT || '');
    await obj.writeMember(toLib, toFile, toMbr, lines.map((t, i) => ({ seq: (i + 1) * 100, dat: 0, text: t })));
    logJob(ctx.job, '', '*INFO', `Member ${m.MBR} converted to ${toLib}/${toFile}(${toMbr}).`);
    done++;
  }
  return { text: `${done} members converted out of ${mbrs.length} attempted.` };
});
compileDef('CRTCLPGM', 'Create CL Program', 'CLP', 'PGM', 'QCLSRC');
compileDef('CRTPF', 'Create Physical File', 'PF', 'FILE', 'QDDSSRC', [P('REPLACE', 'Replace file', 'char', 4, { dft: '*NO', choices: '*NO, *YES' })]);
compileDef('CRTDSPF', 'Create Display File', 'DSPF', 'FILE', 'QDDSSRC');
compileDef('CRTLF', 'Create Logical File', 'LF', 'FILE', 'QDDSSRC');
def('CRTPRTF', 'Create Printer File', [
  LIBQ('FILE', 'File', { lib: '*CURLIB', libChoices: 'Name, *CURLIB' }),
  LIBQ('SRCFILE', 'Source file', { req: false, dft: 'QDDSSRC' }),
  P('SRCMBR', 'Source member', 'name', 10, { dft: '*FILE', choices: 'Name, *FILE' }),
  P('PAGESIZE', 'Page size (length width)', 'list', 12, { dft: '66 132' }),
  P('OVRFLW', 'Overflow line number', 'int', 3, { dft: '60' }),
  P('REPLACE', 'Replace file', 'char', 4, { dft: '*YES', choices: '*YES, *NO' }),
  TEXT,
], async (ctx, a) => {
  const ps = String(a.PAGESIZE || '66 132').replace(/[()]/g, ' ').trim().split(/\s+/).map(Number);
  return compileObject(ctx, {
    type: 'PRTF', obj: a.FILE, srcfile: a.SRCFILE, srcmbr: a.SRCMBR, text: a.TEXT, replace: a.REPLACE !== '*NO',
    pagesize: [ps[0] || 66, ps[1] || 132], ovrflw: Number(a.OVRFLW || 60),
  });
});
def('DSPDBR', 'Display Database Relations', [LIBQ('FILE', 'File')], async (ctx, a) => {
  const lib = await resolveLibOf(ctx, a.FILE, '*FILE');
  const deps = await obj.dependentLogicals(lib, a.FILE.obj);
  const lines = [`File  . . . . . . . . . . :   ${a.FILE.obj}`, `  Library . . . . . . . . :   ${lib}`, `Number of dependent files :   ${deps.length}`, '', 'Dependent File    Library     Dependency', ...deps.map((d) => `${d.NAME.padEnd(18)}${d.LIB.padEnd(12)}Data`)];
  if (!ctx.interactive) return { text: lines.join('\n') };
  const p = new Panel({ fn: 'CMD-DSPDBR', keys: ['F3', 'F12'] });
  p.title('Display Data Base Relations');
  p.sysName();
  lines.forEach((l, i) => p.text(3 + i, 2, l, i < 3 ? 'g' : 'w'));
  p.fkeys('F3=Exit   F12=Cancel');
  await ctx.display(p);
  return null;
});

// ---------- Ejecución de programas y trabajos ----------
def('CALL', 'Call Program', [LIBQ('PGM', 'Program'), P('PARM', 'Parameters', 'list', 60, { lc: true })], async (ctx, a, info) => {
  const { splitList, unquote } = await import('../../../../shared/cl.js');
  const rawParms = info.given.PARM ?? '';
  const refs = splitList(rawParms).map((p) => {
    const v = /^'.*'$/s.test(p) ? unquote(p).padEnd(32) : /^[-+]?\d*\.?\d+$/.test(p) ? Number(p) : p.toUpperCase().padEnd(32);
    return { get: () => v, set: () => {} };
  });
  if (ctx.session && ctx.job.function && !ctx.job.function.startsWith('PGM-')) clearProgramMessages(ctx.session);
  const msgs = await callProgram(ctx, a.PGM.obj, a.PGM.lib, refs);
  return (msgs || []).filter((m) => m.text);
});
def('SBMJOB', 'Submit Job', [
  P('CMD', 'Command to run', 'cmd', 256, { req: true, promptLen: 120 }),
  P('JOB', 'Job name', 'name', 10, { dft: '*JOBD' }),
  P('JOBQ', 'Job queue', 'name', 10, { dft: '*JOBD' }),
], async (ctx, a) => submitJob(ctx, a.CMD, a.JOB === '*JOBD' ? (a.CMD.match(/PGM\(([^)]+)\)/i)?.[1].split('/').pop() || ctx.job.user) : a.JOB));
def('DLYJOB', 'Delay Job', [P('DLY', 'Job delay time', 'int', 6, { req: true, choices: 'Seconds' })], async (ctx, a) => {
  const prev = ctx.job.status;
  ctx.job.status = 'DLYW';
  const until = Date.now() + Number(a.DLY) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
    if (ctx.job.cancel) { ctx.job.cancel = false; const { RpgCancel } = await import('../../../../shared/rpg/interpreter.js'); throw new RpgCancel(); }
  }
  ctx.job.status = prev;
  return null;
});
def('ENDJOB', 'End Job', [P('JOB', 'Job name (number/user/name)', 'char', 28, { req: true, lc: false }), P('OPTION', 'How to end', 'char', 10, { dft: '*CNTRLD' })], async (ctx, a) => {
  const { allJobs, endJob } = await import('../system.js');
  const nbr = a.JOB.split('/')[0];
  const j = allJobs().find((x) => x.number === nbr || x.name === a.JOB);
  if (!j) throw new CLError('CPF1321', a.JOB, '', '');
  if (j.system) throw new CLError('CPF1362', j.number, j.user, j.name);
  j.cancel = true;
  if (j.session) { j.session.forceSignoff = true; if (j.session.pending) { const p = j.session.pending; j.session.pending = null; p.reject(new SignOff()); } } else endJob(j, 30);
  return msg('CPC1224', j.number, j.user, j.name);
});

// ---------- SQL y datos ----------
def('STRSQL', 'Start SQL Interactive Session', [], async (ctx) => strsql(ctx), I);
def('RUNSQL', 'Run SQL Statement', [P('SQL', 'SQL statement', 'sql', 512, { req: true, promptLen: 120 }), P('COMMIT', 'Commitment control', 'char', 5, { dft: '*NONE' })], async (ctx, a) => {
  const r = await ctx.sql(a.SQL);
  if (r.error) throw Object.assign(new CLError('CPF9898', `SQL${Math.abs(r.sqlcode || 0)}: ${r.error}`), { msgId: 'SQL9010' });
  return { id: 'SQL7954', text: r.columns.length ? `${r.rows.length} rows selected.` : `${r.rowCount} rows affected.`, sev: 0 };
});
def('DSPPFM', 'Display Physical File Member', [LIBQ('FILE', 'File'), P('MBR', 'Member', 'name', 10, { dft: '*FIRST' })], async (ctx, a) => { await dsppfm(ctx, a.FILE); }, I);
def('DSPFFD', 'Display File Field Description', [LIBQ('FILE', 'File')], async (ctx, a) => { await dspffd(ctx, a.FILE); }, I);
def('CLRPFM', 'Clear Physical File Member', [LIBQ('FILE', 'Physical file')], async (ctx, a) => {
  const d = await obj.describeFile(gw, `${a.FILE.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.FILE.lib)}/${a.FILE.obj}`, ctx.libl).catch(() => { throw new CLError('CPF9812', a.FILE.obj, a.FILE.lib); });
  await gw.exec(`DELETE FROM ${d.schema}.${d.table}`);
  return msg('CPC3103', d.table, d.table, d.lib);
});
def('CPYF', 'Copy File', [
  LIBQ('FROMFILE', 'From file'), LIBQ('TOFILE', 'To file'),
  P('MBROPT', 'Replace or add records', 'char', 8, { dft: '*NONE', choices: '*NONE, *ADD, *REPLACE' }),
  P('CRTFILE', 'Create file', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }),
], async (ctx, a) => {
  const from = await obj.describeFile(gw, `${a.FROMFILE.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.FROMFILE.lib)}/${a.FROMFILE.obj}`, ctx.libl).catch(() => { throw new CLError('CPF9812', a.FROMFILE.obj, a.FROMFILE.lib); });
  const toLib = a.TOFILE.lib === '*LIBL' ? ctx.curlib : ctx.resolveLib(a.TOFILE.lib);
  let to;
  try { to = await obj.describeFile(gw, `${toLib}/${a.TOFILE.obj}`, ctx.libl); } catch {
    if (a.CRTFILE !== '*YES') throw new CLError('CPF2817');
    await gw.exec(`CREATE TABLE ${toLib}.${a.TOFILE.obj} AS (SELECT * FROM ${from.schema}.${from.table}) WITH NO DATA`).catch(async () => {
      await gw.exec(`CREATE TABLE ${toLib}.${a.TOFILE.obj} AS SELECT * FROM ${from.schema}.${from.table} WHERE 1=0`);
    });
    await obj.putObject(toLib, a.TOFILE.obj, '*FILE', 'PF', `Copy of ${from.table}`, { kind: 'PF', format: a.TOFILE.obj, keys: [] }, ctx.job.user);
    invalidateTables(toLib);
    to = { schema: toLib, table: a.TOFILE.obj };
  }
  if (a.MBROPT === '*REPLACE') await gw.exec(`DELETE FROM ${to.schema}.${to.table}`);
  const r = await gw.exec(`INSERT INTO ${to.schema}.${to.table} SELECT * FROM ${from.schema}.${from.table}`);
  return msg('CPC2955', r.rowCount, from.table);
});

// ---------- Áreas de datos ----------
def('CRTDTAARA', 'Create Data Area', [
  LIBQ('DTAARA', 'Data area', { lib: '*CURLIB' }), P('TYPE', 'Type', 'char', 5, { req: true, choices: '*DEC, *CHAR, *LGL' }),
  P('LEN', 'Length', 'int', 5, { dft: '32' }), P('VALUE', 'Initial value', 'text', 60, { dft: '' }), TEXT,
], async (ctx, a) => {
  const lib = await requireLib(ctx, a.DTAARA.lib);
  if (await obj.findObject(gw, a.DTAARA.obj, '*DTAARA', lib, [])) throw new CLError('CPF2112', a.DTAARA.obj, lib, '*DTAARA');
  await obj.putObject(lib, a.DTAARA.obj, '*DTAARA', a.TYPE, textVal(a.TEXT), { type: a.TYPE, len: a.LEN, value: a.VALUE || '' }, ctx.job.user);
  return msg('CPC1001', a.DTAARA.obj, lib);
});
def('DSPDTAARA', 'Display Data Area', [LIBQ('DTAARA', 'Data area')], async (ctx, a) => {
  const o = await obj.findObject(gw, a.DTAARA.obj, '*DTAARA', a.DTAARA.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.DTAARA.lib), ctx.libl);
  if (!o) throw new CLError('CPF9801', a.DTAARA.obj, a.DTAARA.lib);
  const d = await obj.objectData(gw, o.LIB, o.NAME, '*DTAARA');
  if (!ctx.interactive) return { text: `${o.NAME}: ${d.value}` };
  const p = new Panel({ fn: 'CMD-DSPDTAARA', keys: ['F3', 'F12'] });
  p.title('Display Data Area');
  p.sysName();
  p.info(3, 2, 'Data area', o.NAME, 24); p.info(4, 4, 'Library', o.LIB, 22);
  p.info(5, 2, 'Type', d.type, 24); p.info(6, 2, 'Length', String(d.len), 24); p.info(7, 2, 'Text', o.TEXT, 24);
  p.text(9, 2, 'Value', 'w');
  p.text(10, 2, 'Offset      *...+....1....+....2....+....3....+....4....+....5', 'w');
  p.text(11, 2, `    0       '${String(d.value).padEnd(Math.min(d.len, 50)).slice(0, 50)}'`, 'g');
  p.text(21, 2, 'Press Enter to continue.', 'b');
  p.fkeys('F3=Exit   F12=Cancel');
  await ctx.display(p);
  return null;
});
def('CHGDTAARA', 'Change Data Area', [LIBQ('DTAARA', 'Data area'), P('VALUE', 'New value', 'text', 60, { req: true })], async (ctx, a) => {
  const o = await obj.findObject(gw, a.DTAARA.obj, '*DTAARA', a.DTAARA.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.DTAARA.lib), ctx.libl);
  if (!o) throw new CLError('CPF9801', a.DTAARA.obj, a.DTAARA.lib);
  const d = (await obj.objectData(gw, o.LIB, o.NAME, '*DTAARA')) || {};
  d.value = a.VALUE;
  await obj.putObject(o.LIB, o.NAME, '*DTAARA', d.type || '*CHAR', o.TEXT, d, o.OWNER);
  return { text: `Data area ${o.NAME} in ${o.LIB} changed.` };
});

// ---------- Perfiles y valores del sistema ----------
const isSecofr = (ctx) => ['*SECOFR', '*SECADM'].includes(ctx.user?.USRCLS);
def('CRTUSRPRF', 'Create User Profile', [
  P('USRPRF', 'User profile', 'name', 10, { req: true }),
  P('PASSWORD', 'User password', 'char', 10, { dft: '*USRPRF', choices: 'Name, *USRPRF, *NONE' }),
  P('USRCLS', 'User class', 'char', 7, { dft: '*USER', choices: '*USER, *PGMR, *SECOFR' }),
  P('CURLIB', 'Current library', 'name', 10, { dft: '*CRTDFT' }),
  P('INLMNU', 'Initial menu', 'name', 10, { dft: 'MAIN' }),
  P('INLPGM', 'Initial program to call', 'name', 10, { dft: '*NONE' }),
  TEXT,
], async (ctx, a) => {
  if (!isSecofr(ctx)) throw new CLError('CPF9898', 'Not authorized to command CRTUSRPRF. User class *SECOFR required.');
  await obj.createUser({ name: a.USRPRF, password: a.PASSWORD === '*USRPRF' ? a.USRPRF : a.PASSWORD, usrcls: a.USRCLS, text: textVal(a.TEXT), curlib: a.CURLIB, inlmnu: a.INLMNU, inlpgm: a.INLPGM });
  return msg('CPC2205', a.USRPRF);
});
def('CHGUSRPRF', 'Change User Profile', [
  P('USRPRF', 'User profile', 'name', 10, { req: true }),
  P('PASSWORD', 'User password', 'char', 10, { dft: '*SAME' }),
  P('STATUS', 'Status', 'char', 9, { dft: '*SAME', choices: '*SAME, *ENABLED, *DISABLED' }),
  P('CURLIB', 'Current library', 'name', 10, { dft: '*SAME' }),
  P('INLMNU', 'Initial menu', 'name', 10, { dft: '*SAME' }),
  P('INLPGM', 'Initial program to call', 'name', 10, { dft: '*SAME' }),
  P('TEXT', "Text 'description'", 'text', 50, { dft: '*SAME' }),
], async (ctx, a) => {
  if (!isSecofr(ctx) && a.USRPRF !== ctx.job.user) throw new CLError('CPF9898', 'Not authorized to change user profile.');
  if (!(await obj.getUser(a.USRPRF))) throw new CLError('CPF2204', a.USRPRF);
  const f = {};
  if (a.PASSWORD !== '*SAME') { f.PWDHASH = obj.hashPassword(a.USRPRF, a.PASSWORD); f.PWDTOKEN = obj.passwordTokens(a.USRPRF, a.PASSWORD); }
  if (a.STATUS !== '*SAME') { f.STATUS = a.STATUS; if (a.STATUS === '*ENABLED') f.INVALID = 0; }
  for (const k of ['CURLIB', 'INLMNU', 'INLPGM', 'TEXT']) if (a[k] !== '*SAME') f[k] = a[k];
  await obj.updateUser(a.USRPRF, f);
  return { id: 'CPC2204', text: `User profile ${a.USRPRF} changed.` };
});
def('CHGPRF', 'Change Profile', [P('CURLIB', 'Current library', 'name', 10, { dft: '*SAME' }), P('INLMNU', 'Initial menu', 'name', 10, { dft: '*SAME' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*SAME' })], async (ctx, a) => {
  const f = {};
  for (const k of ['CURLIB', 'INLMNU', 'TEXT']) if (a[k] !== '*SAME') f[k] = a[k];
  await obj.updateUser(ctx.job.user, f);
  return { text: `User profile ${ctx.job.user} changed.` };
});
def('CHGPWD', 'Change Password', [], async (ctx) => {
  const p = new Panel({ fn: 'CMD-CHGPWD', keys: ['F3', 'F12'] });
  p.title('Change Password');
  p.info(3, 2, 'Password last changed', '', 34);
  p.text(5, 2, 'Type choices, press Enter.', 'b');
  p.label(7, 2, 'Current password', 36); p.input('CUR', 7, 40, 10, { nd: true, attr: 'gn' });
  p.label(9, 2, 'New password', 36); p.input('NEW', 9, 40, 10, { nd: true, attr: 'gn' });
  p.label(11, 2, 'New password (to verify)', 36); p.input('VER', 11, 40, 10, { nd: true, attr: 'gn' });
  p.fkeys('F3=Exit   F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return null;
  const u = await obj.getUser(ctx.job.user);
  if (u.PWDHASH !== obj.hashPassword(ctx.job.user, r.fields.CUR.trim())) throw new CLError('CPF2362', 'Password not correct.');
  if (!r.fields.NEW.trim() || r.fields.NEW.trim() !== r.fields.VER.trim()) throw new CLError('CPF2363', 'New password and verify password do not match.');
  await obj.updateUser(ctx.job.user, { PWDHASH: obj.hashPassword(ctx.job.user, r.fields.NEW.trim()), PWDTOKEN: obj.passwordTokens(ctx.job.user, r.fields.NEW.trim()) });
  return msg('CPC2604');
}, I);
def('DLTUSRPRF', 'Delete User Profile', [P('USRPRF', 'User profile', 'name', 10, { req: true })], async (ctx, a) => {
  if (!isSecofr(ctx)) throw new CLError('CPF9898', 'Not authorized to command DLTUSRPRF.');
  if (['QSECOFR', 'QSYS', ctx.job.user].includes(a.USRPRF)) throw new CLError('CPF9898', `User profile ${a.USRPRF} cannot be deleted.`);
  if (!(await obj.getUser(a.USRPRF))) throw new CLError('CPF2204', a.USRPRF);
  await obj.deleteUser(a.USRPRF);
  return msg('CPC2191U', a.USRPRF, 'QSYS');
});
def('WRKUSRPRF', 'Work with User Profiles', [P('USRPRF', 'User profile', 'name', 10, { dft: '*ALL' })], async (ctx) => { await wrkusrprf(ctx); }, I);
def('DSPUSRPRF', 'Display User Profile', [P('USRPRF', 'User profile', 'name', 10, { req: true })], async (ctx, a) => {
  const u = await obj.getUser(a.USRPRF);
  if (!u) throw new CLError('CPF2204', a.USRPRF);
  return { text: `${u.NAME}: class ${u.USRCLS}, status ${u.STATUS}, curlib ${u.CURLIB}, menu ${u.INLMNU}, last sign-on ${u.LASTSIGN || 'never'}.` };
});
def('WRKSYSVAL', 'Work with System Values', [P('SYSVAL', 'System value', 'name', 10, { dft: '*ALL' })], async (ctx) => { await wrksysval(ctx); }, I);
def('DSPSYSVAL', 'Display System Value', [P('SYSVAL', 'System value', 'name', 10, { req: true })], async (ctx, a) => {
  const d = new Date();
  const dyn = { QDATE: d.toLocaleDateString('en-US'), QTIME: d.toLocaleTimeString('en-US', { hour12: false }) };
  const v = dyn[a.SYSVAL] ?? (await obj.sysval(a.SYSVAL));
  if (v === null || v === undefined) throw new CLError('CPF1028', `System value ${a.SYSVAL} not valid.`);
  return { text: `${a.SYSVAL}: ${v}` };
});
def('CHGSYSVAL', 'Change System Value', [P('SYSVAL', 'System value', 'name', 10, { req: true }), P('VALUE', 'New value', 'text', 60, { req: true })], async (ctx, a) => {
  if (!isSecofr(ctx)) throw new CLError('CPF9898', 'Not authorized to change system values.');
  await obj.setSysval(a.SYSVAL, a.VALUE.toUpperCase());
  return { text: `System value ${a.SYSVAL} changed.` };
});

// ---------- Mensajes de programa (también como mandato interactivo) ----------
def('PWRDWNSYS', 'Power Down System', [P('OPTION', 'How to end', 'char', 10, { dft: '*CNTRLD' })], async () => { throw new CLError('CPF1096'); });
def('RTVJOBA', 'Retrieve Job Attributes', [], async () => { throw new CLError('CPD0031', 'RTVJOBA'); });

export function loadCommands() { return true; }
export { refreshMW, commandEntry, msgText };
