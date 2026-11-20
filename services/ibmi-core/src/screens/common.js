// Componentes reutilizables de pantallas IBM i: menús, listas "Work with" y visor de texto.
import { Panel, padR } from '../panel.js';
import { SYS } from '../system.js';
import { CLError, msgText } from '../messages.js';
import { RpgCancel } from '../../../../shared/rpg/interpreter.js';

export function toMsg(e) {
  if (e instanceof CLError) return { id: e.msgId, text: e.message, sev: e.sev };
  if (e && e.msgId) return { id: e.msgId, text: e.message, sev: e.sev || 30 };
  return { id: 'CPF9899', text: e && e.message ? e.message : String(e), sev: 40 };
}

/** Ejecuta un mandato desde una línea de mandatos y devuelve el mensaje a mostrar. */
export async function execFromLine(ctx, cmdText, prompt = false) {
  const { runCommand } = await import('../commands/registry.js');
  const s = ctx.session;
  try {
    const out = await runCommand(ctx, cmdText, { prompt, onRebuild: (full) => { if (s) pushHistory(s, full); } });
    const last = out.filter((m) => m && m.text).pop();
    return last || null;
  } catch (e) {
    if (e.signoff || e.disconnected) throw e;
    if (e instanceof RpgCancel || e.cancel) return { id: 'CPF0549', text: msgText('CPF0549'), sev: 40 };
    if (s) pushHistory(s, cmdText);
    if (!(e instanceof CLError) && !e.msgId) console.error('[cmd]', e);
    return toMsg(e);
  }
}

export function pushHistory(s, text) {
  const t = String(text).trim();
  if (!t) return;
  if (s.history[s.history.length - 1] !== t) s.history.push(t);
  if (s.history.length > 50) s.history.shift();
}

// Recuperación F9 en líneas de mandatos.
export function retrieve(s, state) {
  if (!s.history.length) return null;
  state.ret = state.ret === undefined ? s.history.length - 1 : (state.ret - 1 + s.history.length) % s.history.length;
  return s.history[state.ret];
}

/**
 * Menú estándar: spec = {id, title, options:[[n, text, action]], fkeys?}
 * action: string de mandato, o función async (ctx) => mensaje
 */
export async function showMenu(ctx, spec) {
  let message = spec.message || null;
  const state = {};
  let cmdValue = '';
  for (;;) {
    const p = new Panel({ fn: `MNU-${spec.id}`, keys: ['F3', 'F4', 'F9', 'F12', 'F13', 'F16', 'F23', 'F24', 'PAGEUP', 'PAGEDOWN'] });
    p.text(1, 2, spec.id, 'b');
    p.center(1, spec.title, 'w');
    p.text(2, 62, 'System:', 'g').text(2, 72, SYS.name, 'g');
    p.text(3, 2, 'Select one of the following:', 'b');
    let row = 5;
    for (const [n, t] of spec.options) {
      if (n === null) { row++; continue; }
      p.text(row++, 7, `${String(n).padStart(2)}. ${t}`, 'g');
    }
    if (spec.bottomOptions) {
      row++;
      for (const [n, t] of spec.bottomOptions) p.text(row++, 7, `${String(n).padStart(2)}. ${t}`, 'g');
    }
    p.text(19, 2, 'Selection or command', 'g');
    p.cmdLine(20, 'CMD', 153, cmdValue);
    p.fkeys('F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel   F13=Information Assistant', spec.id === 'MAIN' ? 'F23=Set initial menu' : 'F16=IBM i Main menu');
    if (message) p.msg(message); else p.text(24, 2, '(C) COPYRIGHT IBM CORP. 1980, 2009.', 'w');
    message = null;
    cmdValue = '';
    const r = await ctx.display(p);
    const cmd = (r.fields.CMD || '').trim();
    if (r.aid === 'F3' || r.aid === 'F12') return r.aid;
    if (r.aid === 'F16') { const { goMenu } = await import('./menus.js'); const x = await goMenu(ctx, 'MAIN'); if (x === 'F3') return 'F3'; continue; }
    if (r.aid === 'F9') { cmdValue = retrieve(ctx.session, state) || ''; continue; }
    if (r.aid === 'F13' || r.aid === 'F23') { message = { text: r.aid === 'F23' ? `Initial menu set to ${spec.id}.` : 'Information Assistant is not installed on this system.', sev: 0 }; continue; }
    if (r.aid === 'F4') {
      if (!cmd) { const { selectCommand } = await import('./cmdlist.js'); message = await selectCommand(ctx); continue; }
      message = await execFromLine(ctx, cmd, true);
      continue;
    }
    if (r.aid === 'PAGEUP' || r.aid === 'PAGEDOWN') { message = 'You have reached the bottom of the list.'; continue; }
    if (!cmd) continue;
    state.ret = undefined;
    const all = [...spec.options, ...(spec.bottomOptions || [])];
    const opt = /^\d+$/.test(cmd) ? all.find((o) => o[0] === Number(cmd)) : null;
    if (/^\d+$/.test(cmd) && !opt) { message = { id: 'CPD6A01', text: `Selection ${cmd} not valid.`, sev: 30 }; cmdValue = cmd; continue; }
    if (opt) {
      const action = opt[2];
      if (!action) { message = { text: `Option ${cmd} is not available on this system.`, sev: 30 }; continue; }
      if (typeof action === 'function') { message = await action(ctx); continue; }
      message = await execFromLine(ctx, action);
      continue;
    }
    message = await execFromLine(ctx, cmd);
  }
}

/**
 * Lista "Work with ...".
 * spec: {fn, title, header(p) -> fila inicial de la cabecera de columnas, instr, opts: [líneas], colHead,
 *        optCol=2, optLen=1|2, row(item) -> texto, load(), act(sel[], ctx) -> mensaje, keys: {F6: fn},
 *        fkeys: [..], cmdLabel, dataCol, firstRow, lastRow}
 */
export async function workWith(ctx, spec) {
  let items = await spec.load();
  let top = 0;
  let message = spec.message || null;
  const optValues = new Map();
  const state = {};
  let cmdValue = '';
  const optLen = spec.optLen || 2;
  const optCol = spec.optCol || 3;
  const dataCol = spec.dataCol || 7;
  for (;;) {
    const keys = ['F3', 'F4', 'F5', 'F9', 'F12', 'F11', 'F17', 'F18', 'F23', 'F24', 'PAGEUP', 'PAGEDOWN', ...Object.keys(spec.keys || {})];
    const p = new Panel({ fn: spec.fn, keys });
    p.title(spec.title);
    if (spec.sysRight !== false) p.sysRight(1);
    let headRow = spec.header ? spec.header(p, items) : 3;
    if (spec.instr !== null) p.text(headRow, 2, spec.instr || 'Type options, press Enter.', 'b');
    (spec.opts || []).forEach((l, i) => p.text(headRow + 1 + i, 4, l, 'b'));
    headRow += 1 + (spec.opts || []).length + 1;
    if (spec.colHead2) { p.text(headRow, 2, spec.colHead2, 'w'); headRow++; }
    p.text(headRow, 2, spec.colHead, 'w');
    const first = headRow + 1;
    const last = spec.cmd === false ? 20 : 17;
    const pageSize = last - first + 1;
    if (top > Math.max(0, items.length - 1)) top = Math.max(0, items.length - pageSize);
    const visible = items.slice(top, top + pageSize);
    visible.forEach((it, i) => {
      const key = spec.key ? spec.key(it) : top + i;
      p.input(`OPT${i}`, first + i, optCol, optLen, { value: optValues.get(key) || '' });
      const row = spec.row(it);
      if (Array.isArray(row)) for (const [c, t, a] of row) p.text(first + i, c, t, a || 'g');
      else p.text(first + i, dataCol, row, spec.rowAttr ? spec.rowAttr(it) : 'g');
    });
    if (!items.length) p.text(first, dataCol, spec.empty || '(No items found)', 'g');
    p.more(Math.min(first + Math.max(visible.length, 1), last + 1), top + pageSize < items.length);
    if (spec.cmd !== false) {
      p.text(19, 2, spec.cmdLabel || 'Parameters or command', 'g');
      p.text(20, 2, '===>', 'g');
      p.input('CMD', 20, 7, 73, { value: cmdValue, lower: true });
    }
    p.fkeys(...(spec.fkeys || ['F3=Exit   F5=Refresh   F12=Cancel']));
    if (message) p.msg(message);
    message = null;
    cmdValue = '';
    if (!spec.cursorOnCmd && visible.length) p.cursor = [first, optCol];
    const r = await ctx.display(p);
    visible.forEach((it, i) => {
      const key = spec.key ? spec.key(it) : top + i;
      const v = (r.fields[`OPT${i}`] || '').trim();
      if (v) optValues.set(key, v); else optValues.delete(key);
    });
    if (r.aid === 'F3' || r.aid === 'F12') return r.aid;
    if (r.aid === 'F5') { items = await spec.load(); optValues.clear(); continue; }
    if (r.aid === 'F9') { cmdValue = retrieve(ctx.session, state) || ''; continue; }
    if (r.aid === 'PAGEDOWN') {
      if (top + pageSize < items.length) top += pageSize; else message = 'You have reached the bottom of the list.';
      continue;
    }
    if (r.aid === 'PAGEUP') {
      if (top > 0) top = Math.max(0, top - pageSize); else message = 'You have reached the top of the list.';
      continue;
    }
    if (spec.keys && spec.keys[r.aid]) {
      const res = await spec.keys[r.aid](ctx, items);
      if (res === 'exit') return r.aid;
      if (res && res.text) message = res;
      items = await spec.load();
      continue;
    }
    if (r.aid === 'F4' && r.fields.CMD && r.fields.CMD.trim()) {
      message = await execFromLine(ctx, r.fields.CMD.trim(), true);
      items = await spec.load();
      continue;
    }
    if (r.aid !== 'ENTER') continue;
    const sels = [];
    for (const it of items) {
      const key = spec.key ? spec.key(it) : items.indexOf(it);
      if (optValues.has(key)) sels.push({ opt: optValues.get(key), item: it });
    }
    if (sels.length) {
      const res = await spec.act(sels, ctx, (r.fields.CMD || '').trim());
      optValues.clear();
      if (res === 'exit') return 'ENTER';
      if (res) message = res;
      items = await spec.load();
      continue;
    }
    const cmd = (r.fields.CMD || '').trim();
    if (cmd) {
      message = await execFromLine(ctx, cmd);
      items = await spec.load();
      continue;
    }
    if (spec.enterExits) return 'ENTER';
  }
}

/**
 * Visor de texto desplazable (DSPSPLF, DSPPFM, listados…).
 * spec: {fn, title, head(p) -> fila de inicio, lines[], ruler: bool, width}
 */
export async function viewText(ctx, spec) {
  let top = 0;
  let left = 0;
  let message = null;
  const lines = spec.lines;
  for (;;) {
    const p = new Panel({ fn: spec.fn || 'CMD-DSPSPLF', keys: ['F3', 'F12', 'F19', 'F20', 'F24', 'PAGEUP', 'PAGEDOWN', 'F5'] });
    p.title(spec.title);
    let row = spec.head ? spec.head(p, { top, left, total: lines.length }) : 3;
    p.text(row, 2, 'Control . . . . .', 'g');
    p.input('CTL', row, 21, 7, {});
    p.text(row, 54, 'Columns', 'g');
    p.text(row, 66, `${left + 1} - ${left + 78}`, 'w');
    row++;
    p.text(row, 2, 'Find  . . . . . .', 'g');
    p.input('FIND', row, 21, 30, { lower: true });
    row++;
    if (spec.ruler !== false) {
      const ruler = '*...+....1....+....2....+....3....+....4....+....5....+....6....+....7....+....8....+....9....+....0';
      p.text(row, 2, (ruler + ruler.slice(1)).slice(left, left + 78), 'w');
      row++;
    }
    const pageSize = 20 - row + 1;
    for (let i = 0; i < pageSize; i++) {
      const l = lines[top + i];
      if (l === undefined) break;
      p.text(row + i, 2, l.slice(left, left + 78), spec.attr || 'g');
    }
    p.more(21, top + pageSize < lines.length);
    p.fkeys('F3=Exit   F12=Cancel   F19=Left   F20=Right   F24=More keys');
    if (message) p.msg(message);
    message = null;
    p.cursor = [spec.head ? 4 : 3, 21];
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return r.aid;
    if (r.aid === 'PAGEDOWN') { if (top + pageSize < lines.length) top += pageSize; else message = 'You have reached the bottom of the list.'; continue; }
    if (r.aid === 'PAGEUP') { if (top > 0) top = Math.max(0, top - pageSize); else message = 'You have reached the top of the list.'; continue; }
    if (r.aid === 'F19') { left = Math.max(0, left - 40); continue; }
    if (r.aid === 'F20') { left += 40; continue; }
    const ctl = (r.fields.CTL || '').trim().toUpperCase();
    const find = (r.fields.FIND || '').trim();
    if (ctl === 'T' || ctl === '*TOP') top = 0;
    else if (ctl === 'B' || ctl === '*BOT') top = Math.max(0, lines.length - pageSize);
    else if (/^[+-]\d+$/.test(ctl)) top = Math.min(Math.max(0, top + Number(ctl)), Math.max(0, lines.length - 1));
    else if (/^\d+$/.test(ctl)) top = Math.min(Math.max(0, Number(ctl) - 1), Math.max(0, lines.length - 1));
    else if (/^W\d+$/.test(ctl)) left = Math.max(0, Number(ctl.slice(1)) - 1);
    if (find) {
      const i = lines.findIndex((l, k) => k > top && l.toUpperCase().includes(find.toUpperCase()));
      if (i >= 0) top = i; else message = `String '${find}' not found.`;
    }
  }
}

/** Pantalla de confirmación de borrado estándar ("Confirm Delete of ..."). */
export async function confirmDelete(ctx, title, colHead, rows) {
  const p = new Panel({ fn: 'CMD-CONFIRM', keys: ['F11', 'F12'] });
  p.title(title);
  p.text(3, 2, 'Press Enter to confirm your choices for 4=Delete.', 'b');
  p.text(4, 2, 'Press F12=Cancel to return to change your choices.', 'b');
  p.text(6, 2, colHead, 'w');
  rows.slice(0, 13).forEach((r, i) => p.text(7 + i, 2, `  4   ${r}`, 'g'));
  p.more(20, rows.length > 13);
  p.fkeys('F11=Display names and types   F12=Cancel');
  const r = await ctx.display(p);
  return r.aid === 'ENTER';
}

export { padR, SYS };
