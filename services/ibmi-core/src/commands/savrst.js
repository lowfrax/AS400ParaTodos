// CRTSAVF, CLRSAVF, DSPSAVF, SAVOBJ, SAVLIB, SAVCHGOBJ, SAVSECDTA, SAVSYS, SAV / RSTOBJ, RSTLIB, RSTUSRPRF, RSTAUT,
// RSTCFG, RST. DEV(*SAVF) usa un archivo de salvar; DEV(TAPVRT01…) un dispositivo de cinta virtual (tape.js).
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { Panel, padR, padL } from '../panel.js';
import * as S from '../savrst.js';
import * as T from '../tape.js';
import { sysDate, sysTime, SYS } from '../system.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const up = (s) => String(s ?? '').trim().toUpperCase();
const list = (v) => [].concat(v ?? []).flatMap((x) => String(x).toUpperCase().split(/\s+/)).filter(Boolean);
const DEV = P('DEV', 'Device', 'list', 40, { req: true, choices: 'Name, *SAVF' });
const SAVF = P('SAVF', 'Save file', 'qual', 10, { dft: '*NONE' });
const VOL = P('VOL', 'Volume identifier', 'list', 60, { dft: '*MOUNTED' });
const ENDOPT = P('ENDOPT', 'End of media option', 'name', 7, { dft: '*REWIND', choices: '*REWIND, *LEAVE, *UNLOAD' });
const SAVSEQ = P('SEQNBR', 'Sequence number', 'char', 6, { dft: '*END', choices: '1-16777215, *END' });
const RSTSEQ = P('SEQNBR', 'Sequence number', 'char', 6, { dft: '*SEARCH', choices: '1-16777215, *SEARCH' });
const LABEL = P('LABEL', 'Label', 'char', 17, { dft: '*LIB' });
const EXPDATE = P('EXPDATE', 'File expiration date', 'char', 8, { dft: '*PERM' });

async function savfOf(ctx, a) {
  const dev = list(a.DEV)[0];
  if (dev !== '*SAVF') throw new CLError('CPF9814', dev);
  if (!a.SAVF || !a.SAVF.obj || a.SAVF.obj === '*NONE') throw new CLError('CPD0072', 'SAVF');
  const o = await obj.findObject(gw, up(a.SAVF.obj), '*FILE', !a.SAVF.lib || a.SAVF.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.SAVF.lib), ctx.libl);
  if (!o || o.ATTR !== 'SAVF') throw new CLError('CPF9812', up(a.SAVF.obj), a.SAVF.lib || '*LIBL');
  return o;
}
/** { kind: 'savf', o } o { kind: 'tape', dev } según DEV. */
async function targetOf(ctx, a) {
  const dev = list(a.DEV)[0];
  if (dev === '*SAVF') return { kind: 'savf', o: await savfOf(ctx, a) };
  const d = await T.deviceRow(dev);
  if (!d || d.data.devclass !== '*TAP') throw new CLError('CPF9814', dev);
  if (list(a.DEV).length > 1) throw new CLError('CPF9898', 'Only one tape device can be specified on this system.');
  return { kind: 'tape', dev: d.NAME };
}
const tapeOpts = (a) => ({ vol: list(a.VOL)[0] || '*MOUNTED', endopt: a.ENDOPT || '*REWIND' });
const sec = () => import('../security.js');
// SAVxxx / RSTxxx exigen *SAVSYS o *OBJEXIST sobre cada objeto; se comprueba al menos el *SAVSYS o la propiedad de la biblioteca
async function mayOperate(ctx, lib) {
  const s = await sec();
  if (s.hasSpecial(ctx.user, '*SAVSYS') || s.hasSpecial(ctx.user, '*ALLOBJ')) return;
  const lo = await s.objectRow('QSYS', lib, '*LIB');
  if (lo && lo.OWNER === ctx.job.user) return;
  throw new CLError('CPF3774', lib);
}
async function needSavsys(ctx, what) {
  const s = await sec();
  if (!s.hasSpecial(ctx.user, '*SAVSYS')) throw new CLError('CPF9898', `Special authority *SAVSYS required for ${what}.`);
}

// ---------- Selección de bibliotecas: nombres, genéricos*, *NONSYS, *ALLUSR, *IBM ----------
// Las bibliotecas del sistema operativo (QSYS, QSYS2, QHLPSYS, QTEMP) no se salvan con SAVLIB (van en SAVSYS)
const OS_LIBS = ['QSYS', 'QSYS2', 'QHLPSYS', 'QTEMP', 'QRECOVERY', 'QSPL', 'QRPLOBJ'];
const USER_Q = ['QGPL', 'QUSRSYS'];
const categoryOf = (n) => (OS_LIBS.includes(n) ? 'SYS' : !n.startsWith('Q') || USER_Q.includes(n) || n.startsWith('QUSR') ? 'USR' : 'IBM');
async function allLibraries() {
  return (await gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND TYPE = '*LIB' ORDER BY NAME`)).map((r) => r.NAME);
}
async function expandLibs(ctx, names, omit = []) {
  const all = await allLibraries();
  const out = [];
  for (const n of names.map(up)) {
    let sel;
    if (n === '*NONSYS') sel = all.filter((l) => categoryOf(l) !== 'SYS');
    else if (n === '*ALLUSR') sel = all.filter((l) => categoryOf(l) === 'USR');
    else if (n === '*IBM') sel = all.filter((l) => categoryOf(l) === 'IBM');
    else if (n.endsWith('*')) sel = all.filter((l) => l.startsWith(n.slice(0, -1)) && categoryOf(l) !== 'SYS');
    else sel = [ctx.resolveLib(n)];
    for (const l of sel) if (!out.includes(l)) out.push(l);
  }
  const om = omit.map(up).filter((x) => x !== '*NONE');
  return out.filter((l) => !om.some((o) => l === o || (o.endsWith('*') && l.startsWith(o.slice(0, -1)))));
}
const special = (names) => names.some((n) => ['*NONSYS', '*ALLUSR', '*IBM'].includes(up(n)) || up(n).endsWith('*'));

def('CRTSAVF', 'Create Save File', [P('FILE', 'Save file', 'qual', 10, { req: true, lib: '*CURLIB' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' })], async (ctx, a) => {
  const lib = ctx.resolveLib(a.FILE.lib === '*LIBL' ? '*CURLIB' : a.FILE.lib);
  if (!(await obj.libExists(lib))) throw new CLError('CPF2110', lib);
  await S.createSavf(lib, up(a.FILE.obj), a.TEXT === '*BLANK' ? '' : a.TEXT, ctx.job.user);
  return [{ id: 'CPC9801', text: `Object ${up(a.FILE.obj)} type *FILE created in library ${lib}.`, sev: 0 }];
});
def('CLRSAVF', 'Clear Save File', [P('FILE', 'Save file', 'qual', 10, { req: true })], async (ctx, a) => {
  const o = await savfOf(ctx, { DEV: '*SAVF', SAVF: a.FILE });
  await (await sec()).checkAuthority(ctx, o, ['*OBJOPR', '*DLT']);
  await S.clearSavf(o.LIB, o.NAME);
  return [{ id: 'CPC3701', text: `Save file ${o.NAME} in ${o.LIB} cleared.`, sev: 0 }];
});

async function savfLines(o) {
  const d = await S.savfInfo(o.LIB, o.NAME);
  const h = d.header || {};
  const lines = [
    `Save file  . . . . . . . . :   ${o.NAME}`, `  Library  . . . . . . . . :     ${o.LIB}`,
    `Objects displayed  . . . . :   ${(d.entries || []).length}`, `Library saved  . . . . . . :   ${h.lib || ''}`,
    `Save command . . . . . . . :   ${h.cmd || ''}`, `Save date/time . . . . . . :   ${h.savedAt ? `${sysDate(new Date(h.savedAt))} ${sysTime(new Date(h.savedAt))}` : ''}`,
    `Target release . . . . . . :   ${h.release || ''}`, `Saved by . . . . . . . . . :   ${h.savedBy || ''}`, `System serial number . . . :   ${h.system || ''}`, '',
    'Object      Type      Attribute   Owner       Size (K)   Data   Text',
    ...(d.entries || []).map((e) => (e.type === '*DIR' || e.type === '*STMF' ? `${padR(e.type, 7)}${padR(e.owner, 11)}${padL(Math.max(1, Math.ceil((e.size || 0) / 1024)), 8)}  ${e.name}` : `${padR(e.name, 12)}${padR(e.type, 10)}${padR(e.attr, 12)}${padR(e.owner, 12)}${padL(Math.max(1, Math.ceil((e.size || 0) / 1024)), 8)}   ${e.rows !== undefined ? 'YES ' : 'NO  '}  ${String(e.text || '').slice(0, 20)}`)),
  ];
  if (h.cmd === 'SAV') lines[10] = 'Type   Owner      Size (K)  Object';
  return { d, lines };
}
def('DSPSAVF', 'Display Save File', [P('FILE', 'Save file', 'qual', 10, { req: true }), P('OUTPUT', 'Output', 'char', 6, { dft: '*', choices: '*, *PRINT' })], async (ctx, a) => {
  const o = await savfOf(ctx, { DEV: '*SAVF', SAVF: a.FILE });
  const { lines } = await savfLines(o);
  if (!ctx.interactive || a.OUTPUT === '*PRINT') { if (a.OUTPUT === '*PRINT') await obj.createSpool(ctx.job, 'QPSRODSP', lines, { usrdta: 'DSPSAVF' }); return { text: lines.join('\n') }; }
  let top = 0;
  for (;;) {
    const p = new Panel({ fn: 'CMD-DSPSAVF', keys: ['F3', 'F12', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Display Saved Objects - Save File');
    lines.slice(0, 9).forEach((l, i) => p.text(3 + i, 2, l));
    p.text(13, 2, lines[10], 'w');
    lines.slice(11 + top, 11 + top + 7).forEach((l, i) => p.text(14 + i, 2, l));
    p.more(21, 11 + top + 7 < lines.length);
    p.fkeys('F3=Exit   F12=Cancel');
    const r = await ctx.display(p);
    if (r.aid === 'PAGEDOWN') { if (11 + top + 7 < lines.length) top += 7; continue; }
    if (r.aid === 'PAGEUP') { top = Math.max(0, top - 7); continue; }
    return null;
  }
});

// ---------- Salvar ----------
const SAVE_PARMS = [DEV, VOL, SAVSEQ, LABEL, EXPDATE, ENDOPT, SAVF, P('UPDHST', 'Update history', 'char', 4, { dft: '*YES' }), P('TGTRLS', 'Target release', 'name', 8, { dft: '*CURRENT' }), P('CLEAR', 'Clear', 'name', 8, { dft: '*NONE', choices: '*NONE, *ALL, *AFTER, *REPLACE' }), P('PVTAUT', 'Private authorities', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }), P('DTACPR', 'Data compression', 'name', 7, { dft: '*DEV' })];

/** Salva cada biblioteca en un archivo de cinta (etiqueta = nombre de la biblioteca) y devuelve los mensajes. */
async function saveLibsToTape(ctx, a, libs, sel, { cmd, libDesc, id, skipEmpty = false }) {
  const t = tapeOpts(a);
  const out = [];
  let first = true;
  for (const [i, lib] of libs.entries()) {
    await mayOperate(ctx, lib);
    let b;
    try { b = await S.buildLibSave(ctx.job, lib, sel, { pvtaut: a.PVTAUT === '*YES', cmd, libDesc }); } catch (e) {
      if (e.msgId === 'CPF3770' && (skipEmpty || libs.length > 1)) { out.push({ id: 'CPF3770', text: `No objects saved or restored for library ${lib}.`, sev: 10 }); continue; }
      throw e;
    }
    const last = i === libs.length - 1;
    const label = up(a.LABEL || '*LIB') === '*LIB' || libs.length > 1 ? lib : up(a.LABEL);
    const w = await T.writeFile(ctx.dev, { label, content: b.content, seqnbr: first ? a.SEQNBR || '*END' : '*END', endopt: last ? t.endopt : '*LEAVE', vol: first ? t.vol : '*MOUNTED', expdate: a.EXPDATE });
    first = false;
    await S.markSaved(b, `${ctx.dev}/${w.volume}/${w.seq}`);
    out.push({ id, text: `${b.objs.length} objects saved from library ${lib}.`, sev: 0, seq: w.seq, volume: w.volume });
  }
  if (!out.some((m) => m.sev === 0) && !skipEmpty) throw new CLError('CPF3770', libs.join(' '));
  if (libs.length > 1) out.push({ id: '', text: `${out.filter((m) => m.sev === 0).length} libraries saved.`, sev: 0 });
  return out;
}

def('SAVOBJ', 'Save Object', [P('OBJ', 'Objects', 'list', 120, { req: true, choices: 'Name, generic*, *ALL' }), P('LIB', 'Library', 'list', 60, { req: true }), ...SAVE_PARMS, P('OBJTYPE', 'Object types', 'list', 60, { dft: '*ALL' })], async (ctx, a) => {
  const tg = await targetOf(ctx, a);
  const libs = list(a.LIB).map((l) => ctx.resolveLib(l));
  const sel = { names: list(a.OBJ), types: list(a.OBJTYPE) };
  if (tg.kind === 'tape') return saveLibsToTape(Object.assign(Object.create(ctx), { dev: tg.dev }), a, libs, sel, { cmd: 'SAVOBJ', libDesc: false, id: 'CPC3701' });
  if (libs.length > 1) throw new CLError('CPF3782', 'Only one library can be saved to a save file.');
  await mayOperate(ctx, libs[0]);
  const r = await S.saveToSavf(ctx.job, libs[0], sel, tg.o.LIB, tg.o.NAME, { clear: a.CLEAR, pvtaut: a.PVTAUT === '*YES', cmd: 'SAVOBJ' });
  return [{ id: 'CPC3701', text: `${r.count} objects saved from library ${libs[0]}.`, sev: 0 }];
});
def('SAVLIB', 'Save Library', [P('LIB', 'Library', 'list', 60, { req: true, choices: 'Name, generic*, *NONSYS, *ALLUSR, *IBM' }), ...SAVE_PARMS, P('OMITLIB', 'Libraries to omit', 'list', 100, { dft: '*NONE' })], async (ctx, a) => {
  const tg = await targetOf(ctx, a);
  const names = list(a.LIB);
  if (tg.kind === 'tape') {
    if (names.includes('*NONSYS') || names.includes('*IBM')) await needSavsys(ctx, `SAVLIB LIB(${names.join(' ')})`);
    const libs = await expandLibs(ctx, names, list(a.OMITLIB));
    if (!libs.length) throw new CLError('CPF3770', names.join(' '));
    return saveLibsToTape(Object.assign(Object.create(ctx), { dev: tg.dev }), a, libs, { names: ['*ALL'], types: ['*ALL'] }, { cmd: 'SAVLIB', libDesc: true, id: 'CPC3722', skipEmpty: special(names) });
  }
  // Como en IBM i: a un archivo de salvar solo va una biblioteca
  if (names.length > 1 || special(names)) throw new CLError('CPF3782', 'Only one library can be saved to a save file; use a tape device for *NONSYS, *ALLUSR, *IBM or several libraries.');
  const lib = ctx.resolveLib(names[0]);
  await mayOperate(ctx, lib);
  const r = await S.saveToSavf(ctx.job, lib, { names: ['*ALL'], types: ['*ALL'] }, tg.o.LIB, tg.o.NAME, { clear: a.CLEAR, pvtaut: a.PVTAUT === '*YES', cmd: 'SAVLIB', libDesc: true });
  return [{ id: 'CPC3722', text: `${r.count} objects saved from library ${lib}.`, sev: 0 }];
});
async function changedSince(lib, a) {
  if (up(a.REFDATE) === '*SAVLIB') {
    const lo = (await gw.rows("SELECT DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'", [lib]))[0];
    const ld = lo && lo.DATA ? JSON.parse(lo.DATA) : {};
    if (!ld.lastSave) throw new CLError('CPF3782', `Library ${lib} has never been saved; REFDATE(*SAVLIB) not valid.`);
    return new Date(ld.lastSave);
  }
  const m = /^(\d{2})(\d{2})(\d{2,4})$/.exec(String(a.REFDATE).replace(/\D/g, ''));
  if (!m) throw new CLError('CPD0074', a.REFDATE, 'REFDATE');
  const t = String(a.REFTIME || '').replace(/\D/g, '').padEnd(6, '0');
  return new Date(`${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1]}-${m[2]}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`);
}
def('SAVCHGOBJ', 'Save Changed Objects', [P('OBJ', 'Objects', 'list', 120, { dft: '*ALL' }), P('LIB', 'Library', 'list', 60, { req: true }), ...SAVE_PARMS, P('OBJTYPE', 'Object types', 'list', 60, { dft: '*ALL' }), P('REFDATE', 'Reference date', 'char', 10, { dft: '*SAVLIB' }), P('REFTIME', 'Reference time', 'char', 8, { dft: '*NONE' })], async (ctx, a) => {
  const tg = await targetOf(ctx, a);
  const libs = tg.kind === 'tape' ? await expandLibs(ctx, list(a.LIB)) : [ctx.resolveLib(list(a.LIB)[0])];
  if (tg.kind === 'tape') {
    const out = [];
    const c2 = Object.assign(Object.create(ctx), { dev: tg.dev });
    for (const [i, lib] of libs.entries()) {
      const since = await changedSince(lib, a);
      const ms = await saveLibsToTape(c2, { ...a, SEQNBR: i === 0 ? a.SEQNBR : '*END', ENDOPT: i === libs.length - 1 ? a.ENDOPT : '*LEAVE' }, [lib], { names: list(a.OBJ), types: list(a.OBJTYPE), changedSince: since }, { cmd: 'SAVCHGOBJ', libDesc: false, id: 'CPC3704', skipEmpty: true });
      out.push(...ms);
    }
    return out.length ? out : [{ id: 'CPC3704', text: '0 objects saved.', sev: 0 }];
  }
  const lib = libs[0];
  await mayOperate(ctx, lib);
  const since = await changedSince(lib, a);
  const r = await S.saveToSavf(ctx.job, lib, { names: list(a.OBJ), types: list(a.OBJTYPE), changedSince: since }, tg.o.LIB, tg.o.NAME, { clear: a.CLEAR, pvtaut: a.PVTAUT === '*YES', cmd: 'SAVCHGOBJ' }).catch((e) => { if (e.msgId === 'CPF3770') return { count: 0 }; throw e; });
  return [{ id: 'CPC3704', text: `${r.count} objects saved from library ${lib}.`, sev: 0 }];
});
def('SAVSECDTA', 'Save Security Data', [DEV, VOL, SAVSEQ, EXPDATE, ENDOPT, SAVF, P('CLEAR', 'Clear', 'name', 8, { dft: '*NONE' })], async (ctx, a) => {
  const tg = await targetOf(ctx, a);
  await needSavsys(ctx, 'SAVSECDTA');
  if (tg.kind === 'tape') {
    const b = await S.buildSecurity(ctx.job);
    const w = await T.writeFile(tg.dev, { label: 'QFILEUPR', content: b.content, seqnbr: a.SEQNBR, ...tapeOpts(a), expdate: a.EXPDATE });
    return [{ id: 'CPC3701', text: `${b.users} user profiles saved; ${b.auts} private authorities saved (volume ${w.volume}, sequence ${w.seq}).`, sev: 0 }];
  }
  const r = await S.saveSecurity(ctx.job, tg.o.LIB, tg.o.NAME);
  return [{ id: 'CPC3701', text: `${r.users} user profiles saved; ${r.auts} private authorities saved.`, sev: 0 }];
});

// SAVSYS: QFILE (valores del sistema y objetos de QSYS que no son del catálogo), QFILEUPR (perfiles y autorizaciones)
// y QFILEIOC (configuración: dispositivos y catálogos de imágenes). Solo a cinta.
def('SAVSYS', 'Save System', [DEV, VOL, ENDOPT, EXPDATE, P('USEOPTBLK', 'Use optimum block', 'char', 4, { dft: '*YES' }), P('OMIT', 'Omit', 'list', 30, { dft: '*NONE', choices: '*NONE, *CFG, *SECDTA' })], async (ctx, a) => {
  const tg = await targetOf(ctx, a);
  if (tg.kind !== 'tape') throw new CLError('CPF9898', 'DEV(*SAVF) not valid for SAVSYS; specify a tape device.');
  await needSavsys(ctx, 'SAVSYS');
  const omit = list(a.OMIT);
  const t = tapeOpts(a);
  const hdr = (cmd) => ({ release: SYS.release || 'V7R5M0', system: SYS.name, savedAt: new Date().toISOString(), savedBy: ctx.job.user, cmd, lib: 'QSYS' });
  const sysvals = await gw.rows('SELECT NAME, SVALUE, TEXT FROM QSYS.SYSVAL ORDER BY NAME');
  const qsys = await gw.rows(`SELECT LIB, NAME, TYPE, ATTR, TEXT, OWNER, DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND TYPE IN ('*AUTL', '*MSGF', '*CMD', '*JOBD', '*OUTQ') ORDER BY TYPE, NAME`);
  const rowsOf = (rows) => rows.map((r) => ({ lib: r.LIB, name: r.NAME, type: r.TYPE, attr: r.ATTR, text: r.TEXT, owner: r.OWNER, data: r.DATA ? JSON.parse(r.DATA) : null }));
  const files = [{ label: 'QFILE', content: { format: 'AS400TDS-SAVF-1', header: hdr('SAVSYS'), library: null, sysvals, objects: rowsOf(qsys) }, text: `${sysvals.length} system values and ${qsys.length} objects saved from library QSYS` }];
  if (!omit.includes('*SECDTA')) {
    const b = await S.buildSecurity(ctx.job, 'SAVSYS');
    files.push({ label: 'QFILEUPR', content: b.content, text: `${b.users} user profiles saved; ${b.auts} private authorities saved` });
  }
  if (!omit.includes('*CFG')) {
    const cfg = await gw.rows(`SELECT LIB, NAME, TYPE, ATTR, TEXT, OWNER, DATA FROM QSYS.OBJECTS WHERE (LIB = 'QSYS' AND TYPE = '*DEVD') OR (LIB = ? AND TYPE = '*IMGCLG') ORDER BY TYPE, NAME`, [T.IMGCLG_LIB]);
    files.push({ label: 'QFILEIOC', content: { format: 'AS400TDS-SAVF-1', header: hdr('SAVCFG'), library: null, objects: rowsOf(cfg) }, text: `${cfg.length} configuration objects saved` });
  }
  const out = [];
  // SAVSYS empieza al principio del volumen; ENDOPT se aplica tras el último archivo
  for (const [i, f] of files.entries()) {
    const w = await T.writeFile(tg.dev, { label: f.label, content: f.content, seqnbr: i === 0 ? 1 : '*END', endopt: i === files.length - 1 ? t.endopt : '*LEAVE', vol: i === 0 ? t.vol : '*MOUNTED', expdate: a.EXPDATE });
    out.push({ id: 'CPC3701', text: `${f.text} (volume ${w.volume}, sequence ${w.seq}).`, sev: 0 });
  }
  out.push({ id: '', text: `System saved to device ${tg.dev}.`, sev: 0 });
  return out;
});
def('SAVCFG', 'Save Configuration', [DEV, VOL, SAVSEQ, EXPDATE, ENDOPT, SAVF], async (ctx, a) => {
  const tg = await targetOf(ctx, a);
  await needSavsys(ctx, 'SAVCFG');
  const cfg = await gw.rows(`SELECT LIB, NAME, TYPE, ATTR, TEXT, OWNER, DATA FROM QSYS.OBJECTS WHERE (LIB = 'QSYS' AND TYPE = '*DEVD') OR (LIB = ? AND TYPE = '*IMGCLG') ORDER BY TYPE, NAME`, [T.IMGCLG_LIB]);
  const content = { format: 'AS400TDS-SAVF-1', header: { release: SYS.release || 'V7R5M0', system: SYS.name, savedAt: new Date().toISOString(), savedBy: ctx.job.user, cmd: 'SAVCFG', lib: 'QSYS' }, library: null, objects: cfg.map((r) => ({ lib: r.LIB, name: r.NAME, type: r.TYPE, attr: r.ATTR, text: r.TEXT, owner: r.OWNER, data: r.DATA ? JSON.parse(r.DATA) : null })) };
  if (tg.kind === 'tape') await T.writeFile(tg.dev, { label: 'QFILEIOC', content, seqnbr: a.SEQNBR, ...tapeOpts(a) });
  else await S.writeSavfContent(tg.o.LIB, tg.o.NAME, content);
  return [{ id: 'CPC3701', text: `${cfg.length} configuration objects saved.`, sev: 0 }];
});

// ---------- SAV / RST (IFS) ----------
/** OBJ(('/ruta' *INCLUDE|*OMIT ['/nuevo'])…) o una sola ruta. */
function parseObjElems(raw) {
  const s = String(raw ?? '').trim();
  const tok = (x) => [...x.matchAll(/'((?:[^']|'')*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]));
  if (!s.startsWith('(')) return [{ path: tok(s)[0] || s, include: true }];
  const out = [];
  for (const m of s.matchAll(/\(([^()]*)\)/g)) {
    const [p, inc = '*INCLUDE', nn] = tok(m[1]);
    out.push({ path: p, include: up(inc) !== '*OMIT', newName: nn });
  }
  return out;
}
/** DEV('/QSYS.LIB/TAPVRT01.DEVD') o DEV('/QSYS.LIB/BIB.LIB/SAVF.FILE'). */
async function devPath(ctx, raw) {
  const p = String(raw || '').trim().replace(/^'|'$/g, '').toUpperCase();
  let m = /^\/QSYS\.LIB\/([A-Z0-9#@$_]+)\.DEVD$/.exec(p);
  if (m) {
    const d = await T.deviceRow(m[1]);
    if (!d) throw new CLError('CPF9814', m[1]);
    return { kind: 'tape', dev: d.NAME };
  }
  m = /^\/QSYS\.LIB\/(?:([A-Z0-9#@$_]+)\.LIB\/)?([A-Z0-9#@$_]+)\.FILE$/.exec(p);
  if (m) return { kind: 'savf', o: await savfOf(ctx, { DEV: '*SAVF', SAVF: { lib: m[1] || 'QSYS', obj: m[2] } }) };
  throw new CLError('CPF9898', `Device ${raw} not valid. Specify '/QSYS.LIB/device.DEVD' or '/QSYS.LIB/library.LIB/savefile.FILE'.`);
}
const DEVP = P('DEV', 'Device', 'text', 80, { req: true, lc: true, choices: "'/QSYS.LIB/TAPVRT01.DEVD', '/QSYS.LIB/lib.LIB/savf.FILE'" });

def('SAV', 'Save Object', [DEVP, P('OBJ', 'Objects', 'elem', 512, { dft: "'*'", lc: true, choices: "('/path' *INCLUDE|*OMIT)" }), P('SUBTREE', 'Directory subtree', 'char', 5, { dft: '*ALL', choices: '*ALL, *DIR, *NONE, *OBJ' }),
  P('VOL', 'Volume identifier', 'list', 60, { dft: '*MOUNTED' }), P('SEQNBR', 'Sequence number', 'char', 6, { dft: '*END' }), P('LABEL', 'Label', 'char', 17, { dft: '*GEN' }), ENDOPT, P('CLEAR', 'Clear', 'name', 8, { dft: '*NONE' }), P('UPDHST', 'Update history', 'char', 4, { dft: '*YES' })], async (ctx, a) => {
  const tg = await devPath(ctx, a.DEV);
  const objs = parseObjElems(a.OBJ === "'*'" || a.OBJ === '*' ? ctx.job.cwd || '/' : a.OBJ);
  const s = await sec();
  if (objs.some((o) => o.path === '/*' || o.path === '/') && !s.hasSpecial(ctx.user, '*SAVSYS')) await needSavsys(ctx, "SAV OBJ('/*')");
  const content = await S.buildIfsSave(ctx.job, objs, { subtree: a.SUBTREE });
  if (tg.kind === 'tape') {
    const w = await T.writeFile(tg.dev, { label: up(a.LABEL) === '*GEN' ? `SAV${String(Date.now()).slice(-8)}` : up(a.LABEL), content, seqnbr: a.SEQNBR, vol: list(a.VOL)[0] || '*MOUNTED', endopt: a.ENDOPT });
    return [{ id: 'CPC370C', text: `${content.ifs.filter((x) => !x.parent).length} objects saved (volume ${w.volume}, sequence ${w.seq}).`, sev: 0 }];
  }
  const info = await S.savfInfo(tg.o.LIB, tg.o.NAME);
  if (info.entries && info.entries.length && a.CLEAR === '*NONE') throw new CLError('CPF3782', `Save file ${tg.o.NAME} in ${tg.o.LIB} already contains data; specify CLEAR(*ALL).`);
  await S.writeSavfContent(tg.o.LIB, tg.o.NAME, content);
  return [{ id: 'CPC370C', text: `${content.ifs.filter((x) => !x.parent).length} objects saved.`, sev: 0 }];
});
def('RST', 'Restore Object', [DEVP, P('OBJ', 'Objects', 'elem', 512, { dft: "'*'", lc: true, choices: "('/path' *INCLUDE|*OMIT '/new-name')" }), P('SUBTREE', 'Directory subtree', 'char', 5, { dft: '*ALL' }),
  P('VOL', 'Volume identifier', 'list', 60, { dft: '*MOUNTED' }), P('SEQNBR', 'Sequence number', 'char', 6, { dft: '*SEARCH' }), P('LABEL', 'Label', 'char', 17, { dft: '*SEARCH' }), ENDOPT, P('OPTION', 'Option', 'name', 6, { dft: '*ALL', choices: '*ALL, *NEW, *OLD' }), P('ALWOBJDIF', 'Allow object differences', 'list', 30, { dft: '*NONE' })], async (ctx, a) => {
  const tg = await devPath(ctx, a.DEV);
  const s = await sec();
  if (!s.hasSpecial(ctx.user, '*SAVSYS') && !s.hasSpecial(ctx.user, '*ALLOBJ')) await needSavsys(ctx, 'RST');
  let c;
  if (tg.kind === 'tape') {
    let f;
    if (up(a.SEQNBR) === '*SEARCH' && up(a.LABEL) === '*SEARCH') {
      // El archivo SAV más reciente del volumen desde la posición actual
      const files = await T.allFiles(tg.dev, '*LEAVE');
      f = [...files].reverse().find((x) => x.content && x.content.ifs);
      if (!f) throw new CLError('CPF3780', '*SAV');
      await T.readFile(tg.dev, { label: f.label, seqnbr: f.seq, endopt: a.ENDOPT, vol: list(a.VOL)[0] || '*MOUNTED' });
    } else f = await T.readFile(tg.dev, { label: a.LABEL, seqnbr: a.SEQNBR, endopt: a.ENDOPT, vol: list(a.VOL)[0] || '*MOUNTED' });
    c = f.content;
  } else c = S.readSavfContent(tg.o.LIB, tg.o.NAME);
  const objs = a.OBJ === "'*'" || a.OBJ === '*' ? [] : parseObjElems(a.OBJ);
  const r = await S.restoreIfs(ctx.job, c, objs, { option: up(a.OPTION) });
  if (r.failed.length) throw new CLError('CPF3773', `${r.failed.length} objects`, 'the IFS', r.failed.map((f) => `${f.name}: ${f.error}`).join('; ').slice(0, 300));
  return [{ id: 'CPC370D', text: `${r.restored} objects restored.${r.skipped ? ` ${r.skipped} objects not restored (OPTION).` : ''}`, sev: 0 }];
});

// ---------- Restaurar ----------
const RST_PARMS = [DEV, VOL, RSTSEQ, P('LABEL', 'Label', 'char', 17, { dft: '*SAVLIB' }), ENDOPT, SAVF, P('MBROPT', 'Data base member option', 'name', 6, { dft: '*MATCH', choices: '*MATCH, *ALL, *NEW, *OLD' }), P('ALWOBJDIF', 'Allow object differences', 'list', 30, { dft: '*NONE' }), P('RSTLIB', 'Restore to library', 'name', 10, { dft: '*SAVLIB' })];
function rstMessage(r, cmd) {
  const msgs = [];
  for (const f of r.failed) msgs.push({ id: 'CPF3773', text: `Object ${f.name} type ${f.type} not restored: ${f.error}`, sev: 30 });
  if (r.failed.length) throw new CLError('CPF3773', `${r.failed.length} objects not restored to ${r.lib}`, r.lib, r.failed.map((f) => `${f.name} ${f.type}: ${f.error}`).join('; '));
  msgs.push({ id: cmd === 'RSTLIB' ? 'CPC3703' : 'CPC3703', text: `${r.restored} objects restored from ${r.savlib} to ${r.lib}.${r.skipped ? ` ${r.skipped} not restored (MBROPT).` : ''}`, sev: 0 });
  return msgs;
}
/** Archivo de cinta de una biblioteca: SEQNBR(n) o búsqueda por etiqueta (LABEL(*SAVLIB) = nombre de la biblioteca). */
async function tapeLibFile(dev, a, savlib) {
  const label = up(a.LABEL || '*SAVLIB') === '*SAVLIB' ? savlib : up(a.LABEL);
  const f = await T.readFile(dev, { label, seqnbr: a.SEQNBR || '*SEARCH', ...tapeOpts(a) });
  if (!f.content || !f.content.objects) throw new CLError('CPF3780', savlib);
  return f;
}
def('RSTOBJ', 'Restore Object', [P('OBJ', 'Objects', 'list', 120, { req: true, choices: 'Name, generic*, *ALL' }), P('SAVLIB', 'Saved library', 'name', 10, { req: true }), ...RST_PARMS, P('OBJTYPE', 'Object types', 'list', 60, { dft: '*ALL' })], async (ctx, a) => {
  const tg = await targetOf(ctx, a);
  const rl = a.RSTLIB === '*SAVLIB' ? up(a.SAVLIB) : ctx.resolveLib(a.RSTLIB);
  await mayOperate(ctx, rl);
  const sel = { names: list(a.OBJ), types: list(a.OBJTYPE), savlib: up(a.SAVLIB) };
  const r = tg.kind === 'tape'
    ? await S.restoreContent(ctx.job, (await tapeLibFile(tg.dev, a, up(a.SAVLIB))).content, sel, { rstlib: rl, mbropt: a.MBROPT })
    : await S.restoreFromSavf(ctx.job, tg.o.LIB, tg.o.NAME, sel, { rstlib: rl, mbropt: a.MBROPT });
  return rstMessage(r, 'RSTOBJ');
});
def('RSTLIB', 'Restore Library', [P('SAVLIB', 'Saved library', 'list', 60, { req: true, choices: 'Name, *NONSYS, *ALLUSR, *IBM' }), ...RST_PARMS, P('OMITLIB', 'Libraries to omit', 'list', 100, { dft: '*NONE' })], async (ctx, a) => {
  const tg = await targetOf(ctx, a);
  const names = list(a.SAVLIB);
  const s = await sec();
  const doOne = async (c, savlib, rl) => {
    if (await obj.libExists(rl)) await mayOperate(ctx, rl);
    else if (!s.hasSpecial(ctx.user, '*SAVSYS')) throw new CLError('CPF3774', rl);
    return S.restoreContent(ctx.job, c, { names: ['*ALL'], types: ['*ALL'], savlib }, { rstlib: rl, mbropt: a.MBROPT, createLib: true });
  };
  if (tg.kind === 'savf') {
    if (names.length > 1 || special(names)) throw new CLError('CPF3782', 'Only one library can be restored from a save file.');
    const rl = a.RSTLIB === '*SAVLIB' ? names[0] : up(a.RSTLIB);
    const c = S.readSavfContent(tg.o.LIB, tg.o.NAME);
    if (!c || !c.objects) throw new CLError('CPF3782', `File ${tg.o.NAME} in ${tg.o.LIB} does not contain save data.`);
    return rstMessage(await doOne(c, names[0], rl), 'RSTLIB');
  }
  if (!special(names)) {
    if (names.length > 1) throw new CLError('CPF9898', 'Specify one library, or *NONSYS, *ALLUSR or *IBM.');
    const rl = a.RSTLIB === '*SAVLIB' ? names[0] : up(a.RSTLIB);
    return rstMessage(await doOne((await tapeLibFile(tg.dev, a, names[0])).content, names[0], rl), 'RSTLIB');
  }
  // *NONSYS / *ALLUSR / *IBM / genérico: todas las bibliotecas salvadas con SAVLIB que haya en el volumen
  await needSavsys(ctx, `RSTLIB SAVLIB(${names.join(' ')})`);
  const om = list(a.OMITLIB).filter((x) => x !== '*NONE');
  const files = (await T.allFiles(tg.dev, a.ENDOPT)).filter((f) => f.cmd === 'SAVLIB' && f.content && f.content.header && f.content.header.lib);
  const msgs = [];
  let n = 0;
  for (const f of files) {
    const lib = f.content.header.lib;
    const cat = categoryOf(lib);
    const ok = names.some((x) => (x === '*NONSYS' && cat !== 'SYS') || (x === '*ALLUSR' && cat === 'USR') || (x === '*IBM' && cat === 'IBM') || (x.endsWith('*') && lib.startsWith(x.slice(0, -1))));
    if (!ok || om.some((o) => lib === o || (o.endsWith('*') && lib.startsWith(o.slice(0, -1))))) continue;
    const r = await doOne(f.content, lib, lib);
    msgs.push(...rstMessage(r, 'RSTLIB'));
    n++;
  }
  if (!n) throw new CLError('CPF3781', names.join(' '));
  msgs.push({ id: '', text: `${n} libraries restored.`, sev: 0 });
  return msgs;
});
def('RSTUSRPRF', 'Restore User Profiles', [DEV, VOL, RSTSEQ, ENDOPT, SAVF, P('USRPRF', 'User profile', 'list', 100, { dft: '*ALL' })], async (ctx, a) => {
  const tg = await targetOf(ctx, a);
  if (!(await sec()).hasSpecial(ctx.user, '*SECADM') || !(await sec()).hasSpecial(ctx.user, '*SAVSYS')) throw new CLError('CPF9898', 'Special authorities *SECADM and *SAVSYS required for RSTUSRPRF.');
  let n;
  if (tg.kind === 'tape') {
    const f = await T.readFile(tg.dev, { label: 'QFILEUPR', seqnbr: a.SEQNBR, ...tapeOpts(a) });
    n = await S.restoreProfilesContent(f.content, list(a.USRPRF));
  } else n = await S.restoreProfiles(ctx.job, tg.o.LIB, tg.o.NAME, list(a.USRPRF));
  return [{ id: 'CPC3705', text: `${n} user profiles restored.`, sev: 0 }];
});
def('RSTAUT', 'Restore Authority', [P('USRPRF', 'User profile', 'list', 100, { dft: '*ALL' }), P('SAVF', 'Save file (SAVSECDTA)', 'qual', 10, { dft: '*NONE' })], async (ctx, a) => {
  if (!(await sec()).hasSpecial(ctx.user, '*SECADM')) throw new CLError('CPF9898', 'Special authority *SECADM required for RSTAUT.');
  // Sin SAVF: las autorizaciones que guardó el último RSTUSRPRF (como en IBM i)
  let n;
  if (!a.SAVF || !a.SAVF.obj || a.SAVF.obj === '*NONE') n = await S.restoreAuthoritiesContent(S.authorityReference(), list(a.USRPRF));
  else { const so = await savfOf(ctx, { DEV: '*SAVF', SAVF: a.SAVF }); n = await S.restoreAuthorities(so.LIB, so.NAME, list(a.USRPRF)); }
  return [{ id: 'CPF3736', text: `${n} authorities restored.`, sev: 0 }];
});
def('RSTCFG', 'Restore Configuration', [P('OBJ', 'Objects', 'list', 100, { dft: '*ALL', choices: 'Name, generic*, *ALL' }), DEV, VOL, RSTSEQ, ENDOPT, SAVF, P('OBJTYPE', 'Object types', 'list', 40, { dft: '*ALL', choices: '*ALL, *DEVD, *IMGCLG' })], async (ctx, a) => {
  const tg = await targetOf(ctx, a);
  await needSavsys(ctx, 'RSTCFG');
  const c = tg.kind === 'tape' ? (await T.readFile(tg.dev, { label: 'QFILEIOC', seqnbr: a.SEQNBR, ...tapeOpts(a) })).content : S.readSavfContent(tg.o.LIB, tg.o.NAME);
  if (!c || !c.header || !['SAVCFG'].includes(c.header.cmd)) throw new CLError('CPF3782', 'The save media does not contain configuration data (SAVSYS or SAVCFG).');
  const names = list(a.OBJ);
  const types = list(a.OBJTYPE);
  let n = 0;
  const skipped = [];
  for (const o of c.objects) {
    if (!(names.includes('*ALL') || names.includes(o.name) || names.some((x) => x.endsWith('*') && o.name.startsWith(x.slice(0, -1))))) continue;
    if (!types.includes('*ALL') && !types.includes(o.type)) continue;
    // Un dispositivo activo no se sustituye (CPF379C en IBM i: objeto en uso)
    if (o.type === '*DEVD') { const cur = await T.deviceRow(o.name); if (cur && cur.data.status !== 'VARIED OFF') { skipped.push(o.name); continue; } }
    const data = o.type === '*DEVD' ? { ...o.data, status: 'VARIED OFF', imgclg: null, pos: 1 } : o.type === '*IMGCLG' ? { ...o.data, dev: null, status: '*NOTREADY' } : o.data;
    await obj.putObject(o.lib, o.name, o.type, o.attr, o.text, data, o.owner);
    n++;
  }
  return [...skipped.map((x) => ({ id: 'CPF379C', text: `Device description ${x} in use; not restored.`, sev: 10 })), { id: '', text: `${n} configuration objects restored.`, sev: 0 }];
});
