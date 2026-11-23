// Ciclo RPG (RPG II / RPG III / RPG IV): archivos primario/secundarios, indicadores de identificación de registro,
// niveles de control L1-L9, registros coincidentes (M1-M9 → MR), cálculos de detalle y de total, salida H/D/T/E
// (O-specs) con impresora paginada (espaciado, saltos, desbordamiento OA-OG/OV), códigos y palabras de edición.
import { RpgError, toStr, toNumber, editc, blank, coerce, isNumType, isCharType, charLen, truthy } from './types.js';

const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'];

// ---------- Impresora paginada ----------
export class Printer {
  constructor(h, { formlen = 66, ofl = 60, width = 132, onOverflow } = {}) {
    this.h = h;
    this.formlen = formlen || 66;
    this.ofl = Math.min(ofl || 60, this.formlen);
    this.width = width || 132;
    this.onOverflow = onOverflow;
    this.page = [];
    this.cur = 1;
    this.pages = 0;
    this.used = false;
    this.ofDone = false;
  }
  flushPage(last) {
    let lines = this.page;
    if (last) { let n = lines.length; while (n && !lines[n - 1]) n--; lines = lines.slice(0, n); }
    else while (lines.length < this.formlen) lines.push('');
    if (lines.length || !last) { for (const l of lines) this.h.write(l || ''); this.pages++; }
    this.page = [];
    this.cur = 1;
    this.used = false;
    this.ofDone = false;
  }
  newPage() { if (this.used || this.page.length) this.flushPage(false); }
  checkOverflow() {
    if (!this.ofDone && this.cur > this.ofl) { this.ofDone = true; if (this.onOverflow) this.onOverflow(); }
  }
  skipTo(n) {
    if (!n) return;
    if (n < this.cur || (n === this.cur && this.used && this.page[n - 1])) this.newPage();
    this.cur = n;
    this.checkOverflow();
  }
  space(n) {
    if (!n) return;
    this.cur += n;
    if (this.cur > this.formlen) { this.flushPage(false); }
    else this.checkOverflow();
  }
  print(text) {
    while (this.page.length < this.cur) this.page.push('');
    const old = this.page[this.cur - 1] || '';
    const t = String(text).slice(0, this.width);
    // Sobreimpresión: las posiciones en blanco del nuevo texto conservan lo anterior
    let out = '';
    for (let i = 0; i < Math.max(old.length, t.length); i++) out += t[i] && t[i] !== ' ' ? t[i] : (old[i] || ' ');
    this.page[this.cur - 1] = out.replace(/\s+$/, '');
    this.used = true;
  }
  // Escritura de una línea con control de impresión RPG
  line(text, { skipBefore, spaceBefore, skipAfter, spaceAfter } = {}) {
    if (skipBefore) this.skipTo(Number(skipBefore));
    if (spaceBefore) this.space(Number(spaceBefore));
    this.print(text);
    if (skipAfter) this.skipTo(Number(skipAfter));
    if (spaceAfter === null || spaceAfter === undefined) { if (!skipBefore && !spaceBefore && !skipAfter) this.space(1); }
    else this.space(Number(spaceAfter));
  }
  close() { this.flushPage(true); return this.pages; }
}

// ---------- Palabras de edición ----------
export function editWord(n, word, dec = 0) {
  const neg = n < 0;
  const w = String(word);
  const isDigitPos = (c) => c === ' ' || c === '0' || c === '*';
  let lastDigit = -1;
  for (let i = 0; i < w.length; i++) if (isDigitPos(w[i])) lastDigit = i;
  if (lastDigit < 0) return w;
  const body = w.slice(0, lastDigit + 1);
  let rest = w.slice(lastDigit + 1);
  let status = '';
  const sm = /^(CR|-)/.exec(rest);
  if (sm) { status = sm[1]; rest = rest.slice(status.length); }
  const slots = [...body].filter(isDigitPos).length;
  const digits = String(Math.round(Math.abs(n) * 10 ** dec)).padStart(slots, '0').slice(-slots);
  const zEnd = [...body].findIndex((c) => c === '0' || c === '*');
  const fill = zEnd >= 0 && body[zEnd] === '*' ? '*' : ' ';
  let out = '';
  let di = 0;
  let sig = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (isDigitPos(c)) {
      const d = digits[di++];
      if (d !== '0') sig = true;
      if (sig) out += d;
      else out += fill;
      if (zEnd >= 0 && i >= zEnd) sig = true; // la supresión de ceros incluye la posición del 0/*
    } else if (c === '&') out += ' ';
    else if (c === '$' && !sig && i === 0) out += '$';
    else out += sig ? c : fill;
  }
  out += neg ? status : ' '.repeat(status.length);
  out += rest.replace(/&/g, ' ');
  return out;
}

// Representación sin editar de un número (con zona de signo en el último dígito, como en impresora).
function zonedText(v, t) {
  const dig = t.digits || charLen(t) || 15;
  const dec = t.dec || 0;
  const n = toNumber(v);
  const s = String(Math.round(Math.abs(n) * 10 ** dec)).padStart(dig, '0').slice(-dig);
  if (n < 0) return s.slice(0, -1) + '}JKLMNOPQR'[Number(s.slice(-1))];
  return s;
}

// ---------- Utilidades de indicadores ----------
function condsOk(prog, conds) {
  for (const c of conds || []) {
    const v = prog.ind[c.ind] === '1';
    if (c.n ? v : !v) return false;
  }
  return true;
}
function groupsOk(prog, groups) {
  if (!groups || !groups.length) return true;
  return groups.some((g) => condsOk(prog, g));
}

// Nombre de campo de salida → expresión del IR
function fieldExpr(name) {
  const m = /^([A-Z#@$*][\w#@$]*)(?:\((.+)\))?$/i.exec(name);
  if (!m) return { k: 'id', name };
  const base = m[1].toUpperCase();
  if (base.startsWith('*IN')) return { k: 'sp', v: base };
  if (base === '*DATE' || base === '*DAY' || base === '*MONTH' || base === '*YEAR') return { k: 'sp', v: base };
  if (!m[2]) return { k: 'id', name: base };
  const ix = /^\d+$/.test(m[2]) ? { k: 'num', v: Number(m[2]) } : { k: 'id', name: m[2].toUpperCase() };
  return { k: 'call', name: base, args: [ix] };
}

async function fieldText(prog, f, sc) {
  const name = f.name;
  if (/^PAGE[1-7]?$/.test(name)) {
    const v = sc.lookup(name);
    if (v) v.value = toNumber(v.value) + 1;
  }
  const e = fieldExpr(name);
  let v, t;
  if (e.k === 'id' && /^U(DATE|DAY|MONTH|YEAR)$/.test(e.name) && !sc.lookup(e.name)) {
    v = await prog.ev(e, sc);
    t = { t: 'zoned', digits: e.name === 'UDATE' ? 6 : 2, dec: 0 };
  } else if (e.k === 'sp') {
    v = prog.special(e.v);
    t = /^\*IN/.test(e.v) ? { t: 'ind' } : { t: 'zoned', digits: e.v === '*DATE' ? 8 : e.v === '*YEAR' ? 4 : 2, dec: 0 };
  } else ({ v, t } = await prog.typed(e, sc));
  if (Array.isArray(v)) {
    // Array completo: los elementos uno tras otro
    let s = '';
    for (const x of v) s += await fieldText(prog, { ...f, name: '$EL' }, { lookup: () => ({ kind: 's', type: t, value: x }) });
    return s;
  }
  if (!t) t = typeof v === 'number' ? { t: 'zoned', digits: 15, dec: Number.isInteger(v) ? 0 : 2 } : { t: 'char', len: toStr(v).length };
  if (isNumType(t)) {
    const n = toNumber(v);
    if (f.editWord) return editWord(n, f.editWord, t.dec || 0);
    if (f.edit) {
      let s = editc(n, f.edit, t);
      if (f.constant === "'*'") s = s.replace(/^( +)/, (x) => '*'.repeat(x.length));
      else if (f.constant === "'$'" || f.constant === "'€'") s = s.replace(/ (?=\S)/, f.constant[1]);
      return s;
    }
    return zonedText(n, t);
  }
  if (t.t === 'date' || t.t === 'time' || t.t === 'timestamp') return toStr(v);
  if (t.t === 'ind') return truthy(v) ? '1' : '0';
  return toStr(v);
}

function blankAfter(prog, name, sc) {
  const e = fieldExpr(name);
  if (e.k !== 'id') return;
  const v = sc.lookup(e.name);
  if (v && v.kind === 's') v.value = v.dim ? v.value.map(() => blank(v.type)) : blank(v.type);
}

/** Construye el texto de una línea de salida a partir de sus campos. */
async function buildLine(prog, rec, sc) {
  let buf = '';
  let lastEnd = 0;
  const put = (text, endSpec) => {
    let end;
    const e = String(endSpec || '').trim();
    if (/^[+-]\d+$/.test(e)) end = lastEnd + Number(e) + text.length;
    else if (/^\d+$/.test(e)) end = Number(e);
    else end = lastEnd + text.length;
    const start = Math.max(0, end - text.length);
    if (buf.length < start) buf = buf.padEnd(start);
    buf = buf.slice(0, start) + text + buf.slice(start + text.length);
    lastEnd = end;
  };
  for (const f of rec.fields) {
    if (f.all) continue;
    if (!condsOk(prog, f.conds)) continue;
    if (f.constant !== null && f.constant !== undefined && !f.name) { put(f.constant, f.end); continue; }
    if (!f.name) continue;
    const text = await fieldText(prog, f, sc);
    put(text, f.end);
    if (f.blank) blankAfter(prog, f.name, sc);
  }
  return buf;
}

// ---------- Salida (O-specs) ----------
export async function outputRecords(prog, types, excptName) {
  const sc = prog.globals;
  for (const rec of prog.ir.ospecs || []) {
    if (!types.includes(rec.type)) continue;
    if (rec.type === 'E' && excptName !== undefined && (rec.excpt || '') !== (excptName || '')) continue;
    if (!groupsOk(prog, rec.condGroups)) continue;
    await writeRecord(prog, rec, sc);
  }
}

async function writeRecord(prog, rec, sc) {
  const ent = prog.files.get(rec.file) || prog.formats.get(rec.file);
  if (!ent) throw new RpgError('01211', 'RNX1211', `File or record format ${rec.file} is not defined.`);
  if (ent.def.device === 'PRINTER' && ent.pfmt) { await prog.writePrtf(ent, { file: rec.file }, sc); return; }
  if (ent.def.device === 'PRINTER') {
    const text = await buildLine(prog, rec, sc);
    prog.printerFor(ent).line(text, rec);
    return;
  }
  if (ent.def.device === 'DISK') {
    const info = prog.ir.filex[ent.def.name] || {};
    if (info.progDesc) {
      const text = await buildLine(prog, rec, sc);
      const row = bufferToRow(ent.desc, text);
      if (rec.add) await ent.h.write(row);
      else if (rec.del) await ent.h.delete();
      else await ent.h.update({ ...(ent.h.cur || {}), ...row });
      return;
    }
    const row = prog.moveOut(ent, null, sc);
    if (rec.add) await ent.h.write(row);
    else if (rec.del) await ent.h.delete();
    else {
      const named = rec.fields.some((f) => f.all) ? null : rec.fields.filter((f) => f.name && condsOk(prog, f.conds)).map((f) => f.name.replace(/^.*\./, ''));
      await ent.h.update(row, named && named.length ? named : null);
    }
    return;
  }
  if (ent.def.device === 'WORKSTN') {
    await prog.fileOp({ op: 'file', fop: 'WRITE', file: rec.file, ext: '', line: prog.line }, sc);
  }
}

// ---------- Registros descritos por programa ----------
// El "buffer" de un registro se arma con la representación en caracteres de cada columna del archivo físico.
export function rowToBuffer(desc, row) {
  const segs = [];
  let pos = 1;
  let text = '';
  for (const f of desc.fields) {
    const t = f.type;
    const len = storageLen(t);
    const v = row[f.name];
    let s;
    if (isNumType(t)) s = zonedText(v ?? 0, t).padStart(len, '0').slice(-len);
    else s = toStr(v ?? '').padEnd(len).slice(0, len);
    segs.push({ name: f.name, start: pos, end: pos + len - 1, type: t, value: v });
    text += s;
    pos += len;
  }
  return { text, segs };
}

function storageLen(t) {
  if (t.t === 'packed') return Math.floor((t.digits || 15) / 2) + 1;
  if (t.t === 'int' || t.t === 'uns') return (t.bits || 32) / 8;
  if (t.t === 'float') return 8;
  if (t.t === 'date') return 10;
  if (t.t === 'time') return 8;
  if (t.t === 'timestamp') return 26;
  return charLen(t);
}

function bufferToRow(desc, text) {
  const row = {};
  let pos = 0;
  for (const f of desc.fields) {
    const len = storageLen(f.type);
    const s = text.padEnd(pos + len).slice(pos, pos + len);
    row[f.name] = isNumType(f.type) ? zonedToNumber(s, f.type.dec || 0) : s.replace(/\s+$/, '');
    pos += len;
  }
  return row;
}

function zonedToNumber(s, dec) {
  let neg = false;
  let digits = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c >= '0' && c <= '9') digits += c;
    else if (c === '}') { digits += '0'; neg = true; }
    else if (c >= 'J' && c <= 'R') { digits += String(c.charCodeAt(0) - 73); neg = true; }
    else if (c >= 'A' && c <= 'I') digits += String(c.charCodeAt(0) - 64);
    else if (c === '{') digits += '0';
    else if (c === '-') neg = true;
    else if (c === ' ') digits += '0';
  }
  const n = Number(digits || 0) / 10 ** dec;
  return neg ? -n : n;
}

function extract(buf, from, to, fmt, dec) {
  const exact = buf.segs.find((sg) => sg.start === from && sg.end === to);
  const raw = buf.text.padEnd(to).slice(from - 1, to);
  if (exact && exact.value !== undefined && exact.value !== null) {
    if (dec === '' || dec === undefined) return isNumType(exact.type) ? zonedText(exact.value, exact.type) : toStr(exact.value);
    return toNumber(exact.value);
  }
  if (dec === '' || dec === undefined) return raw;
  return zonedToNumber(raw, Number(dec) || 0);
}

function idsMatch(buf, ids) {
  for (const id of ids || []) {
    const c = buf.text[id.pos - 1] || ' ';
    let ok;
    if (id.czd === 'Z') ok = zoneOf(c) === zoneOf(id.ch);
    else if (id.czd === 'D') ok = digitOf(c) === digitOf(id.ch);
    else ok = c === id.ch;
    if (id.not ? ok : !ok) return false;
  }
  return true;
}
const zoneOf = (c) => (/[0-9]/.test(c) ? 'F' : /[A-I]/.test(c) ? 'C' : /[J-R]/.test(c) ? 'D' : /[S-Z]/.test(c) ? 'E' : c);
const digitOf = (c) => (/[0-9]/.test(c) ? c : /[A-I]/.test(c) ? String(c.charCodeAt(0) - 64) : /[J-R]/.test(c) ? String(c.charCodeAt(0) - 73) : /[S-Z]/.test(c) ? String(c.charCodeAt(0) - 81) : c);

// ---------- Lectura en el ciclo ----------
class CycleFile {
  constructor(prog, ent, info, order) {
    this.prog = prog;
    this.ent = ent;
    this.info = info;
    this.order = order;
    this.next = undefined;
    this.eof = false;
    this.specs = (prog.ir.ispecs || []).filter((r) => r.file === ent.def.name || (ent.formats || []).includes(r.file) || (r.kind === 'extrec' && (ent.formats || []).includes(r.format)));
  }
  async fetch() {
    if (this.next !== undefined || this.eof) return;
    const r = await this.ent.h.read();
    if (!r) { this.eof = true; this.next = null; this.ent.eof = true; return; }
    const buf = this.info.progDesc ? rowToBuffer(this.ent.desc, r) : { text: '', segs: [] };
    let spec = null;
    let recInd = '';
    for (const s of this.specs) {
      if (s.kind === 'extrec') { spec = s; recInd = s.recInd; break; }
      if (idsMatch(buf, s.ids)) { spec = s; recInd = s.recInd; break; }
      const alt = (s.alts || []).find((a) => idsMatch(buf, a.ids));
      if (alt) { spec = s; recInd = alt.recInd; break; }
    }
    if (this.info.progDesc && this.specs.length && !spec) {
      throw new RpgError('01011', 'RNX1011', `Record-identification-code error in file ${this.ent.def.name}: record does not match any input specification.`);
    }
    this.next = { row: r, buf, spec, recInd };
  }
  valueOf(rec, f) {
    if (f.kind === 'extfld') return rec.row[f.ext];
    if (!f.from) return rec.row[f.name]; // campo de un archivo descrito externamente (sin posiciones)
    return extract(rec.buf, f.from, f.to, f.fmt, f.dec);
  }
  // Valores de los campos de control / coincidencia
  keys(rec, attr) {
    const out = {};
    const fields = rec.spec ? rec.spec.fields : [];
    for (const f of fields) {
      const k = f[attr];
      if (!k) continue;
      out[k] = (out[k] || '') + '\u0001' + String(this.valueOf(rec, f));
    }
    return out;
  }
}

async function moveFields(prog, cf, rec) {
  const sc = prog.globals;
  if (!cf.info.progDesc) prog.moveIn(cf.ent, rec.row, null, sc);
  if (!rec.spec) return;
  for (const f of rec.spec.fields) {
    const name = f.kind === 'extfld' ? (f.name || f.ext) : f.name;
    if (!name) continue;
    const raw = cf.valueOf(rec, f);
    if (f.kind === 'extfld') {
      if (f.name && f.name !== f.ext) {
        let v = sc.lookup(f.name);
        if (!v) { prog.ensureVar(sc, f.name, cf.ent.desc.fields.find((x) => x.name === f.ext)?.type || { t: 'char', len: 1 }); v = sc.lookup(f.name); }
        if (v.kind === 's') v.value = coerce(v.type, raw);
      }
    } else if (f.kind === 'field' && f.from) {
      const m = /^([A-Z#@$][\w#@$]*)(?:\((\d+)\))?$/.exec(name);
      const v = m && sc.lookup(m[1]);
      if (v && v.kind === 's') {
        if (m[2] && v.dim) v.value[Number(m[2]) - 1] = coerce(v.type, raw);
        else if (v.dim && !m[2]) {
          const el = charLen(v.type);
          const s = String(raw);
          v.value = v.value.map((x, i) => coerce(v.type, isNumType(v.type) ? zonedToNumber(s.slice(i * el, i * el + el), v.type.dec || 0) : s.slice(i * el, i * el + el)));
        } else v.value = coerce(v.type, raw);
      }
    }
    // Indicadores de campo: positivo / negativo / cero-o-blanco
    const [plus, minus, zero] = f.inds || [];
    if (plus || minus || zero) {
      const isNum = typeof raw === 'number';
      if (plus) prog.ind[plus] = isNum && raw > 0 ? '1' : '0';
      if (minus) prog.ind[minus] = isNum && raw < 0 ? '1' : '0';
      if (zero) prog.ind[zero] = (isNum ? raw === 0 : !String(raw).trim()) ? '1' : '0';
    }
  }
}

/** Ejecuta el programa con el ciclo RPG completo. Devuelve la señal de RETURN o null. */
export async function runCycle(prog, fr) {
  const ir = prog.ir;
  const files = [];
  for (const [name, info] of Object.entries(ir.filex || {})) {
    if (info.desig !== 'P' && info.desig !== 'S') continue;
    const ent = prog.files.get(name);
    if (ent) files.push(new CycleFile(prog, ent, info, info.desig === 'P' ? 0 : files.length + 1));
  }
  files.sort((a, b) => a.order - b.order);
  const usesMatch = (ir.ispecs || []).some((r) => r.fields.some((f) => f.match));
  const recInds = new Set((ir.ispecs || []).flatMap((r) => [r.recInd, ...(r.alts || []).map((a) => a.recInd)]).filter(Boolean));
  let prevLevels = null;
  let firstRecord = true;
  let lastPrimaryMatch = null;
  prog.ind['1P'] = '1';
  for (;;) {
    // 1. Salida de cabecera y detalle
    const ofOn = prog.overflowInds().filter((k) => prog.ind[k] === '1');
    await outputRecords(prog, ['H', 'D']);
    prog.ind['1P'] = '0';
    for (const k of ofOn) prog.ind[k] = '0';
    // 2. Indicadores de identificación y de nivel a off; lectura del siguiente registro
    for (const k of recInds) prog.ind[k] = '0';
    for (const k of LEVELS) prog.ind[k] = '0';
    let sel = null;
    let rec = null;
    if (prog.ind.LR !== '1') {
      if (files.length) {
        for (const f of files) await f.fetch();
        const live = files.filter((f) => f.next);
        const needed = files.filter((f) => f.info.eof);
        const done = needed.length ? needed.every((f) => f.eof) : live.length === 0;
        if (done || !live.length) {
          prog.ind.LR = '1';
          for (const k of LEVELS) prog.ind[k] = '1';
        } else {
          if (usesMatch) {
            const mk = (f) => Object.entries(f.keys(f.next, 'match')).sort().map((x) => x[1]).join('\u0002');
            sel = live[0];
            for (const f of live.slice(1)) if (mk(f) < mk(sel)) sel = f;
            const m = mk(sel);
            if (sel.order === 0) { prog.ind.MR = live.some((f) => f !== sel && mk(f) === m) ? '1' : '0'; lastPrimaryMatch = m; }
            else {
              const prim = files.find((f) => f.order === 0);
              prog.ind.MR = m === lastPrimaryMatch || (prim && prim.next && mk(prim) === m) ? '1' : '0';
            }
          } else sel = live[0];
          rec = sel.next;
          sel.next = undefined;
          if (rec.recInd) prog.ind[rec.recInd] = '1';
          // Niveles de control
          const lv = sel.keys(rec, 'level');
          const defined = Object.keys(lv);
          if (defined.length) {
            if (!prevLevels) for (const k of defined) for (const l of LEVELS.slice(0, Number(k.slice(1)))) prog.ind[l] = '1';
            else {
              let hi = 0;
              for (const k of defined) if (prevLevels[k] !== lv[k]) hi = Math.max(hi, Number(k.slice(1)));
              for (const l of LEVELS.slice(0, hi)) prog.ind[l] = '1';
            }
            prevLevels = { ...(prevLevels || {}), ...lv };
          }
        }
      } else if (!ir.main.length && !ir.totals.length) prog.ind.LR = '1';
    }
    // 3-4. Cálculos y salida de total (no en el primer registro)
    if (!firstRecord || prog.ind.LR === '1') {
      if (!(firstRecord && files.length && rec)) {
        const sig = await runTotals(prog, fr);
        if (sig) return sig;
        await outputRecords(prog, ['T']);
      }
    }
    // 5. Fin del programa con LR
    if (prog.ind.LR === '1') return null;
    // 6. Datos del registro a los campos del programa
    if (rec) { await moveFields(prog, sel, rec); firstRecord = false; }
    else if (!files.length) firstRecord = false;
    // 7. Cálculos de detalle
    const sig = await prog.execList(ir.main, prog.globals, fr);
    if (sig && sig.s === 'return') return sig;
    if (sig && sig.s === 'goto') throw new RpgError('00202', 'RNX9999', `TAG ${sig.label} not found for GOTO.`);
    await prog.tick(true);
    if (!files.length && prog.ind.LR !== '1' && !ir.main.length) prog.ind.LR = '1';
  }
}

async function runTotals(prog, fr) {
  for (const t of prog.ir.totals || []) {
    if (t.lvl !== 'L0' && prog.ind[t.lvl] !== '1') continue;
    const sig = await prog.execList(t.body, prog.globals, fr);
    if (sig && sig.s === 'return') return sig;
  }
  return null;
}

/** Carga de datos de tiempo de compilación en los arrays (CTDATA / PERRCD / ALT). */
export function loadCtdata(prog) {
  const ir = prog.ir;
  const decls = [];
  const walk = (list) => { for (const d of list) if (d.kind === 's' && d.ctdata) decls.push(d); };
  walk(ir.decls);
  const alts = new Map();
  for (const d of ir.decls) if (d.kind === 's' && d.alt) alts.set(d.alt, d.name);
  let unnamed = 0;
  for (const blk of ir.ctdata || []) {
    const d = blk.name ? decls.find((x) => x.name === blk.name) : decls.filter((x) => !(ir.ctdata || []).some((b) => b.name === x.name))[unnamed++];
    if (!d) continue;
    const main = prog.globals.lookup(d.name);
    const altVar = alts.has(d.name) ? prog.globals.lookup(alts.get(d.name)) : null;
    if (!main || !main.dim) continue;
    const per = d.perrcd || 1;
    const el = charLen(main.type);
    const el2 = altVar ? charLen(altVar.type) : 0;
    let i = 0;
    for (const line of blk.lines) {
      let pos = 0;
      for (let k = 0; k < per && i < main.dim; k++) {
        const a = line.padEnd(pos + el).slice(pos, pos + el);
        pos += el;
        main.value[i] = isNumType(main.type) ? coerce(main.type, zonedToNumber(a, main.type.dec || 0)) : coerce(main.type, a);
        if (altVar) {
          const b = line.padEnd(pos + el2).slice(pos, pos + el2);
          pos += el2;
          altVar.value[i] = isNumType(altVar.type) ? coerce(altVar.type, zonedToNumber(b, altVar.type.dec || 0)) : coerce(altVar.type, b);
        }
        i++;
      }
      if (i >= main.dim) break;
    }
  }
}

export { zonedToNumber, zonedText, isCharType };
