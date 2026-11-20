// Emulación de acceso a nivel de registro (READ/CHAIN/SETLL…) sobre SQL.
// Los archivos con clave se recorren por valores de clave; los que no tienen clave, por orden de llegada.
import { RpgError } from './types.js';

const q = (c) => `"${c}"`;
const norm = (v) => (typeof v === 'string' ? v.replace(/\s+$/, '') : v);

export class DiskFile {
  constructor({ name, schema, table, fields, keys, sql }) {
    this.name = name;
    this.schema = schema;
    this.table = table;
    this.full = `${schema}.${table}`;
    this.fields = fields; // [{name, type}]
    this.keys = keys || [];
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

  async query(text, params) {
    const r = await this.sql(text, params.map(norm));
    if (r.error) {
      const e = new RpgError(r.sqlstate === '23505' ? '01021' : '01299', r.sqlstate === '23505' ? 'RNX1021' : 'RNX1299',
        r.sqlstate === '23505' ? `Attempt to write a duplicate record to file ${this.name}.` : `I/O error on file ${this.name}: ${r.error}`);
      e.sqlstate = r.sqlstate;
      throw e;
    }
    return (r.rows || []).map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name.toUpperCase(), row[i]])));
  }

  keyOf(rec) { return this.keys.map((k) => rec[k]); }

  cond(op, key) {
    if (!key || !key.length) return { sql: '1=1', params: [] };
    const ks = this.keys.slice(0, key.length);
    if (op === '=') return { sql: ks.map((k) => `${q(k)} = ?`).join(' AND '), params: key };
    const strict = op === '>' || op === '<';
    const base = op[0];
    const parts = [];
    const params = [];
    for (let i = 0; i < ks.length; i++) {
      const eqs = ks.slice(0, i).map((k) => `${q(k)} = ?`);
      const last = i === ks.length - 1 && !strict ? `${base}=` : base;
      parts.push(`(${[...eqs, `${q(ks[i])} ${last} ?`].join(' AND ')})`);
      params.push(...key.slice(0, i), key[i]);
    }
    return { sql: `(${parts.join(' OR ')})`, params };
  }

  orderBy(desc) {
    if (!this.keys.length) return '';
    return ' ORDER BY ' + this.keys.map((k) => `${q(k)}${desc ? ' DESC' : ''}`).join(', ');
  }

  requireKeys(op) {
    if (!this.keys.length) throw new RpgError('01299', 'RNX1299', `${op} requires a keyed file; ${this.name} has no key fields.`);
  }

  setPositionAfter(rec) {
    this.cur = rec;
    if (this.keys.length) {
      const k = this.keyOf(rec);
      this.lower = { op: '>', key: k };
      this.upper = { op: '<', key: k };
    }
  }

  async setll(key) {
    this.buf = [];
    if (key === '*START' || key === '*LOVAL') { this.lower = { all: true }; this.upper = { none: true }; this.idx = -1; this.snapshot = null; return false; }
    if (key === '*END' || key === '*HIVAL') { this.lower = { none: true }; this.upper = { all: true }; this.idx = Infinity; return false; }
    this.requireKeys('SETLL');
    this.lower = { op: '>=', key };
    this.upper = { op: '<', key };
    const c = this.cond('=', key);
    const r = await this.query(`SELECT 1 AS X FROM ${this.full} WHERE ${c.sql} FETCH FIRST 1 ROWS ONLY`, c.params);
    return r.length > 0;
  }

  async setgt(key) {
    this.buf = [];
    if (key === '*END' || key === '*HIVAL') { this.lower = { none: true }; this.upper = { all: true }; this.idx = Infinity; return; }
    if (key === '*START' || key === '*LOVAL') { this.lower = { all: true }; this.upper = { none: true }; this.idx = -1; return; }
    this.requireKeys('SETGT');
    this.lower = { op: '>', key };
    this.upper = { op: '<=', key };
  }

  async loadSnapshot() {
    this.snapshot = await this.query(`SELECT * FROM ${this.full}`, []);
  }

  async read() {
    if (!this.keys.length) {
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
      const c = this.lower.all ? { sql: '1=1', params: [] } : this.cond(this.lower.op, this.lower.key);
      this.buf = await this.query(`SELECT * FROM ${this.full} WHERE ${c.sql}${this.orderBy(false)} FETCH FIRST 64 ROWS ONLY`, c.params);
      if (!this.buf.length) return null;
    }
    const r = this.buf.shift();
    this.setPositionAfter(r);
    return r;
  }

  async readp() {
    this.buf = [];
    if (!this.keys.length) {
      if (!this.snapshot) await this.loadSnapshot();
      if (this.idx === Infinity) this.idx = this.snapshot.length;
      this.idx--;
      if (this.idx < 0) { this.idx = -1; return null; }
      this.cur = this.snapshot[this.idx];
      return this.cur;
    }
    if (this.upper.none) return null;
    const c = this.upper.all ? { sql: '1=1', params: [] } : this.cond(this.upper.op, this.upper.key);
    const r = await this.query(`SELECT * FROM ${this.full} WHERE ${c.sql}${this.orderBy(true)} FETCH FIRST 1 ROWS ONLY`, c.params);
    if (!r.length) return null;
    this.setPositionAfter(r[0]);
    return r[0];
  }

  async reade(key) {
    this.requireKeys('READE');
    this.buf = [];
    const eq = this.cond('=', key);
    const lo = this.lower.all ? { sql: '1=1', params: [] } : this.lower.none ? null : this.cond(this.lower.op, this.lower.key);
    if (!lo) return null;
    const r = await this.query(`SELECT * FROM ${this.full} WHERE ${eq.sql} AND ${lo.sql}${this.orderBy(false)} FETCH FIRST 1 ROWS ONLY`, [...eq.params, ...lo.params]);
    if (!r.length) return null;
    this.setPositionAfter(r[0]);
    return r[0];
  }

  async readpe(key) {
    this.requireKeys('READPE');
    this.buf = [];
    const eq = this.cond('=', key);
    const up = this.upper.all ? { sql: '1=1', params: [] } : this.upper.none ? null : this.cond(this.upper.op, this.upper.key);
    if (!up) return null;
    const r = await this.query(`SELECT * FROM ${this.full} WHERE ${eq.sql} AND ${up.sql}${this.orderBy(true)} FETCH FIRST 1 ROWS ONLY`, [...eq.params, ...up.params]);
    if (!r.length) return null;
    this.setPositionAfter(r[0]);
    return r[0];
  }

  async chain(key) {
    this.requireKeys('CHAIN');
    this.buf = [];
    const c = this.cond('=', key);
    const r = await this.query(`SELECT * FROM ${this.full} WHERE ${c.sql}${this.orderBy(false)} FETCH FIRST 1 ROWS ONLY`, c.params);
    if (!r.length) return null;
    this.setPositionAfter(r[0]);
    return r[0];
  }

  whereCurrent() {
    if (this.keys.length) return this.cond('=', this.keyOf(this.cur));
    const cols = this.fields.map((f) => f.name);
    return {
      sql: cols.map((c) => (this.cur[c] === null ? `${q(c)} IS NULL` : `${q(c)} = ?`)).join(' AND '),
      params: cols.filter((c) => this.cur[c] !== null).map((c) => this.cur[c]),
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
    await this.query(`UPDATE ${this.full} SET ${cols.map((c) => `${q(c)} = ?`).join(', ')} WHERE ${w.sql}`, [...cols.map((c) => rec[c]), ...w.params]);
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
    await this.query(`DELETE FROM ${this.full} WHERE ${w.sql}`, w.params);
    this.buf = [];
    if (this.snapshot) { this.snapshot.splice(this.idx, 1); this.idx--; }
    this.cur = null;
    return true;
  }

  close() { this.isOpen = false; }
}
