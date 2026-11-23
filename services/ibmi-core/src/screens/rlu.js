// RLU — Report Layout Utility (STRRLU): diseño de archivos de impresora (PRTF) sobre una hoja de 132 columnas.
//   Columna de mandatos de línea: DR (definir registro), DF (definir campos de la línea), K (palabras clave del
//   registro), CF (crear campos a partir de XXXX / 9,999.99), I (insertar línea), D (suprimir línea), R (repetir).
//   F6 = prototipo del informe (archivo en spool), F19/F20 = desplazar, F3 = salir (guardar y CRTPRTF).
import { Panel, padR, padL } from '../panel.js';
import { CLError } from '../messages.js';
import { gw, findObject, findMember, readMember, addMember, writeMember, updateMemberInfo, createSpool } from '../objects.js';
import { parseDdsModel, generateDds, quote } from '../../../../shared/sda.js';
import { toMsg, execFromLine } from './common.js';

const up = (s) => String(s ?? '').trim().toUpperCase();
const WIDTH = 132;
const NUM = new Set(['S', 'P', 'Y', 'B', 'F']);
const isNum = (it) => NUM.has(it.dtype) || (!it.dtype && it.dec !== '');
const kwOf = (it, k) => it.kws.find((x) => !x.cond && new RegExp(`^${k}\\(`, 'i').test(x.text.trim()));
const argOf = (it, k) => { const x = kwOf(it, k); return x ? (/\(([^)]*)\)/.exec(x.text) || [])[1] : null; };

/** Muestra de un campo: XXXX para carácter; 9,999.99 según los decimales y el código de edición. */
export function fieldPattern(it) {
  const len = Number(it.len) || 1;
  if (!isNum(it)) return 'X'.repeat(len);
  const dec = Number(it.dec) || 0;
  const ed = up(argOf(it, 'EDTCDE') || '').split(/\s+/)[0];
  const ip = Math.max(len - dec, 0);
  let int = '9'.repeat(ip || 1);
  if (['1', '2', 'A', 'B', 'J', 'K', 'N', 'O'].includes(ed)) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${int}${dec && ed ? `.${'9'.repeat(dec)}` : dec ? '9'.repeat(dec) : ''}`;
}
const constOf = (it) => { const m = /^'((?:[^']|'')*)'/.exec(String(it.kws[0]?.text || '').trim()); return m ? m[1].replace(/''/g, "'") : ''; };
const SPECIAL = { DATE: 'DD/DD/DD', TIME: 'TT:TT:TT', PAGNBR: 'NNNN' };
function itemText(it) {
  if (it.kind !== 'C') return fieldPattern(it);
  const c = constOf(it);
  if (c) return c;
  const sp = /^(DATE|TIME|PAGNBR)/i.exec(String(it.kws[0]?.text || '').trim());
  return sp ? SPECIAL[sp[1].toUpperCase()] : '';
}

/** Filas de la hoja (cada una con su registro y elementos) a partir del modelo DDS. */
export function layoutRows(model) {
  const rows = [];
  for (const rec of model.records) {
    let cur = { rec, first: true, items: [] };
    rows.push(cur);
    for (const it of rec.items) {
      const sb = Number(argOf(it, 'SPACEB') || 0);
      if (sb > 0 || (it.row && it.row !== null && cur.items.length && cur.items[0].row !== it.row)) {
        for (let k = 1; k < sb; k++) rows.push({ rec, first: false, items: [] });
        cur = { rec, first: false, items: [] };
        rows.push(cur);
      }
      cur.items.push(it);
    }
  }
  return rows;
}
export function rowText(r) {
  const a = Array(WIDTH).fill(' ');
  for (const it of r.items) {
    const t = itemText(it);
    for (let i = 0; i < t.length && it.col - 1 + i < WIDTH; i++) a[it.col - 1 + i] = t[i];
  }
  return a.join('');
}

/** Interpreta el texto de una fila: conserva los elementos intactos; CF convierte XXXX/9999 en campos. */
export function parseRow(model, r, text, { createFields = false } = {}) {
  const s = text.padEnd(WIDTH).slice(0, WIDTH);
  const used = Array(WIDTH).fill(false);
  const keep = [];
  for (const it of r.items) {
    const t = itemText(it);
    if (s.slice(it.col - 1, it.col - 1 + t.length) === t) { keep.push(it); for (let i = it.col - 1; i < it.col - 1 + t.length; i++) used[i] = true; }
  }
  const added = [];
  const taken = new Set(model.records.flatMap((x) => x.items.filter((y) => y.kind === 'F').map((y) => y.name)));
  for (const it of keep) if (it.kind === 'F') taken.add(it.name);
  let i = 0;
  while (i < WIDTH) {
    if (used[i] || s[i] === ' ') { i++; continue; }
    let j = i;
    // Una constante termina en dos espacios seguidos o en un elemento conservado
    while (j < WIDTH && !used[j] && !(s[j] === ' ' && (s[j + 1] === ' ' || j + 1 >= WIDTH || used[j + 1]))) j++;
    const tok = s.slice(i, j).replace(/\s+$/, '');
    const m = /^(X+)$|^([9,]*9[9,]*)(?:\.(9+))?$/.exec(tok);
    if (createFields && m) {
      let n = 1; while (taken.has(`FLD${String(n).padStart(3, '0')}`)) n++;
      taken.add(`FLD${String(n).padStart(3, '0')}`);
      const it = m[1]
        ? { kind: 'F', name: `FLD${String(n).padStart(3, '0')}`, cond: '', ref: '', len: m[1].length, dtype: 'A', dec: '', usage: '', row: null, col: i + 1, kws: [] }
        : { kind: 'F', name: `FLD${String(n).padStart(3, '0')}`, cond: '', ref: '', len: (m[2].match(/9/g) || []).length + (m[3] || '').length, dtype: 'S', dec: String((m[3] || '').length), usage: '', row: null, col: i + 1, kws: m[2].includes(',') ? [{ cond: '', text: 'EDTCDE(J)' }] : m[3] ? [{ cond: '', text: 'EDTCDE(3)' }] : [] };
      added.push(it);
    } else added.push({ kind: 'C', name: '', cond: '', ref: '', len: 0, dtype: '', dec: '', usage: '', row: null, col: i + 1, kws: [{ cond: '', text: quote(tok) }] });
    i = j;
  }
  r.items = [...keep, ...added].sort((a, b) => a.col - b.col);
  for (let k = 1; k < r.items.length; k++) {
    const p = r.items[k - 1];
    if (p.col + itemText(p).length > r.items[k].col) throw new CLError('CPF9898', `Items overlap at column ${r.items[k].col}.`);
  }
}

/** Vuelve a construir los registros del modelo a partir de las filas (SPACEB de cada línea). */
export function rebuildModel(model, rows) {
  for (const rec of model.records) rec.items = [];
  let lastRec = null;
  let gap = 0;
  for (const r of rows) {
    if (r.rec !== lastRec) { lastRec = r.rec; gap = 0; r.first = true; }
    if (!r.items.length) { gap++; continue; }
    const firstInRec = !r.rec.items.length;
    r.items.forEach((it, k) => {
      it.kws = it.kws.filter((x) => x.cond || !/^(SPACEB|SKIPB)\(/i.test(x.text.trim()));
      it.row = null;
      if (k === 0 && !firstInRec) it.kws.unshift({ cond: '', text: `SPACEB(${gap + 1})` });
      if (k === 0 && firstInRec && gap > 0) it.kws.unshift({ cond: '', text: `SPACEB(${gap})` });
    });
    r.rec.items.push(...r.items);
    gap = 0;
  }
}

// ======================= Pantallas =======================
export async function strrlu(ctx, { lib, file, mbr }) {
  const L = lib === '*LIBL' || !lib ? (await findObject(gw, up(file), '*FILE', '*LIBL', ctx.libl))?.LIB : ctx.resolveLib(lib);
  if (!L) throw new CLError('CPF9812', up(file), lib);
  const ex = await findMember(gw, L, up(file), up(mbr), []).catch(() => null);
  const model = ex ? parseDdsModel((await readMember(gw, L, up(file), up(mbr))).map((l) => l.text)) : { comments: [], fileKws: [], records: [] };
  if (!model.records.length) model.records.push({ name: 'TITULO', cond: '', kws: [{ cond: '', text: 'SKIPB(1)' }], items: [] });
  let rows = layoutRows(model);
  while (rows.length < 12) rows.push({ rec: rows[rows.length - 1].rec, first: false, items: [] });
  let top = 0;
  let left = 0;
  const H = 14;
  const W = 63;
  let message = { text: 'Type constants; type XXXX or 9,999.99 and CF to create fields; DR defines a record format.' };
  for (;;) {
    const p = new Panel({ fn: 'RLU-DESIGN', keys: ['F3', 'F6', 'F12', 'F19', 'F20', 'PAGEUP', 'PAGEDOWN'] });
    p.text(1, 2, `Columns . . . :  ${padL(left + 1, 3)} ${padL(left + W, 3)}`, 'b');
    p.text(1, 30, 'Design Report', 'w');
    p.text(1, 55, `${up(file)}/${up(mbr)}`.slice(0, 25), 'b');
    p.text(3, 2, 'Cmd  FMT        ', 'w');
    const ruler = '....+....1....+....2....+....3....+....4....+....5....+....6....+....7....+....8....+....9....+....0....+....1....+....2....+....3..';
    p.text(3, 18, ruler.slice(left, left + W), 'w');
    p.text(4, 18, '************************** Beginning of data ***********************'.slice(0, W), 'w');
    const page = rows.slice(top, top + H);
    page.forEach((r, i) => {
      p.input(`C${i}`, 5 + i, 2, 4, {});
      if (r.first) p.text(5 + i, 7, padR(r.rec.name, 10), 'w');
      p.input(`L${i}`, 5 + i, 18, W, { value: rowText(r).slice(left, left + W).replace(/\s+$/, ''), lower: true, attr: 'g' });
    });
    if (top + H >= rows.length) p.text(5 + page.length, 18, '***************************** End of data ****************************'.slice(0, W), 'w');
    p.fkeys('F3=Exit   F6=Prototype   F12=Cancel   F19=Left   F20=Right', 'Line commands: DR=Record  DF=Fields  K=Keywords  CF=Create fields  I  D  R');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F12') return { text: 'Report design not saved.' };
    try {
      // Texto editado de las filas visibles (dentro de la ventana de columnas)
      const cmds = [];
      page.forEach((row, i) => {
        const txt = rowText(row);
        const win = String(r.fields[`L${i}`] ?? '').padEnd(W).slice(0, W);
        const c = up(r.fields[`C${i}`]);
        parseRow(model, row, txt.slice(0, left) + win + txt.slice(left + W), { createFields: c === 'CF' });
        if (c && c !== 'CF') cmds.push({ row, cmd: c, idx: top + i });
      });
      for (const { row, cmd, idx } of cmds.reverse()) {
        if (cmd === 'I') rows.splice(idx + 1, 0, { rec: row.rec, first: false, items: [] });
        else if (cmd === 'D') { if (row.first && rows[idx + 1] && rows[idx + 1].rec === row.rec) rows[idx + 1].first = true; rows.splice(idx, 1); }
        else if (cmd === 'R') rows.splice(idx + 1, 0, { rec: row.rec, first: false, items: JSON.parse(JSON.stringify(row.items)).map((x) => (x.kind === 'F' ? { ...x, name: `${x.name.slice(0, 8)}R` } : x)) });
        else if (cmd === 'DR') {
          const name = up(await askName(ctx, 'Define Record Format', 'Record format name', row.first ? row.rec.name : ''));
          if (!name) continue;
          if (row.first) { row.rec.name = name; continue; }
          if (model.records.some((x) => x.name === name)) throw new CLError('CPF9898', `Record format ${name} already defined.`);
          const rec = { name, cond: '', kws: [{ cond: '', text: 'SPACEB(1)' }], items: [] };
          model.records.splice(model.records.indexOf(row.rec) + 1, 0, rec);
          for (let k = idx; k < rows.length && rows[k].rec === row.rec; k++) rows[k].rec = rec;
          row.first = true;
        } else if (cmd === 'K') {
          const { keywordEditor } = await import('./sda.js');
          await keywordEditor(ctx, 'Select Record Keywords', `Record format ${row.rec.name}`, row.rec.kws);
        } else if (cmd === 'DF') await defineFields(ctx, row);
        else throw new CLError('CPF9898', `Line command ${cmd} not valid.`);
      }
      rebuildModel(model, rows);
    } catch (e) { message = toMsg(e); continue; }
    if (r.aid === 'F19') { left = Math.max(0, left - 50); continue; }
    if (r.aid === 'F20') { left = Math.min(WIDTH - W, left + 50); continue; }
    if (r.aid === 'PAGEDOWN') { if (top + H < rows.length) top += H; else rows.push(...Array.from({ length: H }, () => ({ rec: rows[rows.length - 1].rec, first: false, items: [] }))); continue; }
    if (r.aid === 'PAGEUP') { top = Math.max(0, top - H); continue; }
    if (r.aid === 'F6') {
      const lines = rows.map((x) => rowText(x).replace(/\s+$/, ''));
      await createSpool(ctx.job, up(mbr), lines, { usrdta: 'PROTOTYPE' });
      message = { text: `Prototype of report ${up(mbr)} printed to spooled file ${up(mbr)}.` };
      continue;
    }
    if (r.aid === 'F3') {
      const res = await exitRlu(ctx, model, { lib: L, file: up(file), mbr: up(mbr) });
      if (res !== 'BACK') return res;
    }
  }
}

async function askName(ctx, title, label, value) {
  const p = new Panel({ fn: 'RLU-NAME', keys: ['F12'] });
  p.title(title);
  p.label(5, 2, label, 30); p.input('N', 5, 34, 10, { value });
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  return r.aid === 'ENTER' ? r.fields.N : null;
}

async function defineFields(ctx, row) {
  const fields = row.items.filter((x) => x.kind === 'F');
  if (!fields.length) throw new CLError('CPF9898', 'No fields on the line; type XXXX or 9999 and use CF first.');
  const p = new Panel({ fn: 'RLU-DEFFLD', keys: ['F12'] });
  p.title('Define Field');
  p.text(3, 2, 'Type information, press Enter.', 'b');
  p.text(5, 2, 'Field       Column  Length  Dec  Edit code', 'w');
  fields.slice(0, 12).forEach((f, i) => {
    p.input(`N${i}`, 6 + i, 2, 10, { value: f.name });
    p.text(6 + i, 14, padL(f.col, 6));
    p.input(`L${i}`, 6 + i, 23, 5, { value: String(f.len) });
    p.input(`D${i}`, 6 + i, 31, 2, { value: String(f.dec || '') });
    p.input(`E${i}`, 6 + i, 37, 1, { value: (argOf(f, 'EDTCDE') || '').trim() });
  });
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return;
  fields.slice(0, 12).forEach((f, i) => {
    const n = up(r.fields[`N${i}`]);
    if (!/^[A-Z#@$][A-Z0-9#@$_]{0,9}$/.test(n)) throw new CLError('CPD0078', n, 'FIELD');
    f.name = n;
    f.len = Number(r.fields[`L${i}`]) || f.len;
    const d = String(r.fields[`D${i}`] ?? '').trim();
    if (d !== '') { f.dec = d; f.dtype = 'S'; } else if (f.dtype === 'S') f.dec = '0';
    const e = up(r.fields[`E${i}`]);
    f.kws = f.kws.filter((x) => !/^EDTCDE\(/i.test(x.text.trim()));
    if (e) f.kws.push({ cond: '', text: `EDTCDE(${e})` });
  });
}

async function exitRlu(ctx, model, { lib, file, mbr }) {
  const p = new Panel({ fn: 'RLU-EXIT', keys: ['F12'] });
  p.title('Exit RLU');
  p.text(3, 2, 'Type choices, press Enter.', 'b');
  p.label(5, 2, 'Save member', 36); p.input('SAVE', 5, 39, 1, { value: 'Y' }); p.text(5, 52, 'Y=Yes, N=No', 'b');
  p.label(6, 4, 'Source file', 34); p.text(6, 39, file, 'w');
  p.label(7, 6, 'Library', 32); p.text(7, 39, lib, 'w');
  p.label(8, 4, 'Member', 34); p.text(8, 39, mbr, 'w');
  p.label(9, 4, 'Text', 34); p.input('TEXT', 9, 39, 40, { lower: true });
  p.label(11, 2, 'Create printer file', 36); p.input('CRT', 11, 39, 1, { value: 'Y' }); p.text(11, 52, 'Y=Yes, N=No', 'b');
  p.label(12, 4, 'Printer file', 34); p.input('PRTF', 12, 39, 10, { value: mbr });
  p.label(13, 6, 'Library', 32); p.input('PLIB', 13, 41, 10, { value: lib });
  p.label(14, 4, 'Replace existing file', 34); p.input('RPL', 14, 39, 1, { value: 'Y' }); p.text(14, 52, 'Y=Yes, N=No', 'b');
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid === 'F12') return 'BACK';
  if (up(r.fields.SAVE) !== 'Y') return { text: `Member ${mbr} not saved.` };
  const dds = generateDds(model);
  const text = String(r.fields.TEXT || '').trim();
  if (!(await findMember(gw, lib, file, mbr, []).catch(() => null))) await addMember(lib, file, mbr, 'PRTF', text);
  else await updateMemberInfo(lib, file, mbr, { type: 'PRTF', text });
  await writeMember(lib, file, mbr, dds.map((t, i) => ({ seq: (i + 1) * 100, dat: 0, text: t })));
  if (up(r.fields.CRT) !== 'Y') return { text: `Member ${mbr} saved in ${lib}/${file}.` };
  const pf = up(r.fields.PRTF) || mbr;
  const pl = up(r.fields.PLIB) || lib;
  if (await findObject(gw, pf, '*FILE', pl, [])) {
    if (up(r.fields.RPL) !== 'Y') return { text: `Member saved; printer file ${pf} exists and was not replaced.` };
    await execFromLine(ctx, `DLTF FILE(${pl}/${pf})`);
  }
  return (await execFromLine(ctx, `CRTPRTF FILE(${pl}/${pf}) SRCFILE(${lib}/${file}) SRCMBR(${mbr})`)) || { text: `Printer file ${pf} created in ${pl}.` };
}
