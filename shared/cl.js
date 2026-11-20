// Lenguaje de control (CL): análisis de cadenas de mandato, programas CLLE y expresiones.
import { CompileError } from './rpg/lexer.js';

export class CLSyntaxError extends Error {
  constructor(msgId, message) { super(message); this.msgId = msgId; }
}

// Lee un valor: 'literal', (lista), o palabra hasta espacio/paréntesis.
function readValue(s, i) {
  if (s[i] === "'") {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; }
      if (s[j] === "'") break;
      j++;
    }
    if (j >= s.length) throw new CLSyntaxError('CPD0016', 'String beginning with quote not ended.');
    return j + 1;
  }
  if (s[i] === '(') return matchParen(s, i) + 1;
  let j = i;
  while (j < s.length && !/[\s()]/.test(s[j])) {
    if (s[j] === "'") { j = readValue(s, j); continue; }
    j++;
  }
  // Funciones integradas tipo %SST(...) dentro de un valor
  if (s[j] === '(' && /%\w+$/.test(s.slice(i, j))) return matchParen(s, j) + 1;
  return j;
}

function matchParen(s, i) {
  let depth = 0, inQ = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'") { if (inQ && s[j + 1] === "'") { j++; continue; } inQ = !inQ; continue; }
    if (inQ) continue;
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j; }
  }
  throw new CLSyntaxError('CPD0013', 'Unbalanced parentheses in command string.');
}

/** Analiza "CMD KW(valor) valor-posicional ..." */
export function parseCommand(str) {
  let s = String(str).trim();
  const out = { label: null, name: '', lib: null, params: {}, positional: [], raw: s };
  const lm = /^([A-Za-z#@$][\w#@$]*)\s*:\s*/.exec(s);
  if (lm) { out.label = lm[1].toUpperCase(); s = s.slice(lm[0].length); }
  const nm = /^(?:([A-Za-z#@$*][\w#@$]*)\/)?([A-Za-z#@$?][\w#@$?]*)/.exec(s);
  if (!nm) {
    if (!s) return out;
    throw new CLSyntaxError('CPD0020', `Character '${s[0]}' not valid in command name.`);
  }
  out.lib = nm[1] ? nm[1].toUpperCase() : null;
  out.name = nm[2].toUpperCase();
  let i = nm[0].length;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const km = /^([A-Za-z][\w#@$]*)\(/.exec(s.slice(i));
    if (km) {
      const start = i + km[1].length;
      const end = matchParen(s, start);
      const kw = km[1].toUpperCase();
      if (out.params[kw] !== undefined) throw new CLSyntaxError('CPD0041', `Keyword ${kw} appears more than once.`);
      out.params[kw] = s.slice(start + 1, end).trim();
      i = end + 1;
      continue;
    }
    const end = readValue(s, i);
    let v = s.slice(i, end);
    if (v.startsWith('(') && v.endsWith(')')) v = v.slice(1, -1).trim();
    out.positional.push(v);
    i = end;
  }
  return out;
}

/** Divide una lista de valores CL respetando comillas y paréntesis. */
export function splitList(raw) {
  const out = [];
  const s = String(raw || '').trim();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const end = readValue(s, i);
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

export function unquote(v) {
  const s = String(v ?? '').trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export function quote(v) { return `'${String(v).replace(/'/g, "''")}'`; }

/** LIB/OBJ o OBJ -> {lib, obj} */
export function qualified(v, dftLib = '*LIBL') {
  const s = unquote(v).toUpperCase();
  const i = s.indexOf('/');
  if (i < 0) return { lib: dftLib, obj: s };
  return { lib: s.slice(0, i) || dftLib, obj: s.slice(i + 1) };
}

// ---------- Programas CL ----------
function clLogicalLines(lines) {
  const out = [];
  let buf = '';
  let startLine = 0;
  let inComment = false;
  for (let n = 0; n < lines.length; n++) {
    let s = (lines[n] || '').replace(/\s+$/, '');
    // Quitar comentarios /* */ fuera de literales
    let t = '';
    let inQ = false;
    for (let i = 0; i < s.length; i++) {
      if (inComment) { if (s[i] === '*' && s[i + 1] === '/') { inComment = false; i++; } continue; }
      if (s[i] === "'") inQ = !inQ;
      if (!inQ && s[i] === '/' && s[i + 1] === '*') { inComment = true; i++; continue; }
      t += s[i];
    }
    t = t.replace(/\s+$/, '');
    if (!buf) startLine = n + 1;
    if (t.endsWith('+')) { buf += t.slice(0, -1); continue; }
    if (t.endsWith('-')) { buf += t.slice(0, -1); continue; }
    buf += t;
    if (buf.trim()) out.push({ text: buf.trim(), line: startLine });
    buf = '';
  }
  if (buf.trim()) out.push({ text: buf.trim(), line: startLine });
  return out;
}

function paramOrPos(cmd, kw, pos) {
  if (cmd.params[kw] !== undefined) return cmd.params[kw];
  return cmd.positional[pos];
}

export function compileCL(lines) {
  const stmts = clLogicalLines(lines).map((l) => {
    let cmd;
    try { cmd = parseCommand(l.text); } catch (e) { throw new CompileError(e.msgId || 'CPD0013', e.message, l.line); }
    cmd.line = l.line;
    return cmd;
  });
  const ir = { kind: 'CLPGM', parms: [], dcls: [], files: [], body: [], monmsg: [] };
  let i = 0;
  const first = stmts[0];
  if (!first || first.name !== 'PGM') throw new CompileError('CPD0791', 'PGM command must be the first command in the program.', first ? first.line : 1);
  ir.parms = splitList(paramOrPos(first, 'PARM', 0) || '').map((p) => p.toUpperCase());
  i = 1;
  // Declaraciones
  while (i < stmts.length && ['DCL', 'DCLF', 'COPYRIGHT', 'DCLPRCOPT'].includes(stmts[i].name)) {
    const c = stmts[i];
    if (c.name === 'DCL') {
      const name = (paramOrPos(c, 'VAR', 0) || '').toUpperCase();
      const type = (paramOrPos(c, 'TYPE', 1) || '*CHAR').toUpperCase();
      const lenRaw = splitList(paramOrPos(c, 'LEN', 2) || '');
      const value = paramOrPos(c, 'VALUE', 3);
      if (!name.startsWith('&')) throw new CompileError('CPD0727', `Variable ${name} must begin with &.`, c.line);
      const dflt = type === '*DEC' ? [15, 5] : type === '*LGL' ? [1] : type === '*INT' || type === '*UINT' ? [4] : [32];
      ir.dcls.push({
        name, type,
        len: lenRaw.length ? Number(lenRaw[0]) : dflt[0],
        dec: lenRaw.length > 1 ? Number(lenRaw[1]) : (type === '*DEC' ? (lenRaw.length ? 0 : dflt[1]) : 0),
        value: value !== undefined ? value : null,
        line: c.line,
      });
    } else if (c.name === 'DCLF') {
      ir.files.push({ file: paramOrPos(c, 'FILE', 0), line: c.line });
    }
    i++;
  }
  // MONMSG de nivel de programa (se resuelven los bloques DO después de definir parseBlock)
  const globalMon = [];
  while (i < stmts.length && stmts[i].name === 'MONMSG') { globalMon.push(stmts[i]); i++; }

  const parseBlock = (enders) => {
    const body = [];
    while (i < stmts.length) {
      const c = stmts[i];
      if (enders.includes(c.name)) return body;
      if (c.name === 'ENDPGM') { i++; return body; }
      i++;
      const node = parseNode(c);
      if (node) body.push(node);
    }
    if (enders.length) throw new CompileError('CPD0731', `${enders[0]} missing for DO group.`, stmts[stmts.length - 1].line);
    return body;
  };

  const thenOf = (raw, line) => {
    if (raw === undefined || raw === null || raw.trim() === '') return [];
    const inner = parseCommand(raw);
    inner.line = line;
    if (['DO', 'DOWHILE', 'DOUNTIL', 'DOFOR'].includes(inner.name) && inner.name === 'DO') {
      const body = parseBlock(['ENDDO']);
      i++;
      return body;
    }
    if (['DOWHILE', 'DOUNTIL', 'DOFOR'].includes(inner.name)) return [parseNode(inner)];
    return [parseNode(inner)];
  };

  const parseNode = (c) => {
    const node = { line: c.line, label: c.label };
    if (!c.name) { node.t = 'nop'; return node; }
    switch (c.name) {
      case 'IF': {
        node.t = 'if';
        node.cond = paramOrPos(c, 'COND', 0);
        node.then = thenOf(paramOrPos(c, 'THEN', 1), c.line);
        node.else = null;
        if (i < stmts.length && stmts[i].name === 'ELSE') {
          const e = stmts[i];
          i++;
          node.else = thenOf(paramOrPos(e, 'CMD', 0), e.line);
        }
        return node;
      }
      case 'DO': node.t = 'do'; node.body = parseBlock(['ENDDO']); i++; return node;
      case 'DOWHILE': case 'DOUNTIL':
        node.t = c.name.toLowerCase();
        node.cond = paramOrPos(c, 'COND', 0);
        node.body = parseBlock(['ENDDO']); i++;
        return node;
      case 'DOFOR':
        node.t = 'dofor';
        node.var = (paramOrPos(c, 'VAR', 0) || '').toUpperCase();
        node.from = paramOrPos(c, 'FROM', 1);
        node.to = paramOrPos(c, 'TO', 2);
        node.by = paramOrPos(c, 'BY', 3) || '1';
        node.body = parseBlock(['ENDDO']); i++;
        return node;
      case 'SELECT': {
        node.t = 'select';
        node.whens = [];
        node.other = null;
        while (i < stmts.length && stmts[i].name !== 'ENDSELECT') {
          const w = stmts[i++];
          if (w.name === 'WHEN') node.whens.push({ cond: paramOrPos(w, 'COND', 0), then: thenOf(paramOrPos(w, 'THEN', 1), w.line) });
          else if (w.name === 'OTHERWISE') node.other = thenOf(paramOrPos(w, 'CMD', 0), w.line);
          else throw new CompileError('CPD0797', `${w.name} not valid in SELECT group.`, w.line);
        }
        i++;
        return node;
      }
      case 'ELSE': throw new CompileError('CPD0761', 'ELSE command not valid at this point.', c.line);
      case 'ENDDO': throw new CompileError('CPD0745', 'ENDDO command not valid at this point.', c.line);
      case 'GOTO': node.t = 'goto'; node.target = (paramOrPos(c, 'CMDLBL', 0) || '').toUpperCase(); return node;
      case 'LEAVE': node.t = 'leave'; return node;
      case 'ITERATE': node.t = 'iterate'; return node;
      case 'RETURN': node.t = 'return'; return node;
      case 'CHGVAR': node.t = 'chgvar'; node.var = paramOrPos(c, 'VAR', 0); node.value = paramOrPos(c, 'VALUE', 1); return node;
      case 'ENDPGM': return null;
      case 'MONMSG': throw new CompileError('CPD0711', 'MONMSG command not valid at this point.', c.line);
      default: {
        node.t = 'cmd';
        node.cmd = c;
        node.monmsg = [];
        while (i < stmts.length && stmts[i].name === 'MONMSG') node.monmsg.push(monmsgWithBlock(stmts[i++]));
        return node;
      }
    }
  };
  // MONMSG ... EXEC(DO) seguido de un bloque hasta ENDDO
  function monmsgWithBlock(c) {
    const m = monmsgOf(c);
    if (m.exec && /^DO$/i.test(m.exec.trim())) {
      m.exec = null;
      m.body = parseBlock(['ENDDO']);
      i++;
    }
    return m;
  }
  ir.monmsg = globalMon.map(monmsgOf);
  ir.body = parseBlock([]);
  return ir;
}

function monmsgOf(c) {
  return {
    msgids: splitList(paramOrPos(c, 'MSGID', 0) || '').map((m) => m.toUpperCase()),
    exec: paramOrPos(c, 'EXEC', 2) || null,
    line: c.line,
  };
}

// ---------- Expresiones CL ----------
const OPS = {
  '*CAT': 'cat', '||': 'cat', '*BCAT': 'bcat', '|>': 'bcat', '*TCAT': 'tcat', '|<': 'tcat',
  '*EQ': '=', '=': '=', '*NE': '<>', '¬=': '<>', '<>': '<>', '*GT': '>', '>': '>', '*LT': '<', '<': '<',
  '*GE': '>=', '>=': '>=', '*LE': '<=', '<=': '<=', '*NL': '>=', '*NG': '<=',
  '*AND': 'and', '&': 'and', '*OR': 'or', '|': 'or',
};

function clTokens(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1, v = '';
      while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { v += "'"; j += 2; continue; } if (s[j] === "'") break; v += s[j++]; }
      out.push({ t: 'str', v }); i = j + 1; continue;
    }
    const two = s.slice(i, i + 2);
    if (['||', '|>', '|<', '¬=', '<>', '>=', '<='].includes(two)) { out.push({ t: 'op', v: OPS[two] }); i += 2; continue; }
    if ('()'.includes(c)) { out.push({ t: c }); i++; continue; }
    if ('=<>&|'.includes(c) && !(c === '&' && /[A-Za-z#@$]/.test(s[i + 1] || ''))) { out.push({ t: 'op', v: OPS[c] }); i++; continue; }
    if ('+-*/'.includes(c) && !(c === '*' && /[A-Za-z]/.test(s[i + 1] || ''))) {
      if ((c === '-' || c === '+') && /[0-9.]/.test(s[i + 1] || '') && (!out.length || out[out.length - 1].t === 'op' || out[out.length - 1].t === 'arith' || out[out.length - 1].t === '(')) {
        // número con signo
      } else { out.push({ t: 'arith', v: c }); i++; continue; }
    }
    if (c === '¬') { out.push({ t: 'not' }); i++; continue; }
    const m = /^(?:[-+]?\d*\.?\d+|&[\w#@$]+|%[\w]+|\*[A-Za-z]+|[A-Za-z#@$*][\w#@$./*]*)/.exec(s.slice(i));
    if (!m) throw new CLSyntaxError('CPD0115', `Character '${c}' not valid in expression.`);
    const w = m[0];
    i += w.length;
    const W = w.toUpperCase();
    if (OPS[W]) out.push({ t: 'op', v: OPS[W] });
    else if (W === '*NOT') out.push({ t: 'not' });
    else if (W.startsWith('&')) out.push({ t: 'var', v: W });
    else if (W.startsWith('%')) out.push({ t: 'fn', v: W });
    else if (/^[-+]?\d*\.?\d+$/.test(w)) out.push({ t: 'num', v: Number(w) });
    else out.push({ t: 'word', v: W });
  }
  return out;
}

/** Evalúa una expresión CL. getVar(name) -> {value, type} */
export function evalCL(expr, getVar) {
  const toks = clTokens(String(expr));
  let p = 0;
  const peek = () => toks[p];
  const asStr = (v) => (typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  const primary = () => {
    const t = toks[p++];
    if (!t) throw new CLSyntaxError('CPD0124', 'Expression incomplete.');
    if (t.t === '(') { const v = orE(); if (peek()?.t === ')') p++; return v; }
    if (t.t === 'str') return t.v;
    if (t.t === 'num') return t.v;
    if (t.t === 'not') return !truthyCL(primary());
    if (t.t === 'var') {
      const v = getVar(t.v);
      if (!v) throw new CLSyntaxError('CPD0727', `Variable ${t.v} referred to but not declared.`);
      return v.value;
    }
    if (t.t === 'fn') {
      if (peek()?.t !== '(') throw new CLSyntaxError('CPD0124', `Function ${t.v} requires arguments.`);
      p++;
      const args = [];
      while (peek() && peek().t !== ')') args.push(addE());
      p++;
      switch (t.v) {
        case '%SST': case '%SUBSTRING': return asStr(args[0]).substr(Number(args[1]) - 1, Number(args[2]));
        case '%TRIM': return asStr(args[0]).trim();
        case '%TRIML': return asStr(args[0]).replace(/^\s+/, '');
        case '%TRIMR': return asStr(args[0]).replace(/\s+$/, '');
        case '%UPPER': return asStr(args[0]).toUpperCase();
        case '%LOWER': return asStr(args[0]).toLowerCase();
        case '%LEN': return asStr(args[0]).length;
        case '%CHAR': return asStr(args[0]);
        case '%DEC': case '%INT': return Number(asStr(args[0]).trim() || 0);
        case '%SCAN': { const i = asStr(args[1]).indexOf(asStr(args[0])); return i + 1; }
        default: throw new CLSyntaxError('CPD0124', `Built-in function ${t.v} not supported.`);
      }
    }
    if (t.t === 'word') {
      if (t.v === '*ON' || t.v === "'1'") return '1';
      if (t.v === '*OFF') return '0';
      if (t.v === '*BLANKS' || t.v === '*BLANK') return '';
      return t.v;
    }
    throw new CLSyntaxError('CPD0124', 'Expression not valid.');
  };
  const mulE = () => {
    let l = primary();
    while (peek()?.t === 'arith' && (peek().v === '*' || peek().v === '/')) {
      const op = toks[p++].v; const r = primary();
      l = op === '*' ? Number(l) * Number(r) : Number(l) / Number(r);
    }
    return l;
  };
  const addE = () => {
    let l = mulE();
    while (peek()?.t === 'arith' && (peek().v === '+' || peek().v === '-')) {
      const op = toks[p++].v; const r = mulE();
      l = op === '+' ? Number(l) + Number(r) : Number(l) - Number(r);
    }
    return l;
  };
  const catE = () => {
    let l = addE();
    while (peek()?.t === 'op' && ['cat', 'bcat', 'tcat'].includes(peek().v)) {
      const op = toks[p++].v; const r = asStr(addE());
      const ls = asStr(l);
      l = op === 'cat' ? ls + r : op === 'tcat' ? ls.replace(/\s+$/, '') + r : ls.replace(/\s+$/, '') + ' ' + r.replace(/^\s+/, '');
    }
    return l;
  };
  const relE = () => {
    const l = catE();
    if (peek()?.t === 'op' && ['=', '<>', '>', '<', '>=', '<='].includes(peek().v)) {
      const op = toks[p++].v; const r = catE();
      let c;
      if (typeof l === 'number' || typeof r === 'number') { const a = Number(l), b = Number(r); c = a === b ? 0 : a < b ? -1 : 1; } else {
        let a = asStr(l), b = asStr(r);
        if (a.length < b.length) a = a.padEnd(b.length); else b = b.padEnd(a.length);
        c = a === b ? 0 : a < b ? -1 : 1;
      }
      return { '=': c === 0, '<>': c !== 0, '>': c > 0, '<': c < 0, '>=': c >= 0, '<=': c <= 0 }[op];
    }
    return l;
  };
  const andE = () => { let l = relE(); while (peek()?.t === 'op' && peek().v === 'and') { p++; const r = relE(); l = truthyCL(l) && truthyCL(r); } return l; };
  const orE = () => { let l = andE(); while (peek()?.t === 'op' && peek().v === 'or') { p++; const r = andE(); l = truthyCL(l) || truthyCL(r); } return l; };
  const v = orE();
  return v;
}

export function truthyCL(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return String(v).trim() === '1';
}
