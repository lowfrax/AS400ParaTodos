// IBM i Core: servidor del sistema (IPL, trabajos, sesiones 5250 por WebSocket) y panel en tiempo real.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createApp, sendJson, SSEHub, getJson } from '../../../shared/http.js';
import { SYS, initSystemJobs, sampleMetrics, metrics, systemStatus, allJobs, createJob, endJob, setStatus, endedJobs } from './system.js';
import { Session, sessions } from './session.js';
import { Ctx } from './ctx.js';
import * as obj from './objects.js';
import { gw } from './objects.js';
import { showIpl, signOn } from './screens/signon.js';
import { goMenu } from './screens/menus.js';
import { execFromLine } from './screens/common.js';
import { compileObject } from './runtime/build.js';
import { refreshMW } from './mw.js';
import './commands/defs.js';
import './commands/integration.js';
import { initIfs, homeDir } from './ifs.js';
import { initDtaq } from './dtaq.js';
import { initMq } from './net/mq.js';
import { initCatalogViews } from './sql/catalog.js';
import { initNetwork } from './net/index.js';
import { serverStatus, connections, netEvents } from './net/servers.js';
import { outboundEvents, outboundLog } from './net/httpclient.js';
import { auditEvents, auditEntries } from './svc/audit.js';
import { httpLog } from './net/http/server.js';
import { loadExtensions } from './extensions.js';
import { SOURCES, CUSTOMERS, COMPILE_ORDER } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5250);
const COMPILER = process.env.COMPILER_URL || 'http://localhost:5251';
const hub = new SSEHub();
const events = [];

function event(kind, text) {
  const e = { t: Date.now(), kind, text };
  events.push(e);
  if (events.length > 200) events.shift();
  hub.broadcast('event', e);
}

// ---------- IPL ----------
async function ipl() {
  SYS.status = 'IPL';
  initSystemJobs();
  SYS.iplStep = 'Storage Management Recovery';
  await new Promise((r) => setTimeout(r, 800));
  SYS.iplStep = 'Authority Recovery';
  await new Promise((r) => setTimeout(r, 500));
  // La inicialización de la base de datos se repite si Db2 cae a mitad (p. ej. el contenedor de Db2 reinicia
  // el gestor tras crear la base de datos). Todos los pasos son idempotentes.
  for (let attempt = 1; ; attempt++) {
    SYS.iplStep = 'Database Recovery';
    await waitDatabase();
    try {
      SYS.iplStep = 'Data Base Initialization';
      await obj.initSchema();
      await initDtaq();
      await initMq();
      await initCatalogViews();
      SYS.iplStep = 'Commit Recovery';
      await seedUsers();
      SYS.iplStep = 'Start the Operating System';
      await seedDemo();
      break;
    } catch (e) {
      if (attempt >= 20) throw e;
      SYS.iplDetail = `Database not available, retrying: ${e.message}`.slice(0, 150);
      console.error(`[ipl] intento ${attempt} fallido: ${e.message}; se reintenta en 10 s`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  // Arranque de TCP/IP: TELNET, FTP, REXEC, HTTP (IWS/XMLSERVICE/REST), Mapepire, servidores host, core bancario…
  SYS.iplStep = 'Start TCP/IP';
  await loadExtensions();
  await initNetwork({ attachSession }).catch((e) => console.error('[ipl] TCP/IP:', e));
  SYS.status = 'READY';
  SYS.iplStep = 'Complete';
  event('ipl', `IPL complete. System ${SYS.name} ${SYS.release} ready.`);
  console.log(`[ipl] Sistema ${SYS.name} listo. Terminal 5250: http://localhost:${PORT}/`);
}

async function waitDatabase() {
  for (let n = 0; ; n++) {
    try {
      const h = await gw.health();
      if (h.status === 'ready') break;
      SYS.iplDetail = `Waiting for IBM Db2 (${h.driver}): ${h.error || 'starting'}`;
    } catch (e) {
      SYS.iplDetail = `Waiting for DB2 Gateway at ${gw.url}...`;
    }
    if (n % 10 === 0) console.log(`[ipl] ${SYS.iplDetail}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  SYS.iplDetail = '';
}

async function seedUsers() {
  const users = [
    { name: 'QSECOFR', password: 'QSECOFR', usrcls: '*SECOFR', text: 'Security Officer', curlib: 'DEMOLIB' },
    { name: 'QPGMR', password: 'QPGMR', usrcls: '*PGMR', text: 'Programmer', curlib: 'QGPL' },
    { name: 'DEMO', password: 'DEMO', usrcls: '*PGMR', text: 'Usuario de demostracion', curlib: 'DEMOLIB' },
  ];
  for (const u of users) if (!(await obj.getUser(u.name))) await obj.createUser(u);
  if (!(await obj.getUser('QSYSOPR'))) await obj.createUser({ name: 'QSYSOPR', password: '*NONE', usrcls: '*SYSOPR', text: 'System Operator' });
  // Perfiles de servidor sin contraseña (no pueden iniciar sesión): CGI (QTMHHTP1), trabajos de servidor (QUSER), TCP/IP (QTCP).
  for (const [name, text] of [['QTMHHTP1', 'HTTP Server CGI user'], ['QUSER', 'Work station user'], ['QTCP', 'TCP/IP user']]) {
    if (!(await obj.getUser(name))) await obj.createUser({ name, password: '*NONE', usrcls: '*USER', text, curlib: 'QGPL' });
  }
  for (const u of ['QSECOFR', 'QPGMR', 'DEMO']) homeDir(u);
  // Tokens SHA-1 (servidores host) de los perfiles que siguen con su contraseña inicial
  for (const u of await obj.listUsers()) {
    const p = await obj.getUser(u.NAME);
    if (p && !p.PWDTOKEN && p.PWDHASH && p.PWDHASH === obj.hashPassword(p.NAME, p.NAME)) await obj.updateUser(p.NAME, { PWDTOKEN: obj.passwordTokens(p.NAME, p.NAME) });
  }
}

async function waitCompiler() {
  for (let i = 0; i < 60; i++) {
    try { await getJson(`${COMPILER}/health`, 2000); return true; } catch { SYS.iplDetail = `Waiting for RPG compiler at ${COMPILER}...`; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function seedDemo() {
  if (await obj.libExists('DEMOLIB')) {
    // DEMOLIB.ITEMS es lo último que se crea: si existe, la semilla terminó.
    const tables = await gw.tables('DEMOLIB');
    if (!Array.isArray(tables)) throw new Error(`catálogo no disponible: ${tables?.error}`);
    if (tables.some((t) => t.name === 'ITEMS')) return;
    console.log('[ipl] DEMOLIB quedó incompleta en un IPL anterior; se vuelve a crear');
    await obj.deleteLibrary('DEMOLIB');
  }
  console.log('[ipl] Creando biblioteca DEMOLIB con programas de ejemplo…');
  await obj.createLibrary('DEMOLIB', 'Biblioteca de demostracion AS400 para Todos', 'PROD', 'QSECOFR');
  for (const f of ['QRPGLESRC', 'QDDSSRC', 'QCLLESRC']) await obj.createSourceFile('DEMOLIB', f, 112, { QRPGLESRC: 'RPG IV source', QDDSSRC: 'DDS source', QCLLESRC: 'CL source' }[f]);
  for (const s of SOURCES) {
    await obj.addMember('DEMOLIB', s.file, s.mbr, s.type, s.text);
    await obj.writeMember('DEMOLIB', s.file, s.mbr, s.lines.map((t, i) => ({ seq: i + 1, dat: 0, text: t })));
  }
  if (!(await waitCompiler())) { console.error('[ipl] compilador no disponible; DEMOLIB sin compilar'); return; }
  const job = createJob({ name: 'QSYSARB', user: 'QSECOFR', type: 'BCH', subsystem: 'QCTL', fn: 'PGM-QWCSEED' });
  job.libl = ['DEMOLIB', 'QGPL', 'QTEMP'];
  job.curlib = 'DEMOLIB';
  const ctx = new Ctx({ job, user: await obj.getUser('QSECOFR'), interactive: false });
  for (const [cmd, kw, name, src] of COMPILE_ORDER) {
    SYS.iplDetail = `${cmd} ${kw}(DEMOLIB/${name})`;
    try {
      const type = { CRTPF: 'PF', CRTDSPF: 'DSPF', CRTBNDRPG: 'RPGLE', CRTSQLRPGI: 'SQLRPGLE', CRTBNDCL: 'CLLE' }[cmd];
      const out = await compileObject(ctx, { type, obj: { lib: 'DEMOLIB', obj: name }, srcfile: { lib: 'DEMOLIB', obj: src }, srcmbr: name, text: '*SRCMBRTXT' });
      console.log(`[ipl]   ${out[0]?.text}`);
    } catch (e) {
      console.error(`[ipl]   ${cmd} ${name}: ${e.message}`);
    }
    if (name === 'CUSTOMER') {
      await gw.batch(CUSTOMERS.map((c) => ({ sql: 'INSERT INTO DEMOLIB.CUSTOMER (CUSTNO, NAME, CITY, COUNTRY, BALANCE, CRLIMIT) VALUES (?, ?, ?, ?, ?, ?)', params: c })), ['23505']);
    }
  }
  // Tabla creada por SQL (no DDS) para practicar STRSQL
  await gw.batch([
    `CREATE TABLE DEMOLIB.ITEMS (ITEMNO INTEGER NOT NULL PRIMARY KEY, DESCR VARCHAR(40) NOT NULL, PRICE DECIMAL(9, 2) NOT NULL, STOCK INTEGER NOT NULL)`,
    ...[[100, 'Teclado IBM Model M', 189.9, 12], [101, 'Terminal IBM 5251', 950, 2], [102, 'Cinta de backup LTO-9', 129.5, 40],
      [103, 'Monitor fosforo verde', 310, 5], [104, 'Manual RPG IV', 49.99, 25]].map((r) => ({ sql: 'INSERT INTO DEMOLIB.ITEMS VALUES (?, ?, ?, ?)', params: r })),
  ], ['42710', '23505']);
  await gw.sql(`COMMENT ON TABLE DEMOLIB.ITEMS IS 'Articulos (creada con SQL)'`);
  await obj.syncSqlTables('DEMOLIB');
  SYS.iplDetail = '';
  endJob(job);
}

// ---------- Sesiones 5250 ----------
async function runSession(session) {
  try {
    await showIpl(session);
    for (;;) {
      if (session.closed) return;
      session.forceSignoff = false;
      const s = await signOn(session);
      const { prf, job } = s;
      session.job = job;
      session.user = prf;
      session.onJob?.(job);
      const ctx = new Ctx({ session, job, user: prf });
      event('signon', `${prf.NAME} signed on at ${session.device} (job ${job.number}).`);
      hub.broadcast('sessions', sessionList());
      refreshMW(job.user);
      try {
        const inlpgm = s.pgm || (prf.INLPGM && prf.INLPGM !== '*NONE' ? prf.INLPGM : '');
        if (inlpgm) {
          const m = await execFromLine(ctx, `CALL ${inlpgm}`);
          if (m && m.sev >= 30) console.log(`[session] ${m.text}`);
        }
        const menu = s.menu || (prf.INLMNU && prf.INLMNU !== '*SIGNOFF' ? prf.INLMNU : 'MAIN');
        await goMenu(ctx, menu).catch(async (e) => { if (e.msgId) await goMenu(ctx, 'MAIN'); else throw e; });
      } catch (e) {
        if (!e.signoff && !e.disconnected && !e.cancel) console.error('[session]', e);
        if (e.disconnected) { endJob(job); event('signoff', `${job.user} disconnected from ${session.device}.`); return; }
      }
      endJob(job);
      event('signoff', `${job.user} signed off ${session.device}.`);
      session.job = null;
      session.dspfBuf = null;
      session.sqlHistory = null;
      session.extMsgs = null;
      session.setMessageWaiting(false);
      hub.broadcast('sessions', sessionList());
    }
  } catch (e) {
    if (!e.disconnected) console.error('[session] fatal', e);
    if (session.job) endJob(session.job);
  } finally {
    hub.broadcast('sessions', sessionList());
  }
}

function sessionList() {
  return [...sessions].map((s) => ({
    device: s.device, remote: s.remote, kind: s.kind, termType: s.termType, secure: s.secure, user: s.job?.user || null, job: s.job ? `${s.job.number}/${s.job.user}/${s.job.name}` : null,
    status: s.job?.status || 'SIGNON', function: s.job?.function || '', connectedAt: s.connectedAt, screens: s.screens, mw: s.mw,
  }));
}

function jobList() {
  return allJobs().map((j) => ({
    number: j.number, name: j.name, user: j.user, type: j.type, subsystem: j.subsystem, status: j.status,
    function: j.function, cpuPct: j.cpuPct || 0, cpuMs: Math.round(j.cpuMs), startedAt: j.startedAt, system: j.system,
  }));
}

/** Crea una sesión de pantalla 5250 para un terminal (web o TN5250) y la pone en marcha. */
function attachSession(ws, remote, opts = {}) {
  const session = new Session(ws, remote, opts);
  event('connect', `Display ${session.device} connected from ${remote}${opts.kind === 'tn5250' ? ` (TN5250 ${opts.termType}${opts.tls ? ', TLS' : ''})` : ''}.`);
  hub.broadcast('sessions', sessionList());
  runSession(session);
  return session;
}

// ---------- HTTP / WS ----------
const app = createApp();
app.get('/health', (req, res) => sendJson(res, 200, { status: SYS.status === 'READY' ? 'ready' : 'ipl', step: SYS.iplStep }));
app.get('/api/status', (req, res) => sendJson(res, 200, { system: systemStatus(), sessions: sessionList(), jobs: jobList() }));
app.get('/api/spool', async (req, res) => sendJson(res, 200, await obj.listSpool('*ALL').catch(() => [])));
app.get('/api/network', (req, res) => sendJson(res, 200, { servers: serverStatus(), connections: connections(), outbound: outboundLog(50), http: httpLog.slice(-50), audit: auditEntries({ limit: 50 }) }));
app.get('/events', (req, res) => hub.handle(req, res, [
  ['system', { ...systemStatus(), step: SYS.iplStep, detail: SYS.iplDetail, history: metrics.history.slice(-120) }],
  ['sessions', sessionList()], ['jobs', jobList()], ['events', events.slice(-50)],
  ['network', { servers: serverStatus(), connections: connections() }], ['outbound', outboundLog(30)], ['audit', auditEntries({ limit: 30 })],
]));
// Eventos de red en tiempo real para el panel
netEvents.on('http', (e) => hub.broadcast('http', e));
outboundEvents.on('request', (e) => hub.broadcast('outbound-one', e));
auditEvents.on('entry', (e) => hub.broadcast('audit-one', e));
netEvents.on('server', (e) => event('tcp', `${e.key} server ${e.active ? 'started' : 'ended'}.`));
app.static('/_shared/', path.resolve(__dirname, '../../../shared/public'));
app.static('/', path.resolve(__dirname, '../public'));

initIfs();
const server = app.listen(PORT, () => {
  console.log(`[core] IBM i core escuchando en http://localhost:${PORT} (panel: /dashboard/)`);
  ipl().catch((e) => { console.error('[ipl] error fatal', e); SYS.iplDetail = `IPL failed: ${e.message}`; });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  attachSession(ws, (req.socket.remoteAddress || '').replace('::ffff:', ''), { kind: 'web' });
});

// Métricas y estado de los demás servicios
setInterval(async () => {
  try { metrics.ext.gateway = await getJson(`${gw.url}/stats`, 1500); } catch { metrics.ext.gateway = null; }
  try { metrics.ext.compiler = await getJson(`${COMPILER}/stats`, 1500); } catch { metrics.ext.compiler = null; }
}, 2000);
setInterval(() => {
  sampleMetrics();
  hub.broadcast('system', { ...systemStatus(), step: SYS.iplStep, detail: SYS.iplDetail, history: metrics.history.slice(-120), gateway: !!metrics.ext.gateway, compiler: !!metrics.ext.compiler, ended: endedJobs().slice(-10).map((j) => `${j.number}/${j.user}/${j.name}`) });
  hub.broadcast('jobs', jobList());
  hub.broadcast('sessions', sessionList());
  hub.broadcast('network', { servers: serverStatus(), connections: connections() });
}, 1000);
setInterval(() => { if (SYS.status === 'READY') refreshMW(); }, 15000);

export { setStatus };
