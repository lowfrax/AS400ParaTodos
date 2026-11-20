// Servicio compilador: CRTBNDRPG / CRTSQLRPGI / CRTBNDCL / CRTPF / CRTDSPF.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp, sendJson, SSEHub } from '../../../shared/http.js';
import { createGateway } from '../../../shared/gateway.js';
import { compile } from './compile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5251);
const gw = createGateway(process.env.GATEWAY_URL || 'http://localhost:5252', 'rpg-compiler');

const state = {
  startedAt: Date.now(),
  total: 0,
  ok: 0,
  failed: 0,
  byType: {},
  inflight: new Map(),
  history: [],
  perMinute: [],
  lines: 0,
  window: 0,
};
let seq = 0;
const hub = new SSEHub();

function summary(c) {
  const { listing, ...rest } = c;
  return rest;
}

function stats() {
  return {
    uptime: Math.round((Date.now() - state.startedAt) / 1000),
    total: state.total,
    ok: state.ok,
    failed: state.failed,
    lines: state.lines,
    byType: state.byType,
    inflight: [...state.inflight.values()],
    perMinute: state.perMinute,
    memory: process.memoryUsage().rss,
    host: os.hostname(),
    gateway: gw.url,
    dashboards: hub.size,
  };
}

setInterval(() => {
  state.perMinute.push({ t: Date.now(), n: state.window });
  if (state.perMinute.length > 60) state.perMinute.shift();
  state.window = 0;
}, 60000);
setInterval(() => hub.broadcast('stats', stats()), 1000);

async function doCompile(body, persist = true) {
  const id = ++seq;
  const job = {
    id, ts: Date.now(), type: String(body.type || 'RPGLE').toUpperCase(), obj: `${body.lib}/${body.name}`,
    src: `${body.srclib || body.lib}/${body.srcfile || ''}(${body.srcmbr || body.name})`, user: body.user || 'QSYS',
    job: body.job || '', lines: (body.source || []).length, status: 'COMPILING', check: !!body.check,
  };
  state.inflight.set(id, job);
  hub.broadcast('start', job);
  const r = await compile(gw, body);
  state.inflight.delete(id);
  Object.assign(job, { status: r.ok ? 'OK' : 'FAILED', ok: r.ok, severity: r.severity, ms: r.ms, messages: r.messages, listing: r.listing });
  if (persist) {
    state.total++;
    state.window++;
    state.lines += job.lines;
    if (r.ok) state.ok++; else state.failed++;
    state.byType[job.type] = (state.byType[job.type] || 0) + 1;
    state.history.push(job);
    if (state.history.length > 100) state.history.shift();
  }
  hub.broadcast('done', summary(job));
  return r;
}

const app = createApp();
app.get('/health', (req, res) => sendJson(res, 200, { status: 'ready' }));
app.get('/stats', (req, res) => sendJson(res, 200, stats()));
app.get('/history', (req, res) => sendJson(res, 200, state.history.map(summary)));
app.get('/history/:id', (req, res) => {
  const j = state.history.find((x) => x.id === Number(req.params.id));
  if (!j) return sendJson(res, 404, { error: 'not found' });
  sendJson(res, 200, j);
});
app.get('/events', (req, res) => hub.handle(req, res, [['stats', stats()], ['history', state.history.map(summary)]]));
app.post('/compile', async (req, res) => sendJson(res, 200, await doCompile(req.body)));
// Compilación de prueba desde el panel: no crea objetos.
app.post('/check', async (req, res) => sendJson(res, 200, await doCompile({ lib: 'QTEMP', name: 'CHECK', user: 'DASHBOARD', ...req.body, check: true }, true)));

app.static('/_shared/', path.resolve(__dirname, '../../../shared/public'));
app.static('/', path.resolve(__dirname, '../public'));
app.listen(PORT, () => console.log(`[compiler] Compilador RPG/CL/DDS escuchando en http://localhost:${PORT}`));
