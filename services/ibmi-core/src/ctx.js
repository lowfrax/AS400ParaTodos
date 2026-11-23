// Contexto de ejecución de un trabajo (interactivo o por lotes) y resolución SQL por *LIBL.
import { gw, SYSTEM_LIBS } from './objects.js';
import { CLError } from './messages.js';
import { jobEndHooks } from './system.js';
import { qtempName, ensureQtemp, physicalSql } from './qtemp.js';

export class Ctx {
  constructor({ session = null, job, user, interactive = !!session }) {
    this.session = session;
    this.job = job;
    this.user = user; // fila de QSYS.USRPRF
    this.interactive = interactive;
  }
  get userName() { return this.job.user; }
  get libl() {
    const out = [...SYSTEM_LIBS];
    if (this.job.curlib && !out.includes(this.job.curlib)) out.push(this.job.curlib);
    // QTEMP es la biblioteca temporal propia del trabajo (esquema QTnnnnnn)
    for (const l0 of this.job.libl) { const l = l0 === 'QTEMP' ? qtempName(this.job) : l0; if (!out.includes(l)) out.push(l); }
    return out;
  }
  get curlib() { return this.job.curlib || 'QGPL'; }
  resolveLib(lib) {
    if (!lib || lib === '*CURLIB') return this.curlib;
    if (String(lib).toUpperCase() === 'QTEMP') return qtempName(this.job);
    return lib;
  }
  async display(panel) {
    if (!this.session) throw new CLError('CPD0031', panel.fn || 'display');
    return this.session.display(panel);
  }
  get client() { return `${this.job.number}/${this.job.user}/${this.job.name}`; }
  async sql(text, params = [], opts = {}) {
    // El usuario del trabajo es el propietario de lo que se cree y el sujeto de las comprobaciones de autorización
    const { withCtx, currentCtx } = await import('./security.js');
    if (currentCtx() !== this) return withCtx(this, () => this.sql(text, params, opts));
    // Servicios SQL de IBM i (QSYS2.QCMDEXC, HTTP_GET, colas de datos, vistas de catálogo…) se resuelven en el núcleo.
    const { sqlServices } = await import('./sql/services.js');
    const handled = await sqlServices(this, String(text), params, opts);
    if (handled) return handled;
    if (/QTEMP/i.test(String(text))) { await ensureQtemp(this.job); text = physicalSql(this.job, text); }
    const q = opts.raw ? text : await qualifySql(text, this.libl, this.curlib);
    const denied = await this.sqlAuthority(q);
    if (denied) return denied;
    const notJournaled = await this.sqlJournalCheck(q);
    if (notJournaled) return notJournaled;
    await this.ensureCommit();
    const r = await gw.sql(q, params, { client: this.client, tx: this.job.cmt?.tx });
    // DROP TABLE/VIEW por SQL elimina también el objeto *FILE (la creación la recoge findObject)
    const drop = !r.error && /^\s*DROP\s+(?:TABLE|VIEW)\s+"?(\w+)"?\s*\.\s*"?(\w+)"?/i.exec(q);
    if (drop) {
      const { forgetSqlObject } = await import('./objects.js');
      await forgetSqlObject(drop[1].toUpperCase(), drop[2].toUpperCase());
    }
    if (!r.error) await this.sqlDdlHooks(q);
    if (r.error && this.job.qtemp) r.error = String(r.error).split(qtempName(this.job)).join('QTEMP');
    return r;
  }

  /** Bajo control de compromiso, cambiar una tabla que no está en un diario da SQL7008 (código de razón 3). */
  async sqlJournalCheck(q) {
    if (!this.job.cmt || ['*NONE', '*NC'].includes(this.job.cmt.level)) return null;
    const sec = await import('./security.js');
    const J = await import('./journal.js');
    for (const t of sec.sqlTargets(q)) {
      if (!['ADD', 'UPD', 'DLT', 'CHANGE'].includes(t.need) || SYSTEM_LIBS.includes(t.lib) || t.lib === qtempName(this.job)) continue;
      if (!(await sec.objectRow(t.lib, t.name, '*FILE'))) continue;
      if (!(await J.journalOf(t.lib, t.name))) {
        return { error: `SQL7008N  ${t.name} in ${t.lib} not valid for operation. Reason code 3: the table is not journaled and commitment control is active (${this.job.cmt.level}).  SQLSTATE=55019`, sqlstate: '55019', sqlcode: -7008, columns: [], rows: [] };
      }
    }
    return null;
  }

  /** CREATE SCHEMA crea la biblioteca con su diario QSQJRN; CREATE TABLE en ella queda registrada en el diario. */
  async sqlDdlHooks(q) {
    let m = /^\s*CREATE\s+(?:SCHEMA|COLLECTION)\s+"?([A-Z#@$][\w#@$]*)"?/i.exec(q);
    if (m) {
      const lib = m[1].toUpperCase();
      const obj = await import('./objects.js');
      if (!(await obj.libExists(lib))) await gw.exec("INSERT INTO QSYS.OBJECTS (LIB, NAME, TYPE, ATTR, TEXT, OWNER, CREATED, CHANGED) VALUES ('QSYS', ?, '*LIB', 'PROD', 'SQL schema', ?, CURRENT TIMESTAMP, CURRENT TIMESTAMP)", [lib, this.job.user]);
      await (await import('./journal.js')).ensureSqlJournal(this.job, lib, { journalExisting: false });
      return;
    }
    m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+"?([A-Z#@$][\w#@$]*)"?\s*\.\s*"?([A-Z#@$][\w#@$]*)"?/i.exec(q);
    if (m) {
      const [lib, file] = [m[1].toUpperCase(), m[2].toUpperCase()];
      const obj = await import('./objects.js');
      await obj.findObject(gw, file, '*FILE', lib, []);
      await (await import('./journal.js')).autoJournal(this.job, lib, file);
    }
  }

  /** Autorización de objeto sobre las tablas de una sentencia (SQL0551 / SQLSTATE 42501). */
  async sqlAuthority(q) {
    const sec = await import('./security.js');
    if (!this.user || sec.hasSpecial(this.user, '*ALLOBJ')) return null;
    for (const t of sec.sqlTargets(q)) {
      if (SYSTEM_LIBS.includes(t.lib)) continue;
      const row = await sec.objectRow(t.lib, t.name, '*FILE');
      if (!row) continue;
      try { await sec.checkAuthority(this, row, t.need); } catch (e) {
        const lib = String(t.lib).split(`QT${this.job.number}`).join('QTEMP');
        return { error: `SQL0551N  Not authorized to object ${t.name} in ${lib} type *FILE.  SQLSTATE=42501`, sqlstate: '42501', sqlcode: -551, columns: [], rows: [] };
      }
    }
    return null;
  }

  // ---------- Control de compromiso (STRCMTCTL / COMMIT / ROLLBACK) ----------
  get commitLevel() { return this.job.cmt?.level || '*NONE'; }
  async startCommit(level = '*CHG') {
    if (this.job.cmt) throw new CLError('CPF8351', this.job.cmt.level);
    if (level === '*NONE') return;
    this.job.cmt = { level, tx: null, pending: 0, startedAt: Date.now() };
  }
  async ensureCommit() {
    const c = this.job.cmt;
    if (!c || c.tx) return;
    c.tx = await gw.begin({ client: this.client, isolation: c.level });
  }
  async commit({ hold = false } = {}) {
    const c = this.job.cmt;
    if (!c || !c.tx) return { ok: true };
    await (await import('./journal.js')).commitEntries(this.job, c.tx).catch(() => {});
    const r = await gw.commit(c.tx, { client: this.client });
    c.tx = null;
    return r;
  }
  async rollback() {
    const c = this.job.cmt;
    if (!c || !c.tx) return { ok: true };
    const J = await import('./journal.js');
    const tx = c.tx;
    const pending = await J.pendingEntries(tx);
    const r = await gw.rollback(tx, { client: this.client });
    c.tx = null;
    await J.rollbackEntries(this.job, tx, pending).catch(() => {});
    return r;
  }
  async endCommit({ commit = false } = {}) {
    if (!this.job.cmt) throw new CLError('CPF8356');
    if (commit) await this.commit(); else await this.rollback();
    this.job.cmt = null;
  }
}

// Al terminar el trabajo con cambios pendientes: confirmación si termina con normalidad, retrotracción si no.
export async function endJobCommit(job, normal = true) {
  const c = job.cmt;
  if (!c || !c.tx) { job.cmt = null; return; }
  job.cmt = null;
  const client = `${job.number}/${job.user}/${job.name}`;
  await (normal ? gw.commit(c.tx, { client }) : gw.rollback(c.tx, { client })).catch(() => {});
}

const tableCache = new Map();
async function tablesOf(lib) {
  const c = tableCache.get(lib);
  if (c && Date.now() - c.at < 3000) return c.set;
  const t = await gw.tables(lib).catch(() => []);
  const set = new Set((Array.isArray(t) ? t : []).map((x) => x.name));
  tableCache.set(lib, { at: Date.now(), set });
  return set;
}
export function invalidateTables(lib) { if (lib) tableCache.delete(lib); else tableCache.clear(); }

// Califica nombres de tabla sin biblioteca buscando en la lista de bibliotecas (nomenclatura *SYS).
export async function qualifySql(sql, libl, curlib) {
  const text = String(sql);
  const masked = text.replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));
  const ctes = new Set([...masked.matchAll(/\b([A-Za-z_#@$][\w#@$]*)\s+AS\s*\(/gi)].map((m) => m[1].toUpperCase()));
  const isCreate = /^\s*CREATE\s+(OR\s+REPLACE\s+)?(TABLE|VIEW|INDEX|ALIAS)/i.test(masked);
  const refs = [];
  const re = /\b(FROM|JOIN|INTO|UPDATE|TABLE|VIEW|ON\s+TABLE)\s+([A-Za-z_#@$][\w#@$]*)(?![\w#@$]*\s*[.(])/gi;
  let m;
  while ((m = re.exec(masked))) {
    refs.push({ idx: m.index + m[0].length - m[2].length, name: m[2], kw: m[1].toUpperCase() });
    if (m[1].toUpperCase() === 'FROM') {
      // lista separada por comas: FROM a x, b y
      const rest = masked.slice(re.lastIndex);
      const seg = rest.split(/\b(WHERE|GROUP|ORDER|FETCH|UNION|HAVING|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|LIMIT|EXCEPT|INTERSECT|FOR)\b|\)/i)[0];
      const cm = /,\s*([A-Za-z_#@$][\w#@$]*)(?!\s*[.(])/g;
      let k;
      while ((k = cm.exec(seg))) refs.push({ idx: re.lastIndex + k.index + k[0].length - k[1].length, name: k[1], kw: 'FROM' });
    }
  }
  if (!refs.length) return text;
  const KEYWORDS = new Set(['SELECT', 'TABLE', 'LATERAL', 'FINAL', 'NEW', 'OLD', 'VALUES', 'SYSIBM', 'SYSDUMMY1']);
  const repl = [];
  for (const r of refs) {
    const N = r.name.toUpperCase();
    if (ctes.has(N) || KEYWORDS.has(N)) continue;
    let lib = null;
    for (const l of libl) { if ((await tablesOf(l)).has(N)) { lib = l; break; } }
    if (!lib && isCreate && (r.kw === 'TABLE' || r.kw === 'VIEW')) lib = curlib;
    if (lib) repl.push({ idx: r.idx, len: r.name.length, val: `${lib}.${N}` });
  }
  repl.sort((a, b) => b.idx - a.idx);
  let out = text;
  for (const x of repl) out = out.slice(0, x.idx) + x.val + out.slice(x.idx + x.len);
  if (isCreate || /^\s*(DROP|ALTER)\b/i.test(masked)) invalidateTables();
  return out;
}

jobEndHooks.push((job, code) => { if (job.cmt) endJobCommit(job, code === 0); });
