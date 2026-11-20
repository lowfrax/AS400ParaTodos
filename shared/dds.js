// Parser de DDS (Data Description Specifications) para archivos físicos (PF) y de pantalla (DSPF).
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

export function parsePF(lines) {
  const res = { kind: 'PF', format: null, text: '', fields: [], keys: [], unique: false };
  let last = null;
  for (const { s, kw, line } of logicalLines(lines)) {
    const type = col(s, 17, 17).toUpperCase().trim();
    const name = col(s, 19, 28).trim().toUpperCase();
    const kws = parseKeywords(kw, line);
    if (!name && !type) {
      // Palabra clave de nivel de archivo o continuación del elemento anterior.
      for (const k of kws) {
        if (k.kw === 'UNIQUE') res.unique = true;
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
    const len = Number(col(s, 30, 34).trim() || 0);
    let dtype = col(s, 35, 35).toUpperCase().trim();
    const decS = col(s, 36, 37).trim();
    const dec = decS === '' ? null : Number(decS);
    if (!dtype) dtype = dec !== null ? 'P' : 'A';
    if (!len && !['L', 'T', 'Z'].includes(dtype)) throw new CompileError('CPD7426', `Length required for field ${name}.`, line);
    const f = { name, len, type: dtype, dec: dec || 0, text: '', colhdg: '', varlen: false, line };
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

export function parseDSPF(lines) {
  const res = { kind: 'DSPF', keys: [], formats: {} };
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
      if (!fmt) { addKeys(res.keys, kws, cond); continue; }
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
    const len = Number(col(s, 30, 34).trim() || 0);
    let dtype = col(s, 35, 35).toUpperCase().trim();
    const decS = col(s, 36, 37).trim();
    const usage = (col(s, 38, 38).trim() || 'O').toUpperCase();
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
