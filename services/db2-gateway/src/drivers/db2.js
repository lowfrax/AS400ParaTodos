// Driver para IBM Db2 (contenedor icr.io/db2_community/db2) usando el paquete ibm_db.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SYSTEM_SCHEMAS = new Set([
  'NULLID', 'SQLJ', 'SYSCAT', 'SYSFUN', 'SYSIBM', 'SYSIBMADM', 'SYSIBMINTERNAL',
  'SYSIBMTS', 'SYSPROC', 'SYSPUBLIC', 'SYSSTAT', 'SYSTOOLS',
]);

const NUMERIC_TYPES = new Set(['DECIMAL', 'NUMERIC', 'BIGINT', 'DECFLOAT', 'INTEGER', 'SMALLINT', 'DOUBLE', 'REAL', 'FLOAT']);

export function createDb2Driver(cfg) {
  const ibmdb = require('ibm_db');
  const connStr =
    `DATABASE=${cfg.database};HOSTNAME=${cfg.host};PORT=${cfg.port};PROTOCOL=TCPIP;` +
    `UID=${cfg.user};PWD=${cfg.password};`;
  const pool = new ibmdb.Pool({ maxPoolSize: cfg.poolSize || 10 });
  let opened = 0;

  // Errores que indican que la conexión (o el gestor de base de datos) cayó, no que la sentencia sea incorrecta:
  // SQL30081N/SQL30108N (comunicación), SQL1224N (Db2 detenido/reiniciado), SQL1035N (BD en uso exclusivo, p. ej. backup),
  // SQL1032N (DB2START pendiente), SQL1776N (HADR), SQL1013N/SQL1031N (BD aún no catalogada/creada).
  const CONN_CODES = new Set([-30081, -30108, -1224, -1035, -1032, -1776, -1013, -1031, -900]);
  function isConnError(e) {
    const st = String(e?.sqlstate || '');
    return CONN_CODES.has(Number(e?.sqlcode)) || st.startsWith('08') || st === '55032' || st === '57019' || st === '40003';
  }

  async function withConn(fn) {
    let conn;
    try {
      conn = await pool.open(connStr);
    } catch (e) {
      throw normalizeError(e);
    }
    let broken = false;
    try {
      return await fn(conn);
    } catch (e) {
      broken = isConnError(e);
      throw e;
    } finally {
      // Una conexión rota no vuelve al pool: se cierra de verdad para que la siguiente petición abra otra.
      try { await (broken && conn.realClose ? conn.realClose() : conn.close()); } catch { /* ignorar */ }
    }
  }

  // Reintenta las sentencias que fallan por caída de la conexión (Db2 se reinicia durante su configuración inicial,
  // o el contenedor se reinicia). Db2 revierte la unidad de trabajo interrumpida, así que repetirla es seguro.
  async function withRetry(fn, { attempts = 15, delay = 3000 } = {}) {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!isConnError(e) || i >= attempts) throw e;
        if (i === 1) console.log(`[gateway] conexión con Db2 perdida (${e.message.slice(0, 80)}); reintentando…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  function normalizeError(e) {
    const msg = String(e?.message || e);
    const m = msg.match(/SQL(\d{4,5})([NWC])/);
    const sqlcode = e?.sqlcode ?? (m ? -Number(m[1]) : -1);
    // ibm_db expone en e.sqlstate el estado ODBC (42S01, 42S02, 23000…); el SQLSTATE de Db2 (42710, 42704, 23505…),
    // que es el que usan los programas y el sistema, va al final del texto del mensaje.
    const sqlstate = (msg.match(/SQLSTATE=(\w{5})/) || [])[1] || e?.sqlstate || e?.state || '58004';
    const clean = msg.replace(/^\[IBM\]\[CLI Driver\](\[[^\]]+\])?\s*/, '').trim();
    const err = new Error(clean);
    err.sqlcode = sqlcode;
    err.sqlstate = sqlstate;
    return err;
  }

  async function exec(sql, params = []) {
    return withRetry(() => execOnce(sql, params));
  }

  async function execOnce(sql, params = []) {
    return withConn((conn) => runOn(conn, sql, params));
  }

  // Ejecuta una sentencia sobre una conexión concreta (del pool o de una transacción).
  async function runOn(conn, sql, params = []) {
    let result;
    // Las cadenas largas (IR de programas, spool) se enlazan como CLOB: VARCHAR admite como máximo 32672 bytes.
    const bound = (params || []).map((p) => (typeof p === 'string' && Buffer.byteLength(p) > 32000 ? { ParamType: 'INPUT', DataType: 'CLOB', Data: p } : p));
    try {
      [result] = await conn.queryResult(sql, bound.length ? bound : null);
    } catch (e) {
      throw normalizeError(e);
    }
    if (!result) return { columns: [], rows: [], rowCount: 0 };
    try {
      const meta = result.getColumnMetadataSync() || [];
      let rows = [];
      let columns = [];
      if (Array.isArray(meta) && meta.length) {
        columns = meta.map((c) => ({
          name: c.SQL_DESC_NAME,
          type: String(c.SQL_DESC_TYPE_NAME || '').toUpperCase(),
          // ibm_db devuelve SQL_DESC_PRECISION = 0: para DECIMAL/NUMERIC la precisión es el tamaño de visualización - 2 (signo y punto)
          precision: c.SQL_DESC_PRECISION || (/^(DECIMAL|NUMERIC|DECFLOAT)$/i.test(String(c.SQL_DESC_TYPE_NAME)) ? Math.max(1, Number(c.SQL_DESC_DISPLAY_SIZE || 2) - 2) : Number(c.SQL_DESC_LENGTH || 0)),
          scale: c.SQL_DESC_SCALE,
          length: c.SQL_DESC_LENGTH,
          nullable: c.SQL_DESC_NULLABLE === undefined ? true : c.SQL_DESC_NULLABLE !== 0,
        }));
        rows = result.fetchAllSync({ fetchMode: 3 }) || [];
        if (!Array.isArray(rows)) throw normalizeError(rows);
        const numIdx = columns.map((c, i) => (NUMERIC_TYPES.has(c.type) ? i : -1)).filter((i) => i >= 0);
        for (const r of rows) {
          for (const i of numIdx) if (typeof r[i] === 'string') r[i] = Number(r[i]);
          for (let i = 0; i < r.length; i++) if (r[i] instanceof Date) r[i] = r[i].toISOString();
        }
      }
      let rowCount = rows.length;
      if (!columns.length) {
        try { rowCount = result.getAffectedRowsSync(); } catch { rowCount = 0; }
      }
      return { columns, rows, rowCount };
    } finally {
      try { result.closeSync(); } catch { /* ignorar */ }
    }
  }

  // ---- Transacciones (control de compromiso): una conexión dedicada con autocommit desactivado ----
  const txs = new Map(); // id -> {conn, client, startedAt, lastUsed, stmts, isolation}
  let txSeq = 0;
  const ISOLATION = { '*NONE': 'UR', '*CHG': 'UR', '*UR': 'UR', '*CS': 'CS', '*ALL': 'RS', '*RS': 'RS', '*RR': 'RR' };
  async function begin(client = '', isolation = '*CS') {
    let conn;
    try { conn = await ibmdb.open(connStr); } catch (e) { throw normalizeError(e); }
    try {
      conn.beginTransactionSync();
      const iso = ISOLATION[String(isolation).toUpperCase()] || 'CS';
      await runOn(conn, `SET CURRENT ISOLATION = ${iso}`).catch(() => {});
    } catch (e) {
      try { conn.closeSync(); } catch { /* ignorar */ }
      throw normalizeError(e);
    }
    const id = `T${++txSeq}${Date.now().toString(36)}`;
    txs.set(id, { conn, client, startedAt: Date.now(), lastUsed: Date.now(), stmts: 0, isolation });
    return id;
  }
  function getTx(id) {
    const t = txs.get(id);
    if (!t) throw Object.assign(new Error(`Transaction ${id} not found or already ended.`), { sqlstate: '25000', sqlcode: -918 });
    t.lastUsed = Date.now();
    return t;
  }
  async function txExec(id, sql, params) {
    const t = getTx(id);
    t.stmts++;
    try { return await runOn(t.conn, sql, params); } catch (e) {
      if (isConnError(e)) { txs.delete(id); try { t.conn.closeSync(); } catch { /* ignorar */ } }
      throw e;
    }
  }
  async function endTx(id, commit, keep = false) {
    const t = getTx(id);
    try {
      if (commit) t.conn.commitTransactionSync(); else t.conn.rollbackTransactionSync();
    } catch (e) {
      throw normalizeError(e);
    } finally {
      if (!keep) { txs.delete(id); try { t.conn.closeSync(); } catch { /* ignorar */ } } else t.stmts = 0;
    }
    return { ok: true, statements: t.stmts };
  }
  // Las transacciones abandonadas (cliente caído) se deshacen pasado TX_TIMEOUT, como hace IBM i al terminar el trabajo.
  setInterval(() => {
    const limit = Number(process.env.TX_TIMEOUT_MS || 15 * 60 * 1000);
    for (const [id, t] of txs) if (Date.now() - t.lastUsed > limit) endTx(id, false).catch(() => {});
  }, 30000).unref();

  async function rows(sql, params) {
    const r = await exec(sql, params);
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])));
  }

  return {
    name: 'db2',
    description: `IBM Db2 ${cfg.host}:${cfg.port}/${cfg.database}`,
    async connect() {
      await execOnce('VALUES 1');
      opened++;
    },
    exec,
    isConnError,
    begin,
    txExec,
    commit: (id, keep) => endTx(id, true, keep),
    rollback: (id, keep) => endTx(id, false, keep),
    transactions: () => [...txs.entries()].map(([id, t]) => ({ id, client: t.client, startedAt: t.startedAt, lastUsed: t.lastUsed, statements: t.stmts, isolation: t.isolation })),
    async createSchema(name) {
      await exec(`CREATE SCHEMA ${name}`);
    },
    async dropSchema(name) {
      // Db2 exige que el esquema esté vacío: se eliminan vistas y tablas y luego el esquema.
      const objs = await rows(`SELECT TRIM(TABNAME) AS NAME, TYPE FROM SYSCAT.TABLES WHERE TABSCHEMA = ? ORDER BY CASE TYPE WHEN 'V' THEN 0 ELSE 1 END`, [name]);
      for (const o of objs) {
        await exec(`DROP ${o.TYPE === 'V' ? 'VIEW' : o.TYPE === 'A' ? 'ALIAS' : 'TABLE'} "${name}"."${o.NAME}"`).catch(() => {});
      }
      await exec(`DROP SCHEMA "${name}" RESTRICT`);
    },
    async schemas() {
      const r = await rows(
        `SELECT TRIM(SCHEMANAME) AS NAME, REMARKS AS TEXT, CREATE_TIME AS CREATED FROM SYSCAT.SCHEMATA ORDER BY SCHEMANAME`,
      );
      return r.filter((s) => !SYSTEM_SCHEMAS.has(s.NAME) && !s.NAME.startsWith('SYS') && s.NAME !== cfg.user.toUpperCase())
        .map((s) => ({ name: s.NAME, text: s.TEXT || '', created: s.CREATED }));
    },
    async tables(schema) {
      const r = await rows(
        `SELECT TRIM(TABNAME) AS NAME, TYPE, REMARKS AS TEXT, CARD, CREATE_TIME AS CREATED FROM SYSCAT.TABLES WHERE TABSCHEMA = ? ORDER BY TABNAME`,
        [schema],
      );
      return r.map((t) => ({ name: t.NAME, type: t.TYPE === 'V' ? 'VIEW' : 'TABLE', text: t.TEXT || '', card: Number(t.CARD), created: t.CREATED }));
    },
    async columns(schema, table) {
      const r = await rows(
        `SELECT TRIM(COLNAME) AS NAME, TRIM(TYPENAME) AS TYPE, LENGTH, SCALE, NULLS, REMARKS AS TEXT, KEYSEQ, COLNO
           FROM SYSCAT.COLUMNS WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY COLNO`,
        [schema, table],
      );
      return r.map((c) => ({
        name: c.NAME, type: c.TYPE, length: Number(c.LENGTH), scale: Number(c.SCALE),
        nullable: c.NULLS === 'Y', text: c.TEXT || '', keyseq: c.KEYSEQ == null ? null : Number(c.KEYSEQ),
      }));
    },
    async info() {
      const out = { product: 'IBM Db2', host: cfg.host, port: cfg.port, database: cfg.database };
      try {
        const r = await rows(`SELECT SERVICE_LEVEL, FIXPACK_NUM FROM SYSIBMADM.ENV_INST_INFO`);
        if (r[0]) out.version = `${r[0].SERVICE_LEVEL}`.trim();
      } catch { /* sin permisos de monitor */ }
      try {
        const r = await rows(`SELECT COUNT(*) AS N FROM TABLE(MON_GET_CONNECTION(NULL, -2))`);
        out.connections = Number(r[0]?.N ?? 0);
      } catch { /* ignorar */ }
      try {
        const r = await rows(
          `SELECT ROWS_READ, ROWS_INSERTED, ROWS_UPDATED, ROWS_DELETED, TOTAL_APP_COMMITS, LOCK_WAITS, DEADLOCKS
             FROM TABLE(MON_GET_DATABASE(-2))`,
        );
        if (r[0]) out.monitor = Object.fromEntries(Object.entries(r[0]).map(([k, v]) => [k, Number(v)]));
      } catch { /* ignorar */ }
      return out;
    },
    poolInfo() {
      let available = 0;
      for (const k of Object.keys(pool.availablePool || {})) available += pool.availablePool[k].length;
      let used = 0;
      for (const k of Object.keys(pool.usedPool || {})) used += pool.usedPool[k].length;
      return { max: cfg.poolSize || 10, available, used };
    },
  };
}
