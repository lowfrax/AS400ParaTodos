// CRTSAVF, CLRSAVF, DSPSAVF, SAVOBJ, SAVLIB, SAVCHGOBJ, SAVSECDTA, RSTOBJ, RSTLIB, RSTUSRPRF, RSTAUT.
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { Panel, padR, padL } from '../panel.js';
import * as S from '../savrst.js';
import { sysDate, sysTime } from '../system.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const up = (s) => String(s ?? '').trim().toUpperCase();
const list = (v) => [].concat(v ?? []).flatMap((x) => String(x).toUpperCase().split(/\s+/)).filter(Boolean);
const DEV = P('DEV', 'Device', 'list', 40, { req: true, choices: 'Name, *SAVF' });
const SAVF = P('SAVF', 'Save file', 'qual', 10, { dft: '*NONE' });

async function savfOf(ctx, a) {
  const dev = list(a.DEV)[0];
  if (dev !== '*SAVF') throw new CLError('CPF9814', dev);
  if (!a.SAVF || !a.SAVF.obj || a.SAVF.obj === '*NONE') throw new CLError('CPD0072', 'SAVF');
  const o = await obj.findObject(gw, up(a.SAVF.obj), '*FILE', !a.SAVF.lib || a.SAVF.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.SAVF.lib), ctx.libl);
  if (!o || o.ATTR !== 'SAVF') throw new CLError('CPF9812', up(a.SAVF.obj), a.SAVF.lib || '*LIBL');
  return o;
}
const sec = () => import('../security.js');
// SAVxxx / RSTxxx exigen *SAVSYS o *OBJEXIST sobre cada objeto; se comprueba al menos el *SAVSYS o la propiedad de la biblioteca
async function mayOperate(ctx, lib) {
  const s = await sec();
  if (s.hasSpecial(ctx.user, '*SAVSYS') || s.hasSpecial(ctx.user, '*ALLOBJ')) return;
  const lo = await s.objectRow('QSYS', lib, '*LIB');
  if (lo && lo.OWNER === ctx.job.user) return;
  throw new CLError('CPF3774', lib);
}

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
    ...(d.entries || []).map((e) => `${padR(e.name, 12)}${padR(e.type, 10)}${padR(e.attr, 12)}${padR(e.owner, 12)}${padL(Math.max(1, Math.ceil((e.size || 0) / 1024)), 8)}   ${e.rows !== undefined ? 'YES ' : 'NO  '}  ${String(e.text || '').slice(0, 20)}`),
  ];
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

const SAVE_PARMS = [DEV, SAVF, P('UPDHST', 'Update history', 'char', 4, { dft: '*YES' }), P('TGTRLS', 'Target release', 'name', 8, { dft: '*CURRENT' }), P('CLEAR', 'Clear', 'name', 8, { dft: '*NONE', choices: '*NONE, *ALL, *AFTER, *REPLACE' }), P('PVTAUT', 'Private authorities', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }), P('DTACPR', 'Data compression', 'name', 7, { dft: '*DEV' })];

def('SAVOBJ', 'Save Object', [P('OBJ', 'Objects', 'list', 120, { req: true, choices: 'Name, generic*, *ALL' }), P('LIB', 'Library', 'list', 60, { req: true }), ...SAVE_PARMS, P('OBJTYPE', 'Object types', 'list', 60, { dft: '*ALL' })], async (ctx, a) => {
  const so = await savfOf(ctx, a);
  const libs = list(a.LIB).map((l) => ctx.resolveLib(l));
  if (libs.length > 1) throw new CLError('CPF3782', 'Only one library can be saved to a save file.');
  await mayOperate(ctx, libs[0]);
  const r = await S.saveToSavf(ctx.job, libs[0], { names: list(a.OBJ), types: list(a.OBJTYPE) }, so.LIB, so.NAME, { clear: a.CLEAR, pvtaut: a.PVTAUT === '*YES', cmd: 'SAVOBJ' });
  return [{ id: 'CPC3701', text: `${r.count} objects saved from library ${libs[0]}.`, sev: 0 }];
});
def('SAVLIB', 'Save Library', [P('LIB', 'Library', 'list', 60, { req: true, choices: 'Name, generic*, *NONSYS, *ALLUSR, *IBM' }), ...SAVE_PARMS], async (ctx, a) => {
  const so = await savfOf(ctx, a);
  const libs = list(a.LIB);
  if (libs.length > 1 || libs[0].startsWith('*')) throw new CLError('CPF3782', 'A save file can contain one library; save *NONSYS/*ALLUSR to tape.');
  const lib = ctx.resolveLib(libs[0]);
  await mayOperate(ctx, lib);
  const r = await S.saveToSavf(ctx.job, lib, { names: ['*ALL'], types: ['*ALL'] }, so.LIB, so.NAME, { clear: a.CLEAR, pvtaut: a.PVTAUT === '*YES', cmd: 'SAVLIB', libDesc: true });
  return [{ id: 'CPC3722', text: `${r.count} objects saved from library ${lib}.`, sev: 0 }];
});
def('SAVCHGOBJ', 'Save Changed Objects', [P('OBJ', 'Objects', 'list', 120, { dft: '*ALL' }), P('LIB', 'Library', 'list', 60, { req: true }), ...SAVE_PARMS, P('OBJTYPE', 'Object types', 'list', 60, { dft: '*ALL' }), P('REFDATE', 'Reference date', 'char', 10, { dft: '*SAVLIB' }), P('REFTIME', 'Reference time', 'char', 8, { dft: '*NONE' })], async (ctx, a) => {
  const so = await savfOf(ctx, a);
  const lib = ctx.resolveLib(list(a.LIB)[0]);
  await mayOperate(ctx, lib);
  let since;
  if (up(a.REFDATE) === '*SAVLIB') {
    const lo = (await gw.rows("SELECT DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'", [lib]))[0];
    const ld = lo && lo.DATA ? JSON.parse(lo.DATA) : {};
    if (!ld.lastSave) throw new CLError('CPF3782', `Library ${lib} has never been saved; REFDATE(*SAVLIB) not valid.`);
    since = new Date(ld.lastSave);
  } else {
    const m = /^(\d{2})(\d{2})(\d{2,4})$/.exec(String(a.REFDATE).replace(/\D/g, ''));
    if (!m) throw new CLError('CPD0074', a.REFDATE, 'REFDATE');
    const t = String(a.REFTIME || '').replace(/\D/g, '').padEnd(6, '0');
    since = new Date(`${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1]}-${m[2]}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`);
  }
  const r = await S.saveToSavf(ctx.job, lib, { names: list(a.OBJ), types: list(a.OBJTYPE), changedSince: since }, so.LIB, so.NAME, { clear: a.CLEAR, pvtaut: a.PVTAUT === '*YES', cmd: 'SAVCHGOBJ' }).catch((e) => { if (e.msgId === 'CPF3770') return { count: 0 }; throw e; });
  return [{ id: 'CPC3704', text: `${r.count} objects saved from library ${lib}.`, sev: 0 }];
});
def('SAVSECDTA', 'Save Security Data', [DEV, SAVF, P('CLEAR', 'Clear', 'name', 8, { dft: '*NONE' })], async (ctx, a) => {
  const so = await savfOf(ctx, a);
  if (!(await sec()).hasSpecial(ctx.user, '*SAVSYS')) throw new CLError('CPF9898', 'Special authority *SAVSYS required for SAVSECDTA.');
  const r = await S.saveSecurity(ctx.job, so.LIB, so.NAME);
  return [{ id: 'CPC3701', text: `${r.users} user profiles saved; ${r.auts} private authorities saved.`, sev: 0 }];
});

const RST_PARMS = [DEV, SAVF, P('MBROPT', 'Data base member option', 'name', 6, { dft: '*MATCH', choices: '*MATCH, *ALL, *NEW, *OLD' }), P('ALWOBJDIF', 'Allow object differences', 'list', 30, { dft: '*NONE' }), P('RSTLIB', 'Restore to library', 'name', 10, { dft: '*SAVLIB' })];
function rstMessage(r, cmd) {
  const msgs = [];
  for (const f of r.failed) msgs.push({ id: 'CPF3773', text: `Object ${f.name} type ${f.type} not restored: ${f.error}`, sev: 30 });
  if (r.failed.length) throw new CLError('CPF3773', `${r.failed.length} objects not restored to ${r.lib}`, r.lib, r.failed.map((f) => `${f.name} ${f.type}: ${f.error}`).join('; '));
  msgs.push({ id: cmd === 'RSTLIB' ? 'CPC3703' : 'CPC3703', text: `${r.restored} objects restored from ${r.savlib} to ${r.lib}.${r.skipped ? ` ${r.skipped} not restored (MBROPT).` : ''}`, sev: 0 });
  return msgs;
}
def('RSTOBJ', 'Restore Object', [P('OBJ', 'Objects', 'list', 120, { req: true, choices: 'Name, generic*, *ALL' }), P('SAVLIB', 'Saved library', 'name', 10, { req: true }), ...RST_PARMS, P('OBJTYPE', 'Object types', 'list', 60, { dft: '*ALL' })], async (ctx, a) => {
  const so = await savfOf(ctx, a);
  const rl = a.RSTLIB === '*SAVLIB' ? up(a.SAVLIB) : ctx.resolveLib(a.RSTLIB);
  await mayOperate(ctx, rl);
  const r = await S.restoreFromSavf(ctx.job, so.LIB, so.NAME, { names: list(a.OBJ), types: list(a.OBJTYPE), savlib: up(a.SAVLIB) }, { rstlib: rl, mbropt: a.MBROPT });
  return rstMessage(r, 'RSTOBJ');
});
def('RSTLIB', 'Restore Library', [P('SAVLIB', 'Saved library', 'name', 10, { req: true }), ...RST_PARMS], async (ctx, a) => {
  const so = await savfOf(ctx, a);
  const rl = a.RSTLIB === '*SAVLIB' ? up(a.SAVLIB) : up(a.RSTLIB);
  if (await obj.libExists(rl)) await mayOperate(ctx, rl);
  else if (!(await sec()).hasSpecial(ctx.user, '*SAVSYS')) throw new CLError('CPF3774', rl);
  const r = await S.restoreFromSavf(ctx.job, so.LIB, so.NAME, { names: ['*ALL'], types: ['*ALL'], savlib: up(a.SAVLIB) }, { rstlib: rl, mbropt: a.MBROPT, createLib: true });
  return rstMessage(r, 'RSTLIB');
});
def('RSTUSRPRF', 'Restore User Profiles', [DEV, SAVF, P('USRPRF', 'User profile', 'list', 100, { dft: '*ALL' })], async (ctx, a) => {
  const so = await savfOf(ctx, a);
  if (!(await sec()).hasSpecial(ctx.user, '*SECADM') || !(await sec()).hasSpecial(ctx.user, '*SAVSYS')) throw new CLError('CPF9898', 'Special authorities *SECADM and *SAVSYS required for RSTUSRPRF.');
  const n = await S.restoreProfiles(ctx.job, so.LIB, so.NAME, list(a.USRPRF));
  return [{ id: 'CPC3705', text: `${n} user profiles restored.`, sev: 0 }];
});
def('RSTAUT', 'Restore Authority', [P('USRPRF', 'User profile', 'list', 100, { dft: '*ALL' }), P('SAVF', 'Save file (SAVSECDTA)', 'qual', 10, { req: true })], async (ctx, a) => {
  const so = await savfOf(ctx, { DEV: '*SAVF', SAVF: a.SAVF });
  if (!(await sec()).hasSpecial(ctx.user, '*SECADM')) throw new CLError('CPF9898', 'Special authority *SECADM required for RSTAUT.');
  const n = await S.restoreAuthorities(so.LIB, so.NAME, list(a.USRPRF));
  return [{ id: 'CPF3736', text: `${n} authorities restored.`, sev: 0 }];
});
