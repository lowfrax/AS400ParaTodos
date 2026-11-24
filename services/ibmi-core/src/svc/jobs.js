// Trabajos de servidor (QZRCSRVS, QZDASOINIT, QTFTPxxxxx, QZHBHTTP…) que ejecutan mandatos, programas y SQL
// en nombre de un usuario conectado por la red, con su lista de bibliotecas y anotaciones de trabajo.
import { createJob, endJob, qualifiedJob, allJobs } from '../system.js';
import { Ctx } from '../ctx.js';
import { getUser, sysval, libExists } from '../objects.js';
import { CLError } from '../messages.js';

/** Crea un trabajo y su contexto para un perfil (fila USRPRF o nombre). */
export async function serverCtx(prfOrName, { name = 'QZRCSRVS', subsystem = 'QUSRWRK', type = 'PJ', fn = '', curlib } = {}) {
  const prf = typeof prfOrName === 'string' ? await getUser(prfOrName.toUpperCase()) : prfOrName;
  if (!prf) throw new CLError('CPF2204', String(prfOrName));
  const job = createJob({ name: name.slice(0, 10), user: prf.NAME, type, subsystem, fn, status: 'RUN' });
  job.libl = String((await sysval('QUSRLIBL').catch(() => null)) || 'QGPL QTEMP').split(/\s+/).filter(Boolean);
  const cl = curlib || prf.CURLIB;
  job.curlib = cl && cl !== '*CRTDFT' && cl !== '*NONE' && (await libExists(cl).catch(() => false)) ? cl : null;
  job.cwd = `/home/${prf.NAME}`;
  job.server = true;
  return new Ctx({ job, user: prf, interactive: false });
}

export function endServerCtx(ctx, normal = true) {
  if (ctx?.job) endJob(ctx.job, normal ? 0 : 20);
}

// Trabajos preiniciados reutilizables por (servicio, usuario): evitan crear un trabajo por petición HTTP.
const pool = new Map();
export async function pooledCtx(kind, prf, opts = {}) {
  const key = `${kind}:${prf.NAME}`;
  const p = pool.get(key);
  // Cada petición se autentica de nuevo: el trabajo reutilizado toma el perfil actual (clase, grupo, autorizaciones especiales)
  if (p && allJobs().includes(p.ctx.job)) { p.used = Date.now(); p.ctx.user = prf; return p.ctx; }
  const ctx = await serverCtx(prf, { name: kind, ...opts });
  pool.set(key, { ctx, used: Date.now() });
  return ctx;
}
setInterval(() => {
  for (const [k, p] of pool) if (Date.now() - p.used > 5 * 60 * 1000 && !p.ctx.busy) { endServerCtx(p.ctx); pool.delete(k); }
}, 30000).unref();

/** Ejecuta un mandato CL. Devuelve {ok, messages, error?} sin lanzar. */
export async function runCmd(ctx, text) {
  const { runCommand } = await import('../commands/registry.js');
  const mark = ctx.job.joblog.length;
  ctx.busy = true;
  try {
    const out = await runCommand(ctx, text, { noAutoPrompt: true });
    return { ok: true, messages: out.map((m) => ({ id: m.id || '', text: m.text, sev: m.sev || 0 })), joblog: ctx.job.joblog.slice(mark) };
  } catch (e) {
    return { ok: false, error: { id: e.msgId || 'CPF9898', text: e.message, sev: e.sev || 40 }, messages: [], joblog: ctx.job.joblog.slice(mark) };
  } finally {
    ctx.busy = false;
  }
}

// ---------- Llamada a programas con parámetros tipados ----------
/** Describe los parámetros de entrada de un programa: [{name, type:{t,len,dec}, io:'in'|'both'}]. */
export async function describeProgram(ctx, name, lib = '*LIBL') {
  const { SYSTEM_PROGRAM_PARAMS } = await import('../runtime/sysapi.js');
  const sys = SYSTEM_PROGRAM_PARAMS[String(name).toUpperCase()];
  if (sys && (!lib || lib === '*LIBL' || String(lib).toUpperCase() === 'QSYS')) return { lib: 'QSYS', name: String(name).toUpperCase(), kind: 'API', text: 'System API', params: sys };
  const { loadProgram } = await import('../runtime/call.js');
  const { o, data } = await loadProgram(ctx, name.toUpperCase(), lib);
  if (data.kind === 'CL') {
    const dcls = new Map(data.ir.dcls.map((d) => [d.name, d]));
    const params = data.ir.parms.map((p) => {
      const d = dcls.get(p) || {};
      const t = d.type === '*DEC' ? { t: 'packed', digits: d.len || 15, dec: d.dec || 0 } : d.type === '*INT' ? { t: 'int', bits: 32 } : d.type === '*LGL' ? { t: 'ind' } : { t: 'char', len: d.len || 32 };
      return { name: p.replace(/^&/, ''), type: t, io: 'both' };
    });
    return { lib: o.LIB, name: o.NAME, kind: 'CL', text: o.TEXT, params };
  }
  const pi = data.ir.pi;
  const resolve = (t) => {
    if (t.t === 'like' || t.t === 'likeds' || t.t === 'likerec') {
      const d = (data.ir.decls || []).find((x) => x.name === t.name);
      return d && d.type ? resolve(d.type) : { t: 'char', len: 256 };
    }
    return t;
  };
  const params = (pi?.params || []).map((p) => ({ name: p.name, type: resolve(p.type), io: p.const || p.value ? 'in' : 'both', dim: p.dim || 0 }));
  return { lib: o.LIB, name: o.NAME, kind: 'RPG', text: o.TEXT, params };
}

/**
 * Llama a un programa con valores (por posición o por nombre). Devuelve {outputs:{NAME:valor}, values:[…], messages}.
 * Los valores de salida se devuelven ya recortados (char sin blancos finales).
 */
export async function callPgm(ctx, name, lib, values = [], desc = null) {
  const { callProgram } = await import('../runtime/call.js');
  const d = desc || (await describeProgram(ctx, name, lib).catch(() => ({ params: [] })));
  const list = Array.isArray(values) ? values : d.params.map((p) => values[p.name] ?? values[p.name.toLowerCase()]);
  const n = Math.max(list.length, d.params.length);
  const cells = [];
  for (let i = 0; i < n; i++) {
    const p = d.params[i];
    let v = list[i];
    if (v === undefined || v === null) v = p && isNum(p.type) ? 0 : '';
    if (p && isNum(p.type) && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) v = Number(v);
    cells.push(v);
  }
  const refs = cells.map((v, i) => ({ get: () => cells[i], set: (x) => { cells[i] = x; } }));
  ctx.busy = true;
  try {
    const msgs = await callProgram(ctx, name.toUpperCase(), lib || '*LIBL', refs);
    const outputs = {};
    d.params.forEach((p, i) => { outputs[p.name] = clean(cells[i]); });
    return { ok: true, outputs, values: cells.map(clean), messages: (msgs || []).map((m) => ({ id: m.id || '', text: m.text })), params: d.params, job: qualifiedJob(ctx.job) };
  } finally {
    ctx.busy = false;
  }
}

const isNum = (t) => t && ['packed', 'zoned', 'int', 'uns', 'float', 'bindec'].includes(t.t);
const clean = (v) => (typeof v === 'string' ? v.replace(/\s+$/, '') : v);
