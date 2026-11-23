// Pantallas de Query/400: WRKQRY (Work with Queries), Define the Query y sus apartados, Exit this Query,
// Display Report; STRQRY (menú de utilidades de Query).
import { Panel, padR, padL } from '../panel.js';
import { CLError } from '../messages.js';
import { gw, findObject, objectData, putObject, describeFile, createSpool } from '../objects.js';
import { showMenu, viewText, toMsg, confirmDelete, execFromLine } from './common.js';
import * as Q from '../query.js';

const up = (s) => String(s ?? '').trim().toUpperCase();
const err = (text) => ({ text, sev: 30 });

export async function loadQuery(ctx, lib, name) {
  const o = await findObject(gw, up(name), '*QRYDFN', !lib || lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(lib), ctx.libl);
  if (!o) throw new CLError('CPF9801', up(name), lib || '*LIBL');
  const { checkAuthority } = await import('../security.js');
  await checkAuthority(ctx, o, 'USE');
  return { o, q: { ...Q.emptyQuery(), ...(await objectData(gw, o.LIB, o.NAME, '*QRYDFN')) } };
}

export async function showReport(ctx, res, qname, lib) {
  if (res.kind === 'print') return { text: `Report printed to spooled file QPQUPRFIL (${res.rows} records).` };
  if (res.kind === 'outfile') return { text: res.lines[0] };
  await viewText(ctx, {
    fn: 'QRY-DSPRPT', title: 'Display Report', lines: res.lines, ruler: false,
    head: (p) => { p.text(2, 2, `Query . . . . . :   ${padR(qname, 10)}     Report width . . . . . :   ${Math.max(...res.lines.map((l) => l.length))}`, 'g'); p.text(3, 2, `  Library . . . :     ${lib || ''}`, 'g'); return 4; },
  });
  return null;
}

// ======================= WRKQRY =======================
export async function wrkqry(ctx, { opt = '', name = '', lib = '*CURLIB' } = {}) {
  let vals = { OPT: opt, QRY: name, LIB: lib };
  let message = null;
  for (;;) {
    const p = new Panel({ fn: 'QRY-WRKQRY', keys: ['F3', 'F4', 'F5', 'F12'] });
    p.title('Work with Queries');
    p.text(3, 2, 'Type choices, press Enter.', 'b');
    p.label(5, 2, 'Option', 30); p.input('OPT', 5, 34, 2, { value: vals.OPT }); p.text(5, 44, '1=Create, 2=Change, 3=Copy, 4=Delete', 'b'); p.text(6, 44, '5=Display, 6=Print definition', 'b'); p.text(7, 44, '8=Run in batch, 9=Run', 'b');
    p.label(9, 2, 'Query', 30); p.input('QRY', 9, 34, 10, { value: vals.QRY }); p.text(9, 44, 'Name, F4 for list', 'b');
    p.label(10, 4, 'Library', 28); p.input('LIB', 10, 36, 10, { value: vals.LIB }); p.text(10, 48, 'Name, *LIBL, F4 for list', 'b');
    p.fkeys('F3=Exit   F4=Prompt   F5=Refresh   F12=Cancel');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    vals = { OPT: (r.fields.OPT || '').trim(), QRY: up(r.fields.QRY), LIB: up(r.fields.LIB) || '*CURLIB' };
    try {
      const lib = vals.LIB === '*CURLIB' ? ctx.resolveLib('*CURLIB') : vals.LIB;
      if (r.aid === 'F4') { const pick = await listQueries(ctx, lib); if (pick) { vals.QRY = pick.NAME; vals.LIB = pick.LIB; } continue; }
      if (!vals.OPT) { message = err('Type an option number.'); continue; }
      if (vals.OPT !== '1' && !vals.QRY) { message = err('Type a query name or press F4 for a list.'); continue; }
      if (vals.OPT === '1') {
        if (!vals.QRY) { const res = await defineQuery(ctx, Q.emptyQuery(), { lib, name: '' }); if (res) message = res; continue; }
        if (await findObject(gw, vals.QRY, '*QRYDFN', lib, [])) { message = err(`Query ${vals.QRY} already exists in library ${lib}.`); continue; }
        message = await defineQuery(ctx, Q.emptyQuery(), { lib, name: vals.QRY });
        continue;
      }
      const { o, q } = await loadQuery(ctx, vals.LIB, vals.QRY);
      switch (vals.OPT) {
        case '2': message = await defineQuery(ctx, q, { lib: o.LIB, name: o.NAME, text: o.TEXT, existing: true }); break;
        case '3': {
          const nn = await promptLine(ctx, 'Copy Queries', `Copy query ${o.NAME} in ${o.LIB} to new name`, 10);
          if (!nn) break;
          await putObject(o.LIB, up(nn), '*QRYDFN', 'QRY', o.TEXT, q, ctx.job.user);
          message = { text: `Query ${o.NAME} copied to ${up(nn)}.` };
          break;
        }
        case '4':
          if (await confirmDelete(ctx, 'Confirm Delete of Query', 'Opt  Query       Library', [`${padR(o.NAME, 10)}  ${o.LIB}`])) { await execFromLine(ctx, `DLTQRY QRY(${o.LIB}/${o.NAME})`); message = { text: `Query ${o.NAME} in ${o.LIB} deleted.` }; }
          break;
        case '5': await viewText(ctx, { fn: 'QRY-DSPDEF', title: 'Display Query', lines: definitionText(o, q), ruler: false }); break;
        case '6': await createSpool(ctx.job, 'QPQUDEF', definitionText(o, q), { usrdta: o.NAME }); message = { text: `Definition of query ${o.NAME} printed (QPQUDEF).` }; break;
        case '8': message = await execFromLine(ctx, `SBMJOB CMD(RUNQRY QRY(${o.LIB}/${o.NAME}) OUTTYPE(*PRINTER)) JOB(${o.NAME})`); break;
        case '9': message = await showReport(ctx, await Q.runQuery(ctx, q, { qname: o.NAME }), o.NAME, o.LIB); break;
        default: message = err(`Option ${vals.OPT} not valid.`);
      }
    } catch (e) { message = toMsg(e); }
  }
}

async function listQueries(ctx, lib) {
  const rows = await gw.rows("SELECT LIB, NAME, TEXT FROM QSYS.OBJECTS WHERE LIB = ? AND TYPE = '*QRYDFN' ORDER BY NAME", [lib]);
  const p = new Panel({ fn: 'QRY-LIST', keys: ['F12'] });
  p.title('Select Query');
  p.info(3, 2, 'Library', lib, 16);
  p.text(5, 2, 'Type option, press Enter.  1=Select', 'b');
  p.text(7, 2, 'Opt  Query       Text', 'w');
  rows.slice(0, 13).forEach((x, i) => { p.input(`O${i}`, 8 + i, 3, 1, {}); p.text(8 + i, 7, `${padR(x.NAME, 10)}  ${padR(x.TEXT, 50)}`); });
  if (!rows.length) p.text(8, 7, '(No queries in library)');
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return null;
  const i = rows.slice(0, 13).findIndex((_, k) => (r.fields[`O${k}`] || '').trim() === '1');
  return i >= 0 ? rows[i] : null;
}

async function promptLine(ctx, title, label, len, value = '') {
  const p = new Panel({ fn: 'QRY-PROMPT', keys: ['F12'] });
  p.title(title);
  p.label(5, 2, label, 44); p.input('V', 5, 48, len, { value });
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  return r.aid === 'ENTER' ? String(r.fields.V || '').trim() : null;
}

export function definitionText(o, q) {
  const out = [`Query . . . . . . :   ${o.NAME}        Library . . . . :   ${o.LIB}`, `Text  . . . . . . :   ${o.TEXT || ''}`, ''];
  out.push('Selected files', ...q.files.map((f) => `  ${f.id}  ${f.lib}/${f.file}`));
  if (q.files.length > 1) out.push(`Join type . . . . :   ${q.joinType}`, ...q.joins.filter((j) => j.left).map((j) => `  ${j.left} ${j.test || 'EQ'} ${j.right}`));
  if (q.results.length) out.push('Result fields', ...q.results.map((r) => `  ${r.name} = ${r.expr}`));
  if (q.fields.length) out.push(`Selected fields . :   ${q.fields.join(', ')}`);
  if (q.conditions.length) out.push('Record selection', ...q.conditions.map((c, i) => `  ${i ? c.andor || 'AND' : '   '} ${c.field} ${c.test} ${c.value}`));
  if (q.sorts.length) out.push('Sort fields', ...q.sorts.map((s) => `  ${s.prty}  ${s.field} ${s.dir || 'A'}`));
  if (Object.keys(q.summaries).length) out.push('Report summary functions', ...Object.entries(q.summaries).map(([f, s]) => `  ${f}: ${s.map((n) => Q.FUNCS[n]).join(' ')}`));
  if (q.breaks.length) out.push('Report breaks', ...q.breaks.map((b) => `  ${b.level}  ${b.field}`));
  out.push(`Output type . . . :   ${['', 'Display', 'Printer', 'Database file'][q.output.type]}${q.output.type === 3 ? ` ${q.output.lib}/${q.output.file}` : ''}`, `Form of output  . :   ${q.output.form === 2 ? 'Summary only' : 'Detail'}`);
  return out;
}

// ======================= Define the Query =======================
const ITEMS = [
  ['files', 'Specify file selections'], ['results', 'Define result fields'], ['fields', 'Select and sequence fields'],
  ['conditions', 'Select records'], ['sorts', 'Select sort fields'], ['collate', 'Select collating sequence'],
  ['headings', 'Specify report column formatting'], ['summaries', 'Select report summary functions'], ['breaks', 'Define report breaks'],
  ['output', 'Select output type and output form'], ['options', 'Specify processing options'],
];
const defined = (q, k) => ({ files: q.files.length, results: q.results.length, fields: q.fields.length, conditions: q.conditions.length, sorts: q.sorts.length, headings: Object.keys(q.headings).length, summaries: Object.keys(q.summaries).length, breaks: q.breaks.length, output: q.output.type !== 1 || q.output.form !== 1 })[k];

export async function defineQuery(ctx, q, { lib, name, text = '', existing = false }) {
  let message = null;
  const selected = new Set(q.files.length ? [] : ['files']);
  for (;;) {
    const p = new Panel({ fn: 'QRY-DEFINE', keys: ['F3', 'F5', 'F12', 'F13', 'F18'] });
    p.title('Define the Query');
    p.info(3, 2, 'Query', name || '', 12); p.info(3, 40, 'Option', existing ? 'CHANGE' : 'CREATE', 12);
    p.info(4, 4, 'Library', lib, 10); p.info(4, 40, 'CCSID', '37', 12);
    p.text(6, 2, 'Type options, press Enter.  Press F21 to select all.', 'b'); p.text(7, 4, '1=Select', 'b');
    p.text(9, 2, 'Opt    Query Definition Option', 'w');
    ITEMS.forEach(([k, t], i) => {
      p.input(`O${i}`, 10 + i, 3, 1, { value: selected.has(k) ? '1' : '' });
      p.text(10 + i, 6, `${defined(q, k) ? '>' : ' '}  ${t}`);
    });
    p.fkeys('F3=Exit   F5=Report   F12=Cancel', 'F13=Layout   F18=Files   F21=Select all');
    if (message) p.msg(message);
    message = null;
    selected.clear();
    const r = await ctx.display(p);
    if (r.aid === 'F12') return null;
    try {
      if (r.aid === 'F3') return exitQuery(ctx, q, { lib, name, text });
      if (r.aid === 'F5' || r.aid === 'F13') { await showReport(ctx, await Q.runQuery(ctx, q, { outtype: 1, qname: name || '*NONE' }), name || '*NONE', lib); continue; }
      if (r.aid === 'F18') { message = { text: q.files.map((f) => `${f.id}=${f.lib}/${f.file}`).join('  ') || 'No files selected.' }; continue; }
      for (const [i, [k]] of ITEMS.entries()) {
        if ((r.fields[`O${i}`] || '').trim() !== '1') continue;
        if (k !== 'files' && !q.files.length) { message = err('Specify file selections first.'); break; }
        const res = await ({ files: fileSelections, results: resultFields, fields: selectFields, conditions: selectRecords, sorts: sortFields, headings: columnFormatting, summaries: summaryFunctions, breaks: reportBreaks, output: outputType, collate: async () => null, options: async () => null })[k](ctx, q);
        if (res && res.text) { message = res; break; }
      }
    } catch (e) { message = toMsg(e); }
  }
}

async function exitQuery(ctx, q, { lib, name, text }) {
  let vals = { SAVE: 'Y', RUN: '1', QRY: name, LIB: lib, TEXT: text, AUT: '*LIBCRTAUT' };
  for (;;) {
    const p = new Panel({ fn: 'QRY-EXIT', keys: ['F12', 'F13'] });
    p.title('Exit this Query');
    p.text(3, 2, 'Type choices, press Enter.', 'b');
    p.label(5, 2, 'Save definition', 32); p.input('SAVE', 5, 36, 1, { value: vals.SAVE }); p.text(5, 44, 'Y=Yes, N=No', 'b');
    p.label(7, 2, 'Run option', 32); p.input('RUN', 7, 36, 1, { value: vals.RUN }); p.text(7, 44, '1=Run interactively', 'b'); p.text(8, 44, '2=Run in batch', 'b'); p.text(9, 44, '3=Do not run', 'b');
    p.text(11, 2, 'For a saved definition:', 'g');
    p.label(12, 4, 'Query', 30); p.input('QRY', 12, 36, 10, { value: vals.QRY }); p.text(12, 48, 'Name', 'b');
    p.label(13, 6, 'Library', 28); p.input('LIB', 13, 38, 10, { value: vals.LIB }); p.text(13, 50, 'Name, F4 for list', 'b');
    p.label(15, 4, 'Text', 30); p.input('TEXT', 15, 36, 40, { value: vals.TEXT, lower: true });
    p.label(17, 4, 'Authority', 30); p.input('AUT', 17, 36, 10, { value: vals.AUT }); p.text(17, 48, '*LIBCRTAUT, *CHANGE, *ALL', 'b'); p.text(18, 48, '*EXCLUDE, *USE', 'b');
    p.fkeys('F4=Prompt   F5=Report   F12=Cancel   F13=Layout   F14=Define the query');
    const r = await ctx.display(p);
    if (r.aid === 'F12') return defineQuery(ctx, q, { lib, name, text });
    vals = { SAVE: up(r.fields.SAVE), RUN: (r.fields.RUN || '3').trim(), QRY: up(r.fields.QRY), LIB: up(r.fields.LIB) || lib, TEXT: String(r.fields.TEXT || '').trim(), AUT: up(r.fields.AUT) || '*LIBCRTAUT' };
    let msg = null;
    if (vals.SAVE === 'Y') {
      if (!vals.QRY) continue;
      const L = vals.LIB === '*CURLIB' ? ctx.resolveLib('*CURLIB') : vals.LIB;
      q.text = vals.TEXT;
      await putObject(L, vals.QRY, '*QRYDFN', 'QRY', vals.TEXT, q, ctx.job.user);
      if (vals.AUT !== '*LIBCRTAUT') {
        const sec = await import('../security.js');
        await sec.setPrivate(L, vals.QRY, '*QRYDFN', '*PUBLIC', [...sec.expand(vals.AUT)].join(' ') || '*EXCLUDE');
      }
      msg = { text: `Query ${vals.QRY} in ${L} saved.` };
    }
    if (vals.RUN === '1') { const m = await showReport(ctx, await Q.runQuery(ctx, q, { qname: vals.QRY || '*NONE' }), vals.QRY || '*NONE', vals.LIB); return m || msg; }
    if (vals.RUN === '2' && vals.SAVE === 'Y') return execFromLine(ctx, `SBMJOB CMD(RUNQRY QRY(${vals.LIB}/${vals.QRY}) OUTTYPE(*PRINTER)) JOB(${vals.QRY})`);
    return msg || { text: 'Query definition not saved.' };
  }
}

// ---------- Apartados ----------
async function fileSelections(ctx, q) {
  let message = null;
  for (;;) {
    const p = new Panel({ fn: 'QRY-FILES', keys: ['F9', 'F12'] });
    p.title('Specify File Selections');
    p.text(3, 2, 'Type choices, press Enter.  Press F9 to specify an additional file selection.', 'b');
    const n = Math.max(1, q.files.length);
    for (let i = 0; i < Math.min(n, 3); i++) {
      const f = q.files[i] || {};
      const r0 = 5 + i * 6;
      p.label(r0, 2, 'File', 30); p.input(`F${i}`, r0, 34, 10, { value: f.file || '' }); p.text(r0, 46, 'Name, F4 for list', 'b');
      p.label(r0 + 1, 4, 'Library', 28); p.input(`L${i}`, r0 + 1, 36, 10, { value: f.lib || '*LIBL' });
      p.label(r0 + 2, 2, 'Member', 30); p.input(`M${i}`, r0 + 2, 34, 10, { value: f.mbr || '*FIRST' });
      p.label(r0 + 3, 2, 'Format', 30); p.input(`R${i}`, r0 + 3, 34, 10, { value: f.fmt || '*FIRST' });
      p.label(r0 + 4, 2, 'File ID', 30); p.input(`I${i}`, r0 + 4, 34, 3, { value: f.id || `T0${i + 1}` });
    }
    p.fkeys('F3=Exit   F4=Prompt   F5=Report   F9=Add file   F12=Cancel');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F12') return null;
    const files = [];
    try {
      for (let i = 0; i < Math.min(n, 3); i++) {
        const file = up(r.fields[`F${i}`]);
        if (!file) continue;
        const lib = up(r.fields[`L${i}`]) || '*LIBL';
        const d = await describeFile(gw, `${lib}/${file}`, ctx.libl).catch(() => null);
        if (!d) throw new CLError('CPF9812', file, lib);
        files.push({ file, lib: d.lib || d.schema, mbr: up(r.fields[`M${i}`]) || '*FIRST', fmt: up(r.fields[`R${i}`]) || '*FIRST', id: up(r.fields[`I${i}`]) || `T0${i + 1}` });
      }
    } catch (e) { message = toMsg(e); continue; }
    q.files = files;
    if (r.aid === 'F9') { q.files.push({ file: '', lib: '*LIBL', id: `T0${q.files.length + 1}` }); q.files = q.files.filter((f, i) => f.file || i === q.files.length - 1); continue; }
    q.files = q.files.filter((f) => f.file);
    if (q.files.length > 1) await joinSpec(ctx, q);
    return null;
  }
}

async function joinSpec(ctx, q) {
  const p = new Panel({ fn: 'QRY-JOINTYPE', keys: ['F12'] });
  p.title('Specify Type of Join');
  p.text(3, 2, 'Type choice, press Enter.', 'b');
  p.label(5, 2, 'Type of join', 30); p.input('T', 5, 34, 1, { value: String(q.joinType || 1) });
  p.text(5, 40, '1=Matched records', 'b'); p.text(6, 40, '2=Matched records with primary file', 'b'); p.text(7, 40, '3=Unmatched records with primary file', 'b');
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return;
  q.joinType = Number(r.fields.T) || 1;
  const z = new Panel({ fn: 'QRY-JOIN', keys: ['F12'] });
  z.title('Specify How to Join Files');
  z.text(3, 2, 'Type comparisons to show how file selections are related, press Enter.', 'b');
  z.text(4, 4, 'Tests: EQ, NE, LE, GE, LT, GT', 'b');
  z.text(6, 2, 'Field                          Test   Field', 'w');
  for (let i = 0; i < 5; i++) {
    const j = q.joins[i] || {};
    z.input(`A${i}`, 7 + i, 2, 30, { value: j.left || '' }); z.input(`T${i}`, 7 + i, 33, 4, { value: j.test || '' }); z.input(`B${i}`, 7 + i, 40, 30, { value: j.right || '' });
  }
  z.fkeys('F12=Cancel');
  const s = await ctx.display(z);
  if (s.aid !== 'ENTER') return;
  q.joins = Array.from({ length: 5 }, (_, i) => ({ left: up(s.fields[`A${i}`]), test: up(s.fields[`T${i}`]) || 'EQ', right: up(s.fields[`B${i}`]) })).filter((j) => j.left && j.right);
}

async function resultFields(ctx, q) {
  const p = new Panel({ fn: 'QRY-RESULT', keys: ['F12'] });
  p.title('Define Result Fields');
  p.text(3, 2, 'Type definitions using field names or constants and operators, press Enter.', 'b');
  p.text(4, 4, 'Operators:  +, -, *, /, SUBSTR, ||, DATE…', 'b');
  p.text(6, 2, 'Field       Expression                                   Column Heading    Len  Dec', 'w');
  for (let i = 0; i < 5; i++) {
    const x = q.results[i] || {};
    const row = 7 + i * 2;
    p.input(`N${i}`, row, 2, 10, { value: x.name || '' }); p.input(`E${i}`, row, 14, 44, { value: x.expr || '', lower: true });
    p.input(`H${i}`, row, 60, 15, { value: x.heading || '', lower: true });
    p.text(row + 1, 52, 'Len', 'g'); p.input(`L${i}`, row + 1, 57, 5, { value: x.len ? String(x.len) : '' });
    p.text(row + 1, 64, 'Dec', 'g'); p.input(`D${i}`, row + 1, 69, 2, { value: x.dec ? String(x.dec) : '' });
  }
  p.fkeys('F3=Exit   F5=Report   F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return null;
  q.results = Array.from({ length: 5 }, (_, i) => ({ name: up(r.fields[`N${i}`]), expr: String(r.fields[`E${i}`] || '').trim(), heading: String(r.fields[`H${i}`] || '').trim(), len: Number(r.fields[`L${i}`]) || 15, dec: Number(r.fields[`D${i}`]) || 0 })).filter((x) => x.name && x.expr);
  return null;
}

async function fieldList(ctx, q, title, instr, colHead, cell, apply) {
  const fields = await Q.availableFields(ctx, q);
  let top = 0;
  for (;;) {
    const p = new Panel({ fn: 'QRY-FLDLIST', keys: ['F12', 'PAGEUP', 'PAGEDOWN'] });
    p.title(title);
    p.text(3, 2, instr, 'b');
    p.text(5, 2, colHead, 'w');
    const page = fields.slice(top, top + 14);
    page.forEach((f, i) => cell(p, 6 + i, f, i + top));
    p.more(20, top + 14 < fields.length);
    p.fkeys('F3=Exit   F5=Report   F12=Cancel   F20=Renumber   F24=More keys');
    const r = await ctx.display(p);
    if (r.aid === 'F12') return null;
    apply(r.fields, page, top);
    if (r.aid === 'PAGEDOWN') { if (top + 14 < fields.length) top += 14; continue; }
    if (r.aid === 'PAGEUP') { top = Math.max(0, top - 14); continue; }
    return null;
  }
}
const qname = (q, f) => (q.files.length > 1 && f.id ? `${f.id}.${f.name}` : f.name);
const desc = (f) => `${padR(f.name, 10)}  ${padR(f.id, 4)} ${padR(f.text, 30)}  ${padL(f.len, 5)} ${f.num ? padL(f.dec, 2) : '  '}`;

async function selectFields(ctx, q) {
  const seq = new Map(q.fields.map((n, i) => [n, (i + 1) * 10]));
  return fieldList(ctx, q, 'Select and Sequence Fields', 'Type sequence number (0-9999) for the names of up to 500 fields to appear in the report, press Enter.', 'Seq    Field       File Text                              Len Dec',
    (p, row, f) => { p.input(`S_${f.id}_${f.name}`, row, 2, 4, { value: seq.get(qname(q, f)) ? String(seq.get(qname(q, f))) : '' }); p.text(row, 9, desc(f)); },
    (vals, page) => {
      for (const f of page) { const v = Number(vals[`S_${f.id}_${f.name}`]); if (v > 0) seq.set(qname(q, f), v); else seq.delete(qname(q, f)); }
      q.fields = [...seq.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);
    });
}

async function sortFields(ctx, q) {
  const cur = new Map(q.sorts.map((s) => [s.field, s]));
  return fieldList(ctx, q, 'Select Sort Fields', 'Type sort priority (0-999) and A (Ascending) or D (Descending) for the names of up to 32 fields, press Enter.', 'Sort  A/D  Field       File Text                              Len Dec',
    (p, row, f) => { const s = cur.get(qname(q, f)); p.input(`P_${f.id}_${f.name}`, row, 2, 3, { value: s ? String(s.prty) : '' }); p.input(`D_${f.id}_${f.name}`, row, 8, 1, { value: s ? s.dir : '' }); p.text(row, 12, desc(f)); },
    (vals, page) => {
      for (const f of page) { const n = Number(vals[`P_${f.id}_${f.name}`]); if (n > 0) cur.set(qname(q, f), { field: qname(q, f), prty: n, dir: up(vals[`D_${f.id}_${f.name}`]) === 'D' ? 'D' : 'A' }); else cur.delete(qname(q, f)); }
      q.sorts = [...cur.values()].sort((a, b) => a.prty - b.prty);
    });
}

async function summaryFunctions(ctx, q) {
  return fieldList(ctx, q, 'Select Report Summary Functions', 'Type options, press Enter.  1=Total  2=Average  3=Minimum  4=Maximum  5=Count', 'Options       Field       File Text                              Len Dec',
    (p, row, f) => { const s = q.summaries[f.name] || []; for (let k = 0; k < 5; k++) p.input(`F${k}_${f.id}_${f.name}`, row, 2 + k * 2, 1, { value: s[k] ? String(s[k]) : '' }); p.text(row, 15, desc(f)); },
    (vals, page) => {
      for (const f of page) {
        const s = [0, 1, 2, 3, 4].map((k) => Number(vals[`F${k}_${f.id}_${f.name}`])).filter((n) => n >= 1 && n <= 5);
        if (!f.num) for (const n of [1, 2]) if (s.includes(n)) s.splice(s.indexOf(n), 1);
        if (s.length) q.summaries[f.name] = [...new Set(s)]; else delete q.summaries[f.name];
      }
    });
}

async function reportBreaks(ctx, q) {
  const cur = new Map(q.breaks.map((b) => [b.field, b.level]));
  return fieldList(ctx, q, 'Define Report Breaks', 'Type break level (1-6) for the names of up to 9 fields, press Enter.', 'Break Level  Field       File Text                              Len Dec',
    (p, row, f) => { p.input(`B_${f.id}_${f.name}`, row, 4, 1, { value: cur.get(qname(q, f)) ? String(cur.get(qname(q, f))) : '' }); p.text(row, 15, desc(f)); },
    (vals, page) => {
      for (const f of page) { const n = Number(vals[`B_${f.id}_${f.name}`]); if (n >= 1 && n <= 6) cur.set(qname(q, f), n); else cur.delete(qname(q, f)); }
      q.breaks = [...cur.entries()].map(([field, level]) => ({ field, level }));
    });
}

async function columnFormatting(ctx, q) {
  return fieldList(ctx, q, 'Specify Report Column Formatting', 'Type information, press Enter.', 'Field       Column Heading',
    (p, row, f) => { p.text(row, 2, padR(f.name, 10)); p.input(`H_${f.id}_${f.name}`, row, 14, 20, { value: q.headings[f.name] || '', lower: true }); },
    (vals, page) => { for (const f of page) { const h = String(vals[`H_${f.id}_${f.name}`] || '').trim(); if (h) q.headings[f.name] = h; else delete q.headings[f.name]; } });
}

async function selectRecords(ctx, q) {
  const p = new Panel({ fn: 'QRY-RCDSLT', keys: ['F12'] });
  p.title('Select Records');
  p.text(3, 2, 'Type comparisons, press Enter.  Specify OR to start each new group.', 'b');
  p.text(4, 4, 'Tests:  EQ, NE, LE, GE, LT, GT, RANGE, LIST, LIKE, ISNULL, ISNNULL', 'b');
  p.text(6, 2, 'AND/OR  Field                Test   Value (Field, Number, \'Characters\', or ...)', 'w');
  for (let i = 0; i < 10; i++) {
    const c = q.conditions[i] || {};
    if (i) p.input(`A${i}`, 7 + i, 3, 3, { value: c.andor || '' });
    p.input(`F${i}`, 7 + i, 10, 20, { value: c.field || '' });
    p.input(`T${i}`, 7 + i, 31, 6, { value: c.test || '' });
    p.input(`V${i}`, 7 + i, 39, 41, { value: c.value || '', lower: true });
  }
  p.fkeys('F3=Exit   F5=Report   F9=Insert   F11=Display names only   F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return null;
  const conds = Array.from({ length: 10 }, (_, i) => ({ andor: i ? up(r.fields[`A${i}`]) || 'AND' : '', field: up(r.fields[`F${i}`]), test: up(r.fields[`T${i}`]), value: String(r.fields[`V${i}`] || '').trim() })).filter((c) => c.field);
  for (const c of conds) if (!Q.TESTS.includes(c.test)) return err(`Test ${c.test || '(blank)'} not valid for field ${c.field}.`);
  q.conditions = conds;
  await Q.buildSql(ctx, q);
  return null;
}

async function outputType(ctx, q) {
  const p = new Panel({ fn: 'QRY-OUTTYPE', keys: ['F12'] });
  p.title('Select Output Type and Output Form');
  p.text(3, 2, 'Type choices, press Enter.', 'b');
  p.label(5, 2, 'Output type', 30); p.input('T', 5, 34, 1, { value: String(q.output.type) }); p.text(5, 40, '1=Display', 'b'); p.text(6, 40, '2=Printer', 'b'); p.text(7, 40, '3=Database file', 'b');
  p.label(9, 2, 'Form of output', 30); p.input('F', 9, 34, 1, { value: String(q.output.form) }); p.text(9, 40, '1=Detail', 'b'); p.text(10, 40, '2=Summary only', 'b');
  p.label(12, 2, 'Line wrapping', 30); p.input('W', 12, 34, 1, { value: 'N' }); p.text(12, 40, 'Y=Yes, N=No', 'b');
  p.fkeys('F3=Exit   F5=Report   F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return null;
  q.output.type = Number(r.fields.T) || 1;
  q.output.form = Number(r.fields.F) || 1;
  if (q.output.type === 3) {
    const z = new Panel({ fn: 'QRY-DBOUT', keys: ['F12'] });
    z.title('Define Database File Output');
    z.text(3, 2, 'Type choices, press Enter.', 'b');
    z.label(5, 2, 'File', 30); z.input('FILE', 5, 34, 10, { value: q.output.file || '' }); z.text(5, 46, 'Name', 'b');
    z.label(6, 4, 'Library', 28); z.input('LIB', 6, 36, 10, { value: q.output.lib || '*CURLIB' }); z.text(6, 48, 'Name, *CURLIB', 'b');
    z.label(7, 2, 'Member', 30); z.input('MBR', 7, 34, 10, { value: q.output.mbr || '*FILE' });
    z.label(9, 2, 'Data in file', 30); z.input('DATA', 9, 34, 1, { value: String(q.output.data || 1) }); z.text(9, 40, '1=New file', 'b'); z.text(10, 40, '2=Replace file', 'b'); z.text(11, 40, '3=Add to file', 'b');
    z.fkeys('F12=Cancel');
    const s = await ctx.display(z);
    if (s.aid !== 'ENTER') return null;
    q.output = { ...q.output, file: up(s.fields.FILE), lib: up(s.fields.LIB) || '*CURLIB', mbr: up(s.fields.MBR) || '*FILE', data: Number(s.fields.DATA) || 1 };
  }
  return null;
}

/** RUNQRY RCDSLT(*YES): pantalla Select Records antes de ejecutar. */
export async function runtimeSelect(ctx, q) { await selectRecords(ctx, q); }

// ======================= STRQRY =======================
export async function strqry(ctx) {
  return showMenu(ctx, {
    id: 'QUERY', title: 'Query Utilities',
    options: [[1, 'Work with queries', 'WRKQRY'], [2, 'Run an existing query', '?RUNQRY'], [3, 'Delete a query', '?DLTQRY'], [null], [10, 'Start DFU', null], [11, 'Work with Query Manager', null], [20, 'Work with files', 'WRKOBJPDM LIB(*CURLIB) OBJTYPE(*FILE)']],
    bottomOptions: [[90, 'Sign off', 'SIGNOFF']],
  });
}
