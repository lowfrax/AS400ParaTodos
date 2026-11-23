// Modelo de SDA (Screen Design Aid, 5770-WDS): fuente DDS de archivos de pantalla y de menús ↔ registros, imagen.
//
// A diferencia de parseDSPF (que prepara la ejecución), aquí se conserva el texto original de cada palabra clave
// y sus indicadores de condición para poder volver a escribir el fuente sin perder nada.
//
// Imagen de diseño (como la "pantalla de trabajo" de SDA):
//   - Las constantes se escriben tal cual; cada palabra es una constante salvo que vaya entre apóstrofos.
//   - Campos nuevos: el signo + va en la posición del atributo, seguido de
//       +I(n) +O(n) +B(n)  alfanuméricos de entrada / salida / ambos   (o la letra repetida: +BBBBB)
//       +3(n,d) +6(n,d) +9(n,d)  numéricos de entrada / salida / ambos  (o el dígito repetido: +999)
//   - Los campos existentes se ven como IIII / OOOO / BBBB / 3333 / 6666 / 9999.
//   - En la posición del atributo (justo antes de un elemento): D=suprimir, H=alta intensidad, R=imagen invertida,
//     U=subrayado, B=parpadeo, N=no visualizar, C=separadores de columna, A=quitar atributos,
//     y en las dos posiciones anteriores CB CG CP CR CT CW CY = color.

const col = (s, a, b) => (s.length >= a ? s.slice(a - 1, b) : '');

/** Divide un fuente DDS (líneas de texto) en archivo → registros → elementos. */
export function parseDdsModel(lines) {
  const model = { comments: [], fileKws: [], records: [] };
  let rec = null;
  let last = null;
  let pending = null; // continuación de palabra clave: { target, cond, text }
  let lastRow = 1;
  let lastEnd = 0;
  const src = lines.map((l) => (typeof l === 'string' ? l : l.text || '')).map((l) => l.replace(/\r$/, ''));
  for (const raw of src) {
    const s = raw.padEnd(80);
    if (!raw.trim()) continue;
    if (col(s, 7, 7) === '*') { if (!rec) model.comments.push(raw); continue; }
    let kwText = col(s, 45, 80).replace(/\s+$/, '');
    if (pending) {
      const cont = pending.mode === '-' ? col(s, 45, 80).replace(/\s+$/, '') : kwText.trimStart();
      pending.kw.text += cont;
      if (/[-+]$/.test(pending.kw.text)) { pending.mode = pending.kw.text.slice(-1); pending.kw.text = pending.kw.text.slice(0, -1); } else pending = null;
      continue;
    }
    const cond = col(s, 8, 16).replace(/\s+$/, '');
    const type = col(s, 17, 17).toUpperCase().trim();
    const name = col(s, 19, 28).trim().toUpperCase();
    const rowS = col(s, 39, 41).trim();
    const colS = col(s, 42, 44).trim();
    let target;
    if (type === 'R') {
      rec = { name, cond, kws: [], items: [] };
      model.records.push(rec);
      last = null;
      target = rec.kws;
      lastRow = 1; lastEnd = 0;
    } else if (!name && !rowS && !colS) {
      target = last ? last.kws : rec ? rec.kws : model.fileKws;
    } else {
      if (!rec) { rec = { name: 'RECORD1', cond: '', kws: [], items: [] }; model.records.push(rec); }
      let row = rowS ? Number(rowS) : null;
      let c = null;
      if (colS) c = colS.startsWith('+') ? lastEnd + 1 + Number(colS.slice(1)) : Number(colS);
      if (row === null && c !== null) row = lastRow;
      const it = {
        kind: name ? 'F' : 'C', name, cond, ref: col(s, 29, 29).toUpperCase().trim(),
        len: Number(col(s, 30, 34).trim() || 0), dtype: col(s, 35, 35).toUpperCase().trim(), dec: col(s, 36, 37).trim(),
        usage: col(s, 38, 38).toUpperCase().trim(), row, col: c, kws: [],
      };
      rec.items.push(it);
      last = it;
      target = it.kws;
      if (row !== null) { lastRow = row; lastEnd = c + displayLen(it, kwText) - 1; }
    }
    if (kwText) {
      // En la línea que define el registro o el elemento, los indicadores son del elemento; en líneas solo de
      // palabras clave, condicionan esa palabra clave.
      const kw = { cond: type === 'R' || name || rowS || colS ? '' : cond, text: kwText };
      target.push(kw);
      if (/[-+]$/.test(kw.text)) { pending = { kw, mode: kw.text.slice(-1) }; kw.text = kw.text.slice(0, -1); }
    }
  }
  return model;
}

/** Texto de una constante: el literal entre apóstrofos (o DATE/TIME/USER/SYSNAME como marcador). */
export function constText(it) {
  const k = (it.kws[0] && it.kws[0].text) || '';
  const m = /^'((?:[^']|'')*)'/.exec(k.trim());
  if (m) return m[1].replace(/''/g, "'");
  const sp = /^(DATE|TIME|USER|SYSNAME)\b/i.exec(k.trim());
  if (sp) return { DATE: 'DD/DD/DD', TIME: 'TT:TT:TT', USER: 'UUUUUUUUUU', SYSNAME: 'SSSSSSSS' }[sp[1].toUpperCase()];
  return '';
}

const NUMERIC = new Set(['S', 'Y', 'F', 'P', 'B']);
/** Longitud / tipo / decimales efectivos (los campos con R en la columna 29 los toman del archivo referido: $len…). */
export const effLen = (it) => Number(it.len || it.$len || 0);
export const effType = (it) => it.dtype || it.$dtype || '';
export const effDec = (it) => (it.dec !== '' && it.dec !== undefined ? it.dec : it.$dec ?? '');
export const isNumericField = (it) => NUMERIC.has(effType(it)) || (!effType(it) && effDec(it) !== '');

/** Carácter de relleno con que SDA muestra un campo según su uso. */
export function fieldChar(it) {
  const u = it.usage || 'B';
  if (isNumericField(it)) return u === 'I' ? '3' : u === 'O' ? '6' : '9';
  return u === 'I' ? 'I' : u === 'O' ? 'O' : 'B';
}

function displayLen(it, kwText) {
  if (it.kind === 'C') return constText({ kws: [{ text: kwText || '' }] }).length || 1;
  return effLen(it) || 1;
}

/** ¿Se ve el elemento en la imagen? (los campos ocultos, de programa a sistema o sin posición no se ven) */
export const visible = (it) => it.row !== null && it.col !== null && (it.kind === 'C' || ['', 'I', 'O', 'B'].includes(it.usage || ''));

export function itemText(it) {
  return it.kind === 'C' ? constText(it) : fieldChar(it).repeat(effLen(it) || 1);
}

/** Imagen 24×80 de un registro (y, opcionalmente, de los registros que se ven a la vez). */
export function recordImage(rec, others = []) {
  const rows = Array.from({ length: 24 }, () => Array(80).fill(' '));
  for (const r of [...others, rec]) {
    for (const it of r.items) {
      if (!visible(it)) continue;
      const t = itemText(it);
      let row = it.row - 1;
      let c = it.col - 1;
      for (const ch of t) {
        if (row > 23) break;
        if (c > 79) { c = 1; row++; if (row > 23) break; }
        rows[row][c++] = ch;
      }
    }
  }
  return rows.map((r) => r.join(''));
}

const ATTR_CODES = { H: 'HI', R: 'RI', U: 'UL', B: 'BL', N: 'ND', C: 'CS' };
const COLOR_CODES = { B: 'BLU', G: 'GRN', P: 'PNK', R: 'RED', T: 'TRQ', W: 'WHT', Y: 'YLW' };

function nextFieldName(model) {
  const used = new Set(model.records.flatMap((r) => r.items.filter((i) => i.kind === 'F').map((i) => i.name)));
  for (let n = 1; ; n++) { const nm = `FLD${String(n).padStart(3, '0')}`; if (!used.has(nm)) return nm; }
}

/**
 * Interpreta la imagen editada de un registro. Devuelve { ok, errors: [{row, col, text}] } y actualiza rec.items.
 * Los elementos existentes que siguen intactos en su posición conservan nombre, palabras clave e indicadores.
 */
export function applyImage(model, rec, rowsIn, { dbFields = [] } = {}) {
  const rows = rowsIn.map((r) => String(r || '').padEnd(80).slice(0, 80));
  const used = rows.map(() => Array(80).fill(false));
  const errors = [];
  const keep = [];
  const hidden = rec.items.filter((it) => !visible(it));
  for (const it of rec.items) {
    if (!visible(it)) continue;
    const t = itemText(it);
    const r = it.row - 1;
    const c = it.col - 1;
    if (r > 23 || c + t.length > 80) { keep.push(it); continue; } // elementos que continúan en otra línea: se respetan
    if (rows[r].slice(c, c + t.length) !== t) continue; // sobrescrito: desaparece y se interpreta el texto nuevo
    for (let i = c; i < c + t.length; i++) used[r][i] = true;
    // Código de mandato en la posición del atributo
    const a = c > 0 ? rows[r][c - 1] : ' ';
    const a2 = c > 1 ? rows[r][c - 2] : ' ';
    if (c > 0 && a !== ' ') {
      const up = a.toUpperCase();
      used[r][c - 1] = true;
      if (a2.toUpperCase() === 'C' && COLOR_CODES[up] && !used[r][c - 2]) {
        used[r][c - 2] = true;
        it.kws = it.kws.filter((k) => !/^COLOR\(/i.test(k.text) || k.cond);
        it.kws.push({ cond: '', text: `COLOR(${COLOR_CODES[up]})` });
      } else if (up === 'D') continue;
      else if (up === 'A') it.kws = it.kws.filter((k) => k.cond || !/^(DSPATR|COLOR)\(/i.test(k.text));
      else if (ATTR_CODES[up]) {
        if (!it.kws.some((k) => !k.cond && new RegExp(`^DSPATR\\(${ATTR_CODES[up]}\\)$`, 'i').test(k.text))) it.kws.push({ cond: '', text: `DSPATR(${ATTR_CODES[up]})` });
      } else { errors.push({ row: r + 1, col: c, text: `Command '${a}' not valid in attribute position.` }); }
    }
    keep.push(it);
  }
  // Texto nuevo
  const added = [];
  for (let r = 0; r < 24; r++) {
    const line = rows[r];
    let i = 0;
    while (i < 80) {
      if (used[r][i] || line[i] === ' ') { i++; continue; }
      const rest = line.slice(i);
      let m;
      if (line[i] === '+' && (m = /^\+([IOB369])(?:\((\d+)(?:,(\d+))?\)|(\1*))/i.exec(rest))) {
        const ch = m[1].toUpperCase();
        const len = m[2] ? Number(m[2]) : 1 + m[4].length;
        const num = '369'.includes(ch);
        const usage = ch === 'I' || ch === '3' ? 'I' : ch === 'O' || ch === '6' ? 'O' : 'B';
        const dec = num ? (m[3] !== undefined ? m[3] : '0') : '';
        if (!len || len > (num ? 63 : 32767)) errors.push({ row: r + 1, col: i + 1, text: `Length ${len} not valid for field.` });
        else if (num && Number(dec) > len) errors.push({ row: r + 1, col: i + 1, text: 'Decimal positions greater than field length.' });
        else added.push({ kind: 'F', name: '', cond: '', ref: '', len, dtype: num ? 'Y' : '', dec, usage, row: r + 1, col: i + 2, kws: [] });
        for (let j = i; j < Math.min(80, i + m[0].length); j++) used[r][j] = true;
        i += m[0].length;
        continue;
      }
      // &n: campo n de la lista de campos de base de datos seleccionados (F10), como en SDA
      if (line[i] === '&' && (m = /^&(\d{1,2})/.exec(rest)) && dbFields[Number(m[1]) - 1]) {
        const d = dbFields[Number(m[1]) - 1];
        added.push({ kind: 'F', name: d.name, cond: '', ref: 'R', len: '', dtype: '', dec: '', usage: d.usage || 'B', row: r + 1, col: i + 2, kws: d.refKw ? [{ cond: '', text: d.refKw }] : [], $len: d.len, $dtype: d.dtype, $dec: d.dec, $placed: Number(m[1]) });
        for (let j = i; j < Math.min(80, i + m[0].length); j++) used[r][j] = true;
        i += m[0].length;
        continue;
      }
      if (line[i] === "'") {
        let j = i + 1;
        let text = '';
        while (j < 80) {
          if (line[j] === "'" && line[j + 1] === "'") { text += "'"; j += 2; continue; }
          if (line[j] === "'") break;
          text += line[j++];
        }
        if (j >= 80) { errors.push({ row: r + 1, col: i + 1, text: 'Ending apostrophe missing for constant.' }); i = 80; continue; }
        if (text.length) added.push({ kind: 'C', name: '', cond: '', ref: '', len: 0, dtype: '', dec: '', usage: '', row: r + 1, col: i + 2, kws: [{ cond: '', text: quote(text) }] });
        for (let k = i; k <= j; k++) used[r][k] = true;
        i = j + 1;
        continue;
      }
      let j = i;
      while (j < 80 && line[j] !== ' ' && !used[r][j]) j++;
      const word = line.slice(i, j);
      added.push({ kind: 'C', name: '', cond: '', ref: '', len: 0, dtype: '', dec: '', usage: '', row: r + 1, col: i + 1, kws: [{ cond: '', text: quote(word) }] });
      i = j;
    }
  }
  for (const it of added) if (it.kind === 'F' && !it.name) it.name = nextFieldName({ records: [...model.records.filter((x) => x !== rec), { items: [...keep, ...added.filter((a) => a.name), ...hidden] }] });
  // Solapamientos (un campo nuevo cuyos datos pisan otro elemento)
  const all = [...keep, ...added].filter(visible).sort((x, y) => x.row - y.row || x.col - y.col);
  for (let k = 1; k < all.length; k++) {
    const p = all[k - 1];
    const q = all[k];
    if (p.row === q.row && p.col + itemText(p).length > q.col - 1 && p.col + itemText(p).length <= 80) {
      errors.push({ row: q.row, col: q.col, text: `${q.kind === 'F' ? `Field ${q.name}` : 'Constant'} overlaps ${p.kind === 'F' ? `field ${p.name}` : 'a constant'}.` });
    }
  }
  const names = new Map();
  for (const it of [...all, ...hidden]) {
    if (it.kind !== 'F') continue;
    if (names.has(it.name)) errors.push({ row: it.row || 1, col: it.col || 1, text: `Field ${it.name} already defined in record ${rec.name}.` });
    names.set(it.name, it);
  }
  if (errors.length) return { ok: false, errors };
  rec.items = [...all, ...hidden];
  return { ok: true, errors: [] };
}

export const quote = (t) => `'${String(t).replace(/'/g, "''")}'`;

// ---------- Generación de DDS ----------
function ddsLine({ cond = '', type = '', name = '', ref = '', len = '', dtype = '', dec = '', usage = '', row = '', col: c = '', kw = '' }) {
  const s = Array(80).fill(' ');
  const put = (pos, text, width, right = false) => {
    let t = String(text ?? '');
    if (!t) return;
    t = right ? t.padStart(width).slice(-width) : t.padEnd(width).slice(0, width);
    for (let i = 0; i < width; i++) s[pos - 1 + i] = t[i];
  };
  put(6, 'A', 1);
  put(8, cond, 9);
  put(17, type, 1);
  put(19, name, 10);
  put(29, ref, 1);
  put(30, len === 0 || len === '0' ? '' : len, 5, true);
  put(35, dtype, 1);
  put(36, dec, 2, true);
  put(38, usage, 1);
  put(39, row, 3, true);
  put(42, c, 3, true);
  put(45, kw, 36);
  return s.join('').replace(/\s+$/, '');
}

/** Una palabra clave (con continuaciones '-' si no cabe en las columnas 45-80). */
function kwLines(base, text) {
  const out = [];
  let t = String(text);
  let first = true;
  while (t.length > 36) {
    out.push(ddsLine({ ...(first ? base : {}), kw: `${t.slice(0, 35)}-` }));
    t = t.slice(35);
    first = false;
  }
  out.push(ddsLine({ ...(first ? base : {}), kw: t }));
  return out;
}

export function generateDds(model) {
  const out = [...model.comments];
  for (const k of model.fileKws) out.push(...kwLines({ cond: k.cond }, k.text));
  for (const rec of model.records) {
    const [k0, ...ks] = rec.kws;
    out.push(...kwLines({ cond: rec.cond, type: 'R', name: rec.name }, k0 ? k0.text : ''));
    for (const k of ks) out.push(...kwLines({ cond: k.cond }, k.text));
    const items = [...rec.items].sort((a, b) => (a.row ?? 999) - (b.row ?? 999) || (a.col ?? 0) - (b.col ?? 0));
    for (const it of items) {
      const base = it.kind === 'F'
        ? { cond: it.cond, name: it.name, ref: it.ref, len: it.ref && !it.len ? '' : it.len, dtype: it.dtype, dec: it.dec, usage: it.usage, row: it.row ?? '', col: it.col ?? '' }
        : { cond: it.cond, row: it.row ?? '', col: it.col ?? '' };
      const [f0, ...fs] = it.kws;
      out.push(...kwLines(base, f0 ? f0.text : ''));
      for (const k of fs) out.push(...kwLines({ cond: k.cond }, k.text));
    }
  }
  return out;
}

/** Plantilla de un registro nuevo según su tipo (RECORD, SFL, SFLCTL, WINDOW). */
export function newRecord(name, type = 'RECORD', related = '') {
  const rec = { name, cond: '', kws: [], items: [] };
  if (type === 'SFL') rec.kws.push({ cond: '', text: 'SFL' });
  if (type === 'SFLCTL') {
    rec.kws.push({ cond: '', text: `SFLCTL(${related || 'SFL01'})` });
    rec.kws.push({ cond: '', text: 'SFLSIZ(0017)' }, { cond: '', text: 'SFLPAG(0016)' });
    rec.kws.push({ cond: '', text: 'OVERLAY' }, { cond: ' 85', text: 'SFLDSPCTL' }, { cond: ' 95', text: 'SFLDSP' }, { cond: ' 75', text: 'SFLCLR' }, { cond: ' 50', text: 'SFLEND(*MORE)' });
  }
  if (type === 'WINDOW') rec.kws.push({ cond: '', text: 'WINDOW(5 10 10 50)' });
  return rec;
}

/** Tipo de registro según sus palabras clave. */
export function recordType(rec) {
  const t = rec.kws.map((k) => k.text.toUpperCase()).join(' ');
  if (/\bSFLCTL\(/.test(t)) return 'SFLCTL';
  if (/(^|\s)SFL(\s|$)/.test(t)) return 'SFL';
  if (/\bWINDOW\(/.test(t)) return 'WINDOW';
  return 'RECORD';
}

// ---------- Menús (MNUDDS) ----------
/** Plantilla de texto de un menú nuevo, como la que propone SDA. */
export function menuTemplate(menu) {
  const rec = { name: menu, cond: '', kws: [{ cond: '', text: 'DSPSIZ(24 80 *DS3)' }], items: [] };
  const c = (row, colN, text, kws = []) => rec.items.push({ kind: 'C', name: '', cond: '', ref: '', len: 0, dtype: '', dec: '', usage: '', row, col: colN, kws: [{ cond: '', text: quote(text) }, ...kws] });
  c(1, 2, menu);
  c(1, 30, 'Menu title', [{ cond: '', text: 'DSPATR(HI)' }]);
  c(3, 2, 'Select one of the following:', [{ cond: '', text: 'COLOR(BLU)' }]);
  for (let i = 1; i <= 3; i++) c(5 + i - 1, 7, `${i}. Option ${i}`);
  c(9, 6, '90. Sign off');
  return { comments: [], fileKws: [{ cond: '', text: 'DSPSIZ(24 80 *DS3)' }, { cond: '', text: 'PRINT' }], records: [{ ...rec, kws: [] }] };
}
