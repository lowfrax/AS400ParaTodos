// CVTRPGSRC: conversión de fuente RPG III / RPG/400 / RPG II (columnas de RPG III) a ILE RPG (RPG IV) en columnas fijas,
// como el mandato de IBM i. Cada especificación se reubica en las columnas de RPG IV:
//   E-specs → D-specs (DIM, CTDATA, PERRCD, ALT, FROMFILE, TOFILE, ASCEND/DESCEND)
//   L-specs → palabras clave FORMLEN/FORMOFL de la F-spec de impresora
//   Estructuras de datos y constantes de las I-specs → D-specs
//   Varios indicadores de condición en una C-spec → líneas AN previas
//   Códigos de operación de 5 caracteres → nombres de RPG IV (LOOKU→LOOKUP, EXCPT→EXCEPT…), semiajuste → (H)

const col = (s, a, b) => s.slice(a - 1, b);
const trim = (s, a, b) => col(s, a, b).trim();
const OP3 = {
  LOOKU: 'LOOKUP', EXCPT: 'EXCEPT', SETOF: 'SETOFF', DELET: 'DELETE', UPDAT: 'UPDATE', COMIT: 'COMMIT', CHEKR: 'CHECKR',
  REDPE: 'READPE', DEFN: 'DEFINE', BITOF: 'BITOFF', OCUR: 'OCCUR', RETRN: 'RETURN', SELEC: 'SELECT', UNLCK: 'UNLOCK',
  DEBUG: 'DUMP', FREE: 'DEALLOC',
};

// Línea de RPG IV: coloca cada texto en su columna (base 1)
function line(seq, spec, cols) {
  let s = (seq || '').padEnd(5).slice(0, 5) + spec;
  for (const [pos, text] of Object.entries(cols).sort((a, b) => a[0] - b[0])) {
    if (text === undefined || text === null || text === '') continue;
    const p = Number(pos) - 1;
    s = s.padEnd(p) + text;
  }
  return s.replace(/\s+$/, '');
}
const rj = (v, w) => (v === '' || v === undefined ? '' : String(v).padStart(w));

export function cvtrpgsrc(srcLines, { name = '' } = {}) {
  const lines = srcLines.map((l) => String(l && typeof l === 'object' ? l.text : l ?? ''));
  const out = [];
  const log = [];
  // Datos de tiempo de compilación al final: se copian sin cambios
  let end = lines.findIndex((l) => /^\*\*(\s|$|CTDATA)/i.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(0, end);
  const tail = lines.slice(end);

  // L-specs: longitud de formulario por archivo
  const forms = new Map();
  for (const l of body) if ((l[5] || '').toUpperCase() === 'L' && l[6] !== '*') forms.set(trim(l, 7, 14).toUpperCase(), { len: Number(trim(l, 15, 17) || 66), ofl: Number(trim(l, 20, 22) || 60) });

  const dspecs = [];  // D-specs generadas (E-specs, DS, constantes) que van tras las F-specs
  let fDone = false;
  let inDs = false;
  const flushD = () => { if (!fDone) { out.push(...dspecs); dspecs.length = 0; fDone = true; } };

  for (let i = 0; i < body.length; i++) {
    const l = body[i].padEnd(80);
    const seq = l.slice(0, 5).trim() ? l.slice(0, 5) : '';
    const spec = l[5].toUpperCase();
    if (l[6] === '*' || !l.trim() || spec === ' ') { out.push(l.replace(/\s+$/, '')); continue; }
    if (l[6] === '/') { out.push(l.replace(/\s+$/, '')); continue; }
    switch (spec) {
      case 'H': {
        const kws = [];
        if (trim(l, 15, 15) === '1') kws.push('DEBUG');
        const df = trim(l, 19, 19).toUpperCase();
        if (df === 'D') kws.push('DATEDIT(*DMY)');
        else if (df === 'Y') kws.push('DATEDIT(*YMD)');
        if (trim(l, 18, 18)) kws.push(`CURSYM('${trim(l, 18, 18)}')`);
        if (trim(l, 21, 21).toUpperCase() === 'J' || trim(l, 21, 21).toUpperCase() === 'D') kws.push('DECEDIT(\',\')');
        out.push(line(seq, 'H', { 7: kws.join(' ') }));
        break;
      }
      case 'F': {
        if (trim(l, 53, 53).toUpperCase() === 'K' && !trim(l, 7, 14)) {
          // Continuación: palabra clave en 54-59
          const kw = trim(l, 54, 59).toUpperCase();
          const entry = trim(l, 60, 67);
          const ext = trim(l, 19, 28) || trim(l, 47, 52);
          const map = { RENAME: `RENAME(${ext}:${entry})`, SFILE: `SFILE(${ext}:${entry})`, INFDS: `INFDS(${entry})`, INFSR: `INFSR(${entry})`, IGNORE: `IGNORE(${entry})`, INCLUD: `INCLUDE(${entry})`, COMIT: 'COMMIT', PLIST: `PLIST(${entry})`, ID: `ID(${entry})`, SLN: `SLN(${entry})`, PRTCTL: `PRTCTL(${entry})`, FORMSA: '' };
          out.push(line(seq, 'F', { 44: map[kw] !== undefined ? map[kw] : `${kw}(${entry})` }));
          break;
        }
        const nm = trim(l, 7, 14).toUpperCase();
        const kws = [];
        const ofl = trim(l, 33, 34).toUpperCase();
        if (ofl) kws.push(`OFLIND(*IN${ofl})`);
        const f = forms.get(nm);
        if (f) kws.push(`FORMLEN(${f.len})`, `FORMOFL(${f.ofl})`);
        if (trim(l, 53, 53).toUpperCase() === 'K') {
          const kw = trim(l, 54, 59).toUpperCase();
          const entry = trim(l, 60, 67);
          if (kw === 'RENAME') kws.push(`RENAME(${trim(l, 47, 52)}:${entry})`);
          else if (kw === 'SFILE') kws.push(`SFILE(${trim(l, 47, 52)}:${entry})`);
          else if (kw) kws.push(`${kw}(${entry})`);
        }
        const device = trim(l, 40, 46).toUpperCase();
        out.push(line(seq, 'F', {
          7: nm, 17: trim(l, 15, 15), 18: trim(l, 16, 16), 19: trim(l, 17, 17), 20: trim(l, 66, 66), 21: trim(l, 18, 18), 22: trim(l, 19, 19),
          23: rj(trim(l, 24, 27), 5), 28: trim(l, 28, 28), 29: rj(trim(l, 29, 30), 5), 34: trim(l, 31, 31), 35: trim(l, 32, 32),
          36: device === 'WORKSTN' ? 'WORKSTN' : device, 44: kws.join(' '),
        }));
        break;
      }
      case 'L': break; // integradas en la F-spec
      case 'E': {
        const fromFile = trim(l, 11, 18), toFile = trim(l, 19, 26), arr = trim(l, 27, 32).toUpperCase();
        if (!arr) break;
        const per = trim(l, 33, 35), num = trim(l, 36, 39), len = trim(l, 40, 42), fmt = trim(l, 43, 43).toUpperCase(), dec = trim(l, 44, 44), sq = trim(l, 45, 45).toUpperCase();
        const alt = trim(l, 46, 51).toUpperCase();
        const dType = (f, d) => (f === 'P' ? 'P' : f === 'B' ? 'B' : d !== '' ? 'S' : 'A');
        const dLen = (f, L) => (f === 'P' ? String(Number(L) * 2 - 1) : f === 'B' ? (Number(L) === 2 ? '4' : '9') : L);
        const kws = [`DIM(${Number(num) || 1})`];
        if (!fromFile && per) kws.push('CTDATA', `PERRCD(${Number(per)})`);
        if (fromFile) kws.push(`FROMFILE(${fromFile})`, ...(per ? [`PERRCD(${Number(per)})`] : []));
        if (toFile) kws.push(`TOFILE(${toFile})`);
        if (sq === 'A') kws.push('ASCEND');
        if (sq === 'D') kws.push('DESCEND');
        dspecs.push(line(seq, 'D', { 7: arr, 24: 'S', 33: rj(dLen(fmt, len), 7), 40: dType(fmt, dec), 41: rj(dec, 2), 44: kws.join(' ') }));
        if (alt) {
          const al = trim(l, 52, 54), af = trim(l, 55, 55).toUpperCase(), ad = trim(l, 56, 56), as = trim(l, 57, 57).toUpperCase();
          const k2 = [`DIM(${Number(num) || 1})`, `ALT(${arr})`];
          if (as === 'A') k2.push('ASCEND');
          if (as === 'D') k2.push('DESCEND');
          dspecs.push(line(seq, 'D', { 7: alt, 24: 'S', 33: rj(dLen(af, al), 7), 40: dType(af, ad), 41: rj(ad, 2), 44: k2.join(' ') }));
        }
        break;
      }
      case 'I': {
        const nm = trim(l, 7, 14);
        const dsMark = trim(l, 19, 20).toUpperCase();
        // Estructura de datos
        if (dsMark === 'DS') {
          inDs = true;
          const kws = [];
          const ext = trim(l, 17, 17).toUpperCase() === 'E';
          const opt = trim(l, 18, 18).toUpperCase();
          if (ext) kws.push(`EXTNAME(${trim(l, 21, 30) || nm})`);
          if (opt === 'U') kws.push('DTAARA(*AUTO)');
          if (opt === 'S') kws.push('PSDS');
          if (Number(trim(l, 44, 47)) > 1) kws.push(`OCCURS(${Number(trim(l, 44, 47))})`);
          const len = trim(l, 48, 51);
          dspecs.push(line(seq, 'D', { 7: nm, 22: ext ? 'E' : '', 23: opt === 'S' ? 'S' : opt === 'U' ? 'U' : '', 24: 'DS', 33: rj(len, 7), 44: kws.filter((k) => k !== 'PSDS').join(' ') }));
          break;
        }
        // Constante con nombre
        if (!nm && trim(l, 43, 43).toUpperCase() === 'C' && trim(l, 53, 58)) {
          inDs = false;
          dspecs.push(line(seq, 'D', { 7: trim(l, 53, 58), 24: 'C', 44: `CONST(${col(l, 21, 42).trim()})` }));
          break;
        }
        if (inDs && !nm && (trim(l, 44, 51) || trim(l, 53, 58))) {
          const from = trim(l, 44, 47), to = trim(l, 48, 51), f = trim(l, 43, 43).toUpperCase(), dec = trim(l, 52, 52);
          const fname = trim(l, 53, 58);
          if (trim(l, 21, 30) && !from) { dspecs.push(line(seq, 'D', { 7: fname, 22: 'E', 24: '', 44: `EXTFLD(${trim(l, 21, 30)})` })); break; }
          dspecs.push(line(seq, 'D', { 7: fname, 26: rj(from, 7), 33: rj(to, 7), 40: f === 'P' ? 'P' : f === 'B' ? 'B' : dec !== '' ? 'S' : 'A', 41: rj(dec, 2) }));
          break;
        }
        inDs = false;
        if (!trim(l, 7, 13) && /^(AND|OR)$/i.test(trim(l, 14, 16))) {
          out.push(line(seq, 'I', { 16: trim(l, 14, 16).toUpperCase(), 21: trim(l, 19, 20), ...idsCols(l) }));
          break;
        }
        if (nm) {
          out.push(line(seq, 'I', { 7: nm, 17: trim(l, 15, 16), 19: trim(l, 17, 17), 20: trim(l, 18, 18), 21: trim(l, 19, 20), ...idsCols(l) }));
          break;
        }
        // Campo de entrada (descrito por programa o renombrado externo)
        if (trim(l, 21, 30) && !trim(l, 44, 51)) {
          out.push(line(seq, 'I', { 21: trim(l, 21, 30), 49: trim(l, 53, 58), 63: trim(l, 59, 60), 65: trim(l, 61, 62), 69: trim(l, 65, 66), 71: trim(l, 67, 68), 73: trim(l, 69, 70) }));
          break;
        }
        const f = trim(l, 43, 43).toUpperCase();
        const dec = trim(l, 52, 52);
        out.push(line(seq, 'I', {
          36: f === 'P' ? 'P' : f === 'B' ? 'B' : dec !== '' ? 'S' : trim(l, 44, 51) ? 'A' : '', 37: rj(trim(l, 44, 47), 5), 42: rj(trim(l, 48, 51), 5), 47: rj(dec, 2),
          49: fixName(trim(l, 53, 58)), 63: trim(l, 59, 60), 65: trim(l, 61, 62), 67: trim(l, 63, 64), 69: trim(l, 65, 66), 71: trim(l, 67, 68), 73: trim(l, 69, 70),
        }));
        break;
      }
      case 'C': {
        flushD();
        const lvl = trim(l, 7, 8);
        const inds = [trim(l, 9, 11), trim(l, 12, 14), trim(l, 15, 17)].filter(Boolean);
        let op = trim(l, 28, 32).toUpperCase();
        op = OP3[op] || op.replace(/^WH(EQ|NE|GT|LT|GE|LE)$/, 'WHEN$1');
        const half = trim(l, 53, 53).toUpperCase() === 'H';
        if (half && op) op += '(H)';
        // Indicadores de condición adicionales → líneas AN previas
        const first = inds.shift() || '';
        if (inds.length) {
          out.push(line(seq, 'C', { 7: lvl, 9: first.padStart(3) }));
          for (let k = 0; k < inds.length - 1; k++) out.push(line('', 'C', { 7: 'AN', 9: inds[k].padStart(3) }));
        }
        const lastInd = inds.length ? inds[inds.length - 1] : first;
        out.push(line(seq && !inds.length ? seq : '', 'C', {
          7: inds.length ? 'AN' : lvl, 9: lastInd ? lastInd.padStart(3) : '', 12: fixName(trim(l, 18, 27)), 26: op, 36: fixName(trim(l, 33, 42)),
          50: fixName(trim(l, 43, 48)), 64: rj(trim(l, 49, 51), 5), 69: rj(trim(l, 52, 52), 2), 71: trim(l, 54, 55), 73: trim(l, 56, 57), 75: trim(l, 58, 59),
        }));
        break;
      }
      case 'O': {
        flushD();
        const nm = trim(l, 7, 14);
        const andor = trim(l, 14, 16).toUpperCase();
        const indCols = { 21: trim(l, 23, 25), 24: trim(l, 26, 28), 27: trim(l, 29, 31) };
        if (!trim(l, 7, 13) && (andor === 'AND' || andor === 'OR')) { out.push(line(seq, 'O', { 16: andor, ...indCols })); break; }
        const type = trim(l, 15, 15).toUpperCase();
        if (nm || (type && 'HDTE'.includes(type))) {
          const fa = trim(l, 16, 18).toUpperCase();
          const isAddDel = fa === 'ADD' || fa === 'DEL';
          out.push(line(seq, 'O', {
            7: nm, 17: type, 18: isAddDel ? fa : trim(l, 16, 16), ...indCols, 30: trim(l, 32, 37),
            40: isAddDel ? '' : rj(trim(l, 17, 17), 3), 43: isAddDel ? '' : rj(trim(l, 18, 18), 3), 46: rj(trim(l, 19, 20), 3), 49: rj(trim(l, 21, 22), 3),
          }));
          break;
        }
        out.push(line(seq, 'O', { ...indCols, 30: fixName(trim(l, 32, 37)), 44: trim(l, 38, 38), 45: trim(l, 39, 39), 47: rj(trim(l, 40, 43), 5), 52: trim(l, 44, 44), 53: col(l, 45, 70).trim() }));
        break;
      }
      default:
        out.push(l.replace(/\s+$/, ''));
        log.push(`Specification ${spec} copied without change.`);
    }
    if (spec === 'F' || spec === 'H' || spec === 'E' || spec === 'L' || spec === 'I') continue;
  }
  flushD();
  // Las D-specs deben ir tras las F-specs y antes de las I-specs: se reordena el resultado
  const order = { H: 0, F: 1, D: 2, I: 3, C: 4, O: 5 };
  const sorted = [];
  const buckets = { H: [], F: [], D: [], I: [], C: [], O: [] };
  let lastSpec = 'H';
  for (const ln of out) {
    const sp = (ln[5] || '').toUpperCase();
    if (buckets[sp]) { buckets[sp].push(ln); lastSpec = sp; } else buckets[lastSpec].push(ln); // comentarios con la especificación anterior
  }
  for (const k of Object.keys(order)) sorted.push(...buckets[k]);
  return { lines: [...sorted, ...tail], log };
}

function idsCols(l) {
  // 3 grupos: RPG III 21-41 (pos 4, N, C/Z/D, carácter) → RPG IV 23-46 (pos 5, N, C/Z/D, carácter)
  const out = {};
  for (let k = 0; k < 3; k++) {
    const b3 = 21 + k * 7;
    const b4 = 23 + k * 8;
    const pos = trim(l, b3, b3 + 3);
    if (!pos) continue;
    out[b4] = rj(pos, 5);
    out[b4 + 5] = trim(l, b3 + 4, b3 + 4);
    out[b4 + 6] = trim(l, b3 + 5, b3 + 5);
    out[b4 + 7] = col(l, b3 + 6, b3 + 6);
  }
  return out;
}

function fixName(x) {
  if (!x || x.startsWith("'")) return x;
  return x.replace(/\*IN,(\d\d|[A-Z][A-Z0-9])/gi, '*IN$1').replace(/^([A-Z#@$][\w#@$]*),([A-Z#@$\d][\w#@$]*)$/i, '$1($2)');
}
