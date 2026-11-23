// STRSDA y objetos de menú (*MENU): CRTMNU, CHGMNU, DLTMNU. GO busca también los menús de usuario.
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const up = (s) => String(s ?? '').trim().toUpperCase();
const I = { interactive: true };

def('STRSDA', 'Start SDA', [
  P('OPTION', 'Option', 'name', 7, { dft: '*SELECT', choices: '*SELECT, 1, 2, 3' }),
  P('SRCFILE', 'Source file', 'qual', 10, { dft: 'QDDSSRC' }),
  P('SRCMBR', 'Source member', 'name', 10, { dft: '*SELECT' }),
  P('TSTFILE', 'Test file', 'qual', 10, { dft: '*SELECT' }),
], async (ctx, a) => {
  const { strsda } = await import('../screens/sda.js');
  const tst = a.TSTFILE && a.TSTFILE.obj && a.TSTFILE.obj !== '*SELECT' ? a.TSTFILE : null;
  await strsda(ctx, { option: up(a.OPTION), srcfile: a.SRCFILE, srcmbr: up(a.SRCMBR), tstfile: tst });
  return null;
}, I);

def('STRRLU', 'Start Report Layout Utility', [
  P('SRCFILE', 'Source file', 'qual', 10, { dft: 'QDDSSRC' }),
  P('SRCMBR', 'Source member', 'name', 10, { req: true }),
  P('OPTION', 'Option', 'name', 2, { dft: '*BLANK' }),
  P('PAGEWIDTH', 'Page width', 'int', 3, { dft: '132' }),
], async (ctx, a) => {
  const { strrlu } = await import('../screens/rlu.js');
  return (await strrlu(ctx, { lib: a.SRCFILE.lib, file: a.SRCFILE.obj, mbr: a.SRCMBR })) || null;
}, I);

const qualOf = (ctx, q, dftName, dftLib) => {
  if (!q || !q.obj || q.obj === '*MENU') return { lib: dftLib, name: dftName };
  return { lib: !q.lib || q.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(q.lib), name: up(q.obj) };
};

const MNU_PARMS = [
  P('TYPE', 'Menu type', 'name', 5, { dft: '*DSPF', choices: '*DSPF, *PGM' }),
  P('DSPF', 'Display file', 'qual', 10, { dft: '*MENU' }),
  P('MSGF', 'Message file', 'qual', 10, { dft: '*MENU' }),
  P('CMDLIN', 'Command line', 'name', 6, { dft: '*LONG', choices: '*LONG, *SHORT, *NONE' }),
  P('PGM', 'Program', 'qual', 10, { dft: '*MENU' }),
  P('CURLIB', 'Current library', 'name', 10, { dft: '*NOCHG', choices: 'Name, *NOCHG, *MNULIB' }),
];

async function menuData(ctx, a, lib, name, prev = {}) {
  const type = a.TYPE && a.TYPE !== '*SAME' ? up(a.TYPE) : prev.type || '*DSPF';
  const data = { ...prev, type, cmdlin: a.CMDLIN && a.CMDLIN !== '*SAME' ? up(a.CMDLIN) : prev.cmdlin || '*LONG', curlib: a.CURLIB && a.CURLIB !== '*SAME' ? up(a.CURLIB) : prev.curlib || '*NOCHG' };
  if (type === '*DSPF') {
    data.dspf = a.DSPF && a.DSPF.obj !== '*SAME' ? qualOf(ctx, a.DSPF, name, lib) : prev.dspf || { lib, name };
    data.msgf = a.MSGF && a.MSGF.obj !== '*SAME' ? qualOf(ctx, a.MSGF, `${name}QQ`, lib) : prev.msgf || { lib, name: `${name}QQ` };
    const fo = await obj.findObject(gw, data.dspf.name, '*FILE', data.dspf.lib, ctx.libl);
    const d = fo ? await obj.objectData(gw, fo.LIB, data.dspf.name, '*FILE') : null;
    if (!d || d.kind !== 'DSPF') throw new CLError('CPF6AC5', `Display file ${data.dspf.name} in ${data.dspf.lib} not found; menu ${name} not created.`);
    if (!(await obj.findObject(gw, data.msgf.name, '*MSGF', data.msgf.lib, ctx.libl))) throw new CLError('CPF2407', `Message file ${data.msgf.name} in ${data.msgf.lib} not found.`);
  } else {
    data.pgm = a.PGM && a.PGM.obj !== '*SAME' ? qualOf(ctx, a.PGM, name, lib) : prev.pgm || { lib, name };
  }
  return data;
}

def('CRTMNU', 'Create Menu', [P('MENU', 'Menu', 'qual', 10, { req: true, lib: '*CURLIB' }), ...MNU_PARMS, P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' })], async (ctx, a) => {
  const lib = ctx.resolveLib(a.MENU.lib === '*LIBL' ? '*CURLIB' : a.MENU.lib);
  const name = up(a.MENU.obj);
  if (!(await obj.libExists(lib))) throw new CLError('CPF2110', lib);
  if (await obj.findObject(gw, name, '*MENU', lib, [])) throw new CLError('CPF2112', name, lib, '*MENU');
  const data = await menuData(ctx, a, lib, name);
  await obj.putObject(lib, name, '*MENU', data.type === '*PGM' ? 'PGM' : 'DSPF', a.TEXT === '*BLANK' ? '' : a.TEXT, data, ctx.job.user);
  return [{ id: 'CPC2205', text: `Menu ${name} created in library ${lib}.`, sev: 0 }];
});

def('CHGMNU', 'Change Menu', [P('MENU', 'Menu', 'qual', 10, { req: true }), ...MNU_PARMS.map((p) => ({ ...p, dft: '*SAME' })), P('TEXT', "Text 'description'", 'text', 50, { dft: '*SAME' })], async (ctx, a) => {
  const o = await obj.findObject(gw, up(a.MENU.obj), '*MENU', a.MENU.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.MENU.lib), ctx.libl);
  if (!o) throw new CLError('CPF2105', a.MENU.obj, a.MENU.lib, '*MENU');
  const prev = (await obj.objectData(gw, o.LIB, o.NAME, '*MENU')) || {};
  const data = await menuData(ctx, a, o.LIB, o.NAME, prev);
  await obj.putObject(o.LIB, o.NAME, '*MENU', data.type === '*PGM' ? 'PGM' : 'DSPF', a.TEXT === '*SAME' ? o.TEXT : a.TEXT, data, o.OWNER || ctx.job.user);
  return [{ id: 'CPC2206', text: `Menu ${o.NAME} in library ${o.LIB} changed.`, sev: 0 }];
});

def('DLTMNU', 'Delete Menu', [P('MENU', 'Menu', 'qual', 10, { req: true })], async (ctx, a) => {
  const o = await obj.findObject(gw, up(a.MENU.obj), '*MENU', a.MENU.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.MENU.lib), ctx.libl);
  if (!o) throw new CLError('CPF2105', a.MENU.obj, a.MENU.lib, '*MENU');
  await obj.deleteObject(o.LIB, o.NAME, '*MENU');
  return [{ id: 'CPC2191', text: `Object ${o.NAME} in ${o.LIB} type *MENU deleted.`, sev: 0 }];
});

/** GO para un menú de usuario; null si no existe. */
export async function goUserMenu(ctx, q) {
  const o = await obj.findObject(gw, up(q.obj), '*MENU', !q.lib || q.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(q.lib), ctx.libl);
  if (!o) return null;
  const data = await obj.objectData(gw, o.LIB, o.NAME, '*MENU');
  const { showUserMenu } = await import('../screens/sda.js');
  return { r: await showUserMenu(ctx, o.LIB, o.NAME, data) };
}
