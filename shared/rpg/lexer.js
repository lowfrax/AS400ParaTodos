// Lexer de RPG IV (ILE RPG) en formato libre, con soporte de columnas fijas convertido a libre.
import { convertFixed } from './fixed.js';

export class CompileError extends Error {
  constructor(msgId, message, line, severity = 30) {
    super(message);
    this.msgId = msgId;
    this.line = line;
    this.severity = severity;
  }
}

// Palabras tras las cuales un '*' inicia un valor especial (*ON, *INLR…) y no una multiplicación.
const NON_OPERAND_WORDS = new Set([
  'IF', 'ELSEIF', 'DOW', 'DOU', 'WHEN', 'RETURN', 'AND', 'OR', 'NOT', 'EVAL', 'EVALR', 'CALLP',
  'DSPLY', 'FOR', 'TO', 'BY', 'DOWNTO', 'CHAIN', 'SETLL', 'SETGT', 'READE', 'READPE', 'DELETE',
  'CLEAR', 'RESET', 'CLOSE', 'INZ', 'EVAL-CORR', 'ON-ERROR', 'SORTA', 'DCL-PI', 'DCL-PR', 'DCL-DS',
  'DCL-S', 'DCL-C', 'CONST', 'LIKE', 'END-PI', 'END-PR', 'END-DS', 'OTHER', 'ENDIF',
]);

/**
 * Prepara las líneas de un miembro fuente: detecta **FREE, columnas fijas, comentarios y directivas.
 * Devuelve [{text, line}] donde line es el índice (base 1) del registro fuente.
 */
export function preprocess(srcLines, includeResolver) {
  const out = [];
  const first = (srcLines[0] || '').trim().toUpperCase();
  const fullyFree = first.startsWith('**FREE');
  let inFree = false;
  const fixedBuf = [];
  const flushFixed = () => {
    if (!fixedBuf.length) return;
    for (const l of convertFixed(fixedBuf)) out.push(l);
    fixedBuf.length = 0;
  };
  for (let i = 0; i < srcLines.length; i++) {
    const raw = (srcLines[i] || '').replace(/\s+$/, '');
    const lineNo = i + 1;
    if (fullyFree) {
      if (i === 0) continue;
      const d = raw.trim().toUpperCase();
      if (/^\/(COPY|INCLUDE)\s+/.test(d)) {
        out.push(...expandInclude(raw.trim(), lineNo, includeResolver));
        continue;
      }
      if (/^\/(TITLE|EJECT|SPACE)\b/.test(d)) continue;
      out.push({ text: raw, line: lineNo });
      continue;
    }
    const line = raw.padEnd(80);
    const c7 = line[6];
    const spec = line[5].toUpperCase();
    const directive = line.slice(6).trim().toUpperCase();
    if (c7 === '*' || !line.trim()) continue; // comentario o línea vacía en columnas fijas
    if (line[6] === '/' || (spec === 'C' && line[6] === '/')) {
      flushFixed();
      if (directive.startsWith('/FREE')) { inFree = true; continue; }
      if (directive.startsWith('/END-FREE')) { inFree = false; continue; }
      if (/^\/(COPY|INCLUDE)\s+/.test(directive)) { out.push(...expandInclude(line.slice(6).trim(), lineNo, includeResolver)); continue; }
      continue;
    }
    if (inFree || spec === ' ') {
      flushFixed();
      const code = inFree ? line.slice(7) : line.slice(7, 80);
      if (code.trim()) out.push({ text: code, line: lineNo });
      continue;
    }
    if ('HFDCPIO'.includes(spec)) {
      fixedBuf.push({ text: line, line: lineNo });
      continue;
    }
    throw new CompileError('RNF0257', `Form-type ${spec} not valid or out of sequence.`, lineNo);
  }
  flushFixed();
  return out;
}

function expandInclude(directive, lineNo, resolver) {
  const m = /^\/(?:COPY|INCLUDE)\s+(?:([\w#@$]+)\/)?(?:([\w#@$]+),)?([\w#@$]+)/i.exec(directive);
  if (!m || !resolver) throw new CompileError('RNF0300', `The /COPY or /INCLUDE member was not found.`, lineNo);
  const lines = resolver({ lib: m[1], file: m[2] || 'QRPGLESRC', member: m[3] });
  if (!lines) throw new CompileError('RNF0300', `The /COPY member ${m[3]} was not found.`, lineNo);
  return preprocess(['**FREE', ...lines]).map((l) => ({ text: l.text, line: lineNo }));
}

export function tokenize(lines) {
  // Se concatenan líneas recordando el número de línea de cada desplazamiento.
  let text = '';
  const starts = [];
  for (const l of lines) {
    starts.push({ off: text.length, line: l.line });
    text += l.text + '\n';
  }
  const lineAt = (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid].off <= off) lo = mid; else hi = mid - 1;
    }
    return starts.length ? starts[lo].line : 0;
  };
  const toks = [];
  let i = 0;
  const n = text.length;
  const isIdStart = (c) => /[A-Za-z_#@$]/.test(c);
  const isId = (c) => /[A-Za-z0-9_#@$]/.test(c);
  const prevIsOperand = () => {
    const p = toks[toks.length - 1];
    if (!p) return false;
    if (p.type === 'num' || p.type === 'str' || p.type === 'hex' || p.type === 'special') return true;
    if (p.type === 'op') return p.value === ')';
    if (p.type === 'id') return !NON_OPERAND_WORDS.has(p.value);
    return false;
  };
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    const line = lineAt(i);
    // EXEC SQL … ; se captura como texto bruto.
    if ((c === 'E' || c === 'e') && /^exec\s+sql\b/i.test(text.slice(i, i + 12))) {
      const m = /^exec\s+sql\b/i.exec(text.slice(i));
      let j = i + m[0].length;
      let sql = '';
      while (j < n && text[j] !== ';') {
        if (text[j] === "'") {
          let k = j + 1;
          while (k < n && !(text[k] === "'" && text[k + 1] !== "'")) k += text[k] === "'" ? 2 : 1;
          sql += text.slice(j, k + 1);
          j = k + 1;
          continue;
        }
        if (text[j] === '-' && text[j + 1] === '-') { while (j < n && text[j] !== '\n') j++; continue; }
        if (text[j] === '/' && text[j + 1] === '/') { while (j < n && text[j] !== '\n') j++; continue; }
        sql += text[j] === '\n' ? ' ' : text[j];
        j++;
      }
      toks.push({ type: 'sql', value: sql.replace(/\s+/g, ' ').trim(), line });
      i = j;
      continue;
    }
    if (c === "'" || (/[xXdDtTzZ]/.test(c) && text[i + 1] === "'" && !isId(text[i - 1] || ' '))) {
      const hex = c === 'x' || c === 'X';
      let j = i + (c === "'" ? 1 : 2);
      let s = '';
      for (;;) {
        if (j >= n || text[j] === '\n') throw new CompileError('RNF0022', 'Literal is not terminated.', line);
        if (text[j] === "'") {
          if (text[j + 1] === "'") { s += "'"; j += 2; continue; }
          break;
        }
        s += text[j++];
      }
      i = j + 1;
      if (hex) {
        let out = '';
        for (let k = 0; k < s.length; k += 2) {
          const b = parseInt(s.slice(k, k + 2), 16);
          out += b === 0x40 ? ' ' : String.fromCharCode(b);
        }
        toks.push({ type: 'str', value: out, line });
      } else toks.push({ type: 'str', value: s, line });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      let j = i;
      while (j < n && /[0-9]/.test(text[j])) j++;
      if (text[j] === '.' && /[0-9]/.test(text[j + 1] || '')) { j++; while (j < n && /[0-9]/.test(text[j])) j++; }
      else if (text[j] === '.' && !isIdStart(text[j + 1] || '')) j++;
      toks.push({ type: 'num', value: Number(text.slice(i, j)), raw: text.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === '*' && isIdStart(text[i + 1] || '') && !prevIsOperand()) {
      let j = i + 1;
      while (j < n && isId(text[j])) j++;
      toks.push({ type: 'special', value: text.slice(i, j).toUpperCase(), line });
      i = j;
      continue;
    }
    if (c === '%' && isIdStart(text[i + 1] || '')) {
      let j = i + 1;
      while (j < n && isId(text[j])) j++;
      toks.push({ type: 'bif', value: text.slice(i, j).toUpperCase(), line });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < n && (isId(text[j]) || (text[j] === '-' && isIdStart(text[j + 1] || '') && /^(DCL|END|ON|EVAL|CTL)$/i.test(text.slice(i, j))))) j++;
      const raw = text.slice(i, j);
      toks.push({ type: 'id', value: raw.toUpperCase(), raw, line });
      i = j;
      continue;
    }
    const two = text.slice(i, i + 3);
    const ops = ['**=', '<>', '<=', '>=', '+=', '-=', '*=', '/=', '**'];
    const op = ops.find((o) => two.startsWith(o));
    if (op) { toks.push({ type: 'op', value: op, line }); i += op.length; continue; }
    if ('+-*/=<>():;,.'.includes(c)) { toks.push({ type: 'op', value: c, line }); i++; continue; }
    throw new CompileError('RNF0013', `Character '${c}' is not valid in this context.`, line);
  }
  toks.push({ type: 'eof', value: '', line: starts.length ? starts[starts.length - 1].line : 0 });
  return toks;
}
