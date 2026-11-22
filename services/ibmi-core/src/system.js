// Estado global del sistema: nombre, subsistemas, trabajos activos, métricas y fechas.
import os from 'node:os';
import { msgText } from './messages.js';

export const SYS = {
  name: (process.env.SYSTEM_NAME || 'AS400TDS').toUpperCase().slice(0, 8),
  model: '9009-42A',
  serial: '78A1B2C',
  release: 'V7R5M0',
  iplAt: Date.now(),
  status: 'IPL', // IPL -> READY
  iplStep: 'Storage management recovery',
};

export const pad2 = (n) => String(n).padStart(2, '0');
export function sysDate(d = new Date()) { return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${String(d.getFullYear()).slice(2)}`; }
export function sysTime(d = new Date()) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }

export const SUBSYSTEMS = ['QBATCH', 'QCMN', 'QCTL', 'QHTTPSVR', 'QINTER', 'QSERVER', 'QSPL', 'QSYSWRK', 'QUSRWRK'];

let nextNumber = 300000 + Math.floor(Math.random() * 100000);
const jobs = new Map();
const ended = [];

export function createJob({ name, user, type = 'INT', subsystem = 'QINTER', fn = '', status = 'RUN', system = false }) {
  const number = String(nextNumber++).padStart(6, '0');
  const job = {
    number, name, user, type, subsystem, function: fn, status,
    system, startedAt: Date.now(), cpuMs: 0, cpuMark: 0, cpuPct: 0, busySince: null,
    joblog: [], activations: new Map(), cancel: false, priority: type === 'BCH' ? 50 : 20, pool: type === 'BCH' ? 3 : 2,
    threads: 1, aux: 0, spoolSeq: 0, curlib: null, libl: [],
  };
  jobs.set(number, job);
  if (!system) {
    const d = new Date();
    logJob(job, 'CPF1124', '*INFO', msgText('CPF1124', number, user, name, sysDate(d), sysTime(d), subsystem));
  }
  return job;
}

export function qualifiedJob(job) { return `${job.number}/${job.user}/${job.name}`; }

export const jobEndHooks = [];
export function endJob(job, code = 0) {
  if (!jobs.has(job.number)) return;
  for (const h of jobEndHooks) { try { h(job, code); } catch (e) { console.error('[job] end hook', e); } }
  const d = new Date();
  logJob(job, 'CPF1164', '*COMP', msgText('CPF1164', job.number, job.user, job.name, sysDate(d), sysTime(d), (job.cpuMs / 1000).toFixed(3)));
  job.status = 'END';
  job.endedAt = Date.now();
  job.endCode = code;
  jobs.delete(job.number);
  ended.push(job);
  if (ended.length > 200) ended.shift();
}

export function logJob(job, id, type, text, extra = {}) {
  job.joblog.push({ id, type, text, time: Date.now(), sev: extra.sev ?? 0, from: extra.from || '', ...extra });
  if (job.joblog.length > 2000) job.joblog.shift();
}

// Marca de CPU: el trabajo acumula tiempo mientras está en RUN.
export function setStatus(job, status, fn) {
  if (!job) return;
  const now = Date.now();
  if (job.status === 'RUN' && job.busySince) job.cpuMs += now - job.busySince;
  job.busySince = status === 'RUN' ? now : null;
  job.status = status;
  if (fn !== undefined) job.function = fn;
}

export function allJobs() { return [...jobs.values()]; }
export function findJob(number) { return jobs.get(String(number).padStart(6, '0')) || null; }
export function endedJobs() { return ended; }

// Trabajos de sistema permanentes (se muestran en WRKACTJOB).
const SYSTEM_JOBS = [
  ['QBATCH', 'QBATCH', 'QSYS', 'SBS', '', 'DEQW'],
  ['QCMN', 'QCMN', 'QSYS', 'SBS', '', 'DEQW'],
  ['QCTL', 'QCTL', 'QSYS', 'SBS', '', 'DEQW'],
  ['QCTL', 'QSYSSCD', 'QPGMR', 'BCH', 'PGM-QEZSCNEP', 'EVTW'],
  ['QHTTPSVR', 'QHTTPSVR', 'QSYS', 'SBS', '', 'DEQW'],
  ['QHTTPSVR', 'ADMIN', 'QTMHHTTP', 'BCH', 'PGM-QZHBMAIN', 'SIGW'],
  ['QINTER', 'QINTER', 'QSYS', 'SBS', '', 'DEQW'],
  ['QSERVER', 'QSERVER', 'QSYS', 'SBS', '', 'DEQW'],
  ['QSERVER', 'QPWFSERVSD', 'QUSER', 'BCH', '', 'SELW'],
  ['QSERVER', 'QSERVER', 'QPGMR', 'ASJ', '', 'EVTW'],
  ['QSPL', 'QSPL', 'QSYS', 'SBS', '', 'DEQW'],
  ['QSPL', 'PRT01', 'QSPLJOB', 'WTR', 'PGM-QSPWTR', 'MSGW'],
  ['QSYSWRK', 'QSYSWRK', 'QSYS', 'SBS', '', 'DEQW'],
  ['QSYSWRK', 'QSQSRVR', 'QUSER', 'PJ', '', 'TIMW'],
  ['QSYSWRK', 'QRPGCOMP', 'QSYS', 'BCH', 'PGM-QRNXCOMP', 'DEQW'],
  ['QSYSWRK', 'QYPSJSVR', 'QYPSJSVR', 'BCH', 'JVM-com.ibm.as', 'SIGW'],
  ['QSYSWRK', 'QZDASOINIT', 'QUSER', 'PJ', '', 'TIMW'],
  ['QUSRWRK', 'QUSRWRK', 'QSYS', 'SBS', '', 'DEQW'],
  ['QUSRWRK', 'QZSCSRVS', 'QUSER', 'PJ', '', 'TIMW'],
];

export function initSystemJobs() {
  for (const [sbs, name, user, type, fn, status] of SYSTEM_JOBS) {
    const j = createJob({ name, user, type, subsystem: sbs, fn, status, system: true });
    j.startedAt = SYS.iplAt;
  }
}

// Métricas reales del proceso para WRKSYSSTS / WRKACTJOB.
let lastCpu = process.cpuUsage();
let lastAt = Date.now();
export const metrics = { cpuPct: 0, history: [], ext: { gateway: null, compiler: null } };

export function sampleMetrics() {
  const now = Date.now();
  const cpu = process.cpuUsage(lastCpu);
  const el = now - lastAt;
  lastCpu = process.cpuUsage();
  lastAt = now;
  const ours = ((cpu.user + cpu.system) / 1000) / el * 100;
  metrics.cpuPct = Math.min(99.9, +(ours / Math.max(os.cpus().length, 1) + Math.random() * 0.4).toFixed(1));
  for (const j of jobs.values()) {
    let ms = j.cpuMs;
    if (j.status === 'RUN' && j.busySince) ms += now - j.busySince;
    j.cpuPct = Math.min(99.9, +(((ms - j.cpuMark) / el) * 100).toFixed(1));
    j.cpuMark = ms;
    if (j.system) {
      j.cpuPct = Math.random() < 0.15 ? +(Math.random() * 0.3).toFixed(1) : 0;
    }
  }
  // Los trabajos QSQSRVR reflejan la actividad real del DB2 Gateway
  const g = metrics.ext.gateway;
  for (const j of jobs.values()) {
    if (j.name === 'QSQSRVR' && g) {
      const last = g.history?.[g.history.length - 1];
      j.status = g.inflight > 0 || (last && last.qps > 0) ? 'RUN' : 'TIMW';
      j.cpuPct = last ? Math.min(99.9, +(last.qps * 0.05).toFixed(1)) : 0;
    }
    if (j.name === 'QRPGCOMP' && metrics.ext.compiler) {
      j.status = metrics.ext.compiler.inflight?.length ? 'RUN' : 'DEQW';
    }
  }
  metrics.history.push({ t: now, cpu: metrics.cpuPct, jobs: jobs.size });
  if (metrics.history.length > 300) metrics.history.shift();
}

export function systemStatus() {
  const mem = process.memoryUsage();
  const total = os.totalmem();
  return {
    name: SYS.name, release: SYS.release, model: SYS.model, serial: SYS.serial, status: SYS.status,
    iplAt: SYS.iplAt, uptime: Math.round((Date.now() - SYS.iplAt) / 1000),
    cpuPct: metrics.cpuPct, jobs: jobs.size, cpus: os.cpus().length,
    memTotal: total, memFree: os.freemem(), rss: mem.rss, heapUsed: mem.heapUsed,
    aspUsedPct: +(((total - os.freemem()) / total) * 100).toFixed(4),
  };
}
