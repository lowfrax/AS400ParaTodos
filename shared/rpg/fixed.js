// Conversión de especificaciones RPG IV en columnas fijas (H, F, D, C, P) a formato libre.
// Cubre las operaciones más comunes; el resto genera un error de compilación claro.

const col = (s, from, to) => s.slice(from - 1, to).trim();

const TYPE_MAP = (t, len, dec, isSubfield) => {
  const L = len ? Number(len) : 0;
  const hasDec = dec !== '';
  switch (t) {
    case 'A': return `CHAR(${L || 1})`;
    case 'P': return `PACKED(${L}:${dec || 0})`;
    case 'S': return `ZONED(${L}:${dec || 0})`;
    case 'B': return `BINDEC(${L}:${dec || 0})`;
    case 'I': return `INT(${L || 10})`;
    case 'U': return `UNS(${L || 10})`;
    case 'F': return `FLOAT(${L || 8})`;
    case 'D': return 'DATE';
    case 'T': return 'TIME';
    case 'Z': return 'TIMESTAMP';
    case 'N': return 'IND';
    case '*': return 'POINTER';
    case '':
      if (!L) return '';
      if (hasDec) return isSubfield ? `ZONED(${L}:${dec})` : `PACKED(${L}:${dec})`;
      return `CHAR(${L})`;
    default: return `CHAR(${L || 1})`;
  }
};

const CMP = { EQ: '=', NE: '<>', GT: '>', LT: '<', GE: '>=', LE: '<=' };

export function convertFixed(lines) {
  const out = [];
  const emit = (text, line) => out.push({ text, line });
  let openBlock = null; // 'DS' | 'PR' | 'PI'
  let pendingCall = null;
  let pendingCond = null; // condición IFxx/DOWxx/DOUxx/WHENxx que puede continuar con ANDxx/ORxx
  const closeBlock = (line) => {
    if (openBlock) emit(`END-${openBlock};`, line);
    openBlock = null;
  };
  const flushCall = (line) => {
    if (!pendingCall) return;
    const args = pendingCall.parms.join(' ');
    emit(`CALL$ ${pendingCall.pgm} ${args};`, pendingCall.line ?? line);
    pendingCall = null;
  };
  const flushCond = () => {
    if (!pendingCond) return;
    emit(`${pendingCond.op} ${pendingCond.expr};`, pendingCond.line);
    pendingCond = null;
  };

  for (const { text: s, line } of lines) {
    const spec = s[5].toUpperCase();
    if (spec !== 'D' && spec !== 'C') closeBlock(line);
    if (spec !== 'C') { flushCall(line); flushCond(); }

    if (spec === 'H') { emit(`CTL-OPT ${col(s, 7, 80)};`, line); continue; }

    if (spec === 'F') {
      const name = col(s, 7, 16);
      const type = col(s, 17, 17).toUpperCase();
      const add = col(s, 20, 20).toUpperCase() === 'A';
      const keyed = col(s, 34, 34).toUpperCase() === 'K';
      const device = col(s, 36, 42).toUpperCase() || 'DISK';
      const kw = col(s, 44, 80);
      if (!name) { emit(`// F-spec continuation: ${kw}`, line); continue; }
      const usage = [];
      if (type === 'I') usage.push('*INPUT');
      if (type === 'U') usage.push('*UPDATE', '*DELETE');
      if (type === 'O') usage.push('*OUTPUT');
      if (type === 'C') usage.push('*INPUT', '*OUTPUT');
      if (add && !usage.includes('*OUTPUT')) usage.push('*OUTPUT');
      emit(`DCL-F ${name} ${device}${usage.length ? ` USAGE(${usage.join(':')})` : ''}${keyed ? ' KEYED' : ''} ${kw};`, line);
      continue;
    }

    if (spec === 'D') {
      const name = col(s, 7, 21);
      const ext = col(s, 22, 22).toUpperCase();
      const decl = col(s, 24, 25).toUpperCase();
      const from = col(s, 26, 32);
      const to = col(s, 33, 39);
      const t = col(s, 40, 40).toUpperCase();
      const dec = col(s, 41, 42);
      let kw = col(s, 44, 80);
      let len = to;
      if (from && to) len = String(Number(to) - Number(from) + 1);
      if (decl === 'DS' || decl === 'PR' || decl === 'PI' || decl === 'S' || decl === 'C') closeBlock(line);
      if (decl === 'DS') {
        if (ext === 'E' && !/EXTNAME/i.test(kw)) kw = `EXTNAME(${name}) ${kw}`;
        emit(`DCL-DS ${name || '*N'} ${len ? `LEN(${len}) ` : ''}${kw};`, line);
        openBlock = 'DS';
        continue;
      }
      if (decl === 'PR' || decl === 'PI') {
        emit(`DCL-${decl} ${name || '*N'} ${TYPE_MAP(t, len, dec, false)} ${kw};`, line);
        openBlock = decl;
        continue;
      }
      if (decl === 'S') { emit(`DCL-S ${name} ${TYPE_MAP(t, len, dec, false)} ${kw};`, line); continue; }
      if (decl === 'C') {
        emit(`DCL-C ${name} ${/^CONST\s*\(/i.test(kw) ? kw : `CONST(${kw})`};`, line);
        continue;
      }
      if (!name && !t && !len) { emit(`// D-spec continuation`, line); continue; }
      emit(`${name || '*N'} ${TYPE_MAP(t, len, dec, openBlock === 'DS')} ${kw};`, line);
      continue;
    }

    if (spec === 'P') {
      closeBlock(line);
      const name = col(s, 7, 21);
      const be = col(s, 24, 24).toUpperCase();
      const kw = col(s, 44, 80);
      emit(be === 'B' ? `DCL-PROC ${name} ${kw};` : 'END-PROC;', line);
      continue;
    }

    if (spec === 'C') {
      closeBlock(line);
      const cond = col(s, 9, 11).toUpperCase();
      const f1 = col(s, 12, 25);
      const opFull = col(s, 26, 35).toUpperCase();
      const opm = /^([A-Z0-9-]+)(\(([A-Z ]*)\))?$/.exec(opFull) || [null, opFull, '', ''];
      const op = opm[1];
      const ext = opm[2] || '';
      const f2 = col(s, 36, 49);
      const ext2 = col(s, 36, 80);
      // Con factor 2 ampliado (EVAL, IF…) las columnas 36-80 son una expresión: no hay resultado ni indicadores.
      const isExt = ['', 'EVAL', 'EVALR', 'EVAL-CORR', 'IF', 'ELSEIF', 'DOW', 'DOU', 'WHEN', 'CALLP', 'FOR', 'ON-ERROR', 'SORTA', 'RETURN'].includes(op);
      const res = isExt ? '' : col(s, 50, 63);
      const len = isExt ? '' : col(s, 64, 68);
      const dec = isExt ? '' : col(s, 69, 70);
      const hi = isExt ? '' : col(s, 71, 72), lo = isExt ? '' : col(s, 73, 74), eq = isExt ? '' : col(s, 75, 76);

      if (op === 'PARM' && pendingCall) { pendingCall.parms.push(res); continue; }
      if (op === 'PLIST' || (op === 'PARM' && !pendingCall)) {
        // *ENTRY PLIST: se traduce como interfaz de procedimiento principal.
        if (op === 'PLIST' && f1.toUpperCase() === '*ENTRY') { emit('DCL-PI *N;', line); openBlock = 'PI*'; }
        else if (op === 'PARM' && openBlock === 'PI*') {
          emit(len ? `${res} ${dec !== '' ? `PACKED(${len}:${dec})` : `CHAR(${len})`};` : `${res} LIKE(${res});`, line);
        }
        continue;
      }
      if (openBlock === 'PI*') { emit('END-PI;', line); openBlock = null; }
      flushCall(line);
      const m = /^(AND|OR)(EQ|NE|GT|LT|GE|LE)$/.exec(op);
      if (m && pendingCond) {
        pendingCond.expr += ` ${m[1]} ${f1} ${CMP[m[2]]} ${f2}`;
        continue;
      }
      flushCond();

      if (len && res) emit(`DCL-S ${res} ${dec !== '' ? `PACKED(${len}:${dec})` : `CHAR(${len})`};`, line);

      const stmts = [];
      const cmpm = /^(IF|DOW|DOU|WHEN)(EQ|NE|GT|LT|GE|LE)$/.exec(op);
      if (cmpm) {
        pendingCond = { op: cmpm[1], expr: `${f1} ${CMP[cmpm[2]]} ${f2}`, line };
        continue;
      }
      const setInd = (ind, expr) => { if (ind) stmts.push(`*IN${ind} = ${expr};`); };
      switch (op) {
        case '': if (ext2) stmts.push(`${ext2};`); break; // continuación de factor 2 ampliado
        case 'EVAL': case 'EVALR': case 'EVAL-CORR':
          stmts.push(`${op === 'EVAL' ? '' : op + ' '}${ext2};`); break;
        case 'IF': case 'ELSEIF': case 'DOW': case 'DOU': case 'WHEN': case 'CALLP': case 'FOR':
        case 'ON-ERROR': case 'SORTA':
          stmts.push(`${op} ${ext2};`); break;
        case 'RETURN': stmts.push(`RETURN ${ext2};`); break;
        case 'ELSE': case 'ENDIF': case 'ENDDO': case 'ENDSL': case 'ENDFOR': case 'ENDMON': case 'END':
        case 'MONITOR': case 'SELECT': case 'OTHER': case 'ITER': case 'LEAVE': case 'LEAVESR': case 'ENDSR':
          stmts.push(`${op};`); break;
        case 'DO':
          stmts.push(f2 ? `FOR ${res || '$DOIDX'} = ${f1 || 1} TO ${f2};` : 'DOW *ON;'); break;
        case 'BEGSR': stmts.push(`BEGSR ${f1};`); break;
        case 'EXSR': stmts.push(`EXSR ${f2};`); break;
        case 'CALL': pendingCall = { pgm: f2, parms: [], line }; break;
        case 'MOVE': case 'MOVEL': stmts.push(`${op}$ ${f2} ${res};`); break;
        case 'Z-ADD': stmts.push(`${res} = ${f2};`); break;
        case 'Z-SUB': stmts.push(`${res} = -(${f2});`); break;
        case 'ADD': stmts.push(f1 ? `${res} = ${f1} + ${f2};` : `${res} += ${f2};`); break;
        case 'SUB': stmts.push(f1 ? `${res} = ${f1} - ${f2};` : `${res} -= ${f2};`); break;
        case 'MULT': stmts.push(f1 ? `${res} = ${f1} * ${f2};` : `${res} *= ${f2};`); break;
        case 'DIV': stmts.push(f1 ? `${res} = ${f1} / ${f2};` : `${res} /= ${f2};`); break;
        case 'CAT': stmts.push(`${res} = %TRIMR(${f1 || res}) + ${f2.replace(/:\d+$/, '')};`); break;
        case 'SETON': for (const i of [hi, lo, eq]) setInd(i, '*ON'); break;
        case 'SETOFF': case 'SETOF': for (const i of [hi, lo, eq]) setInd(i, '*OFF'); break;
        case 'DSPLY': stmts.push(`DSPLY ${f1 || "''"} ${f2 || "''"} ${res};`); break;
        case 'CLEAR': case 'RESET': stmts.push(`${op} ${f2 || res};`); break;
        case 'CHAIN': case 'SETLL': case 'SETGT': case 'READE': case 'READPE': case 'DELETE':
          stmts.push(`${op}${ext} ${f1} ${f2}${res ? ' ' + res : ''};`);
          if (op === 'CHAIN') setInd(hi, `NOT %FOUND(${f2})`);
          if (op === 'SETLL') setInd(eq, `%EQUAL(${f2})`);
          if (op === 'READE' || op === 'READPE') setInd(eq, `%EOF(${f2})`);
          break;
        case 'READ': case 'READP': case 'WRITE': case 'UPDATE': case 'EXFMT': case 'OPEN': case 'CLOSE':
          stmts.push(`${op}${ext} ${f2}${res ? ' ' + res : ''};`);
          if (op === 'READ' || op === 'READP') setInd(eq, `%EOF(${f2})`);
          break;
        default:
          stmts.push(`$UNSUPPORTED '${op}';`);
      }
      if (!stmts.length) continue;
      if (cond) {
        const neg = cond.startsWith('N');
        const ind = cond.replace(/^N/, '');
        if (ind) {
          emit(`IF ${neg ? 'NOT ' : ''}*IN${ind};`, line);
          for (const st of stmts) emit(st, line);
          emit('ENDIF;', line);
          continue;
        }
      }
      for (const st of stmts) emit(st, line);
      continue;
    }
    emit(`// ${spec}-spec ignored`, line);
  }
  if (openBlock === 'PI*') out.push({ text: 'END-PI;', line: lines[lines.length - 1].line });
  else closeBlock(lines[lines.length - 1]?.line);
  flushCall(lines[lines.length - 1]?.line);
  flushCond();
  return out;
}
