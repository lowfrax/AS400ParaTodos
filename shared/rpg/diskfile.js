// Emulación de acceso a nivel de registro (READ/CHAIN/SETLL…) sobre SQL.
// La posición del archivo es la tupla (claves…, RRN): el RRN es el identificador de fila de Db2 (RID), así que
// los archivos sin clave se leen en orden de llegada y las claves duplicadas se recorren una a una, como en IBM i.
// Los lógicos (vistas) exponen el RID de su físico en la columna "$RRN". Las claves pueden ser descendentes (DESCEND).
import { RpgError } from './types.js';

const q = (c) => `"${c}"`;
const norm = (v) => (typeof v === 'string' ? v.replace(/\s+$/, '') : v);
const LOB = /LOB|XML|BLOB|DBCLOB/i;

export class DiskFile {
  /**
   * rrn: 'rid' (tabla: RID(T)), 'col' (vista con columna "$RRN") o null (sin identificador de fila: vistas de unión).
   */
  constructor({ name, schema, table, fields, keys, keyDesc, rrn = 'rid', sql }) {
    this.name = name;
    this.schema = schema;
    this.table = table;
    this.full = `${schema}.${table}`;
    this.fields = (fields || []).filter((f) => f.name !== '$RRN'); // [{name, type}]
    this.keys = keys || [];
    this.keyDesc = this.keys.map((_, i) => !!(keyDesc && keyDesc[i]));
    this.rrnMode = rrn;
    this.sql = sql;
    this.isOpen = true;
    this.reset();
  }

  reset() {
    this.lower = { all: true };
    this.upper = { none: true };
    this.buf = [];
    this.snapshot = null;
    this.idx = -1;
    this.cur = null;
  }

  get rrnExpr() { return this.rrnMode === 'rid' ? 'RID(T)' : this.rrnMode === 'col' ? 'T."$RRN"' : null; }

  async query(text, params) {
    const r = await this.sql(text, params.map(norm));
    if (r.error) {
      // Sin RID posible (p. ej. una vista creada con SQL): se continúa sin identificador de fila
      if (this.rrnMode && /RID|\$RRN/i.test(text) && /^42/.test(r.sqlstate || '')) {
        this.rrnMode = null;
        throw Object.assign(new Error('retry'), { retry: true });
      }
      const e = new RpgError(r.sqlstate === '23505' ? '01021' : '01299', r.sqlstate === '23505' ? 'RNX1021' : 'RNX1299',
        r.sqlstate === '23505' ? `Attempt to write a duplicate record to file ${this.name}.` : `I/O error on file ${this.name}: ${r.error}`);
      e.sqlstate = r.sqlstate;
      throw e;
    }
    return (r.rows || []).map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name.toUpperCase(), row[i]])));
  }

  // Ejecuta una operación construida con el modo de RRN vigente; si el RID no está disponible, se reintenta sin él.
  async run(build) {
    try { return await this.query(...build()); } catch (e) {
      if (e.retry) return this.query(...build());
      throw e;
    }
  }

  select(where, order, n) {
    const rid = this.rrnExpr;
    return `SELECT ${rid ? `${rid} AS "$RID", ` : ''}T.* FROM ${this.full} T WHERE ${where}${order}${n ? ` FETCH FIRST ${n} ROWS ONLY` : ''}`;
  }

  keyOf(rec) { return this.keys.map((k) => rec[k]); }

  // Componentes de posición: claves (prefijo) y, si se pide, el RRN
  comps(n, withRrn) {
    const out = this.keys.slice(0, n).map((k, i) => ({ expr: `T.${q(k)}`, desc: this.keyDesc[i] }));
    if (withRrn && this.rrnExpr) out.push({ expr: this.rrnExpr, desc: false });
    return out;
  }

  /** Condición de comparación lexicográfica de la posición frente a `key` (op: = > >= < <=). */
  cond(op, key, withRrn = false) {
    const vals = withRrn && this.rrnExpr ? [...key.k, key.rrn] : (key && key.k) || key || [];
    if (!vals.length) return { sql: '1=1', params: [] };
    const cs = this.comps(withRrn && this.rrnExpr ? key.k.length : vals.length, withRrn);
    if (op === '=') return { sql: cs.map((c) => `${c.expr} = ?`).join(' AND '), params: vals };
    const strict = op === '>' || op === '<';
    const parts = [];
    const params = [];
    for (let i = 0; i < cs.length; i++) {
      const eqs = cs.slice(0, i).map((c) => `${c.expr} = ?`);
      // dirección según la clave: en una clave descendente "después" es "menor"
      let base = op[0];
      if (cs[i].desc) base = base === '>' ? '<' : '>';
      const last = i === cs.length - 1 && !strict ? `${base}=` : base;
      parts.push(`(${[...eqs, `${cs[i].expr} ${last} ?`].join(' AND ')})`);
      params.push(...vals.slice(0, i), vals[i]);
    }
    return { sql: `(${parts.join(' OR ')})`, params };
  }

  orderBy(back) {
    const cs = this.comps(this.keys.length, true);
    if (!cs.length) return '';
    return ' ORDER BY ' + cs.map((c) => `${c.expr}${(c.desc !== back) ? ' DESC' : ''}`).join(', ');
  }

  requireKeys(op) {
    if (!this.keys.length) throw new RpgError('01299', 'RNX1299', `${op} requires a keyed file; ${this.name} has no key fields.`);
  }

  posOf(rec) { return { k: this.keyOf(rec), rrn: rec.$RID }; }

  setPositionAfter(rec) {
    this.cur = rec;
    if (this.keys.length || this.rrnExpr) {
      const p = this.posOf(rec);
      this.lower = { op: '>', key: p, full: true };
      this.upper = { op: '<', key: p, full: true };
    }
  }

  boundCond(b) {
    if (b.all) return { sql: '1=1', params: [] };
    return this.cond(b.op, b.key, !!b.full);
  }

  async setll(key) {
    this.buf = [];
    if (key === '*START' || key === '*LOVAL') { this.lower = { all: true }; this.upper = { none: true }; this.idx = -1; this.snapshot = null; return false; }
    if (key === '*END' || key === '*HIVAL') { this.lower = { none: true }; this.upper = { all: true }; this.idx = Infinity; return false; }
    if (!this.keys.length && typeof key === 'number' && this.rrnExpr) {
      // SETLL por número relativo de registro en un archivo sin clave
      const rows = await this.run(() => [this.select('1=1', this.orderBy(false)), []]);
      const r = rows[key - 1];
      if (!r) { this.lower = { none: true }; this.upper = { all: true }; return false; }
      this.lower = { op: '>=', key: { k: [], rrn: r.$RID }, full: true };
      this.upper = { op: '<', key: { k: [], rrn: r.$RID }, full: true };
      return true;
    }
    this.requireKeys('SETLL');
    this.lower = { op: '>=', key: { k: key } };
    this.upper = { op: '<', key: { k: key } };
    const c = this.cond('=', { k: key });
    const r = await this.run(() => [`SELECT 1 AS X FROM ${this.full} T WHERE ${c.sql} FETCH FIRST 1 ROWS ONLY`, c.params]);
    return r.length > 0;
  }

  async setgt(key) {
    this.buf = [];
    if (key === '*END' || key === '*HIVAL') { this.lower = { none: true }; this.upper = { all: true }; this.idx = Infinity; return; }
    if (key === '*START' || key === '*LOVAL') { this.lower = { all: true }; this.upper = { none: true }; this.idx = -1; return; }
    this.requireKeys('SETGT');
    this.lower = { op: '>', key: { k: key } };
    this.upper = { op: '<=', key: { k: key } };
  }

  async loadSnapshot() {
    this.snapshot = await this.run(() => [this.select('1=1', '', 0), []]);
  }

  async read() {
    if (!this.keys.length && !this.rrnExpr) {
      // Sin clave ni RRN: instantánea en memoria (vistas de unión)
      if (!this.snapshot) await this.loadSnapshot();
      if (this.idx === Infinity) return null;
      this.idx++;
      const r = this.snapshot[this.idx] || null;
      if (!r) this.idx = this.snapshot.length;
      if (r) this.cur = r;
      return r;
    }
    if (!this.buf.length) {
      if (this.lower.none) return null;
      this.buf = await this.run(() => { const c = this.boundCond(this.lower); return [this.select(c.sql, this.orderBy(false), 64), c.params]; });
      if (!this.buf.length) return null;
    }
    const r = this.buf.shift();
    this.setPositionAfter(r);
    return r;
  }

  async readp() {
    this.buf = [];
    if (!this.keys.length && !this.rrnExpr) {
      if (!this.snapshot) await this.loadSnapshot();
      if (this.idx === Infinity) this.idx = this.snapshot.length;
      this.idx--;
      if (this.idx < 0) { this.idx = -1; return null; }
      this.cur = this.snapshot[this.idx];
      return this.cur;
    }
    if (this.upper.none) return null;
    const r = await this.run(() => { const c = this.boundCond(this.upper); return [this.select(c.sql, this.orderBy(true), 1), c.params]; });
    if (!r.length) return null;
    this.setPositionAfter(r[0]);
    return r[0];
  }

  async reade(key) {
    this.requireKeys('READE');
    this.buf = [];
    if (this.lower.none) return null;
    const r = await this.run(() => {
      const eq = this.cond('=', { k: key });
      const lo = this.boundCond(this.lower);
      return [this.select(`${eq.sql} AND ${lo.sql}`, this.orderBy(false), 1), [...eq.params, ...lo.params]];
    });
    if (!r.length) return null;
    this.setPositionAfter(r[0]);
    return r[0];
  }

  async readpe(key) {
    this.requireKeys('READPE');
    this.buf = [];
    if (this.upper.none) return null;
    const r = await this.run(() => {
      const eq = this.cond('=', { k: key });
      const up = this.boundCond(this.upper);
      return [this.select(`${eq.sql} AND ${up.sql}`, this.orderBy(true), 1), [...eq.params, ...up.params]];
    });
    if (!r.length) return null;
    this.setPositionAfter(r[0]);
    return r[0];
  }

  async chain(key) {
    this.buf = [];
    if (!this.keys.length && typeof key === 'number') {
      // CHAIN por número relativo de registro
      const rows = await this.run(() => [this.select('1=1', this.orderBy(false), key), []]);
      const r = rows[key - 1];
      if (!r) return null;
      this.setPositionAfter(r);
      return r;
    }
    this.requireKeys('CHAIN');
    const r = await this.run(() => { const c = this.cond('=', { k: key }); return [this.select(c.sql, this.orderBy(false), 1), c.params]; });
    if (!r.length) return null;
    this.setPositionAfter(r[0]);
    return r[0];
  }

  // Fila actual: por RRN (exactamente una) o, sin RRN, por todos sus valores (una sola fila con FETCH FIRST)
  whereCurrent() {
    if (this.rrnExpr && this.cur.$RID !== undefined && this.cur.$RID !== null) return { sql: `${this.rrnExpr} = ?`, params: [this.cur.$RID], one: false };
    const cols = this.fields.filter((f) => !LOB.test(f.sqlType || '')).map((f) => f.name);
    return {
      sql: cols.map((c) => (this.cur[c] === null || this.cur[c] === undefined ? `T.${q(c)} IS NULL` : `T.${q(c)} = ?`)).join(' AND ') || '1=1',
      params: cols.filter((c) => this.cur[c] !== null && this.cur[c] !== undefined).map((c) => this.cur[c]),
      one: true,
    };
  }

  async write(rec) {
    this.buf = [];
    this.snapshot = null;
    const cols = this.fields.map((f) => f.name);
    await this.query(`INSERT INTO ${this.full} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => rec[c]));
  }

  async update(rec, only) {
    if (!this.cur) throw new RpgError('01221', 'RNX1221', `Update or delete operation attempted without a prior input operation for file ${this.name}.`);
    const cols = this.fields.map((f) => f.name).filter((c) => !only || only.includes(c));
    const w = this.whereCurrent();
    const target = `(SELECT * FROM ${this.full} T WHERE ${w.sql} FETCH FIRST 1 ROWS ONLY)`;
    await this.query(`UPDATE ${target} SET ${cols.map((c) => `${q(c)} = ?`).join(', ')}`, [...w.params, ...cols.map((c) => rec[c])]);
    this.buf = [];
    if (this.snapshot) this.snapshot[this.idx] = { ...this.cur, ...Object.fromEntries(cols.map((c) => [c, rec[c]])) };
    this.cur = { ...this.cur, ...Object.fromEntries(cols.map((c) => [c, rec[c]])) };
  }

  async delete(key) {
    if (key) {
      const r = await this.chain(key);
      if (!r) return false;
    }
    if (!this.cur) throw new RpgError('01221', 'RNX1221', `Update or delete operation attempted without a prior input operation for file ${this.name}.`);
    const w = this.whereCurrent();
    await this.query(`DELETE FROM (SELECT * FROM ${this.full} T WHERE ${w.sql} FETCH FIRST 1 ROWS ONLY)`, w.params);
    this.buf = [];
    if (this.snapshot) { this.snapshot.splice(this.idx, 1); this.idx--; }
    this.cur = null;
    return true;
  }

  close() { this.isOpen = false; }
}
