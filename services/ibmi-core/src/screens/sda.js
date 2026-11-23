// SDA — Screen Design Aid (STRSDA, 5770-WDS): diseño de pantallas y de menús y prueba de archivos de pantalla.
//   1. Design screens ..... Trabajar con registros de pantalla, imagen de diseño, campos y palabras clave;
//                           al salir guarda el fuente DDS y crea el archivo de pantalla (CRTDSPF).
//   2. Design menus ....... texto del menú (MNUDDS) y mandatos (MNUCMD → archivo de mensajes menúQQ) y CRTMNU.
//   3. Test display files . valores de prueba, indicadores, visualización del registro y datos devueltos.
import { Panel, padR, padL, dots } from '../panel.js';
import { SYS, sysDate, sysTime } from '../system.js';
import { CLError, msgText } from '../messages.js';
import { gw, findObject, objectData, readMember, findMember, listMembers, addMember, writeMember, updateMemberInfo, describeFile, libExists } from '../objects.js';
import { showMenu, execFromLine, confirmDelete, toMsg } from './common.js';
import { parseDdsModel, generateDds, recordImage, applyImage, newRecord, recordType, menuTemplate, quote, effLen, effType, effDec, visible } from '../../../../shared/sda.js';
import { ddsReferences, resolveRef } from '../../../../shared/dds.js';

const up = (s) => String(s ?? '').trim().toUpperCase();
const NAME_RE = /^[A-Z#@$][A-Z0-9#@$_]{0,9}$/;
const err = (text) => ({ text, sev: 30 });

// ======================= Menú principal =======================
export async function strsda(ctx, { option = '*SELECT', srcfile, srcmbr, tstfile, direct = false } = {}) {
  // Desde PDM (opción 17) se entra directamente al miembro y se vuelve a PDM al salir
  if (direct && srcfile && srcmbr) {
    try {
      const lib = await resolveSrc(ctx, srcfile.lib, srcfile.obj);
      const r = option === '2' ? await designMenu(ctx, lib, up(srcfile.obj), up(srcmbr)) : await designScreens(ctx, lib, up(srcfile.obj), up(srcmbr));
      return r === 'F3' ? null : r;
    } catch (e) { return toMsg(e); }
  }
  if (option === '1') return designScreensPrompt(ctx, { srcfile, srcmbr });
  if (option === '2') return designMenusPrompt(ctx, { srcfile, srcmbr });
  if (option === '3') return testDisplayPrompt(ctx, { file: tstfile });
  return showMenu(ctx, {
    id: 'SDA',
    title: 'Screen Design Aid (SDA)',
    options: [
      [1, 'Design screens', (c) => designScreensPrompt(c, { srcfile, srcmbr })],
      [2, 'Design menus', (c) => designMenusPrompt(c, { srcfile, srcmbr })],
      [3, 'Test display files', (c) => testDisplayPrompt(c, { file: tstfile })],
    ],
  });
}

// ======================= Utilidades de fuente =======================
async function resolveSrc(ctx, lib, file) {
  const L = up(lib) || '*LIBL';
  const o = await findObject(gw, up(file), '*FILE', L === '*LIBL' ? '*LIBL' : L === '*CURLIB' ? ctx.resolveLib('*CURLIB') : L, ctx.libl);
  if (!o) throw new CLError('CPF9812', up(file), L);
  return o.LIB;
}

async function loadModel(ctx, lib, file, mbr) {
  const m = await findMember(gw, lib, file, mbr, []).catch(() => null);
  if (!m) return { model: null, exists: false, type: '' };
  const lines = (await readMember(gw, lib, file, mbr)).map((l) => l.text);
  const model = parseDdsModel(lines);
  await resolveRefs(ctx, model, lines, lib);
  return { model, exists: true, type: m.TYPE || '', text: m.TEXT || '' };
}

// Longitud/tipo de los campos con R en la columna 29 (REF/REFFLD), para verlos en la imagen
async function resolveRefs(ctx, model, lines, lib) {
  const refs = {};
  for (const f of ddsReferences(lines || generateDds(model))) {
    try { refs[f.replace(/^.*\//, '')] = await describeFile(gw, f.includes('/') ? f : `*LIBL/${f}`, [lib, ...ctx.libl]); } catch { /* sin resolver */ }
  }
  const refKw = model.fileKws.map((k) => /^REF\(([^)]+)\)/i.exec(k.text.trim())).find(Boolean);
  const fileRef = refKw ? refKw[1].trim().toUpperCase().replace(/^.*\//, '') : null;
  for (const rec of model.records) {
    for (const it of rec.items) {
      if (it.kind !== 'F' || (it.ref !== 'R' && it.len)) continue;
      const rf = it.kws.map((k) => /REFFLD\(([^)]+)\)/i.exec(k.text)).find(Boolean);
      const kws = rf ? [{ kw: 'REFFLD', args: rf[1].trim().split(/\s+/) }] : [];
      try { const r = resolveRef(refs, fileRef, kws, it.name, 0); it.$len = r.len; it.$dtype = r.type; it.$dec = r.type === 'A' ? '' : String(r.dec); } catch { it.$len = it.$len || 1; }
    }
  }
}

// ======================= 1. Diseñar pantallas =======================
async function designScreensPrompt(ctx, { srcfile, srcmbr } = {}) {
  let vals = { FILE: (srcfile && srcfile.obj) || 'QDDSSRC', LIB: (srcfile && srcfile.lib) || '*LIBL', MBR: srcmbr && srcmbr !== '*SELECT' ? srcmbr : '' };
  let message = null;
  for (;;) {
    const p = new Panel({ fn: 'SDA-DESIGN', keys: ['F3', 'F4', 'F12'] });
    p.title('Design Screens');
    p.text(3, 2, 'Type choices, press Enter.', 'b');
    p.label(5, 2, 'Source file', 32); p.input('FILE', 5, 36, 10, { value: vals.FILE }); p.text(5, 50, 'Name, F4 for list', 'b');
    p.label(6, 4, 'Library', 30); p.input('LIB', 6, 38, 10, { value: vals.LIB }); p.text(6, 50, 'Name, *LIBL, *CURLIB', 'b');
    p.label(8, 2, 'Member', 32); p.input('MBR', 8, 36, 10, { value: vals.MBR }); p.text(8, 50, 'Name, F4 for list', 'b');
    p.fkeys('F3=Exit   F4=Prompt   F12=Cancel');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    vals = { FILE: up(r.fields.FILE), LIB: up(r.fields.LIB) || '*LIBL', MBR: up(r.fields.MBR) };
    try {
      const lib = await resolveSrc(ctx, vals.LIB, vals.FILE);
      if (r.aid === 'F4' || !vals.MBR) {
        const pick = await pickMember(ctx, lib, vals.FILE, ['DSPF']);
        if (pick) vals.MBR = pick;
        continue;
      }
      if (!NAME_RE.test(vals.MBR)) { message = err(`Member name ${vals.MBR} not valid.`); continue; }
      const res = await designScreens(ctx, lib, vals.FILE, vals.MBR);
      if (res === 'F3') return null;
      message = res;
    } catch (e) { message = toMsg(e); }
  }
}

async function pickMember(ctx, lib, file, types) {
  const list = (await listMembers(lib, file)).filter((m) => !types || types.includes(m.TYPE));
  const p = new Panel({ fn: 'SDA-MBRLIST', keys: ['F12'] });
  p.title('Select Member');
  p.info(3, 2, 'File', file, 18); p.info(4, 2, 'Library', lib, 18);
  p.text(6, 2, 'Type option, press Enter.', 'b'); p.text(7, 4, '1=Select', 'b');
  p.text(9, 2, 'Opt  Member      Type        Text', 'w');
  list.slice(0, 12).forEach((m, i) => { p.input(`O${i}`, 10 + i, 3, 1, {}); p.text(10 + i, 7, `${padR(m.MBR, 10)}  ${padR(m.TYPE, 10)}  ${padR(m.TEXT, 40)}`); });
  if (!list.length) p.text(10, 7, '(No members in file)');
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return null;
  const i = list.slice(0, 12).findIndex((_, k) => (r.fields[`O${k}`] || '').trim() === '1');
  return i >= 0 ? list[i].MBR : null;
}

async function designScreens(ctx, lib, file, mbr) {
  const loaded = await loadModel(ctx, lib, file, mbr);
  if (loaded.exists && loaded.type && !['DSPF', ''].includes(loaded.type)) return err(`Member ${mbr} is type ${loaded.type}; SDA designs members of type DSPF.`);
  const model = loaded.model || { comments: [], fileKws: [{ cond: '', text: 'DSPSIZ(24 80 *DS3)' }], records: [] };
  const state = { lib, file, mbr, model, text: loaded.text || '', changed: false, exists: loaded.exists };
  const r = await workRecords(ctx, state);
  if (r === 'CANCEL') return { text: `Design of member ${mbr} ended; changes not saved.` };
  return exitScreens(ctx, state);
}

// ---------- Trabajar con registros de pantalla ----------
async function workRecords(ctx, st) {
  let message = null;
  let top = 0;
  for (;;) {
    const recs = st.model.records;
    const p = new Panel({ fn: 'SDA-RECORDS', keys: ['F3', 'F12', 'F14', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Work with Display Records');
    p.info(3, 2, 'File', st.file, 16); p.info(3, 42, 'Member', st.mbr, 16);
    p.info(4, 4, 'Library', st.lib, 14); p.info(4, 42, 'Source type', 'DSPF', 16);
    p.text(6, 2, 'Type options, press Enter.', 'b');
    p.text(7, 4, '1=Add                 2=Edit comments       3=Copy          4=Delete', 'b');
    p.text(8, 4, '7=Rename              8=Select keywords     12=Design image', 'b');
    p.text(10, 2, 'Opt    Order    Record      Type       Related    Subfile  Date', 'w');
    p.input('AOPT', 11, 3, 2, {}); p.input('AREC', 11, 18, 10, {}); p.input('ATYPE', 11, 30, 8, {});
    const page = recs.slice(top, top + 9);
    page.forEach((rc, i) => {
      const t = recordType(rc);
      const rel = t === 'SFLCTL' ? (/SFLCTL\((\w+)\)/i.exec(rc.kws.map((k) => k.text).join(' ')) || [])[1] || '' : '';
      p.input(`O${i}`, 12 + i, 3, 2, {});
      p.text(12 + i, 10, `${padL((top + i + 1) * 10, 4)}     ${padR(rc.name, 10)}  ${padR(t, 9)}  ${padR(rel, 10)} ${padR('', 7)}  ${sysDate()}`);
    });
    if (!recs.length) p.text(12, 10, '(No records in member; type 1, a record name and a type on the first line)', 'g');
    p.more(21, top + 9 < recs.length);
    p.fkeys('F3=Exit   F12=Cancel   F14=File-level keywords   F15=File-level comments', 'F17=Subset   F24=More keys');
    if (message) p.msg(message);
    message = null;
    p.cursorTo('AOPT');
    const r = await ctx.display(p);
    if (r.aid === 'F3') return 'F3';
    if (r.aid === 'F12') {
      if (!st.changed) return 'CANCEL';
      return 'F3';
    }
    if (r.aid === 'PAGEDOWN') { if (top + 9 < recs.length) top += 9; else message = 'You have reached the bottom of the list.'; continue; }
    if (r.aid === 'PAGEUP') { if (top > 0) top = Math.max(0, top - 9); else message = 'You have reached the top of the list.'; continue; }
    if (r.aid === 'F14') { await keywordEditor(ctx, 'Select File Keywords', `File ${st.file} member ${st.mbr}`, st.model.fileKws); st.changed = true; continue; }
    // Línea de alta
    const aopt = (r.fields.AOPT || '').trim();
    if (aopt) {
      if (aopt !== '1') { message = err(`Option ${aopt} not valid on the add line; use 1=Add.`); continue; }
      const name = up(r.fields.AREC);
      const type = up(r.fields.ATYPE) || 'RECORD';
      if (!NAME_RE.test(name)) { message = err('Type a valid record name.'); continue; }
      if (recs.some((x) => x.name === name)) { message = err(`Record ${name} already exists.`); continue; }
      if (!['RECORD', 'SFL', 'SFLCTL', 'WINDOW'].includes(type)) { message = err(`Type ${type} not valid; use RECORD, SFL, SFLCTL or WINDOW.`); continue; }
      let related = '';
      if (type === 'SFLCTL') {
        related = await promptValue(ctx, 'Add New Record', 'Related subfile record', 10, recs.filter((x) => recordType(x) === 'SFL').map((x) => x.name)[0] || '');
        if (related === null) continue;
        related = up(related);
        if (!recs.some((x) => x.name === related && recordType(x) === 'SFL')) { message = err(`Subfile record ${related} not found; add it first with type SFL.`); continue; }
      }
      const rec = newRecord(name, type, related);
      if (type === 'SFLCTL') { const i = recs.findIndex((x) => x.name === related); recs.splice(i + 1, 0, rec); } else recs.push(rec);
      st.changed = true;
      const d = await designImage(ctx, st, rec);
      message = d;
      continue;
    }
    // Opciones sobre registros
    const sels = page.map((rc, i) => ({ rc, opt: (r.fields[`O${i}`] || '').trim() })).filter((x) => x.opt);
    const del = sels.filter((x) => x.opt === '4');
    if (del.length && await confirmDelete(ctx, 'Confirm Delete of Records', 'Opt  Record', del.map((x) => x.rc.name))) {
      st.model.records = recs.filter((x) => !del.some((d) => d.rc === x));
      st.changed = true;
      message = { text: `${del.length} record(s) deleted.` };
    }
    for (const { rc, opt } of sels) {
      if (opt === '4') continue;
      if (opt === '12') { message = await designImage(ctx, st, rc); continue; }
      if (opt === '8') { await keywordEditor(ctx, 'Select Record Keywords', `Record ${rc.name}  (${recordType(rc)})`, rc.kws); st.changed = true; continue; }
      if (opt === '2') { await commentsEditor(ctx, st, rc); continue; }
      if (opt === '3' || opt === '7') {
        const nn = await promptValue(ctx, opt === '3' ? 'Copy Record' : 'Rename Record', 'New record', 10, '');
        if (nn === null) continue;
        const name = up(nn);
        if (!NAME_RE.test(name) || st.model.records.some((x) => x.name === name)) { message = err(`Record name ${name} not valid or already exists.`); continue; }
        if (opt === '7') rc.name = name;
        else st.model.records.splice(st.model.records.indexOf(rc) + 1, 0, JSON.parse(JSON.stringify({ ...rc, name })));
        st.changed = true;
        message = { text: `Record ${rc.name} ${opt === '3' ? 'copied to' : 'renamed to'} ${name}.` };
        continue;
      }
      message = err(`Option ${opt} not valid.`);
    }
  }
}

async function promptValue(ctx, title, label, len, value) {
  const p = new Panel({ fn: 'SDA-PROMPT', keys: ['F12'] });
  p.title(title);
  p.text(3, 2, 'Type choice, press Enter.', 'b');
  p.label(5, 2, label, 32); p.input('V', 5, 36, len, { value });
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  return r.aid === 'ENTER' ? r.fields.V || '' : null;
}

// Comentarios del registro (líneas * antes de la R) — se guardan como comentarios del archivo si es el primero
async function commentsEditor(ctx, st, rc) {
  rc.comments = rc.comments || [];
  const p = new Panel({ fn: 'SDA-COMMENTS', keys: ['F12'] });
  p.title('Edit Comments');
  p.info(3, 2, 'Record', rc.name, 14);
  p.text(5, 2, 'Type comments, press Enter.', 'b');
  for (let i = 0; i < 12; i++) p.input(`C${i}`, 7 + i, 4, 70, { value: (rc.comments[i] || '').replace(/^\s{0,5}A\*\s?/, ''), lower: true });
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return;
  rc.comments = Array.from({ length: 12 }, (_, i) => r.fields[`C${i}`] || '').filter((x) => x.trim()).map((x) => `     A* ${x}`);
  st.changed = true;
}

// ---------- Editor de palabras clave (archivo, registro o campo) ----------
export async function keywordEditor(ctx, title, subtitle, kws) {
  let top = 0;
  let message = null;
  const N = 13;
  for (;;) {
    const p = new Panel({ fn: 'SDA-KEYWORDS', keys: ['F12', 'PAGEUP', 'PAGEDOWN'] });
    p.title(title);
    p.text(3, 2, subtitle, 'w');
    p.text(5, 2, 'Type keywords and their indicators, press Enter.', 'b');
    p.text(6, 4, 'Indicators: up to three, e.g. N03 or 4050; keyword: e.g. CA03(03 \'Exit\')  DSPATR(HI)  OVERLAY', 'b');
    p.text(8, 2, 'Indicators   Keyword', 'w');
    for (let i = 0; i < N; i++) {
      const k = kws[top + i] || { cond: '', text: '' };
      p.input(`I${i}`, 9 + i, 3, 9, { value: k.cond.trim() });
      p.input(`K${i}`, 9 + i, 15, 64, { value: k.text, lower: true });
    }
    p.more(22, top + N < kws.length + 1);
    p.fkeys('Enter=Accept   F12=Cancel   Page Down=More lines');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F12') return false;
    // Aplicar lo de la página visible
    const page = [];
    let bad = null;
    for (let i = 0; i < N; i++) {
      const ind = up(r.fields[`I${i}`] || '');
      const text = String(r.fields[`K${i}`] || '').trim();
      if (!text) continue;
      if (ind && !/^((N?\d\d)\s*){1,3}$/.test(ind.replace(/\s+/g, ' ').replace(/\s/g, ''))) bad = `Indicators ${ind} not valid.`;
      const parts = (ind.replace(/\s/g, '').match(/N?\d\d/g) || []);
      const cond = parts.map((x) => (x.startsWith('N') ? x : ` ${x}`)).join('');
      page.push({ cond, text: text.toUpperCase().startsWith("'") ? text : text.replace(/^([A-Za-z0-9]+)/, (w) => w.toUpperCase()) });
    }
    if (bad) { message = err(bad); continue; }
    kws.splice(top, Math.min(N, Math.max(0, kws.length - top)), ...page);
    if (r.aid === 'PAGEDOWN') { top += N; continue; }
    if (r.aid === 'PAGEUP') { top = Math.max(0, top - N); continue; }
    return true;
  }
}

// ---------- Imagen de diseño ----------
async function designImage(ctx, st, rec) {
  const backup = JSON.stringify(rec);
  const typ = recordType(rec);
  // El control de subarchivo se diseña viendo también el registro de subarchivo, como en SDA
  const relName = typ === 'SFLCTL' ? (/SFLCTL\((\w+)\)/i.exec(rec.kws.map((k) => k.text).join(' ')) || [])[1] : null;
  const rel = relName ? st.model.records.find((x) => x.name === relName.toUpperCase()) : null;
  let rows = recordImage(rec);
  let message = { text: `Work screen for record ${rec.name}: type constants, +I(n) +O(n) +B(n) +3/+6/+9(n,d) for fields. F3=Exit F4=Fields F10=Database fields F12=Cancel.` };
  let dbFields = [];
  let cursor = null;
  for (;;) {
    const p = new Panel({ fn: 'SDA-IMAGE', keys: ['F3', 'F4', 'F10', 'F12', 'F14'] });
    const relRows = rel ? recordImage(rel) : null;
    for (let r = 0; r < 24; r++) {
      let v = rows[r].slice(1);
      // líneas del subarchivo relacionado, solo como referencia visual
      if (relRows && !rows[r].trim() && relRows[r].trim()) { p.text(r + 1, 2, relRows[r].slice(1).replace(/\s+$/, ''), 'b'); continue; }
      p.input(`L${r}`, r + 1, 2, 79, { value: v.replace(/\s+$/, ''), lower: true, attr: 'g' });
    }
    if (dbFields.length) message = { text: `Database fields: ${dbFields.map((d, i) => `&${i + 1}=${d.name}`).join(' ')}` };
    if (message) p.msg(message);
    message = null;
    if (cursor) p.cursor = cursor;
    const r = await ctx.display(p);
    if (r.aid === 'F12') { Object.assign(rec, JSON.parse(backup)); return { text: `Changes to record ${rec.name} canceled.` }; }
    const newRows = rows.map((old, i) => (r.fields[`L${i}`] === undefined ? old : ` ${String(r.fields[`L${i}`]).padEnd(79).slice(0, 79)}`));
    const res = applyImage(st.model, rec, newRows, { dbFields });
    if (!res.ok) {
      rows = newRows;
      const e = res.errors[0];
      message = { text: e.text + (res.errors.length > 1 ? ` (${res.errors.length - 1} more)` : ''), sev: 30 };
      cursor = [e.row, Math.max(2, e.col)];
      continue;
    }
    cursor = null;
    st.changed = true;
    if (dbFields.length && rec.items.some((it) => it.$placed)) {
      // añadir REF(lib/archivo) a nivel de archivo para los campos de base de datos colocados
      const files = [...new Set(dbFields.map((d) => d.file))];
      const hasRef = st.model.fileKws.find((k) => /^REF\(/i.test(k.text.trim()));
      if (!hasRef && files.length === 1) st.model.fileKws.push({ cond: '', text: `REF(${files[0]})` });
      for (const it of rec.items) if (it.$placed) { const d = dbFields[it.$placed - 1]; if (hasRef && !hasRef.text.toUpperCase().includes(d.file.split('/').pop()) || files.length > 1) it.kws.unshift({ cond: '', text: `REFFLD(${d.name} ${d.file})` }); delete it.$placed; }
      dbFields = [];
    }
    rows = recordImage(rec);
    if (r.aid === 'F3') return { text: `Record ${rec.name} designed: ${rec.items.filter((i) => i.kind === 'F').length} fields, ${rec.items.filter((i) => i.kind === 'C').length} constants.` };
    if (r.aid === 'F4') { message = await workFields(ctx, st, rec); rows = recordImage(rec); continue; }
    if (r.aid === 'F14') { await keywordEditor(ctx, 'Select Record Keywords', `Record ${rec.name}`, rec.kws); continue; }
    if (r.aid === 'F10') { const sel = await selectDbFields(ctx, st); if (sel && sel.length) dbFields = sel; continue; }
  }
}

// F10: campos de un archivo de base de datos para colocarlos con &1, &2…
async function selectDbFields(ctx, st) {
  const f = await promptValue(ctx, 'Select Database Files', 'Database file (biblioteca/archivo)', 21, '');
  if (!f || !f.trim()) return null;
  let d;
  try { d = await describeFile(gw, up(f).includes('/') ? up(f) : `*LIBL/${up(f)}`, ctx.libl); } catch (e) { return null; }
  const file = `${d.lib}/${up(f).replace(/^.*\//, '')}`;
  const fields = d.fields.slice(0, 13);
  const p = new Panel({ fn: 'SDA-DBFLDS', keys: ['F12'] });
  p.title('Select Database Fields');
  p.info(3, 2, 'File', file, 14);
  p.text(5, 2, 'Type options, press Enter.', 'b');
  p.text(6, 4, '1=Display  2=Input  3=Both', 'b');
  p.text(8, 2, 'Opt  Field       Length  Dec  Text', 'w');
  fields.forEach((x, i) => {
    const r = resolveRef({ X: d }, 'X', [], x.name, 0);
    p.input(`O${i}`, 9 + i, 3, 1, {});
    p.text(9 + i, 7, `${padR(x.name, 10)}  ${padL(r.len, 6)}  ${padL(r.type === 'A' ? '' : r.dec, 3)}  ${padR(x.text || '', 40)}`);
  });
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return null;
  const out = [];
  fields.forEach((x, i) => {
    const o = (r.fields[`O${i}`] || '').trim();
    if (!['1', '2', '3'].includes(o)) return;
    const ra = resolveRef({ X: d }, 'X', [], x.name, 0);
    out.push({ name: x.name, file, usage: o === '1' ? 'O' : o === '2' ? 'I' : 'B', len: ra.len, dtype: ra.type, dec: ra.type === 'A' ? '' : String(ra.dec) });
  });
  return out;
}

// ---------- F4: Trabajar con campos ----------
async function workFields(ctx, st, rec) {
  let message = null;
  for (;;) {
    const fields = rec.items.filter((i) => i.kind === 'F');
    const p = new Panel({ fn: 'SDA-FIELDS', keys: ['F3', 'F12'] });
    p.title('Work with Fields');
    p.info(3, 2, 'Record', rec.name, 14);
    p.text(5, 2, 'Type changes, press Enter.', 'b');
    p.text(6, 4, '1=Select keywords   4=Delete     Use: I=Input O=Output B=Both H=Hidden P=Program-to-system', 'b');
    p.text(8, 2, 'Opt  Field       Use  Type  Length  Dp  Row  Col  Ref', 'w');
    p.input('AOPT', 9, 3, 1, {}); p.input('ANAME', 9, 7, 10, {}); p.input('AUSE', 9, 20, 1, { value: '' }); p.input('ATYPE', 9, 25, 1, {}); p.input('ALEN', 9, 30, 5, {}); p.input('ADEC', 9, 38, 2, {});
    p.text(9, 44, '<- 1=Add a hidden or program-to-system field', 'b');
    fields.slice(0, 11).forEach((f, i) => {
      const r = 10 + i;
      p.input(`O${i}`, r, 3, 1, {});
      p.input(`N${i}`, r, 7, 10, { value: f.name });
      p.input(`U${i}`, r, 20, 1, { value: f.usage || 'B' });
      p.input(`T${i}`, r, 25, 1, { value: effType(f) || 'A' });
      p.input(`L${i}`, r, 30, 5, { value: String(effLen(f)) });
      p.input(`D${i}`, r, 38, 2, { value: String(effDec(f)) });
      p.text(r, 43, `${padL(f.row ?? '', 3)}  ${padL(f.col ?? '', 3)}  ${f.ref === 'R' ? 'R' : ''}`);
    });
    p.more(21, fields.length > 11);
    p.fkeys('F3=Exit   F12=Cancel');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F12') return null;
    // Cambios en la lista
    let bad = null;
    const removes = [];
    const kwSel = [];
    fields.slice(0, 11).forEach((f, i) => {
      const name = up(r.fields[`N${i}`]);
      const use = up(r.fields[`U${i}`]) || 'B';
      const type = up(r.fields[`T${i}`]);
      const len = Number(r.fields[`L${i}`]);
      const dec = String(r.fields[`D${i}`] ?? '').trim();
      const opt = (r.fields[`O${i}`] || '').trim();
      if (!NAME_RE.test(name)) { bad = `Field name ${name} not valid.`; return; }
      if (!['I', 'O', 'B', 'H', 'P', 'M'].includes(use)) { bad = `Use ${use} not valid for field ${name}.`; return; }
      if (name !== f.name && rec.items.some((x) => x !== f && x.kind === 'F' && x.name === name)) { bad = `Field ${name} already defined.`; return; }
      f.name = name;
      f.usage = use;
      if (f.ref !== 'R' || len !== effLen(f) || type !== effType(f)) {
        if (len > 0) { f.len = len; f.ref = f.ref === 'R' ? 'R' : ''; }
        f.dtype = type === 'A' ? '' : type;
        f.dec = ['', 'A'].includes(type) && !dec ? '' : dec;
      }
      if (['H', 'P'].includes(use)) { f.row = null; f.col = null; }
      if (opt === '4') removes.push(f);
      if (opt === '1') kwSel.push(f);
    });
    if (bad) { message = err(bad); continue; }
    if ((r.fields.AOPT || '').trim() === '1') {
      const name = up(r.fields.ANAME);
      const use = up(r.fields.AUSE) || 'H';
      if (!NAME_RE.test(name) || rec.items.some((x) => x.kind === 'F' && x.name === name)) { message = err(`Field name ${name} not valid or already defined.`); continue; }
      if (!['H', 'P', 'M'].includes(use)) { message = err('Fields without a position must be H, P or M; place visible fields in the image.'); continue; }
      const type = up(r.fields.ATYPE);
      rec.items.push({ kind: 'F', name, cond: '', ref: '', len: Number(r.fields.ALEN) || 1, dtype: type === 'A' ? '' : type, dec: String(r.fields.ADEC || '').trim(), usage: use, row: null, col: null, kws: [] });
    }
    rec.items = rec.items.filter((x) => !removes.includes(x));
    for (const f of kwSel) await keywordEditor(ctx, 'Select Field Keywords', `Field ${f.name}  usage ${f.usage}  length ${effLen(f)}`, f.kws);
    st.changed = true;
    if (r.aid === 'F3' || (!kwSel.length && !removes.length && !(r.fields.AOPT || '').trim())) return { text: `Fields of record ${rec.name} updated.` };
  }
}

// ---------- Salida: guardar el fuente y crear el archivo de pantalla ----------
async function exitScreens(ctx, st) {
  let vals = { SAVE: 'Y', FILE: st.file, LIB: st.lib, MBR: st.mbr, TEXT: st.text, REPLACE: 'Y', CREATE: 'Y', BATCH: 'Y', PROMPT: 'N', DSPF: st.mbr, DLIB: st.lib, RPLF: 'Y' };
  let message = null;
  for (;;) {
    const p = new Panel({ fn: 'SDA-EXIT', keys: ['F3', 'F12'] });
    p.title('Exit SDA Work Screen');
    p.text(3, 2, 'Type choices, press Enter.', 'b');
    const line = (row, ind, label, name, len, hint) => { p.label(row, 2 + ind, label, 36 - ind); p.input(name, row, 39, len, { value: vals[name], lower: name === 'TEXT' }); if (hint) p.text(row, 52, hint, 'b'); };
    line(5, 0, 'Save DDS - Create display file', 'SAVE', 1, 'Y=Yes, N=No');
    p.text(7, 4, 'For choice Y=Yes:', 'g');
    line(8, 4, 'Source file', 'FILE', 10, 'F4 for list');
    line(9, 6, 'Library', 'LIB', 10, 'Name, *CURLIB');
    line(10, 4, 'Member', 'MBR', 10, 'F4 for list');
    line(11, 4, 'Text', 'TEXT', 50, '');
    line(13, 4, 'Replace member', 'REPLACE', 1, 'Y=Yes, N=No');
    line(14, 4, 'Create display file', 'CREATE', 1, 'Y=Yes, N=No');
    line(15, 4, 'Submit create job in batch', 'BATCH', 1, 'Y=Yes, N=No');
    line(16, 4, 'Prompt create command', 'PROMPT', 1, 'Y=Yes, N=No');
    line(17, 4, 'Display file', 'DSPF', 10, 'Name');
    line(18, 6, 'Library', 'DLIB', 10, 'Name, *CURLIB');
    line(19, 4, 'Replace existing file', 'RPLF', 1, 'Y=Yes, N=No');
    p.fkeys('F3=Exit   F4=Prompt   F12=Cancel');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F12') { const back = await workRecords(ctx, st); if (back === 'CANCEL') return { text: 'Changes not saved.' }; continue; }
    vals = Object.fromEntries(Object.keys(vals).map((k) => [k, k === 'TEXT' ? String(r.fields[k] ?? '').trim() : up(r.fields[k] ?? vals[k])]));
    if (vals.SAVE !== 'Y') return { text: `Member ${st.mbr} not saved.` };
    try {
      const lib = vals.LIB === '*CURLIB' ? ctx.resolveLib('*CURLIB') : vals.LIB;
      if (!(await findObject(gw, vals.FILE, '*FILE', lib, []))) { message = err(`Source file ${vals.FILE} in ${lib} not found.`); continue; }
      const exists = !!(await findMember(gw, lib, vals.FILE, vals.MBR, []).catch(() => null));
      if (exists && vals.REPLACE !== 'Y') { message = err(`Member ${vals.MBR} already exists; type Y to replace it.`); continue; }
      if (!exists) await addMember(lib, vals.FILE, vals.MBR, 'DSPF', vals.TEXT);
      else await updateMemberInfo(lib, vals.FILE, vals.MBR, { type: 'DSPF', text: vals.TEXT });
      const dds = generateDds(st.model);
      await writeMember(lib, vals.FILE, vals.MBR, dds.map((text, i) => ({ seq: (i + 1) * 100, dat: 0, text })));
      const saved = `Member ${vals.MBR} saved in file ${vals.FILE} in library ${lib} (${dds.length} records).`;
      if (vals.CREATE !== 'Y') return { text: saved };
      const dlib = vals.DLIB === '*CURLIB' ? ctx.resolveLib('*CURLIB') : vals.DLIB;
      if (vals.RPLF !== 'Y' && await findObject(gw, vals.DSPF, '*FILE', dlib, [])) return { text: `${saved} File ${vals.DSPF} not replaced.`, sev: 10 };
      const cmd = `CRTDSPF FILE(${dlib}/${vals.DSPF}) SRCFILE(${lib}/${vals.FILE}) SRCMBR(${vals.MBR})${vals.TEXT ? ` TEXT(${quote(vals.TEXT)})` : ''}`;
      if (vals.BATCH === 'Y') {
        const m = await execFromLine(ctx, `SBMJOB CMD(${cmd}) JOB(${vals.DSPF})`, vals.PROMPT === 'Y');
        return m || { text: saved };
      }
      const m = await execFromLine(ctx, cmd, vals.PROMPT === 'Y');
      return m || { text: saved };
    } catch (e) { message = toMsg(e); }
  }
}

// ======================= 3. Probar archivos de pantalla =======================
async function testDisplayPrompt(ctx, { file } = {}) {
  let vals = { FILE: (file && file.obj) || '', LIB: (file && file.lib) || '*LIBL', REC: '', ADD: '' };
  let message = null;
  for (;;) {
    const p = new Panel({ fn: 'SDA-TEST', keys: ['F3', 'F12'] });
    p.title('Test Display File');
    p.text(3, 2, 'Type choices, press Enter.', 'b');
    p.label(5, 2, 'Display file', 32); p.input('FILE', 5, 36, 10, { value: vals.FILE }); p.text(5, 50, 'Name', 'b');
    p.label(6, 4, 'Library', 30); p.input('LIB', 6, 38, 10, { value: vals.LIB }); p.text(6, 50, 'Name, *LIBL, *CURLIB', 'b');
    p.label(8, 2, 'Record to be tested', 32); p.input('REC', 8, 36, 10, { value: vals.REC }); p.text(8, 50, 'Name', 'b');
    p.label(10, 2, 'Additional records to display', 32); p.input('ADD', 10, 36, 10, { value: vals.ADD }); p.text(10, 50, 'Name', 'b');
    p.fkeys('F3=Exit   F12=Cancel');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    vals = { FILE: up(r.fields.FILE), LIB: up(r.fields.LIB) || '*LIBL', REC: up(r.fields.REC), ADD: up(r.fields.ADD) };
    try {
      const fo = await findObject(gw, vals.FILE, '*FILE', vals.LIB === '*CURLIB' ? ctx.resolveLib('*CURLIB') : vals.LIB, ctx.libl);
      if (!fo) throw new CLError('CPF9812', vals.FILE, vals.LIB);
      const d = await objectData(gw, fo.LIB, vals.FILE, '*FILE');
      if (!d || d.kind !== 'DSPF') { message = err(`File ${vals.FILE} in ${fo.LIB} is not a display file.`); continue; }
      if (!vals.REC) vals.REC = Object.keys(d.formats).find((k) => !d.formats[k].sfl) || Object.keys(d.formats)[0];
      if (!d.formats[vals.REC]) { message = err(`Record ${vals.REC} not found in file ${vals.FILE}.`); continue; }
      const res = await testRecord(ctx, fo.LIB, vals.FILE, d, vals.REC, vals.ADD && d.formats[vals.ADD] ? vals.ADD : null);
      if (res === 'F3') return null;
      message = res;
    } catch (e) { message = toMsg(e); }
  }
}

async function testRecord(ctx, lib, file, dspf, recName, addName) {
  const { displayFormat } = await import('../runtime/dspf.js');
  const fmt = dspf.formats[recName];
  const outFields = fmt.fields.filter((f) => f.usage !== 'I');
  let values = Object.fromEntries(fmt.fields.map((f) => [f.name, f.rpgType && f.rpgType.t === 'zoned' ? 0 : '']));
  let inds = '';
  for (;;) {
    // Valores de salida e indicadores
    const p = new Panel({ fn: 'SDA-TESTOUT', keys: ['F3', 'F12'] });
    p.title('Set Test Output Data');
    p.info(3, 2, 'Record', recName, 14); p.info(3, 42, 'Display file', `${lib}/${file}`, 14);
    p.text(5, 2, 'Type indicators and values, press Enter.', 'b');
    p.label(7, 2, 'Indicators set on (e.g. 03 50 90)', 36); p.input('IND', 7, 40, 30, { value: inds });
    p.text(9, 2, 'Field       Use  Length  Value', 'w');
    outFields.slice(0, 11).forEach((f, i) => {
      p.text(10 + i, 2, `${padR(f.name, 10)}   ${f.usage}   ${padL(f.len, 6)}`);
      p.input(`V${i}`, 10 + i, 26, Math.min(50, f.len + (f.dec ? 1 : 0) + 1), { value: String(values[f.name] ?? ''), lower: true });
    });
    p.fkeys('F3=Exit   F12=Cancel');
    const r = await ctx.display(p);
    if (r.aid === 'F3') return 'F3';
    if (r.aid === 'F12') return null;
    inds = String(r.fields.IND || '').trim();
    const ind = {};
    for (const n of inds.split(/[\s,]+/).filter(Boolean)) if (/^\d\d?$/.test(n)) ind[n.padStart(2, '0')] = '1';
    outFields.slice(0, 11).forEach((f, i) => { const v = r.fields[`V${i}`] ?? ''; values[f.name] = f.rpgType && f.rpgType.t === 'zoned' ? Number(String(v).replace(',', '.')) || 0 : v; });
    // Visualización real del registro (con el registro adicional debajo si se pidió)
    ctx.session.dspfBuf = new Map();
    if (addName) await displayFormat(ctx, `$SDA$${file}`, dspf, addName, values, ind, 'write');
    const out = await displayFormat(ctx, `$SDA$${file}`, dspf, recName, values, ind, 'exfmt');
    // Datos de entrada devueltos
    const q = new Panel({ fn: 'SDA-TESTIN', keys: ['F3', 'F12'] });
    q.title('Display Test Input Data');
    q.info(3, 2, 'Record', recName, 14); q.info(4, 2, 'Key pressed', out ? out.aid : '', 14);
    const onInds = out ? Object.entries(out.ind || {}).filter(([, v]) => v === '1').map(([k]) => k) : [];
    q.info(5, 2, 'Indicators on', onInds.join(' ') || '(none)', 14);
    q.text(7, 2, 'Field       Use  Length  Value', 'w');
    const inFields = fmt.fields.filter((f) => f.usage !== 'O' && f.usage !== 'H');
    inFields.slice(0, 13).forEach((f, i) => q.text(8 + i, 2, `${padR(f.name, 10)}   ${f.usage}   ${padL(f.len, 6)}  ${String(out && out.values[f.name] !== undefined ? out.values[f.name] : '').slice(0, 50)}`));
    if (!inFields.length) q.text(8, 2, '(No input fields in record)');
    q.fkeys('Enter=Test again   F3=Exit   F12=Cancel');
    const z = await ctx.display(q);
    if (out) for (const [k, v] of Object.entries(out.values || {})) values[k] = v;
    if (z.aid === 'F3') return 'F3';
    if (z.aid === 'F12') return null;
  }
}

// ======================= 2. Diseñar menús =======================
async function designMenusPrompt(ctx, { srcfile, srcmbr } = {}) {
  let vals = { MENU: srcmbr && srcmbr !== '*SELECT' ? srcmbr : '', LIB: (srcfile && srcfile.lib && srcfile.lib !== '*LIBL') ? srcfile.lib : '*CURLIB', FILE: (srcfile && srcfile.obj) || 'QDDSSRC' };
  let message = null;
  for (;;) {
    const p = new Panel({ fn: 'SDA-MENUS', keys: ['F3', 'F12'] });
    p.title('Design Menus');
    p.text(3, 2, 'Type choices, press Enter.', 'b');
    p.label(5, 2, 'Menu', 32); p.input('MENU', 5, 36, 10, { value: vals.MENU }); p.text(5, 50, 'Name', 'b');
    p.label(6, 4, 'Library', 30); p.input('LIB', 6, 38, 10, { value: vals.LIB }); p.text(6, 50, 'Name, *CURLIB', 'b');
    p.label(8, 2, 'Source file', 32); p.input('FILE', 8, 36, 10, { value: vals.FILE }); p.text(8, 50, 'Name', 'b');
    p.fkeys('F3=Exit   F12=Cancel');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    vals = { MENU: up(r.fields.MENU), LIB: up(r.fields.LIB) || '*CURLIB', FILE: up(r.fields.FILE) || 'QDDSSRC' };
    if (!NAME_RE.test(vals.MENU) || vals.MENU.length > 8) { message = err('Type a menu name of up to 8 characters (the message file is named menuQQ).'); continue; }
    try {
      const lib = vals.LIB === '*CURLIB' ? ctx.resolveLib('*CURLIB') : vals.LIB;
      if (!(await libExists(lib))) throw new CLError('CPF2110', lib);
      if (!(await findObject(gw, vals.FILE, '*FILE', lib, []))) { const { createSourceFile } = await import('../objects.js'); await createSourceFile(lib, vals.FILE); }
      const res = await designMenu(ctx, lib, vals.FILE, vals.MENU);
      if (res === 'F3') return null;
      message = res;
    } catch (e) { message = toMsg(e); }
  }
}

async function designMenu(ctx, lib, file, menu) {
  const loaded = await loadModel(ctx, lib, file, menu);
  const model = loaded.model && loaded.model.records.length ? loaded.model : menuTemplate(menu);
  const cmds = new Map();
  try {
    for (const l of await readMember(gw, lib, file, `${menu}QQ`)) { const m = /^\s*(\d{1,2})\s+(.*)$/.exec(l.text); if (m) cmds.set(Number(m[1]), m[2].trim()); }
  } catch { /* menú nuevo */ }
  let vals = { TEXT: 'Y', CMDS: 'Y' };
  for (;;) {
    const p = new Panel({ fn: 'SDA-DEFMENU', keys: ['F3', 'F12'] });
    p.title('Define Menu');
    p.info(3, 2, 'Menu', menu, 14); p.info(4, 4, 'Library', lib, 12);
    p.text(6, 2, 'Type choices, press Enter.', 'b');
    p.label(8, 2, 'Change menu text', 32); p.input('TEXT', 8, 36, 1, { value: vals.TEXT }); p.text(8, 50, 'Y=Yes, N=No', 'b');
    p.label(9, 2, 'Change menu commands', 32); p.input('CMDS', 9, 36, 1, { value: vals.CMDS }); p.text(9, 50, 'Y=Yes, N=No', 'b');
    p.fkeys('F3=Exit   F12=Cancel');
    const r = await ctx.display(p);
    if (r.aid === 'F12') return null;
    if (r.aid === 'F3') return exitMenu(ctx, { lib, file, menu, model, cmds });
    vals = { TEXT: up(r.fields.TEXT) || 'N', CMDS: up(r.fields.CMDS) || 'N' };
    if (vals.TEXT === 'Y') {
      const st = { model, changed: false };
      const rec = model.records[0];
      const res = await menuImage(ctx, st, rec);
      if (res && res.cancel) continue;
    }
    if (vals.CMDS === 'Y') await menuCommands(ctx, menu, cmds);
    return exitMenu(ctx, { lib, file, menu, model, cmds });
  }
}

// Texto del menú: imagen solo de constantes
async function menuImage(ctx, st, rec) {
  const backup = JSON.stringify(rec);
  let rows = recordImage(rec);
  let message = { text: 'Type the menu text (title, options and instructions). F3=Exit F12=Cancel.' };
  for (;;) {
    const p = new Panel({ fn: 'SDA-MNUTEXT', keys: ['F3', 'F12'] });
    for (let r = 0; r < 20; r++) p.input(`L${r}`, r + 1, 2, 79, { value: rows[r].slice(1).replace(/\s+$/, ''), lower: true, attr: 'g' });
    p.text(21, 2, 'Selection or command', 'g'); p.text(22, 2, '===>', 'g');
    p.text(23, 2, 'F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel', 'b');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F12') { Object.assign(rec, JSON.parse(backup)); return { cancel: true }; }
    const newRows = rows.map((old, i) => (i < 20 ? ` ${String(r.fields[`L${i}`] ?? '').padEnd(79).slice(0, 79)}` : ' '.repeat(80)));
    if (newRows.some((l) => /\+[IOB369]/i.test(l))) { rows = newRows; message = err('Menus contain constants only; fields (+I, +O, +B…) are not allowed.'); continue; }
    const res = applyImage(st.model, rec, newRows);
    if (!res.ok) { rows = newRows; message = err(res.errors[0].text); continue; }
    rows = recordImage(rec);
    if (r.aid === 'F3') return null;
  }
}

async function menuCommands(ctx, menu, cmds) {
  let top = 1;
  for (;;) {
    const p = new Panel({ fn: 'SDA-MNUCMD', keys: ['F3', 'F12', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Define Menu Commands');
    p.info(3, 2, 'Menu', menu, 14);
    p.text(5, 2, 'Type commands, press Enter.', 'b');
    p.text(7, 2, 'Option  Command', 'w');
    for (let i = 0; i < 12; i++) {
      const n = top + i;
      if (n > 99) break;
      p.text(8 + i, 3, String(n).padStart(2, '0'), 'g');
      p.input(`C${n}`, 8 + i, 10, 70, { value: cmds.get(n) || '', lower: true });
    }
    p.more(20, top + 12 <= 99);
    p.fkeys('F3=Exit   F12=Cancel   Page Down=Options 13-99');
    const r = await ctx.display(p);
    if (r.aid === 'F12') return;
    for (let i = 0; i < 12; i++) {
      const n = top + i;
      if (r.fields[`C${n}`] === undefined) continue;
      const v = String(r.fields[`C${n}`]).trim();
      if (v) cmds.set(n, v); else cmds.delete(n);
    }
    if (r.aid === 'PAGEDOWN') { if (top + 12 <= 99) top += 12; continue; }
    if (r.aid === 'PAGEUP') { top = Math.max(1, top - 12); continue; }
    return;
  }
}

async function exitMenu(ctx, { lib, file, menu, model, cmds }) {
  const p = new Panel({ fn: 'SDA-EXITMNU', keys: ['F12'] });
  p.title('Exit SDA Menus');
  p.text(3, 2, 'Type choices, press Enter.', 'b');
  p.label(5, 2, 'Save menu source', 36); p.input('SAVE', 5, 39, 1, { value: 'Y' }); p.text(5, 52, 'Y=Yes, N=No', 'b');
  p.label(6, 2, 'Create menu objects', 36); p.input('CRT', 6, 39, 1, { value: 'Y' }); p.text(6, 52, 'Y=Yes, N=No', 'b');
  p.label(8, 4, 'Source file', 34); p.text(8, 39, file, 'w');
  p.label(9, 6, 'Library', 32); p.text(9, 39, lib, 'w');
  p.label(10, 4, 'Members', 34); p.text(10, 39, `${menu} (MNUDDS), ${menu}QQ (MNUCMD)`, 'w');
  p.label(11, 4, 'Objects', 34); p.text(11, 39, `${menu} *FILE, ${menu}QQ *MSGF, ${menu} *MENU`, 'w');
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER' || up(r.fields.SAVE) !== 'Y') return { text: `Menu ${menu} not saved.` };
  return saveMenu(ctx, { lib, file, menu, model, cmds, create: up(r.fields.CRT) === 'Y' });
}

/** Guarda el fuente del menú y crea *FILE + *MSGF + *MENU (también lo usa la prueba). */
export async function saveMenu(ctx, { lib, file, menu, model, cmds, create = true }) {
  const { runCommand } = await import('../commands/registry.js');
  const put = async (mbr, type, text, lines) => {
    if (!(await findMember(gw, lib, file, mbr, []).catch(() => null))) await addMember(lib, file, mbr, type, text);
    else await updateMemberInfo(lib, file, mbr, { type, text });
    await writeMember(lib, file, mbr, lines.map((t, i) => ({ seq: (i + 1) * 100, dat: 0, text: t })));
  };
  await put(menu, 'MNUDDS', `Menu ${menu}`, generateDds(model));
  await put(`${menu}QQ`, 'MNUCMD', `Commands for menu ${menu}`, [...cmds.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${String(n).padStart(2, '0')}  ${c}`));
  if (!create) return { text: `Menu source ${menu} saved in ${lib}/${file}.` };
  const run = (c) => runCommand(ctx, c, { noAutoPrompt: true, log: true });
  await run(`CRTDSPF FILE(${lib}/${menu}) SRCFILE(${lib}/${file}) SRCMBR(${menu})`);
  await run(`DLTMSGF MSGF(${lib}/${menu}QQ)`).catch(() => {});
  await run(`CRTMSGF MSGF(${lib}/${menu}QQ) TEXT('Commands for menu ${menu}')`);
  for (const [n, c] of cmds) await run(`ADDMSGD MSGID(USR${String(n).padStart(4, '0')}) MSGF(${lib}/${menu}QQ) MSG(${quote(c)})`);
  await run(`DLTMNU MENU(${lib}/${menu})`).catch(() => {});
  await run(`CRTMNU MENU(${lib}/${menu}) TYPE(*DSPF) DSPF(${lib}/${menu}) MSGF(${lib}/${menu}QQ)`);
  return { id: 'CPC2205', text: `Menu ${menu} created in library ${lib}.` };
}

// ======================= GO de un menú de usuario (*MENU TYPE(*DSPF)) =======================
const COLOR_ATTR = { blue: 'b', white: 'w', green: 'g', red: 'r', turquoise: 't', yellow: 'y', pink: 'p' };
export async function showUserMenu(ctx, lib, name, data) {
  if (data.type === '*PGM') {
    const { callProgram } = await import('../runtime/call.js');
    await callProgram(ctx, data.pgm.name, data.pgm.lib, []);
    return null;
  }
  const fo = await findObject(gw, data.dspf.name, '*FILE', data.dspf.lib, ctx.libl);
  const dspf = fo ? await objectData(gw, fo.LIB, data.dspf.name, '*FILE') : null;
  if (!dspf || !dspf.formats) throw new CLError('CPF6AC5', `Display file ${data.dspf.name} for menu ${name} not found.`);
  const fmt = dspf.formats[name] || Object.values(dspf.formats)[0];
  const msgfQ = { lib: data.msgf.lib, obj: data.msgf.name };
  const { getMsgd } = await import('../msgf.js');
  let message = null;
  let cmdValue = '';
  const state = {};
  const prevCur = ctx.job.curlib;
  if (data.curlib && data.curlib !== '*NOCHG') ctx.job.curlib = data.curlib === '*MNULIB' ? lib : data.curlib;
  try {
    for (;;) {
      const p = new Panel({ fn: `MNU-${name}`, keys: ['F3', 'F4', 'F9', 'F12', 'F16'] });
      for (const c of fmt.constants) {
        if (c.row === null || (c.cond && c.cond.length)) continue;
        const hi = (c.attrs.dspatr || []).some((d) => d.attr === 'HI' && !d.cond.length);
        const attr = c.attrs.color ? COLOR_ATTR[c.attrs.color] || 'g' : hi ? 'w' : 'g';
        p.text(c.row, c.col, c.special ? (c.special === 'SYSNAME' ? SYS.name : c.special === 'DATE' ? sysDate() : c.special === 'TIME' ? sysTime() : ctx.job.user) : c.text, attr);
      }
      if (data.cmdlin !== '*NONE') {
        p.text(19, 2, 'Selection or command', 'g');
        p.cmdLine(20, 'CMD', data.cmdlin === '*SHORT' ? 73 : 153, cmdValue);
      } else {
        p.text(19, 2, 'Selection', 'g');
        p.text(20, 2, '===>', 'g'); p.input('CMD', 20, 7, 2, { value: cmdValue });
      }
      p.fkeys('F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel', 'F16=IBM i Main menu');
      if (message) p.msg(message);
      message = null;
      cmdValue = '';
      const r = await ctx.display(p);
      const cmd = (r.fields.CMD || '').trim();
      if (r.aid === 'F3' || r.aid === 'F12') return r.aid;
      if (r.aid === 'F16') { const { goMenu } = await import('./menus.js'); if ((await goMenu(ctx, 'MAIN')) === 'F3') return 'F3'; continue; }
      if (r.aid === 'F9') { const { retrieve } = await import('./common.js'); cmdValue = retrieve(ctx.session, state) || ''; continue; }
      if (!cmd) continue;
      if (/^\d{1,2}$/.test(cmd)) {
        const n = Number(cmd);
        if (n === 90 && !(await getMsgd(ctx, 'USR0090', msgfQ).catch(() => null))) { message = await execFromLine(ctx, 'SIGNOFF'); continue; }
        const d = await getMsgd(ctx, `USR${String(n).padStart(4, '0')}`, msgfQ).catch(() => null);
        if (!d) { message = { id: 'CPD6A01', text: msgText('CPD6A01', cmd), sev: 30 }; cmdValue = cmd; continue; }
        message = await execFromLine(ctx, d.MSG || d.msg || d.text, r.aid === 'F4');
        continue;
      }
      if (data.cmdlin === '*NONE') { message = err('Only option numbers can be typed on this menu.'); continue; }
      message = await execFromLine(ctx, cmd, r.aid === 'F4');
    }
  } finally {
    ctx.job.curlib = prevCur;
  }
}
