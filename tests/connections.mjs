// Pruebas de integración de todas las conexiones externas del sistema (contra un sistema en marcha).
// Uso: node tests/connections.mjs        (variables: AS400_HOST, HTTP_PORT, FTP_PORT, REXEC_PORT, TELNET_PORT, MAPEPIRE_PORT, ISO_PORT…)
import net from 'node:net';
import tls from 'node:tls';
import { WebSocket } from 'ws';

const H = process.env.AS400_HOST || '127.0.0.1';
const PORT = {
  http: Number(process.env.HTTP_PORT || 10010), ftp: Number(process.env.FTP_PORT || 21), rexec: Number(process.env.REXEC_PORT || 512),
  telnet: Number(process.env.TELNET_PORT || 23), mapepire: Number(process.env.MAPEPIRE_PORT || 8076), iso: Number(process.env.ISO_PORT || 8583),
  hostsvr: Number(process.env.SIGNON_PORT || 8476), drda: Number(process.env.DRDA_PORT || 446),
};
const USER = process.env.AS400_USER || 'DEMO';
const PWD = process.env.AS400_PASSWORD || 'DEMO';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const BASE = `http://${H}:${PORT.http}`;
const AUTH = { Authorization: `Basic ${Buffer.from(`${USER}:${PWD}`).toString('base64')}` };
let failures = 0;
let passed = 0;

async function step(group, name, fn) {
  if (ONLY.length && !ONLY.includes(group)) return;
  try { await fn(); passed++; console.log(`  ok  [${group}] ${name}`); } catch (e) { failures++; console.log(`  FALLO [${group}] ${name}\n        ${String(e.stack || e.message).split('\n').slice(0, 4).join('\n        ')}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function api(method, path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { ...AUTH, ...(body !== undefined && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* no JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

// ---------------- REST / CORS / SQL ----------------
await step('rest', 'POST /api/v1/auth/token emite JWT y /auth/me lo acepta', async () => {
  const r = await api('POST', '/api/v1/auth/token', { user: USER, password: PWD });
  assert(r.status === 200 && r.json.access_token, r.text);
  const me = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${r.json.access_token}` } }).then((x) => x.json());
  assert(me.user === USER, JSON.stringify(me));
});
await step('rest', 'Credenciales incorrectas → 401 con WWW-Authenticate', async () => {
  const r = await fetch(`${BASE}/api/v1/system`, { headers: { Authorization: `Basic ${Buffer.from(`${USER}:MALA`).toString('base64')}` } });
  assert(r.status === 401, `status ${r.status}`);
  await api('POST', '/api/v1/commands', { command: `CHGUSRPRF USRPRF(${USER}) STATUS(*ENABLED)` }, { Authorization: `Basic ${Buffer.from('QSECOFR:QSECOFR').toString('base64')}` });
});
await step('cors', 'Preflight OPTIONS desde otro origen', async () => {
  const r = await fetch(`${BASE}/api/v1/sql`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5000', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert(r.status === 204, `status ${r.status}`);
  assert(r.headers.get('access-control-allow-origin'), 'sin Access-Control-Allow-Origin');
  assert(/POST/.test(r.headers.get('access-control-allow-methods') || ''), 'sin métodos');
});
await step('rest', 'Mandato CL por REST (CRTLIB + DSPLIB)', async () => {
  await api('POST', '/api/v1/commands', { command: 'DLTLIB LIB(CONNTEST)' });
  const r = await api('POST', '/api/v1/commands', { command: "CRTLIB LIB(CONNTEST) TEXT('Pruebas de conexiones')" });
  assert(r.status === 200 && r.json.ok, r.text);
  assert(/CONNTEST created/.test(r.text), r.text);
});
await step('sql', 'SQL con *LIBL y servicios QSYS2 (ACTIVE_JOB_INFO, LIBRARY_LIST_INFO, SYSTABLES)', async () => {
  let r = await api('POST', '/api/v1/sql', { sql: 'SELECT COUNT(*) AS N FROM CUSTOMER' });
  assert(r.status === 200 && r.json.data[0].N >= 20, r.text);
  r = await api('POST', '/api/v1/sql', { sql: "SELECT JOB_NAME, JOB_TYPE FROM QSYS2.ACTIVE_JOB_INFO WHERE JOB_TYPE IN ('SBS', 'BCH') ORDER BY JOB_NAME" });
  assert(r.status === 200 && r.json.data.length > 3, r.text);
  r = await api('POST', '/api/v1/sql', { sql: 'SELECT * FROM QSYS2.LIBRARY_LIST_INFO' });
  assert(r.json.data.some((x) => x.SCHEMA_NAME === 'QSYS'), r.text);
  r = await api('POST', '/api/v1/sql', { sql: "SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'DEMOLIB'" });
  assert(r.json.data.some((x) => x.TABLE_NAME === 'CUSTOMER'), r.text);
});
await step('sql', 'CALL QSYS2.QCMDEXC y colas de datos por SQL', async () => {
  let r = await api('POST', '/api/v1/sql', { sql: "CALL QSYS2.QCMDEXC('CRTDTAQ DTAQ(CONNTEST/Q1) MAXLEN(200)')" });
  assert(r.status === 200, r.text);
  r = await api('POST', '/api/v1/sql', { sql: "CALL QSYS2.SEND_DATA_QUEUE(MESSAGE_DATA => 'hola desde SQL', DATA_QUEUE => 'Q1', DATA_QUEUE_LIBRARY => 'CONNTEST')" });
  assert(r.status === 200, r.text);
  r = await api('POST', '/api/v1/sql', { sql: "SELECT MESSAGE_DATA FROM TABLE(QSYS2.RECEIVE_DATA_QUEUE(DATA_QUEUE => 'Q1', DATA_QUEUE_LIBRARY => 'CONNTEST'))" });
  assert(r.json.data[0]?.MESSAGE_DATA === 'hola desde SQL', r.text);
});
await step('sql', 'QSYS2.HTTP_GET (HTTP saliente desde SQL)', async () => {
  const r = await api('POST', '/api/v1/sql', { sql: 'VALUES QSYS2.HTTP_GET(?)', params: [`${BASE}/api/v1/health`] });
  assert(r.status === 200 && JSON.parse(Object.values(r.json.data[0])[0]).status === 'ok', r.text);
});
await step('sql', 'Control de compromiso: ROLLBACK deshace y COMMIT confirma', async () => {
  const sql = (s) => api('POST', '/api/v1/qsh', { script: s });
  // El trabajo de servidor se reutiliza: se termina cualquier control de compromiso que quedara activo
  await api('POST', '/api/v1/commands', { command: 'ROLLBACK' });
  await api('POST', '/api/v1/commands', { command: 'ENDCMTCTL' });
  await api('POST', '/api/v1/sql', { sql: 'CREATE TABLE CONNTEST.TXT (ID INTEGER NOT NULL PRIMARY KEY, TXT VARCHAR(20))' });
  // En IBM i el control de compromiso exige que la tabla esté en un diario
  await api('POST', '/api/v1/commands', { command: 'CRTJRNRCV JRNRCV(CONNTEST/RCV0001)' });
  await api('POST', '/api/v1/commands', { command: 'CRTJRN JRN(CONNTEST/JRN) JRNRCV(CONNTEST/RCV0001)' });
  await api('POST', '/api/v1/commands', { command: 'STRJRNPF FILE(CONNTEST/TXT) JRN(CONNTEST/JRN)' });
  // Mapepire/host servers prueban transacciones de sesión; por REST se usa un programa CL con STRCMTCTL
  const r = await api('POST', '/api/v1/commands', { command: 'STRCMTCTL LCKLVL(*CHG)' });
  assert(r.json.ok || /already active/.test(r.text), r.text);
  await api('POST', '/api/v1/sql', { sql: "INSERT INTO CONNTEST.TXT VALUES (1, 'uno')" });
  await api('POST', '/api/v1/commands', { command: 'ROLLBACK' });
  let c = await api('POST', '/api/v1/sql', { sql: 'SELECT COUNT(*) AS N FROM CONNTEST.TXT' });
  assert(c.json.data && Number(c.json.data[0].N) === 0, `tras ROLLBACK: ${c.text}`);
  await api('POST', '/api/v1/sql', { sql: "INSERT INTO CONNTEST.TXT VALUES (2, 'dos')" });
  await api('POST', '/api/v1/commands', { command: 'COMMIT' });
  await api('POST', '/api/v1/commands', { command: 'ENDCMTCTL' });
  c = await api('POST', '/api/v1/sql', { sql: 'SELECT COUNT(*) AS N FROM CONNTEST.TXT' });
  assert(Number(c.json.data[0].N) === 1, `tras COMMIT: ${c.text}`);
  void sql;
});

// ---------------- Colas de datos / MQ / IFS / programas ----------------
await step('dtaq', 'REST: enviar, ver entradas y recibir con espera (FIFO y por clave)', async () => {
  await api('POST', '/api/v1/dataqueues/CONNTEST/KQ', { maxlen: 100, seq: '*KEYED', keylen: 4 });
  await api('POST', '/api/v1/dataqueues/CONNTEST/KQ/send', { data: 'segundo', key: 'B002' });
  await api('POST', '/api/v1/dataqueues/CONNTEST/KQ/send', { data: 'primero', key: 'A001' });
  const e = await api('GET', '/api/v1/dataqueues/CONNTEST/KQ/entries');
  assert(e.json.length === 2 && e.json[0].key === 'A001', e.text);
  const r = await api('GET', '/api/v1/dataqueues/CONNTEST/KQ/receive?key=B002&order=EQ');
  assert(r.json.data === 'segundo', r.text);
  const waiting = api('GET', '/api/v1/dataqueues/CONNTEST/Q1/receive?wait=10');
  await new Promise((res) => setTimeout(res, 300));
  await api('POST', '/api/v1/dataqueues/CONNTEST/Q1/send', { data: 'llega mientras espera' });
  const w = await waiting;
  assert(w.json?.data === 'llega mientras espera', w.text);
});
await step('dtaq', 'WebSocket /api/v1/ws: watch-dtaq recibe los envíos', async () => {
  const ws = new WebSocket(`ws://${H}:${PORT.http}/api/v1/ws`, { headers: AUTH });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const got = new Promise((res) => ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'dtaq') res(m); }));
  ws.send(JSON.stringify({ op: 'watch-dtaq', dtaq: 'CONNTEST/Q1' }));
  await new Promise((res) => setTimeout(res, 300));
  await api('POST', '/api/v1/dataqueues/CONNTEST/Q1/send', { data: 'evento ws' });
  const m = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('sin evento')), 5000))]);
  assert(m.data === 'evento ws', JSON.stringify(m));
  ws.close();
});
await step('mq', 'IBM MQ REST (put/get) y SQL MQSEND/MQRECEIVE', async () => {
  const q = (await api('GET', '/ibmmq/rest/v3/admin/qmgr')).json.qmgr[0].name;
  let r = await fetch(`${BASE}/ibmmq/rest/v3/messaging/qmgr/${q}/queue/DEV.QUEUE.1/message`, { method: 'POST', headers: { ...AUTH, 'ibm-mq-rest-csrf-token': 'x', 'Content-Type': 'text/plain' }, body: 'hola MQ' });
  assert(r.status === 201, `put ${r.status}`);
  r = await fetch(`${BASE}/ibmmq/rest/v3/messaging/qmgr/${q}/queue/DEV.QUEUE.1/message?wait=1000`, { method: 'DELETE', headers: { ...AUTH, 'ibm-mq-rest-csrf-token': 'x' } });
  assert(r.status === 200 && (await r.text()) === 'hola MQ', `get ${r.status}`);
  await api('POST', '/api/v1/sql', { sql: "VALUES MQSEND('DEV.QUEUE.2', 'desde SQL')" });
  const s = await api('POST', '/api/v1/sql', { sql: "VALUES MQRECEIVE('DEV.QUEUE.2')" });
  assert(JSON.stringify(s.json).includes('desde SQL'), s.text);
});
await step('ifs', 'IFS por REST: PUT, GET, listado y QSYS.LIB', async () => {
  let r = await api('PUT', '/api/v1/ifs/tmp/conntest/hola.txt', 'Hola IFS\n', { 'Content-Type': 'text/plain' });
  assert(r.status === 201, r.text);
  r = await api('GET', '/api/v1/ifs/tmp/conntest/hola.txt');
  assert(r.text === 'Hola IFS\n', r.text);
  r = await api('GET', '/api/v1/ifs/QSYS.LIB/DEMOLIB.LIB/QRPGLESRC.FILE/HELLO.MBR');
  assert(/Hola, /.test(r.text), r.text.slice(0, 200));
});
await step('pgm', 'Llamada a programa con parámetros (QCMDEXC como programa del sistema)', async () => {
  const r = await api('POST', '/api/v1/programs/QSYS/QCMDEXC/call', { params: ['CRTDTAQ DTAQ(CONNTEST/Q2) MAXLEN(50)', 40] });
  assert(r.status === 200, r.text);
  const l = await api('GET', '/api/v1/dataqueues?lib=CONNTEST');
  assert(l.json.some((q) => q.name === 'Q2'), l.text);
});
await step('qsh', 'QSH: system, db2, ls, tuberías', async () => {
  const r = await api('POST', '/api/v1/qsh', { script: "system \"DSPDTAQ DTAQ(CONNTEST/Q1)\"\ndb2 \"select count(*) from demolib.customer\"\nls /QSYS.LIB/DEMOLIB.LIB | grep -i pgm | wc -l" });
  assert(r.json.exitCode === 0 && /record\(s\) selected/.test(r.json.output), r.text);
});
await step('spool', 'Spool a PDF', async () => {
  await api('POST', '/api/v1/commands', { command: 'CALL PGM(DEMOLIB/CUSTLIST)' });
  const l = await api('GET', '/api/v1/spool');
  const s = l.json.filter((x) => x.NAME === 'QSYSPRT').pop();
  assert(s, l.text);
  const r = await fetch(`${BASE}/api/v1/spool/${s.ID}?format=pdf`, { headers: AUTH });
  const b = Buffer.from(await r.arrayBuffer());
  assert(r.status === 200 && b.subarray(0, 5).toString() === '%PDF-', `pdf ${r.status}`);
});

// ---------------- XMLSERVICE / IWS / SOAP ----------------
await step('xmlservice', 'XMLCGI: <cmd>, <sql>, <sh> y <pgm>', async () => {
  const xmlin = `<?xml version='1.0'?><script><cmd>CHGLIBL LIBL(DEMOLIB QGPL QTEMP)</cmd><sql><query>select custno, name from customer where custno &lt; 3</query><fetch block='all' desc='on'/></sql><sh>echo hola</sh>
<pgm name='QCMDEXC' lib='QSYS'><parm io='in'><data type='80a'>CRTDTAQ DTAQ(CONNTEST/XQ) MAXLEN(10)</data></parm><parm io='in'><data type='15p5'>80</data></parm></pgm></script>`;
  const r = await fetch(`${BASE}/cgi-bin/xmlcgi.pgm`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ db2: '*LOCAL', uid: USER, pwd: PWD, ipc: '*NA', ctl: '*here', xmlin, xmlout: '500000' }) });
  const t = await r.text();
  assert(/\+\+\+ success CHGLIBL/.test(t), t);
  assert(/<data desc='NAME'><!\[CDATA\[ACME CORPORATION/.test(t), t);
  assert(/<sh><!\[CDATA\[hola/.test(t), t);
  assert(/\+\+\+ success QSYS QCMDEXC/.test(t), t);
});
await step('iws', 'IWS REST + SOAP + WSDL de un programa', async () => {
  await api('POST', '/api/v1/commands', { command: "ADDIWSSVC SERVICE(cmdexec) PGM(QSYS/QCMDEXC) METHOD(POST) PATH('/')" });
  const w = await fetch(`${BASE}/web/services/cmdexec?wsdl`).then((x) => x.text());
  assert(/wsdl:definitions/.test(w) && /name="cmd"/.test(w), w.slice(0, 300));
  const list = await fetch(`${BASE}/web/services`).then((x) => x.json());
  assert(list.some((s) => s.name === 'cmdexec'), JSON.stringify(list));
  // REST: JSON con los parámetros por nombre
  let r = await api('POST', '/web/services/cmdexec', { cmd: 'CRTDTAQ DTAQ(CONNTEST/IWSQ) MAXLEN(10)', len: 38 });
  assert(r.status === 200, r.text);
  // SOAP
  const env = '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><qcmdexc><cmd>DLTDTAQ DTAQ(CONNTEST/IWSQ)</cmd><len>27</len></qcmdexc></soapenv:Body></soapenv:Envelope>';
  r = await api('POST', '/web/services/cmdexec', env, { 'Content-Type': 'text/xml', SOAPAction: 'urn:qcmdexc' });
  assert(r.status === 200 && /qcmdexcResponse/.test(r.text), r.text);
});

// ---------------- FTP ----------------
function ftpClient(port = PORT.ftp) {
  const s = net.connect(port, H);
  let buf = '';
  const waiters = [];
  s.on('data', (d) => {
    buf += d;
    for (;;) {
      const m = /^(\d{3}) [^\r\n]*\r?\n/m.exec(buf);
      if (!m) break;
      const end = m.index + m[0].length;
      const resp = buf.slice(0, end);
      buf = buf.slice(end);
      const w = waiters.shift();
      if (w) w(resp);
    }
  });
  const read = () => new Promise((res) => waiters.push(res));
  return {
    s, read,
    async cmd(c) { s.write(`${c}\r\n`); return read(); },
    async pasv() {
      const r = await this.cmd('EPSV');
      const port2 = Number(/\|\|\|(\d+)\|/.exec(r)[1]);
      return net.connect(port2, H);
    },
    async data(cmd, upload) {
      const d = await this.pasv();
      await new Promise((res) => d.once('connect', res));
      const p = read();
      s.write(`${cmd}\r\n`);
      const first = await p;
      if (!/^150/.test(first)) { d.destroy(); return { first, text: '' }; }
      if (upload !== undefined) d.end(upload);
      const chunks = [];
      await new Promise((res) => { d.on('data', (c) => chunks.push(c)); d.on('close', res); });
      const done = await read();
      return { first, done, text: Buffer.concat(chunks).toString() };
    },
  };
}
await step('ftp', 'Login, SYST, NAMEFMT 0 (BIB/ARCHIVO.MIEMBRO), RETR/STOR de miembros, NAMEFMT 1, IFS y RCMD', async () => {
  const f = ftpClient();
  assert(/^220/.test(await f.read()), 'saludo');
  assert(/^331/.test(await f.cmd(`USER ${USER}`)), 'user');
  assert(/^230/.test(await f.cmd(`PASS ${PWD}`)), 'pass');
  assert(/OS\/400/.test(await f.cmd('SYST')), 'syst');
  assert(/current library/.test(await f.cmd('CWD DEMOLIB')), 'cwd lib');
  let r = await f.data('NLST');
  assert(/QRPGLESRC/.test(r.text), r.text);
  r = await f.data('RETR QRPGLESRC.HELLO');
  assert(/Hola, /.test(r.text), r.text.slice(0, 120));
  await f.cmd('RCMD CRTSRCPF FILE(CONNTEST/QTXTSRC)');
  r = await f.data('STOR CONNTEST/QTXTSRC.NOTA', 'linea uno\r\nlinea dos\r\n');
  assert(/^226/.test(r.done), r.done);
  r = await f.data('RETR CONNTEST/QTXTSRC.NOTA');
  assert(r.text.includes('linea dos'), r.text);
  assert(/naming format "1"/.test(await f.cmd('SITE NAMEFMT 1')), 'namefmt');
  assert(/^250/.test(await f.cmd('CWD /tmp')), 'cwd /tmp');
  r = await f.data('STOR ftp.txt', 'archivo por FTP');
  r = await f.data('RETR /tmp/ftp.txt');
  assert(r.text === 'archivo por FTP', r.text);
  r = await f.data('LIST /QSYS.LIB/DEMOLIB.LIB');
  assert(/CUSTOMER\.FILE/.test(r.text), r.text);
  assert(/^250/.test(await f.cmd('RCMD SNDMSG MSG(\'hola por FTP\') TOUSR(QSYSOPR)')), 'rcmd');
  await f.cmd('QUIT');
});

// ---------------- REXEC ----------------
await step('rexec', 'Mandato CL y QSH por REXEC', async () => {
  const run = (cmd) => new Promise((res, rej) => {
    const s = net.connect(PORT.rexec, H, () => s.write(Buffer.from(`\0${USER}\0${PWD}\0${cmd}\0`)));
    const chunks = [];
    s.on('data', (d) => chunks.push(d));
    s.on('end', () => res(Buffer.concat(chunks)));
    s.on('error', rej);
  });
  let b = await run('CHKOBJ OBJ(DEMOLIB/CUSTOMER) OBJTYPE(*FILE)');
  assert(b[0] === 0, b.toString());
  b = await run('qsh echo $USER');
  assert(b.subarray(1).toString().trim() === USER, b.toString());
  b = await run('CHKOBJ OBJ(DEMOLIB/NOEXISTE) OBJTYPE(*FILE)');
  assert(b[0] === 0 && /CPF9801/.test(b.toString()), b.toString());
});

// ---------------- Mapepire ----------------
await step('mapepire', 'connect, sql con paginación (sqlmore), prepare_sql_execute, cl', async () => {
  const ws = new WebSocket(`wss://${H}:${PORT.mapepire}/db/`, { headers: { authorization: `Basic ${Buffer.from(`${USER}:${PWD}`).toString('base64')}` }, rejectUnauthorized: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(String(d)); pending.get(m.id)?.(m); });
  let n = 0;
  const send = (o) => new Promise((res) => { const id = `t${++n}`; pending.set(id, res); ws.send(JSON.stringify({ id, ...o })); });
  let r = await send({ type: 'connect', technique: 'tcp', application: 'conntest', props: 'libraries=DEMOLIB' });
  assert(r.success && /QZDASOINIT/.test(r.job), JSON.stringify(r));
  r = await send({ type: 'sql', sql: 'select custno, name from customer order by custno', rows: 5 });
  assert(r.success && r.data.length === 5 && !r.is_done && r.metadata.columns[1].name === 'NAME', JSON.stringify(r).slice(0, 300));
  const more = await send({ type: 'sqlmore', cont_id: r.id, rows: 100 });
  assert(more.success && more.is_done && more.data.length === 15, JSON.stringify(more).slice(0, 300));
  r = await send({ type: 'prepare_sql_execute', sql: 'select name from customer where custno = ?', parameters: [12], rows: 10 });
  assert(String(r.data[0].NAME).trim() === 'BIG BLUE SYSTEMS', JSON.stringify(r));
  r = await send({ type: 'cl', cmd: 'CHKOBJ OBJ(DEMOLIB/NOEXISTE) OBJTYPE(*PGM)' });
  assert(!r.success && r.data.some((m) => m.id === 'CPF9801'), JSON.stringify(r));
  r = await send({ type: 'getversion' });
  assert(r.success && r.version, JSON.stringify(r));
  ws.close();
});

// ---------------- TN5250 ----------------
await step('telnet', 'Negociación TN5250, pantalla Sign On en EBCDIC, inicio de sesión y menú', async () => {
  const { fromEbcdic, toEbcdic } = await import('../services/ibmi-core/src/net/tn5250/ebcdic.js');
  const s = net.connect(PORT.telnet, H);
  const IAC = 255;
  let screen = Array(1920).fill(' ');
  let records = [];
  let buf = [];
  let iac = false, sb = null, verb = 0;
  const onRecord = (rec) => {
    // GDS: LL(2) 12A0 flow(2) varlen flags res opcode
    const d = rec.subarray(6 + rec[6]);
    let i = 0, pos = 0;
    while (i < d.length) {
      if (d[i] === 0x04) {
        const c = d[i + 1];
        if (c === 0x40) { screen = Array(1920).fill(' '); i += 2; continue; }
        if (c === 0x11 || c === 0x52) { i += 4; continue; }
        if (c === 0xf3) { i += 2 + ((d[i + 2] << 8) | d[i + 3]); continue; }
        i += 2; continue;
      }
      if (d[i] === 0x11) { pos = (d[i + 1] - 1) * 80 + (d[i + 2] - 1); i += 3; continue; }
      if (d[i] === 0x13) { i += 3; continue; }
      if (d[i] === 0x1d) { i += 1; while ((d[i] & 0xe0) !== 0x20) i += 2; pos++; i += 3; continue; }
      if (d[i] < 0x40) { pos++; i++; continue; }
      screen[pos++] = fromEbcdic(d, 37, i, i + 1);
      i++;
    }
    records.push(rec);
  };
  s.on('data', (chunk) => {
    for (const b of chunk) {
      if (sb) { if (iac) { iac = false; if (b === 240) { const opt = sb[0]; if (opt === 24) s.write(Buffer.from([IAC, 250, 24, 0, ...Buffer.from('IBM-3179-2'), IAC, 240])); if (opt === 39) s.write(Buffer.from([IAC, 250, 39, 0, 0, ...Buffer.from('DEVNAME'), 1, ...Buffer.from('CONNTST01'), IAC, 240])); sb = null; } continue; } if (b === IAC) { iac = true; continue; } sb.push(b); continue; }
      if (verb) { if (verb === 253) s.write(Buffer.from([IAC, 251, b])); if (verb === 251) s.write(Buffer.from([IAC, 253, b])); verb = 0; continue; }
      if (iac) { iac = false; if (b === IAC) { buf.push(IAC); continue; } if (b === 239) { onRecord(Buffer.from(buf)); buf = []; continue; } if (b === 250) { sb = []; continue; } if (b >= 251) { verb = b; continue; } continue; }
      if (b === IAC) { iac = true; continue; }
      buf.push(b);
    }
  });
  const text = () => Array.from({ length: 24 }, (_, r) => screen.slice(r * 80, r * 80 + 80).join('')).join('\n');
  const waitFor = async (re, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(text())) return; await new Promise((r) => setTimeout(r, 200)); } throw new Error(`No apareció ${re}:\n${text()}`); };
  await waitFor(/Sign On/);
  assert(/CONNTST01/.test(text()), `DEVNAME no usado:\n${text()}`);
  // Respuesta: fila, col, AID Enter, SBA campo usuario (6,54) + datos, SBA contraseña (7,54)
  const field = (r, c, v) => [0x11, r, c, ...toEbcdic(v)];
  const data = Buffer.from([6, 54, 0xf1, ...field(6, 54, USER), ...field(7, 54, PWD)]);
  const len = 10 + data.length;
  const rec = Buffer.concat([Buffer.from([len >> 8, len & 255, 0x12, 0xa0, 0, 0, 4, 0, 0, 3]), data]);
  s.write(Buffer.concat([rec, Buffer.from([IAC, 239])]));
  await waitFor(/IBM i Main Menu/);
  s.destroy();
});

// ---------------- Core bancario ----------------
if (!ONLY.length || ONLY.includes('banco')) {
  const { bankTests } = await import('./bank.mjs').catch(() => ({ bankTests: null }));
  if (bankTests) await bankTests({ step, assert, api, H, PORT, AUTH, BASE });
}

// Limpieza
if (!ONLY.length) await api('POST', '/api/v1/commands', { command: 'DLTLIB LIB(CONNTEST)' });
console.log(`\n${passed} correctas, ${failures} fallidas`);
process.exit(failures ? 1 : 0);
