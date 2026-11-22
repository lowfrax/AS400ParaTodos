// Servidores host de IBM i Access (QSERVER/QUSRWRK): los usan jt400 (Java: JDBC, CommandCall, ProgramCall, DataQueue),
// IBM i Access Client Solutions, el controlador ODBC de IBM i y .NET.
//   449  as-svrmap   mapeador de puertos ("as-signon" → 8476)
//   8476 as-signon   validación de usuario (semillas + sustituto SHA-1)
//   8475 as-rmtcmd   mandatos CL y llamadas a programas (QZRCSRVS)
//   8472 as-dtaq     colas de datos (QZHQSSRV)
//   8471 as-database SQL / JDBC / ODBC (QZDASOINIT) — ver database.js
//   8470 as-central  (atributos básicos)
// Cada uno también con TLS en 9470-9476.
import net from 'node:net';
import tls from 'node:tls';
import { addServer } from '../index.js';
import { listen } from '../telnet.js';
import { tagConnection } from '../servers.js';
import { SERVER_ID, reply, parseCPs, frameReader, u16, u32, ebc, unebc, seed, hostDate, decodeText, utf16be } from './ds.js';
import { verifySubstitute, RC } from './auth.js';
import { serverCtx, endServerCtx } from '../../svc/jobs.js';
import { qualifiedJob, SYS } from '../../system.js';
import { handleRmtcmd } from './rmtcmd.js';
import { handleDtaq } from './dtaq.js';

const BASE = () => Number(process.env.HOSTSVR_BASE || 8470);
const SSL_BASE = () => Number(process.env.HOSTSVR_SSL_BASE || 9470);
const PUBLIC_BASE = () => Number(process.env.HOSTSVR_PUBLIC_BASE || BASE());
const PUBLIC_SSL_BASE = () => Number(process.env.HOSTSVR_PUBLIC_SSL_BASE || SSL_BASE());
const OFFSET = { 'as-central': 0, 'as-database': 1, 'as-dtaq': 2, 'as-file': 3, 'as-netprt': 4, 'as-rmtcmd': 5, 'as-signon': 6 };
const VERSION = 0x00070500; // V7R5M0

// ---------- as-svrmap (449) ----------
function svrmapDef() {
  const port = Number(process.env.HOSTSVR_MAP_PORT || 449);
  return {
    key: '*SVRMAP', title: 'Host server port mapper', job: 'QZSOSMAPD', subsystem: 'QSYSWRK', fn: 'PGM-QZSOSMAPD', ports: [{ port, label: 'as-svrmap' }],
    async start(ctl) {
      const s = net.createServer((sock) => {
        ctl.track(sock, { detail: 'as-svrmap' });
        sock.once('data', (d) => {
          const name = d.toString('latin1').trim().toLowerCase();
          const ssl = name.endsWith('-s');
          const base = name.replace(/-s$/, '');
          let p = null;
          if (OFFSET[base] !== undefined) p = (ssl ? PUBLIC_SSL_BASE() : PUBLIC_BASE()) + OFFSET[base];
          else if (base === 'drda' || base === 'as-ddm') p = Number(process.env.DRDA_PUBLIC_PORT || 446);
          else if (base === 'telnet') p = 23;
          else if (base === 'as-svrmap') p = port;
          if (p) sock.end(Buffer.concat([Buffer.from([0x2b]), u32(p)])); else sock.end(Buffer.from([0x2d, 0, 0, 0, 0]));
        });
        sock.on('error', () => {});
      });
      await listen(s, port);
      return s;
    },
  };
}

// ---------- Inicio de servidor común (semillas + 0x7002) para central, database, dtaq, rmtcmd ----------
const JOBS = { [SERVER_ID.CENTRAL]: 'QZSCSRVS', [SERVER_ID.DATABASE]: 'QZDASOINIT', [SERVER_ID.DTAQ]: 'QZHQSSRV', [SERVER_ID.RMTCMD]: 'QZRCSRVS', [SERVER_ID.FILE]: 'QPWFSERVSO', [SERVER_ID.NETPRT]: 'QNPSERVS' };

function hostServer(serviceName, serverId, handler) {
  return (ctl, sock) => {
    const conn = ctl.track(sock, { detail: serviceName });
    const st = { serverId, serverSeed: seed(), clientSeed: null, prf: null, ctx: null, conn, sock, remote: conn.remoteAddress };
    const write = (b) => { try { sock.write(b); } catch { /* cerrado */ } };
    sock.on('close', () => { if (st.ctx) { if (st.ctx.job.cmt?.tx) st.ctx.rollback().catch(() => {}); endServerCtx(st.ctx); } st.onClose?.(); });
    sock.on('error', () => {});
    frameReader(sock, async (f) => {
      const rr = f.readUInt16BE(18);
      if (rr === 0x7001) { // intercambio de semillas
        st.clientSeed = Buffer.from(f.subarray(20, 28));
        write(reply(f, serverId, 0xf001, Buffer.concat([u32(0), st.serverSeed])));
        return;
      }
      if (rr === 0x7002) { // inicio de servidor (autenticación)
        const authType = f[20];
        const cps = parseCPs(f, 22);
        const auth = cps.get(0x1105) || cps.get(0x1115) || Buffer.alloc(0);
        const uid = cps.get(0x1104) || Buffer.alloc(10, 0x40);
        const r = await verifySubstitute(uid, authType, auth, st.serverSeed, st.clientSeed || Buffer.alloc(8), { service: serviceName.toUpperCase(), remote: st.remote });
        if (r.rc !== RC.OK) { write(reply(f, serverId, 0xf002, u32(r.rc))); return; }
        st.prf = r.prf;
        st.ctx = await serverCtx(r.prf, { name: JOBS[serverId] || 'QZSOSIGN', subsystem: serverId === SERVER_ID.DATABASE ? 'QUSRWRK' : 'QSYSWRK', type: 'PJ', fn: `PGM-${JOBS[serverId] || 'QZSO'}` });
        tagConnection(conn, { user: r.prf.NAME, job: st.ctx.job, detail: serviceName });
        const jobName = ebc(qualifiedJob(st.ctx.job));
        write(reply(f, serverId, 0xf002, u32(0), [[0x1104, Buffer.concat([u32(37), ebc(r.prf.NAME, 10)])], [0x111f, Buffer.concat([u32(37), jobName])]]));
        return;
      }
      if (!st.prf) { sock.destroy(); return; }
      await handler(st, f, write);
    });
  };
}

// ---------- as-signon (8476) ----------
function signonHandler(ctl, sock) {
  const conn = ctl.track(sock, { detail: 'as-signon' });
  const st = { serverSeed: seed(), clientSeed: Buffer.alloc(8) };
  const write = (b) => { try { sock.write(b); } catch { /* cerrado */ } };
  sock.on('error', () => {});
  frameReader(sock, async (f) => {
    const rr = f.readUInt16BE(18);
    const sid = f.readUInt16BE(6);
    if (rr === 0x7003 || rr === 0x7103) { // atributos de intercambio
      const cps = parseCPs(f, 20);
      if (cps.get(0x1103)) st.clientSeed = Buffer.from(cps.get(0x1103).subarray(0, 8));
      const job = ebc('QZSOSIGN/QUSER/000000');
      write(reply(f, sid, rr === 0x7103 ? 0xf103 : 0xf003, u32(0), [
        [0x1101, u32(VERSION)], [0x1102, u16(10)], [0x1103, st.serverSeed], [0x1119, Buffer.from([2])], [0x111f, Buffer.concat([u32(37), job])],
      ]));
      return;
    }
    if (rr === 0x7004) { // información de inicio de sesión
      const authType = f[20];
      const cps = parseCPs(f, 21);
      const auth = cps.get(0x1105) || cps.get(0x1115) || Buffer.alloc(0);
      const uid = cps.get(0x1104) || Buffer.alloc(10, 0x40);
      const r = await verifySubstitute(uid, authType, auth, st.serverSeed, st.clientSeed, { service: 'SIGNON', remote: conn.remoteAddress });
      if (r.rc !== RC.OK) { write(reply(f, SERVER_ID.SIGNON, 0xf004, u32(r.rc))); return; }
      tagConnection(conn, { user: r.prf.NAME, detail: 'as-signon' });
      const last = r.prf.LASTSIGN ? new Date(String(r.prf.LASTSIGN).replace(' ', 'T')) : new Date();
      const exp = new Date(Date.now() + 365 * 864e5);
      write(reply(f, SERVER_ID.SIGNON, 0xf004, u32(0), [
        [0x1106, hostDate(new Date())], [0x1107, hostDate(last)], [0x1108, hostDate(exp)], [0x1114, u32(37)],
        [0x1104, Buffer.concat([u32(37), ebc(r.prf.NAME, 10)])],
      ]));
      return;
    }
    if (rr === 0x7005) { // cambio de contraseña: no soportado por este protocolo (usar CHGPWD / API REST)
      write(reply(f, SERVER_ID.SIGNON, 0xf005, u32(0x00030016)));
      return;
    }
    if (rr === 0x7007) { // generar token de perfil: no soportado
      write(reply(f, SERVER_ID.SIGNON, 0xf007, u32(0x00010003)));
      return;
    }
    // Cualquier otra petición: código de "petición no válida"
    write(reply(f, sid, rr | 0x8000, u32(0x00010001)));
  });
}

// ---------- as-central (8470): atributos mínimos ----------
async function centralHandler(st, f, write) {
  const rr = f.readUInt16BE(18);
  // 0x1101 intercambio de atributos / 0x1201 gestión de licencias / 0x1301 NLS: respuesta correcta con CCSID 37
  write(reply(f, SERVER_ID.CENTRAL, rr | 0x8000, Buffer.concat([u16(0), u32(37), ebc('2924'), u32(1), u16(10)])));
}

function def(key, title, service, job, onConn) {
  const off = OFFSET[service];
  return (api) => ({
    key, title, job, subsystem: 'QSYSWRK', fn: `PGM-${job}`,
    ports: [{ port: BASE() + off, label: service }, { port: SSL_BASE() + off, tls: true, label: `${service}-s` }],
    async start(ctl) {
      const handles = [];
      const plain = net.createServer((s) => onConn(ctl, s));
      await listen(plain, BASE() + off);
      handles.push(plain);
      const creds = api.tls?.();
      if (creds) {
        const secure = tls.createServer({ key: creds.key, cert: creds.cert }, (s) => onConn(ctl, s));
        await listen(secure, SSL_BASE() + off).then(() => handles.push(secure)).catch((e) => console.error(`[tcp] ${service}-s: ${e.message}`));
      }
      return handles;
    },
  });
}

export async function register() {
  addServer(svrmapDef);
  addServer(def('*SIGNON', 'Host server: sign-on', 'as-signon', 'QZSOSIGN', signonHandler));
  addServer(def('*CENTRAL', 'Host server: central', 'as-central', 'QZSCSRVS', hostServer('as-central', SERVER_ID.CENTRAL, centralHandler)));
  addServer(def('*RMTCMD', 'Host server: remote command/program call', 'as-rmtcmd', 'QZRCSRVS', hostServer('as-rmtcmd', SERVER_ID.RMTCMD, handleRmtcmd)));
  addServer(def('*DTAQ', 'Host server: data queues', 'as-dtaq', 'QZHQSSRV', hostServer('as-dtaq', SERVER_ID.DTAQ, handleDtaq)));
  try {
    const { handleDatabase } = await import('./database.js');
    addServer(def('*DATABASE', 'Host server: database (JDBC/ODBC)', 'as-database', 'QZDASOINIT', hostServer('as-database', SERVER_ID.DATABASE, handleDatabase)));
  } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') console.error('[hostsvr] database:', e.message); }
}

export { decodeText, utf16be, SYS };
