// API REST del sistema (/api/v1): mandatos CL, SQL, programas, objetos, archivos, miembros fuente, spool,
// mensajes, colas de datos, IFS, trabajos, red, auditoría, QSH y certificados. Autenticación Basic o Bearer (JWT).
import { sendJson, send } from '../../../../../shared/http.js';
import { authed, isSecofr, upper, fail, rowsToObjects } from './common.js';
import { authenticate, signToken, parseBasic } from '../../svc/auth.js';
import { runCmd, callPgm, describeProgram } from '../../svc/jobs.js';
import * as obj from '../../objects.js';
import { gw, describeFile } from '../../objects.js';
import * as ifs from '../../ifs.js';
import { mimeOf } from '../../../../../shared/http.js';
import { resolveDtaq, sendDtaq, receiveDtaq, clearDtaq, dtaqEntries, allDtaqs, createDtaq, deleteDtaq, dtaqCount } from '../../dtaq.js';
import { SYS, systemStatus, allJobs, findJob, endJob, qualifiedJob } from '../../system.js';
import { serverStatus, connections, startServer, stopServer, netstatRows } from '../servers.js';
import { auditEntries } from '../../svc/audit.js';
import { outboundLog } from '../httpclient.js';
import { runQsh } from '../qsh.js';
import { spoolToPdf } from '../../svc/pdf.js';
import { readQsysMember, writeQsysMember } from '../../qsyslib.js';
import { tlsCredentials, certInfo } from '../tls.js';

export function mountRest(app) {
  const V = '/api/v1';

  // ---------- Autenticación ----------
  app.post(`${V}/auth/token`, async (req, res) => {
    const b = typeof req.body === 'object' ? req.body : {};
    const basic = parseBasic(req.headers.authorization);
    const user = b.user || b.username || basic?.user;
    const password = b.password ?? basic?.password;
    try {
      const prf = await authenticate(user, password, { service: 'API', remote: req.socket.remoteAddress });
      const ttl = Math.min(Number(b.expiresIn || 3600), 24 * 3600);
      const t = signToken({ sub: prf.NAME, usr: prf.NAME, cls: prf.USRCLS, scope: b.scope || '*ALL' }, ttl);
      sendJson(res, 200, { access_token: t.token, token_type: 'Bearer', expires_in: t.expiresIn, user: prf.NAME, userClass: prf.USRCLS });
    } catch (e) { fail(res, e, 401); }
  });
  app.get(`${V}/auth/me`, authed(async (req, res, { prf, claims }) => {
    sendJson(res, 200, { user: prf.NAME, userClass: prf.USRCLS, text: prf.TEXT, currentLibrary: prf.CURLIB, status: prf.STATUS, token: claims || null });
  }));

  // ---------- Sistema ----------
  app.get(`${V}/system`, authed(async (req, res) => sendJson(res, 200, { ...systemStatus(), system: SYS.name, release: SYS.release, model: SYS.model, serial: SYS.serial })));
  app.get(`${V}/system/values`, authed(async (req, res) => sendJson(res, 200, await obj.sysvals())));
  app.get(`${V}/system/values/:name`, authed(async (req, res) => {
    const v = await obj.sysval(upper(req.params.name));
    if (v === null) return sendJson(res, 404, { error: { id: 'CPF1028', text: `System value ${upper(req.params.name)} not valid.` } });
    sendJson(res, 200, { name: upper(req.params.name), value: v });
  }));

  // ---------- Mandatos CL ----------
  app.post(`${V}/commands`, authed(async (req, res, { ctx }) => {
    const cmd = typeof req.body === 'string' ? req.body : req.body.command || req.body.cmd;
    if (!cmd) return sendJson(res, 400, { error: { id: 'CPD0072', text: 'Parameter command required.' } });
    const r = await runCmd(ctx, cmd);
    sendJson(res, r.ok ? 200 : 400, { ...r, job: qualifiedJob(ctx.job) }, { 'X-Job': qualifiedJob(ctx.job) });
  }));

  // ---------- SQL ----------
  app.post(`${V}/sql`, authed(async (req, res, { ctx }) => {
    const b = typeof req.body === 'string' ? { sql: req.body } : req.body;
    if (!b.sql) return sendJson(res, 400, { error: { id: 'SQL0104', text: 'sql required' } });
    const statements = Array.isArray(b.sql) ? b.sql : [b.sql];
    const results = [];
    for (const s of statements) {
      const r = await ctx.sql(s, b.params || []);
      if (r.error) return sendJson(res, 400, { error: { id: `SQL${String(Math.abs(r.sqlcode || 0)).padStart(4, '0')}`, text: r.error, sqlstate: r.sqlstate, sqlcode: r.sqlcode }, results });
      results.push(b.format === 'rows' ? { columns: r.columns, rows: r.rows, rowCount: r.rowCount } : { columns: r.columns, data: rowsToObjects(r), rowCount: r.rowCount, ms: r.ms });
    }
    sendJson(res, 200, Array.isArray(b.sql) ? { results } : results[0], { 'X-Job': qualifiedJob(ctx.job) });
  }));

  // ---------- Programas ----------
  app.get(`${V}/programs/:lib/:pgm`, authed(async (req, res, { ctx }) => sendJson(res, 200, await describeProgram(ctx, upper(req.params.pgm), upper(req.params.lib)))));
  app.post(`${V}/programs/:lib/:pgm/call`, authed(async (req, res, { ctx }) => {
    const b = typeof req.body === 'object' ? req.body : {};
    const params = b.params ?? b.parameters ?? (Array.isArray(b) ? b : Object.keys(b).length ? b : []);
    const r = await callPgm(ctx, upper(req.params.pgm), upper(req.params.lib), params);
    sendJson(res, 200, r, { 'X-Job': r.job });
  }));

  // ---------- Bibliotecas, objetos y archivos ----------
  app.get(`${V}/libraries`, authed(async (req, res) => sendJson(res, 200, await obj.libraries())));
  app.post(`${V}/libraries`, authed(async (req, res, { ctx }) => {
    const r = await runCmd(ctx, `CRTLIB LIB(${upper(req.body.name)}) TEXT('${String(req.body.text || '').replace(/'/g, "''")}')`);
    sendJson(res, r.ok ? 201 : 400, r);
  }));
  app.get(`${V}/libraries/:lib/objects`, authed(async (req, res) => {
    await obj.syncSqlTables(upper(req.params.lib)).catch(() => {});
    sendJson(res, 200, await obj.listObjects(upper(req.params.lib), upper(req.query.name || '*ALL'), upper(req.query.type || '*ALL')));
  }));
  app.get(`${V}/files/:lib/:file`, authed(async (req, res, { ctx }) => sendJson(res, 200, await describeFile(gw, `${upper(req.params.lib)}/${upper(req.params.file)}`, ctx.libl))));
  app.get(`${V}/files/:lib/:file/records`, authed(async (req, res, { ctx }) => {
    const d = await describeFile(gw, `${upper(req.params.lib)}/${upper(req.params.file)}`, ctx.libl);
    const limit = Math.min(Number(req.query.limit || 100), 10000);
    const offset = Number(req.query.offset || 0);
    const where = [];
    const params = [];
    for (const [k, v] of Object.entries(req.query)) {
      const f = d.fields.find((x) => x.name === upper(k));
      if (f) { where.push(`"${f.name}" = ?`); params.push(v); }
    }
    const order = req.query.orderBy && d.fields.some((f) => f.name === upper(req.query.orderBy)) ? `"${upper(req.query.orderBy)}"` : d.keys.length ? d.keys.map((k) => `"${k}"`).join(', ') : '1';
    const r = await ctx.sql(`SELECT * FROM ${d.schema}.${d.table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} OFFSET ${offset} ROWS FETCH FIRST ${limit} ROWS ONLY`, params, { raw: true });
    if (r.error) return fail(res, Object.assign(new Error(r.error), { sqlstate: r.sqlstate, sqlcode: r.sqlcode }), 400);
    const c = await ctx.sql(`SELECT COUNT(*) AS N FROM ${d.schema}.${d.table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, params, { raw: true });
    sendJson(res, 200, { file: `${d.lib}/${d.table}`, keys: d.keys, total: Number(c.rows?.[0]?.[0] || 0), offset, limit, records: rowsToObjects(r) }, { 'X-Total-Count': String(c.rows?.[0]?.[0] || 0) });
  }));
  app.post(`${V}/files/:lib/:file/records`, authed(async (req, res, { ctx }) => {
    const d = await describeFile(gw, `${upper(req.params.lib)}/${upper(req.params.file)}`, ctx.libl);
    const recs = Array.isArray(req.body) ? req.body : [req.body];
    let n = 0;
    for (const rec of recs) {
      const cols = d.fields.filter((f) => rec[f.name] !== undefined || rec[f.name.toLowerCase()] !== undefined);
      const r = await ctx.sql(`INSERT INTO ${d.schema}.${d.table} (${cols.map((f) => `"${f.name}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((f) => rec[f.name] ?? rec[f.name.toLowerCase()]), { raw: true });
      if (r.error) return fail(res, Object.assign(new Error(r.error), { sqlstate: r.sqlstate, sqlcode: r.sqlcode }), r.sqlstate === '23505' ? 409 : 400);
      n += r.rowCount;
    }
    sendJson(res, 201, { inserted: n });
  }));

  // ---------- Miembros fuente ----------
  app.get(`${V}/sources/:lib/:file`, authed(async (req, res) => sendJson(res, 200, await obj.listMembers(upper(req.params.lib), upper(req.params.file)))));
  app.get(`${V}/sources/:lib/:file/:mbr`, authed(async (req, res) => {
    const text = await readQsysMember(upper(req.params.lib), upper(req.params.file), upper(req.params.mbr));
    if (/json/.test(req.headers.accept || '')) return sendJson(res, 200, { lines: text.replace(/\r\n$/, '').split('\r\n') });
    send(res, 200, text.replace(/\r\n/g, '\n'));
  }));
  app.put(`${V}/sources/:lib/:file/:mbr`, authed(async (req, res) => {
    const text = typeof req.body === 'string' ? req.body : Array.isArray(req.body.lines) ? req.body.lines.join('\n') : String(req.body.source || '');
    const n = await writeQsysMember(upper(req.params.lib), upper(req.params.file), upper(req.params.mbr), text, { srctype: upper(req.query.type || req.body?.type || '') });
    sendJson(res, 200, { lines: n });
  }));

  // ---------- Spool ----------
  app.get(`${V}/spool`, authed(async (req, res, { prf }) => sendJson(res, 200, await obj.listSpool(isSecofr(prf) ? upper(req.query.user || '*ALL') : prf.NAME))));
  app.get(`${V}/spool/:id`, authed(async (req, res, { prf }) => {
    const list = await obj.listSpool('*ALL');
    const s = list.find((x) => Number(x.ID) === Number(req.params.id));
    if (!s || (!isSecofr(prf) && s.JOBUSER !== prf.NAME)) return sendJson(res, 404, { error: { id: 'CPF3303', text: `Spooled file ${req.params.id} not found.` } });
    const lines = await obj.spoolData(s.ID);
    const fmt = String(req.query.format || (/pdf/.test(req.headers.accept || '') ? 'pdf' : 'text')).toLowerCase();
    if (fmt === 'pdf') return send(res, 200, spoolToPdf(lines, { title: `${s.NAME} ${s.JOBNBR}/${s.JOBUSER}/${s.JOBNAME} #${s.SPLNBR}` }), 'application/pdf', { 'Content-Disposition': `inline; filename="${s.NAME}-${s.ID}.pdf"` });
    if (fmt === 'json') return sendJson(res, 200, { ...s, lines });
    send(res, 200, `${lines.join('\n')}\n`);
  }));
  app.del(`${V}/spool/:id`, authed(async (req, res) => { await obj.deleteSpool(Number(req.params.id)); sendJson(res, 200, { deleted: Number(req.params.id) }); }));

  // ---------- Mensajes ----------
  app.get(`${V}/messages/:queue`, authed(async (req, res, { prf }) => {
    const q = upper(req.params.queue) === '*SELF' ? prf.NAME : upper(req.params.queue);
    if (q !== prf.NAME && q !== 'QSYSOPR' && !isSecofr(prf)) return sendJson(res, 403, { error: { id: 'CPF2451', text: `Not authorized to message queue ${q}.` } });
    sendJson(res, 200, await obj.queueMessages(q));
  }));
  app.post(`${V}/messages`, authed(async (req, res, { prf, ctx }) => {
    const to = upper(req.body.to || 'QSYSOPR');
    const id = await obj.sendToQueue(to, String(req.body.text || ''), { from: prf.NAME, fromJob: qualifiedJob(ctx.job), msgid: req.body.msgid || '', type: req.body.type || '*INFO' });
    const { refreshMW } = await import('../../mw.js');
    refreshMW(to);
    sendJson(res, 201, { id, to });
  }));

  // ---------- Colas de datos ----------
  app.get(`${V}/dataqueues`, authed(async (req, res) => {
    const out = [];
    for (const q of await allDtaqs(req.query.lib ? upper(req.query.lib) : undefined)) {
      const d = JSON.parse(q.DATA || '{}');
      out.push({ library: q.LIB, name: q.NAME, text: q.TEXT, ...d, entries: await dtaqCount({ lib: q.LIB, name: q.NAME }) });
    }
    sendJson(res, 200, out);
  }));
  app.post(`${V}/dataqueues/:lib/:name`, authed(async (req, res, { prf }) => {
    const b = req.body || {};
    await createDtaq(upper(req.params.lib), upper(req.params.name), { maxlen: b.maxlen || 1000, seq: upper(b.seq || '*FIFO'), keylen: b.keylen || 0, senderInfo: !!b.senderInfo, text: b.text || '', owner: prf.NAME });
    sendJson(res, 201, { created: `${upper(req.params.lib)}/${upper(req.params.name)}` });
  }));
  app.del(`${V}/dataqueues/:lib/:name`, authed(async (req, res) => { await deleteDtaq(upper(req.params.lib), upper(req.params.name)); sendJson(res, 200, { deleted: true }); }));
  app.post(`${V}/dataqueues/:lib/:name/send`, authed(async (req, res, { ctx }) => {
    const q = await resolveDtaq(req.params.name, req.params.lib, ctx.libl);
    const b = typeof req.body === 'string' ? { data: req.body } : req.body;
    const data = typeof b.data === 'string' ? b.data : JSON.stringify(b.data ?? '');
    const r = await sendDtaq(q, data, { key: b.key || '', sender: q.senderInfo ? qualifiedJob(ctx.job) : '' });
    sendJson(res, 200, { sent: true, ...r });
  }));
  app.get(`${V}/dataqueues/:lib/:name/receive`, authed(async (req, res, { ctx }) => {
    const q = await resolveDtaq(req.params.name, req.params.lib, ctx.libl);
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    const e = await receiveDtaq(q, { wait: Math.min(Number(req.query.wait || 0), 300), key: req.query.key, order: req.query.order || 'EQ', peek: req.query.peek === 'true', signal: ac.signal });
    if (!e) return sendJson(res, 204, {});
    sendJson(res, 200, e);
  }));
  app.get(`${V}/dataqueues/:lib/:name/entries`, authed(async (req, res, { ctx }) => sendJson(res, 200, await dtaqEntries(await resolveDtaq(req.params.name, req.params.lib, ctx.libl)))));
  app.del(`${V}/dataqueues/:lib/:name/entries`, authed(async (req, res, { ctx }) => { await clearDtaq(await resolveDtaq(req.params.name, req.params.lib, ctx.libl), { key: req.query.key }); sendJson(res, 200, { cleared: true }); }));

  // ---------- IFS ----------
  app.get(`${V}/ifs/*`, authed(async (req, res) => {
    const p = ifs.normPath(`/${req.params['*'] || ''}`);
    if (ifs.isQsys(p)) {
      const { parseQsysPath, listQsys } = await import('../../qsyslib.js');
      const q = parseQsysPath(p);
      if (q.mbr || (q.obj && req.query.content === 'true')) return send(res, 200, (await readQsysMember(q.lib, q.obj, q.mbr || q.obj)).replace(/\r\n/g, '\n'));
      return sendJson(res, 200, await listQsys(q));
    }
    const st = await ifs.stat(p);
    if (!st) return sendJson(res, 404, { error: { id: 'CPFA0A9', text: `Object not found. Object is ${p}.` } });
    if (st.dir) return sendJson(res, 200, (await ifs.list(p)).map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size, modified: e.mtime })));
    send(res, 200, await ifs.readFile(p), mimeOf(p), { 'Content-Disposition': `inline; filename="${st.name}"` });
  }));
  app.put(`${V}/ifs/*`, authed(async (req, res) => {
    const p = ifs.normPath(`/${req.params['*'] || ''}`);
    await ifs.writeFile(p, req.rawBody || Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)), { append: req.query.append === 'true' });
    sendJson(res, 201, { path: p, size: (await ifs.stat(p))?.size });
  }));
  app.post(`${V}/ifs/*`, authed(async (req, res) => {
    const p = ifs.normPath(`/${req.params['*'] || ''}`);
    if (req.query.mkdir === 'true' || req.body?.type === 'dir') { await ifs.mkdir(p, { parents: true }); return sendJson(res, 201, { path: p, type: '*DIR' }); }
    await ifs.writeFile(p, req.rawBody || '', { append: true });
    sendJson(res, 201, { path: p });
  }));
  app.del(`${V}/ifs/*`, authed(async (req, res) => {
    const p = ifs.normPath(`/${req.params['*'] || ''}`);
    const st = await ifs.stat(p);
    if (!st) return sendJson(res, 404, { error: { id: 'CPFA0A9', text: `Object not found. Object is ${p}.` } });
    if (st.dir) await ifs.rmdir(p, { recursive: req.query.recursive === 'true' }); else await ifs.unlink(p);
    sendJson(res, 200, { deleted: p });
  }));

  // ---------- Trabajos ----------
  app.get(`${V}/jobs`, authed(async (req, res) => sendJson(res, 200, allJobs().map((j) => ({
    job: qualifiedJob(j), number: j.number, user: j.user, name: j.name, type: j.type, subsystem: j.subsystem, status: j.status, function: j.function, cpuPct: j.cpuPct, startedAt: j.startedAt,
  })))));
  app.get(`${V}/jobs/:number/joblog`, authed(async (req, res, { prf }) => {
    const j = findJob(req.params.number);
    if (!j) return sendJson(res, 404, { error: { id: 'CPF1321', text: `Job ${req.params.number} not found.` } });
    if (j.user !== prf.NAME && !isSecofr(prf)) return sendJson(res, 403, { error: { id: 'CPF1344', text: 'Not authorized to job.' } });
    sendJson(res, 200, j.joblog.slice(-500));
  }));
  app.del(`${V}/jobs/:number`, authed(async (req, res) => {
    const j = findJob(req.params.number);
    if (!j || j.system) return sendJson(res, 404, { error: { id: 'CPF1321', text: `Job ${req.params.number} not found or is a system job.` } });
    j.cancel = true;
    if (!j.session) endJob(j, 30);
    sendJson(res, 200, { ended: qualifiedJob(j) });
  }, { secofr: true }));

  // ---------- Red (NETSTAT, STRTCPSVR) ----------
  app.get(`${V}/network/servers`, authed(async (req, res) => sendJson(res, 200, serverStatus())));
  app.get(`${V}/network/connections`, authed(async (req, res) => sendJson(res, 200, connections())));
  app.get(`${V}/network/netstat`, authed(async (req, res) => sendJson(res, 200, netstatRows())));
  app.get(`${V}/network/outbound`, authed(async (req, res) => sendJson(res, 200, outboundLog())));
  app.post(`${V}/network/servers/:key/:action`, authed(async (req, res) => {
    const key = `*${upper(req.params.key).replace(/^\*/, '')}`;
    const ok = req.params.action === 'start' ? await startServer(key) : await stopServer(key);
    sendJson(res, 200, { server: key, action: req.params.action, changed: ok });
  }, { secofr: true }));

  // ---------- Auditoría, QSH y certificados ----------
  app.get(`${V}/audit`, authed(async (req, res) => sendJson(res, 200, auditEntries({ type: req.query.type, user: req.query.user && upper(req.query.user), limit: Number(req.query.limit || 200) })), { secofr: true }));
  app.post(`${V}/qsh`, authed(async (req, res, { ctx }) => {
    const script = typeof req.body === 'string' ? req.body : req.body.script || req.body.command || '';
    const r = await runQsh(ctx, script);
    sendJson(res, 200, { output: r.text, exitCode: r.code });
  }));
  app.get(`${V}/certs/ca.crt`, async (req, res) => {
    const c = tlsCredentials();
    if (!c?.ca) return sendJson(res, 404, { error: { id: 'CPF9801', text: 'No system certificate authority available.' } });
    send(res, 200, c.ca, 'application/x-x509-ca-cert', { 'Content-Disposition': 'attachment; filename="as400-ca.crt"' });
  });
  app.get(`${V}/certs`, async (req, res) => sendJson(res, 200, certInfo() || { error: 'TLS not available' }));
}
