// Mandatos de usuario: CRTCMD (fuente de definición de mandato CMD/PARM/QUAL/ELEM), DLTCMD, CHGCMD, DSPCMD.
// Un *CMD se resuelve por la lista de bibliotecas (QSYS va antes: los mandatos del sistema tienen preferencia salvo
// que se cualifique BIB/MANDATO), se solicita con F4 como los del sistema y llama a su programa de proceso (CPP).
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { parseCommand, splitList, unquote } from '../../../../shared/cl.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const up = (s) => String(s ?? '').trim().toUpperCase();

// ---------- Compilación del fuente ----------
/** Sentencias del fuente CL de definición (continuación + y -, comentarios). */
function statements(lines) {
  const out = [];
  let cur = '';
  let first = 0;
  lines.forEach((raw, i) => {
    let l = String(raw).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+$/, '');
    if (!cur) first = i + 1;
    if (/[+-]$/.test(l)) { cur += `${l.slice(0, -1)}${l.endsWith('-') ? '' : ' '}`; return; }
    cur += l;
    if (cur.trim()) out.push({ text: cur.trim(), line: first });
    cur = '';
  });
  if (cur.trim()) out.push({ text: cur.trim(), line: first });
  return out;
}

const listVals = (v) => (v === undefined ? [] : splitList(v).map((x) => unquote(x)));
function parseLen(v) {
  const parts = listVals(v).map(Number);
  return { len: parts[0] || 0, dec: parts[1] || 0 };
}

/** Compila el fuente de definición. Devuelve { prompt, params:[…] } o lanza errores CPD02xx con línea. */
export function compileCmdSource(lines) {
  const sts = statements(lines);
  const labels = new Map();
  const parms = [];
  let prompt = '';
  let lastGroup = null;
  const errors = [];
  for (const st of sts) {
    let p;
    try { p = parseCommand(st.text); } catch (e) { errors.push({ line: st.line, text: e.message }); continue; }
    const k = (n) => p.params[n];
    if (p.name === 'CMD') { prompt = unquote(k('PROMPT') || p.positional[0] || ''); continue; }
    const def0 = {
      line: st.line, kwd: up(unquote(k('KWD') || '')), type: up(unquote(k('TYPE') || p.positional[1] || '*CHAR')), ...parseLen(k('LEN')),
      dft: k('DFT') !== undefined ? unquote(k('DFT')) : undefined, rstd: up(k('RSTD')) === '*YES', values: listVals(k('VALUES')).map(up),
      spcval: listVals(k('SPCVAL')).map((x) => splitList(x.replace(/^\(|\)$/g, '')).map((y) => unquote(y))), sngval: listVals(k('SNGVAL')).map((x) => splitList(x.replace(/^\(|\)$/g, '')).map((y) => unquote(y))),
      min: k('MIN') !== undefined ? Number(unquote(k('MIN'))) : 0, max: k('MAX') !== undefined ? Number(unquote(k('MAX'))) : 1,
      prompt: unquote(k('PROMPT') || ''), choice: unquote(k('CHOICE') || ''), mixed: up(k('CASE')) === '*MIXED', constant: k('CONSTANT') !== undefined ? unquote(k('CONSTANT')) : undefined,
    };
    if (p.name === 'PARM') {
      lastGroup = null;
      if (!def0.kwd) { errors.push({ line: st.line, text: 'CPD0204 KWD parameter required for PARM statement.' }); continue; }
      parms.push(def0);
    } else if (p.name === 'QUAL' || p.name === 'ELEM') {
      // Las sentencias sin etiqueta continúan el grupo QUAL/ELEM de la última etiqueta
      if (!p.label && !lastGroup) { errors.push({ line: st.line, text: `CPD0222 ${p.name} statement must have a label.` }); continue; }
      const l = p.label ? up(p.label) : lastGroup;
      lastGroup = l;
      if (!labels.has(l)) labels.set(l, { kind: p.name, parts: [] });
      labels.get(l).parts.push(def0);
    } else if (['DEP', 'PMTCTL'].includes(p.name)) {
      /* dependencias y control de solicitud: se aceptan */
    } else errors.push({ line: st.line, text: `CPD0043 Statement ${p.name} not valid in command definition source.` });
  }
  const params = [];
  for (const d of parms) {
    const lab = labels.get(d.type);
    if (!lab && !/^\*/.test(d.type)) { errors.push({ line: d.line, text: `CPD0211 Label ${d.type} specified for TYPE of ${d.kwd} not found.` }); continue; }
    if (lab && lab.kind === 'QUAL') {
      const [n, l] = lab.parts;
      params.push({ ...d, kind: 'qual', parts: lab.parts, libDft: l ? (l.dft || '*LIBL') : '*LIBL', nameLen: n.len || 10 });
    } else if (lab && lab.kind === 'ELEM') params.push({ ...d, kind: 'elem', parts: lab.parts });
    else params.push({ ...d, kind: 'simple' });
    if (d.type === '*DEC' && !d.len) d.len = 15;
    if (/^\*(CHAR|NAME|SNAME|CNAME|GENERIC|PNAME|X|HEX)$/.test(d.type) && !d.len) d.len = /NAME|GENERIC/.test(d.type) ? 10 : 32;
  }
  if (errors.length) { const e = new CLError('CPF0201', 'definition', '*LIBL'); e.diag = errors; throw e; }
  return { prompt, params };
}

/** Definición del registro de mandatos a partir de la definición compilada. */
function registryParams(d) {
  return d.params.filter((p) => p.constant === undefined).map((p) => {
    const choices = p.choice || [...p.spcval.map((s) => s[0]), ...p.sngval.map((s) => s[0]), ...p.values].join(', ') || undefined;
    const base = { req: p.min > 0, dft: p.dft !== undefined ? p.dft : undefined, choices, lc: p.mixed };
    if (p.kind === 'qual') return P(p.kwd, p.prompt || p.kwd, 'qual', p.nameLen, { ...base, lib: p.libDft });
    if (p.max > 1 || p.kind === 'elem') return P(p.kwd, p.prompt || p.kwd, 'list', Math.max(32, (p.len || 10) * Math.min(p.max, 6)), { ...base, lc: true });
    if (/^\*(DEC|INT2|INT4|UINT2|UINT4)$/.test(p.type)) return P(p.kwd, p.prompt || p.kwd, 'int', p.len || 15, base);
    if (/^\*(NAME|SNAME|CNAME|GENERIC)$/.test(p.type)) return P(p.kwd, p.prompt || p.kwd, 'name', p.len, base);
    return P(p.kwd, p.prompt || p.kwd, p.mixed ? 'text' : 'char', p.len || 32, base);
  });
}

// ---------- Ejecución ----------
function valueFor(p, raw) {
  const spc = (v) => { const s = p.spcval.find((x) => up(x[0]) === up(v)) || p.sngval.find((x) => up(x[0]) === up(v)); return s ? (s[1] !== undefined ? s[1] : s[0]) : v; };
  const padTo = (v, n) => String(v ?? '').padEnd(n).slice(0, n);
  if (p.kind === 'qual') {
    const q = raw && typeof raw === 'object' ? raw : { obj: up(raw), lib: p.libDft };
    return padTo(spc(q.obj), p.nameLen) + padTo(q.lib === '*LIBL' && p.libDft !== '*LIBL' ? p.libDft : q.lib, 10);
  }
  const conv = (v) => {
    v = spc(v);
    if (/^\*(DEC|INT2|INT4|UINT2|UINT4)$/.test(p.type)) { const n = Number(v); if (Number.isNaN(n)) throw new CLError('CPD0074', String(v), p.kwd); return n; }
    if (p.type === '*LGL') { const s = up(v); return s === '*YES' || s === '1' || s === "'1'" ? '1' : '0'; }
    const s = String(v ?? '');
    return padTo(p.mixed ? s : s.toUpperCase(), p.len || 32);
  };
  if (p.max > 1 || p.kind === 'elem') {
    // Lista: número de elementos en binario de 2 bytes seguido de los elementos, como recibe un CPP de IBM i
    const items = [].concat(raw ?? []).filter((x) => x !== '' && x !== undefined);
    if (items.length > p.max && p.max > 1) throw new CLError('CPD0084', p.kwd);
    const els = items.map((x) => { const c = conv(x); return typeof c === 'number' ? String(c).padStart(p.len || 15, '0') : c; });
    return String.fromCharCode(items.length >> 8, items.length & 255) + els.join('');
  }
  return conv(raw);
}

async function runUserCommand(ctx, d, o, args) {
  const refs = d.params.map((p) => {
    const raw = p.constant !== undefined ? p.constant : args[p.kwd];
    if (p.rstd && p.values.length && raw !== undefined && raw !== '' && typeof raw === 'string') {
      const ok = p.values.includes(up(raw)) || p.spcval.some((s) => up(s[0]) === up(raw)) || p.sngval.some((s) => up(s[0]) === up(raw));
      if (!ok) throw new CLError('CPD0074', raw, p.kwd);
    }
    const v = valueFor(p, raw === undefined ? p.dft ?? '' : raw);
    return { get: () => v, set: () => {} };
  });
  const { callProgram } = await import('../runtime/call.js');
  if (d.vldckr) {
    try { await callProgram(ctx, d.vldckr.name, d.vldckr.lib, refs); } catch (e) { throw new CLError('CPF0006', `${e.msgId ? `${e.msgId} ` : ''}${e.message}`); }
  }
  const msgs = await callProgram(ctx, d.pgm.name, d.pgm.lib, refs);
  return (msgs || []).filter((m) => m && m.text);
}

/** Mandato de usuario para runCommand: null si no hay *CMD con ese nombre en la biblioteca o la lista. */
export async function resolveUserCommand(ctx, name, lib) {
  const o = await obj.findObject(gw, up(name), '*CMD', !lib || lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(lib), ctx.libl);
  if (!o) return null;
  const d = await obj.objectData(gw, o.LIB, o.NAME, '*CMD');
  if (!d) return null;
  const { checkAuthority } = await import('../security.js');
  await checkAuthority(ctx, o, ['*OBJOPR', '*EXECUTE']);
  return { name: o.NAME, title: d.prompt || o.TEXT || o.NAME, params: registryParams(d), userCmd: true, run: (c, a) => runUserCommand(c, d, o, a) };
}

// ---------- Mandatos ----------
const q2 = (ctx, q, dftLib = '*LIBL') => ({ name: up(q.obj), lib: !q.lib || q.lib === '*LIBL' ? dftLib : ctx.resolveLib(q.lib) });

def('CRTCMD', 'Create Command', [
  P('CMD', 'Command', 'qual', 10, { req: true, lib: '*CURLIB' }),
  P('PGM', 'Program to process command', 'qual', 10, { req: true, choices: 'Name, *REXX' }),
  P('SRCFILE', 'Source file', 'qual', 10, { dft: 'QCMDSRC' }),
  P('SRCMBR', 'Source member', 'name', 10, { dft: '*CMD' }),
  P('TEXT', "Text 'description'", 'text', 50, { dft: '*SRCMBRTXT' }),
  P('VLDCKR', 'Validity checking program', 'qual', 10, { dft: '*NONE' }),
  P('MODE', 'Mode in which valid', 'list', 40, { dft: '*ALL' }),
  P('ALLOW', 'Where allowed to run', 'list', 60, { dft: '*ALL' }),
  P('THDSAFE', 'Threadsafe', 'name', 8, { dft: '*NO' }),
  P('REPLACE', 'Replace command', 'char', 4, { dft: '*YES', choices: '*YES, *NO' }),
], async (ctx, a) => {
  const lib = ctx.resolveLib(a.CMD.lib === '*LIBL' ? '*CURLIB' : a.CMD.lib);
  const name = up(a.CMD.obj);
  if (!(await obj.libExists(lib))) throw new CLError('CPF2110', lib);
  const mbr = a.SRCMBR === '*CMD' ? name : up(a.SRCMBR);
  const m = await obj.findMember(gw, a.SRCFILE.lib === '*LIBL' ? null : ctx.resolveLib(a.SRCFILE.lib), up(a.SRCFILE.obj), mbr, ctx.libl);
  if (!m) throw new CLError('CPF9815', mbr, up(a.SRCFILE.obj), a.SRCFILE.lib);
  const lines = (await obj.readMember(gw, m.LIB, up(a.SRCFILE.obj), mbr)).map((l) => l.text);
  let d;
  try { d = compileCmdSource(lines); } catch (e) {
    const { createSpool } = await import('../objects.js');
    const listing = ['5770SS1 V7R5M0  Command Definition', `Command . . . :   ${lib}/${name}`, '', ...lines.map((l, i) => `${String(i + 1).padStart(6)}  ${l}`), '', ...(e.diag || []).map((x) => `* ${x.text} (line ${x.line})`)];
    await createSpool(ctx.job, name, listing, { usrdta: mbr });
    const { logJob } = await import('../system.js');
    for (const x of e.diag || []) logJob(ctx.job, (/^(CPD\d{4})/.exec(x.text) || [])[1] || 'CPD0201', '*DIAG', `${x.text} (line ${x.line})`, { sev: 30 });
    throw new CLError('CPF0201', name, lib);
  }
  if (await obj.findObject(gw, name, '*CMD', lib, [])) {
    if (a.REPLACE === '*NO') throw new CLError('CPF2112', name, lib, '*CMD');
    await obj.deleteObject(lib, name, '*CMD');
  }
  const pgm = q2(ctx, a.PGM);
  const vld = a.VLDCKR && a.VLDCKR.obj && a.VLDCKR.obj !== '*NONE' ? q2(ctx, a.VLDCKR) : null;
  const text = a.TEXT === '*SRCMBRTXT' ? m.TEXT || d.prompt : a.TEXT === '*BLANK' ? '' : a.TEXT;
  await obj.putObject(lib, name, '*CMD', '', text, { ...d, pgm, vldckr: vld, srcfile: `${m.LIB}/${up(a.SRCFILE.obj)}(${mbr})`, allow: a.ALLOW }, ctx.job.user);
  return [{ id: 'CPC0202', text: `Command ${name} created in library ${lib}.`, sev: 0 }];
});

def('DLTCMD', 'Delete Command', [P('CMD', 'Command', 'qual', 10, { req: true })], async (ctx, a) => {
  const o = await obj.findObject(gw, up(a.CMD.obj), '*CMD', a.CMD.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.CMD.lib), ctx.libl);
  if (!o) throw new CLError('CPF2105', up(a.CMD.obj), a.CMD.lib, '*CMD');
  await obj.deleteObject(o.LIB, o.NAME, '*CMD');
  return [{ id: 'CPC2191', text: `Object ${o.NAME} in ${o.LIB} type *CMD deleted.`, sev: 0 }];
});

def('CHGCMD', 'Change Command', [P('CMD', 'Command', 'qual', 10, { req: true }), P('PGM', 'Program to process command', 'qual', 10, { dft: '*SAME' }), P('VLDCKR', 'Validity checking program', 'qual', 10, { dft: '*SAME' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*SAME' })], async (ctx, a) => {
  const o = await obj.findObject(gw, up(a.CMD.obj), '*CMD', a.CMD.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.CMD.lib), ctx.libl);
  if (!o) throw new CLError('CPF2105', up(a.CMD.obj), a.CMD.lib, '*CMD');
  const d = await obj.objectData(gw, o.LIB, o.NAME, '*CMD');
  if (a.PGM && a.PGM.obj && a.PGM.obj !== '*SAME') d.pgm = q2(ctx, a.PGM);
  if (a.VLDCKR && a.VLDCKR.obj && a.VLDCKR.obj !== '*SAME') d.vldckr = a.VLDCKR.obj === '*NONE' ? null : q2(ctx, a.VLDCKR);
  await obj.putObject(o.LIB, o.NAME, '*CMD', '', a.TEXT === '*SAME' ? o.TEXT : a.TEXT, d, o.OWNER);
  return [{ id: 'CPC6201', text: `Command ${o.NAME} in library ${o.LIB} changed.`, sev: 0 }];
});

def('DSPCMD', 'Display Command', [P('CMD', 'Command', 'qual', 10, { req: true })], async (ctx, a) => {
  const o = await obj.findObject(gw, up(a.CMD.obj), '*CMD', a.CMD.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.CMD.lib), ctx.libl);
  if (!o) throw new CLError('CPF2105', up(a.CMD.obj), a.CMD.lib, '*CMD');
  const d = await obj.objectData(gw, o.LIB, o.NAME, '*CMD');
  return { text: [`Command  . . . . . . . . . . . :   ${o.NAME}`, `  Library  . . . . . . . . . . :     ${o.LIB}`, `Program to process command . . :   ${d.pgm.name}`, `  Library  . . . . . . . . . . :     ${d.pgm.lib}`,
    `Source file  . . . . . . . . . :   ${d.srcfile || ''}`, `Validity checker . . . . . . . :   ${d.vldckr ? `${d.vldckr.lib}/${d.vldckr.name}` : '*NONE'}`, `Prompt text  . . . . . . . . . :   ${d.prompt || ''}`,
    `Number of parameters . . . . . :   ${d.params.length}`, ...d.params.map((p) => `  ${p.kwd.padEnd(10)} ${p.type.padEnd(8)} ${String(p.len || '').padStart(5)}${p.dec ? ` ${p.dec}` : ''}  MIN(${p.min}) MAX(${p.max})${p.dft !== undefined ? ` DFT(${p.dft})` : ''}  ${p.prompt}`)].join('\n') };
});
