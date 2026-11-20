// Registro de mandatos CL, análisis de parámetros, prompter (F4) y ejecución.
import { parseCommand, splitList, unquote, qualified, quote, CLSyntaxError } from '../../../../shared/cl.js';
import { CLError, msgText, msg } from '../messages.js';
import { Panel, dots } from '../panel.js';
import { logJob } from '../system.js';

export const COMMANDS = new Map();

/**
 * Parámetro: {kw, prompt, type: name|qual|text|char|int|cmd|list|sql, len, dft, req, choices, lib (lib por omisión de qual), lc}
 */
export function def(name, title, params, run, opts = {}) {
  COMMANDS.set(name, { name, title, params, run, ...opts });
}

// Nombres IBM i, valores especiales (*LIBL, *CURLIB…, y '*' solo = trabajo actual) y genéricos (ABC*).
const NAME_RE = /^([A-Z#@$][A-Z0-9_#@$.]{0,9}|\*[A-Z0-9]*|[A-Z#@$][A-Z0-9_#@$]{0,9}\*)$/;

function normalize(p, raw) {
  if (raw === undefined || raw === null) return undefined;
  let v = String(raw).trim();
  switch (p.type) {
    case 'name': {
      v = unquote(v).toUpperCase();
      if (v && !NAME_RE.test(v)) throw new CLError('CPD0078', v, p.kw);
      return v;
    }
    case 'qual': {
      const q = qualified(v, p.lib || '*LIBL');
      if (q.obj && !NAME_RE.test(q.obj)) throw new CLError('CPD0078', q.obj, p.kw);
      return q;
    }
    case 'int': {
      const n = Number(unquote(v));
      if (Number.isNaN(n)) {
        if (/^\*/.test(v)) return v.toUpperCase();
        throw new CLError('CPD0074', v, p.kw);
      }
      return n;
    }
    case 'list': return splitList(v).map((x) => (p.lc ? unquote(x) : unquote(x).toUpperCase()));
    case 'cmd': case 'sql': return unquote(v);
    case 'text': return unquote(v);
    default: return p.lc ? unquote(v) : unquote(v).toUpperCase();
  }
}

export function dftValue(p) {
  if (p.dft === undefined) return undefined;
  return normalize(p, p.dft);
}

/** Convierte un mandato analizado a {args, given} validando palabras clave. */
export function bindArgs(cmd, parsed) {
  const given = {};
  const posParams = cmd.params.filter((p) => p.pos !== false);
  if (parsed.positional.length > posParams.length) throw new CLError('CPD0084', cmd.name);
  parsed.positional.forEach((v, i) => { given[posParams[i].kw] = v; });
  for (const [kw, v] of Object.entries(parsed.params)) {
    if (!cmd.params.find((p) => p.kw === kw)) throw new CLError('CPD0043', kw);
    given[kw] = v;
  }
  return given;
}

export function finalize(cmd, given) {
  const args = {};
  const missing = [];
  for (const p of cmd.params) {
    const raw = given[p.kw];
    if (raw === undefined || raw === '') {
      if (p.req) missing.push(p.kw);
      args[p.kw] = dftValue(p);
    } else args[p.kw] = normalize(p, raw);
    if (p.values && args[p.kw] !== undefined && typeof args[p.kw] === 'string' && !p.values.includes(args[p.kw])) {
      throw new CLError('CPD0074', args[p.kw], p.kw);
    }
  }
  return { args, missing };
}

export function rebuild(cmd, given) {
  const parts = [cmd.name];
  for (const p of cmd.params) {
    const v = given[p.kw];
    if (v === undefined || v === '' || (p.dft !== undefined && String(v).toUpperCase() === String(p.dft).toUpperCase())) continue;
    let s = String(v).trim();
    if ((p.type === 'text' || p.type === 'cmd' || p.type === 'sql' || /\s/.test(s)) && !s.startsWith("'") && p.type !== 'list' && !(p.type === 'cmd' && /^\w+$/.test(s))) s = quote(s);
    parts.push(`${p.kw}(${s})`);
  }
  return parts.join(' ');
}

// ---------- Prompter (F4) ----------
export async function promptCommand(ctx, cmd, given = {}, marked = new Set(Object.keys(given))) {
  const vals = {};
  for (const p of cmd.params) {
    const g = given[p.kw];
    if (p.type === 'qual') {
      const q = g !== undefined ? qualified(g, p.lib || '*LIBL') : qualified(p.dft || '', p.lib || '*LIBL');
      vals[p.kw] = q.obj;
      vals[`${p.kw}$LIB`] = g !== undefined || p.dft ? q.lib : (p.lib || '*LIBL');
    } else vals[p.kw] = g !== undefined ? unquote(g) : (p.dft !== undefined ? unquote(p.dft) : '');
  }
  let page = 0;
  let message = null;
  for (;;) {
    const panel = new Panel({ fn: `CMD-${cmd.name}`, keys: ['F3', 'F4', 'F5', 'F12', 'F9', 'F10', 'F11', 'F13', 'F24', 'PAGEUP', 'PAGEDOWN'] });
    panel.center(1, `${cmd.title} (${cmd.name})`, 'w');
    panel.text(3, 2, 'Type choices, press Enter.', 'b');
    // Distribución de parámetros en páginas
    const layout = [];
    let row = 5;
    let pg = 0;
    for (const p of cmd.params) {
      const len = Math.min(p.promptLen || p.len || 10, 512);
      const h = p.type === 'qual' ? 2 : Math.ceil((36 + len) / 80);
      if (row + h > 20) { pg++; row = 5; }
      layout.push({ p, pg, row, len });
      row += h;
    }
    const pages = pg + 1;
    if (page >= pages) page = pages - 1;
    for (const { p, pg: lp, row: r, len } of layout) {
      if (lp !== page) continue;
      panel.text(r, 2, dots(p.prompt, 32, 1), 'g');
      if (marked.has(p.kw)) panel.text(r, 35, '>', 'w');
      panel.input(p.kw, r, 37, len, { value: vals[p.kw], lower: p.type === 'text' || p.type === 'cmd' || p.type === 'sql' || p.lc });
      if (p.type === 'qual') {
        panel.text(r + 1, 4, dots('Library', 30, 3), 'g');
        panel.input(`${p.kw}$LIB`, r + 1, 39, 10, { value: vals[`${p.kw}$LIB`] });
        panel.text(r + 1, 51, p.libChoices || 'Name, *LIBL, *CURLIB', 'g');
      }
      const ch = p.choices || (p.type === 'name' || p.type === 'qual' ? 'Name' : p.type === 'int' ? 'Number' : '');
      const cc = Math.max(51, 37 + len + 2);
      if (ch && cc <= 70) panel.text(r, cc, ch.slice(0, 80 - cc), 'g');
    }
    panel.more(20, page < pages - 1);
    panel.fkeys('F3=Exit   F4=Prompt   F5=Refresh   F12=Cancel   F13=How to use this display', 'F24=More keys');
    if (message) panel.msg(message);
    message = null;
    const r = await ctx.display(panel);
    for (const f of panel.fields) vals[f.n] = f.v;
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'F5') continue;
    if (r.aid === 'PAGEDOWN') { if (page < pages - 1) page++; else message = 'You have reached the bottom of the list.'; continue; }
    if (r.aid === 'PAGEUP') { if (page > 0) page--; else message = 'You have reached the top of the list.'; continue; }
    if (r.aid !== 'ENTER') continue;
    const out = {};
    for (const p of cmd.params) {
      let v = String(vals[p.kw] ?? '').trim();
      if (p.type === 'qual') {
        const lib = String(vals[`${p.kw}$LIB`] || '').trim();
        if (v) v = lib && lib !== (p.lib || '*LIBL') ? `${lib}/${v}` : (lib === (p.lib || '*LIBL') ? v : `${lib}/${v}`);
      }
      if (v !== '' && !(p.dft !== undefined && v.toUpperCase() === String(p.dft).toUpperCase() && !marked.has(p.kw))) {
        if (['text', 'cmd', 'sql'].includes(p.type) && !/^'.*'$/s.test(v) && !(p.type === 'text' && v.startsWith('*'))) v = quote(v);
        out[p.kw] = v;
      }
    }
    const missing = cmd.params.filter((p) => p.req && !out[p.kw]);
    if (missing.length) { message = { id: 'CPD0072', text: msgText('CPD0072', missing[0].kw), sev: 30 }; continue; }
    return out;
  }
}

// ---------- Ejecución ----------
/**
 * Ejecuta una cadena de mandato. Devuelve la lista de mensajes de terminación.
 * opts.prompt: forzar prompter; opts.log: registrar en la anotación del trabajo.
 */
export async function runCommand(ctx, text, opts = {}) {
  let src = String(text || '').trim();
  if (!src) return [];
  let forcePrompt = !!opts.prompt;
  if (src.startsWith('?')) { forcePrompt = true; src = src.slice(1).trim(); }
  let parsed;
  try { parsed = parseCommand(src); } catch (e) {
    if (e instanceof CLSyntaxError) throw new CLError(e.msgId, e.message);
    throw e;
  }
  const cmd = COMMANDS.get(parsed.name);
  if (!cmd) throw new CLError('CPD0030', parsed.name, parsed.lib || '*LIBL');
  if (cmd.interactive && !ctx.interactive) throw new CLError('CPD0031', cmd.name);
  let given = bindArgs(cmd, parsed);
  let { missing } = finalize(cmd, given);
  if ((forcePrompt || (missing.length && ctx.interactive && !opts.noAutoPrompt)) && cmd.params.length) {
    const g = await promptCommand(ctx, cmd, given);
    if (!g) return [];
    given = g;
  } else if (missing.length) {
    if (ctx.job) logJob(ctx.job, 'CPD0072', '*DIAG', msgText('CPD0072', missing[0]), { sev: 30 });
    throw new CLError('CPD0072', missing[0]);
  }
  const fin = finalize(cmd, given);
  if (fin.missing.length) throw new CLError('CPD0072', fin.missing[0]);
  const full = rebuild(cmd, given);
  if (ctx.job && opts.log !== false) logJob(ctx.job, '', '*RQS', full);
  if (ctx.job && !String(ctx.job.function).startsWith('PGM-')) ctx.job.function = `CMD-${cmd.name}`;
  if (opts.onRebuild) opts.onRebuild(full);
  const out = (await cmd.run(ctx, fin.args, { text: full, parsed, given })) || [];
  const list = Array.isArray(out) ? out : [out];
  if (ctx.job) for (const m of list) if (m && m.text) logJob(ctx.job, m.id || '', '*COMP', m.text, { sev: m.sev || 0 });
  return list.filter(Boolean);
}

export { msg };
