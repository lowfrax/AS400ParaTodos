// Servicios TCP/IP adicionales de IBM i:
//  *SNMP  agente SNMP v1/v2c (UDP 161): MIB-II system + Host Resources (CPU, memoria, trabajos) para Nagios/Zabbix/PRTG.
//  *NTP   servidor SNTP (UDP 123): los clientes pueden sincronizar la hora con el sistema.
//  *LPD   servidor de impresión LPD/LPR (TCP 515): otros sistemas imprimen en colas de salida (spool) del IBM i.
//  Planificador de trabajos: ADDJOBSCDE / WRKJOBSCDE / RMVJOBSCDE / HLDJOBSCDE / RLSJOBSCDE.
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { addServer } from './index.js';
import { listen } from './telnet.js';
import { SYS, systemStatus, allJobs, createJob, endJob } from '../system.js';
import { createSpool, getUser } from '../objects.js';
import { def } from '../commands/registry.js';
import { CLError } from '../messages.js';
import { Panel, padR } from '../panel.js';
import * as ifs from '../ifs.js';

// ======================= SNMP =======================
const T = { INT: 0x02, STR: 0x04, NULL: 0x05, OID: 0x06, SEQ: 0x30, IP: 0x40, COUNTER: 0x41, GAUGE: 0x42, TICKS: 0x43, NOSUCH: 0x80, END: 0x82 };
function berLen(n) { if (n < 128) return Buffer.from([n]); const b = []; while (n > 0) { b.unshift(n & 255); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); }
function tlv(type, body) { return Buffer.concat([Buffer.from([type]), berLen(body.length), body]); }
function encInt(v, type = T.INT) {
  let n = BigInt(Math.trunc(v));
  const out = [];
  do { out.unshift(Number(n & 255n)); n >>= 8n; } while (n > 0n && n !== -1n);
  if (type === T.INT && out[0] & 0x80 && v >= 0) out.unshift(0);
  if (type !== T.INT && out[0] & 0x80) out.unshift(0);
  return tlv(type, Buffer.from(out));
}
function encOid(oid) {
  const p = oid.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const x of p.slice(2)) { const b = []; let v = x; do { b.unshift(v & 127); v >>= 7; } while (v > 0); for (let i = 0; i < b.length - 1; i++) b[i] |= 128; out.push(...b); }
  return tlv(T.OID, Buffer.from(out));
}
function decode(buf, pos = 0) {
  const type = buf[pos];
  let len = buf[pos + 1];
  let hl = 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | buf[pos + 2 + i]; hl = 2 + n; }
  return { type, pos, start: pos + hl, end: pos + hl + len, next: pos + hl + len };
}
function children(buf, node) { const out = []; let p = node.start; while (p < node.end) { const c = decode(buf, p); out.push(c); p = c.next; } return out; }
const intOf = (buf, n) => { let v = 0; for (let i = n.start; i < n.end; i++) v = v * 256 + buf[i]; return v; };
function oidOf(buf, n) {
  const b = buf.subarray(n.start, n.end);
  const out = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = (v << 7) | (b[i] & 127); if (!(b[i] & 128)) { out.push(v); v = 0; } }
  return out.join('.');
}
const cmpOid = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { if (x[i] === undefined) return -1; if (y[i] === undefined) return 1; if (x[i] !== y[i]) return x[i] - y[i]; } return 0; };

function mib() {
  const s = systemStatus();
  const up = Math.round((Date.now() - SYS.iplAt) / 10);
  const str = (v) => tlv(T.STR, Buffer.from(String(v)));
  const m = {
    '1.3.6.1.2.1.1.1.0': str(`IBM OS/400 ${SYS.release} (AS400 para Todos) ${SYS.model} ${SYS.serial}`),
    '1.3.6.1.2.1.1.2.0': encOid('1.3.6.1.4.1.2.6.11'),
    '1.3.6.1.2.1.1.3.0': encInt(up, T.TICKS),
    '1.3.6.1.2.1.1.4.0': str(process.env.SNMP_CONTACT || 'QSECOFR'),
    '1.3.6.1.2.1.1.5.0': str(SYS.name),
    '1.3.6.1.2.1.1.6.0': str(process.env.SNMP_LOCATION || 'Docker'),
    '1.3.6.1.2.1.1.7.0': encInt(72),
    '1.3.6.1.2.1.25.1.1.0': encInt(up, T.TICKS),
    '1.3.6.1.2.1.25.1.5.0': encInt(allJobs().filter((j) => j.type === 'INT').length, T.GAUGE),
    '1.3.6.1.2.1.25.1.6.0': encInt(allJobs().length, T.GAUGE),
    '1.3.6.1.2.1.25.2.2.0': encInt(Math.round(os.totalmem() / 1024)),
    '1.3.6.1.2.1.25.3.3.1.2.1': encInt(Math.round(s.cpuPct)),
    // MIB privada de ejemplo (enterprise IBM 2.6.11): uso de CPU (décimas de %), trabajos, ASP usado (centésimas de %)
    '1.3.6.1.4.1.2.6.11.1.1.0': encInt(Math.round(s.cpuPct * 10), T.GAUGE),
    '1.3.6.1.4.1.2.6.11.1.2.0': encInt(s.jobs, T.GAUGE),
    '1.3.6.1.4.1.2.6.11.1.3.0': encInt(Math.round(s.aspUsedPct * 100), T.GAUGE),
  };
  return m;
}

function snmpResponse(buf, community) {
  const top = decode(buf, 0);
  const [ver, comm, pdu] = children(buf, top);
  const version = intOf(buf, ver);
  if (buf.subarray(comm.start, comm.end).toString() !== community) return null;
  const [reqId, , , vbl] = children(buf, pdu);
  const nonRep = pdu.type === 0xa5 ? intOf(buf, children(buf, pdu)[1]) : 0;
  const maxRep = pdu.type === 0xa5 ? intOf(buf, children(buf, pdu)[2]) : 1;
  const m = mib();
  const keys = Object.keys(m).sort(cmpOid);
  const out = [];
  let error = 0;
  let errIdx = 0;
  children(buf, vbl).forEach((vb, idx) => {
    const oid = oidOf(buf, children(buf, vb)[0]);
    const nextOf = (o) => keys.find((k) => cmpOid(k, o) > 0);
    if (pdu.type === 0xa0) {
      if (m[oid]) out.push([oid, m[oid]]); else if (version === 0) { error = 2; errIdx = idx + 1; out.push([oid, tlv(T.NULL, Buffer.alloc(0))]); } else out.push([oid, tlv(T.NOSUCH, Buffer.alloc(0))]);
    } else {
      const reps = pdu.type === 0xa5 && idx >= nonRep ? maxRep : 1;
      let o = oid;
      for (let r = 0; r < reps; r++) {
        const n = nextOf(o);
        if (!n) { if (version === 0) { error = 2; errIdx = idx + 1; out.push([o, tlv(T.NULL, Buffer.alloc(0))]); } else out.push([o, tlv(T.END, Buffer.alloc(0))]); break; }
        out.push([n, m[n]]);
        o = n;
      }
    }
  });
  const vbs = tlv(T.SEQ, Buffer.concat(out.map(([o, v]) => tlv(T.SEQ, Buffer.concat([encOid(o), v])))));
  const resp = tlv(0xa2, Buffer.concat([buf.subarray(reqId.pos, reqId.end), encInt(error), encInt(errIdx), vbs]));
  return tlv(T.SEQ, Buffer.concat([encInt(version), tlv(T.STR, Buffer.from(community)), resp]));
}

function snmpDef() {
  const port = Number(process.env.SNMP_PORT || 161);
  return {
    key: '*SNMP', title: 'SNMP agent', job: 'QTMSNMP', subsystem: 'QSYSWRK', fn: 'PGM-QTOSMAIN', ports: [{ port, proto: 'udp', label: 'snmp' }],
    async start(ctl) {
      const s = dgram.createSocket('udp4');
      s.on('message', (msg, rinfo) => {
        const v = ctl.virtual({ proto: 'udp', remote: rinfo.address, local: `*:${port}`, detail: 'SNMP' });
        try {
          const r = snmpResponse(msg, process.env.SNMP_COMMUNITY || 'public');
          v.count(msg.length, r ? r.length : 0);
          if (r) s.send(r, rinfo.port, rinfo.address); else ctl.reject();
        } catch { ctl.reject(); }
        setTimeout(() => v.close(), 2000);
      });
      await new Promise((res, rej) => { s.once('error', rej); s.bind(port, '0.0.0.0', res); });
      return { close: (cb) => s.close(cb) };
    },
  };
}

// ======================= NTP (SNTP v4) =======================
function ntpDef() {
  const port = Number(process.env.NTP_PORT || 123);
  return {
    key: '*NTP', title: 'NTP / SNTP server', job: 'QTOTNTP', subsystem: 'QSYSWRK', fn: 'PGM-QTOTNTP', ports: [{ port, proto: 'udp', label: 'ntp' }],
    async start(ctl) {
      const s = dgram.createSocket('udp4');
      const ntpTime = (ms, buf, off) => { const secs = Math.floor(ms / 1000) + 2208988800; const frac = Math.floor(((ms % 1000) / 1000) * 2 ** 32); buf.writeUInt32BE(secs >>> 0, off); buf.writeUInt32BE(frac >>> 0, off + 4); };
      s.on('message', (msg, rinfo) => {
        if (msg.length < 48) return;
        const recv = Date.now();
        const r = Buffer.alloc(48);
        r[0] = (0 << 6) | ((msg[0] >> 3) & 7) << 3 | 4; // LI=0, versión del cliente, modo 4 (servidor)
        r[1] = 2; r[2] = msg[2]; r[3] = 0xec;
        r.write('LOCL', 12, 'ascii');
        ntpTime(SYS.iplAt, r, 16);
        msg.copy(r, 24, 40, 48); // originate = transmit del cliente
        ntpTime(recv, r, 32);
        ntpTime(Date.now(), r, 40);
        s.send(r, rinfo.port, rinfo.address);
        const v = ctl.virtual({ proto: 'udp', remote: rinfo.address, local: `*:${port}`, detail: 'NTP' });
        v.count(48, 48);
        setTimeout(() => v.close(), 1000);
      });
      await new Promise((res, rej) => { s.once('error', rej); s.bind(port, '0.0.0.0', res); });
      return { close: (cb) => s.close(cb) };
    },
  };
}

// ======================= LPD (RFC 1179) =======================
function lpdDef() {
  const port = Number(process.env.LPD_PORT || 515);
  return {
    key: '*LPD', title: 'LPD print server', job: 'QTLPD00000', subsystem: 'QSYSWRK', fn: 'PGM-QTMPLPD', ports: [{ port, label: 'lpd' }],
    async start(ctl) {
      const srv = net.createServer((sock) => {
        ctl.track(sock, { detail: 'LPD' });
        let buf = Buffer.alloc(0);
        let mode = 'cmd';
        let queue = 'QPRINT';
        let need = 0;
        let fileKind = '';
        let control = '';
        const datas = [];
        const ack = () => sock.write(Buffer.from([0]));
        const finish = async () => {
          const user = (/^P(.*)$/m.exec(control)?.[1] || 'QTCP').toUpperCase().slice(0, 10);
          const name = (/^J(.*)$/m.exec(control)?.[1] || /^N(.*)$/m.exec(control)?.[1] || 'LPDJOB').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10) || 'LPDJOB';
          const job = createJob({ name: 'QPRTJOB', user: (await getUser(user)) ? user : 'QTCP', type: 'BCH', subsystem: 'QSPL', fn: 'PGM-QTMPLPD', system: true });
          for (const d of datas) {
            const lines = d.toString('latin1').replace(/\f/g, '\n').replace(/\r\n/g, '\n').split('\n');
            await createSpool(job, name, lines, { usrdta: 'LPD', outq: queue.toUpperCase().slice(0, 10) }).catch((e) => console.error('[lpd]', e.message));
          }
          endJob(job);
        };
        sock.on('data', (d) => {
          buf = Buffer.concat([buf, d]);
          for (;;) {
            if (mode === 'data') {
              if (buf.length < need + 1) return;
              const chunk = buf.subarray(0, need);
              buf = buf.subarray(need + 1);
              if (fileKind === 'c') control = chunk.toString('latin1'); else datas.push(chunk);
              ack();
              mode = 'sub';
              continue;
            }
            const nl = buf.indexOf(10);
            if (nl < 0) return;
            const line = buf.subarray(0, nl).toString('latin1');
            buf = buf.subarray(nl + 1);
            const code = line.charCodeAt(0);
            const rest = line.slice(1);
            if (mode === 'cmd') {
              if (code === 2) { queue = rest.trim() || 'QPRINT'; mode = 'sub'; ack(); continue; }
              if (code === 3 || code === 4) { sock.end(`${queue}: ${SYS.name} LPD ready\n`); return; }
              if (code === 1 || code === 5) { ack(); sock.end(); return; }
              sock.end(Buffer.from([1]));
              return;
            }
            // Subórdenes de recepción de trabajo
            if (code === 1) { ack(); continue; }
            if (code === 2 || code === 3) { const [count] = rest.split(' '); need = Number(count); fileKind = code === 2 ? 'c' : 'd'; mode = 'data'; ack(); continue; }
          }
        });
        sock.on('end', () => { if (datas.length) finish(); });
        sock.on('error', () => {});
      });
      await listen(srv, port);
      return srv;
    },
  };
}

// ======================= Planificador de trabajos =======================
const SCDE_FILE = '/QIBM/UserData/OS/jobscde.json';
async function loadScde() { try { return JSON.parse((await ifs.readFile(SCDE_FILE)).toString('utf8')); } catch { return []; } }
async function saveScde(e) { await ifs.writeFile(SCDE_FILE, JSON.stringify(e, null, 2)); }
const DAYS = ['*SUN', '*MON', '*TUE', '*WED', '*THU', '*FRI', '*SAT'];

function due(e, now) {
  if (e.status === 'HLD') return false;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  if (String(e.scdtime).slice(0, 4) !== hhmm) return false;
  const stamp = `${now.toISOString().slice(0, 10)}T${hhmm}`;
  if (e.lastRun === stamp) return false;
  if (e.frq === '*ONCE') return !e.lastRun && (!e.scddate || e.scddate === '*CURRENT' || e.scddate === now.toISOString().slice(0, 10));
  if (e.frq === '*MONTHLY') return Number(e.scddate?.slice(-2) || 1) === now.getDate();
  const days = e.scdday || ['*ALL'];
  return days.includes('*ALL') || days.includes(DAYS[now.getDay()]);
}

function startScheduler() {
  setInterval(async () => {
    const list = await loadScde();
    const now = new Date();
    let changed = false;
    for (const e of list) {
      if (!due(e, now)) continue;
      e.lastRun = `${now.toISOString().slice(0, 10)}T${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      changed = true;
      try {
        const { serverCtx, endServerCtx } = await import('../svc/jobs.js');
        const { submitJob } = await import('../runtime/build.js');
        const ctx = await serverCtx(e.user || 'QSECOFR', { name: 'QJOBSCD', subsystem: 'QCTL', type: 'BCH' });
        await submitJob(ctx, e.cmd, e.job);
        setTimeout(() => endServerCtx(ctx), 2000);
        console.log(`[scd] ${e.job}: ${e.cmd}`);
      } catch (err) { console.error(`[scd] ${e.job}: ${err.message}`); }
      if (e.frq === '*ONCE') e.status = 'SCD-DONE';
    }
    if (changed) await saveScde(list);
  }, 20000).unref();
}

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
def('ADDJOBSCDE', 'Add Job Schedule Entry', [
  P('JOB', 'Job name', 'name', 10, { req: true }), P('CMD', 'Command to run', 'cmd', 512, { req: true, promptLen: 120 }),
  P('FRQ', 'Frequency', 'char', 8, { req: true, choices: '*ONCE, *WEEKLY, *MONTHLY', values: ['*ONCE', '*WEEKLY', '*MONTHLY'] }),
  P('SCDDATE', 'Schedule date', 'char', 10, { dft: '*NONE', choices: 'Date, *CURRENT, *NONE' }), P('SCDDAY', 'Schedule day', 'list', 40, { dft: '*NONE', choices: '*NONE, *ALL, *MON…' }),
  P('SCDTIME', 'Schedule time', 'char', 8, { dft: '*CURRENT', choices: 'HHMMSS' }), P('USER', 'User', 'name', 10, { dft: '*CURRENT' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' }),
], async (ctx, a) => {
  const list = await loadScde();
  if (list.some((e) => e.job === a.JOB)) throw new CLError('CPF1628', `Job schedule entry ${a.JOB} already exists.`);
  const t = a.SCDTIME === '*CURRENT' ? `${String(new Date().getHours()).padStart(2, '0')}${String(new Date().getMinutes() + 1).padStart(2, '0')}00` : String(a.SCDTIME).replace(/[:.]/g, '').padEnd(6, '0');
  const days = a.SCDDAY.filter((d) => d !== '*NONE');
  list.push({ job: a.JOB, cmd: a.CMD, frq: a.FRQ, scddate: a.SCDDATE, scdday: days.length ? days : ['*ALL'], scdtime: t, user: a.USER === '*CURRENT' ? ctx.job.user : a.USER, text: a.TEXT === '*BLANK' ? '' : a.TEXT, status: 'SCD', created: new Date().toISOString() });
  await saveScde(list);
  return { id: 'CPC1238', text: `Job schedule entry ${a.JOB} number 000001 added.` };
});
def('RMVJOBSCDE', 'Remove Job Schedule Entry', [P('JOB', 'Job name', 'name', 10, { req: true })], async (ctx, a) => {
  const list = await loadScde();
  const n = list.filter((e) => e.job !== a.JOB);
  if (n.length === list.length) throw new CLError('CPF1629', `Job schedule entry ${a.JOB} not found.`);
  await saveScde(n);
  return { id: 'CPC1239', text: `Job schedule entry ${a.JOB} removed.` };
});
for (const [cmd, st, txt] of [['HLDJOBSCDE', 'HLD', 'held'], ['RLSJOBSCDE', 'SCD', 'released']]) {
  def(cmd, `${txt === 'held' ? 'Hold' : 'Release'} Job Schedule Entry`, [P('JOB', 'Job name', 'name', 10, { req: true })], async (ctx, a) => {
    const list = await loadScde();
    const e = list.find((x) => x.job === a.JOB);
    if (!e) throw new CLError('CPF1629', `Job schedule entry ${a.JOB} not found.`);
    e.status = st;
    await saveScde(list);
    return { text: `Job schedule entry ${a.JOB} ${txt}.` };
  });
}
def('WRKJOBSCDE', 'Work with Job Schedule Entries', [], async (ctx) => {
  const list = await loadScde();
  if (!ctx.interactive) return { text: list.map((e) => `${e.job} ${e.frq} ${e.scdtime} ${e.status}`).join('; ') || 'No entries.' };
  const p = new Panel({ fn: 'CMD-WRKJOBSCDE', keys: ['F3', 'F5', 'F12'] });
  p.title('Work with Job Schedule Entries');
  p.sysName();
  p.text(4, 2, 'Type options, press Enter.', 'b');
  p.text(5, 4, '2=Change   3=Hold   4=Remove   5=Display details   6=Release', 'b');
  p.text(7, 37, '-----Schedule------', 'w');
  p.text(8, 2, 'Opt  Job         Status   Date     Time      Frequency    Recovery', 'w');
  list.slice(0, 12).forEach((e, i) => p.text(9 + i, 7, padR(e.job, 11)).text(9 + i, 19, padR(e.status, 8)).text(9 + i, 28, padR(e.scddate === '*NONE' ? 'USER DEF' : e.scddate, 8)).text(9 + i, 37, `${e.scdtime.slice(0, 2)}:${e.scdtime.slice(2, 4)}:${e.scdtime.slice(4, 6)}`).text(9 + i, 47, padR(e.frq, 12)).text(9 + i, 60, '*SBMRLS'));
  if (!list.length) p.text(9, 7, '(No job schedule entries)');
  p.more(21, false);
  p.fkeys('F3=Exit   F5=Refresh   F6=Add   F12=Cancel');
  await ctx.display(p);
  return null;
}, { interactive: true });

export async function register() {
  addServer(snmpDef);
  addServer(ntpDef);
  addServer(lpdDef);
  // Entrada de planificación por omisión: cierre diario del banco a las 23:00 (retenida; RLSJOBSCDE para activarla)
  const list = await loadScde();
  if (!list.some((e) => e.job === 'CIERREBNK')) {
    list.push({ job: 'CIERREBNK', cmd: 'CALL PGM(BANCO/BNKCIERRE)', frq: '*WEEKLY', scddate: '*NONE', scdday: ['*ALL'], scdtime: '230000', user: 'QSECOFR', text: 'Cierre diario del banco', status: 'HLD', created: new Date().toISOString() });
    await saveScde(list);
  }
  startScheduler();
}
