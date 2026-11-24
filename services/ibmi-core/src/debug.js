// Depurador del sistema (STRDBG / ENDDBG / DSPMODSRC / ADDBKP / RMVBKP), como el depurador ILE de IBM i:
// pantalla "Display Module Source" con la línea actual, puntos de interrupción (con condición WHEN), paso a paso
// (F10), EVAL de variables y expresiones y asignación (EVAL var = valor), para programas RPG y CL.
import { Panel, padR } from './panel.js';
import { CLError } from './messages.js';
import { gw, findObject, objectData, readMember } from './objects.js';
import { RpgCancel } from '../../../shared/rpg/interpreter.js';

const up = (s) => String(s ?? '').trim().toUpperCase();
export const dbg = (job) => job.debug || null;

/**
 * Programa preparado para depurar: { lib, name, kind, view, lines, bps: Map(sentencia → condición|null), note }.
 * Vistas de depuración como en IBM i (DBGVIEW del mandato de compilación):
 *   *STMT    solo números de sentencia (del listado de compilación): BREAK n y EVAL, sin fuente en pantalla
 *   *SOURCE  el fuente del miembro (se lee al depurar: si cambió después de compilar puede no coincidir)
 *   *COPY    como *SOURCE (los /COPY se muestran en el miembro que los contiene)
 *   *LIST    el listado guardado dentro del programa al compilar (no depende del miembro)
 *   *ALL     listado y fuente
 *   *NONE    sin datos de depuración: no se puede depurar
 */
export async function debugProgram(ctx, name, lib) {
  const o = await findObject(gw, up(name), '*PGM', !lib || lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(lib), ctx.libl);
  if (!o) throw new CLError('CPF9811', up(name), lib || '*LIBL');
  const d = await objectData(gw, o.LIB, o.NAME, '*PGM');
  if (!d) throw new CLError('CPF9811', up(name), o.LIB);
  const view = up((d.src && d.src.dbgview) || '*STMT');
  if (view === '*NONE') throw new CLError('CPF9898', `Program ${o.NAME} in ${o.LIB} has no debug data; compile it with DBGVIEW(*STMT), *SOURCE, *LIST or *ALL.`);
  let lines = null;
  let note = null;
  if ((view === '*LIST' || view === '*ALL') && d.src && Array.isArray(d.src.listing)) {
    lines = d.src.listing;
    note = 'Listing view.';
  } else if (['*SOURCE', '*COPY', '*ALL', '*LIST'].includes(view)) {
    if (d.src) lines = (await readMember(gw, d.src.lib, d.src.file, d.src.mbr).catch(() => [])).map((l) => l.text);
    if (!lines || !lines.length) throw new CLError('CPF9898', `Source for program ${o.NAME} not available: member ${d.src ? `${d.src.lib}/${d.src.file}(${d.src.mbr})` : ''} not found. Compile with DBGVIEW(*LIST) to keep the listing in the program.`);
    // El miembro cambió después de compilar: la vista del fuente puede no coincidir con el programa
    if (d.src && d.src.compiled) {
      const m = await gw.rows('SELECT CHANGED FROM QSYS.MEMBERS WHERE LIB = ? AND SRCF = ? AND MBR = ?', [d.src.lib, d.src.file, d.src.mbr]).catch(() => []);
      if (m[0] && m[0].CHANGED && new Date(String(m[0].CHANGED).replace(' ', 'T')) > new Date(d.src.compiled)) note = `Source member ${d.src.mbr} changed after the program was created; the source view may not match the program.`;
    }
  }
  return { lib: o.LIB, name: o.NAME, kind: d.kind, view, lines: lines || [], stmtOnly: !lines, bps: new Map(), note };
}

/** Trabajo al que se aplican los mandatos de depuración: el servido con STRSRVJOB o el propio. */
export function targetJob(ctx) {
  const t = ctx.job.serviced;
  if (t && !t.endedAt) return t;
  return ctx.job;
}

export async function startDebug(ctx, pgms, { updprod = false } = {}) {
  const job = targetJob(ctx);
  if (job.debug) throw new CLError('CPF1999', 'Debug mode already active; use ADDPGM or ENDDBG.');
  const d = { pgms: new Map(), updprod, step: null };
  for (const p of pgms) { const dp = await debugProgram(ctx, p.name, p.lib); d.pgms.set(`${dp.lib}/${dp.name}`, dp); }
  // Trabajo servido: las paradas se muestran en la estación de trabajo que lo sirve
  if (job !== ctx.job) d.host = { session: ctx.session, job: ctx.job };
  job.debug = d;
  return d;
}

function findPgm(job, lib, name) {
  const d = dbg(job);
  if (!d) return null;
  return d.pgms.get(`${lib}/${name}`) || [...d.pgms.values()].find((p) => p.name === up(name) && (!lib || lib === '*LIBL')) || null;
}

const fmt = (v) => {
  if (v === null || v === undefined) return '*NULL';
  if (Array.isArray(v)) return v.map((x, i) => `(${i + 1}) = ${fmt(x)}`).join('  ');
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && v.fig) return v.fig;
  return `'${String(v)}'`;
};

/**
 * Gancho de cada sentencia. api = { evalExpr(text), assign(text), cond(text) } del intérprete que ejecuta.
 * Se detiene en un punto de interrupción (si se cumple su condición) o en el paso siguiente (F10 / STEP n).
 */
export async function onStatement(ctx, lib, name, line, api) {
  const d = dbg(ctx.job);
  if (!d || line === undefined || line === null) return;
  const host = d.host && d.host.session && !d.host.session.closed ? d.host : null;
  if (!host && !ctx.session) return;
  const dp = findPgm(ctx.job, lib, name);
  if (!dp) return;
  let reason = null;
  if (d.step && d.step.key === `${dp.lib}/${dp.name}`) {
    if (--d.step.count <= 0) { d.step = null; reason = `Step completed at line ${line}.`; }
  }
  if (!reason && dp.bps.has(line)) {
    const c = dp.bps.get(line);
    let ok = true;
    if (c) { try { ok = !!(await api.cond(c)); } catch { ok = true; } }
    if (ok) reason = `Breakpoint at line ${line} in program ${dp.name}.`;
  }
  if (!reason) return;
  // Trabajo servido (STRSRVJOB): la pantalla interrumpe a la estación de trabajo que lo sirve y el trabajo espera
  const ui = host ? { display: (p) => host.session.overlay(p), done: () => host.session.restoreScreen(), job: ctx.job } : null;
  await sourceScreen(ctx, dp, line, api, reason, ui);
}

/** Pantalla Display Module Source (detenido en `line`, o sin detener si line = null). */
export async function sourceScreen(ctx, dp, line, api, message, ui = null) {
  try { return await sourceLoop(ctx, dp, line, api, message, ui); } finally { if (ui) ui.done(); }
}
async function sourceLoop(ctx, dp, line, api, message, ui) {
  const d = dbg(ui ? ui.job : targetJob(ctx));
  const show = ui ? ui.display : (p) => ctx.display(p);
  const ROWS = 15;
  if (!message && dp.note) message = dp.note;
  let top = Math.max(1, (line || 1) - 6);
  let msg = message ? { text: message } : null;
  let evalLines = null;
  for (;;) {
    const p = new Panel({ fn: 'DBG-DSPMODSRC', keys: ['F3', 'F6', 'F10', 'F11', 'F12', 'F13', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Display Module Source');
    p.text(2, 2, `Program:   ${padR(dp.name, 10)}   Library:   ${padR(dp.lib, 10)}   Module:   ${dp.name}`, 'g');
    if (ui) p.text(2, 70, `Job ${ui.job.number}`, 'w');
    if (dp.stmtOnly) {
      // DBGVIEW(*STMT): no hay fuente; se trabaja con números de sentencia del listado de compilación
      p.text(4, 2, `Source is not available: program ${dp.name} was created with DBGVIEW(*STMT).`, 'g');
      p.text(5, 2, 'Use statement numbers from the compiler listing: BREAK n [WHEN expr], CLEAR n, EVAL.', 'g');
      if (line) p.text(7, 2, `> Stopped at statement ${line}.`, 'wv');
      p.text(9, 2, `Breakpoints: ${dp.bps.size ? [...dp.bps.entries()].map(([n, c]) => `${n}${c ? ` WHEN ${c}` : ''}`).join(', ') : 'none'}`.slice(0, 78), 'w');
    }
    for (let i = 0; i < ROWS && !dp.stmtOnly; i++) {
      const n = top + i;
      const t = dp.lines[n - 1];
      if (t === undefined) break;
      const cur = n === line;
      p.text(3 + i, 2, `${cur ? '>' : ' '}${String(n).padStart(5)}${dp.bps.has(n) ? '*' : ' '} ${String(t).slice(0, 70)}`, cur ? 'wv' : dp.bps.has(n) ? 'w' : 'g');
    }
    p.more(18, top + ROWS <= dp.lines.length);
    if (evalLines) evalLines.slice(0, 1).forEach((l) => p.text(19, 2, l.slice(0, 78), 'w'));
    p.text(20, 2, 'Debug . . .', 'g');
    p.input('DBG', 20, 15, 66, { lower: true });
    p.fkeys(line ? 'F3=End program   F6=Add/Clear breakpoint   F10=Step   F11=Display variable' : 'F3=Exit   F6=Add/Clear breakpoint   F11=Display variable',
      'F12=Resume       F13=Work with module breakpoints   F24=More keys');
    if (msg) p.msg(msg);
    msg = null;
    evalLines = null;
    if (line && !dp.stmtOnly) p.cursor = [3 + (line - top), 9];
    const r = await show(p);
    const cmd = String(r.fields.DBG || '').trim();
    const cursorLine = r.cursor && r.cursor[0] >= 3 && r.cursor[0] < 3 + ROWS ? top + r.cursor[0] - 3 : null;
    if (r.aid === 'F3') { if (line) { d.step = null; throw new RpgCancel(); } return 'F3'; }
    if (r.aid === 'F12') return 'F12';
    if (r.aid === 'PAGEDOWN') { if (top + ROWS <= dp.lines.length) top += ROWS; continue; }
    if (r.aid === 'PAGEUP') { top = Math.max(1, top - ROWS); continue; }
    if (r.aid === 'F10') {
      if (!line) { msg = { text: 'Step not valid: the program is not stopped.', sev: 30 }; continue; }
      d.step = { key: `${dp.lib}/${dp.name}`, count: 1 };
      return 'STEP';
    }
    if (r.aid === 'F6' && dp.stmtOnly) { msg = { text: 'No source view (DBGVIEW(*STMT)): use BREAK statement-number.', sev: 30 }; continue; }
    if (r.aid === 'F6') {
      const n = cursorLine;
      if (!n || !dp.lines[n - 1]) { msg = { text: 'Cursor not on a source line.', sev: 30 }; continue; }
      if (dp.bps.has(n)) { dp.bps.delete(n); msg = { text: `Breakpoint removed from line ${n}.` }; } else { dp.bps.set(n, null); msg = { text: `Breakpoint added to line ${n}.` }; }
      continue;
    }
    if (r.aid === 'F13') { msg = { text: dp.bps.size ? `Breakpoints: ${[...dp.bps.entries()].map(([n, c]) => `${n}${c ? ` WHEN ${c}` : ''}`).join(', ')}` : 'No breakpoints set.' }; continue; }
    if (r.aid === 'F11') {
      if (!line || !api) { msg = { text: 'Variables can be displayed only when the program is stopped.', sev: 30 }; continue; }
      const src = cursorLine ? String(dp.lines[cursorLine - 1] || '') : '';
      const col = r.cursor ? r.cursor[1] - 10 : 0;
      const m = [...src.matchAll(/&?[A-Za-z#@$][\w#@$.]*/g)].find((x) => x.index <= col && x.index + x[0].length >= col);
      if (!m) { msg = { text: 'Cursor not on a variable.', sev: 30 }; continue; }
      try { msg = { text: `${m[0].toUpperCase()} = ${fmt(await api.evalExpr(m[0]))}` }; } catch (e) { msg = { text: e.message, sev: 30 }; }
      continue;
    }
    if (!cmd) continue;
    const words = cmd.split(/\s+/);
    const verb = up(words[0]);
    try {
      if (verb === 'EVAL' || verb === 'EV') {
        if (!line || !api) throw new Error('EVAL is valid only when the program is stopped at a breakpoint.');
        const expr = cmd.slice(words[0].length).trim();
        const asg = /^([&\w#@$.()]+)\s*=(?!=)\s*([\s\S]+)$/.exec(expr);
        if (asg && !/[<>!]$/.test(asg[1])) { await api.assign(expr); msg = { text: `${asg[1].toUpperCase()} = ${fmt(await api.evalExpr(asg[1]))}` }; } else msg = { text: `${expr.toUpperCase()} = ${fmt(await api.evalExpr(expr))}` };
      } else if (verb === 'BREAK' || verb === 'BR') {
        const n = Number(words[1]);
        if (!n || (!dp.stmtOnly && !dp.lines[n - 1])) throw new Error(`${dp.stmtOnly ? 'Statement' : 'Line'} ${words[1]} not valid.`);
        const w = /\bWHEN\b\s+([\s\S]+)$/i.exec(cmd);
        dp.bps.set(n, w ? w[1] : null);
        msg = { text: `Breakpoint added to line ${n}${w ? ` (conditional: ${w[1]})` : ''}.` };
      } else if (verb === 'CLEAR') {
        if (up(words[1]) === 'PGM') { dp.bps.clear(); msg = { text: 'All breakpoints removed from the program.' }; } else { const n = Number(words[1]); dp.bps.delete(n); msg = { text: `Breakpoint removed from line ${n}.` }; }
      } else if (verb === 'STEP') {
        if (!line) throw new Error('STEP is valid only when the program is stopped.');
        d.step = { key: `${dp.lib}/${dp.name}`, count: Number(words[1]) || 1 };
        return 'STEP';
      } else if (verb === 'TOP') top = 1;
      else if (verb === 'BOTTOM') top = Math.max(1, dp.lines.length - ROWS + 1);
      else if (/^\d+$/.test(verb)) top = Math.max(1, Number(verb));
      else if (verb === 'HELP') msg = { text: 'Debug commands: EVAL, BREAK n [WHEN cond], CLEAR n|PGM, STEP [n], TOP, BOTTOM, line number.' };
      else throw new Error(`Debug command ${verb} not valid.`);
    } catch (e) { msg = { text: e.message, sev: 30 }; }
  }
}

// ---------- Acceso a variables de los intérpretes ----------
/** API de evaluación para el intérprete RPG detenido en el ámbito `sc`. */
export function rpgApi(interp, sc) {
  const parse = async (lines) => (await import('../../../shared/rpg/parser.js')).compileRpg(['**FREE', ...lines]);
  const body = (ir) => ir.main || ir.body || ir.stmts || [];
  return {
    async evalExpr(text) {
      const ir = await parse([`if ${text};`, 'endif;']);
      const cond = body(ir)[0].branches[0].cond;
      const v = await interp.ev(cond, sc);
      return v;
    },
    async cond(text) { return this.evalExpr(text).then((v) => v === true || v === '1' || v === 1); },
    async assign(text) {
      const ir = await parse([`${text};`]);
      await interp.assign(body(ir)[0], sc);
    },
  };
}

/** API para el intérprete CL (variables &X). */
export function clApi(getVar, coerce) {
  const get = (n) => { const v = getVar(String(n).replace(/^&?/, '&')); if (!v) throw new Error(`Variable ${n} not found.`); return v; };
  return {
    async evalExpr(text) { return get(text.trim()).value; },
    async cond(text) {
      const m = /^(&\w+)\s*(\*EQ|=|\*NE|<>|\*GT|>|\*LT|<|\*GE|>=|\*LE|<=)\s*(.+)$/i.exec(text.trim());
      if (!m) return true;
      const a = get(m[1]).value;
      const b = String(m[3]).replace(/^'|'$/g, '');
      const [x, y] = typeof a === 'number' ? [a, Number(b)] : [String(a).trimEnd(), b.trimEnd()];
      return ({ '*EQ': x === y, '=': x === y, '*NE': x !== y, '<>': x !== y, '*GT': x > y, '>': x > y, '*LT': x < y, '<': x < y, '*GE': x >= y, '>=': x >= y, '*LE': x <= y, '<=': x <= y })[m[2].toUpperCase()];
    },
    async assign(text) {
      const m = /^(&\w+)\s*=\s*([\s\S]+)$/.exec(text.trim());
      const v = get(m[1]);
      v.value = coerce(v, String(m[2]).trim().replace(/^'([\s\S]*)'$/, '$1'));
    },
  };
}
