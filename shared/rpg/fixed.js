// Frente de RPG en columnas fijas: RPG IV (ILE RPG, H/F/D/I/C/O/P) y RPG III / RPG/400 / RPG II (H/F/E/L/I/C/O).
// Cada especificación se normaliza a una estructura común y se genera RPG IV en formato libre más directivas internas
// que el analizador recoge en el IR:
//   $FILEX  datos de archivo que el formato libre no expresa (archivo primario/secundario, desbordamiento, FORMLEN…)
//   $ISPEC  especificaciones de entrada (registros y campos descritos por programa, renombres, L1-L9, M1-M9)
//   $OSPEC  especificaciones de salida (líneas H/D/T/E de impresora o disco, campos, códigos de edición)
//   $CTDATA datos de tiempo de compilación (** al final del fuente)
//   $TOTAL Ln … $ENDTOTAL   cálculos de tiempo total (L0-L9, LR en columnas 7-8)
//   GOTO$ / TAG$            bifurcación (GOTO, TAG, CABxx)
//   MOVEA$                  MOVEA entre arrays y campos
// Equivale a lo que hacen CVTRPGSRC (RPG III → RPG IV) y el compilador de ILE RPG con el ciclo RPG.

const col = (s, from, to) => s.slice(from - 1, to).trim();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const CMP = { EQ: '=', NE: '<>', GT: '>', LT: '<', GE: '>=', LE: '<=', '': null };
const EXT_F2 = new Set(['EVAL', 'EVALR', 'EVAL-CORR', 'IF', 'ELSEIF', 'DOW', 'DOU', 'WHEN', 'CALLP', 'FOR', 'ON-ERROR', 'SORTA', 'RETURN', 'XML-INTO', 'XML-SAX', 'DATA-INTO', 'DSPLY*']);

function typeOf(t, len, dec, isSubfield) {
  const L = len ? Number(len) : 0;
  switch (String(t || '').toUpperCase()) {
    case 'A': return `CHAR(${L || 1})`;
    case 'P': return `PACKED(${L || 15}:${dec || 0})`;
    case 'S': return `ZONED(${L || 15}:${dec || 0})`;
    case 'B': return `BINDEC(${L || 9}:${dec || 0})`;
    case 'I': return `INT(${L || 10})`;
    case 'U': return `UNS(${L || 10})`;
    case 'F': return `FLOAT(${L || 8})`;
    case 'D': return 'DATE';
    case 'T': return 'TIME';
    case 'Z': return 'TIMESTAMP';
    case 'N': return 'IND';
    case '*': return 'POINTER';
    case 'G': return `CHAR(${L || 1})`;
    case 'C': return `CHAR(${L || 1})`;
    case '':
      if (!L) return '';
      if (dec !== '' && dec !== undefined) return isSubfield ? `ZONED(${L}:${dec})` : `PACKED(${L}:${dec})`;
      return `CHAR(${L})`;
    default: return `CHAR(${L || 1})`;
  }
}

// Nombres de RPG III: ARR,I → ARR(I); *IN,nn → *INnn (fuera de literales).
function fixName(x) {
  if (!x) return x;
  let out = '';
  let i = 0;
  while (i < x.length) {
    if (x[i] === "'") { const j = x.indexOf("'", i + 1); const end = j < 0 ? x.length : j + 1; out += x.slice(i, end); i = end; continue; }
    out += x[i++];
  }
  return out
    .replace(/\*IN,(\d\d|[A-Z][A-Z0-9])/gi, '*IN$1')
    .replace(/^([A-Z#@$][\w#@$]*),([A-Z#@$\d][\w#@$]*)$/i, '$1($2)')
    .replace(/^\*ALL'(.*)'$/i, "*ALL'$1'");
}

// ---------- Normalización por dialecto ----------
const OP3 = {
  LOOKU: 'LOOKUP', EXCPT: 'EXCEPT', SETOF: 'SETOFF', DELET: 'DELETE', UPDAT: 'UPDATE', COMIT: 'COMMIT', CHEKR: 'CHECKR',
  REDPE: 'READPE', DEFN: 'DEFINE', BITOF: 'BITOFF', OCUR: 'OCCUR', RETRN: 'RETURN', SELEC: 'SELECT', UNLCK: 'UNLOCK',
  DEBUG: 'DUMP', FREE: 'DEALLOC', TIME: 'TIME', XFOOT: 'XFOOT', OTHER: 'OTHER', ENDSL: 'ENDSL',
};
function op3(o) {
  if (OP3[o]) return OP3[o];
  const w = /^WH(EQ|NE|GT|LT|GE|LE)$/.exec(o);
  if (w) return `WHEN${w[1]}`;
  return o;
}

function normC(s, dialect) {
  if (dialect === 'RPG3') {
    const inds = [col(s, 9, 11), col(s, 12, 14), col(s, 15, 17)].filter(Boolean).map((x) => ({ n: x.startsWith('N'), ind: x.replace(/^N/, '') }));
    return {
      lvl: col(s, 7, 8).toUpperCase(), conds: inds, f1: fixName(col(s, 18, 27)), op: op3(col(s, 28, 32).toUpperCase()), ext: col(s, 53, 53).toUpperCase() === 'H' ? 'H' : '',
      f2: fixName(col(s, 33, 42)), f2x: '', res: fixName(col(s, 43, 48)), len: col(s, 49, 51), dec: col(s, 52, 52), hi: col(s, 54, 55), lo: col(s, 56, 57), eq: col(s, 58, 59),
    };
  }
  const opFull = col(s, 26, 35).toUpperCase();
  const m = /^([A-Z0-9-]+)(?:\(([A-Z ]*)\))?$/.exec(opFull) || [null, opFull, ''];
  const c = col(s, 9, 11);
  // Con factor 2 ampliado (EVAL, IF…) las columnas 36-80 son una expresión: no hay resultado ni indicadores.
  if (EXT_F2.has(m[1])) {
    return { lvl: col(s, 7, 8).toUpperCase(), conds: c ? [{ n: c.startsWith('N'), ind: c.replace(/^N/, '') }] : [], f1: col(s, 12, 25), op: m[1], ext: (m[2] || '').replace(/\s/g, ''),
      f2: col(s, 36, 80), f2x: col(s, 36, 80), res: '', len: '', dec: '', hi: '', lo: '', eq: '' };
  }
  return {
    lvl: col(s, 7, 8).toUpperCase(), conds: c ? [{ n: c.startsWith('N'), ind: c.replace(/^N/, '') }] : [], f1: col(s, 12, 25), op: m[1], ext: (m[2] || '').replace(/\s/g, ''),
    f2: col(s, 36, 49), f2x: col(s, 36, 80), res: col(s, 50, 63), len: col(s, 64, 68), dec: col(s, 69, 70), hi: col(s, 71, 72), lo: col(s, 73, 74), eq: col(s, 75, 76),
  };
}

function normF(s, dialect) {
  if (dialect === 'RPG3') {
    if (col(s, 53, 53).toUpperCase() === 'K' && !col(s, 7, 14)) {
      return { cont: true, kw: col(s, 54, 59).toUpperCase(), entry: col(s, 60, 67), extra: col(s, 47, 52), extfmt: col(s, 19, 28) };
    }
    return {
      name: col(s, 7, 14), type: col(s, 15, 15).toUpperCase(), desig: col(s, 16, 16).toUpperCase(), eof: col(s, 17, 17).toUpperCase(),
      format: col(s, 19, 19).toUpperCase(), reclen: col(s, 24, 27), keylen: col(s, 29, 30), rat: col(s, 31, 31).toUpperCase(), org: col(s, 32, 32).toUpperCase(),
      ofl: col(s, 33, 34).toUpperCase(), keystart: col(s, 35, 38), ext: col(s, 39, 39).toUpperCase(), device: col(s, 40, 46).toUpperCase() || 'DISK',
      add: col(s, 66, 66).toUpperCase() === 'A', cond: col(s, 71, 72).toUpperCase(), kwText: '',
      cont: col(s, 53, 53).toUpperCase() === 'K' ? { kw: col(s, 54, 59).toUpperCase(), entry: col(s, 60, 67), extra: col(s, 47, 52) } : null,
    };
  }
  return {
    name: col(s, 7, 16), type: col(s, 17, 17).toUpperCase(), desig: col(s, 18, 18).toUpperCase(), eof: col(s, 19, 19).toUpperCase(), add: col(s, 20, 20).toUpperCase() === 'A',
    format: col(s, 22, 22).toUpperCase(), reclen: col(s, 23, 27), keylen: col(s, 29, 33), rat: col(s, 34, 34).toUpperCase(), org: col(s, 35, 35).toUpperCase(),
    device: col(s, 36, 42).toUpperCase() || 'DISK', kwText: col(s, 44, 80), ofl: '',
  };
}

// I-specs: devuelve {kind, …}
function normI(s, dialect) {
  if (dialect === 'RPG3') {
    const name = col(s, 7, 14);
    const ds = col(s, 19, 20).toUpperCase();
    if (name && (ds === 'DS' || /^ *DS$/.test(s.slice(18, 20)))) {
      return { kind: 'ds', name: col(s, 7, 12), ext: col(s, 17, 17).toUpperCase() === 'E', opt: col(s, 18, 18).toUpperCase(), extfile: col(s, 21, 30), occurs: col(s, 44, 47), len: col(s, 48, 51) };
    }
    if (!name && col(s, 19, 20).toUpperCase() === 'DS') return { kind: 'ds', name: '', ext: col(s, 17, 17).toUpperCase() === 'E', opt: col(s, 18, 18).toUpperCase(), extfile: col(s, 21, 30), occurs: col(s, 44, 47), len: col(s, 48, 51) };
    if (col(s, 43, 43).toUpperCase() === 'C' && col(s, 53, 58)) return { kind: 'const', value: s.slice(20, 42).trim(), name: col(s, 53, 58) };
    if (!col(s, 7, 13) && /^(AND|OR)$/i.test(col(s, 14, 16))) return { kind: col(s, 14, 16).toUpperCase() === 'OR' ? 'or' : 'and', recInd: col(s, 19, 20), ids: s.slice(20, 41) };
    if (name) return { kind: 'record', file: name, seq: col(s, 15, 16), recInd: col(s, 19, 20), ids: s.slice(20, 41) };
    if (col(s, 21, 30) && !col(s, 44, 51)) return { kind: 'extfld', ext: col(s, 21, 30).toUpperCase(), name: col(s, 53, 58).toUpperCase(), level: col(s, 59, 60).toUpperCase(), match: col(s, 61, 62).toUpperCase(), inds: [col(s, 65, 66), col(s, 67, 68), col(s, 69, 70)] };
    return {
      kind: 'field', fmt: col(s, 43, 43).toUpperCase(), from: Number(col(s, 44, 47) || 0), to: Number(col(s, 48, 51) || 0), dec: col(s, 52, 52),
      name: fixName(col(s, 53, 58)).toUpperCase(), level: col(s, 59, 60).toUpperCase(), match: col(s, 61, 62).toUpperCase(), rel: col(s, 63, 64).toUpperCase(), inds: [col(s, 65, 66), col(s, 67, 68), col(s, 69, 70)],
    };
  }
  const name = col(s, 7, 16);
  if (!col(s, 7, 15) && /^(AND|OR)$/i.test(col(s, 16, 18))) {
    return { kind: col(s, 16, 18).toUpperCase() === 'OR' ? 'or' : 'and', recInd: col(s, 21, 22), ids: s.slice(22, 46) };
  }
  if (name) {
    // Registro descrito por programa (número de secuencia en 17-18) o formato externo
    const seq = col(s, 17, 18);
    return seq ? { kind: 'record', file: name, seq, recInd: col(s, 21, 22), ids: s.slice(22, 46) } : { kind: 'extrec', format: name, recInd: col(s, 21, 22) };
  }
  if (col(s, 21, 30) && !col(s, 37, 46)) return { kind: 'extfld', ext: col(s, 21, 30).toUpperCase(), name: col(s, 49, 62).toUpperCase(), level: col(s, 63, 64).toUpperCase(), match: col(s, 65, 66).toUpperCase(), inds: [col(s, 69, 70), col(s, 71, 72), col(s, 73, 74)] };
  return {
    kind: 'field', fmt: col(s, 36, 36).toUpperCase(), from: Number(col(s, 37, 41) || 0), to: Number(col(s, 42, 46) || 0), dec: col(s, 47, 48),
    name: col(s, 49, 62).toUpperCase(), level: col(s, 63, 64).toUpperCase(), match: col(s, 65, 66).toUpperCase(), rel: col(s, 67, 68).toUpperCase(), inds: [col(s, 69, 70), col(s, 71, 72), col(s, 73, 74)],
  };
}

function normO(s, dialect) {
  const condsOf = (a, b, c) => [a, b, c].filter(Boolean).map((x) => ({ n: x.toUpperCase().startsWith('N'), ind: x.toUpperCase().replace(/^N/, '') }));
  if (dialect === 'RPG3') {
    const andor = col(s, 14, 16).toUpperCase();
    if (!col(s, 7, 13) && (andor === 'AND' || andor === 'OR')) return { kind: andor.toLowerCase(), conds: condsOf(col(s, 23, 25), col(s, 26, 28), col(s, 29, 31)) };
    const name = col(s, 7, 14);
    const type = col(s, 15, 15).toUpperCase();
    if (name || (type && 'HDTE'.includes(type))) {
      return {
        kind: 'record', file: name, type, fetch: col(s, 16, 16).toUpperCase() === 'F', add: col(s, 16, 18).toUpperCase() === 'ADD', del: col(s, 16, 18).toUpperCase() === 'DEL',
        spaceBefore: Number(col(s, 17, 17) || 0), spaceAfter: col(s, 18, 18) === '' ? null : Number(col(s, 18, 18)), skipBefore: col(s, 19, 20), skipAfter: col(s, 21, 22),
        conds: condsOf(col(s, 23, 25), col(s, 26, 28), col(s, 29, 31)), excpt: col(s, 32, 37).toUpperCase(),
      };
    }
    return {
      kind: 'field', conds: condsOf(col(s, 23, 25), col(s, 26, 28), col(s, 29, 31)), name: fixName(col(s, 32, 37)).toUpperCase(), edit: col(s, 38, 38).toUpperCase(),
      blank: col(s, 39, 39).toUpperCase() === 'B', end: col(s, 40, 43), fmt: col(s, 44, 44).toUpperCase(), constant: s.slice(44, 70).trim(),
    };
  }
  const andor = col(s, 16, 18).toUpperCase();
  const name = col(s, 7, 15) ? col(s, 7, 16) : '';
  if (!name && (andor === 'AND' || andor === 'OR')) return { kind: andor.toLowerCase(), conds: condsOf(col(s, 21, 23), col(s, 24, 26), col(s, 27, 29)) };
  const type = col(s, 17, 17).toUpperCase();
  if (name || (type && 'HDTE'.includes(type))) {
    return {
      kind: 'record', file: name, type, fetch: col(s, 18, 18).toUpperCase() === 'F', add: col(s, 18, 20).toUpperCase() === 'ADD', del: col(s, 18, 20).toUpperCase() === 'DEL',
      spaceBefore: Number(col(s, 40, 42) || 0), spaceAfter: col(s, 43, 45) === '' ? null : Number(col(s, 43, 45)), skipBefore: col(s, 46, 48), skipAfter: col(s, 49, 51),
      conds: condsOf(col(s, 21, 23), col(s, 24, 26), col(s, 27, 29)), excpt: col(s, 30, 39).toUpperCase(),
    };
  }
  return {
    kind: 'field', conds: condsOf(col(s, 21, 23), col(s, 24, 26), col(s, 27, 29)), name: col(s, 30, 43).toUpperCase(), edit: col(s, 44, 44).toUpperCase(),
    blank: col(s, 45, 45).toUpperCase() === 'B', end: col(s, 47, 51), fmt: col(s, 52, 52).toUpperCase(), constant: s.slice(52, 80).trim(),
  };
}

// ---------- Generación ----------
export function convertFixed(lines, { dialect = 'RPG4' } = {}) {
  const out = [];
  const emit = (text, line) => out.push({ text, line });
  const lastLine = lines.length ? lines[lines.length - 1].line : 0;

  // Paso 1: clasificar y normalizar
  const recs = lines.map(({ text, line }) => ({ spec: text[5].toUpperCase(), s: text, line }));
  const cspecs = recs.filter((r) => r.spec === 'C').map((r) => ({ ...normC(r.s, dialect), line: r.line }));

  // KLIST / KFLD y PLIST con nombre (se pueden definir después de usarse)
  const klists = new Map();
  const plists = new Map();
  for (let i = 0; i < cspecs.length; i++) {
    const c = cspecs[i];
    if (c.op === 'KLIST' || (c.op === 'PLIST' && c.f1.toUpperCase() !== '*ENTRY')) {
      const list = [];
      let j = i + 1;
      while (j < cspecs.length && (cspecs[j].op === (c.op === 'KLIST' ? 'KFLD' : 'PARM') || (!cspecs[j].op && !cspecs[j].f1 && !cspecs[j].res))) { if (cspecs[j].op) list.push(cspecs[j]); j++; }
      (c.op === 'KLIST' ? klists : plists).set(c.f1.toUpperCase(), list);
    }
  }
  // Incremento de cada DO (factor 2 del ENDDO correspondiente)
  const doInc = new Map();
  {
    const st = [];
    cspecs.forEach((c, i) => {
      if (['DO', 'DOW', 'DOU'].includes(c.op) || /^DO[WU](EQ|NE|GT|LT|GE|LE)$/.test(c.op) || /^IF(EQ|NE|GT|LT|GE|LE)?$/.test(c.op) || c.op === 'SELECT' || /^CAS/.test(c.op) || c.op === 'FOR' || c.op === 'MONITOR') st.push({ i, op: c.op });
      if (/^END/.test(c.op) && c.op !== 'ENDSR') { const o = st.pop(); if (o && o.op === 'DO' && c.f2) doInc.set(o.i, c.f2); }
    });
  }
  const tables = new Set(); // TABxxx: se usan con el elemento actual
  const keyOf = (f1) => { const k = klists.get(String(f1).toUpperCase()); return k ? `(${k.map((x) => x.res).join(':')})` : f1; };
  const ref = (x) => { if (!x) return x; const u = x.toUpperCase(); return tables.has(u) ? `${u}($TI_${u})` : x; };

  let openBlock = null;
  const closeBlock = (line) => { if (openBlock && openBlock !== 'PI*') emit(`END-${openBlock};`, line); if (openBlock === 'PI*') emit('END-PI;', line); openBlock = null; };
  const fileInfo = new Map();

  // ---- E-specs (RPG III): arrays y tablas (equivale a D-spec DIM/CTDATA/PERRCD/ALT/FROMFILE/TOFILE) ----
  for (const r of recs.filter((x) => x.spec === 'E')) {
    const s = r.s;
    const fromFile = col(s, 11, 18), toFile = col(s, 19, 26);
    const name = col(s, 27, 32).toUpperCase();
    const perRec = col(s, 33, 35), entries = col(s, 36, 39), len = col(s, 40, 42), fmt = col(s, 43, 43).toUpperCase(), dec = col(s, 44, 44), seq = col(s, 45, 45).toUpperCase();
    const alt = col(s, 46, 51).toUpperCase();
    if (!name) continue;
    const arrType = (f, l, d) => (f === 'P' ? `PACKED(${(Number(l) || 1) * 2 - 1}:${d || 0})` : f === 'B' ? `BINDEC(${Number(l) === 2 ? 4 : 9}:${d || 0})` : d !== '' ? `ZONED(${l || 1}:${d})` : `CHAR(${l || 1})`);
    const kws = [`DIM(${entries || 1})`];
    if (!fromFile && perRec) kws.push('CTDATA', `PERRCD(${perRec})`);
    if (fromFile) kws.push(`FROMFILE(${fromFile})`, perRec ? `PERRCD(${perRec})` : '');
    if (toFile) kws.push(`TOFILE(${toFile})`);
    if (seq === 'A') kws.push('ASCEND');
    if (seq === 'D') kws.push('DESCEND');
    if (name.startsWith('TAB')) { tables.add(name); emit(`DCL-S $TI_${name} INT(10) INZ(1);`, r.line); }
    emit(`DCL-S ${name} ${arrType(fmt, len, dec)} ${kws.filter(Boolean).join(' ')};`, r.line);
    if (alt) {
      if (alt.startsWith('TAB')) { tables.add(alt); emit(`DCL-S $TI_${alt} INT(10) INZ(1);`, r.line); }
      emit(`DCL-S ${alt} ${arrType(col(s, 55, 55).toUpperCase(), col(s, 52, 54), col(s, 56, 56))} DIM(${entries || 1}) ALT(${name});`, r.line);
      fileInfo.set(`$ALT:${name}`, alt);
      fileInfo.set(`$ALT:${alt}`, name);
    }
  }
  // ---- L-specs (RPG III): longitud de página y desbordamiento ----
  for (const r of recs.filter((x) => x.spec === 'L')) fileInfo.set(`$L:${col(r.s, 7, 14).toUpperCase()}`, { formlen: Number(col(r.s, 15, 17) || 66), ofl: Number(col(r.s, 20, 22) || 60) });

  // ---- H / F / D / P ----
  let lastF = null;
  const fileDecls = [];
  for (const r of recs) {
    const { spec, s, line } = r;
    if (spec !== 'D' && spec !== 'I' && spec !== 'C' && spec !== 'O') closeBlock(line);
    if (spec === 'H') { if (dialect === 'RPG4') emit(`CTL-OPT ${col(s, 7, 80)};`, line); continue; }
    if (spec === 'F') {
      const f = normF(s, dialect);
      if (f.cont && !f.name) {
        if (lastF) {
          if (f.kw === 'SFILE') lastF.kws.push(`SFILE(${f.entry}:${f.extra})`);
          else if (f.kw === 'RENAME') lastF.kws.push(`RENAME(${f.extfmt || f.extra}:${f.entry})`);
          else if (f.kw === 'INFDS') lastF.kws.push(`INFDS(${f.entry})`);
          else if (f.kw === 'IGNORE') lastF.kws.push(`IGNORE(${f.entry})`);
          else if (f.kw === 'INCLUD') lastF.kws.push(`INCLUDE(${f.entry})`);
          else if (f.kw === 'COMIT') lastF.kws.push('COMMIT');
          else if (f.kw === 'PLIST' || f.kw === 'ID' || f.kw === 'SLN' || f.kw === 'INFSR') lastF.kws.push(`${f.kw}(${f.entry})`);
        }
        continue;
      }
      const usage = [];
      if (f.type === 'I') usage.push('*INPUT');
      if (f.type === 'U') usage.push('*UPDATE', '*DELETE');
      if (f.type === 'O') usage.push('*OUTPUT');
      if (f.type === 'C') usage.push('*INPUT', '*OUTPUT');
      if (f.add && !usage.includes('*OUTPUT')) usage.push('*OUTPUT');
      const progDesc = f.format === 'F';
      const device = f.device === 'SEQ' || f.device === 'SPECIAL' ? 'DISK' : f.device;
      const kws = f.kwText ? [f.kwText] : [];
      if (f.cont) { if (f.cont.kw === 'SFILE') kws.push(`SFILE(${f.cont.entry}:${f.cont.extra})`); else if (f.cont.kw === 'RENAME') kws.push(`RENAME(${f.cont.extra}:${f.cont.entry})`); }
      lastF = { name: f.name.toUpperCase(), device, usage, keyed: f.rat === 'K' || (dialect === 'RPG3' && f.org === 'I' && f.rat !== 'A'), kws, line, progDesc, reclen: Number(f.reclen || 0), keylen: Number(f.keylen || 0), keystart: Number(f.keystart || 0) };
      fileDecls.push(lastF);
      const L = fileInfo.get(`$L:${lastF.name}`);
      const ofl = f.ofl || (/OFLIND\(\*IN(\w\w)\)/i.exec(f.kwText)?.[1] || '');
      fileInfo.set(lastF.name, {
        file: lastF.name, desig: f.desig, eof: f.eof === 'E', progDesc, reclen: lastF.reclen, device, keyed: lastF.keyed,
        ofl: ofl.toUpperCase(), formlen: L?.formlen || Number(/FORMLEN\((\d+)\)/i.exec(f.kwText)?.[1] || 66), formofl: L?.ofl || Number(/FORMOFL\((\d+)\)/i.exec(f.kwText)?.[1] || 60),
      });
      continue;
    }
    if (spec === 'D') {
      lastF = null;
      const name = col(s, 7, 21);
      const ext = col(s, 22, 22).toUpperCase();
      const decl = col(s, 24, 25).toUpperCase();
      const from = col(s, 26, 32);
      const to = col(s, 33, 39);
      const t = col(s, 40, 40).toUpperCase();
      const dec = col(s, 41, 42);
      let kw = col(s, 44, 80);
      let len = to;
      if (from && to) {
        const bytes = Number(to) - Number(from) + 1;
        // Con posiciones desde/hasta la longitud es en bytes: P → 2n-1 dígitos, B → 4/9, I/U → 3/5/10/20, F → 4/8
        len = String(t === 'P' ? bytes * 2 - 1 : t === 'B' ? (bytes <= 2 ? 4 : 9) : t === 'I' || t === 'U' ? ({ 1: 3, 2: 5, 4: 10, 8: 20 }[bytes] || 10) : bytes);
        if (!/POS\(/i.test(kw)) kw = `POS(${from}) ${kw}`;
      }
      if (['DS', 'PR', 'PI', 'S', 'C'].includes(decl)) closeBlock(line);
      if (decl === 'DS') {
        if (ext === 'E' && !/EXTNAME/i.test(kw)) kw = `EXTNAME(${name}) ${kw}`;
        emit(`DCL-DS ${name || '*N'} ${len ? `LEN(${len}) ` : ''}${kw};`, line);
        openBlock = 'DS';
        continue;
      }
      if (decl === 'PR' || decl === 'PI') { emit(`DCL-${decl} ${name || '*N'} ${typeOf(t, len, dec, false)} ${kw};`, line); openBlock = decl; continue; }
      if (decl === 'S') {
        // Tablas de RPG (TABxxx con DIM): el nombre solo se refiere al elemento actual
        if (/^TAB/i.test(name) && /DIM\(/i.test(kw)) { tables.add(name.toUpperCase()); emit(`DCL-S $TI_${name.toUpperCase()} INT(10) INZ(1);`, line); }
        const altM = /ALT\((\w+)\)/i.exec(kw);
        if (altM) { fileInfo.set(`$ALT:${altM[1].toUpperCase()}`, name.toUpperCase()); fileInfo.set(`$ALT:${name.toUpperCase()}`, altM[1].toUpperCase()); }
        emit(`DCL-S ${name} ${typeOf(t, len, dec, false)} ${kw};`, line);
        continue;
      }
      if (decl === 'C') { emit(`DCL-C ${name} ${/^CONST\s*\(/i.test(kw) ? kw : `CONST(${kw})`};`, line); continue; }
      if (!name && !t && !len) {
        // continuación de palabras clave de la línea anterior
        if (kw && out.length) { const last = out[out.length - 1]; last.text = last.text.replace(/;\s*$/, ` ${kw};`); }
        continue;
      }
      emit(`${name || '*N'} ${typeOf(t, len, dec, openBlock === 'DS')} ${kw};`, line);
      continue;
    }
    if (spec === 'P') {
      closeBlock(line);
      const name = col(s, 7, 21);
      const be = col(s, 24, 24).toUpperCase();
      emit(be === 'B' ? `DCL-PROC ${name} ${col(s, 44, 80)};` : 'END-PROC;', line);
      continue;
    }
  }
  closeBlock(lastLine);
  // DCL-F al principio (antes de los cálculos)
  for (const f of fileDecls) {
    // Impresora descrita por programa: PRINTER(longitud); descrita externamente (PRTF): PRINTER(*EXT)
    const dev = f.device === 'PRINTER' ? (f.progDesc ? `PRINTER(${f.reclen || 132})` : 'PRINTER(*EXT)') : f.device;
    emit(`DCL-F ${f.name} ${dev}${f.usage.length && f.device !== 'PRINTER' ? ` USAGE(${f.usage.join(':')})` : f.device === 'PRINTER' ? ' USAGE(*OUTPUT)' : ''}${f.keyed ? ' KEYED' : ''} ${f.kws.join(' ')};`, f.line);
  }
  for (const [k, v] of fileInfo) if (!k.startsWith('$')) emit(`$FILEX '${b64(v)}';`, lastLine);

  // ---- I-specs ----
  const ispecs = [];
  let curRec = null;
  let curDs = null;
  for (const r of recs.filter((x) => x.spec === 'I')) {
    const i = normI(r.s, dialect);
    if (i.kind === 'const') { emit(`DCL-C ${i.name} ${i.value};`, r.line); continue; }
    if (i.kind === 'ds') {
      if (curDs) emit('END-DS;', r.line);
      const kws = [];
      if (i.ext) kws.push(`EXTNAME(${i.extfile || i.name})`);
      if (i.opt === 'U') kws.push('DTAARA(*AUTO)');
      if (i.opt === 'S') kws.push('PSDS');
      if (Number(i.occurs) > 1) kws.push(`OCCURS(${Number(i.occurs)})`);
      if (Number(i.len)) kws.push(`LEN(${Number(i.len)})`);
      emit(`DCL-DS ${i.name || '*N'} ${kws.join(' ')};`, r.line);
      curDs = i;
      curRec = null;
      continue;
    }
    if (curDs && i.kind === 'field') {
      emit(`${i.name} ${typeOf(i.fmt === 'P' ? 'P' : i.fmt === 'B' ? 'B' : '', String(i.fmt === 'P' ? (i.to - i.from + 1) * 2 - 1 : i.fmt === 'B' ? ((i.to - i.from + 1) === 2 ? 4 : 9) : i.to - i.from + 1), i.dec, true)} POS(${i.from});`, r.line);
      continue;
    }
    if (curDs && i.kind !== 'field') { emit('END-DS;', r.line); curDs = null; }
    if (i.kind === 'or' && curRec) { curRec.alts.push({ recInd: i.recInd || curRec.recInd, ids: parseIds(i.ids, dialect) }); continue; }
    if (i.kind === 'and' && curRec) { (curRec.alts.length ? curRec.alts[curRec.alts.length - 1] : curRec).ids.push(...parseIds(i.ids, dialect)); continue; }
    if (i.kind === 'record' || i.kind === 'extrec') { curRec = { ...i, ids: parseIds(i.ids, dialect), alts: [], fields: [], line: r.line }; ispecs.push(curRec); continue; }
    if ((i.kind === 'field' || i.kind === 'extfld') && curRec) curRec.fields.push(i);
  }
  if (curDs) emit('END-DS;', lastLine);
  // Variables de los campos descritos por programa
  const declared = new Set();
  for (const rec of ispecs) {
    for (const f of rec.fields) {
      if (f.kind !== 'field' || declared.has(f.name) || !f.name) continue;
      declared.add(f.name);
      const bytes = f.to - f.from + 1;
      const t = f.fmt === 'P' ? `PACKED(${bytes * 2 - 1}:${f.dec || 0})` : f.fmt === 'B' ? `BINDEC(${bytes === 2 ? 4 : 9}:${f.dec || 0})` : f.dec !== '' ? `ZONED(${bytes}:${f.dec})` : `CHAR(${bytes})`;
      emit(`DCL-S ${f.name} ${t};`, rec.line);
    }
    emit(`$ISPEC '${b64(rec)}';`, lastLine);
  }

  // ---- O-specs ----
  const outputs = [];
  let curOut = null;
  for (const r of recs.filter((x) => x.spec === 'O')) {
    const o = normO(r.s, dialect);
    if (o.kind === 'record') {
      if (!o.file && curOut) o.file = curOut.file;
      curOut = { ...o, condGroups: [o.conds], fields: [] };
      outputs.push(curOut);
      continue;
    }
    if (!curOut) continue;
    if (o.kind === 'and') { curOut.condGroups[curOut.condGroups.length - 1].push(...o.conds); continue; }
    if (o.kind === 'or') { curOut.condGroups.push(o.conds); continue; }
    if (o.kind === 'field') {
      let constant = null;
      let editWord = null;
      if (o.constant.startsWith("'")) {
        const m = /^'((?:[^']|'')*)'/.exec(o.constant);
        const v = m ? m[1].replace(/''/g, "'") : o.constant.slice(1);
        if (o.name) editWord = v; else constant = v;
      }
      if (/^\*ALL/.test(o.name) && !constant) { curOut.fields.push({ all: true }); continue; }
      curOut.fields.push({ name: ref(o.name) || null, constant, editWord, conds: o.conds, edit: o.edit, blank: o.blank, end: o.end, fmt: o.fmt });
    }
  }
  if (outputs.length) emit(`$OSPEC '${b64(outputs)}';`, lastLine);

  // ---- C-specs ----
  // Las declaraciones que generan los cálculos (campos de resultado, DEFINE, *ENTRY PLIST) se colocan delante
  const cStart = out.length;
  const hoist = [];
  const decl = (text, line) => hoist.push({ text, line });
  const stack = [];         // bloques abiertos: {op, wrapped}
  let pendingCond = null;   // IFxx/DOWxx/DOUxx/WHENxx + ANDxx/ORxx
  let pendingCall = null;
  let pendingPI = false;
  let condGroups = [];      // indicadores de condición acumulados con AN/OR
  let totalOpen = null;     // nivel de tiempo total abierto
  let casOpen = false;
  let mvrSeq = 0;
  let lastExt = null;
  const declaredRes = new Set();

  const ind = (x) => `*IN${x.toUpperCase()}`;
  const condExpr = (groups) => {
    const parts = groups.filter((g) => g.length).map((g) => g.map((c) => `${c.n ? 'NOT ' : ''}${ind(c.ind)}`).join(' AND '));
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(' OR ');
  };
  const flushCond = () => {
    if (!pendingCond) return;
    emit(`${pendingCond.op} ${pendingCond.expr};`, pendingCond.line);
    pendingCond = null;
  };
  const flushCall = (line) => {
    if (!pendingCall) return;
    emit(`CALL$ ${pendingCall.pgm} ${pendingCall.parms.join(' ')};`, pendingCall.line ?? line);
    for (const a of pendingCall.after) emit(a, line);
    if (pendingCall.lr) emit(`*IN${pendingCall.lr} = $CALLLR$;`, line);
    if (pendingCall.err) emit(`*IN${pendingCall.err} = *OFF;`, line);
    if (pendingCall.wrapped) emit('ENDIF;', line);
    pendingCall = null;
  };
  const setInd = (stmts, i, expr) => { if (i) stmts.push(`*IN${i.toUpperCase()} = ${expr};`); };
  const resultInds = (stmts, c, v) => {
    setInd(stmts, c.hi, `${v} > 0`);
    setInd(stmts, c.lo, `${v} < 0`);
    setInd(stmts, c.eq, `${v} = 0`);
  };
  const charInds = (stmts, c, v) => { setInd(stmts, c.eq, `${v} = *BLANKS`); };
  const declareRes = (c) => {
    if (c.op !== 'DEFINE' && c.len && c.res && !declaredRes.has(c.res.toUpperCase())) {
      declaredRes.add(c.res.toUpperCase());
      const nm = c.res.replace(/\(.*$/, '');
      decl(`DCL-S ${nm} ${c.dec !== '' ? `PACKED(${c.len}:${c.dec})` : `CHAR(${c.len})`};`, c.line);
    }
  };

  for (let idx = 0; idx < cspecs.length; idx++) {
    const c = cspecs[idx];
    const line = c.line;
    // Continuación del factor 2 ampliado (RPG IV): línea sin operación con texto en 36-80
    if (dialect === 'RPG4' && !c.op && !c.f1 && c.f2x && lastExt !== null) { const t = out[lastExt]; t.text = t.text.replace(/;\s*$/, ` ${c.f2x};`); continue; }
    // Cálculos de tiempo total (L0-L9, LR en 7-8)
    const lvl = c.lvl;
    const isTotal = /^L[0-9]$|^LR$/.test(lvl);
    if (isTotal && totalOpen !== lvl) {
      flushCall(line); flushCond();
      if (totalOpen) emit('$ENDTOTAL;', line);
      emit(`$TOTAL ${lvl};`, line);
      totalOpen = lvl;
    } else if (!isTotal && lvl !== 'AN' && lvl !== 'OR' && totalOpen) {
      flushCall(line); flushCond();
      emit('$ENDTOTAL;', line);
      totalOpen = null;
    }
    // Indicadores de condición con AN/OR
    if (lvl === 'AN' || lvl === 'OR') {
      if (lvl === 'OR') condGroups.push([...c.conds]); else (condGroups[condGroups.length - 1] || (condGroups[0] = [])).push(...c.conds);
      if (!c.op) continue;
    } else condGroups = [c.conds];
    if (!c.op) continue;
    const op = c.op;
    const ext = c.ext || '';

    if (op === 'KLIST' || op === 'KFLD') continue;
    if (op === 'PARM' && pendingCall) {
      pendingCall.parms.push(c.res);
      if (c.f2) emit(`${c.res} = ${c.f2};`, line);
      if (c.f1) pendingCall.after.push(`${c.f1} = ${c.res};`);
      declareRes(c);
      continue;
    }
    if (op === 'PLIST' && c.f1.toUpperCase() === '*ENTRY') { flushCall(line); flushCond(); decl('DCL-PI *N;', line); pendingPI = true; continue; }
    if (op === 'PLIST') { continue; }
    if (op === 'PARM') {
      if (pendingPI) decl(c.len ? `${c.res} ${c.dec !== '' ? `PACKED(${c.len}:${c.dec})` : `CHAR(${c.len})`};` : `${c.res} LIKE(${c.res});`, line);
      continue;
    }
    if (pendingPI) { decl('END-PI;', line); pendingPI = false; }
    flushCall(line);
    // ANDxx / ORxx continúan un IFxx / DOWxx / DOUxx / WHENxx
    const andor = /^(AND|OR)(EQ|NE|GT|LT|GE|LE)$/.exec(op);
    if (andor && pendingCond) { pendingCond.expr += ` ${andor[1]} ${ref(c.f1)} ${CMP[andor[2]]} ${ref(c.f2)}`; continue; }
    flushCond();

    const cond = condExpr(condGroups);
    declareRes(c);
    const f1 = ref(c.f1), f2 = ref(c.f2), res = ref(c.res);
    const stmts = [];
    let opens = null; // bloque que abre (para envolver con IF si está condicionado)
    let closes = false;

    const cmpm = /^(IF|DOW|DOU|WHEN)(EQ|NE|GT|LT|GE|LE)$/.exec(op);
    if (cmpm) {
      if (cond) { emit(`IF ${cond};`, line); }
      stack.push({ op: cmpm[1] === 'WHEN' ? 'WHEN' : cmpm[1], wrapped: !!cond && cmpm[1] !== 'WHEN' });
      if (cmpm[1] === 'WHEN') stack.pop();
      pendingCond = { op: cmpm[1], expr: `${f1} ${CMP[cmpm[2]]} ${f2}`, line };
      continue;
    }
    const casm = /^CAS(EQ|NE|GT|LT|GE|LE)?$/.exec(op);
    if (casm) {
      if (!casOpen) { emit('SELECT;', line); casOpen = true; stack.push({ op: 'CAS', wrapped: false }); }
      if (casm[1]) emit(`WHEN ${cond ? `(${cond}) AND ` : ''}${f1} ${CMP[casm[1]]} ${f2};`, line);
      else emit(cond ? `WHEN ${cond};` : 'OTHER;', line);
      emit(`EXSR ${res};`, line);
      continue;
    }
    const cabm = /^CAB(EQ|NE|GT|LT|GE|LE)?$/.exec(op);
    if (cabm) {
      const e = [cond, cabm[1] ? `${f1} ${CMP[cabm[1]]} ${f2}` : null].filter(Boolean).join(' AND ');
      if (c.hi || c.lo || c.eq) { setInd(stmts, c.hi, `${f1} > ${f2}`); setInd(stmts, c.lo, `${f1} < ${f2}`); setInd(stmts, c.eq, `${f1} = ${f2}`); stmts.forEach((x) => emit(x, line)); }
      if (e) { emit(`IF ${e};`, line); emit(`GOTO$ ${res};`, line); emit('ENDIF;', line); } else emit(`GOTO$ ${res};`, line);
      continue;
    }
    switch (op) {
      case 'EVAL': case 'EVALR': case 'EVAL-CORR': stmts.push(`${op === 'EVAL' ? `EVAL${ext ? `(${ext})` : ''} ` : `${op} `}${c.f2x};`); break;
      case 'IF': case 'DOW': case 'DOU': case 'WHEN': case 'ELSEIF': case 'FOR':
        if (op === 'IF' || op === 'DOW' || op === 'DOU' || op === 'FOR') opens = op;
        stmts.push(`${op} ${c.f2x};`); break;
      case 'CALLP': stmts.push(`CALLP${ext ? `(${ext})` : ''} ${c.f2x};`); break;
      case 'SORTA': stmts.push(`SORTA ${c.f2x || f2};`); break;
      case 'ON-ERROR': stmts.push(`ON-ERROR ${c.f2x};`); break;
      case 'RETURN': stmts.push(`RETURN ${c.f2x};`); break;
      case 'MONITOR': opens = 'MONITOR'; stmts.push('MONITOR;'); break;
      case 'SELECT': opens = 'SELECT'; stmts.push('SELECT;'); break;
      case 'ELSE': stmts.push('ELSE;'); break;
      case 'OTHER': stmts.push('OTHER;'); break;
      case 'ITER': case 'LEAVE': case 'LEAVESR': stmts.push(`${op};`); break;
      case 'ENDIF': case 'ENDDO': case 'ENDSL': case 'ENDFOR': case 'ENDMON': case 'ENDCS': case 'END': {
        const top = stack.pop();
        let closer = op;
        if (top) closer = top.op === 'IF' ? 'ENDIF' : top.op === 'SELECT' || top.op === 'CAS' ? 'ENDSL' : top.op === 'FOR' ? 'ENDFOR' : top.op === 'MONITOR' ? 'ENDMON' : 'ENDDO';
        if (top && top.op === 'CAS') casOpen = false;
        emit(`${closer};`, line);
        if (top && top.wrapped) emit('ENDIF;', line);
        continue;
      }
      case 'DO': {
        opens = 'FOR';
        const by = doInc.get(idx);
        const ix = res || `$DO${idx}`;
        if (!res) decl(`DCL-S ${ix} INT(10);`, line);
        stmts.push(c.f2 ? `FOR ${ix} = ${f1 || 1} TO ${f2}${by ? ` BY ${by}` : ''};` : `FOR ${ix} = 1 TO 1;`);
        break;
      }
      case 'BEGSR': stmts.push(`BEGSR ${c.f1};`); break;
      case 'ENDSR': if (c.f1) stmts.push(`TAG$ ${c.f1};`); stmts.push('ENDSR;'); break;
      case 'EXSR': stmts.push(`EXSR ${c.f2};`); break;
      case 'TAG': stmts.push(`TAG$ ${c.f1};`); break;
      case 'GOTO': stmts.push(`GOTO$ ${c.f2};`); break;
      case 'CALL': case 'CALLB': {
        const pl = plists.get(String(c.res).toUpperCase());
        pendingCall = { pgm: f2, parms: [], after: [], line, lr: c.eq, err: c.lo, wrapped: !!cond };
        if (cond) emit(`IF ${cond};`, line);
        if (pl) {
          for (const p of pl) { pendingCall.parms.push(p.res); if (p.f2) emit(`${p.res} = ${p.f2};`, line); if (p.f1) pendingCall.after.push(`${p.f1} = ${p.res};`); }
          flushCall(line);
        }
        continue;
      }
      case 'MOVE': case 'MOVEL':
        stmts.push(`${op}$${ext.includes('P') ? 'P' : ''} ${f2} : ${res};`);
        if (c.hi || c.lo || c.eq) { setInd(stmts, c.hi, `$NUM$(${res}) > 0`); setInd(stmts, c.lo, `$NUM$(${res}) < 0`); setInd(stmts, c.eq, `$ZB$(${res})`); }
        break;
      case 'MOVEA': stmts.push(`MOVEA$${ext.includes('P') ? 'P' : ''} ${f2} : ${res};`); break;
      case 'Z-ADD': stmts.push(`EVAL${ext ? `(${ext})` : ''} ${res} = ${f2};`); resultInds(stmts, c, res); break;
      case 'Z-SUB': stmts.push(`EVAL${ext ? `(${ext})` : ''} ${res} = -(${f2});`); resultInds(stmts, c, res); break;
      case 'ADD': stmts.push(`EVAL${ext ? `(${ext})` : ''} ${res} = ${f1 || res} + ${f2};`); resultInds(stmts, c, res); break;
      case 'SUB': stmts.push(`EVAL${ext ? `(${ext})` : ''} ${res} = ${f1 || res} - ${f2};`); resultInds(stmts, c, res); break;
      case 'MULT': stmts.push(`EVAL${ext ? `(${ext})` : ''} ${res} = ${f1 || res} * ${f2};`); resultInds(stmts, c, res); break;
      case 'DIV': {
        mvrSeq++;
        const next = cspecs[idx + 1];
        if (next && next.op === 'MVR') { decl(`DCL-S $DVD${mvrSeq} PACKED(31:10);`, line); decl(`DCL-S $DVS${mvrSeq} PACKED(31:10);`, line); stmts.push(`$DVD${mvrSeq} = ${f1 || res};`, `$DVS${mvrSeq} = ${f2};`); }
        stmts.push(`EVAL${ext ? `(${ext})` : ''} ${res} = ${f1 || res} / ${f2};`);
        resultInds(stmts, c, res);
        if (next && next.op === 'MVR') c.mvr = mvrSeq;
        break;
      }
      case 'MVR': { const prev = cspecs[idx - 1]; stmts.push(prev && prev.mvr ? `${res} = $DVD${prev.mvr} - %INT($DVD${prev.mvr} / $DVS${prev.mvr}) * $DVS${prev.mvr};` : `${res} = 0;`); resultInds(stmts, c, res); break; }
      case 'SQRT': stmts.push(`EVAL${ext ? `(${ext})` : ''} ${res} = %SQRT(${f2});`); resultInds(stmts, c, res); break;
      case 'XFOOT': stmts.push(`EVAL${ext ? `(${ext})` : ''} ${res} = %XFOOT(${f2.replace(/\(.*$/, '')});`); resultInds(stmts, c, res); break;
      case 'COMP': setInd(stmts, c.hi, `${f1} > ${f2}`); setInd(stmts, c.lo, `${f1} < ${f2}`); setInd(stmts, c.eq, `${f1} = ${f2}`); break;
      case 'CAT': {
        const [b, blanks] = String(c.f2).split(':');
        const left = f1 || res;
        stmts.push(blanks !== undefined ? `${res} = %TRIMR(${left}) + %SUBST(${"'" + ' '.repeat(40) + "'"}:1:${blanks}) + ${ref(b)};` : `${res} = ${left} + ${ref(b)};`);
        break;
      }
      case 'SCAN': {
        const [pat, plen] = String(c.f1).split(':');
        const [base, start] = String(c.f2).split(':');
        const p = plen ? `%SUBST(${ref(pat)}:1:${plen})` : ref(pat);
        if (res) stmts.push(`${res} = %SCAN(${p}:${ref(base)}${start ? `:${start}` : ''});`);
        setInd(stmts, c.eq, `%SCAN(${p}:${ref(base)}${start ? `:${start}` : ''}) > 0`);
        break;
      }
      case 'SUBST': {
        const [base, start] = String(c.f2).split(':');
        const e = `%SUBST(${ref(base)}:${start || 1}:${c.f1 || `%LEN(${ref(base)}) - ${start || 1} + 1`})`;
        stmts.push(ext.includes('P') ? `${res} = ${e};` : `%SUBST(${res}:1:${c.f1 || `%LEN(${e})`}) = ${e};`);
        break;
      }
      case 'CHECK': case 'CHECKR': {
        const [base, start] = String(c.f2).split(':');
        const e = `%${op}(${f1}:${ref(base)}${start ? `:${start}` : ''})`;
        if (res) stmts.push(`${res} = ${e};`);
        setInd(stmts, c.eq, `${e} > 0`);
        break;
      }
      case 'XLATE': {
        const [from, to] = String(c.f1).split(':');
        const [base, start] = String(c.f2).split(':');
        stmts.push(`${res} = %XLATE(${ref(from)}:${ref(to)}:${ref(base)}${start ? `:${start}` : ''});`);
        break;
      }
      case 'LOOKUP': {
        const arr = String(c.f2).replace(/\(.*$/, '').toUpperCase();
        const startIdx = /\((.+)\)$/.exec(c.f2)?.[1];
        const fnName = c.eq && c.hi ? '%LOOKUPGE' : c.eq && c.lo ? '%LOOKUPLE' : c.hi ? '%LOOKUPGT' : c.lo ? '%LOOKUPLT' : '%LOOKUP';
        if (tables.has(arr)) {
          stmts.push(`$TI_${arr} = ${fnName}(${f1}:${arr});`);
          const found = c.eq || c.hi || c.lo;
          if (found) stmts.push(`${ind(found)} = $TI_${arr} > 0;`);
          const alt = fileInfo.get(`$ALT:${arr}`) || (c.res && tables.has(c.res.toUpperCase()) ? c.res.toUpperCase() : null);
          if (alt) stmts.push(`IF $TI_${arr} > 0;`, `$TI_${alt} = $TI_${arr};`, 'ENDIF;');
          stmts.push(`IF $TI_${arr} = 0;`, `$TI_${arr} = 1;`, 'ENDIF;');
        } else {
          const found = c.eq || c.hi || c.lo;
          if (startIdx && /^[A-Z#@$]/i.test(startIdx)) {
            stmts.push(`${startIdx} = ${fnName}(${f1}:${arr}:${startIdx});`);
            if (found) stmts.push(`${ind(found)} = ${startIdx} > 0;`);
            stmts.push(`IF ${startIdx} = 0;`, `${startIdx} = 1;`, 'ENDIF;');
          } else if (found) stmts.push(`${ind(found)} = ${fnName}(${f1}:${arr}${startIdx ? `:${startIdx}` : ''}) > 0;`);
        }
        break;
      }
      case 'TIME': stmts.push(`${res} = $TIME$(%LEN(%CHAR(${res})));`); break;
      case 'SETON': for (const i of [c.hi, c.lo, c.eq]) setInd(stmts, i, '*ON'); break;
      case 'SETOFF': case 'SETOF': for (const i of [c.hi, c.lo, c.eq]) setInd(stmts, i, '*OFF'); break;
      case 'DSPLY': stmts.push(`DSPLY ${f1 || "''"} ${f2 || "''"} ${res};`); break;
      case 'CLEAR': case 'RESET': stmts.push(`${op} ${c.f2 || c.res};`); break;
      case 'DEFINE': {
        if (c.f1.toUpperCase() === '*LIKE') decl(`DCL-S ${c.res} LIKE(${c.f2}${c.len && /^[+-]/.test(c.len) ? `:${c.len}` : ''});`, line);
        else if (c.f1.toUpperCase() === '*DTAARA') stmts.push(`$DTAARA$ ${c.res || c.f2} '${c.f2 || c.res}';`);
        break;
      }
      case 'IN': case 'OUT': stmts.push(`${op}$ ${c.f2};`); break;
      case 'UNLOCK': case 'FEOD': case 'DUMP': case 'FORCE': case 'NEXT': case 'POST': case 'ACQ': case 'REL': case 'SHTDN': case 'DEALLOC': stmts.push(op === 'SHTDN' && c.hi ? `*IN${c.hi} = *OFF;` : `// ${op}`); break;
      case 'OCCUR': {
        // factor 1: fija la aparición; resultado: recibe la aparición actual; indicador ER (73-74) si está fuera de rango
        const body = [...(c.f1 ? [`%OCCUR(${f2}) = ${f1};`] : []), ...(c.res ? [`${res} = %OCCUR(${f2});`] : [])];
        if (c.lo) stmts.push(`*IN${c.lo} = *OFF;`, 'MONITOR;', ...body, 'ON-ERROR;', `*IN${c.lo} = *ON;`, 'ENDMON;');
        else stmts.push(...body);
        break;
      }
      case 'TESTN': setInd(stmts, c.hi, `$TESTN$(${res}) = 1`); setInd(stmts, c.lo, `$TESTN$(${res}) = 2`); setInd(stmts, c.eq, `${res} = *BLANKS`); break;
      case 'TESTZ': setInd(stmts, c.hi, '*OFF'); setInd(stmts, c.lo, '*OFF'); setInd(stmts, c.eq, '*ON'); break;
      case 'TEST': stmts.push('MONITOR;', `$TEST$ '${ext}' : ${c.f1 || "''"} : ${res};`, ...(c.lo ? [`*IN${c.lo} = *OFF;`] : []), 'ON-ERROR;', ...(c.lo ? [`*IN${c.lo} = *ON;`] : []), 'ENDMON;'); break;
      case 'ADDDUR': case 'SUBDUR': {
        const [n, unit] = String(c.f2).split(':');
        if (op === 'ADDDUR') stmts.push(`${res} = ${f1 || res} + %${({ '*D': 'DAYS', '*DAYS': 'DAYS', '*M': 'MONTHS', '*MONTHS': 'MONTHS', '*Y': 'YEARS', '*YEARS': 'YEARS', '*H': 'HOURS', '*HOURS': 'HOURS', '*MN': 'MINUTES', '*MINUTES': 'MINUTES', '*S': 'SECONDS', '*SECONDS': 'SECONDS' })[String(unit).toUpperCase()] || 'DAYS'}(${n});`);
        else if (/:/.test(c.res)) { const [r2, u2] = String(c.res).split(':'); stmts.push(`${r2} = %DIFF(${f1}:${ref(n)}:${u2});`); }
        else stmts.push(`${res} = ${f1 || res} - %${({ '*D': 'DAYS', '*DAYS': 'DAYS', '*M': 'MONTHS', '*MONTHS': 'MONTHS', '*Y': 'YEARS', '*YEARS': 'YEARS' })[String(unit).toUpperCase()] || 'DAYS'}(${n});`);
        break;
      }
      case 'EXTRCT': { const [d, u] = String(c.f2).split(':'); stmts.push(`${res} = %SUBDT(${ref(d)}:${u});`); break; }
      case 'EXCEPT': stmts.push(`EXCEPT ${c.f2 || ''};`); break;
      case 'COMMIT': stmts.push('COMMIT;'); break;
      case 'ROLBK': stmts.push('ROLBK;'); break;
      case 'CHAIN': case 'SETLL': case 'SETGT': case 'READE': case 'READPE': case 'DELETE': case 'DELET': {
        const o = op === 'DELET' ? 'DELETE' : op;
        const keyed = o !== 'DELETE' || c.f1;
        stmts.push(`${o}${ext ? `(${ext.replace('N', 'N')})` : ''} ${keyed ? keyOf(f1) + ' ' : ''}${f2}${res ? ` ${res}` : ''};`.replace(/  +/g, ' '));
        if (o === 'CHAIN') setInd(stmts, c.hi, `NOT %FOUND(${f2})`);
        if (o === 'DELETE' && c.f1) setInd(stmts, c.hi, `NOT %FOUND(${f2})`);
        if (o === 'SETLL') { setInd(stmts, c.hi, `NOT %FOUND(${f2})`); setInd(stmts, c.eq, `%EQUAL(${f2})`); }
        if (o === 'SETGT') setInd(stmts, c.hi, `NOT %FOUND(${f2})`);
        if (o === 'READE' || o === 'READPE') setInd(stmts, c.eq, `%EOF(${f2})`);
        if (c.lo) setInd(stmts, c.lo, `%ERROR`);
        break;
      }
      case 'READ': case 'READP': case 'READC': case 'WRITE': case 'UPDATE': case 'UPDAT': case 'EXFMT': case 'OPEN': case 'CLOSE': {
        const o = op === 'UPDAT' ? 'UPDATE' : op;
        stmts.push(`${o}${ext ? `(${ext})` : ''} ${f2}${res ? ` ${res}` : ''};`);
        if (o === 'READ' || o === 'READP' || o === 'READC') setInd(stmts, c.eq, `%EOF(${f2})`);
        if (c.lo) setInd(stmts, c.lo, `%ERROR`);
        break;
      }
      case 'BITON': case 'BITOFF': stmts.push(`$${op}$ '${String(c.f2).replace(/'/g, '')}' : ${res};`); break;
      case 'TESTB': setInd(stmts, c.hi, `$TESTB$('${String(c.f2).replace(/'/g, '')}':${res}) = 0`); setInd(stmts, c.lo, `$TESTB$('${String(c.f2).replace(/'/g, '')}':${res}) = 1`); setInd(stmts, c.eq, `$TESTB$('${String(c.f2).replace(/'/g, '')}':${res}) = 2`); break;
      case 'MHHZO': case 'MHLZO': case 'MLHZO': case 'MLLZO': stmts.push(`// ${op} ${f2} ${res}`); break;
      default:
        stmts.push(`$UNSUPPORTED '${op}';`);
    }
    if (!stmts.length) continue;
    lastExt = null;
    if (cond && !opens) { emit(`IF ${cond};`, line); for (const st of stmts) emit(st, line); emit('ENDIF;', line); if (EXT_F2.has(op)) lastExt = out.length - 2; continue; }
    if (cond && opens) emit(`IF ${cond};`, line);
    for (const st of stmts) emit(st, line);
    if (EXT_F2.has(op)) lastExt = out.length - 1;
    if (opens) stack.push({ op: opens, wrapped: !!cond });
    void closes;
  }
  if (pendingPI) decl('END-PI;', lastLine);
  flushCall(lastLine);
  flushCond();
  if (totalOpen) emit('$ENDTOTAL;', lastLine);
  out.splice(cStart, 0, ...hoist);
  return out;
}

// Códigos de identificación de registro: hasta 3 grupos posición/N/C-Z-D/carácter.
function parseIds(str, dialect) {
  const w = dialect === 'RPG3' ? 4 : 5;
  const out = [];
  const g = w + 3;
  for (let k = 0; k < 3; k++) {
    const seg = String(str || '').slice(k * g, k * g + g).padEnd(g);
    const pos = Number(seg.slice(0, w).trim() || 0);
    if (!pos) continue;
    out.push({ pos, not: seg[w].toUpperCase() === 'N', czd: (seg[w + 1].trim() || 'C').toUpperCase(), ch: seg[w + 2] });
  }
  return out;
}

/** Separa los datos de tiempo de compilación (** / **CTDATA nombre) del fuente. */
export function splitCtdata(srcLines) {
  const src = [];
  const blocks = [];
  let cur = null;
  for (const raw of srcLines) {
    const l = String(raw ?? '');
    if (/^\*\*(\s|$|CTDATA|FTRANS|ALTSEQ)/i.test(l) && !/^\*\*FREE/i.test(l)) {
      const m = /^\*\*CTDATA\s+(\S+)/i.exec(l);
      cur = { name: m ? m[1].toUpperCase() : null, lines: [] };
      blocks.push(cur);
      continue;
    }
    if (cur) cur.lines.push(l); else src.push(l);
  }
  return { src, blocks };
}
