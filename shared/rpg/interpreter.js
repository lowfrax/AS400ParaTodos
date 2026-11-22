// Intérprete del IR de RPG IV. Ejecuta con semántica RPG (ciclo, indicadores, tipos empaquetados,
// archivos por registro, SQL embebido) delegando la E/S en un "host" proporcionado por el sistema.
import {
  RpgError, Fig, isFig, isDur, coerce, blank, charLen, toNumber, toStr, numToChar, truthy, isCharType, isNumType,
  toDate, toTime, toTimestamp, fmtDate, addDuration, diffDates, dateToJs, editc, figValue,
} from './types.js';

export { RpgError };
export class RpgCancel extends Error {
  constructor(msg = 'Request ended.') { super(msg); this.cancel = true; }
}

const LEAVE = { s: 'leave' };
const ITER = { s: 'iter' };
const LEAVESR = { s: 'leavesr' };
const FKEY_IND = ['KA', 'KB', 'KC', 'KD', 'KE', 'KF', 'KG', 'KH', 'KI', 'KJ', 'KK', 'KL', 'KM', 'KN', 'KP', 'KQ', 'KR', 'KS', 'KT', 'KU', 'KV', 'KW', 'KX', 'KY'];
const DUR_UNITS = { '%DAYS': '*DAYS', '%MONTHS': '*MONTHS', '%YEARS': '*YEARS', '%HOURS': '*HOURS', '%MINUTES': '*MINUTES', '%SECONDS': '*SECONDS', '%MSECONDS': '*MSECONDS' };

class Scope {
  constructor(parent) { this.vars = new Map(); this.parent = parent; }
  lookup(n) {
    for (let s = this; s; s = s.parent) { const v = s.vars.get(n); if (v) return v; }
    return null;
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o));

export class RpgProgram {
  constructor(ir, host) {
    this.ir = ir;
    this.host = host;
    this.globals = new Scope(null);
    this.ind = {};
    for (let i = 1; i <= 99; i++) this.ind[String(i).padStart(2, '0')] = '0';
    for (const k of ['LR', 'RT', 'H1', 'U1', 'U2', ...FKEY_IND]) this.ind[k] = '0';
    this.files = new Map();
    this.formats = new Map();
    this.cursors = new Map();
    this.prepared = new Map();
    this.activated = false;
    this.ticks = 0;
    this.line = 0;
    this.last = { eof: false, found: false, equal: false, error: false, status: 0 };
    this.parms = 0;
  }

  // ---------- Activación ----------
  async activate() {
    const g = this.globals;
    const sqlDecls = [
      ['SQLCODE', { t: 'int', bits: 32 }], ['SQLCOD', { t: 'int', bits: 32 }], ['SQLSTATE', { t: 'char', len: 5 }],
      ['SQLSTT', { t: 'char', len: 5 }], ['SQLERRMC', { t: 'char', len: 70 }], ['SQLER3', { t: 'int', bits: 32 }],
    ];
    for (const [n, t] of sqlDecls) g.vars.set(n, { kind: 's', name: n, type: t, value: blank(t) });
    g.vars.set('SQLERRD', { kind: 's', name: 'SQLERRD', type: { t: 'int', bits: 32 }, dim: 6, value: [0, 0, 0, 0, 0, 0] });
    for (const f of this.ir.files) await this.openFile(f, g);
    for (const d of this.ir.decls) await this.declare(d, g);
    this.activated = true;
  }

  async openFile(f, scope) {
    const ent = { def: f, eof: false, found: false, equal: false, error: false, status: 0, open: true };
    const pfx = (n) => (f.prefix ? f.prefix + n : n);
    if (f.device === 'DISK') {
      const desc = await this.host.describeFile(f.extfile || f.name);
      ent.desc = desc;
      ent.h = this.host.openDisk(desc, f);
      for (const fld of desc.fields) this.ensureVar(scope, pfx(fld.name), fld.type);
      const fmt = f.rename[desc.format] || desc.format;
      this.formats.set(fmt, ent);
      ent.formats = [fmt];
    } else if (f.device === 'WORKSTN') {
      const dspf = await this.host.describeDisplay(f.extfile || f.name);
      ent.dspf = dspf;
      ent.formats = Object.keys(dspf.formats);
      for (const [fmtName, fmt] of Object.entries(dspf.formats)) {
        this.formats.set(f.rename[fmtName] || fmtName, ent);
        for (const fld of fmt.fields) this.ensureVar(scope, pfx(fld.name), fld.rpgType);
      }
      ent.sfl = {};
      for (const [fmtName, rrnVar] of Object.entries(f.sfile)) ent.sfl[fmtName] = { rrnVar, records: [] };
    } else if (f.device === 'PRINTER') {
      ent.h = this.host.openPrinter(f.name, f.prtlen || 132);
      ent.formats = [f.name];
    }
    this.files.set(f.name, ent);
  }

  ensureVar(scope, name, type) {
    if (!scope.lookup(name)) scope.vars.set(name, { kind: 's', name, type, value: blank(type) });
  }

  constNumber(x) {
    if (typeof x === 'number') return x;
    if (x && x.ref) {
      const v = this.globals.lookup(x.ref);
      if (v && v.kind === 'c') return toNumber(v.value);
      throw new RpgError('00202', 'RNF7030', `The name ${x.ref} is not defined as a constant.`);
    }
    return toNumber(x);
  }

  resolveType(t, scope) {
    if (!t) return t;
    if (t.t === 'like') {
      const v = scope.lookup(t.name);
      if (!v) throw new RpgError('00202', 'RNF7030', `The name or indicator ${t.name} is not defined.`);
      if (v.kind === 'ds') return { t: 'char', len: this.dsLen(v.tmpl) };
      const nt = clone(v.type);
      if (t.adj) { if (nt.len) nt.len += t.adj; if (nt.digits) nt.digits += t.adj; }
      return nt;
    }
    const out = { ...t };
    for (const k of ['len', 'digits', 'dec']) if (out[k] !== undefined) out[k] = this.constNumber(out[k]);
    return out;
  }

  dsLen(tmpl) { return tmpl.reduce((a, f) => a + (f.nested ? this.dsLen(f.nested) : charLen(f.type)) * (f.dim || 1), 0); }

  async buildTemplate(d, scope) {
    if (d.likeds) {
      if (d.likerec) {
        const ent = this.formats.get(d.likeds);
        if (!ent) throw new RpgError('00202', 'RNF7030', `Record format ${d.likeds} is not defined.`);
        const fields = ent.desc ? ent.desc.fields : ent.dspf.formats[d.likeds].fields.map((f) => ({ name: f.name, type: f.rpgType }));
        return fields.map((f) => ({ name: f.name, type: f.type }));
      }
      const src = scope.lookup(d.likeds);
      if (!src || src.kind !== 'ds') throw new RpgError('00202', 'RNF7030', `Data structure ${d.likeds} is not defined.`);
      return clone(src.tmpl);
    }
    if (d.extname) {
      const desc = await this.host.describeFile(d.extname);
      return desc.fields.map((f) => ({ name: f.name, type: f.type }));
    }
    const tmpl = [];
    for (const f of d.fields) {
      if (f.likeds) {
        const src = scope.lookup(f.likeds);
        if (!src || src.kind !== 'ds') throw new RpgError('00202', 'RNF7030', `Data structure ${f.likeds} is not defined.`);
        tmpl.push({ name: f.name, nested: clone(src.tmpl), dim: f.dim ? this.constNumber(f.dim) : 0 });
      } else {
        const type = this.resolveType(f.type, scope);
        let inz = null;
        if (f.inz) inz = coerce(type, await this.ev(f.inz, scope));
        tmpl.push({ name: f.name, type, dim: f.dim ? this.constNumber(f.dim) : 0, inz });
      }
    }
    return tmpl;
  }

  makeInst(tmpl) {
    const fields = new Map();
    for (const f of tmpl) {
      if (f.nested) {
        const sub = { kind: 'ds', name: f.name, qualified: true, tmpl: f.nested, dim: f.dim };
        sub.inst = f.dim ? Array.from({ length: f.dim }, () => this.makeInst(f.nested)) : this.makeInst(f.nested);
        fields.set(f.name, sub);
      } else {
        const init = f.inz !== null && f.inz !== undefined ? f.inz : blank(f.type);
        fields.set(f.name, {
          kind: 's', name: f.name, type: f.type, dim: f.dim, inzValue: init,
          value: f.dim ? Array.from({ length: f.dim }, () => init) : init,
        });
      }
    }
    return { fields };
  }

  async declare(d, scope) {
    if (d.kind === 'c') {
      scope.vars.set(d.name, { kind: 'c', name: d.name, value: await this.ev(d.value, scope) });
      return;
    }
    if (d.kind === 's') {
      const type = this.resolveType(d.type, scope);
      let init = blank(type);
      if (d.inz) {
        if (d.inz.k === 'sp' && d.inz.v === '*USER') init = coerce(type, this.host.user || '');
        else if (d.inz.k === 'sp' && ['*SYS', '*JOB'].includes(d.inz.v)) init = figValue(type, '*SYS');
        else init = coerce(type, await this.ev(d.inz, scope));
      }
      const dim = d.dim ? this.constNumber(d.dim) : 0;
      scope.vars.set(d.name, {
        kind: 's', name: d.name, type, dim, inzValue: init,
        value: dim ? Array.from({ length: dim }, () => init) : init,
      });
      return;
    }
    if (d.kind === 'ds') {
      const tmpl = await this.buildTemplate(d, scope);
      const dim = d.dim ? this.constNumber(d.dim) : 0;
      const v = { kind: 'ds', name: d.name, qualified: !!d.qualified || !!dim, tmpl, dim, template: d.template };
      v.inst = dim ? Array.from({ length: dim }, () => this.makeInst(tmpl)) : this.makeInst(tmpl);
      if (d.name !== '*N') scope.vars.set(d.name, v);
      if (!v.qualified) for (const [n, f] of v.inst.fields) scope.vars.set(n, f);
    }
  }

  // ---------- Ejecución principal ----------
  async call(args = []) {
    if (!this.activated) await this.activate();
    this.parms = args.length;
    this.ind.LR = '0';
    this.ind.RT = '0';
    const pi = this.ir.pi;
    const bound = [];
    if (pi) {
      for (let i = 0; i < pi.params.length; i++) {
        const p = pi.params[i];
        let v = this.globals.vars.get(p.name);
        const selfLike = p.type.t === 'like' && p.type.name === p.name && v;
        if (!selfLike) {
          const type = this.resolveType(p.type, this.globals);
          v = { kind: 's', name: p.name, type, value: blank(type) };
          this.globals.vars.set(p.name, v);
        }
        if (i < args.length && args[i]) {
          v.value = coerce(v.type, args[i].get());
          if (!p.const && !p.value) bound.push([v, args[i]]);
        }
      }
    }
    try {
      if (this.ir.ctl.MAIN) {
        const name = String(this.ir.ctl.MAIN[0]).toUpperCase();
        await this.callProc(this.ir.procs[name], (pi?.params || []).map((p) => ({ k: 'id', name: p.name })), this.globals);
        this.ind.LR = '1';
      } else {
        const fr = { subrs: this.ir.subrs, proc: null };
        if (this.ir.subrs['*INZSR'] && !this.inzDone) {
          this.inzDone = true;
          await this.execList(this.ir.subrs['*INZSR'], this.globals, fr);
        }
        for (;;) {
          const sig = await this.execList(this.ir.main, this.globals, fr);
          if (sig && sig.s === 'return') break;
          if (this.ind.LR === '1') break;
          // Ciclo RPG: sin *INLR ni RETURN, los cálculos se repiten.
          if (!this.ir.main.length) break;
          await this.tick(true);
        }
      }
    } catch (e) {
      if (e instanceof RpgError && this.ir.subrs['*PSSR'] && !this.inPssr) {
        this.inPssr = true;
        this.last.status = Number(e.status);
        await this.execList(this.ir.subrs['*PSSR'], this.globals, { subrs: this.ir.subrs });
        this.ind.LR = '1';
      } else throw e;
    } finally {
      for (const [v, ref] of bound) ref.set(v.value);
    }
    if (this.ind.LR === '1') await this.closeAll();
    return { lr: this.ind.LR === '1' };
  }

  async closeAll() {
    // Se espera a cada cierre: el de una impresora escribe el archivo en spool y debe existir al volver el CALL.
    for (const ent of this.files.values()) if (ent.h && ent.h.close) await ent.h.close();
  }

  async tick(force) {
    if (++this.ticks % 500 === 0 || force) {
      await new Promise((r) => setImmediate(r));
      if (this.host.checkCancel) this.host.checkCancel();
    }
  }

  async execList(stmts, sc, fr) {
    for (const s of stmts) {
      const sig = await this.exec(s, sc, fr);
      if (sig) return sig;
    }
    return null;
  }

  async exec(s, sc, fr) {
    this.line = s.line;
    await this.tick();
    switch (s.op) {
      case 'nop': return null;
      case 'assign': return this.assign(s, sc);
      case 'callp': {
        if (s.e) return this.withE(() => this.ev(s.call, sc, { stmt: true }));
        await this.ev(s.call, sc, { stmt: true });
        return null;
      }
      case 'if': {
        for (const b of s.branches) {
          if (truthy(await this.ev(b.cond, sc))) return this.execList(b.body, sc, fr);
        }
        return s.else ? this.execList(s.else, sc, fr) : null;
      }
      case 'dow':
        while (truthy(await this.ev(s.cond, sc))) {
          const sig = await this.execList(s.body, sc, fr);
          if (sig === LEAVE) break;
          if (sig && sig !== ITER) return sig;
          await this.tick();
        }
        return null;
      case 'dou':
        do {
          const sig = await this.execList(s.body, sc, fr);
          if (sig === LEAVE) break;
          if (sig && sig !== ITER) return sig;
          await this.tick();
        } while (!truthy(await this.ev(s.cond, sc)));
        return null;
      case 'for': {
        const ref = await this.place(s.v, sc);
        ref.set(await this.ev(s.from, sc));
        for (;;) {
          if (s.to) {
            const lim = toNumber(await this.ev(s.to, sc));
            const cur = toNumber(ref.get());
            if (s.down ? cur < lim : cur > lim) break;
          }
          const sig = await this.execList(s.body, sc, fr);
          if (sig === LEAVE) break;
          if (sig && sig !== ITER) return sig;
          const by = toNumber(await this.ev(s.by, sc));
          ref.set(toNumber(ref.get()) + (s.down ? -by : by));
          await this.tick();
        }
        return null;
      }
      case 'select': {
        for (const w of s.whens) if (truthy(await this.ev(w.cond, sc))) return this.execList(w.body, sc, fr);
        return s.other ? this.execList(s.other, sc, fr) : null;
      }
      case 'iter': return ITER;
      case 'leave': return LEAVE;
      case 'leavesr': return LEAVESR;
      case 'return': return { s: 'return', v: s.expr ? await this.ev(s.expr, sc) : undefined };
      case 'exsr': {
        const body = (fr.subrs && fr.subrs[s.name]) || this.ir.subrs[s.name];
        if (!body) throw new RpgError('00202', 'RNF7030', `Subroutine ${s.name} is not defined.`);
        const sig = await this.execList(body, sc, fr);
        if (sig && sig.s === 'return') return sig;
        return null;
      }
      case 'monitor': {
        try {
          const sig = await this.execList(s.body, sc, fr);
          return sig;
        } catch (e) {
          if (!(e instanceof RpgError)) throw e;
          const st = Number(e.status);
          this.last.status = st;
          for (const h of s.handlers) {
            const ok = !h.codes.length || h.codes.some((c) =>
              c === '*ALL' || (c === '*PROGRAM' && st < 1000) || (c === '*FILE' && st >= 1000) || Number(c) === st);
            if (ok) return this.execList(h.body, sc, fr);
          }
          throw e;
        }
      }
      case 'commit': case 'rolbk': {
        const r = this.host.sqlControl ? await this.host.sqlControl(s.op === 'commit' ? 'COMMIT' : 'ROLLBACK', {}) : null;
        this.last.error = !!(r && r.error);
        if (r && r.error && !(s.ext || '').includes('E')) throw new RpgError('00802', 'RNX0802', `Commitment control error: ${r.error}`);
        return null;
      }
      case 'dsply': {
        const text = s.msg ? toStr(await this.ev(s.msg, sc)) : '';
        if (s.resp) {
          const ref = await this.place(s.resp, sc);
          const reply = await this.host.dsply(text, true, ref.type ? charLen(ref.type) : 52);
          ref.set(isNumType(ref.type || { t: 'char' }) ? toNumber(reply || 0) : reply);
        } else await this.host.dsply(text, false);
        return null;
      }
      case 'clear': case 'reset': {
        const ref = await this.place(s.target, sc);
        ref.clear(s.op === 'reset');
        return null;
      }
      case 'sorta': {
        const ref = await this.place(s.target, sc);
        const arr = ref.get();
        if (!Array.isArray(arr)) throw new RpgError('00202', 'RNF7030', 'SORTA requires an array.');
        const sorted = [...arr].sort((a, b) => cmp(a, b));
        if (s.desc) sorted.reverse();
        ref.set(sorted);
        return null;
      }
      case 'move': {
        const ref = await this.place(s.target, sc);
        const src = await this.ev(s.src, sc);
        if (ref.type && isCharType(ref.type)) {
          const cur = toStr(ref.get());
          const sv = toStr(src);
          const len = cur.length;
          let res;
          if (s.left) res = sv.length >= len ? sv.slice(0, len) : sv + cur.slice(sv.length);
          else res = sv.length >= len ? sv.slice(sv.length - len) : cur.slice(0, len - sv.length) + sv;
          ref.set(res);
        } else ref.set(typeof src === 'string' ? toNumber(src.trim() || 0) : src);
        return null;
      }
      case 'callpgm': {
        const name = toStr(await this.ev(s.pgm, sc)).trim().toUpperCase();
        const refs = [];
        for (const p of s.parms) refs.push(await this.place(p, sc));
        await this.host.callProgram(name, refs);
        return null;
      }
      case 'file': return this.fileOp(s, sc);
      case 'sql': await this.execSql(s.text, sc); return null;
      default:
        throw new RpgError('00202', 'RNX9999', `Operation ${s.op} not supported.`);
    }
  }

  async withE(fn) {
    this.last.error = false;
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof RpgError)) throw e;
      this.last.error = true;
      this.last.status = Number(e.status);
    }
    return null;
  }

  async assign(s, sc) {
    if (s.corr) {
      const dst = await this.place(s.target, sc);
      const src = await this.place(s.expr, sc);
      if (dst.inst && src.inst) {
        for (const [n, f] of src.inst.fields) {
          const t = dst.inst.fields.get(n);
          if (t && t.kind === 's' && f.kind === 's') t.value = coerce(t.type, f.value);
        }
      }
      return null;
    }
    const ref = await this.place(s.target, sc);
    let v = await this.ev(s.expr, sc);
    if (s.mode !== '=') v = arith(s.mode.slice(0, -1), ref.get(), v);
    ref.set(v, { half: s.h, right: s.r });
    return null;
  }

  // ---------- Lugares (lvalues) ----------
  scalarPlace(v, idx) {
    const self = this;
    if (v.kind === 'c') return { type: null, get: () => v.value, set: () => { throw new RpgError('00202', 'RNF5346', `Constant ${v.name} cannot be changed.`); }, clear() {} };
    return {
      type: v.type,
      var: v,
      get() {
        if (idx === undefined || idx === null) return v.value;
        return v.value[self.checkIdx(v, idx)];
      },
      set(val, o) {
        if (Array.isArray(v.value) && (idx === undefined || idx === null)) {
          if (Array.isArray(val)) v.value = val.map((x) => coerce(v.type, x, o));
          else v.value = v.value.map(() => coerce(v.type, val, o));
          return;
        }
        if (idx === undefined || idx === null) v.value = coerce(v.type, val, o);
        else v.value[self.checkIdx(v, idx)] = coerce(v.type, val, o);
      },
      clear(reset) {
        const val = reset ? v.inzValue ?? blank(v.type) : blank(v.type);
        if (Array.isArray(v.value) && (idx === undefined || idx === null)) v.value = v.value.map(() => val);
        else if (idx === undefined || idx === null) v.value = val;
        else v.value[self.checkIdx(v, idx)] = val;
      },
    };
  }

  checkIdx(v, idx) {
    const i = Math.trunc(toNumber(idx));
    const n = Array.isArray(v.value) ? v.value.length : Array.isArray(v.inst) ? v.inst.length : 0;
    if (i < 1 || i > n) throw new RpgError('00121', 'RNX0121', `An array index is out of range (${i}).`);
    return i - 1;
  }

  dsPlace(v, inst) {
    const self = this;
    return {
      type: { t: 'char', len: this.dsLen(v.tmpl) },
      inst,
      dsvar: v,
      get() { return self.dsString(inst, v.tmpl); },
      set(val) {
        if (isFig(val)) { self.clearInst(inst, false, val.fig); return; }
        if (val && val.fields) { self.copyInst(val, inst); return; }
        self.splitInto(inst, v.tmpl, toStr(val));
      },
      clear(reset) { self.clearInst(inst, reset); },
    };
  }

  dsString(inst, tmpl) {
    let s = '';
    for (const f of tmpl) {
      const fv = inst.fields.get(f.name);
      if (fv.kind === 'ds') {
        const insts = Array.isArray(fv.inst) ? fv.inst : [fv.inst];
        for (const i of insts) s += this.dsString(i, f.nested);
        continue;
      }
      const vals = Array.isArray(fv.value) ? fv.value : [fv.value];
      for (const x of vals) s += fieldChars(f.type, x);
    }
    return s;
  }

  splitInto(inst, tmpl, str) {
    let pos = 0;
    for (const f of tmpl) {
      const fv = inst.fields.get(f.name);
      if (fv.kind === 'ds') {
        const insts = Array.isArray(fv.inst) ? fv.inst : [fv.inst];
        for (const i of insts) { const l = this.dsLen(f.nested); this.splitInto(i, f.nested, str.slice(pos, pos + l)); pos += l; }
        continue;
      }
      const len = charLen(f.type);
      const read = () => {
        const chunk = str.slice(pos, pos + len).padEnd(len);
        pos += len;
        if (isNumType(f.type)) {
          const digits = chunk.trim();
          const n = digits === '' ? 0 : Number(digits) / 10 ** (f.type.dec || 0);
          return Number.isNaN(n) ? 0 : n;
        }
        return coerce(f.type, chunk);
      };
      if (Array.isArray(fv.value)) fv.value = fv.value.map(read); else fv.value = read();
    }
  }

  clearInst(inst, reset, fig) {
    for (const fv of inst.fields.values()) {
      if (fv.kind === 'ds') {
        for (const i of Array.isArray(fv.inst) ? fv.inst : [fv.inst]) this.clearInst(i, reset, fig);
        continue;
      }
      const val = fig ? figValue(fv.type, fig) : reset ? fv.inzValue ?? blank(fv.type) : blank(fv.type);
      fv.value = Array.isArray(fv.value) ? fv.value.map(() => val) : val;
    }
  }

  copyInst(src, dst) {
    for (const [n, f] of src.fields) {
      const t = dst.fields.get(n);
      if (!t) continue;
      if (f.kind === 'ds') { this.copyInst(Array.isArray(f.inst) ? f.inst[0] : f.inst, Array.isArray(t.inst) ? t.inst[0] : t.inst); continue; }
      t.value = Array.isArray(f.value) ? [...f.value] : f.value;
    }
  }

  async place(e, sc) {
    switch (e.k) {
      case 'id': {
        const v = sc.lookup(e.name);
        if (!v) throw new RpgError('00202', 'RNF7030', `The name or indicator ${e.name} is not defined.`);
        if (v.kind === 'ds') return Array.isArray(v.inst) ? { type: null, dsvar: v, insts: v.inst, get: () => v.inst, set: () => {}, clear: (r) => v.inst.forEach((i) => this.clearInst(i, r)) } : this.dsPlace(v, v.inst);
        return this.scalarPlace(v);
      }
      case 'call': {
        const v = sc.lookup(e.name);
        if (v && v.kind === 's' && v.dim) return this.scalarPlace(v, await this.ev(e.args[0], sc));
        if (v && v.kind === 'ds' && Array.isArray(v.inst)) return this.dsPlace(v, v.inst[this.checkIdx(v, await this.ev(e.args[0], sc))]);
        const val = await this.ev(e, sc);
        return { type: null, get: () => val, set: () => {}, clear() {} };
      }
      case 'dot': {
        const base = await this.place(e.base, sc);
        if (!base.inst) throw new RpgError('00202', 'RNF7030', `${e.field} is not a subfield of a qualified data structure.`);
        const f = base.inst.fields.get(e.field);
        if (!f) throw new RpgError('00202', 'RNF7030', `The name ${e.field} is not a subfield.`);
        if (f.kind === 'ds') return Array.isArray(f.inst) ? { type: null, dsvar: f, insts: f.inst, get: () => f.inst, set: () => {}, clear() {} } : this.dsPlace(f, f.inst);
        return this.scalarPlace(f);
      }
      case 'idx': {
        // ds.campo(i) o ds.subds(i)
        const basePlace = await this.place(e.base, sc);
        const i = await this.ev(e.args[0], sc);
        if (basePlace.var && basePlace.var.dim) return this.scalarPlace(basePlace.var, i);
        if (basePlace.insts) return this.dsPlace(basePlace.dsvar, basePlace.insts[this.checkIdx(basePlace.dsvar, i)]);
        throw new RpgError('00121', 'RNX0121', 'Indexed item is not an array.');
      }
      case 'sp': {
        const key = indKey(e.v);
        if (key) {
          const self = this;
          return {
            type: { t: 'ind' },
            get: () => self.ind[key],
            set: (val) => { self.ind[key] = truthy(isFig(val) ? val.fig === '*ON' : val) ? '1' : '0'; },
            clear: () => { self.ind[key] = '0'; },
          };
        }
        if (e.v === '*IN') {
          const self = this;
          return {
            type: { t: 'ind' },
            get: () => Array.from({ length: 99 }, (_, i) => self.ind[String(i + 1).padStart(2, '0')]),
            set: (val) => { for (let i = 1; i <= 99; i++) self.ind[String(i).padStart(2, '0')] = truthy(isFig(val) ? val.fig === '*ON' : val) ? '1' : '0'; },
            clear: () => { for (let i = 1; i <= 99; i++) self.ind[String(i).padStart(2, '0')] = '0'; },
          };
        }
        throw new RpgError('00202', 'RNF5347', `${e.v} cannot be the target of an assignment.`);
      }
      case 'inidx': {
        const n = Math.trunc(toNumber(await this.ev(e.idx, sc)));
        if (n < 1 || n > 99) throw new RpgError('00121', 'RNX0121', 'An array index is out of range.');
        return this.place({ k: 'sp', v: '*IN' + String(n).padStart(2, '0') }, sc);
      }
      case 'bif': {
        if (e.name === '%SUBST') {
          const base = await this.place(e.args[0], sc);
          const start = Math.trunc(toNumber(await this.ev(e.args[1], sc)));
          const cur = toStr(base.get());
          const len = e.args[2] ? Math.trunc(toNumber(await this.ev(e.args[2], sc))) : cur.length - start + 1;
          if (start < 1 || start + len - 1 > cur.length) throw new RpgError('00100', 'RNX0100', 'Length or start position is out of range for the string operation.');
          return {
            type: { t: 'char', len },
            get: () => cur.substr(start - 1, len),
            set: (val) => {
              const s = coerce({ t: 'char', len }, val);
              const now = toStr(base.get());
              base.set(now.slice(0, start - 1) + s + now.slice(start - 1 + len));
            },
            clear: () => {},
          };
        }
        break;
      }
      default: break;
    }
    const val = await this.ev(e, sc);
    return { type: null, get: () => val, set: () => {}, clear() {} };
  }

  // ---------- Expresiones ----------
  async ev(e, sc, opts) {
    switch (e.k) {
      case 'num': return e.v;
      case 'str': return e.v;
      case 'all': return { all: e.v };
      case 'list': { const out = []; for (const x of e.items) out.push(await this.ev(x, sc)); return out; }
      case 'sp': return this.special(e.v);
      case 'id': {
        const v = sc.lookup(e.name);
        if (v) {
          if (v.kind === 'ds') return Array.isArray(v.inst) ? v.inst : this.dsString(v.inst, v.tmpl);
          return v.value;
        }
        if (this.ir.procs[e.name] || this.ir.protos[e.name]) return this.callNamed(e.name, [], sc);
        const t = new Date();
        if (e.name === 'UDATE') return Number(`${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}${String(t.getFullYear()).slice(2)}`);
        if (e.name === 'UYEAR') return t.getFullYear() % 100;
        if (e.name === 'UMONTH') return t.getMonth() + 1;
        if (e.name === 'UDAY') return t.getDate();
        throw new RpgError('00202', 'RNF7030', `The name or indicator ${e.name} is not defined.`);
      }
      case 'call': {
        const v = sc.lookup(e.name);
        if (v && (v.kind === 's' || v.kind === 'ds') && (v.dim || Array.isArray(v.inst))) {
          const p = await this.place(e, sc);
          return p.get();
        }
        return this.callNamed(e.name, e.args, sc);
      }
      case 'dot': case 'idx': case 'inidx': return (await this.place(e, sc)).get();
      case 'bif': return this.bif(e, sc);
      case 'un': {
        const v = await this.ev(e.e, sc);
        if (e.op === 'NOT') return !truthy(v);
        return -toNumber(v);
      }
      case 'bin': {
        if (e.op === 'AND') return truthy(await this.ev(e.l, sc)) && truthy(await this.ev(e.r, sc));
        if (e.op === 'OR') return truthy(await this.ev(e.l, sc)) || truthy(await this.ev(e.r, sc));
        const l = await this.ev(e.l, sc);
        const r = await this.ev(e.r, sc);
        switch (e.op) {
          case '=': return cmp(l, r) === 0;
          case '<>': return cmp(l, r) !== 0;
          case '<': return cmp(l, r) < 0;
          case '>': return cmp(l, r) > 0;
          case '<=': return cmp(l, r) <= 0;
          case '>=': return cmp(l, r) >= 0;
          default: return arith(e.op, l, r);
        }
      }
      default: throw new RpgError('00202', 'RNX9999', `Expression kind ${e.k} not supported.`);
    }
  }

  special(v) {
    switch (v) {
      case '*ON': return '1';
      case '*OFF': return '0';
      case '*BLANK': case '*BLANKS': return Fig('*BLANKS');
      case '*ZERO': case '*ZEROS': return Fig('*ZEROS');
      case '*HIVAL': return Fig('*HIVAL');
      case '*LOVAL': return Fig('*LOVAL');
      case '*NULL': return Fig('*NULL');
      case '*OMIT': return Fig('*OMIT');
      case '*DATE': { const t = new Date(); return Number(`${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}${t.getFullYear()}`); }
      case '*USER': return this.host.user || '';
      default: {
        const key = indKey(v);
        if (key) return this.ind[key];
        return v; // *ISO, *DAYS, *START… se usan como argumentos
      }
    }
  }

  async callNamed(name, args, sc) {
    const proc = this.ir.procs[name];
    if (proc) return this.callProc(proc, args, sc);
    const pr = this.ir.protos[name];
    if (pr) {
      if (pr.extproc && this.ir.procs[pr.extproc]) return this.callProc(this.ir.procs[pr.extproc], args, sc);
      if (pr.extpgm) {
        const refs = [];
        for (let i = 0; i < args.length; i++) {
          const p = pr.params[i];
          if (p && (p.value || p.const)) {
            const val = await this.ev(args[i], sc);
            refs.push({ get: () => val, set: () => {}, type: p.type });
          } else refs.push(await this.place(args[i], sc));
        }
        await this.host.callProgram(pr.extpgm.toUpperCase(), refs);
        return undefined;
      }
      // Procedimiento externo de sistema conocido
      if (this.host.callProc) {
        const vals = [];
        const places = [];
        for (let i = 0; i < args.length; i++) {
          const p = pr.params[i];
          const byRef = p && !p.value && !p.const && ['id', 'dot', 'idx', 'call'].includes(args[i].k);
          const pl = byRef ? await this.place(args[i], sc).catch(() => null) : null;
          places.push(pl);
          vals.push(pl ? pl.get() : await this.ev(args[i], sc));
        }
        const r = await this.host.callProc(pr.extproc || name, vals, places, pr);
        return r === undefined || !pr.returns ? r : coerce(this.resolveType(pr.returns, this.globals), r);
      }
    }
    throw new RpgError('00211', 'RNX0211', `Program or procedure ${name} is not defined.`);
  }

  async callProc(proc, args, sc) {
    const local = new Scope(this.globals);
    const back = [];
    for (let i = 0; i < proc.params.length; i++) {
      const p = proc.params[i];
      const type = p.type.t === 'likeds' || p.type.t === 'likerec' ? null : this.resolveType(p.type, this.globals);
      if (i >= args.length || (args[i].k === 'sp' && args[i].v === '*OMIT')) {
        if (type) local.vars.set(p.name, { kind: 's', name: p.name, type, value: blank(type) });
        continue;
      }
      if (!type) {
        const src = await this.place(args[i], sc);
        const tmpl = (this.globals.lookup(p.type.name) || {}).tmpl || (src.dsvar && src.dsvar.tmpl) || [];
        const v = { kind: 'ds', name: p.name, qualified: true, tmpl, inst: this.makeInst(tmpl) };
        if (src.inst) this.copyInst(src.inst, v.inst);
        local.vars.set(p.name, v);
        if (!p.value && !p.const && src.inst) back.push(() => this.copyInst(v.inst, src.inst));
        continue;
      }
      const dim = p.dim ? this.constNumber(p.dim) : 0;
      if (!p.value && !p.const) {
        const ref = await this.place(args[i], sc);
        const v = { kind: 's', name: p.name, type, dim };
        const cur = ref.get();
        v.value = dim ? (Array.isArray(cur) ? cur.map((x) => coerce(type, x)) : Array(dim).fill(blank(type))) : coerce(type, cur);
        local.vars.set(p.name, v);
        back.push(() => ref.set(v.value));
      } else {
        const val = await this.ev(args[i], sc);
        local.vars.set(p.name, {
          kind: 's', name: p.name, type, dim,
          value: dim ? (Array.isArray(val) ? val.map((x) => coerce(type, x)) : Array(dim).fill(blank(type))) : coerce(type, val),
        });
      }
    }
    const savedParms = this.parms;
    this.parms = args.length;
    for (const d of proc.decls) await this.declare(d, local);
    let sig;
    try {
      sig = await this.execList(proc.body, local, { subrs: proc.subrs, proc });
    } finally {
      this.parms = savedParms;
      for (const b of back) b();
    }
    if (proc.returns) {
      const rt = proc.returns.t === 'likeds' ? null : this.resolveType(proc.returns, this.globals);
      if (sig && sig.s === 'return') return rt ? coerce(rt, sig.v) : sig.v;
      return rt ? blank(rt) : undefined;
    }
    return undefined;
  }

  // Tipo y valor de una expresión cuando se conoce (para %CHAR, %EDITC, %LEN…).
  async typed(e, sc) {
    if (e.k === 'id' || e.k === 'dot' || e.k === 'idx' || (e.k === 'call' && sc.lookup(e.name))) {
      const p = await this.place(e, sc);
      return { v: p.get(), t: p.type };
    }
    if (e.k === 'bif' && ['%DATE', '%TIME', '%TIMESTAMP'].includes(e.name)) {
      return { v: await this.ev(e, sc), t: { t: e.name.slice(1).toLowerCase() } };
    }
    return { v: await this.ev(e, sc), t: null };
  }

  fileEntry(name, need = true) {
    const ent = this.files.get(name) || this.formats.get(name);
    if (!ent && need) throw new RpgError('01211', 'RNX1211', `File or record format ${name} is not defined.`);
    return ent;
  }

  async bif(e, sc) {
    const a = e.args;
    const ev = (i) => this.ev(a[i], sc);
    const num = async (i) => toNumber(await ev(i));
    const str = async (i) => toStr(await ev(i));
    const fileFlag = (flag) => {
      if (!a.length) return this.last[flag] ? '1' : '0';
      const ent = this.fileEntry(a[0].name || a[0].v);
      return ent[flag] ? '1' : '0';
    };
    switch (e.name) {
      case '%TRIM': case '%TRIML': case '%TRIMR': {
        const s = await str(0);
        const chars = a[1] ? await str(1) : ' ';
        const set = new Set(chars.split(''));
        let i = 0, j = s.length;
        if (e.name !== '%TRIMR') while (i < j && set.has(s[i])) i++;
        if (e.name !== '%TRIML') while (j > i && set.has(s[j - 1])) j--;
        return s.slice(i, j);
      }
      case '%CHAR': {
        const { v, t } = await this.typed(a[0], sc);
        const fmt = a[1] ? await ev(1) : null;
        if (t && t.t === 'date') return fmtDate(v, fmt || '*ISO');
        if (t && t.t === 'time') return fmt === '*HMS' || fmt === '*USA' ? v.replace(/\./g, ':') : v;
        if (t && t.t === 'timestamp') return v;
        if (typeof v === 'number') return t && (t.t === 'packed' || t.t === 'zoned') ? numToChar(v, t.dec) : numToChar(v);
        if (typeof v === 'boolean') return v ? '1' : '0';
        return toStr(v);
      }
      case '%DEC': case '%DECH': {
        const { v, t } = await this.typed(a[0], sc);
        if (t && t.t === 'date') return Number(fmtDate(v, (a[1] ? await ev(1) : '*ISO') + '0').replace(/\D/g, ''));
        const n = toNumber(typeof v === 'string' ? v.trim() : v);
        if (a.length >= 3) return coerce({ t: 'packed', digits: await num(1), dec: await num(2) }, n, { half: e.name === '%DECH' });
        return n;
      }
      case '%INT': case '%INTH': case '%UNS': case '%UNSH': {
        const n = toNumber(typeof (await ev(0)) === 'string' ? (await str(0)).trim() : await ev(0));
        return e.name.endsWith('H') ? Math.round(n) : Math.trunc(n);
      }
      case '%FLOAT': return toNumber(await ev(0));
      case '%ABS': return Math.abs(await num(0));
      case '%SQRT': return Math.sqrt(await num(0));
      case '%DIV': { const d = await num(1); if (!d) throw new RpgError('00102', 'RNX0102', 'Attempt to divide by zero.'); return Math.trunc((await num(0)) / d); }
      case '%REM': { const d = await num(1); if (!d) throw new RpgError('00102', 'RNX0102', 'Attempt to divide by zero.'); return (await num(0)) % d; }
      case '%MAX': case '%MIN': {
        const vals = [];
        for (let i = 0; i < a.length; i++) vals.push(await ev(i));
        return vals.reduce((x, y) => (e.name === '%MAX' ? (cmp(x, y) >= 0 ? x : y) : (cmp(x, y) <= 0 ? x : y)));
      }
      case '%LEN': {
        const { v, t } = await this.typed(a[0], sc);
        if (t && t.t === 'char') return t.len;
        if (t && (t.t === 'packed' || t.t === 'zoned')) return t.digits;
        return toStr(v).length;
      }
      case '%SIZE': {
        const { v, t } = await this.typed(a[0], sc);
        if (t) {
          if (t.t === 'packed') return Math.floor(t.digits / 2) + 1;
          if (t.t === 'int' || t.t === 'uns') return t.bits / 8;
          return charLen(t);
        }
        return toStr(v).length;
      }
      case '%ELEM': {
        const p = await this.place(a[0], sc);
        if (p.var && p.var.dim) return p.var.dim;
        if (p.insts) return p.insts.length;
        const arr = p.get();
        return Array.isArray(arr) ? arr.length : 0;
      }
      case '%SUBST': {
        const s = await str(0);
        const start = Math.trunc(await num(1));
        const len = a[2] ? Math.trunc(await num(2)) : s.length - start + 1;
        if (start < 1 || len < 0 || start + len - 1 > s.length) throw new RpgError('00100', 'RNX0100', 'Length or start position is out of range for the string operation.');
        return s.substr(start - 1, len);
      }
      case '%SCAN': case '%SCANR': {
        const search = await str(0); const src = await str(1);
        const start = a[2] ? Math.trunc(await num(2)) : 1;
        if (e.name === '%SCAN') { const i = src.indexOf(search, start - 1); return i + 1; }
        const i = src.lastIndexOf(search); return i >= start - 1 ? i + 1 : 0;
      }
      case '%SCANRPL': return (await str(2)).split(await str(0)).join(await str(1));
      case '%REPLACE': {
        const repl = await str(0); const src = await str(1);
        const start = a[2] ? Math.trunc(await num(2)) : 1;
        const len = a[3] ? Math.trunc(await num(3)) : repl.length;
        return src.slice(0, start - 1) + repl + src.slice(start - 1 + len);
      }
      case '%XLATE': {
        const from = await str(0); const to = await str(1); const src = await str(2);
        const start = a[3] ? Math.trunc(await num(3)) : 1;
        let out = src.slice(0, start - 1);
        for (const ch of src.slice(start - 1)) { const i = from.indexOf(ch); out += i >= 0 ? (to[i] ?? ' ') : ch; }
        return out;
      }
      case '%UPPER': return (await str(0)).toUpperCase();
      case '%LOWER': return (await str(0)).toLowerCase();
      case '%CHECK': case '%CHECKR': {
        const cmpS = await str(0); const base = await str(1);
        const start = a[2] ? Math.trunc(await num(2)) : (e.name === '%CHECK' ? 1 : base.length);
        if (e.name === '%CHECK') { for (let i = start - 1; i < base.length; i++) if (!cmpS.includes(base[i])) return i + 1; return 0; }
        for (let i = start - 1; i >= 0; i--) if (!cmpS.includes(base[i])) return i + 1;
        return 0;
      }
      case '%LOOKUP': {
        const arg = await ev(0); const arr = await ev(1);
        const start = a[2] ? Math.trunc(await num(2)) : 1;
        if (!Array.isArray(arr)) return 0;
        for (let i = start - 1; i < arr.length; i++) if (cmp(arr[i], arg) === 0) return i + 1;
        return 0;
      }
      case '%XFOOT': { const arr = await ev(0); return Array.isArray(arr) ? arr.reduce((x, y) => x + toNumber(y), 0) : 0; }
      case '%EDITC': {
        const { v, t } = await this.typed(a[0], sc);
        return editc(toNumber(v), await str(1), t);
      }
      case '%EDITW': {
        const n = Math.abs(await num(0));
        const mask = await str(1);
        const { t } = await this.typed(a[0], sc);
        const dec = t && t.dec ? t.dec : 0;
        let digits = String(Math.round(n * 10 ** dec));
        let out = '';
        let started = false;
        const slots = mask.split('').filter((c) => c === ' ' || c === '0').length;
        digits = digits.padStart(slots, '0');
        let di = 0;
        for (const c of mask) {
          if (c === ' ' || c === '0') {
            const d = digits[di++];
            if (d !== '0' || c === '0') started = true;
            out += started ? d : ' ';
            if (c === '0') started = true;
          } else out += started || c === '.' ? c : ' ';
        }
        return out;
      }
      case '%EOF': return fileFlag('eof');
      case '%FOUND': return fileFlag('found');
      case '%EQUAL': return fileFlag('equal');
      case '%ERROR': return this.last.error ? '1' : '0';
      case '%OPEN': { const ent = this.fileEntry(a[0].name, false); return ent && ent.open ? '1' : '0'; }
      case '%STATUS': return this.last.status;
      case '%PARMS': return this.parms;
      case '%KDS': {
        const p = await this.place(a[0], sc);
        const n = a[1] ? Math.trunc(await num(1)) : Infinity;
        const vals = [...p.inst.fields.values()].filter((f) => f.kind === 's').map((f) => f.value);
        return { kds: vals.slice(0, n) };
      }
      case '%DATE': {
        if (!a.length) return toDate(new Date());
        const v = await ev(0);
        const fmt = a[1] ? await ev(1) : '*ISO';
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}-\d{2}\./.test(v)) return v.slice(0, 10);
        return toDate(v, fmt);
      }
      case '%TIME': {
        if (!a.length) return toTime(new Date());
        const v = await ev(0);
        return toTime(typeof v === 'number' ? String(v).padStart(6, '0') : v);
      }
      case '%TIMESTAMP': return a.length ? toTimestamp(await ev(0)) : toTimestamp(new Date());
      case '%DAYS': case '%MONTHS': case '%YEARS': case '%HOURS': case '%MINUTES': case '%SECONDS': case '%MSECONDS':
        return { dur: Math.trunc(await num(0)), unit: DUR_UNITS[e.name] };
      case '%DIFF': return diffDates(toStr(await ev(0)), toStr(await ev(1)), await ev(2));
      case '%SUBDT': {
        const v = toStr(await ev(0)); const unit = await ev(1);
        const d = dateToJs(v.length === 8 && v[2] === '.' ? `0001-01-01-${v}` : v);
        switch (unit) {
          case '*YEARS': case '*Y': return d.getUTCFullYear();
          case '*MONTHS': case '*M': return d.getUTCMonth() + 1;
          case '*DAYS': case '*D': return d.getUTCDate();
          case '*HOURS': case '*H': return d.getUTCHours();
          case '*MINUTES': case '*MN': return d.getUTCMinutes();
          case '*SECONDS': case '*S': return d.getUTCSeconds();
          default: return 0;
        }
      }
      case '%NULLIND': return '0';
      case '%ADDR': case '%PADDR': return null;
      // %STR: los "punteros" a cadena de las APIs del sistema (getenv…) son cadenas JS terminadas en NUL.
      case '%STR': { const s0 = a[0] ? await this.ev(a[0], sc) : ''; const t = s0 === null || s0 === undefined ? '' : toStr(s0).split('\u0000')[0]; return a[1] ? t.slice(0, toNumber(await this.ev(a[1], sc))) : t; }
      default:
        throw new RpgError('00202', 'RNF7030', `Built-in function ${e.name} is not supported.`);
    }
  }

  // ---------- Operaciones de archivo ----------
  async keyVals(e, sc) {
    if (e.k === 'list') { const out = []; for (const x of e.items) out.push(await this.ev(x, sc)); return out; }
    if (e.k === 'sp' && ['*START', '*END', '*LOVAL', '*HIVAL'].includes(e.v)) return e.v;
    const v = await this.ev(e, sc);
    if (v && v.kds) return v.kds;
    return [v];
  }

  moveIn(ent, rec, dsName, sc) {
    const pfx = ent.def.prefix || '';
    if (dsName) {
      const ds = sc.lookup(dsName);
      for (const f of ent.desc.fields) {
        const fv = ds.inst.fields.get(f.name);
        if (fv) fv.value = coerce(fv.type, rec[f.name] ?? blank(fv.type));
      }
      return;
    }
    for (const f of ent.desc.fields) {
      const v = sc.lookup(pfx + f.name);
      if (v && v.kind === 's') v.value = coerce(v.type, rec[f.name] ?? blank(v.type));
    }
  }

  moveOut(ent, dsName, sc) {
    const pfx = ent.def.prefix || '';
    const rec = {};
    const ds = dsName ? sc.lookup(dsName) : null;
    for (const f of ent.desc.fields) {
      const v = ds ? ds.inst.fields.get(f.name) : sc.lookup(pfx + f.name);
      let val = v ? v.value : blank(f.type);
      if (f.type.t === 'char' || f.type.t === 'varchar') val = toStr(val).replace(/\s+$/, '');
      rec[f.name] = val;
    }
    return rec;
  }

  async fileOp(s, sc) {
    const ent = this.fileEntry(s.file);
    const run = async () => {
      ent.error = false;
      this.last.error = false;
      const op = s.fop;
      if (ent.def.device === 'WORKSTN') return this.workstnOp(ent, s, sc);
      if (ent.def.device === 'PRINTER') {
        if (op === 'WRITE') {
          const v = s.ds ? toStr((await this.place({ k: 'id', name: s.ds }, sc)).get()) : '';
          ent.h.write(v);
        }
        return;
      }
      if (!ent.open && op !== 'OPEN') throw new RpgError('01211', 'RNX1211', `I/O operation was applied to closed file ${ent.def.name}.`);
      const h = ent.h;
      switch (op) {
        case 'READ': case 'READP': {
          const r = op === 'READ' ? await h.read() : await h.readp();
          ent.eof = this.last.eof = !r;
          if (r) this.moveIn(ent, r, s.ds, sc);
          break;
        }
        case 'READE': case 'READPE': {
          const k = await this.keyVals(s.key, sc);
          const r = op === 'READE' ? await h.reade(k) : await h.readpe(k);
          ent.eof = this.last.eof = !r;
          if (r) this.moveIn(ent, r, s.ds, sc);
          break;
        }
        case 'CHAIN': {
          const r = await h.chain(await this.keyVals(s.key, sc));
          ent.found = this.last.found = !!r;
          if (r) this.moveIn(ent, r, s.ds, sc);
          break;
        }
        case 'SETLL': {
          const eq = await h.setll(await this.keyVals(s.key, sc));
          ent.found = ent.equal = this.last.found = this.last.equal = !!eq;
          ent.eof = this.last.eof = false;
          break;
        }
        case 'SETGT': await h.setgt(await this.keyVals(s.key, sc)); ent.eof = this.last.eof = false; break;
        case 'WRITE': await h.write(this.moveOut(ent, s.ds, sc)); break;
        case 'UPDATE': await h.update(this.moveOut(ent, s.ds, sc), s.fields); break;
        case 'DELETE': {
          const ok = await h.delete(s.key ? await this.keyVals(s.key, sc) : null);
          ent.found = this.last.found = !!ok;
          break;
        }
        case 'OPEN': ent.open = true; h.reset(); break;
        case 'CLOSE': ent.open = false; break;
        case 'UNLOCK': case 'FEOD': break;
        default: throw new RpgError('01299', 'RNX1299', `Operation ${op} not valid for file ${ent.def.name}.`);
      }
    };
    if (s.ext && s.ext.includes('E')) {
      try { await run(); } catch (e) {
        if (!(e instanceof RpgError)) throw e;
        ent.error = this.last.error = true;
        ent.status = this.last.status = Number(e.status);
      }
      return null;
    }
    await run();
    return null;
  }

  async workstnOp(ent, s, sc) {
    const pfx = ent.def.prefix || '';
    const fmtName = Object.keys(ent.def.rename).find((k) => ent.def.rename[k] === s.file) || s.file;
    const collect = (fmt) => {
      const vals = {};
      for (const f of fmt.fields) { const v = sc.lookup(pfx + f.name); vals[f.name] = v ? v.value : blank(f.rpgType); }
      return vals;
    };
    if (s.fop === 'CLOSE' || s.fop === 'OPEN') { ent.open = s.fop === 'OPEN'; return; }
    const fmt = ent.dspf.formats[fmtName];
    if (!fmt && s.fop !== 'READ') throw new RpgError('01299', 'RNX1299', `Record format ${s.file} not found in display file.`);
    // Subarchivo: WRITE añade un registro; CHAIN/READC/UPDATE trabajan sobre los registros guardados.
    const sfl = ent.sfl && ent.sfl[fmtName];
    if (sfl) {
      const rrnV = sc.lookup(sfl.rrnVar);
      const rrn = rrnV ? Math.trunc(toNumber(rrnV.value)) : 0;
      switch (s.fop) {
        case 'WRITE': sfl.records[rrn - 1] = { ...collect(fmt), $rrn: rrn, $chg: false }; return;
        case 'UPDATE': if (sfl.records[rrn - 1]) Object.assign(sfl.records[rrn - 1], collect(fmt)); return;
        case 'CHAIN': {
          const k = Math.trunc(toNumber((await this.keyVals(s.key, sc))[0]));
          const r = sfl.records[k - 1];
          ent.found = this.last.found = !!r;
          if (r) { for (const f of fmt.fields) { const v = sc.lookup(pfx + f.name); if (v) v.value = coerce(v.type, r[f.name]); } if (rrnV) rrnV.value = k; }
          return;
        }
        case 'READC': {
          sfl.readPos = sfl.readPos ?? 0;
          while (sfl.readPos < sfl.records.length) {
            const r = sfl.records[sfl.readPos++];
            if (r && r.$chg) {
              r.$chg = false;
              for (const f of fmt.fields) { const v = sc.lookup(pfx + f.name); if (v) v.value = coerce(v.type, r[f.name]); }
              if (rrnV) rrnV.value = r.$rrn;
              ent.eof = this.last.eof = false;
              return;
            }
          }
          ent.eof = this.last.eof = true;
          return;
        }
        default: break;
      }
    }
    if (fmt && fmt.sflctl && s.fop !== 'READ') {
      const sflName = fmt.sflctl;
      const sf = ent.sfl[sflName] || (ent.sfl[sflName] = { records: [] });
      if (fmt.sflclrInd && this.indOn(fmt.sflclrInd)) { sf.records = []; }
      if (s.fop === 'WRITE' && !(fmt.sfldspInd && this.indOn(fmt.sfldspInd))) {
        return;
      }
    }
    const values = fmt ? collect(fmt) : {};
    let sflData = null;
    if (fmt && fmt.sflctl) {
      const sf = ent.sfl[fmt.sflctl];
      const sflFmt = ent.dspf.formats[fmt.sflctl];
      const showSfl = !fmt.sfldspInd || this.indOn(fmt.sfldspInd);
      sflData = showSfl ? { format: fmt.sflctl, records: sf.records.filter(Boolean), fields: sflFmt.fields } : null;
      if (sf) sf.readPos = 0;
    }
    const mode = s.fop === 'EXFMT' ? 'exfmt' : s.fop === 'WRITE' ? 'write' : 'read';
    const res = await this.host.display(ent.def.name, fmtName, values, { ...this.ind }, mode, sflData);
    if (!res) return;
    if (res.ind) Object.assign(this.ind, res.ind);
    if (res.aid) {
      const fk = /^F(\d+)$/.exec(res.aid);
      for (const k of FKEY_IND) this.ind[k] = '0';
      if (fk) this.ind[FKEY_IND[Number(fk[1]) - 1]] = '1';
    }
    if (res.values && fmt) {
      for (const f of fmt.fields) {
        if (f.usage === 'O' || !(f.name in res.values)) continue;
        const v = sc.lookup(pfx + f.name);
        if (v) v.value = coerce(v.type, isNumType(v.type) ? toNumber(String(res.values[f.name]).trim() || 0) : res.values[f.name]);
      }
    }
    if (res.sflRecords && sflData) {
      const sf = ent.sfl[sflData.format];
      for (const upd of res.sflRecords) {
        const r = sf.records[upd.$rrn - 1];
        if (!r) continue;
        for (const [k, v] of Object.entries(upd)) if (k !== '$rrn') r[k] = v;
        r.$chg = true;
      }
    }
  }

  indOn(cond) {
    if (!cond) return true;
    return cond.every(({ ind, not }) => (this.ind[ind] === '1') !== not);
  }

  // ---------- SQL embebido ----------
  hostVars(text) {
    const vars = [];
    let out = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "'") {
        let j = i + 1;
        while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
        out += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      const m = /^:\s*([A-Za-z_#@$][\w#@$]*(?:\.[A-Za-z_#@$][\w#@$]*)?)/.exec(text.slice(i));
      if (m) {
        vars.push(m[1].toUpperCase());
        out += '?';
        i += m[0].length;
        // Variable indicadora de nulo opcional: ":var :ind" o ":var INDICATOR :ind"
        const ind = /^\s*(?:INDICATOR\s*)?:\s*[A-Za-z_#@$][\w#@$]*/i.exec(text.slice(i));
        if (ind && !/^\s*,/.test(text.slice(i))) i += ind[0].length;
        continue;
      }
      out += c;
      i++;
    }
    return { sql: out, vars };
  }

  varExpr(name) {
    const parts = name.split('.');
    let e = { k: 'id', name: parts[0] };
    for (const p of parts.slice(1)) e = { k: 'dot', base: e, field: p };
    return e;
  }

  async hostValues(vars, sc) {
    const out = [];
    for (const v of vars) {
      const p = await this.place(this.varExpr(v), sc);
      let val = p.get();
      if (p.type && p.type.t === 'char') val = toStr(val).replace(/\s+$/, '');
      if (p.type && p.type.t === 'ind') val = val === '1' ? 1 : 0;
      out.push(val);
    }
    return out;
  }

  async assignRow(targets, row, sc) {
    if (targets.length === 1 && row.length > 1) {
      const p = await this.place(this.varExpr(targets[0]), sc);
      if (p.inst) {
        const fields = [...p.inst.fields.values()].filter((f) => f.kind === 's');
        fields.forEach((f, i) => { if (i < row.length) f.value = coerce(f.type, row[i] ?? blank(f.type)); });
        return;
      }
    }
    for (let i = 0; i < targets.length; i++) {
      const p = await this.place(this.varExpr(targets[i]), sc);
      const v = row[i];
      p.set(v === null || v === undefined ? (p.type ? blank(p.type) : '') : v);
    }
  }

  setSqlca(code, state, msg = '', rows = 0) {
    const g = this.globals.vars;
    g.get('SQLCODE').value = code; g.get('SQLCOD').value = code;
    g.get('SQLSTATE').value = state; g.get('SQLSTT').value = state;
    g.get('SQLERRMC').value = coerce({ t: 'char', len: 70 }, msg);
    g.get('SQLER3').value = rows;
    g.get('SQLERRD').value[2] = rows;
  }

  async runQuery(sqlText, params) {
    const r = await this.host.sql(sqlText, params);
    if (r.error) { this.setSqlca(r.sqlcode ?? -901, r.sqlstate || '58004', r.error); return null; }
    return r;
  }

  async execSql(text, sc) {
    const T = text.trim();
    const U = T.toUpperCase();
    let m;
    // Control de compromiso: SET OPTION COMMIT = *CHG|*CS|*ALL|*NONE, COMMIT [HOLD], ROLLBACK [HOLD]
    if ((m = /^SET\s+OPTION\b[\s\S]*\bCOMMIT\s*=\s*(\*\w+)/i.exec(T)) && this.host.sqlControl) {
      const r = await this.host.sqlControl('OPTION', { commit: m[1].toUpperCase() });
      if (r && r.error) this.setSqlca(r.sqlcode ?? -901, r.sqlstate || '58004', r.error); else this.setSqlca(0, '00000');
      return;
    }
    if ((m = /^(COMMIT|ROLLBACK)(?:\s+WORK)?(\s+HOLD)?\s*$/i.exec(T)) && this.host.sqlControl) {
      const r = await this.host.sqlControl(m[1].toUpperCase(), { hold: !!m[2] });
      if (r && r.error) this.setSqlca(r.sqlcode ?? -901, r.sqlstate || '58004', r.error); else this.setSqlca(0, '00000');
      return;
    }
    if (/^SET\s+OPTION\b/.test(U) || /^(COMMIT|ROLLBACK)\b/.test(U) || /^WHENEVER\b/.test(U) || /^INCLUDE\b/.test(U)) {
      this.setSqlca(0, '00000');
      return;
    }
    if ((m = /^DECLARE\s+([\w#@$]+)\s+(?:(?:INSENSITIVE|SENSITIVE|ASENSITIVE|NO\s+SCROLL|SCROLL|DYNAMIC)\s+)*CURSOR\s+(?:WITH(?:OUT)?\s+(?:HOLD|RETURN)\s+)*FOR\s+([\s\S]+)$/i.exec(T))) {
      const src = m[2].trim();
      this.cursors.set(m[1].toUpperCase(), /^[\w#@$]+$/.test(src) ? { stmt: src.toUpperCase() } : { text: src });
      this.setSqlca(0, '00000');
      return;
    }
    if ((m = /^PREPARE\s+([\w#@$]+)\s+(?:INTO\s+\S+\s+)?FROM\s+([\s\S]+)$/i.exec(T))) {
      const hv = this.hostVars(m[2]);
      const v = hv.vars.length ? toStr((await this.hostValues(hv.vars, sc))[0]) : m[2].replace(/^'|'$/g, '');
      this.prepared.set(m[1].toUpperCase(), v.trim());
      this.setSqlca(0, '00000');
      return;
    }
    if ((m = /^EXECUTE\s+IMMEDIATE\s+([\s\S]+)$/i.exec(T))) {
      const hv = this.hostVars(m[1]);
      const stmt = hv.vars.length ? toStr((await this.hostValues(hv.vars, sc))[0]).trim() : m[1].replace(/^'|'$/g, '');
      const r = await this.runQuery(stmt, []);
      if (r) this.setSqlca(0, '00000', '', r.rowCount);
      return;
    }
    if ((m = /^EXECUTE\s+([\w#@$]+)(?:\s+USING\s+([\s\S]+))?$/i.exec(T))) {
      const stmt = this.prepared.get(m[1].toUpperCase()) || '';
      const params = m[2] ? await this.hostValues(this.hostVars(m[2]).vars, sc) : [];
      const r = await this.runQuery(stmt, params);
      if (r) this.setSqlca(0, '00000', '', r.rowCount);
      return;
    }
    if ((m = /^OPEN\s+([\w#@$]+)(?:\s+USING\s+([\s\S]+))?$/i.exec(T))) {
      const cur = this.cursors.get(m[1].toUpperCase());
      if (!cur) { this.setSqlca(-504, '34000', `Cursor ${m[1]} not declared.`); return; }
      let q = cur.text;
      let params = [];
      if (cur.stmt) { q = this.prepared.get(cur.stmt) || ''; params = m[2] ? await this.hostValues(this.hostVars(m[2]).vars, sc) : []; } else {
        const hv = this.hostVars(q);
        q = hv.sql;
        params = await this.hostValues(hv.vars, sc);
      }
      const r = await this.runQuery(q.replace(/\bFOR\s+(READ\s+ONLY|FETCH\s+ONLY|UPDATE(\s+OF\s+[\w,\s]+)?)\s*$/i, ''), params);
      if (!r) return;
      cur.rows = r.rows;
      cur.pos = 0;
      this.setSqlca(0, '00000');
      return;
    }
    if ((m = /^CLOSE\s+([\w#@$]+)$/i.exec(T))) {
      const cur = this.cursors.get(m[1].toUpperCase());
      if (cur) cur.rows = null;
      this.setSqlca(0, '00000');
      return;
    }
    if ((m = /^FETCH\s+(?:(NEXT|PRIOR|FIRST|LAST|BEFORE|AFTER|CURRENT|RELATIVE\s+-?\d+|ABSOLUTE\s+\d+)\s+)?(?:FROM\s+)?([\w#@$]+)\s+(?:FOR\s+\S+\s+ROWS\s+)?INTO\s+([\s\S]+)$/i.exec(T))) {
      const cur = this.cursors.get(m[2].toUpperCase());
      if (!cur || !cur.rows) { this.setSqlca(-501, '24501', `Cursor ${m[2]} not open.`); return; }
      const dir = (m[1] || 'NEXT').toUpperCase();
      if (dir === 'FIRST') cur.pos = 0;
      else if (dir === 'LAST') cur.pos = cur.rows.length - 1;
      else if (dir === 'PRIOR') cur.pos -= 2;
      else if (dir.startsWith('RELATIVE')) cur.pos += Number(dir.split(/\s+/)[1]) - 1;
      else if (dir.startsWith('ABSOLUTE')) cur.pos = Number(dir.split(/\s+/)[1]) - 1;
      else if (dir === 'CURRENT') cur.pos -= 1;
      const row = cur.rows[cur.pos];
      cur.pos++;
      if (!row || cur.pos < 1) { this.setSqlca(100, '02000', 'Row not found for FETCH.'); if (cur.pos < 0) cur.pos = 0; return; }
      const targets = this.hostVars(m[3]).vars;
      await this.assignRow(targets, row, sc);
      this.setSqlca(0, '00000', '', 1);
      return;
    }
    // SELECT … INTO :a, :b FROM …  /  VALUES expr INTO :x  /  SET :x = expr
    let intoTargets = null;
    let stmt = T;
    if ((m = /^SET\s+:\s*([\w#@$.]+)\s*=\s*([\s\S]+)$/i.exec(T))) {
      intoTargets = [m[1].toUpperCase()];
      stmt = `VALUES ${m[2]}`;
    } else if (/^(SELECT|VALUES|WITH)\b/i.test(T)) {
      const im = /\bINTO\s+(:\s*[\w#@$.]+(?:\s*(?:INDICATOR\s*)?:\s*[\w#@$]+)?(?:\s*,\s*:\s*[\w#@$.]+(?:\s*(?:INDICATOR\s*)?:\s*[\w#@$]+)?)*)/i.exec(T);
      if (im) {
        intoTargets = this.hostVars(im[1]).vars;
        stmt = T.slice(0, im.index) + T.slice(im.index + im[0].length);
      }
    }
    const hv = this.hostVars(stmt);
    const params = await this.hostValues(hv.vars, sc);
    const r = await this.runQuery(hv.sql, params);
    if (!r) return;
    if (intoTargets) {
      if (!r.rows.length) { this.setSqlca(100, '02000', 'Row not found.'); return; }
      await this.assignRow(intoTargets, r.rows[0], sc);
      if (r.rows.length > 1) { this.setSqlca(-811, '21000', 'The result of a scalar fullselect, SELECT INTO statement, or VALUES INTO statement is more than one row.'); return; }
      this.setSqlca(0, '00000', '', 1);
      return;
    }
    if (!r.columns.length && r.rowCount === 0 && /^(UPDATE|DELETE)\b/i.test(T)) { this.setSqlca(100, '02000', 'Row not found.'); return; }
    this.setSqlca(0, '00000', '', r.rowCount);
  }
}

// ---------- Utilidades ----------
function indKey(v) {
  const m = /^\*IN(\d\d|LR|RT|H\d|U\d|K[A-Y])$/.exec(v);
  return m ? m[1] : null;
}

function fieldChars(t, x) {
  const len = charLen(t);
  if (isNumType(t)) {
    const n = Math.round(Math.abs(toNumber(x)) * 10 ** (t.dec || 0));
    return String(n).padStart(len, '0').slice(-len);
  }
  return toStr(x).padEnd(len).slice(0, len);
}

export function cmp(a, b) {
  if (isFig(a) || isFig(b)) {
    const f = isFig(a) ? a : b;
    const o = isFig(a) ? b : a;
    let fv;
    if (typeof o === 'number') fv = toNumber(f);
    else if (f.fig === '*HIVAL') { const r = /^￿*$/.test(String(o)) ? 0 : -1; return isFig(a) ? -r : r; }
    else if (f.fig === '*LOVAL') { const r = /^\u0000*$/.test(String(o)) ? 0 : 1; return isFig(a) ? -r : r; }
    else fv = f.fig === '*ZEROS' || f.fig === '*ZERO' ? '0'.repeat(String(o).length) : f.fig === '*NULL' ? null : '';
    return isFig(a) ? cmp(fv, b) : cmp(a, fv);
  }
  if (a && typeof a === 'object' && 'all' in a) a = a.all.repeat(Math.ceil(String(b).length / a.all.length)).slice(0, String(b).length);
  if (b && typeof b === 'object' && 'all' in b) b = b.all.repeat(Math.ceil(String(a).length / b.all.length)).slice(0, String(a).length);
  if (typeof a === 'boolean') a = a ? '1' : '0';
  if (typeof b === 'boolean') b = b ? '1' : '0';
  if (typeof a === 'number' || typeof b === 'number') {
    const x = toNumber(a), y = toNumber(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  let x = toStr(a), y = toStr(b);
  if (x.length < y.length) x = x.padEnd(y.length); else if (y.length < x.length) y = y.padEnd(x.length);
  return x === y ? 0 : x < y ? -1 : 1;
}

export function arith(op, l, r) {
  if (op === '+' && isDur(r)) return addDuration(toStr(l), r, 1);
  if (op === '-' && isDur(r)) return addDuration(toStr(l), r, -1);
  if (op === '+' && (typeof l === 'string' || typeof r === 'string') && !(typeof l === 'number' || typeof r === 'number')) {
    return toStr(l) + toStr(r);
  }
  const x = toNumber(l), y = toNumber(r);
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': if (y === 0) throw new RpgError('00102', 'RNX0102', 'Attempt to divide by zero.'); return x / y;
    case '**': return x ** y;
    default: throw new RpgError('00202', 'RNX9999', `Operator ${op} not supported.`);
  }
}
