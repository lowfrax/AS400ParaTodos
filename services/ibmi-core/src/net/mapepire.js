// Servidor Mapepire (base de datos de IBM i por WebSocket, puerto 8076, wss://host:8076/db/).
// Compatible con los clientes oficiales @ibm/mapepire-js, mapepire-python, mapepire-java, Go, PHP y la extensión
// Db2 for IBM i de VS Code: connect, sql, prepare_sql, prepare_sql_execute, execute, sqlmore, sqlclose, cl, rccl,
// getversion, getdbjob, ping, setconfig, gettracedata y control de transacciones (COMMIT / ROLLBACK).
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { authenticate, parseBasic } from '../svc/auth.js';
import { serverCtx, endServerCtx, runCmd } from '../svc/jobs.js';
import { tagConnection } from './servers.js';
import { listen } from './telnet.js';
import { qualifiedJob } from '../system.js';

const VERSION = '2.3.0';
const ISO = { none: '*NONE', 'read uncommitted': '*CHG', 'read committed': '*CS', 'repeatable read': '*ALL', serializable: '*RR' };

function parseProps(s) {
  const o = {};
  for (const kv of String(s || '').split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) o[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
  }
  return o;
}

function meta(r) {
  return {
    column_count: r.columns.length,
    columns: r.columns.map((c) => ({ name: c.name, label: c.name, type: c.type, display_size: c.precision || c.length || 0, precision: c.precision || c.length || 0, scale: c.scale || 0, nullable: c.nullable ? 1 : 0 })),
  };
}

class MapepireSession {
  constructor(ws, ctl, conn, prf, remote) {
    this.ws = ws;
    this.ctl = ctl;
    this.conn = conn;
    this.prf = prf;
    this.remote = remote;
    this.ctx = null;
    this.cursors = new Map();
    this.prepared = new Map();
    this.trace = { tracedest: 'IN_MEM', tracelevel: 'OFF' };
    ws.on('message', (raw) => {
      conn.count(raw.length, 0);
      this.queue = (this.queue || Promise.resolve()).then(() => this.handle(raw)).catch((e) => console.error('[mapepire]', e));
    });
    ws.on('close', () => this.close());
    ws.on('error', () => this.close());
  }

  out(o) {
    const s = JSON.stringify(o);
    this.conn.count(0, s.length);
    try { this.ws.send(s); } catch { /* cerrado */ }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.conn.close();
    if (this.ctx) {
      // Sin COMMIT explícito, IBM i deshace la transacción al terminar la conexión.
      if (this.ctx.job.cmt?.tx) this.ctx.rollback().catch(() => {});
      endServerCtx(this.ctx);
    }
  }

  async ensureCtx() {
    if (!this.ctx) await this.connect({ id: 'auto', props: '' }, false);
    return this.ctx;
  }

  async connect(m, reply = true) {
    if (this.ctx) endServerCtx(this.ctx);
    this.ctx = await serverCtx(this.prf, { name: 'QZDASOINIT', subsystem: 'QUSRWRK', type: 'PJ', fn: 'PGM-MAPEPIRE' });
    const p = parseProps(m.props);
    if (p.libraries) {
      const libs = p.libraries.split(/[\s,]+/).map((l) => l.toUpperCase()).filter(Boolean);
      if (libs.length) { this.ctx.job.curlib = libs[0]; this.ctx.job.libl = [...new Set([...libs, ...this.ctx.job.libl])]; }
    }
    if (p['default schema'] || p.schema) this.ctx.job.curlib = String(p['default schema'] || p.schema).toUpperCase();
    const iso = ISO[String(p['transaction isolation'] || 'none').toLowerCase()] || '*NONE';
    const auto = String(p['auto commit'] ?? 'true').toLowerCase() !== 'false';
    if (iso !== '*NONE' && !auto) await this.ctx.startCommit(iso);
    this.ctx.job.name = 'QZDASOINIT';
    tagConnection(this.conn.conn, { user: this.prf.NAME, job: this.ctx.job, detail: `Mapepire ${m.application || ''}`.trim() });
    if (reply) this.out({ id: m.id, success: true, job: qualifiedJob(this.ctx.job), execution_time: 0 });
  }

  // id = id de la petición (se devuelve en la respuesta); key = id del cursor para sqlmore/sqlclose (por omisión, el mismo).
  async runSql(id, sql, params, rows, terse, key = id) {
    const t0 = Date.now();
    const ctx = await this.ensureCtx();
    // Consulta interna de los clientes para saber si hay cambios pendientes
    if (/qsys2\.db_transaction_info/i.test(sql)) {
      const n = ctx.job.cmt?.tx ? 1 : 0;
      return this.out({ id, success: true, has_results: true, update_count: -1, is_done: true, metadata: { column_count: 1, columns: [{ name: 'THECOUNT', label: 'THECOUNT', type: 'INTEGER', display_size: 11 }] }, data: terse ? [[n]] : [{ THECOUNT: n }], execution_time: 0 });
    }
    const U = sql.trim().toUpperCase();
    if (/^(COMMIT|ROLLBACK)\b/.test(U)) {
      const r = U.startsWith('COMMIT') ? await ctx.commit() : await ctx.rollback();
      return this.out({ id, success: !r?.error, ...(r?.error ? { error: r.error } : {}), has_results: false, update_count: 0, is_done: true, data: [], metadata: { column_count: 0, columns: [] }, execution_time: Date.now() - t0 });
    }
    const r = await ctx.sql(sql, params || []);
    if (r.error) return this.out({ id, success: false, error: `[SQL${String(Math.abs(r.sqlcode || 0)).padStart(4, '0')}] ${r.error}`, sql_rc: r.sqlcode, sql_state: r.sqlstate, execution_time: Date.now() - t0 });
    if (!r.columns.length) return this.out({ id, success: true, has_results: false, update_count: r.rowCount, is_done: true, data: [], metadata: { column_count: 0, columns: [] }, execution_time: Date.now() - t0 });
    const cur = { r, pos: 0, terse };
    this.cursors.set(key, cur);
    this.page(id, cur, rows, t0, key);
  }

  page(id, cur, rows, t0 = Date.now(), key = id) {
    const n = Math.max(1, Number(rows || 100));
    const slice = cur.r.rows.slice(cur.pos, cur.pos + n);
    cur.pos += slice.length;
    const done = cur.pos >= cur.r.rows.length;
    const data = cur.terse ? slice : slice.map((row) => Object.fromEntries(cur.r.columns.map((c, i) => [c.name, row[i]])));
    if (done) this.cursors.delete(key);
    this.out({ id, success: true, has_results: true, update_count: -1, is_done: done, metadata: meta(cur.r), data, execution_time: Date.now() - t0 });
  }

  async handle(raw) {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return this.out({ id: '', success: false, error: 'Invalid JSON request' }); }
    const id = m.id ?? '';
    try {
      switch (m.type) {
        case 'connect': return await this.connect(m);
        case 'getversion': return this.out({ id, success: true, version: VERSION, build_date: '2026-01-01 00:00:00', execution_time: 0 });
        case 'ping': return this.out({ id, success: true, alive: true, db_alive: true, execution_time: 0 });
        case 'getdbjob': { const ctx = await this.ensureCtx(); return this.out({ id, success: true, job: qualifiedJob(ctx.job), execution_time: 0 }); }
        case 'setconfig': Object.assign(this.trace, { tracedest: m.tracedest || this.trace.tracedest, tracelevel: m.tracelevel || this.trace.tracelevel }); return this.out({ id, success: true, ...this.trace, execution_time: 0 });
        case 'gettracedata': return this.out({ id, success: true, tracedata: '', execution_time: 0 });
        case 'sql': return await this.runSql(id, m.sql, m.parameters, m.rows, m.terse);
        case 'prepare_sql': {
          this.prepared.set(id, { sql: m.sql });
          const nparms = (String(m.sql).replace(/'(?:[^']|'')*'/g, '').match(/\?/g) || []).length;
          return this.out({ id, success: true, has_results: /^\s*(SELECT|WITH|VALUES)\b/i.test(m.sql), update_count: -1, is_done: false, data: [], metadata: { column_count: 0, columns: [], parameters: Array.from({ length: nparms }, (_, i) => ({ name: `P${i + 1}`, type: 'VARCHAR', mode: 'IN', precision: 0, scale: 0 })) }, parameter_count: nparms, execution_time: 0 });
        }
        case 'prepare_sql_execute': {
          this.prepared.set(id, { sql: m.sql });
          const batch = Array.isArray(m.parameters) && Array.isArray(m.parameters[0]);
          if (batch) {
            let total = 0;
            for (const ps of m.parameters) {
              const r = await (await this.ensureCtx()).sql(m.sql, ps);
              if (r.error) return this.out({ id, success: false, error: r.error, sql_rc: r.sqlcode, sql_state: r.sqlstate, execution_time: 0 });
              total += r.rowCount;
            }
            return this.out({ id, success: true, has_results: false, update_count: total, is_done: true, data: [], metadata: { column_count: 0, columns: [] }, execution_time: 0 });
          }
          return await this.runSql(id, m.sql, m.parameters, m.rows, m.terse);
        }
        case 'execute': {
          const p = this.prepared.get(m.cont_id);
          if (!p) return this.out({ id, success: false, error: `Prepared statement ${m.cont_id} not found` });
          return await this.runSql(id, p.sql, m.parameters, m.rows, m.terse, m.cont_id);
        }
        case 'sqlmore': {
          const cur = this.cursors.get(m.cont_id);
          if (!cur) return this.out({ id, success: false, error: `Query ${m.cont_id} is not active or already complete.` });
          return this.page(id, cur, m.rows, Date.now(), m.cont_id);
        }
        case 'sqlclose': this.cursors.delete(m.cont_id); this.prepared.delete(m.cont_id); return this.out({ id, success: true, execution_time: 0 });
        case 'cl': case 'rccl': {
          const ctx = await this.ensureCtx();
          const r = await runCmd(ctx, m.cmd);
          const data = r.joblog.filter((e) => e.type !== '*RQS').map((e) => ({ id: e.id || '', type: String(e.type || '').replace('*', ''), severity: e.sev || 0, text: e.text, time: e.time, messageLibrary: 'QSYS', messageFile: 'QCPFMSG', sendingProgram: 'QCMDEXC', sendingInstruction: '', receivingProgram: '', receivingInstruction: '' }));
          if (!r.ok && !data.some((d) => d.id === r.error.id)) data.push({ id: r.error.id, type: 'ESCAPE', severity: r.error.sev, text: r.error.text, time: Date.now() });
          return this.out({ id, success: r.ok, ...(r.ok ? {} : { error: `${r.error.id}: ${r.error.text}` }), data, execution_time: 0 });
        }
        case 'dove': return this.out({ id, success: false, error: 'Visual Explain is not available on this system.' });
        case 'getcldoc': case 'getcmdxml': return this.out({ id, success: false, error: `${m.type} is not available on this system.` });
        case 'exit': this.ws.close(); return undefined;
        default: return this.out({ id, success: false, error: `Unknown request type: ${m.type}` });
      }
    } catch (e) {
      return this.out({ id, success: false, error: `${e.msgId ? `${e.msgId}: ` : ''}${e.message}` });
    }
  }
}

export function mapepireServerDef(api) {
  const port = Number(process.env.MAPEPIRE_PORT || 8076);
  return {
    key: '*MAPEPIRE', title: 'Mapepire (DB WebSocket)', job: 'MAPEPIRE', subsystem: 'QUSRWRK', fn: 'JVM-mapepire',
    ports: [{ port, tls: true, label: 'mapepire' }],
    async start(ctl) {
      const creds = api.tls?.();
      const server = creds ? https.createServer({ key: creds.key, cert: creds.cert }) : http.createServer();
      server.on('request', (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ server: 'mapepire', version: VERSION, websocket: '/db/' })); });
      const wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', async (req, socket, head) => {
        if (!/^\/db\/?$/.test(new URL(req.url, 'http://x').pathname)) { socket.destroy(); return; }
        const b = parseBasic(req.headers.authorization);
        const remote = (req.socket.remoteAddress || '').replace('::ffff:', '');
        let prf;
        try { prf = b ? await authenticate(b.user, b.password, { service: 'MAPEPIRE', remote }) : null; } catch { prf = null; }
        if (!prf) { ctl.reject(); socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="mapepire"\r\n\r\n'); socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const v = ctl.virtual({ remote, local: `*:${port}`, user: prf.NAME, detail: 'Mapepire' });
          // eslint-disable-next-line no-new
          new MapepireSession(ws, ctl, v, prf, remote);
        });
      });
      await listen(server, port);
      return server;
    },
  };
}
