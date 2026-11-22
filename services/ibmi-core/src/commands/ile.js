// Mandatos ILE: CRTSRVPGM, CRTPGM, UPDSRVPGM, UPDPGM, CRTBNDDIR, ADDBNDDIRE, RMVBNDDIRE, DSPBNDDIR, DSPSRVPGM,
// DSPMOD, RTVBNDSRC y RCLACTGRP.
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { Panel } from '../panel.js';
import { logJob, sysDate, sysTime } from '../system.js';
import { bindModules, exportsOf, importsOf, parseBinderSource, signatureOf } from '../runtime/ile.js';
import { qualList } from '../runtime/build.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const LIBQ = (kw, prompt, o = {}) => P(kw, prompt, 'qual', 10, { req: true, ...o });
const TEXT = P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' });
const textVal = (t) => (!t || t === '*BLANK' ? '' : t);
const libOf = (ctx, l) => (l === '*LIBL' || !l ? '*LIBL' : ctx.resolveLib(l));
const now = () => { const d = new Date(); return `${sysDate(d)} at ${sysTime(d)}`; };

async function loadModules(ctx, list, self, allowEmpty = false) {
  const mods = [];
  for (const m of qualList(list)) {
    const name = m.name === '*SRVPGM' || m.name === '*PGM' ? self.name : m.name;
    const lib = m.lib || (m.name === '*SRVPGM' || m.name === '*PGM' ? self.lib : null);
    const o = await obj.findObject(gw, name, '*MODULE', libOf(ctx, lib || '*LIBL'), ctx.libl);
    if (!o) throw new CLError('CPF5D1E', `Module ${name} in library ${lib || '*LIBL'} not found.`);
    const data = await obj.objectData(gw, o.LIB, o.NAME, '*MODULE');
    mods.push({ name: o.NAME, lib: o.LIB, ir: data.ir });
  }
  if (!mods.length && !allowEmpty) throw new CLError('CPF5D1E', 'No modules specified.');
  return mods;
}

async function replaceObject(lib, name, type, replace) {
  const ex = await obj.findObject(gw, name, type, lib, []);
  if (ex && !replace) throw new CLError('CPF5D18', `Object ${name} type ${type} already exists in library ${lib}.`);
  return ex;
}

function invalidateSrvpgm(ctx, lib, name) {
  if (ctx.job.srvpgms) ctx.job.srvpgms.delete(`${lib}/${name}`);
  for (const [k] of ctx.job.activations || []) ctx.job.activations.delete(k);
}

/** Crea o actualiza un programa de servicio. */
async function buildSrvpgm(ctx, a, { update = false } = {}) {
  const lib = ctx.resolveLib(a.SRVPGM.lib === '*LIBL' ? '*CURLIB' : a.SRVPGM.lib);
  const name = a.SRVPGM.obj;
  const self = { lib, name };
  let prev = null;
  if (update) {
    const o = await obj.findObject(gw, name, '*SRVPGM', libOf(ctx, a.SRVPGM.lib), ctx.libl);
    if (!o) throw new CLError('CPF9801', name, a.SRVPGM.lib);
    prev = await obj.objectData(gw, o.LIB, name, '*SRVPGM');
    self.lib = o.LIB;
  } else await replaceObject(lib, name, '*SRVPGM', a.REPLACE !== '*NO');
  let modules;
  if (update) {
    // UPDSRVPGM: se sustituyen los módulos indicados por su versión actual
    const fresh = await loadModules(ctx, a.MODULE, self, true);
    modules = prev.modules.map((m) => fresh.find((f) => f.name === m.name) || m);
    for (const f of fresh) if (!modules.some((m) => m.name === f.name)) modules.push(f);
  } else modules = await loadModules(ctx, a.MODULE, self);
  // Exportaciones: lenguaje enlazador (*SRCFILE) o todas (*ALL)
  let exports;
  let signature;
  let signatures;
  const exp = String(a.EXPORT || '*SRCFILE').toUpperCase();
  if (exp === '*ALL') {
    exports = modules.flatMap((m) => exportsOf(m.ir));
    signature = signatureOf(exports);
    signatures = [signature];
  } else {
    const srcLib = libOf(ctx, a.SRCFILE.lib);
    const mbr = !a.SRCMBR || a.SRCMBR === '*SRVPGM' ? name : a.SRCMBR;
    const mi = await obj.findMember(gw, srcLib === '*LIBL' ? null : srcLib, a.SRCFILE.obj || 'QSRVSRC', mbr, ctx.libl);
    if (!mi) throw new CLError('CPF9815', mbr, a.SRCFILE.obj || 'QSRVSRC', a.SRCFILE.lib);
    const src = await obj.readMember(gw, mi.LIB, a.SRCFILE.obj || 'QSRVSRC', mbr);
    const bs = parseBinderSource(src);
    exports = bs.current.exports;
    signature = signatureOf(exports, bs.current.signature);
    // Las firmas anteriores (PGMLVL(*PRV)) siguen siendo válidas para los programas ya enlazados
    signatures = [signature, ...bs.previous.map((b) => signatureOf(b.exports, b.signature))];
  }
  const all = new Set(modules.flatMap((m) => exportsOf(m.ir)));
  const missing = exports.filter((e) => !all.has(String(e).toUpperCase()));
  if (missing.length) {
    for (const m of missing) logJob(ctx.job, 'CPD5D03', '*DIAG', `Definition not found for exported symbol ${m}.`, { sev: 30 });
    throw new CLError('CPF5D04', name, self.lib);
  }
  const res = await bindModules(ctx, { modules, bndsrvpgm: qualList(a.BNDSRVPGM || []), bnddir: qualList(a.BNDDIR || []), self });
  const data = {
    kind: 'SRVPGM', modules: res.modules.map((m) => ({ name: m.name, lib: m.lib, ir: m.ir })),
    exports: exports.map((e) => String(e).toUpperCase()), signature, signatures,
    bind: res.bind.filter((b) => b.kind === 'srvpgm'), actgrp: a.ACTGRP || '*CALLER',
  };
  await obj.putObject(self.lib, name, '*SRVPGM', 'RPGLE', textVal(a.TEXT) || (prev && '') || '', data, ctx.job.user);
  invalidateSrvpgm(ctx, self.lib, name);
  return [{ id: update ? 'CPC5D0D' : 'CPC5D0B', text: `Service program ${name} ${update ? 'updated' : 'created'} in library ${self.lib}.`, sev: 0 }];
}

def('CRTSRVPGM', 'Create Service Program', [
  LIBQ('SRVPGM', 'Service program', { lib: '*CURLIB' }),
  P('MODULE', 'Module', 'list', 60, { dft: '*SRVPGM' }),
  P('EXPORT', 'Export', 'name', 10, { dft: '*SRCFILE', choices: '*SRCFILE, *ALL' }),
  LIBQ('SRCFILE', 'Export source file', { req: false, dft: 'QSRVSRC' }),
  P('SRCMBR', 'Export source member', 'name', 10, { dft: '*SRVPGM' }),
  TEXT,
  P('BNDSRVPGM', 'Bind service program', 'list', 60, { dft: '*NONE' }),
  P('BNDDIR', 'Binding directory', 'list', 60, { dft: '*NONE' }),
  P('ACTGRP', 'Activation group', 'name', 10, { dft: '*CALLER' }),
  P('REPLACE', 'Replace existing service program', 'char', 4, { dft: '*YES', choices: '*YES, *NO' }),
], async (ctx, a) => buildSrvpgm(ctx, a));

def('UPDSRVPGM', 'Update Service Program', [
  LIBQ('SRVPGM', 'Service program'),
  P('MODULE', 'Module', 'list', 60, { dft: '*SAME' }),
  P('EXPORT', 'Export', 'name', 10, { dft: '*SRCFILE', choices: '*SRCFILE, *ALL' }),
  LIBQ('SRCFILE', 'Export source file', { req: false, dft: 'QSRVSRC' }),
  P('SRCMBR', 'Export source member', 'name', 10, { dft: '*SRVPGM' }),
  P('BNDSRVPGM', 'Bind service program', 'list', 60, { dft: '*NONE' }),
  P('BNDDIR', 'Binding directory', 'list', 60, { dft: '*NONE' }),
], async (ctx, a) => buildSrvpgm(ctx, { ...a, MODULE: a.MODULE === '*SAME' ? [] : a.MODULE }, { update: true }));

async function buildPgm(ctx, a, { update = false } = {}) {
  const lib = ctx.resolveLib(a.PGM.lib === '*LIBL' ? '*CURLIB' : a.PGM.lib);
  const name = a.PGM.obj;
  const self = { lib, name };
  let modules;
  let entmod;
  if (update) {
    const o = await obj.findObject(gw, name, '*PGM', libOf(ctx, a.PGM.lib), ctx.libl);
    if (!o) throw new CLError('CPF9811', name, a.PGM.lib);
    const prev = await obj.objectData(gw, o.LIB, name, '*PGM');
    self.lib = o.LIB;
    const fresh = await loadModules(ctx, a.MODULE, self, true);
    const cur = [{ name: prev.entmod || name, lib: o.LIB, ir: prev.ir }, ...(prev.modules || [])];
    modules = cur.map((m) => fresh.find((f) => f.name === m.name) || m);
    entmod = prev.entmod || name;
  } else {
    await replaceObject(lib, name, '*PGM', a.REPLACE !== '*NO');
    modules = await loadModules(ctx, a.MODULE, self);
    const ent = String(a.ENTMOD || '*FIRST').toUpperCase();
    if (ent === '*FIRST' || ent === '*ONLY') entmod = (modules.find((m) => !(m.ir.ctl && m.ir.ctl.NOMAIN)) || {}).name;
    else entmod = qualList([ent])[0].name;
  }
  const entry = modules.find((m) => m.name === entmod);
  if (!entry || (entry.ir.ctl && entry.ir.ctl.NOMAIN)) throw new CLError('CPF5D0B', `Program entry procedure module not found; program ${name} not created in library ${self.lib}.`);
  const res = await bindModules(ctx, { modules, bndsrvpgm: qualList(a.BNDSRVPGM || []), bnddir: qualList(a.BNDDIR || []), self });
  const ir = JSON.parse(JSON.stringify(entry.ir));
  ir.$bind = res.bind.filter((b) => b.kind === 'srvpgm');
  const data = { kind: 'RPG', ir, entmod, modules: res.modules.filter((m) => m.name !== entmod).map((m) => ({ name: m.name, lib: m.lib, ir: m.ir })), actgrp: a.ACTGRP || '*ENTMOD' };
  await obj.putObject(self.lib, name, '*PGM', 'RPGLE', textVal(a.TEXT), data, ctx.job.user);
  for (const [k] of ctx.job.activations || []) if (k.endsWith(`/${name}`)) ctx.job.activations.delete(k);
  return [{ id: update ? 'CPC5D0E' : 'CPC5D07', text: `Program ${name} ${update ? 'updated' : 'created'} in library ${self.lib}.`, sev: 0 }];
}

def('CRTPGM', 'Create Program', [
  LIBQ('PGM', 'Program', { lib: '*CURLIB' }),
  P('MODULE', 'Module', 'list', 60, { dft: '*PGM' }),
  P('ENTMOD', 'Program entry procedure module', 'name', 21, { dft: '*FIRST' }),
  P('BNDSRVPGM', 'Bind service program', 'list', 60, { dft: '*NONE' }),
  P('BNDDIR', 'Binding directory', 'list', 60, { dft: '*NONE' }),
  P('ACTGRP', 'Activation group', 'name', 10, { dft: '*ENTMOD' }),
  TEXT,
  P('REPLACE', 'Replace program', 'char', 4, { dft: '*YES', choices: '*YES, *NO' }),
], async (ctx, a) => buildPgm(ctx, a));

def('UPDPGM', 'Update Program', [
  LIBQ('PGM', 'Program'),
  P('MODULE', 'Module', 'list', 60, { dft: '*NONE' }),
  P('BNDSRVPGM', 'Bind service program', 'list', 60, { dft: '*SAME' }),
  P('BNDDIR', 'Binding directory', 'list', 60, { dft: '*SAME' }),
], async (ctx, a) => buildPgm(ctx, {
  ...a, MODULE: a.MODULE === '*NONE' ? [] : a.MODULE,
  BNDSRVPGM: a.BNDSRVPGM === '*SAME' ? [] : a.BNDSRVPGM, BNDDIR: a.BNDDIR === '*SAME' ? [] : a.BNDDIR,
}, { update: true }));

// ---------- Directorios de enlace ----------
def('CRTBNDDIR', 'Create Binding Directory', [LIBQ('BNDDIR', 'Binding directory', { lib: '*CURLIB' }), TEXT], async (ctx, a) => {
  const lib = ctx.resolveLib(a.BNDDIR.lib === '*LIBL' ? '*CURLIB' : a.BNDDIR.lib);
  if (await obj.findObject(gw, a.BNDDIR.obj, '*BNDDIR', lib, [])) throw new CLError('CPF2112', a.BNDDIR.obj, lib, '*BNDDIR');
  await obj.putObject(lib, a.BNDDIR.obj, '*BNDDIR', '', textVal(a.TEXT), { entries: [] }, ctx.job.user);
  return [{ id: 'CPC5D15', text: `Binding directory ${a.BNDDIR.obj} created in library ${lib}.`, sev: 0 }];
});

async function bnddirOf(ctx, q) {
  const o = await obj.findObject(gw, q.obj, '*BNDDIR', libOf(ctx, q.lib), ctx.libl);
  if (!o) throw new CLError('CPF9801', q.obj, q.lib);
  return { o, data: (await obj.objectData(gw, o.LIB, o.NAME, '*BNDDIR')) || { entries: [] } };
}

// OBJ((LIB/NOMBRE *SRVPGM) (NOMBRE *MODULE))
function parseEntries(raw) {
  const text = Array.isArray(raw) ? raw.join(' ') : String(raw || '');
  const out = [];
  const groups = text.match(/\([^()]*\)/g) || [text];
  for (const g of groups) {
    const [q, type] = g.replace(/[()]/g, ' ').trim().split(/\s+/);
    if (!q) continue;
    const [l, n] = q.includes('/') ? q.split('/') : ['*LIBL', q];
    out.push({ lib: l.toUpperCase(), obj: n.toUpperCase(), type: (type || '*SRVPGM').toUpperCase() });
  }
  return out;
}

def('ADDBNDDIRE', 'Add Binding Directory Entry', [
  LIBQ('BNDDIR', 'Binding directory'), P('OBJ', 'Object specifications', 'list', 60, { req: true }),
  P('POSITION', 'Position', 'name', 10, { dft: '*LAST', choices: '*LAST, *FIRST' }),
], async (ctx, a) => {
  const { o, data } = await bnddirOf(ctx, a.BNDDIR);
  const add = parseEntries(a.OBJ);
  for (const e of add) {
    if (!['*SRVPGM', '*MODULE'].includes(e.type)) throw new CLError('CPF5D20', `Object type ${e.type} not valid for a binding directory.`);
    if (data.entries.some((x) => x.obj === e.obj && x.type === e.type && x.lib === e.lib)) { logJob(ctx.job, 'CPF5D1F', '*DIAG', `Entry ${e.lib}/${e.obj} ${e.type} already in binding directory.`, { sev: 10 }); continue; }
    if (a.POSITION === '*FIRST') data.entries.unshift(e); else data.entries.push(e);
  }
  await obj.putObject(o.LIB, o.NAME, '*BNDDIR', '', o.TEXT, data, o.OWNER);
  return [{ id: 'CPC5D16', text: `${add.length} entries added to binding directory ${o.NAME} in library ${o.LIB}.`, sev: 0 }];
});

def('RMVBNDDIRE', 'Remove Binding Directory Entry', [LIBQ('BNDDIR', 'Binding directory'), P('OBJ', 'Object', 'list', 60, { req: true })], async (ctx, a) => {
  const { o, data } = await bnddirOf(ctx, a.BNDDIR);
  const rm = parseEntries(a.OBJ);
  const before = data.entries.length;
  data.entries = data.entries.filter((x) => !rm.some((r) => r.obj === x.obj && (r.type === x.type) && (r.lib === '*LIBL' || r.lib === x.lib)));
  await obj.putObject(o.LIB, o.NAME, '*BNDDIR', '', o.TEXT, data, o.OWNER);
  return [{ id: 'CPC5D17', text: `${before - data.entries.length} entries removed from binding directory ${o.NAME}.`, sev: 0 }];
});

def('DSPBNDDIR', 'Display Binding Directory', [LIBQ('BNDDIR', 'Binding directory')], async (ctx, a) => {
  const { o, data } = await bnddirOf(ctx, a.BNDDIR);
  const lines = [`Binding directory: ${o.NAME}   Library: ${o.LIB}`, '', 'Object      Type        Library', ...data.entries.map((e) => `${e.obj.padEnd(12)}${e.type.padEnd(12)}${e.lib}`)];
  if (!ctx.interactive) return { text: lines.join('\n') };
  const p = new Panel({ fn: 'CMD-DSPBNDDIR', keys: ['F3', 'F12'] });
  p.title('Display Binding Directory');
  p.sysName();
  lines.forEach((l, i) => p.text(3 + i, 2, l, i === 2 ? 'b' : i ? 'g' : 'w'));
  p.fkeys('F3=Exit   F12=Cancel');
  await ctx.display(p);
  return null;
});

def('DSPSRVPGM', 'Display Service Program', [LIBQ('SRVPGM', 'Service program'), P('DETAIL', 'Detail', 'list', 30, { dft: '*ALL' })], async (ctx, a) => {
  const o = await obj.findObject(gw, a.SRVPGM.obj, '*SRVPGM', libOf(ctx, a.SRVPGM.lib), ctx.libl);
  if (!o) throw new CLError('CPF9801', a.SRVPGM.obj, a.SRVPGM.lib);
  const d = await obj.objectData(gw, o.LIB, o.NAME, '*SRVPGM');
  const lines = [
    `Service program . . . . :   ${o.NAME}`, `  Library . . . . . . . :   ${o.LIB}`, `Current signature . . . :   ${d.signature}`,
    `Activation group  . . . :   ${d.actgrp}`, '', 'Modules:', ...d.modules.map((m) => `   ${m.name.padEnd(12)}${m.lib}`),
    '', 'Exported procedures:', ...d.exports.map((e) => `   ${e}`),
    '', 'Bound service programs:', ...(d.bind || []).map((b) => `   ${b.name.padEnd(12)}${b.lib}`),
  ];
  if (!ctx.interactive) return { text: lines.join('\n') };
  const p = new Panel({ fn: 'CMD-DSPSRVPGM', keys: ['F3', 'F12'] });
  p.title('Display Service Program Information');
  p.sysName();
  lines.slice(0, 18).forEach((l, i) => p.text(3 + i, 2, l, 'g'));
  p.fkeys('F3=Exit   F12=Cancel');
  await ctx.display(p);
  return null;
});

def('DSPMOD', 'Display Module', [LIBQ('MODULE', 'Module')], async (ctx, a) => {
  const o = await obj.findObject(gw, a.MODULE.obj, '*MODULE', libOf(ctx, a.MODULE.lib), ctx.libl);
  if (!o) throw new CLError('CPF9801', a.MODULE.obj, a.MODULE.lib);
  const d = await obj.objectData(gw, o.LIB, o.NAME, '*MODULE');
  const text = [`Module  . . . . . . . . :   ${o.NAME}`, `  Library . . . . . . . :   ${o.LIB}`, `Module attribute  . . . :   ${o.ATTR}`,
    `Main procedure  . . . . :   ${d.ir.ctl && d.ir.ctl.NOMAIN ? '*NONE' : o.NAME}`, `Exports . . . . . . . . :   ${exportsOf(d.ir).join(' ') || '*NONE'}`,
    `Imports . . . . . . . . :   ${importsOf(d.ir).join(' ') || '*NONE'}`].join('\n');
  return { text };
});

// Genera lenguaje enlazador a partir de los módulos o de un programa de servicio
def('RTVBNDSRC', 'Retrieve Binder Source', [
  P('MODULE', 'Module', 'list', 60, { dft: '*NONE' }), LIBQ('SRVPGM', 'Service program', { req: false, dft: '*NONE' }),
  LIBQ('SRCFILE', 'Source file', { req: false, dft: 'QSRVSRC' }), P('SRCMBR', 'Source member', 'name', 10, { dft: '*SRVPGM' }),
], async (ctx, a) => {
  let exports = [];
  let name = a.SRCMBR;
  if (a.SRVPGM && a.SRVPGM.obj && a.SRVPGM.obj !== '*NONE') {
    const o = await obj.findObject(gw, a.SRVPGM.obj, '*SRVPGM', libOf(ctx, a.SRVPGM.lib), ctx.libl);
    if (!o) throw new CLError('CPF9801', a.SRVPGM.obj, a.SRVPGM.lib);
    exports = (await obj.objectData(gw, o.LIB, o.NAME, '*SRVPGM')).exports;
    if (name === '*SRVPGM') name = o.NAME;
  } else {
    const mods = await loadModules(ctx, a.MODULE, { lib: ctx.curlib, name: '' });
    exports = mods.flatMap((m) => exportsOf(m.ir));
    if (name === '*SRVPGM') name = mods[0].name;
  }
  const lib = ctx.resolveLib(a.SRCFILE.lib === '*LIBL' ? '*CURLIB' : a.SRCFILE.lib);
  const file = a.SRCFILE.obj || 'QSRVSRC';
  const lines = ['STRPGMEXP PGMLVL(*CURRENT)', ...exports.map((e) => `  EXPORT SYMBOL(${e})`), 'ENDPGMEXP'];
  const ex = await obj.listMembers(lib, file);
  if (!ex.some((m) => m.MBR === name)) await obj.addMember(lib, file, name, 'BND', `Binder source ${now()}`);
  await obj.writeMember(lib, file, name, lines.map((t, i) => ({ seq: (i + 1) * 100, dat: 0, text: t })));
  return [{ id: 'CPC5D1B', text: `Binder source written to ${lib}/${file}(${name}).`, sev: 0 }];
});

def('RCLACTGRP', 'Reclaim Activation Group', [P('ACTGRP', 'Activation group', 'name', 10, { req: true, choices: 'Name, *ELIGIBLE' })], async (ctx, a) => {
  const n = ctx.job.srvpgms ? ctx.job.srvpgms.size : 0;
  if (ctx.job.srvpgms) ctx.job.srvpgms.clear();
  for (const [k] of ctx.job.activations || []) ctx.job.activations.delete(k);
  return [{ id: 'CPC1506', text: `Activation group ${a.ACTGRP} reclaimed; ${n} service program activation(s) ended.`, sev: 0 }];
});
