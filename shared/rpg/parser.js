// Parser de RPG IV (formato libre) -> IR JSON ejecutable por el intérprete (interpreter.js).
import { preprocess, tokenize, CompileError } from './lexer.js';

const TYPE_KW = new Set([
  'CHAR', 'VARCHAR', 'GRAPH', 'VARGRAPH', 'UCS2', 'VARUCS2', 'PACKED', 'ZONED', 'BINDEC', 'INT', 'UNS',
  'FLOAT', 'IND', 'DATE', 'TIME', 'TIMESTAMP', 'POINTER', 'LIKE', 'LIKEDS', 'LIKEREC', 'OBJECT',
]);
const FILE_OPS = new Set(['READ', 'READP', 'READE', 'READPE', 'CHAIN', 'SETLL', 'SETGT', 'WRITE', 'UPDATE',
  'DELETE', 'EXFMT', 'OPEN', 'CLOSE', 'UNLOCK', 'FEOD', 'READC']);
const BLOCK_END = new Set(['ENDIF', 'ENDDO', 'ENDFOR', 'ENDSL', 'ENDMON', 'ENDSR', 'END', 'ELSE', 'ELSEIF',
  'WHEN', 'OTHER', 'ON-ERROR', 'END-PROC']);
const OPCODES = new Set(['IF', 'ELSEIF', 'ELSE', 'ENDIF', 'DOW', 'DOU', 'ENDDO', 'FOR', 'ENDFOR', 'SELECT', 'WHEN',
  'OTHER', 'ENDSL', 'ITER', 'LEAVE', 'LEAVESR', 'RETURN', 'BEGSR', 'ENDSR', 'EXSR', 'MONITOR', 'ON-ERROR', 'ENDMON',
  'DSPLY', 'CLEAR', 'RESET', 'EVAL', 'EVALR', 'EVAL-CORR', 'CALLP', 'SORTA', 'CALL$', 'MOVE$', 'MOVEL$',
  '$UNSUPPORTED', 'END', 'DEALLOC', 'EXCEPT', 'COMMIT', 'ROLBK', 'GOTO$', 'TAG$', 'MOVE$P', 'MOVEL$P', 'MOVEA$', 'MOVEA$P',
  'IN$', 'OUT$', '$DTAARA$', '$TEST$', '$BITON$', '$BITOFF$', ...FILE_OPS]);
const DIRECTIVES = new Set(['$FILEX', '$ISPEC', '$OSPEC', '$CTDATA', '$TOTAL', '$ENDTOTAL']);
const unb64 = (x) => JSON.parse(Buffer.from(String(x), 'base64').toString('utf8'));

export function compileRpg(srcLines, { name = 'PGM', includeResolver, dialect } = {}) {
  const pre = preprocess(srcLines, includeResolver, { dialect: dialect || detectDialect(srcLines) });
  const toks = tokenize(pre);
  const p = new Parser(toks);
  const ir = p.parseProgram(name);
  return ir;
}

export { CompileError };

// RPG III / RPG/400 / RPG II: el código de operación está en 28-32 (en RPG IV, 26-35); además hay E/L-specs.
export function detectDialect(lines) {
  const ls = (lines || []).map((l) => String(l && typeof l === 'object' ? l.text : l ?? ''));
  if (String(ls[0] || '').trim().toUpperCase().startsWith('**FREE')) return 'RPG4';
  let r3 = 0, r4 = 0;
  for (const l of ls) {
    if (/^\*\*/.test(l)) break;
    const spec = (l[5] || '').toUpperCase();
    if (l[6] === '*' || l[6] === '/') continue;
    if (spec === 'E' || spec === 'L') r3 += 3;
    if (spec === 'D' || spec === 'P') r4 += 3;
    if (spec === 'C') {
      const op3 = l.slice(27, 32).trim().toUpperCase();
      const op4 = l.slice(25, 35).trim().toUpperCase();
      if (/^[A-Z][A-Z0-9-]*(\([A-Z ]*\))?$/.test(op4) && l.slice(25, 27).trim()) r4++;
      else if (/^[A-Z][A-Z0-9-]*$/.test(op3) && !l.slice(25, 27).trim()) r3++;
    }
    if (spec === 'F' && /^[A-Z]/i.test(l.slice(39, 46).trim()) && !l.slice(35, 39).trim()) r3++;
  }
  return r3 > r4 ? 'RPG3' : 'RPG4';
}

class Parser {
  constructor(toks) {
    this.t = toks;
    this.i = 0;
  }
  get cur() { return this.t[this.i]; }
  peek(n = 1) { return this.t[this.i + n] || this.t[this.t.length - 1]; }
  next() { return this.t[this.i++]; }
  is(type, value) {
    const c = this.cur;
    return c.type === type && (value === undefined || c.value === value);
  }
  isOp(v) { return this.is('op', v); }
  isId(v) { return this.is('id', v); }
  accept(type, value) {
    if (this.is(type, value)) return this.next();
    return null;
  }
  expect(type, value, msg) {
    if (this.is(type, value)) return this.next();
    const c = this.cur;
    throw new CompileError('RNF0637', msg || `Expected ${value || type} but found '${c.value || c.type}'.`, c.line);
  }
  semi() {
    if (this.isOp(';')) { this.next(); return; }
    const c = this.cur;
    throw new CompileError('RNF0636', `Semicolon expected; found '${c.value || 'end of source'}'.`, c.line);
  }
  skipToSemi() { while (!this.is('eof') && !this.isOp(';')) this.next(); this.accept('op', ';'); }

  parseProgram(name) {
    const ir = { version: 1, name, ctl: {}, files: [], decls: [], main: [], subrs: {}, procs: {}, protos: {}, pi: null,
      filex: {}, ispecs: [], ospecs: [], ctdata: [], totals: [] };
    this.ctx = ir;
    while (!this.is('eof')) {
      const c = this.cur;
      if (c.type === 'id' && DIRECTIVES.has(c.value)) {
        const line = c.line;
        this.next();
        if (c.value === '$TOTAL') {
          const lvl = this.next().value;
          this.semi();
          const body = this.parseStmtList(new Set(['$ENDTOTAL'])).stmts;
          if (this.isId('$ENDTOTAL')) { this.next(); this.semi(); }
          ir.totals.push({ lvl, body, line });
          continue;
        }
        if (c.value === '$ENDTOTAL') { this.semi(); continue; }
        const v = unb64(this.next().value);
        this.semi();
        if (c.value === '$FILEX') ir.filex[v.file] = v;
        else if (c.value === '$ISPEC') ir.ispecs.push(v);
        else if (c.value === '$OSPEC') ir.ospecs.push(...v);
        else if (c.value === '$CTDATA') ir.ctdata.push(v);
        continue;
      }
      if (c.type === 'id') {
        if (c.value === 'CTL-OPT') { this.next(); Object.assign(ir.ctl, kwObject(this.keywords())); this.semi(); continue; }
        if (c.value === 'DCL-PROC') { const pr = this.parseProc(); ir.procs[pr.name] = pr; continue; }
        if (c.value === 'BEGSR') { const sr = this.parseSubr(); ir.subrs[sr.name] = sr.body; continue; }
        if (c.value === 'DCL-PI') { ir.pi = this.parsePI(); continue; }
        const d = this.tryDecl(ir);
        if (d) continue;
      }
      ir.main.push(...this.parseStmtList(new Set(), true).stmts);
      if (!this.is('eof') && this.cur.type === 'id' && BLOCK_END.has(this.cur.value)) {
        throw new CompileError('RNF5032', `${this.cur.value} operation is not expected here (no matching block).`, this.cur.line);
      }
    }
    return ir;
  }

  // Declaraciones que pueden aparecer a nivel global o en procedimientos.
  tryDecl(scope) {
    const c = this.cur;
    switch (c.value) {
      case 'DCL-S': this.next(); scope.decls.push(this.parseDclS()); return true;
      case 'DCL-C': this.next(); scope.decls.push(this.parseDclC()); return true;
      case 'DCL-DS': this.next(); scope.decls.push(this.parseDclDS()); return true;
      case 'DCL-F': this.next(); (scope.files || this.ctx.files).push(this.parseDclF()); return true;
      case 'DCL-PR': this.next(); { const pr = this.parsePR(); this.ctx.protos[pr.name] = pr; } return true;
      default: return false;
    }
  }

  name() {
    const c = this.cur;
    if (c.type === 'id') { this.next(); return c.value; }
    if (c.type === 'special' && c.value === '*N') { this.next(); return '*N'; }
    throw new CompileError('RNF3305', `A name is expected; found '${c.value}'.`, c.line);
  }

  // Lista de palabras clave: KW o KW(arg:arg) hasta ';'
  keywords(stopWords = []) {
    const out = [];
    while (!this.isOp(';') && !this.is('eof')) {
      const c = this.cur;
      if (c.type === 'id' && stopWords.includes(c.value)) break;
      if (c.type !== 'id' && c.type !== 'special') {
        throw new CompileError('RNF3308', `Keyword expected; found '${c.value}'.`, c.line);
      }
      this.next();
      const kw = { kw: c.value, args: [], line: c.line };
      if (this.isOp('(')) {
        this.next();
        if (!this.isOp(')')) {
          kw.args.push(this.expr());
          while (this.accept('op', ':')) kw.args.push(this.expr());
        }
        this.expect('op', ')');
      }
      out.push(kw);
    }
    return out;
  }

  typeFrom(kws, line) {
    const k = kws.find((x) => TYPE_KW.has(x.kw));
    if (!k) return null;
    const n = (i, d) => (k.args[i] ? constNum(k.args[i], line) : d);
    switch (k.kw) {
      case 'CHAR': case 'GRAPH': case 'UCS2': return { t: 'char', len: n(0, 1) };
      case 'VARCHAR': case 'VARGRAPH': case 'VARUCS2': return { t: 'varchar', len: n(0, 1) };
      case 'PACKED': return { t: 'packed', digits: n(0, 15), dec: n(1, 0) };
      case 'ZONED': return { t: 'zoned', digits: n(0, 15), dec: n(1, 0) };
      case 'BINDEC': return { t: 'packed', digits: n(0, 9), dec: n(1, 0) };
      case 'INT': return { t: 'int', bits: bitsOf(n(0, 10)) };
      case 'UNS': return { t: 'uns', bits: bitsOf(n(0, 10)) };
      case 'FLOAT': return { t: 'float' };
      case 'IND': return { t: 'ind' };
      case 'DATE': return { t: 'date' };
      case 'TIME': return { t: 'time' };
      case 'TIMESTAMP': return { t: 'timestamp' };
      case 'POINTER': case 'OBJECT': return { t: 'pointer' };
      case 'LIKE': return { t: 'like', name: refName(k.args[0], line), adj: k.args[1] ? constNum(k.args[1], line) : 0 };
      case 'LIKEDS': return { t: 'likeds', name: refName(k.args[0], line) };
      case 'LIKEREC': return { t: 'likerec', name: refName(k.args[0], line) };
      default: return null;
    }
  }

  commonAttrs(kws, line) {
    const o = {};
    for (const k of kws) {
      switch (k.kw) {
        case 'INZ': o.inz = k.args.length ? k.args[0] : { k: 'sp', v: '*INZDFT' }; break;
        case 'DIM': o.dim = constNum(k.args[0], line); break;
        case 'CONST': o.const = true; break;
        case 'VALUE': o.value = true; break;
        case 'OPTIONS': o.options = k.args.map((a) => a.v); break;
        case 'QUALIFIED': o.qualified = true; break;
        case 'TEMPLATE': o.template = true; break;
        case 'VARYING': o.varying = true; break;
        case 'STATIC': o.static = true; break;
        case 'CTDATA': o.ctdata = true; break;
        case 'PERRCD': o.perrcd = constNum(k.args[0], line); break;
        case 'ALT': o.alt = refName(k.args[0], line); break;
        case 'ASCEND': o.seq = 'A'; break;
        case 'DESCEND': o.seq = 'D'; break;
        case 'FROMFILE': o.fromfile = refName(k.args[0], line); break;
        case 'TOFILE': o.tofile = refName(k.args[0], line); break;
        case 'POS': o.pos = constNum(k.args[0], line); break;
        case 'OVERLAY': o.overlay = { name: refName(k.args[0], line), pos: k.args[1] ? (k.args[1].k === 'sp' ? k.args[1].v : constNum(k.args[1], line)) : 1 }; break;
        case 'OCCURS': o.occurs = constNum(k.args[0], line); break;
        default: break;
      }
    }
    return o;
  }

  parseDclS() {
    const line = this.cur.line;
    const name = this.name();
    const kws = this.keywords();
    this.semi();
    const type = this.typeFrom(kws, line);
    if (!type) throw new CompileError('RNF3303', `The data type for ${name} is not specified.`, line);
    const a = this.commonAttrs(kws, line);
    if (a.varying && type.t === 'char') type.t = 'varchar';
    if (type.t === 'likeds' || type.t === 'likerec') {
      return { kind: 'ds', name, likeds: type.name, likerec: type.t === 'likerec', qualified: true, dim: a.dim, fields: [], line };
    }
    return { kind: 's', name, type, dim: a.dim, inz: a.inz, line, ctdata: a.ctdata, perrcd: a.perrcd, alt: a.alt, seq: a.seq, fromfile: a.fromfile };
  }

  parseDclC() {
    const line = this.cur.line;
    const name = this.name();
    let value;
    if (this.isId('CONST')) {
      this.next(); this.expect('op', '('); value = this.expr(); this.expect('op', ')');
    } else value = this.expr();
    this.semi();
    return { kind: 'c', name, value, line };
  }

  parseDclDS() {
    const line = this.cur.line;
    const name = this.name();
    const kws = this.keywords(['END-DS']);
    const ds = { kind: 'ds', name, fields: [], line, ...this.commonAttrs(kws, line) };
    for (const k of kws) {
      if (k.kw === 'LIKEDS' || k.kw === 'LIKEREC') { ds.likeds = refName(k.args[0], line); ds.likerec = k.kw === 'LIKEREC'; ds.qualified = true; }
      if (k.kw === 'EXTNAME') { ds.extname = refName(k.args[0], line); ds.extfmt = k.args[1] ? refName(k.args[1], line) : null; }
      if (k.kw === 'LEN') ds.len = constNum(k.args[0], line);
    }
    if (this.isId('END-DS')) { this.next(); if (this.is('id')) this.next(); this.semi(); return ds; }
    this.semi();
    if (ds.likeds) return ds;
    while (!this.isId('END-DS')) {
      if (this.is('eof')) throw new CompileError('RNF3310', `END-DS missing for data structure ${name}.`, line);
      if (this.isId('DCL-SUBF')) this.next();
      const fl = this.cur.line;
      const fname = this.name();
      const fk = this.keywords();
      this.semi();
      const ft = this.typeFrom(fk, fl);
      const fa = this.commonAttrs(fk, fl);
      if (ft && (ft.t === 'likeds' || ft.t === 'likerec')) {
        ds.fields.push({ name: fname, likeds: ft.name, dim: fa.dim, line: fl });
      } else {
        if (!ft) throw new CompileError('RNF3303', `The data type for subfield ${fname} is not specified.`, fl);
        if (fa.varying && ft.t === 'char') ft.t = 'varchar';
        ds.fields.push({ name: fname, type: ft, inz: fa.inz, dim: fa.dim, line: fl, pos: fa.pos, overlay: fa.overlay, ctdata: fa.ctdata, perrcd: fa.perrcd });
      }
    }
    this.next();
    if (this.is('id')) this.next();
    this.semi();
    return ds;
  }

  parseDclF() {
    const line = this.cur.line;
    const name = this.name();
    const kws = this.keywords();
    this.semi();
    const f = { name, device: 'DISK', usage: null, keyed: false, line, rename: {}, sfile: {}, prefix: null };
    for (const k of kws) {
      switch (k.kw) {
        case 'DISK': case 'SEQ': case 'SPECIAL': f.device = 'DISK'; break;
        case 'WORKSTN': f.device = 'WORKSTN'; break;
        case 'PRINTER':
          f.device = 'PRINTER';
          f.prtlen = k.args[0] && k.args[0].k === 'num' ? k.args[0].v : 132;
          // PRINTER sin longitud (o *EXT) es un archivo de impresora descrito externamente
          f.prtExt = !k.args.length || (k.args[0].k === 'sp' && k.args[0].v === '*EXT');
          break;
        case 'USAGE': f.usage = k.args.map((a) => a.v); break;
        case 'KEYED': f.keyed = true; break;
        case 'EXTFILE': case 'EXTDESC': f.extfile = refName(k.args[0], line); break;
        case 'RENAME': f.rename[refName(k.args[0], line)] = refName(k.args[1], line); break;
        case 'SFILE': f.sfile[refName(k.args[0], line)] = refName(k.args[1], line); break;
        case 'PREFIX': f.prefix = refName(k.args[0], line); break;
        case 'INDDS': f.indds = refName(k.args[0], line); break;
        case 'OFLIND': f.oflind = k.args[0] ? String(k.args[0].v || k.args[0].name || '').replace(/^\*IN/, '') : 'OF'; break;
        case 'FORMLEN': f.formlen = constNum(k.args[0], line); break;
        case 'FORMOFL': f.formofl = constNum(k.args[0], line); break;
        case 'COMMIT': f.commit = true; break;
        default: break;
      }
    }
    if (!f.usage) f.usage = f.device === 'DISK' ? ['*INPUT'] : f.device === 'PRINTER' ? ['*OUTPUT'] : ['*INPUT', '*OUTPUT'];
    if (f.usage.includes('*UPDATE') && !f.usage.includes('*INPUT')) f.usage.push('*INPUT');
    return f;
  }

  parseParams(endKw) {
    const params = [];
    while (!this.isId(endKw)) {
      if (this.is('eof')) throw new CompileError('RNF3310', `${endKw} missing.`, this.cur.line);
      if (this.isId('DCL-PARM')) this.next();
      const line = this.cur.line;
      const name = this.name();
      const kws = this.keywords();
      this.semi();
      const type = this.typeFrom(kws, line);
      if (!type) throw new CompileError('RNF3303', `The data type for parameter ${name} is not specified.`, line);
      const a = this.commonAttrs(kws, line);
      if (a.varying && type.t === 'char') type.t = 'varchar';
      params.push({ name, type, dim: a.dim, value: !!a.value, const: !!a.const, options: a.options || [], line });
    }
    this.next();
    if (this.is('id') || this.is('special')) this.next();
    this.semi();
    return params;
  }

  parsePR() {
    const line = this.cur.line;
    const name = this.name();
    const kws = this.keywords(['END-PR']);
    const pr = { name, params: [], returns: this.typeFrom(kws, line), line };
    for (const k of kws) {
      if (k.kw === 'EXTPGM') pr.extpgm = k.args.length ? refName(k.args[0], line) : name;
      if (k.kw === 'EXTPROC') pr.extproc = k.args.length ? refName(k.args[0], line) : name;
    }
    if (this.isId('END-PR')) { this.next(); this.semi(); return pr; }
    this.semi();
    pr.params = this.parseParams('END-PR');
    return pr;
  }

  parsePI() {
    this.next();
    const line = this.cur.line;
    const name = this.name();
    const kws = this.keywords(['END-PI']);
    const pi = { name, params: [], returns: this.typeFrom(kws, line), line };
    if (this.isId('END-PI')) { this.next(); this.semi(); return pi; }
    this.semi();
    pi.params = this.parseParams('END-PI');
    return pi;
  }

  parseProc() {
    this.next();
    const line = this.cur.line;
    const name = this.name();
    const kws = this.keywords();
    this.semi();
    const proc = { name, export: kws.some((k) => k.kw === 'EXPORT'), params: [], returns: null, decls: [], body: [], subrs: {}, line };
    while (!this.isId('END-PROC')) {
      if (this.is('eof')) throw new CompileError('RNF3310', `END-PROC missing for procedure ${name}.`, line);
      if (this.isId('DCL-PI')) { const pi = this.parsePI(); proc.params = pi.params; proc.returns = pi.returns; continue; }
      if (this.isId('BEGSR')) { const sr = this.parseSubr(); proc.subrs[sr.name] = sr.body; continue; }
      if (this.is('id') && this.tryDecl(proc)) continue;
      const before = this.i;
      proc.body.push(...this.parseStmtList(new Set(['END-PROC']), true).stmts);
      if (this.i === before && !this.isId('END-PROC')) {
        throw new CompileError('RNF5032', `${this.cur.value} operation is not expected here (no matching block).`, this.cur.line);
      }
    }
    this.next();
    if (this.is('id')) this.next();
    this.semi();
    return proc;
  }

  parseSubr() {
    this.next();
    const line = this.cur.line;
    const nm = this.is('special') ? this.next().value : this.name();
    this.semi();
    const r = this.parseStmtList(new Set(['ENDSR']));
    this.expect('id', 'ENDSR');
    if (!this.isOp(';')) this.next();
    this.semi();
    return { name: nm, body: r.stmts, line };
  }

  // Lee sentencias hasta encontrar una de las palabras de cierre (que no se consume).
  parseStmtList(enders, topLevel = false) {
    const stmts = [];
    for (;;) {
      const c = this.cur;
      if (c.type === 'eof') break;
      if (c.type === 'id' && (enders.has(c.value) || BLOCK_END.has(c.value))) break;
      if (topLevel && c.type === 'id' && (['DCL-S', 'DCL-C', 'DCL-DS', 'DCL-F', 'DCL-PR', 'DCL-PI', 'DCL-PROC', 'BEGSR', 'CTL-OPT'].includes(c.value) || DIRECTIVES.has(c.value))) break;
      if (c.type === 'id' && c.value === '$ENDTOTAL') break;
      stmts.push(this.parseStmt());
    }
    return { stmts };
  }

  extender() {
    if (this.isOp('(') && this.peek().type === 'id' && /^[EHNRTMD]+$/.test(this.peek().value) && this.peek(2).value === ')') {
      this.next();
      const e = this.next().value;
      this.next();
      return e;
    }
    return '';
  }

  closeBlock(...names) {
    const c = this.cur;
    if (c.type === 'id' && (names.includes(c.value) || c.value === 'END')) {
      this.next();
      this.semi();
      return;
    }
    throw new CompileError('RNF5011', `${names[0]} expected; found '${c.value || 'end of source'}'.`, c.line);
  }

  parseStmt() {
    const c = this.cur;
    const line = c.line;
    if (c.type === 'op' && c.value === ';') { this.next(); return { op: 'nop', line }; }
    if (c.type === 'sql') { this.next(); this.semi(); return { op: 'sql', text: c.value, line }; }
    const isOpcode = c.type === 'id' && OPCODES.has(c.value) &&
      !(this.peek().type === 'op' && ['=', '+=', '-=', '*=', '/=', '**=', '.'].includes(this.peek().value));
    if (!isOpcode) {
      // Asignación o llamada a procedimiento.
      const target = this.postfix();
      if (this.is('op') && ['=', '+=', '-=', '*=', '/=', '**='].includes(this.cur.value)) {
        const mode = this.next().value;
        const e = this.expr();
        this.semi();
        return { op: 'assign', target, expr: e, mode, line };
      }
      if (target.k === 'call' || target.k === 'id') { this.semi(); return { op: 'callp', call: target, line }; }
      throw new CompileError('RNF5347', 'An assignment operator is expected with the EVAL operation.', line);
    }
    const op = this.next().value;
    const ext = this.extender();
    switch (op) {
      case 'EVAL': case 'EVALR': case 'EVAL-CORR': {
        const target = this.postfix();
        const mode = this.next().value;
        if (!['=', '+=', '-=', '*=', '/=', '**='].includes(mode)) throw new CompileError('RNF5347', 'An assignment operator is expected with the EVAL operation.', line);
        const e = this.expr();
        this.semi();
        return { op: 'assign', target, expr: e, mode, h: ext.includes('H'), r: op === 'EVALR', corr: op === 'EVAL-CORR', line };
      }
      case 'CALLP': { const call = this.postfix(); this.semi(); return { op: 'callp', call, line, e: ext.includes('E') }; }
      case 'IF': {
        const branches = [];
        let cond = this.expr(); this.semi();
        let body = this.parseStmtList(new Set(['ELSEIF', 'ELSE', 'ENDIF'])).stmts;
        branches.push({ cond, body });
        let elseBody = null;
        for (;;) {
          if (this.isId('ELSEIF')) {
            this.next(); cond = this.expr(); this.semi();
            body = this.parseStmtList(new Set(['ELSEIF', 'ELSE', 'ENDIF'])).stmts;
            branches.push({ cond, body });
            continue;
          }
          if (this.isId('ELSE')) {
            this.next(); this.semi();
            // "ELSE; IF" anidado típico de columnas fijas se respeta tal cual.
            elseBody = this.parseStmtList(new Set(['ENDIF'])).stmts;
          }
          break;
        }
        this.closeBlock('ENDIF');
        return { op: 'if', branches, else: elseBody, line };
      }
      case 'DOW': case 'DOU': {
        const cond = this.expr(); this.semi();
        const body = this.parseStmtList(new Set(['ENDDO'])).stmts;
        this.closeBlock('ENDDO');
        return { op: op.toLowerCase(), cond, body, line };
      }
      case 'FOR': {
        const v = this.postfix();
        let from = { k: 'num', v: 1 };
        if (this.accept('op', '=')) from = this.expr();
        let to = null, by = { k: 'num', v: 1 }, down = false;
        for (;;) {
          if (this.isId('TO')) { this.next(); to = this.expr(); continue; }
          if (this.isId('DOWNTO')) { this.next(); to = this.expr(); down = true; continue; }
          if (this.isId('BY')) { this.next(); by = this.expr(); continue; }
          break;
        }
        this.semi();
        const body = this.parseStmtList(new Set(['ENDFOR'])).stmts;
        this.closeBlock('ENDFOR');
        return { op: 'for', v, from, to, by, down, body, line };
      }
      case 'SELECT': {
        this.semi();
        const whens = [];
        let other = null;
        while (this.isId('WHEN')) {
          this.next();
          const cond = this.expr(); this.semi();
          whens.push({ cond, body: this.parseStmtList(new Set(['WHEN', 'OTHER', 'ENDSL'])).stmts });
        }
        if (this.isId('OTHER')) { this.next(); this.semi(); other = this.parseStmtList(new Set(['ENDSL'])).stmts; }
        this.closeBlock('ENDSL');
        return { op: 'select', whens, other, line };
      }
      case 'MONITOR': {
        this.semi();
        const body = this.parseStmtList(new Set(['ON-ERROR', 'ENDMON'])).stmts;
        const handlers = [];
        while (this.isId('ON-ERROR')) {
          this.next();
          const codes = [];
          while (!this.isOp(';')) {
            const t = this.next();
            if (t.type === 'num') codes.push(t.value);
            else if (t.type === 'special') codes.push(t.value);
            else if (t.type === 'id') codes.push(t.value);
          }
          this.semi();
          handlers.push({ codes, body: this.parseStmtList(new Set(['ON-ERROR', 'ENDMON'])).stmts });
        }
        this.closeBlock('ENDMON');
        return { op: 'monitor', body, handlers, line };
      }
      case 'ITER': case 'LEAVE': case 'LEAVESR': this.semi(); return { op: op.toLowerCase(), line };
      case 'RETURN': {
        const e = this.isOp(';') ? null : this.expr();
        this.semi();
        return { op: 'return', expr: e, line };
      }
      case 'EXSR': { const n = this.is('special') ? this.next().value : this.name(); this.semi(); return { op: 'exsr', name: n, line }; }
      case 'COMMIT': case 'ROLBK': {
        if (!this.isOp(';')) this.expr(); // identificador de límite (COMMIT 'texto'): se ignora
        this.semi();
        return { op: op === 'COMMIT' ? 'commit' : 'rolbk', line, ext };
      }
      case 'DSPLY': {
        let msg = null, msgq = null, resp = null;
        if (!this.isOp(';')) msg = this.expr();
        if (!this.isOp(';')) msgq = this.expr();
        if (!this.isOp(';')) resp = this.postfix();
        this.semi();
        return { op: 'dsply', msg, msgq, resp, line };
      }
      case 'CLEAR': case 'RESET': {
        if (this.is('special') && ['*NOKEY', '*ALL'].includes(this.cur.value)) this.next();
        const target = this.postfix(); this.semi();
        return { op: op.toLowerCase(), target, line };
      }
      case 'SORTA': { const target = this.postfix(); this.semi(); return { op: 'sorta', target, line, desc: ext.includes('D') }; }
      case 'CALL$': {
        const pgm = this.expr();
        const parms = [];
        while (!this.isOp(';')) parms.push(this.postfix());
        this.semi();
        return { op: 'callpgm', pgm, parms, line };
      }
      case 'MOVE$': case 'MOVEL$': case 'MOVE$P': case 'MOVEL$P': case 'MOVEA$': case 'MOVEA$P': {
        const src = this.expr(); this.accept('op', ':'); const target = this.postfix(); this.semi();
        if (op.startsWith('MOVEA')) return { op: 'movea', src, target, pad: op.endsWith('P'), line };
        return { op: 'move', left: op.startsWith('MOVEL'), pad: op.endsWith('P'), src, target, line };
      }
      case 'GOTO$': case 'TAG$': { const label = this.next().value; this.semi(); return { op: op === 'GOTO$' ? 'goto' : 'tag', label: String(label).toUpperCase(), line }; }
      case 'IN$': case 'OUT$': {
        const lock = this.is('special') && this.cur.value === '*LOCK' ? (this.next(), true) : false;
        const target = this.is('special') ? this.next().value : this.name();
        this.semi();
        return { op: op === 'IN$' ? 'dtain' : 'dtaout', target, lock, line };
      }
      case '$DTAARA$': { const name = this.name(); const ext = this.next().value; this.semi(); return { op: 'dtadef', name, ext, line }; }
      case '$TEST$': {
        const ext2 = this.expr(); this.accept('op', ':'); const fmt = this.expr(); this.accept('op', ':'); const target = this.postfix(); this.semi();
        return { op: 'test', ext: ext2.v || '', fmt, target, line };
      }
      case '$BITON$': case '$BITOFF$': {
        const bits = this.expr(); this.accept('op', ':'); const target = this.postfix(); this.semi();
        return { op: 'bit', on: op === '$BITON$', bits: bits.v, target, line };
      }
      case 'EXCEPT': { const name = this.is('id') ? this.next().value : ''; this.semi(); return { op: 'except', name, line }; }
      case '$UNSUPPORTED': {
        const t = this.next(); this.semi();
        throw new CompileError('RNF5113', `Operation code ${t.value} is not supported by this compiler.`, line);
      }
      case 'DEALLOC': this.skipToSemi(); return { op: 'nop', line };
      default: break;
    }
    if (FILE_OPS.has(op)) return this.parseFileOp(op, ext, line);
    throw new CompileError('RNF5011', `Operation ${op} is not valid here.`, line);
  }

  parseFileOp(op, ext, line) {
    const st = { op: 'file', fop: op, ext, line, key: null, file: null, ds: null };
    const items = [];
    while (!this.isOp(';') && !this.is('eof')) {
      if (this.isOp('(')) {
        // Lista de claves (k1 : k2)
        this.next();
        const list = [this.expr()];
        while (this.accept('op', ':')) list.push(this.expr());
        this.expect('op', ')');
        items.push({ k: 'list', items: list });
        continue;
      }
      items.push(this.postfix());
    }
    this.semi();
    const keyed = ['CHAIN', 'SETLL', 'SETGT', 'READE', 'READPE'].includes(op);
    const nameOf = (e) => {
      if (!e || (e.k !== 'id' && e.k !== 'sp')) throw new CompileError('RNF5126', `File or record format name expected for ${op}.`, line);
      return e.k === 'id' ? e.name : e.v;
    };
    if (keyed) {
      st.key = items[0];
      st.file = nameOf(items[1]);
      st.ds = items[2] ? nameOf(items[2]) : null;
    } else if (op === 'DELETE') {
      if (items.length >= 2) { st.key = items[0]; st.file = nameOf(items[1]); } else st.file = nameOf(items[0]);
    } else {
      st.file = nameOf(items[0]);
      if (items[1]) {
        if (items[1].k === 'bif' && items[1].name === '%FIELDS') st.fields = items[1].args.map((a) => a.name);
        else st.ds = nameOf(items[1]);
      }
    }
    return st;
  }

  // ---------- Expresiones ----------
  expr() { return this.orExpr(); }
  orExpr() {
    let l = this.andExpr();
    while (this.isId('OR')) { this.next(); l = { k: 'bin', op: 'OR', l, r: this.andExpr() }; }
    return l;
  }
  andExpr() {
    let l = this.notExpr();
    while (this.isId('AND')) { this.next(); l = { k: 'bin', op: 'AND', l, r: this.notExpr() }; }
    return l;
  }
  notExpr() {
    if (this.isId('NOT')) { this.next(); return { k: 'un', op: 'NOT', e: this.notExpr() }; }
    return this.cmpExpr();
  }
  cmpExpr() {
    const l = this.addExpr();
    if (this.is('op') && ['=', '<>', '<', '>', '<=', '>='].includes(this.cur.value)) {
      const op = this.next().value;
      return { k: 'bin', op, l, r: this.addExpr() };
    }
    return l;
  }
  addExpr() {
    let l = this.mulExpr();
    while (this.is('op') && (this.cur.value === '+' || this.cur.value === '-')) {
      const op = this.next().value;
      l = { k: 'bin', op, l, r: this.mulExpr() };
    }
    return l;
  }
  mulExpr() {
    let l = this.unary();
    while (this.is('op') && (this.cur.value === '*' || this.cur.value === '/')) {
      const op = this.next().value;
      l = { k: 'bin', op, l, r: this.unary() };
    }
    return l;
  }
  unary() {
    if (this.is('op') && (this.cur.value === '-' || this.cur.value === '+')) {
      const op = this.next().value;
      const e = this.unary();
      if (op === '-' && e.k === 'num') return { k: 'num', v: -e.v, raw: '-' + e.raw };
      return op === '-' ? { k: 'un', op: '-', e } : e;
    }
    return this.pow();
  }
  pow() {
    const l = this.postfix();
    if (this.isOp('**')) { this.next(); return { k: 'bin', op: '**', l, r: this.unary() }; }
    return l;
  }
  args() {
    const args = [];
    this.expect('op', '(');
    if (!this.isOp(')')) {
      args.push(this.argExpr());
      while (this.accept('op', ':')) args.push(this.argExpr());
    }
    this.expect('op', ')');
    return args;
  }
  argExpr() {
    if (this.is('special') && this.cur.value === '*OMIT') { this.next(); return { k: 'sp', v: '*OMIT' }; }
    return this.expr();
  }
  postfix() {
    let e = this.primary();
    for (;;) {
      if (this.isOp('(') && (e.k === 'id' || e.k === 'call' || e.k === 'dot' || (e.k === 'sp' && e.v === '*IN'))) {
        const args = this.args();
        if (e.k === 'sp') e = { k: 'inidx', idx: args[0] };
        else if (e.k === 'id') e = { k: 'call', name: e.name, args };
        else e = { k: 'idx', base: e, args };
        continue;
      }
      if (this.isOp('.') && this.peek().type === 'id') {
        this.next();
        e = { k: 'dot', base: e, field: this.next().value };
        continue;
      }
      break;
    }
    return e;
  }
  primary() {
    const c = this.cur;
    switch (c.type) {
      case 'num': this.next(); return { k: 'num', v: c.value, raw: c.raw };
      case 'str': this.next(); return { k: 'str', v: c.value };
      case 'special':
        this.next();
        if (c.value === '*ALL' && this.is('str')) return { k: 'all', v: this.next().value };
        return { k: 'sp', v: c.value };
      case 'bif': {
        this.next();
        const args = this.isOp('(') ? this.args() : [];
        return { k: 'bif', name: c.value, args, line: c.line };
      }
      case 'id': this.next(); return { k: 'id', name: c.value, line: c.line };
      case 'op':
        if (c.value === '(') {
          this.next();
          const e = this.expr();
          if (this.isOp(':')) {
            const items = [e];
            while (this.accept('op', ':')) items.push(this.expr());
            this.expect('op', ')');
            return { k: 'list', items };
          }
          this.expect('op', ')');
          return e;
        }
        break;
      default: break;
    }
    throw new CompileError('RNF0602', `Expression not valid; found '${c.value || 'end of statement'}'.`, c.line);
  }
}

function constNum(e, line) {
  if (e && e.k === 'num') return e.v;
  if (e && e.k === 'id') return { ref: e.name };
  if (e && e.k === 'sp') return e.v;
  throw new CompileError('RNF3307', 'A numeric constant is expected.', line);
}
function refName(e, line) {
  if (!e) throw new CompileError('RNF3308', 'A name is expected.', line);
  if (e.k === 'str') return e.v.toUpperCase();
  if (e.k === 'id') return e.name;
  if (e.k === 'sp') return e.v;
  throw new CompileError('RNF3308', 'A name is expected.', line);
}
function bitsOf(n) { return n <= 3 ? 8 : n <= 5 ? 16 : n <= 10 ? 32 : 64; }
function kwObject(kws) {
  const o = {};
  for (const k of kws) o[k.kw] = k.args.map((a) => a.v ?? a.name);
  return o;
}
