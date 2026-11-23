// Servidor HTTP del sistema (QHTTPSVR): IBM HTTP Server (estático + CGI), Integrated Web Services (REST/SOAP),
// XMLSERVICE, API REST de administración (/api/v1), mensajería REST de IBM MQ, OpenAPI y WebSocket de eventos.
// CORS configurable con CORS_ORIGINS / CORS_CREDENTIALS. HTTP en 10010 y HTTPS en 10443 (certificado del sistema).
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { createApp, sendJson, send, corsConfig } from '../../../../../shared/http.js';
import { mountRest } from './rest.js';
import { mountIws } from './iws.js';
import { mountXmlService } from './xmlservice.js';
import { mountCgi, serveHtdocs } from './cgi.js';
import { mountMqRest } from './mqrest.js';
import { openapi, docsPage } from './openapi.js';
import { verifyToken, parseBasic, authenticate } from '../../svc/auth.js';
import { dtaqEvents, resolveDtaq, receiveDtaq } from '../../dtaq.js';
import { mqEvents, mqReceive } from '../mq.js';
import { netEvents } from '../servers.js';
import { getUser } from '../../objects.js';
import { listen } from '../telnet.js';

export const httpLog = [];
const extraMounts = [];
/** Otros módulos (core bancario, Open Banking…) registran sus rutas aquí antes de arrancar el servidor. */
export function addHttpMount(fn) { extraMounts.push(fn); }

export function buildApp(ctl) {
  const app = createApp({
    cors: corsConfig(),
    notFound: async (req, res) => {
      if (await serveHtdocs(req, res)) return;
      sendJson(res, 404, { error: { id: 'HTTP404', text: `Not found: ${req.path}` } });
    },
  });
  app.use((req, res) => {
    const t0 = Date.now();
    res.setHeader('Server', 'IBM_HTTP_Server/7.5 (AS400 para Todos)');
    res.on('finish', () => {
      const e = { t: t0, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, remote: (req.socket.remoteAddress || '').replace('::ffff:', ''), origin: req.headers.origin || '' };
      httpLog.push(e);
      if (httpLog.length > 300) httpLog.shift();
      netEvents.emit('http', e);
    });
  });
  app.get('/openapi.json', (req, res) => sendJson(res, 200, openapi(req)));
  app.get('/docs', (req, res) => send(res, 200, docsPage(), 'text/html; charset=utf-8'));
  app.get('/docs/', (req, res) => send(res, 200, docsPage(), 'text/html; charset=utf-8'));
  app.get('/api/v1/health', (req, res) => sendJson(res, 200, { status: 'ok' }));
  app.get('/api/v1/http/log', (req, res) => sendJson(res, 200, httpLog.slice(-100)));
  mountRest(app);
  mountIws(app);
  mountXmlService(app); // antes que /cgi-bin/:pgm
  mountMqRest(app);
  for (const m of extraMounts) m(app);
  mountCgi(app);
  return app;
}

// WebSocket /api/v1/ws: suscripción a colas de datos, colas MQ y eventos del sistema.
function attachWs(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/v1/ws') return; // otros WS (p. ej. Open Banking) los gestionan sus módulos
    let prf = null;
    try {
      const tok = url.searchParams.get('token') || (/^Bearer /i.test(req.headers.authorization || '') ? req.headers.authorization.slice(7) : null);
      if (tok) { const c = verifyToken(tok); prf = await getUser(c.usr); } else {
        const b = parseBasic(req.headers.authorization);
        if (b) prf = await authenticate(b.user, b.password, { service: 'WS', remote: req.socket.remoteAddress });
      }
    } catch { prf = null; }
    if (!prf) { socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="IBM i"\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wsSession(ws, prf));
  });
}

async function wsSession(ws, prf) {
  const subs = [];
  const out = (m) => { try { ws.send(JSON.stringify(m)); } catch { /* cerrado */ } };
  // Los mensajes que lleguen mientras se prepara el trabajo se encolan (no se pierden).
  let chain = Promise.resolve();
  let handler = null;
  ws.on('message', (raw) => { chain = chain.then(() => handler(raw)).catch(() => {}); });
  const { pooledCtx } = await import('../../svc/jobs.js');
  const ctxReady = pooledCtx('QZHBWS', prf, { subsystem: 'QHTTPSVR', type: 'BCH' });
  chain = chain.then(() => ctxReady);
  const ctx = await ctxReady;
  out({ type: 'welcome', user: prf.NAME, ops: ['watch-dtaq', 'consume-dtaq', 'watch-mq', 'consume-mq', 'events', 'sql', 'cmd', 'unsubscribe'] });
  handler = async (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return out({ type: 'error', text: 'invalid JSON' }); }
    const id = m.id ?? null;
    try {
      if (m.op === 'watch-dtaq' || m.op === 'consume-dtaq') {
        const [lib, name] = String(m.dtaq || '').toUpperCase().split('/');
        const q = await resolveDtaq(name || lib, name ? lib : '*LIBL', ctx.libl);
        if (m.op === 'watch-dtaq') {
          const fn = (e) => { if (e.lib === q.lib && e.name === q.name) out({ type: 'dtaq', dtaq: `${q.lib}/${q.name}`, data: e.data, key: e.key, at: e.enqueued }); };
          dtaqEvents.on('send', fn);
          subs.push(() => dtaqEvents.off('send', fn));
        } else {
          const ac = new AbortController();
          subs.push(() => ac.abort());
          (async () => { while (!ac.signal.aborted) { const e = await receiveDtaq(q, { wait: 30, signal: ac.signal }); if (e) out({ type: 'dtaq', consumed: true, dtaq: `${q.lib}/${q.name}`, data: e.data, key: e.key }); } })().catch(() => {});
        }
        return out({ type: 'ok', id, subscribed: `${q.lib}/${q.name}` });
      }
      if (m.op === 'watch-mq' || m.op === 'consume-mq') {
        const qn = String(m.queue || '').toUpperCase();
        if (m.op === 'watch-mq') {
          const fn = (e) => { if (e.queue === qn) out({ type: 'mq', queue: qn, data: e.data, messageId: e.messageId, correlationId: e.correlationId }); };
          mqEvents.on('put', fn);
          subs.push(() => mqEvents.off('put', fn));
        } else {
          const ac = new AbortController();
          subs.push(() => ac.abort());
          (async () => { while (!ac.signal.aborted) { const e = await mqReceive(qn, { wait: 30, signal: ac.signal }); if (e) out({ type: 'mq', consumed: true, queue: qn, data: e.data, messageId: e.messageId }); } })().catch(() => {});
        }
        return out({ type: 'ok', id, subscribed: qn });
      }
      if (m.op === 'events') {
        const fns = {
          server: (e) => out({ type: 'server', ...e }),
          conn: (e) => out({ type: 'connection', ...e }),
        };
        for (const [k, fn] of Object.entries(fns)) netEvents.on(k, fn);
        subs.push(() => { for (const [k, fn] of Object.entries(fns)) netEvents.off(k, fn); });
        return out({ type: 'ok', id, subscribed: 'events' });
      }
      if (m.op === 'sql') {
        const r = await ctx.sql(m.sql, m.params || []);
        return out({ type: 'sql', id, ...(r.error ? { error: r.error, sqlstate: r.sqlstate } : { columns: r.columns, rows: r.rows, rowCount: r.rowCount }) });
      }
      if (m.op === 'cmd') {
        const { runCmd } = await import('../../svc/jobs.js');
        return out({ type: 'cmd', id, ...(await runCmd(ctx, m.command)) });
      }
      if (m.op === 'unsubscribe') { subs.splice(0).forEach((f) => f()); return out({ type: 'ok', id }); }
      out({ type: 'error', id, text: `unknown op ${m.op}` });
    } catch (e) { out({ type: 'error', id, text: e.message, msgId: e.msgId }); }
  };
  ws.on('close', () => subs.splice(0).forEach((f) => f()));
}

export function httpServerDef(api) {
  const port = Number(process.env.HTTP_PORT || 10010);
  const sport = Number(process.env.HTTPS_PORT || 10443);
  return {
    key: '*HTTP', title: 'HTTP Server / IWS / XMLSERVICE / REST', job: 'QZHBHTTP', subsystem: 'QHTTPSVR', fn: 'PGM-QZHBMAIN',
    ports: [{ port, label: 'http' }, { port: sport, tls: true, label: 'https' }],
    async start(ctl) {
      const app = buildApp(ctl);
      const handles = [];
      const s1 = http.createServer(app.handler);
      s1.on('connection', (sock) => ctl.track(sock, { detail: 'HTTP' }));
      attachWs(s1);
      for (const fn of api.upgradeHandlers || []) fn(s1);
      await listen(s1, port);
      handles.push(s1);
      const creds = api.tls?.();
      if (creds) {
        const s2 = https.createServer({ key: creds.key, cert: creds.cert }, app.handler);
        s2.on('secureConnection', (sock) => ctl.track(sock, { detail: 'HTTPS' }));
        attachWs(s2);
        for (const fn of api.upgradeHandlers || []) fn(s2);
        await listen(s2, sport).then(() => handles.push(s2)).catch((e) => console.error(`[tcp] HTTPS ${sport}: ${e.message}`));
      }
      return handles;
    },
  };
}
