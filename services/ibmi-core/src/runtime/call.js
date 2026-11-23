// CALL de programas *PGM (RPG o CL): activaciones, host de E/S y mensajes de programa.
import { RpgProgram, RpgError, RpgCancel } from '../../../../shared/rpg/interpreter.js';
import { DiskFile } from '../../../../shared/rpg/diskfile.js';
import { gw, findObject, objectData, describeFile, createSpool, sendToQueue } from '../objects.js';
import { CLError, msgText } from '../messages.js';
import { setStatus, logJob, qualifiedJob, sysDate, sysTime } from '../system.js';
import { Panel } from '../panel.js';
import { displayFormat } from './dspf.js';
import { runCl } from './clrun.js';
import { callSystemProc, systemProgram } from './sysapi.js';
import { resolveBound } from './ile.js';
import { enterCall, leaveCall, overrideFor } from './overrides.js';

const programCache = new Map(); // `${lib}/${name}` -> {changed, data}

export async function loadProgram(ctx, name, lib) {
  const o = await findObject(gw, name, '*PGM', lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(lib), ctx.libl);
  if (!o) throw new CLError('CPF9811', name, lib || '*LIBL');
  const key = `${o.LIB}/${name}`;
  const c = programCache.get(key);
  if (c && c.changed === String(o.CHANGED)) { const { checkAuthority } = await import('../security.js'); await checkAuthority(ctx, o, 'EXECUTE'); return { o, data: c.data, key }; }
  const data = await objectData(gw, o.LIB, name, '*PGM');
  if (!data) throw new CLError('CPF9811', name, o.LIB);
  { const { checkAuthority } = await import('../security.js'); await checkAuthority(ctx, o, 'EXECUTE'); }
  programCache.set(key, { changed: String(o.CHANGED), data });
  return { o, data, key };
}

/** Llama a un programa. refs: [{get(), set(v)}] por referencia. Devuelve mensajes de programa. */
export async function callProgram(ctx, name, lib, refs = []) {
  if (name === 'QCMD') {
    const { commandEntry } = await import('../screens/misc.js');
    await commandEntry(ctx);
    return [];
  }
  // APIs del sistema (QSNDDTAQ, QRCVDTAQ, QCMDEXC, QSYS2…): programas *PGM de QSYS implementados en el núcleo.
  const api = systemProgram(name);
  if (api && (!lib || lib === '*LIBL' || lib === 'QSYS')) {
    await api(ctx, refs);
    return [];
  }
  const { o, data, key } = await loadProgram(ctx, name, lib);
  const job = ctx.job;
  const prevFn = job.function;
  setStatus(job, 'RUN', `PGM-${name}`);
  ctx.pgmMsgs = [];
  enterCall(job);
  const depth = job.callDepth || 0;
  let normal = false;
  try {
    if (data.kind === 'CL') {
      await runCl(ctx, name, data.ir, refs);
    } else {
      await runRpg(ctx, { ...o, $modules: data.modules || [], $entry: data.entmod }, name, key, data.ir, refs);
    }
    normal = true;
  } finally {
    // El control de compromiso que inició el propio programa (SET OPTION COMMIT / CRTSQLRPGI COMMIT) termina
    // con él, como al finalizar su grupo de activación: confirmación si acaba con normalidad, retrotracción si no
    if (job.cmt && job.cmt.auto && job.cmt.autoDepth === depth) await ctx.endCommit({ commit: normal }).catch(() => { job.cmt = null; });
    job.function = prevFn;
    // Las alteraciones (OVRDBF/OVRPRTF) del nivel de llamada del programa terminan con él
    leaveCall(job);
  }
  return ctx.pgmMsgs;
}

// OVRDBF POSITION(*END|*START): posición inicial del archivo abierto
function withPosition(desc, f) {
  const pos = desc.override && desc.override.position ? String(desc.override.position).toUpperCase() : '';
  if (pos.startsWith('*END')) { f.lower = { none: true }; f.upper = { all: true }; f.idx = Infinity; }
  return f;
}

function makeHost(ctx, pgmName) {
  const job = ctx.job;
  const debugStmt = async (stmt, sc, interp) => {
    if (!job.debug || !stmt || stmt.line === undefined) return;
    const D = await import('../debug.js');
    await D.onStatement(ctx, null, pgmName, stmt.line, D.rpgApi(interp, sc));
  };
  const client = `${qualifiedJob(job)}:${pgmName || ''}`;
  const printers = [];
  const host = {
    debugStmt,
    user: job.user,
    // OVRDBF FILE(n) TOFILE(lib/arch): el programa abre el archivo alterado
    describeFile: (n) => {
      const ov = overrideFor(job, 'DB', String(n).replace(/^.*\//, ''));
      let target = ov && ov.tofile && ov.tofile !== '*FILE' ? ov.tofile : n;
      // EXTFILE('QTEMP/x') u OVRDBF TOFILE(QTEMP/x): la QTEMP del trabajo
      if (/^(\*LIBL\/)?QTEMP\//i.test(String(target))) target = `${ctx.resolveLib('QTEMP')}/${String(target).replace(/^.*\//, '')}`;
      return describeFile(gw, target, ctx.libl).then(async (d) => {
        // Abrir el archivo exige *OBJOPR; leer, *READ (las grabaciones se comprueban en cada operación)
        const { checkAuthority, objectRow } = await import('../security.js');
        const row = await objectRow(d.lib || d.schema, d.table || String(target).replace(/^.*\//, '').toUpperCase(), '*FILE');
        if (row) await checkAuthority(ctx, row, ['*OBJOPR']);
        return ov ? { ...d, override: ov } : d;
      }).catch((e) => {
        if (['CPF9802', 'CPF9820'].includes(e.msgId)) throw new RpgError('01216', 'RNX1216', `Error message ${e.msgId} appeared during OPEN for file ${String(n).replace(/^.*\//, '')}: ${e.message}`);
        throw new RpgError('01011', 'RNX1011', `Undefined record type or file ${n} not found: ${e.message}`);
      });
    },
    openDisk: (desc) => withPosition(desc, new DiskFile({
      name: desc.table, schema: desc.schema, table: desc.table, fields: desc.fields, keys: desc.keys, keyDesc: desc.keyDesc, rrn: desc.rrn,
      sql: async (t, p) => {
        const verb = (/^\s*(SELECT|INSERT|UPDATE|DELETE)/i.exec(t) || [])[1];
        const need = { SELECT: 'READ', INSERT: 'ADD', UPDATE: 'UPD', DELETE: 'DLT' }[String(verb).toUpperCase()];
        desc.$auth = desc.$auth || {};
        if (need && !desc.$auth[need]) {
          const { checkAuthority, objectRow } = await import('../security.js');
          const row = await objectRow(desc.schema, desc.table, '*FILE');
          if (row) { try { await checkAuthority(ctx, row, need, { library: false }); } catch (e) { throw new RpgError('01218', 'RNX1218', e.message); } }
          desc.$auth[need] = true;
        }
        await ctx.ensureCommit(); return gw.sql(t, p, { client, tx: job.cmt?.tx });
      },
    })),
    // SET OPTION COMMIT / COMMIT / ROLLBACK (SQL) y COMMIT / ROLBK (RPG)
    async sqlControl(verb, o = {}) {
      try {
        if (verb === 'OPTION') {
          if (o.commit && o.commit !== '*NONE' && !job.cmt) { await ctx.startCommit(o.commit); job.cmt.auto = true; job.cmt.autoDepth = job.callDepth || 0; }
          return null;
        }
        const r = verb === 'COMMIT' ? await ctx.commit(o) : await ctx.rollback(o);
        return r && r.error ? r : null;
      } catch (e) { return { error: e.message, sqlstate: e.sqlstate || '2D521', sqlcode: e.sqlcode ?? -751 }; }
    },
    callProc: (n, args, places) => callSystemProc(ctx, n, args, places),
    // ILE: símbolos de otros módulos del programa y de los programas de servicio enlazados
    resolveBound: (sym, prog) => resolveBound(ctx, prog, sym, (ir, nm) => new RpgProgram(ir, makeHost(ctx, nm))),
    // Archivo de impresora descrito externamente (CRTPRTF); null si no existe o no tiene DDS
    async describePrinter(n) {
      const ovp = overrideFor(job, 'PRT', String(n).replace(/^.*\//, ''));
      if (ovp && ovp.tofile) n = ovp.tofile;
      const [lib, nm] = n.includes('/') ? n.split('/') : ['*LIBL', n];
      const fo = await findObject(gw, nm, '*FILE', lib, ctx.libl);
      const d = fo ? await objectData(gw, fo.LIB, nm, '*FILE') : null;
      return d && d.kind === 'PRTF' ? d : null;
    },
    async describeDisplay(n) {
      const [lib, nm] = n.includes('/') ? n.split('/') : ['*LIBL', n];
      const fo = await findObject(gw, nm, '*FILE', lib, ctx.libl);
      const d = fo ? await objectData(gw, fo.LIB, nm, '*FILE') : null;
      if (!d || d.kind !== 'DSPF') throw new RpgError('01011', 'RNX1011', `Display file ${n} not found.`);
      host.dspfs = host.dspfs || {};
      host.dspfs[nm] = d;
      return d;
    },
    async display(file, fmt, values, ind, mode, sfl) {
      if (!ctx.session) throw new RpgError('01281', 'RNX1281', 'Display file I/O is not allowed in a batch job.');
      return displayFormat(ctx, file, host.dspfs[file], fmt, values, ind, mode, sfl);
    },
    async dsply(text, wantReply, len) {
      logJob(job, '', '*INFO', `DSPLY  ${text}`);
      if (!ctx.session) {
        await sendToQueue('QSYSOPR', `DSPLY  ${text}`, { from: job.user, fromJob: qualifiedJob(job) });
        return '';
      }
      return programMessages(ctx, `DSPLY  ${text}`, wantReply, len);
    },
    sql: (t, p) => ctx.sql(t, p),
    callProgram: async (n, r) => {
      try { await callProgram(ctx, n, '*LIBL', r); } catch (e) {
        // Un *ESCAPE enviado a la entrada anterior de la pila (QMHSNDPM '*' 1) termina este programa y llega a su llamador
        if (e instanceof CLError && e.escapeToCaller) { e.escapeToCaller = false; throw e; }
        if (e instanceof CLError) throw new RpgError('00211', 'RNX0211', `Error calling program ${n}: ${e.message}`);
        throw e;
      }
    },
    openPrinter(name, len, { pageLen } = {}) {
      // OVRPRTF: cola de salida, nombre del archivo en spool, datos de usuario, retención y longitud de página
      const ov = overrideFor(job, 'PRT', name) || {};
      if (ov.pagelen) pageLen = ov.pagelen;
      const lines = [];
      const h = {
        write: (line) => lines.push(String(line).slice(0, len).replace(/\s+$/, '')),
        close: async () => {
          if (!lines.length) return;
          const data = lines.splice(0);
          for (let c = 0; c < (ov.copies || 1); c++) await createSpool(job, ov.splfname || name, data, { usrdta: ov.usrdta || pgmName, pageLen, outq: ov.outq, hold: ov.hold });
        },
      };
      printers.push(h);
      return h;
    },
    flushPrinters: async () => { for (const h of printers) await h.close(); },
    checkCancel() { if (job.cancel) { job.cancel = false; throw new RpgCancel(); } },
  };
  return host;
}

async function runRpg(ctx, o, name, key, ir, refs) {
  const job = ctx.job;
  // CRTSQLRPGI COMMIT(*CHG|*CS|…): el programa trabaja bajo control de compromiso, como con SET OPTION COMMIT
  if (ir.$commit && !job.cmt) { await ctx.startCommit(ir.$commit === '*UR' ? '*CHG' : ir.$commit === '*RS' ? '*ALL' : ir.$commit); job.cmt.auto = true; job.cmt.autoDepth = job.callDepth || 0; }
  let entry = job.activations.get(key);
  let prog;
  if (entry) prog = entry;
  else {
    prog = new RpgProgram(JSON.parse(JSON.stringify(ir)), makeHost(ctx, name));
    // Programa ILE con varios módulos (CRTPGM): cada módulo tiene su propio almacenamiento estático
    if (o && o.$modules && o.$modules.length) {
      const unit = { modules: new Map([[o.$entry || name, prog]]) };
      prog.$unit = unit;
      for (const m of o.$modules) {
        const mir = JSON.parse(JSON.stringify(m.ir));
        mir.$bind = ir.$bind || [];
        const mp = new RpgProgram(mir, makeHost(ctx, name));
        mp.$unit = unit;
        unit.modules.set(m.name, mp);
      }
    }
  }
  try {
    const r = await prog.call(refs);
    await prog.host.flushPrinters();
    if (r.lr) job.activations.delete(key); else job.activations.set(key, prog);
  } catch (e) {
    job.activations.delete(key);
    await prog.host.flushPrinters().catch(() => {});
    if (e instanceof RpgCancel || e.cancel || e.signoff || e.disconnected) throw e;
    if (e instanceof CLError) throw e;
    const status = e instanceof RpgError ? e.status : '09999';
    const rnx = e instanceof RpgError ? e.msgId : 'RNX9999';
    const stmt = String(prog.line || 0).padStart(10, '0');
    if (!(e instanceof RpgError)) console.error('[rpg]', e);
    logJob(job, rnx, '*ESCAPE', e.message, { sev: 50 });
    const rnq = rnx.replace(/^RN[XF]/, 'RNQ');
    const inquiry = `${e.message.replace(/\.$/, '')} (C G D F).`;
    logJob(job, rnq, '*INQ', inquiry, { sev: 99 });
    let reply = 'C';
    if (ctx.session) reply = (await programMessages(ctx, inquiry, true, 1, 'C')).trim().toUpperCase() || 'C';
    else await sendToQueue('QSYSOPR', `${rnq} ${inquiry} Job ${qualifiedJob(job)}. Default reply D taken.`, { msgid: rnq, type: '*INQ', sev: 99, from: job.user, fromJob: qualifiedJob(job) });
    if (reply === 'D' || reply === 'F') {
      const dump = [`ILE RPG FORMATTED DUMP`, `Program . . . . . . . :   ${name}`, `Status  . . . . . . . :   ${status}`, `Statement . . . . . . :   ${stmt}`, `Message . . . . . . . :   ${e.message}`, '', 'Indicators:'];
      dump.push(Object.entries(prog.ind).filter(([, v]) => v === '1').map(([k]) => `*IN${k}`).join(' ') || '  (none on)');
      dump.push('', 'Global variables:');
      for (const [n, v] of prog.globals.vars) if (v.kind === 's') dump.push(`  ${n.padEnd(12)} ${JSON.stringify(v.value).slice(0, 100)}`);
      await createSpool(job, 'QPPGMDMP', dump, { usrdta: name }).catch(() => {});
    }
    const err = new CLError('CEE9901', `${rnx}`, name, stmt);
    err.message = `Application error. ${rnx} unmonitored by ${name} at statement ${stmt}, instruction X'0000'.`;
    throw err;
  }
}

/** Pantalla "Display Program Messages" (DSPLY y mensajes de consulta). */
export async function programMessages(ctx, text, wantReply, len = 52, dft = '') {
  const s = ctx.session;
  s.extMsgs = s.extMsgs || [];
  if (!s.extMsgs.length) {
    const d = new Date(ctx.job.startedAt);
    s.extMsgs.push(msgText('CPF1124', ctx.job.number, ctx.job.user, ctx.job.name, sysDate(d), sysTime(d), 'QINTER').replace(/ Job entered system.*$/, ''));
  }
  s.extMsgs.push(text);
  const p = new Panel({ fn: ctx.job.function, keys: ['F3', 'F12'] });
  p.center(1, 'Display Program Messages', 'w');
  const lines = [];
  for (const m of s.extMsgs) {
    let cur = '';
    for (const w of m.split(' ')) { if ((cur + ' ' + w).length > 78) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w; }
    lines.push(cur);
  }
  lines.slice(-14).forEach((l, i) => p.text(3 + i, 2, l, 'g'));
  if (wantReply) {
    p.text(19, 2, 'Type reply, press Enter.', 'b');
    p.text(20, 4, 'Reply . . .', 'g');
    p.input('REPLY', 20, 17, Math.min(Math.max(len, 1), 60), { value: dft, lower: true });
  } else {
    p.text(20, 2, 'Press Enter to continue.', 'b');
  }
  p.fkeys('F3=Exit   F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid === 'F3' || r.aid === 'F12') {
    if (!wantReply) { s.extMsgs = []; throw new RpgCancel(); }
  }
  if (wantReply) s.extMsgs.push(`  Reply: ${(r.fields.REPLY || '').trim()}`);
  return wantReply ? (r.fields.REPLY || '') : '';
}

export function clearProgramMessages(session) { if (session) session.extMsgs = []; }
export { RpgCancel };
