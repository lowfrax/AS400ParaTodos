// ILE: módulos (*MODULE), programas de servicio (*SRVPGM), directorios de enlace (*BNDDIR) y enlace de símbolos.
//   - Un módulo exporta sus procedimientos con EXPORT e importa los que llama sin definirlos (prototipos sin EXTPGM).
//   - CRTPGM/CRTBNDRPG/CRTSRVPGM resuelven cada importación contra los módulos enlazados, los programas de servicio
//     (BNDSRVPGM) y las entradas de los directorios de enlace (BNDDIR); si falta alguna: CPD5D02 + CPF5D04.
//   - En ejecución, cada programa de servicio se activa una vez por trabajo: su almacenamiento estático persiste.
//   - La firma (SIGNATURE) se comprueba al activar: si cambió, MCH4431 como en IBM i.
import crypto from 'node:crypto';
import { gw, findObject, objectData } from '../objects.js';
import { CLError } from '../messages.js';
import { logJob } from '../system.js';
import { isSystemProc } from './sysapi.js';

const up = (s) => String(s || '').toUpperCase();

/** Procedimientos exportados por un módulo (nombre en mayúsculas o el de EXTPROC del PI). */
export function exportsOf(ir) {
  return Object.values(ir.procs || {}).filter((p) => p.export).map((p) => up(p.name));
}

/** Símbolos que el módulo llama y no define (sus importaciones). */
export function importsOf(ir) {
  const called = new Set();
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (x.k === 'call' || x.k === 'id') called.add(x.name);
    for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v);
  };
  walk([ir.main, ir.subrs, Object.values(ir.procs || {}).map((p) => [p.body, p.subrs, p.decls]), ir.decls, ir.totals || []]);
  const out = new Set();
  for (const [name, pr] of Object.entries(ir.protos || {})) {
    if (pr.extpgm) continue;
    const sym = up(pr.extproc || name);
    if (ir.procs[name] || ir.procs[sym]) continue;
    if (!called.has(name)) continue;
    if (isSystemProc(sym)) continue;
    out.add(sym);
  }
  return [...out];
}

/** Lenguaje enlazador: STRPGMEXP PGMLVL(*CURRENT) SIGNATURE('x') / EXPORT SYMBOL(nombre) / ENDPGMEXP */
export function parseBinderSource(lines) {
  const text = lines.map((l) => String(typeof l === 'object' ? l.text : l)).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const blocks = [];
  let cur = null;
  for (const m of text.matchAll(/(STRPGMEXP|EXPORT|ENDPGMEXP)\b([^\n]*)/gi)) {
    const kw = up(m[1]);
    const rest = m[2];
    if (kw === 'STRPGMEXP') {
      const lvl = /PGMLVL\(\s*(\*\w+)\s*\)/i.exec(rest);
      const sig = /SIGNATURE\(\s*'([^']*)'\s*\)|SIGNATURE\(\s*(\*\w+|X'[0-9A-F]+')\s*\)/i.exec(rest);
      cur = { level: lvl ? up(lvl[1]) : '*CURRENT', signature: sig ? (sig[1] ?? sig[2]) : null, exports: [] };
      blocks.push(cur);
    } else if (kw === 'EXPORT' && cur) {
      const s = /SYMBOL\(\s*(?:'([^']*)'|"([^"]*)"|([\w#@$]+))\s*\)/i.exec(rest);
      if (s) cur.exports.push(s[1] ?? s[2] ?? up(s[3]));
    } else if (kw === 'ENDPGMEXP') cur = null;
  }
  const current = blocks.find((b) => b.level === '*CURRENT') || blocks[0];
  if (!current) throw new CLError('CPF5D1A', 'Binder language source has no STRPGMEXP/ENDPGMEXP group.');
  return { current, previous: blocks.filter((b) => b !== current) };
}

export function signatureOf(exports, given) {
  if (given && given !== '*GEN') return String(given).padEnd(16).slice(0, 16);
  return crypto.createHash('md5').update(exports.map(up).join('\u0000')).digest('hex').slice(0, 32).toUpperCase();
}

async function objectOf(ctx, lib, name, type) {
  const o = await findObject(gw, up(name), type, !lib || lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(lib), ctx.libl);
  if (!o) return null;
  return { o, data: await objectData(gw, o.LIB, o.NAME, type) };
}

/**
 * Enlaza módulos. o = {modules:[{name, lib, ir}], bndsrvpgm:[{lib,name}], bnddir:[{lib,name}], self:{lib,name,type}}
 * Devuelve {bind:[{kind:'srvpgm', lib, name, signature}|{kind:'module', name}], exports:[...]}.
 */
export async function bindModules(ctx, o) {
  const symbols = new Map(); // símbolo → origen
  const dup = [];
  for (const m of o.modules) for (const e of exportsOf(m.ir)) { if (symbols.has(e)) dup.push(e); symbols.set(e, { kind: 'module', name: m.name }); }
  if (dup.length) {
    for (const d of dup) logJob(ctx.job, 'CPD5D03', '*DIAG', `Definition supplied multiple times for symbol ${d}.`, { sev: 30 });
    throw new CLError('CPF5D04', o.self.name, o.self.lib);
  }
  // Programas de servicio: explícitos y de los directorios de enlace (en orden)
  const srvs = [];
  const addSrv = async (lib, name, from) => {
    const r = await objectOf(ctx, lib, name, '*SRVPGM');
    if (!r) {
      logJob(ctx.job, 'CPD5D1D', '*DIAG', `Service program ${name} in library ${lib || '*LIBL'} not found${from ? ` (binding directory ${from})` : ''}.`, { sev: 30 });
      return false;
    }
    if (!srvs.some((s) => s.lib === r.o.LIB && s.name === r.o.NAME)) srvs.push({ lib: r.o.LIB, name: r.o.NAME, data: r.data });
    return true;
  };
  let missingObj = false;
  for (const s of o.bndsrvpgm || []) if (!(await addSrv(s.lib, s.name))) missingObj = true;
  const bdModules = [];
  for (const b of o.bnddir || []) {
    const r = await objectOf(ctx, b.lib, b.name, '*BNDDIR');
    if (!r) { logJob(ctx.job, 'CPD5D1C', '*DIAG', `Binding directory ${b.name} in library ${b.lib || '*LIBL'} not found.`, { sev: 30 }); missingObj = true; continue; }
    for (const e of r.data.entries || []) {
      if (e.type === '*SRVPGM') await addSrv(e.lib === '*LIBL' ? null : e.lib, e.obj, b.name);
      else if (e.type === '*MODULE') {
        const m = await objectOf(ctx, e.lib === '*LIBL' ? null : e.lib, e.obj, '*MODULE');
        if (m) bdModules.push({ name: m.o.NAME, lib: m.o.LIB, ir: m.data.ir, fromDir: true });
      }
    }
  }
  if (missingObj) throw new CLError('CPF5D04', o.self.name, o.self.lib);
  for (const s of srvs) for (const e of s.data.exports || []) if (!symbols.has(up(e))) symbols.set(up(e), { kind: 'srvpgm', lib: s.lib, name: s.name });
  // Resolución de importaciones (los módulos de un BNDDIR sólo se enlazan si resuelven algo)
  const modules = [...o.modules];
  const pending = [...modules];
  const unresolved = [];
  while (pending.length) {
    const m = pending.shift();
    for (const imp of importsOf(m.ir)) {
      if (symbols.has(imp)) continue;
      const dm = bdModules.find((x) => !modules.includes(x) && exportsOf(x.ir).includes(imp));
      if (dm) {
        modules.push(dm);
        pending.push(dm);
        for (const e of exportsOf(dm.ir)) if (!symbols.has(e)) symbols.set(e, { kind: 'module', name: dm.name });
        continue;
      }
      unresolved.push({ sym: imp, module: m.name });
    }
  }
  if (unresolved.length) {
    for (const u of unresolved) logJob(ctx.job, 'CPD5D02', '*DIAG', `Definition for symbol ${u.sym} not found (referenced in module ${u.module}).`, { sev: 30 });
    throw new CLError('CPF5D04', o.self.name, o.self.lib);
  }
  const usedSrv = srvs.filter((s) => [...symbols.values()].some((v) => v.kind === 'srvpgm' && v.lib === s.lib && v.name === s.name));
  return {
    modules,
    bind: [
      ...modules.map((m) => ({ kind: 'module', name: m.name, lib: m.lib })),
      ...usedSrv.map((s) => ({ kind: 'srvpgm', lib: s.lib, name: s.name, signature: s.data.signature, sigs: s.data.signatures || [s.data.signature] })),
    ],
  };
}

// ---------- Ejecución ----------
/**
 * Resuelve un símbolo para una llamada desde `prog` (RpgProgram). Devuelve {prog, proc} o null.
 * makeProgram(ir, name) crea un RpgProgram con su host.
 */
export async function resolveBound(ctx, prog, symbol, makeProgram) {
  const sym = up(symbol);
  const bind = (prog.ir && prog.ir.$bind) || [];
  const job = ctx.job;
  // Módulos del mismo programa (o del mismo programa de servicio)
  if (prog.$unit) {
    for (const [name, inst] of prog.$unit.modules) {
      if (inst === prog) continue;
      const p = Object.values(inst.ir.procs).find((x) => x.export && up(x.name) === sym);
      if (p) { if (!inst.activated) await inst.activate(); return { prog: inst, proc: p, name }; }
    }
  }
  for (const b of bind) {
    if (b.kind !== 'srvpgm') continue;
    const act = await activateSrvpgm(ctx, b, makeProgram);
    const target = act.exports.get(sym);
    if (target) {
      if (!target.prog.activated) await target.prog.activate();
      return target;
    }
  }
  void job;
  return null;
}

/** Activación de un programa de servicio en el trabajo (una sola vez; el almacenamiento estático persiste). */
export async function activateSrvpgm(ctx, b, makeProgram) {
  const job = ctx.job;
  job.srvpgms = job.srvpgms || new Map();
  const key = `${b.lib}/${b.name}`;
  let act = job.srvpgms.get(key);
  if (act) return act;
  const data = await objectData(gw, b.lib, b.name, '*SRVPGM');
  if (!data) throw new CLError('CPF4101', `Service program ${b.name} in library ${b.lib} not found.`);
  const sigs = data.signatures || [data.signature];
  if (b.signature && !sigs.includes(b.signature)) {
    const e = new CLError('MCH4431', `Program signature violation: service program ${b.lib}/${b.name} no longer exports the signature the program was bound with. Re-create the program (CRTPGM/UPDPGM).`);
    e.msgId = 'MCH4431';
    throw e;
  }
  act = { lib: b.lib, name: b.name, modules: new Map(), exports: new Map() };
  const unit = { modules: act.modules };
  for (const m of data.modules) {
    const ir = JSON.parse(JSON.stringify(m.ir));
    ir.$bind = data.bind || [];
    const p = makeProgram(ir, b.name);
    p.$unit = unit;
    act.modules.set(m.name, p);
  }
  for (const sym of data.exports) {
    for (const [, p] of act.modules) {
      const proc = Object.values(p.ir.procs).find((x) => x.export && up(x.name) === up(sym));
      if (proc) { act.exports.set(up(sym), { prog: p, proc }); break; }
    }
  }
  job.srvpgms.set(key, act);
  logJob(job, '', '*INFO', `Service program ${b.lib}/${b.name} activated.`);
  return act;
}
