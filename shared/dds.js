// Parser de DDS (Data Description Specifications): archivos físicos (PF), lógicos (LF), de pantalla (DSPF) y de impresora (PRTF).
import { CompileError } from './rpg/lexer.js';

const col = (s, a, b) => s.slice(a - 1, b);

function parseKeywords(text, line) {
  // KW, KW(args), 'constante', con argumentos entre comillas y paréntesis anidados.
  const out = [];
  let i = 0;
  const s = text;
  while (i < s.length) {
    while (s[i] === ' ') i++;
    if (i >= s.length) break;
    if (s[i] === "'") {
      let j = i + 1, v = '';
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") { v += "'"; j += 2; continue; }
        if (s[j] === "'") break;
        v += s[j++];
      }
      out.push({ kw: '$CONST', args: [v] });
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z0-9_#@$*]+/.exec(s.slice(i));
    if (!m) throw new CompileError('CPD7451', `Keyword not valid near '${s.slice(i, i + 10)}'.`, line);
    const kw = m[0].toUpperCase();
    i += m[0].length;
    const args = [];
    if (s[i] === '(') {
      let depth = 1, j = i + 1, cur = '', inQ = false;
      while (j < s.length && depth > 0) {
        const c = s[j];
        if (c === "'" ) { if (inQ && s[j + 1] === "'") { cur += "'"; j += 2; continue; } inQ = !inQ; j++; continue; }
        if (!inQ && c === '(') depth++;
        if (!inQ && c === ')') { depth--; if (depth === 0) break; }
        if (!inQ && c === ' ' && depth === 1) { if (cur) args.push(cur); cur = ''; j++; continue; }
        cur += c;
        j++;
      }
      if (cur) args.push(cur);
      i = j + 1;
    }
    out.push({ kw, args });
  }
  return out;
}

function parseCond(s) {
  const conds = [];
  for (const [a, b] of [[8, 10], [11, 13], [14, 16]]) {
    const c = col(s, a, b);
    const ind = c.slice(1).trim();
    if (ind) conds.push({ ind, not: c[0].toUpperCase() === 'N' });
  }
  return conds;
}

// Une líneas de continuación de literales ('-' o '+' al final del área de palabras clave).
function logicalLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let s = (lines[i] || '').padEnd(80);
    if (s[6] === '*') continue;
    if (!s.trim()) continue;
    if (s[5] !== 'A' && s[5] !== 'a' && s[5] !== ' ') continue;
    let kw = col(s, 45, 80).replace(/\s+$/, '');
    let lineNo = i + 1;
    while ((kw.endsWith('-') || kw.endsWith('+')) && i + 1 < lines.length) {
      const plus = kw.endsWith('+');
      const nxt = (lines[++i] || '').padEnd(80);
      let cont = col(nxt, 45, 80).replace(/\s+$/, '');
      if (plus) cont = cont.replace(/^\s+/, '');
      kw = kw.slice(0, -1) + cont;
    }
    out.push({ s, kw, line: lineNo });
  }
  return out;
}

export function parsePF(lines, refs = {}) {
  const res = { kind: 'PF', format: null, text: '', fields: [], keys: [], unique: false, ref: null };
  let last = null;
  for (const { s, kw, line } of logicalLines(lines)) {
    const type = col(s, 17, 17).toUpperCase().trim();
    const name = col(s, 19, 28).trim().toUpperCase();
    const kws = parseKeywords(kw, line);
    if (!name && !type) {
      // Palabra clave de nivel de archivo o continuación del elemento anterior.
      for (const k of kws) {
        if (k.kw === 'UNIQUE') res.unique = true;
        else if (k.kw === 'REF' && !res.format) res.ref = (k.args[0] || '').toUpperCase();
        else if (last) applyFieldKw(last, k);
      }
      continue;
    }
    if (type === 'R') {
      res.format = name;
      for (const k of kws) if (k.kw === 'TEXT') res.text = k.args[0] || '';
      last = null;
      continue;
    }
    if (type === 'K') { res.keys.push(name); continue; }
    if (type === 'S' || type === 'O') continue;
    let len = Number(col(s, 30, 34).trim() || 0);
    let dtype = col(s, 35, 35).toUpperCase().trim();
    let decS = col(s, 36, 37).trim();
    let varlenRef = false;
    if (col(s, 29, 29).toUpperCase() === 'R' || (!len && (res.ref || kws.some((k) => k.kw === 'REFFLD')))) {
      const r = resolveRef(refs, res.ref, kws, name, line);
      if (!len) len = r.len;
      if (!dtype) dtype = r.type;
      if (decS === '' && r.type !== 'A') decS = String(r.dec);
      varlenRef = !!r.varlen;
    }
    const dec = decS === '' ? null : Number(decS);
    if (!dtype) dtype = dec !== null ? 'P' : 'A';
    if (!len && !['L', 'T', 'Z'].includes(dtype)) throw new CompileError('CPD7426', `Length required for field ${name}.`, line);
    const f = { name, len, type: dtype, dec: dec || 0, text: '', colhdg: '', varlen: varlenRef, line };
    for (const k of kws) applyFieldKw(f, k);
    res.fields.push(f);
    last = f;
  }
  if (!res.format) throw new CompileError('CPD7411', 'Record format (R) not specified.', 1);
  if (!res.fields.length) throw new CompileError('CPD7412', 'No fields defined for record format.', 1);
  for (const k of res.keys) if (!res.fields.find((f) => f.name === k)) throw new CompileError('CPD7466', `Key field ${k} not defined in record format.`, 1);
  return res;
}

function applyFieldKw(f, k) {
  if (k.kw === 'TEXT') f.text = k.args[0] || '';
  if (k.kw === 'COLHDG') f.colhdg = k.args.join(' ');
  if (k.kw === 'VARLEN') f.varlen = true;
  if (k.kw === 'DFT') f.dft = k.args[0];
}

export function pfToSql(lib, file, pf) {
  const cols = pf.fields.map((f) => {
    let t;
    switch (f.type) {
      case 'A': t = f.varlen ? `VARCHAR(${f.len})` : `CHAR(${f.len})`; break;
      case 'P': t = `DECIMAL(${f.len}, ${f.dec})`; break;
      case 'S': t = `NUMERIC(${f.len}, ${f.dec})`; break;
      case 'B': t = f.len <= 4 ? 'SMALLINT' : f.len <= 9 ? 'INTEGER' : 'BIGINT'; break;
      case 'F': t = 'DOUBLE'; break;
      case 'L': t = 'DATE'; break;
      case 'T': t = 'TIME'; break;
      case 'Z': t = 'TIMESTAMP'; break;
      default: t = `CHAR(${f.len})`;
    }
    const dft = ['A'].includes(f.type) ? "DEFAULT ''" : ['L', 'T', 'Z'].includes(f.type) ? '' : 'DEFAULT 0';
    return `"${f.name}" ${t} NOT NULL ${dft}`.trim();
  });
  if (pf.keys.length && pf.unique) cols.push(`PRIMARY KEY (${pf.keys.map((k) => `"${k}"`).join(', ')})`);
  return `CREATE TABLE ${lib}.${file} (${cols.join(', ')})`;
}

const COLORS = { WHT: 'white', BLU: 'blue', RED: 'red', GRN: 'green', TRQ: 'turquoise', YLW: 'yellow', PNK: 'pink' };

export function parseDSPF(lines, refs = {}) {
  const res = { kind: 'DSPF', keys: [], formats: {}, ref: null };
  let fmt = null;
  let last = null;
  const addKeys = (target, kws, cond) => {
    for (const k of kws) {
      const m = /^C([AF])(\d\d)$/.exec(k.kw);
      if (m) target.push({ key: `F${Number(m[2])}`, ind: k.args[0] || null, data: m[1] === 'F', cond });
    }
  };
  const fmtKw = (f, k, cond) => {
    switch (k.kw) {
      case 'OVERLAY': f.overlay = true; break;
      case 'SFL': f.sfl = true; break;
      case 'SFLCTL': f.sflctl = k.args[0].toUpperCase(); break;
      case 'SFLSIZ': f.sflsiz = Number(k.args[0]); break;
      case 'SFLPAG': f.sflpag = Number(k.args[0]); break;
      case 'SFLDSP': f.sfldspInd = cond; break;
      case 'SFLDSPCTL': f.sfldspctlInd = cond; break;
      case 'SFLCLR': f.sflclrInd = cond; break;
      case 'SFLEND': f.sflendInd = cond; f.sflend = (k.args[0] || '*PLUS').toUpperCase(); break;
      case 'SFLRCDNBR': break;
      case 'TEXT': f.text = k.args[0]; break;
      case 'PRINT': case 'BLINK': case 'LOCK': case 'ALARM': if (k.kw === 'ALARM') f.alarm = cond.length ? cond : true; break;
      case 'ERASE': case 'PUTOVR': case 'INVITE': case 'FRCDTA': case 'ASSUME': case 'KEEP': break;
      default: break;
    }
  };
  for (const { s, kw, line } of logicalLines(lines)) {
    const type = col(s, 17, 17).toUpperCase().trim();
    const name = col(s, 19, 28).trim().toUpperCase();
    const cond = parseCond(s);
    const kws = parseKeywords(kw, line);
    const rowS = col(s, 39, 41).trim();
    const colS = col(s, 42, 44).trim();
    if (type === 'R') {
      fmt = { name, fields: [], constants: [], keys: [], overlay: false };
      res.formats[name] = fmt;
      addKeys(fmt.keys, kws, cond);
      for (const k of kws) fmtKw(fmt, k, cond);
      last = null;
      continue;
    }
    if (!name && !rowS && !colS) {
      // Palabras clave de archivo, de formato o del elemento anterior (con su propia condición).
      if (!fmt) { addKeys(res.keys, kws, cond); for (const k of kws) if (k.kw === 'REF') res.ref = (k.args[0] || '').toUpperCase(); continue; }
      if (last) applyDisplayKw(last, kws, cond);
      else { addKeys(fmt.keys, kws, cond); for (const k of kws) fmtKw(fmt, k, cond); }
      continue;
    }
    if (!fmt) throw new CompileError('CPD7411', 'Record format (R) must precede fields.', line);
    const row = rowS ? Number(rowS) : null;
    const column = colS ? Number(colS.replace('+', '')) : 1;
    if (!name) {
      const c = { row, col: column, text: '', cond, attrs: { color: null, dspatr: [] }, special: null };
      for (const k of kws) {
        if (k.kw === '$CONST') c.text = k.args[0];
        else if (['DATE', 'TIME', 'USER', 'SYSNAME', 'SYSTEM'].includes(k.kw)) c.special = k.kw;
      }
      applyDisplayKw(c, kws.filter((k) => k.kw !== '$CONST'), []);
      fmt.constants.push(c);
      last = c;
      continue;
    }
    let len = Number(col(s, 30, 34).trim() || 0);
    let dtype = col(s, 35, 35).toUpperCase().trim();
    let decS = col(s, 36, 37).trim();
    const usage = (col(s, 38, 38).trim() || 'O').toUpperCase();
    if (col(s, 29, 29).toUpperCase() === 'R' || (!len && (res.ref || kws.some((k) => k.kw === 'REFFLD')))) {
      const r = resolveRef(refs, res.ref, kws, name, line);
      if (!len) len = r.len;
      if (!dtype) dtype = r.type === 'P' || r.type === 'B' ? 'Y' : r.type === 'S' ? 'S' : r.type;
      if (decS === '' && r.type !== 'A') decS = String(r.dec);
    }
    if (!dtype) dtype = decS !== '' ? 'S' : 'A';
    const dec = decS === '' ? 0 : Number(decS);
    const f = {
      name, len, type: dtype, dec, usage, row, col: column, cond,
      attrs: { color: null, dspatr: [] }, edtcde: null, values: null, check: [], text: '',
      rpgType: ['A', 'X', 'W', 'I', 'D', 'M'].includes(dtype) ? { t: 'char', len } : { t: 'zoned', digits: len, dec },
    };
    applyDisplayKw(f, kws, []);
    fmt.fields.push(f);
    last = f;
  }
  return res;
}

function applyDisplayKw(item, kws, cond) {
  for (const k of kws) {
    switch (k.kw) {
      case 'COLOR': item.attrs.colorRules = item.attrs.colorRules || []; item.attrs.colorRules.push({ color: COLORS[k.args[0]] || 'green', cond }); if (!cond.length) item.attrs.color = COLORS[k.args[0]] || 'green'; break;
      case 'DSPATR': item.attrs.dspatr.push(...k.args.map((a) => ({ attr: a.toUpperCase(), cond }))); break;
      case 'EDTCDE': item.edtcde = k.args[0]; break;
      case 'VALUES': item.values = k.args; break;
      case 'CHECK': item.check = k.args.map((a) => a.toUpperCase()); break;
      case 'TEXT': item.text = k.args[0]; break;
      case 'DFT': item.dft = k.args[0]; break;
      case 'ERRMSG': item.errmsg = item.errmsg || []; item.errmsg.push({ text: k.args[0], cond }); break;
      case 'DATE': case 'TIME': case 'USER': case 'SYSNAME': item.special = k.kw; break;
      case '$CONST': item.text = k.args[0]; break;
      default: break;
    }
  }
}

// ---------- Referencias a campos de otros archivos (REF / REFFLD / R en la columna 29) ----------
/** Archivos que referencia un fuente DDS (para describirlos antes de analizar). */
export function ddsReferences(lines) {
  const files = new Set();
  for (const { kw, line } of logicalLines(lines)) {
    let kws;
    try { kws = parseKeywords(kw, line); } catch { continue; }
    for (const k of kws) {
      if (k.kw === 'REF' && k.args[0]) files.add(k.args[0].toUpperCase());
      if (k.kw === 'REFFLD' && k.args[1]) files.add(k.args[1].toUpperCase().replace(/^\*LIBL\//, ''));
      if (k.kw === 'PFILE' || k.kw === 'JFILE') for (const a of k.args) files.add(a.toUpperCase());
    }
  }
  return [...files];
}

// Tipo DDS a partir del tipo RPG/SQL del campo referenciado
function refAttrs(fld) {
  const t = fld.type || {};
  switch (t.t) {
    case 'packed': return { len: t.digits, type: 'P', dec: t.dec || 0 };
    case 'zoned': return { len: t.digits, type: 'S', dec: t.dec || 0 };
    case 'int': return { len: t.bits === 16 ? 4 : t.bits === 64 ? 18 : 9, type: 'B', dec: 0 };
    case 'float': return { len: 8, type: 'F', dec: 0 };
    case 'date': return { len: 10, type: 'L', dec: 0 };
    case 'time': return { len: 8, type: 'T', dec: 0 };
    case 'timestamp': return { len: 26, type: 'Z', dec: 0 };
    case 'varchar': return { len: t.len, type: 'A', dec: 0, varlen: true };
    default: return { len: t.len || fld.length || 1, type: 'A', dec: 0 };
  }
}

export function resolveRef(refs, fileRef, kws, name, line) {
  const rf = kws.find((k) => k.kw === 'REFFLD');
  const fieldName = rf ? rf.args[0].toUpperCase().replace(/^.*\//, '') : name;
  const file = rf && rf.args[1] ? rf.args[1].toUpperCase().replace(/^\*LIBL\//, '') : fileRef;
  const desc = file && refs ? refs[file] : null;
  const fld = desc && desc.fields.find((f) => f.name === fieldName);
  if (!fld) throw new CompileError('CPD7434', `Referenced field ${fieldName} not found${file ? ` in file ${file}` : ''}.`, line);
  return refAttrs(fld);
}

// ---------- Archivos lógicos (LF) ----------
/**
 * DDS de archivo lógico: R formato PFILE(pf) | JFILE(pf1 pf2 ...); campos (todos si no hay ninguno),
 * RENAME, CONCAT, SST; K claves (DESCEND, *NONE); S/O selección/omisión con COMP/VALUES/RANGE/ALL;
 * J JOIN/JFLD/JDFTVAL/JREF. refs = { NOMBREPF: describeFile(...) }.
 */
export function parseLF(lines, refs = {}) {
  const res = { kind: 'LF', format: null, text: '', pfiles: [], join: false, joins: [], jdftval: false, fields: [], keys: [], keyDesc: [], selomit: [], unique: false, dynslt: false };
  let cur = null;      // último campo
  let curSO = null;    // último grupo de selección/omisión
  let curJ = null;
  for (const { s, kw, line } of logicalLines(lines)) {
    const type = col(s, 17, 17).toUpperCase().trim();
    const name = col(s, 19, 28).trim().toUpperCase();
    const kws = parseKeywords(kw, line);
    if (!type && !name) {
      for (const k of kws) {
        if (k.kw === 'UNIQUE') res.unique = true;
        else if (k.kw === 'DYNSLT') res.dynslt = true;
        else if (k.kw === 'JDFTVAL') res.jdftval = true;
        else if (k.kw === 'JFLD' && curJ) curJ.flds.push([k.args[0].toUpperCase(), k.args[1].toUpperCase()]);
        else if (k.kw === 'JOIN' && curJ) curJ.files = k.args.map((a) => a.toUpperCase());
        else if ((k.kw === 'COMP' || k.kw === 'VALUES' || k.kw === 'RANGE') && curSO && curSO.tests.length) curSO.tests[curSO.tests.length - 1].kw.push(k);
        else if (k.kw === 'DESCEND' && res.keys.length && !cur) res.keyDesc[res.keyDesc.length - 1] = true;
        else if (cur) applyLfKw(cur, k);
        else if (k.kw === 'TEXT' && res.format) res.text = k.args[0] || '';
      }
      continue;
    }
    if (type === 'R') {
      if (res.format) throw new CompileError('CPD7486', 'Only one record format is supported in this logical file.', line);
      res.format = name;
      for (const k of kws) {
        if (k.kw === 'PFILE') res.pfiles = k.args.map((a) => a.toUpperCase());
        if (k.kw === 'JFILE') { res.pfiles = k.args.map((a) => a.toUpperCase()); res.join = true; }
        if (k.kw === 'TEXT') res.text = k.args[0] || '';
      }
      if (!res.pfiles.length) throw new CompileError('CPD7472', 'PFILE or JFILE keyword required for record format.', line);
      continue;
    }
    if (type === 'J') {
      cur = null;
      curJ = { files: [res.pfiles[0], res.pfiles[1]], flds: [] };
      for (const k of kws) {
        if (k.kw === 'JOIN') curJ.files = k.args.map((a) => a.toUpperCase());
        if (k.kw === 'JFLD') curJ.flds.push([k.args[0].toUpperCase(), k.args[1].toUpperCase()]);
      }
      res.joins.push(curJ);
      continue;
    }
    if (type === 'K') {
      cur = null;
      curSO = null;
      if (name === '*NONE') continue;
      res.keys.push(name);
      res.keyDesc.push(kws.some((k) => k.kw === 'DESCEND'));
      continue;
    }
    if (type === 'S' || type === 'O' || (!type && name && curSO)) {
      // S/O inicia un grupo (OR); una línea sin tipo tras ella añade una condición AND al grupo
      cur = null;
      if (type === 'S' || type === 'O') { curSO = { sel: type === 'S', tests: [] }; res.selomit.push(curSO); }
      if (name === '*ALL' || kws.some((k) => k.kw === 'ALL')) curSO.all = true;
      else curSO.tests.push({ field: name, kw: kws.filter((k) => ['COMP', 'VALUES', 'RANGE'].includes(k.kw)) });
      continue;
    }
    if (!type && name) {
      const f = { name, src: name, jref: null, concat: null, sst: null, line };
      for (const k of kws) applyLfKw(f, k);
      res.fields.push(f);
      cur = f;
    }
  }
  if (!res.format) throw new CompileError('CPD7411', 'Record format (R) not specified.', 1);
  for (const pf of res.pfiles) if (!refs[pf]) throw new CompileError('CPD7469', `Based-on physical file ${pf} not found.`, 1);
  // Campos: si no se enumeran, todos los del primer PF
  if (!res.fields.length) {
    if (res.join) throw new CompileError('CPD7474', 'Fields must be specified for a join logical file.', 1);
    res.fields = refs[res.pfiles[0]].fields.map((f) => ({ name: f.name, src: f.name, jref: null }));
  }
  const fileOf = (fname, jref) => {
    if (jref) return res.pfiles[jref - 1];
    for (const pf of res.pfiles) if (refs[pf].fields.some((x) => x.name === fname)) return pf;
    return null;
  };
  for (const f of res.fields) {
    if (f.concat || f.sst) continue;
    f.file = fileOf(f.src, f.jref);
    if (!f.file) throw new CompileError('CPD7426', `Field ${f.src} not found in based-on file(s) ${res.pfiles.join(' ')}.`, f.line || 1);
  }
  for (const k of res.keys) if (!res.fields.some((f) => f.name === k)) throw new CompileError('CPD7466', `Key field ${k} not defined in record format.`, 1);
  return res;
}

function applyLfKw(f, k) {
  switch (k.kw) {
    case 'RENAME': f.src = k.args[0].toUpperCase(); break;
    case 'CONCAT': f.concat = k.args.map((a) => a.toUpperCase()); break;
    case 'SST': f.sst = { field: k.args[0].toUpperCase(), start: Number(k.args[1]), len: Number(k.args[2] || 0) }; break;
    case 'JREF': f.jref = Number(k.args[0]); break;
    case 'TEXT': f.text = k.args[0]; break;
    case 'COLHDG': f.colhdg = k.args.join(' '); break;
    default: break;
  }
}

const sqlLit = (v) => {
  const t = String(v);
  if (/^[-+]?\d*\.?\d+$/.test(t)) return t;
  if (/^X'[0-9A-F]*'$/i.test(t)) return t;
  return `'${t.replace(/'/g, "''")}'`;
};
const COMP_OP = { EQ: '=', NE: '<>', GT: '>', LT: '<', GE: '>=', LE: '<=', NG: '<=', NL: '>=' };

/** SQL CREATE VIEW del archivo lógico. libOf(pf) da la biblioteca de cada PF base. */
export function lfToSql(lib, name, lf, libOf = () => lib) {
  const alias = (pf) => `T${lf.pfiles.indexOf(pf) + 1}`;
  const srcCol = (fname, jref) => {
    if (jref) return `${alias(lf.pfiles[jref - 1])}."${fname}"`;
    const f = lf.fields.find((x) => x.src === fname && x.file);
    return f ? `${alias(f.file)}."${fname}"` : `${alias(lf.pfiles[0])}."${fname}"`;
  };
  const exprOf = (f) => {
    if (f.concat) return f.concat.map((c) => srcCol(c)).join(' || ');
    if (f.sst) return `SUBSTR(${srcCol(f.sst.field)}, ${f.sst.start}${f.sst.len ? `, ${f.sst.len}` : ''})`;
    return `${alias(f.file)}."${f.src}"`;
  };
  // Las condiciones de selección se refieren a los nombres del formato lógico (o del PF si no está en él)
  const colOf = (fname) => {
    const f = lf.fields.find((x) => x.name === fname);
    return f ? exprOf(f) : srcCol(fname);
  };
  const sel = lf.fields.map((f) => `${exprOf(f)} AS "${f.name}"`);
  // Número relativo de registro del físico (para posicionar y actualizar exactamente una fila)
  if (!lf.join) sel.unshift('RID(T1) AS "$RRN"');
  let from = `${libOf(lf.pfiles[0])}.${lf.pfiles[0]} ${alias(lf.pfiles[0])}`;
  if (lf.join) {
    const joins = lf.joins.length ? lf.joins : [{ files: lf.pfiles.slice(0, 2), flds: [] }];
    for (const j of joins) {
      const right = j.files[1];
      const on = j.flds.map(([a, b]) => `${alias(j.files[0])}."${a}" = ${alias(right)}."${b}"`).join(' AND ') || '1=1';
      from += ` ${lf.jdftval ? 'LEFT OUTER JOIN' : 'INNER JOIN'} ${libOf(right)}.${right} ${alias(right)} ON ${on}`;
    }
  }
  // Selección/omisión: se evalúan en orden; la primera que se cumple decide
  let where = '';
  if (lf.selomit.length) {
    const hasSel = lf.selomit.some((g) => g.sel);
    const testSql = (t) => {
      const c = colOf(t.field);
      const parts = t.kw.map((k) => {
        if (k.kw === 'COMP') return `${c} ${COMP_OP[k.args[0].toUpperCase()] || '='} ${sqlLit(k.args[1])}`;
        if (k.kw === 'VALUES') return `${c} IN (${k.args.map(sqlLit).join(', ')})`;
        if (k.kw === 'RANGE') return `${c} BETWEEN ${sqlLit(k.args[0])} AND ${sqlLit(k.args[1])}`;
        return '1=1';
      });
      return parts.length ? parts.join(' AND ') : '1=1';
    };
    const whens = lf.selomit.map((g) => `WHEN ${g.all ? '1=1' : g.tests.map(testSql).join(' AND ')} THEN ${g.sel ? 1 : 0}`);
    where = ` WHERE (CASE ${whens.join(' ')} ELSE ${hasSel ? 0 : 1} END) = 1`;
  }
  return `CREATE VIEW ${lib}.${name} AS SELECT ${sel.join(', ')} FROM ${from}${where}`;
}

// ---------- Archivos de impresora (PRTF) ----------
/**
 * DDS de impresora: formatos R con campos/constantes en posición (39-41 línea, 42-44 columna o +n),
 * SPACEB/SPACEA/SKIPB/SKIPA (de formato o de campo), EDTCDE/EDTWRD, DATE/TIME/PAGNBR, indicadores 7-16.
 */
export function parsePRTF(lines, refs = {}) {
  const res = { kind: 'PRTF', ref: null, formats: {}, text: '' };
  let fmt = null;
  let last = null;
  const ctlKw = (target, k, cond) => {
    if (['SPACEA', 'SPACEB', 'SKIPA', 'SKIPB'].includes(k.kw)) { target.ctl.push({ kw: k.kw, n: Number(k.args[0]), cond }); return true; }
    return false;
  };
  for (const { s, kw, line } of logicalLines(lines)) {
    const type = col(s, 17, 17).toUpperCase().trim();
    const name = col(s, 19, 28).trim().toUpperCase();
    const refFlag = col(s, 29, 29).toUpperCase() === 'R';
    const cond = parseCond(s);
    const kws = parseKeywords(kw, line);
    const lineS = col(s, 39, 41).trim();
    const posS = col(s, 42, 44).trim();
    if (type === 'R') {
      fmt = { name, items: [], ctl: [], text: '' };
      res.formats[name] = fmt;
      for (const k of kws) { if (!ctlKw(fmt, k, cond) && k.kw === 'TEXT') fmt.text = k.args[0]; }
      last = null;
      continue;
    }
    if (!name && !lineS && !posS && !kws.some((k) => k.kw === '$CONST')) {
      for (const k of kws) {
        if (!fmt) { if (k.kw === 'REF') res.ref = k.args[0].toUpperCase(); continue; }
        const target = last || fmt;
        if (ctlKw(target, k, cond)) continue;
        if (last) applyPrtKw(last, k, cond);
      }
      continue;
    }
    if (!fmt) throw new CompileError('CPD7411', 'Record format (R) must precede fields.', line);
    const item = { name: name || null, line: lineS ? Number(lineS) : null, pos: posS ? (posS.startsWith('+') ? { rel: Number(posS.slice(1)) } : { abs: Number(posS) }) : { rel: 0 }, cond, ctl: [] };
    if (!name) {
      item.text = '';
      for (const k of kws) {
        if (k.kw === '$CONST') item.text = k.args[0];
        else if (!ctlKw(item, k, [])) applyPrtKw(item, k, []);
      }
    } else {
      let len = Number(col(s, 30, 34).trim() || 0);
      let dtype = col(s, 35, 35).toUpperCase().trim();
      let decS = col(s, 36, 37).trim();
      if (refFlag || (!len && (res.ref || kws.some((k) => k.kw === 'REFFLD')))) {
        const r = resolveRef(refs, res.ref, kws, name, line);
        if (!len) len = r.len;
        if (!dtype) dtype = r.type;
        if (decS === '' && r.type !== 'A') decS = String(r.dec);
      }
      if (!dtype) dtype = decS !== '' ? 'S' : 'A';
      const dec = decS === '' ? 0 : Number(decS);
      if (!len && !['L', 'T', 'Z'].includes(dtype)) throw new CompileError('CPD7426', `Length required for field ${name}.`, line);
      Object.assign(item, {
        len, type: dtype, dec,
        rpgType: dtype === 'A' ? { t: 'char', len } : dtype === 'L' ? { t: 'date' } : dtype === 'T' ? { t: 'time' } : dtype === 'Z' ? { t: 'timestamp' } : dtype === 'P' ? { t: 'packed', digits: len, dec } : dtype === 'B' ? { t: 'int', bits: len <= 4 ? 16 : 32 } : { t: 'zoned', digits: len, dec },
      });
      for (const k of kws) if (!ctlKw(item, k, [])) applyPrtKw(item, k, []);
    }
    fmt.items.push(item);
    last = item;
  }
  if (!Object.keys(res.formats).length) throw new CompileError('CPD7411', 'No record formats defined.', 1);
  return res;
}

function applyPrtKw(item, k, cond) {
  switch (k.kw) {
    case 'EDTCDE': item.edtcde = k.args[0].toUpperCase(); if (k.args[1]) item.edtfill = k.args[1]; break;
    case 'EDTWRD': item.edtwrd = k.args[0]; break;
    case 'DATE': case 'TIME': case 'PAGNBR': item.special = k.kw; break;
    case 'UNDERLINE': case 'HIGHLIGHT': case 'BOLD': (item.attrs = item.attrs || []).push({ kw: k.kw, cond }); break;
    case 'TEXT': item.textKw = k.args[0]; break;
    default: break;
  }
}
