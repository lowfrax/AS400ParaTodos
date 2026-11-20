// STRSQL: SQL interactivo con la pantalla "Enter SQL Statements" y "Display Data".
import { Panel, padR, padL } from '../panel.js';
import { SYS } from '../system.js';
import { viewText } from './common.js';
import { wrapText } from '../session.js';

export async function strsql(ctx) {
  const s = ctx.session;
  s.sqlHistory = s.sqlHistory || [{ t: `    Current connection is to relational database ${SYS.name}.`, a: 'g' }];
  let message = null;
  let input = ['', '', '', ''];
  let retIdx = null;
  for (;;) {
    const p = new Panel({ fn: 'CMD-STRSQL', keys: ['F3', 'F4', 'F6', 'F9', 'F10', 'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F21', 'F24', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Enter SQL Statements');
    p.text(3, 2, 'Type SQL statement, press Enter.', 'b');
    const hist = s.sqlHistory.slice(-12);
    hist.forEach((h, i) => p.text(4 + i, 2, h.t.slice(0, 79), h.a));
    p.text(16, 2, '===>', 'g');
    for (let i = 0; i < 4; i++) p.input(`L${i}`, 16 + i, 7, 74, { value: input[i] || '', lower: true });
    p.more(20, false);
    p.fkeys('F3=Exit   F4=Prompt   F6=Insert line   F9=Retrieve   F10=Copy line', 'F12=Cancel            F13=Services     F24=More keys');
    if (message) p.msg(message);
    message = null;
    p.cursor = [16, 7];
    const r = await ctx.display(p);
    input = [0, 1, 2, 3].map((i) => r.fields[`L${i}`] || '');
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'F9') {
      const stmts = s.sqlHistory.filter((h) => h.stmt);
      if (stmts.length) {
        retIdx = retIdx === null ? stmts.length - 1 : (retIdx - 1 + stmts.length) % stmts.length;
        const text = stmts[retIdx].stmt;
        input = [0, 1, 2, 3].map((i) => text.slice(i * 74, (i + 1) * 74));
      }
      continue;
    }
    if (r.aid === 'F4' || r.aid === 'F13') { message = 'Prompting and services are not available. Type the SQL statement directly.'; continue; }
    if (r.aid !== 'ENTER') continue;
    retIdx = null;
    const stmt = input.map((l) => l.replace(/\s+$/, '')).join(' ').trim().replace(/;\s*$/, '');
    if (!stmt) continue;
    wrapText(stmt, 75).forEach((l, i) => s.sqlHistory.push({ t: `${i === 0 ? ' > ' : '   '}${l}`, a: 'g', stmt: i === 0 ? stmt : undefined }));
    const res = await ctx.sql(stmt);
    if (res.error) {
      const m = `${res.error}`.replace(/\s+/g, ' ');
      wrapText(m, 75).forEach((l) => s.sqlHistory.push({ t: `   ${l}`, a: 'w' }));
      message = { id: `SQL${String(Math.abs(res.sqlcode || 0)).padStart(4, '0')}`, text: m.slice(0, 78), sev: 30 };
      continue;
    }
    input = ['', '', '', ''];
    if (res.columns && res.columns.length) {
      s.sqlHistory.push({ t: '   SELECT statement run complete.', a: 'g' });
      await displayData(ctx, res);
      continue;
    }
    const verb = stmt.split(/\s+/)[0].toUpperCase();
    const obj = (stmt.match(/\b(?:INTO|UPDATE|FROM|TABLE|VIEW|INDEX|SCHEMA)\s+([\w#@$.]+)/i) || [])[1] || '';
    const [lib, name] = obj.includes('.') ? obj.toUpperCase().split('.') : [ctx.curlib, obj.toUpperCase()];
    let text;
    switch (verb) {
      case 'INSERT': text = `${res.rowCount} rows inserted in ${name} in ${lib}.`; break;
      case 'UPDATE': text = `${res.rowCount} rows updated in ${name} in ${lib}.`; break;
      case 'DELETE': text = `${res.rowCount} rows deleted from ${name} in ${lib}.`; break;
      case 'CREATE': text = `${/SCHEMA/i.test(stmt) ? `Schema ${name || lib}` : `${/VIEW/i.test(stmt) ? 'View' : /INDEX/i.test(stmt) ? 'Index' : 'Table'} ${name} in ${lib}`} created.`; break;
      case 'DROP': text = `${name} in ${lib} dropped.`; break;
      default: text = `${verb} statement complete.`;
    }
    s.sqlHistory.push({ t: `   ${text}`, a: 'g' });
    if (verb === 'CREATE' || verb === 'DROP') {
      const { syncSqlTables } = await import('../objects.js');
      if (lib) await syncSqlTables(lib).catch(() => {});
    }
    message = { text };
  }
}

async function displayData(ctx, res) {
  const cols = res.columns.map((c, i) => {
    const vals = res.rows.map((r) => fmtVal(r[i]));
    const numeric = res.rows.length && res.rows.every((r) => r[i] === null || typeof r[i] === 'number');
    const w = Math.min(60, Math.max(c.name.length, ...vals.map((v) => v.length), 1));
    return { name: c.name, w, numeric, i };
  });
  const head = cols.map((c) => (c.numeric ? padL(c.name, c.w) : padR(c.name, c.w))).join('  ');
  const lines = res.rows.map((r) => cols.map((c) => {
    const v = fmtVal(r[c.i]);
    return c.numeric ? padL(v, c.w) : padR(v, c.w);
  }).join('  '));
  lines.push('********  End of data  ********');
  const width = Math.max(head.length, ...lines.map((l) => l.length));
  let top = 0;
  let left = 0;
  let message = null;
  for (;;) {
    const p = new Panel({ fn: 'CMD-STRSQL', keys: ['F3', 'F12', 'F19', 'F20', 'F21', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Display Data');
    p.label(2, 47, 'Data width', 24); p.text(2, 71, ':', 'g'); p.text(2, 73, padL(width, 7), 'w');
    p.label(3, 2, 'Position to line', 28); p.input('POS', 3, 30, 5, {});
    p.label(3, 43, 'Shift to column', 28); p.input('SHIFT', 3, 72, 3, {});
    const ruler = '....+....1....+....2....+....3....+....4....+....5....+....6....+....7....+....8....+....9....+....0';
    p.text(4, 2, (ruler + ruler + ruler).slice(left, left + 78), 'w');
    p.text(5, 2, head.slice(left, left + 78), 'w');
    const page = 15;
    lines.slice(top, top + page).forEach((l, i) => p.text(6 + i, 2, l.slice(left, left + 78), 'g'));
    p.more(21, top + page < lines.length);
    p.fkeys('F3=Exit      F12=Cancel      F19=Left      F20=Right      F21=Split');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12' || (r.aid === 'ENTER' && !r.fields.POS.trim() && !r.fields.SHIFT.trim())) return;
    if (r.aid === 'PAGEDOWN') { if (top + page < lines.length) top += page; else message = 'You have reached the bottom of the list.'; }
    if (r.aid === 'PAGEUP') { if (top > 0) top = Math.max(0, top - page); else message = 'You have reached the top of the list.'; }
    if (r.aid === 'F19') left = Math.max(0, left - 40);
    if (r.aid === 'F20') left = Math.min(Math.max(0, width - 40), left + 40);
    if (r.fields.POS.trim()) top = Math.max(0, Math.min(lines.length - 1, Number(r.fields.POS) - 1 || 0));
    if (r.fields.SHIFT.trim()) left = Math.max(0, Number(r.fields.SHIFT) - 1 || 0);
  }
}

function fmtVal(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(8)).replace(/^0\./, '.').replace(/^-0\./, '-.');
  return String(v).replace(/\s+$/, '');
}

export { viewText };
