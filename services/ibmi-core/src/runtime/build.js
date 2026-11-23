// Compilación de objetos (a través del servicio compilador) y envío de trabajos por lotes.
import { postJson } from '../../../../shared/http.js';
import { gw, readMember, findMember, putObject, createSpool, findObject, sendToQueue, deleteObject } from '../objects.js';
import { CLError, msg, msgText } from '../messages.js';
import { createJob, endJob, logJob, setStatus, qualifiedJob, sysDate, sysTime } from '../system.js';
import { invalidateTables } from '../ctx.js';
import { refreshMW } from '../mw.js';
import { bindModules, importsOf } from './ile.js';

// Nombres cualificados de una lista (LIB/NOMBRE o NOMBRE)
export const qualList = (v) => (Array.isArray(v) ? v : String(v || '').split(/\s+/)).map((x) => String(x).replace(/[()']/g, '').trim()).filter((x) => x && x !== '*NONE')
  .map((x) => { const [l, n] = x.includes('/') ? x.split('/') : [null, x]; return { lib: l && l !== '*LIBL' ? l.toUpperCase() : null, name: n.toUpperCase() }; });

const COMPILER = process.env.COMPILER_URL || 'http://localhost:5251';

const SRC_FOR = { RPGLE: 'QRPGLESRC', SQLRPGLE: 'QRPGLESRC', RPG: 'QRPGSRC', RPG38: 'QRPGSRC', RPG36: 'QS36SRC', CLLE: 'QCLLESRC', CLP: 'QCLSRC', PF: 'QDDSSRC', LF: 'QDDSSRC', DSPF: 'QDDSSRC', PRTF: 'QDDSSRC' };
export const COMPILE_CMD = { RPGLE: 'CRTBNDRPG', SQLRPGLE: 'CRTSQLRPGI', RPG: 'CRTRPGPGM', RPG38: 'CRTRPGPGM', RPG36: 'CRTRPGPGM', CLLE: 'CRTBNDCL', CLP: 'CRTCLPGM', PF: 'CRTPF', LF: 'CRTLF', DSPF: 'CRTDSPF', PRTF: 'CRTPRTF', CMD: 'CRTCMD' };

/**
 * Compila un miembro fuente y crea el objeto.
 * o = {type, obj:{lib,obj}, srcfile:{lib,obj}, srcmbr, text, replace}
 */
export async function compileObject(ctx, o) {
  const objLib = ctx.resolveLib(o.obj.lib === '*LIBL' ? '*CURLIB' : o.obj.lib);
  const name = o.obj.obj;
  const srcfile = o.srcfile.obj || SRC_FOR[o.type] || 'QRPGLESRC';
  const mbrName = !o.srcmbr || o.srcmbr === '*PGM' || o.srcmbr === '*FILE' || o.srcmbr === '*OBJ' || o.srcmbr === '*MODULE' ? name : o.srcmbr;
  const mi = await findMember(gw, o.srcfile.lib === '*LIBL' ? null : ctx.resolveLib(o.srcfile.lib), srcfile, mbrName, ctx.libl);
  if (!mi) throw new CLError('CPF9815', mbrName, srcfile, o.srcfile.lib);
  // CRTRPGPGM compila RPG/400 (RPG), RPG/38 y RPG II (RPG36) según el tipo del miembro
  const opm = ['RPG', 'RPG38', 'RPG36'];
  const type = (o.type === 'RPG' ? (opm.includes(String(mi.TYPE).toUpperCase()) ? mi.TYPE : 'RPG') : o.type || mi.TYPE || 'RPGLE').toUpperCase();
  const source = await readMember(gw, mi.LIB, srcfile, mbrName);
  const text = o.text && o.text !== '*SRCMBRTXT' ? o.text : mi.TEXT || '';
  // Como en IBM i, CRTPF comprueba antes de compilar si el archivo ya existe: CPF5813 (diagnóstico) + CPF7302 (escape).
  if (type === 'PF' && !o.replace && (await findObject(gw, name, '*FILE', objLib, []))) {
    logJob(ctx.job, 'CPF5813', '*DIAG', msgText('CPF5813', name, objLib), { sev: 30 });
    throw new CLError('CPF7302', name, objLib);
  }
  let r;
  try {
    r = await postJson(`${COMPILER}/compile`, {
      type, name, lib: objLib, srcfile, srclib: mi.LIB, srcmbr: mbrName, text,
      source, libl: [objLib, ...ctx.libl.filter((l) => l !== objLib)], user: ctx.job.user, job: qualifiedJob(ctx.job),
    }, 120000);
  } catch (e) {
    throw new CLError('CPF9898', `Compiler service not available: ${e.message}`);
  }
  await createSpool(ctx.job, name, r.listing.split('\n'), { usrdta: mbrName });
  for (const m of r.messages) if (m.sev >= 30) logJob(ctx.job, m.id, '*DIAG', `${m.text}${m.line ? ` (line ${m.line})` : ''}`, { sev: m.sev });
  const isFile = ['PF', 'LF', 'DSPF', 'PRTF'].includes(type);
  if (!r.ok) {
    if (isFile) throw new CLError('CPF7302', name, objLib);
    const sev = String(r.severity).padStart(2, '0');
    // Los errores RNF/CPD concretos ya quedaron como *DIAG en las anotaciones del trabajo y en el listado.
    const e = type.startsWith('CL')
      ? new CLError('CPF9898', `Program ${name} not created in library ${objLib}. Maximum error severity ${sev}.`)
      : new CLError('CPF9898', `Compilation stopped. Severity ${sev} errors found in program.`);
    e.msgId = type.startsWith('CL') ? 'CPF0815' : 'RNS9310';
    throw e;
  }
  if (type === 'PF') {
    const exists = await findObject(gw, name, '*FILE', objLib, []);
    if (exists) {
      if (!o.replace) throw new CLError('CPF7302', name, objLib);
      await deleteObject(objLib, name, '*FILE');
    }
    const res = await gw.sql(r.object.data.sql);
    if (res.error && res.sqlstate !== '42710') throw new CLError('CPF9898', `File ${name} not created: ${res.error}`);
    if (r.object.data.keys.length && !r.object.data.unique) {
      await gw.sql(`CREATE INDEX ${objLib}.${name}_K ON ${objLib}.${name} (${r.object.data.keys.map((k) => `"${k}"`).join(', ')})`);
    }
    await gw.sql(`COMMENT ON TABLE ${objLib}.${name} IS '${text.replace(/'/g, "''")}'`);
    const { sql, ...meta } = r.object.data;
    await putObject(objLib, name, '*FILE', 'PF', text || r.object.data.text, meta, ctx.job.user);
    invalidateTables(objLib);
    return [msg('CPC7301', name, objLib)];
  }
  if (type === 'LF') {
    if (await findObject(gw, name, '*FILE', objLib, [])) throw new CLError('CPF7302', name, objLib);
    const res = await gw.sql(r.object.data.sql);
    if (res.error) throw new CLError('CPF9898', `Logical file ${name} not created: ${res.error}`);
    const { sql, ...meta } = r.object.data;
    await putObject(objLib, name, '*FILE', 'LF', text || meta.text, meta, ctx.job.user);
    invalidateTables(objLib);
    return [msg('CPC7301', name, objLib)];
  }
  if (type === 'PRTF') {
    if (await findObject(gw, name, '*FILE', objLib, [])) {
      if (!o.replace) throw new CLError('CPF7302', name, objLib);
      await deleteObject(objLib, name, '*FILE');
    }
    await putObject(objLib, name, '*FILE', 'PRTF', text, { ...r.object.data, pagesize: o.pagesize || [66, 132], ovrflw: o.ovrflw || 60 }, ctx.job.user);
    return [msg('CPC7301', name, objLib)];
  }
  // ILE: CRTRPGMOD crea un *MODULE; CRTBNDRPG enlaza las importaciones del módulo (BNDDIR de CTL-OPT o del mandato)
  if (o.module && r.object.data && r.object.data.kind === 'RPG') {
    await putObject(objLib, name, '*MODULE', r.object.attr, text, { kind: 'RPG', ir: r.object.data.ir, module: true }, ctx.job.user);
    const dm = new Date();
    return [{ id: 'RNS9305', text: `Module ${name} placed in library ${objLib}. ${String(r.severity).padStart(2, '0')} highest severity. Created on ${sysDate(dm)} at ${sysTime(dm)}.`, sev: 0 }];
  }
  if (r.object.data && r.object.data.kind === 'RPG') {
    const ir = r.object.data.ir;
    if (o.commit && !['*NONE', '*NC'].includes(String(o.commit).toUpperCase())) ir.$commit = String(o.commit).toUpperCase();
    if (ir.ctl && ir.ctl.NOMAIN) {
      logJob(ctx.job, 'RNF0143', '*DIAG', `Module ${name} has no main procedure (NOMAIN); use CRTRPGMOD and CRTSRVPGM.`, { sev: 30 });
      throw new CLError('CPF5D0B', `Program entry procedure module not found; program ${name} not created in library ${objLib}.`);
    }
    const bnddir = [...qualList((ir.ctl && ir.ctl.BNDDIR) || []), ...qualList(o.bnddir || [])];
    if (importsOf(ir).length || bnddir.length) {
      const res = await bindModules(ctx, { modules: [{ name, lib: objLib, ir }], bnddir, bndsrvpgm: qualList(o.bndsrvpgm || []), self: { lib: objLib, name } });
      ir.$bind = res.bind.filter((b) => !(b.kind === 'module' && b.name === name));
      const extra = res.modules.filter((m) => m.name !== name);
      if (extra.length) { r.object.data.modules = extra.map((m) => ({ name: m.name, lib: m.lib, ir: m.ir })); r.object.data.entmod = name; }
    }
  }
  await putObject(objLib, name, r.object.type, r.object.attr, text, r.object.data, ctx.job.user);
  // Las activaciones en caché del programa anterior dejan de ser válidas.
  for (const [k] of ctx.job.activations) if (k.endsWith(`/${name}`)) ctx.job.activations.delete(k);
  if (type === 'DSPF') return [msg('CPC7301', name, objLib)];
  if (type === 'PRTF') return [msg('CPC7301', name, objLib)];
  const d = new Date();
  if (type.startsWith('CL')) return [{ id: 'CPC0904', text: `Program ${name} created in library ${objLib}.`, sev: 0 }];
  return [{ id: 'RNS9304', text: `Program ${name} placed in library ${objLib}. ${String(r.severity).padStart(2, '0')} highest severity. Created on ${sysDate(d)} at ${sysTime(d)}.`, sev: 0 }];
}

/** SBMJOB: ejecuta un mandato en un trabajo por lotes de QBATCH. */
export async function submitJob(ctx, cmdText, jobName) {
  const { Ctx } = await import('../ctx.js');
  const { runCommand } = await import('../commands/registry.js');
  const job = createJob({ name: (jobName || ctx.job.user).slice(0, 10), user: ctx.job.user, type: 'BCH', subsystem: 'QBATCH', fn: '', status: 'RUN' });
  job.libl = [...ctx.job.libl];
  job.curlib = ctx.job.curlib;
  const bctx = new Ctx({ job, user: ctx.user, interactive: false });
  const fromJob = qualifiedJob(ctx.job);
  setTimeout(async () => {
    setStatus(job, 'RUN', `CMD-${String(cmdText).trim().split(/\s|\(/)[0].toUpperCase()}`);
    let ok = true;
    let lastText = '';
    try {
      const out = await runCommand(bctx, cmdText);
      lastText = out.map((m) => m.text).join(' ');
    } catch (e) {
      ok = false;
      lastText = e.message;
      logJob(job, e.msgId || 'CPF9898', '*ESCAPE', e.message, { sev: 40 });
    }
    const d = new Date();
    const text = ok
      ? `Job ${qualifiedJob(job)} completed normally on ${sysDate(d)} at ${sysTime(d)}.`
      : `Job ${qualifiedJob(job)} ended abnormally. ${lastText}`;
    await sendToQueue(ctx.job.user, text, { msgid: ok ? 'CPC1221' : 'CPF1240', sev: ok ? 0 : 30, from: 'QSYS', fromJob });
    if (!ok) {
      await createSpool(job, 'QPJOBLOG', job.joblog.map((e) => `${(e.id || '').padEnd(8)} ${e.type.padEnd(8)} ${String(e.sev || 0).padStart(2, '0')}  ${e.text}`), { usrdta: job.name, outq: 'QEZJOBLOG' }).catch(() => {});
    }
    endJob(job, ok ? 0 : 20);
    refreshMW(ctx.job.user);
  }, 600);
  return msg('CPC1221', job.number, job.user, job.name, 'QBATCH', 'QGPL');
}

export { msgText };
