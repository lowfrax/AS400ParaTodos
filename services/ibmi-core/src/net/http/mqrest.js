// API REST de mensajería compatible con IBM MQ (messaging REST API v1/v2/v3) sobre el gestor de colas interno,
// más /api/v1/mq en JSON. Los clientes escritos para IBM MQ REST (curl, Postman, apps) funcionan sin cambios.
import { sendJson, send } from '../../../../../shared/http.js';
import { requireAuth, fail } from './common.js';
import * as mq from '../mq.js';

export function mountMqRest(app) {
  const base = '/ibmmq/rest/:ver/messaging/qmgr/:qmgr/queue/:q/message';
  const check = async (req, res) => {
    const a = await requireAuth(req, res, { realm: 'IBM MQ' });
    if (!a) return null;
    if (req.params.qmgr && req.params.qmgr.toUpperCase() !== mq.QMGR()) { sendJson(res, 404, { error: [{ msgId: 'MQWB0009E', message: `MQWB0009E: Could not find the queue manager '${req.params.qmgr}'.` }] }); return null; }
    if (req.method !== 'GET' && !req.headers['ibm-mq-rest-csrf-token']) { sendJson(res, 403, { error: [{ msgId: 'MQWB0115E', message: 'MQWB0115E: The ibm-mq-rest-csrf-token HTTP header is missing.' }] }); return null; }
    return a;
  };
  app.post(base, async (req, res) => {
    const a = await check(req, res);
    if (!a) return;
    try {
      const body = req.rawBody ? req.rawBody.toString('utf8') : '';
      const r = await mq.mqSend(req.params.q, body, { correlId: req.headers['ibm-mq-md-correlationid'] || '', user: a.prf.NAME, replyTo: req.headers['ibm-mq-md-replyto'] || '', priority: Number(req.headers['ibm-mq-md-priority'] || 0) });
      res.writeHead(201, { 'ibm-mq-md-messageId': r.messageId, 'ibm-mq-md-correlationId': r.correlationId || '' });
      res.end();
    } catch (e) { sendJson(res, 404, { error: [{ msgId: 'MQWB0101E', message: e.message }] }); }
  });
  const get = (browse) => async (req, res) => {
    const a = await check(req, res);
    if (!a) return;
    try {
      const opts = { wait: Math.min(Number(req.query.wait || 0) / 1000, 300), correlId: req.query.correlationId, messageId: req.query.messageId };
      const m = browse ? await mq.mqBrowse(req.params.q, opts) : await mq.mqReceive(req.params.q, opts);
      if (!m) { res.writeHead(204); return res.end(); }
      send(res, 200, m.data, 'text/plain; charset=utf-8', { 'ibm-mq-md-messageId': m.messageId || '', 'ibm-mq-md-correlationId': m.correlationId || '', 'ibm-mq-md-replyTo': m.replyTo || '' });
    } catch (e) { sendJson(res, 404, { error: [{ msgId: 'MQWB0101E', message: e.message }] }); }
  };
  app.del(base, get(false));
  app.get(base, get(true));
  app.get('/ibmmq/rest/:ver/admin/qmgr', async (req, res) => {
    const a = await requireAuth(req, res, { realm: 'IBM MQ' });
    if (!a) return;
    sendJson(res, 200, { qmgr: [{ name: mq.QMGR(), state: 'running' }] });
  });
  app.get('/ibmmq/rest/:ver/admin/qmgr/:qmgr/queue', async (req, res) => {
    const a = await requireAuth(req, res, { realm: 'IBM MQ' });
    if (!a) return;
    const qs = await mq.listQueues();
    sendJson(res, 200, { queue: qs.map((q) => ({ name: q.name, type: 'local', description: q.description, status: { currentDepth: q.depth }, storage: { maximumDepth: q.maxDepth } })) });
  });

  // JSON
  app.get('/api/v1/mq/queues', async (req, res) => { const a = await requireAuth(req, res); if (!a) return; sendJson(res, 200, { qmgr: mq.QMGR(), queues: await mq.listQueues() }); });
  app.post('/api/v1/mq/queues', async (req, res) => {
    const a = await requireAuth(req, res);
    if (!a) return;
    try { await mq.createQueue(req.body.name, { descr: req.body.description || '', maxdepth: req.body.maxDepth || 5000 }); sendJson(res, 201, { created: String(req.body.name).toUpperCase() }); } catch (e) { fail(res, e); }
  });
  app.get('/api/v1/mq/queues/:q/messages', async (req, res) => { const a = await requireAuth(req, res); if (!a) return; sendJson(res, 200, await mq.mqMessages(req.params.q)); });
  app.post('/api/v1/mq/queues/:q/messages', async (req, res) => {
    const a = await requireAuth(req, res);
    if (!a) return;
    const data = typeof req.body === 'string' ? req.body : typeof req.body?.data === 'string' ? req.body.data : JSON.stringify(req.body?.data ?? req.body);
    try { sendJson(res, 201, await mq.mqSend(req.params.q, data, { correlId: req.body?.correlationId || '', user: a.prf.NAME })); } catch (e) { fail(res, e); }
  });
  app.del('/api/v1/mq/queues/:q/messages', async (req, res) => {
    const a = await requireAuth(req, res);
    if (!a) return;
    try {
      const m = await mq.mqReceive(req.params.q, { wait: Math.min(Number(req.query.wait || 0), 300), correlId: req.query.correlationId });
      if (!m) { res.writeHead(204); return res.end(); }
      sendJson(res, 200, m);
    } catch (e) { fail(res, e); }
  });
}
