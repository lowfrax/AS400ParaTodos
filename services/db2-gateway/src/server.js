// DB2 Gateway: único punto de acceso SQL del sistema (equivalente a los jobs QSQSRVR).
// Expone una API HTTP JSON y un panel en tiempo real con el log de consultas.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp, sendJson, SSEHub } from '../../../shared/http.js';
import { createDb2Driver } from './drivers/db2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5252);
const driver = createDb2Driver({
  host: process.env.DB2_HOST || 'localhost',
  port: Number(process.env.DB2_PORT || 50000),
  database: process.env.DB2_DATABASE || 'AS400',
  user: process.env.DB2_USER || 'db2inst1',
  password: process.env.DB2_PASSWORD || 'as400pass',
  poolSize: Number(process.env.DB2_POOL || 10),
});

const state = {
  status: 'starting',
  error: null,
  startedAt: Date.now(),
  readyAt: null,
  attempts: 0,
  total: 0,
  errors: 0,
  rowsReturned: 0,
  rowsAffected: 0,
  inflight: 0,
  latencyTotal: 0,
  byClient: {},
  byVerb: {},
  log: [],
  history: [], // {t, qps, avgMs, errors}
  windowCount: 0,
  windowMs: 0,
  windowErr: 0,
  info: null,
};
let seq = 0;
const hub = new SSEHub();

let connecting = null;
function connectLoop() {
  if (!connecting) connecting = connectForever().finally(() => { connecting = null; });
  return connecting;
}

async function connectForever() {
  for (;;) {
    state.attempts++;
    try {
      await driver.connect();
      state.status = 'ready';
      state.error = null;
      state.readyAt = Date.now();
      console.log(`[gateway] conectado a ${driver.description}`);
      refreshInfo();
      return;
    } catch (e) {
      state.status = 'starting';
      state.error = e.message;
      if (state.attempts % 5 === 1) console.log(`[gateway] esperando base de datos (${state.attempts}): ${e.message}`);
      hub.broadcast('status', publicStatus());
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function refreshInfo() {
  try { state.info = await driver.info(); } catch (e) { state.info = { error: e.message }; }
}

function publicStatus() {
  return {
    status: state.status, error: state.error, driver: driver.name, description: driver.description,
    startedAt: state.startedAt, readyAt: state.readyAt, attempts: state.attempts,
  };
}

async function runSql(sql, params, client = 'anon') {
  if (state.status !== 'ready') {
    const e = new Error('Database not available. IPL in progress.');
    e.sqlstate = '08001';
    e.sqlcode = -30081;
    throw e;
  }
  const id = ++seq;
  const t0 = performance.now();
  const verb = (String(sql).trim().match(/^\w+/) || ['?'])[0].toUpperCase();
  state.inflight++;
  const entry = { id, ts: Date.now(), client, verb, sql: String(sql).slice(0, 2000), params: (params || []).slice(0, 20) };
  try {
    const r = await driver.exec(sql, params);
    entry.ms = +(performance.now() - t0).toFixed(2);
    entry.ok = true;
    entry.rows = r.rowCount;
    if (r.columns.length) state.rowsReturned += r.rows.length; else state.rowsAffected += r.rowCount;
    return { ...r, ms: entry.ms };
  } catch (e) {
    entry.ms = +(performance.now() - t0).toFixed(2);
    entry.ok = false;
    entry.sqlstate = e.sqlstate || '58004';
    entry.sqlcode = e.sqlcode ?? -901;
    entry.error = e.message;
    state.errors++;
    // Db2 sigue sin responder tras los reintentos del driver: se vuelve a 'starting' y se reconecta en segundo plano.
    if (driver.isConnError?.(e) && state.status === 'ready') {
      state.status = 'starting';
      state.error = e.message;
      console.log(`[gateway] Db2 no disponible: ${e.message.slice(0, 120)}; reconectando…`);
      hub.broadcast('status', publicStatus());
      connectLoop();
    }
    state.windowErr++;
    throw e;
  } finally {
    state.inflight--;
    state.total++;
    state.latencyTotal += entry.ms;
    state.windowCount++;
    state.windowMs += entry.ms;
    state.byClient[client] = (state.byClient[client] || 0) + 1;
    state.byVerb[verb] = (state.byVerb[verb] || 0) + 1;
    state.log.push(entry);
    if (state.log.length > 300) state.log.shift();
    hub.broadcast('query', entry);
  }
}

function stats() {
  return {
    ...publicStatus(),
    total: state.total,
    errors: state.errors,
    inflight: state.inflight,
    rowsReturned: state.rowsReturned,
    rowsAffected: state.rowsAffected,
    avgMs: state.total ? +(state.latencyTotal / state.total).toFixed(2) : 0,
    byClient: state.byClient,
    byVerb: state.byVerb,
    pool: driver.poolInfo(),
    history: state.history,
    info: state.info,
    uptime: Math.round((Date.now() - state.startedAt) / 1000),
    host: os.hostname(),
    memory: process.memoryUsage().rss,
    dashboards: hub.size,
  };
}

setInterval(() => {
  state.history.push({
    t: Date.now(),
    qps: state.windowCount,
    avgMs: state.windowCount ? +(state.windowMs / state.windowCount).toFixed(2) : 0,
    errors: state.windowErr,
  });
  if (state.history.length > 120) state.history.shift();
  state.windowCount = 0;
  state.windowMs = 0;
  state.windowErr = 0;
  hub.broadcast('stats', stats());
}, 1000);
setInterval(() => { if (state.status === 'ready') refreshInfo(); }, 10000);

const app = createApp();

app.get('/health', (req, res) => sendJson(res, state.status === 'ready' ? 200 : 503, publicStatus()));
app.get('/stats', (req, res) => sendJson(res, 200, stats()));
app.get('/log', (req, res) => sendJson(res, 200, state.log.slice(-Number(req.query.n || 100))));
app.get('/events', (req, res) => hub.handle(req, res, [['stats', stats()], ['log', state.log.slice(-100)]]));

app.post('/sql', async (req, res) => {
  const { sql, params, client } = req.body || {};
  if (!sql) return sendJson(res, 400, { error: 'sql requerido' });
  try {
    sendJson(res, 200, await runSql(sql, params || [], client || req.headers['x-client'] || 'http'));
  } catch (e) {
    sendJson(res, 200, { error: e.message, sqlstate: e.sqlstate || '58004', sqlcode: e.sqlcode ?? -901 });
  }
});

// Ejecuta varias sentencias en orden; ignore = lista de SQLSTATE tolerados (p.ej. 42710 "ya existe").
app.post('/batch', async (req, res) => {
  const { statements = [], ignore = [], client } = req.body || {};
  const results = [];
  for (const st of statements) {
    const s = typeof st === 'string' ? { sql: st, params: [] } : st;
    try {
      const r = await runSql(s.sql, s.params || [], client || 'batch');
      results.push({ ok: true, rowCount: r.rowCount });
    } catch (e) {
      const ignored = ignore.includes(e.sqlstate);
      results.push({ ok: ignored, ignored, error: e.message, sqlstate: e.sqlstate, sqlcode: e.sqlcode });
      if (!ignored && !req.body.continueOnError) break;
    }
  }
  sendJson(res, 200, { results });
});

async function catalog(res, fn) {
  if (state.status !== 'ready') return sendJson(res, 503, { error: 'Database not available', sqlstate: '08001' });
  try { sendJson(res, 200, await fn()); } catch (e) { sendJson(res, 200, { error: e.message, sqlstate: e.sqlstate }); }
}
app.get('/catalog/schemas', (req, res) => catalog(res, () => driver.schemas()));
app.get('/catalog/tables', (req, res) => catalog(res, () => driver.tables(String(req.query.schema || '').toUpperCase())));
app.get('/catalog/columns', (req, res) => catalog(res, () => driver.columns(
  String(req.query.schema || '').toUpperCase(), String(req.query.table || '').toUpperCase())));
app.post('/catalog/schema', (req, res) => catalog(res, async () => {
  const name = String(req.body.name || '').toUpperCase();
  if (!/^[A-Z#@$][A-Z0-9_#@$]{0,9}$/.test(name)) throw Object.assign(new Error('Invalid schema name'), { sqlstate: '42602' });
  if (req.body.drop) await driver.dropSchema(name); else await driver.createSchema(name);
  return { ok: true };
}));

app.static('/_shared/', path.resolve(__dirname, '../../../shared/public'));
app.static('/', path.resolve(__dirname, '../public'));

app.listen(PORT, () => {
  console.log(`[gateway] DB2 Gateway escuchando en http://localhost:${PORT} (driver=${driver.name})`);
  connectLoop();
});
