// Servidores TCP/IP del sistema (STRTCPSVR/ENDTCPSVR) y tabla de conexiones (NETSTAT).
// Cada servidor tiene un trabajo daemon visible en WRKACTJOB y cuenta conexiones y bytes reales.
import { EventEmitter } from 'node:events';
import { createJob, endJob, setStatus } from '../system.js';

export const netEvents = new EventEmitter();
netEvents.setMaxListeners(100);

const defs = new Map(); // '*TELNET' -> def
const state = new Map(); // '*TELNET' -> {active, handles, job, startedAt, error, accepted, bytesIn, bytesOut}
const conns = new Map(); // id -> conexión
let connSeq = 0;

/**
 * Define un servidor:
 * { key:'*TELNET', title, job:'QTVTELNET', user:'QTCP', subsystem:'QSYSWRK', ports:[{port, proto:'tcp'|'udp', tls, label}],
 *   autostart:true, start: async (ctl) => handle|handle[], stop: async (handles) => {} }
 * ctl = { track(socket, info) } para registrar conexiones.
 */
export function defineServer(def) {
  defs.set(def.key, { autostart: true, user: 'QTCP', subsystem: 'QSYSWRK', ports: [], ...def });
  state.set(def.key, { active: false, handles: [], job: null, startedAt: null, error: null, accepted: 0, bytesIn: 0, bytesOut: 0, rejected: 0 });
}

export function serverKeys() { return [...defs.keys()]; }
export function serverDef(key) { return defs.get(key); }

export async function startServer(key) {
  const d = defs.get(key);
  const st = state.get(key);
  if (!d) throw Object.assign(new Error(`Server ${key} not valid.`), { msgId: 'TCP1A13' });
  if (st.active) return false;
  st.error = null;
  try {
    const ctl = controller(key);
    const h = await d.start(ctl);
    st.handles = Array.isArray(h) ? h : h ? [h] : [];
    st.active = true;
    st.startedAt = Date.now();
    st.job = createJob({ name: d.job, user: d.user, type: 'BCH', subsystem: d.subsystem, fn: d.fn || `PGM-${d.job}`, status: 'SELW', system: true });
    netEvents.emit('server', { key, active: true });
    console.log(`[tcp] ${key} activo en ${d.ports.map((p) => `${p.port}/${p.proto || 'tcp'}${p.tls ? '+tls' : ''}`).join(', ')}`);
    return true;
  } catch (e) {
    st.error = e.message;
    console.error(`[tcp] ${key} no pudo arrancar: ${e.message}`);
    throw e;
  }
}

export async function stopServer(key) {
  const d = defs.get(key);
  const st = state.get(key);
  if (!d) throw Object.assign(new Error(`Server ${key} not valid.`), { msgId: 'TCP1A13' });
  if (!st.active) return false;
  for (const c of [...conns.values()]) if (c.server === key) { try { c.socket?.destroy(); } catch { /* ignorar */ } conns.delete(c.id); }
  try {
    if (d.stop) await d.stop(st.handles);
    else for (const h of st.handles) await new Promise((r) => { try { h.close(() => r()); } catch { r(); } setTimeout(r, 1500); });
  } finally {
    st.active = false;
    st.handles = [];
    if (st.job) { endJob(st.job); st.job = null; }
    netEvents.emit('server', { key, active: false });
  }
  return true;
}

export async function startAll() {
  for (const [key, d] of defs) {
    if (!d.autostart) continue;
    if (process.env[`DISABLE_${key.replace('*', '')}`] === '1') continue;
    await startServer(key).catch(() => {});
  }
}

function controller(key) {
  return {
    /** Registra una conexión TCP: cuenta bytes, aparece en NETSTAT y se elimina al cerrarse. */
    track(socket, info = {}) {
      const st = state.get(key);
      const id = ++connSeq;
      const c = {
        id, server: key, socket, proto: 'tcp',
        local: `${socket.localAddress?.replace('::ffff:', '') || '*'}:${socket.localPort || info.localPort || ''}`,
        remote: `${socket.remoteAddress?.replace('::ffff:', '') || '?'}:${socket.remotePort || ''}`,
        remoteAddress: socket.remoteAddress?.replace('::ffff:', '') || '?',
        localPort: socket.localPort || info.localPort, startedAt: Date.now(), lastActivity: Date.now(),
        bytesIn: 0, bytesOut: 0, user: info.user || '', job: info.job || null, state: 'ESTABLISHED', detail: info.detail || '',
      };
      conns.set(id, c);
      st.accepted++;
      socket.on('data', (b) => { c.bytesIn += b.length; st.bytesIn += b.length; c.lastActivity = Date.now(); });
      const w = socket.write;
      socket.write = function patchedWrite(chunk, ...rest) {
        const n = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk?.length || 0;
        c.bytesOut += n; st.bytesOut += n; c.lastActivity = Date.now();
        return w.call(this, chunk, ...rest);
      };
      socket.once('close', () => { conns.delete(id); netEvents.emit('conn', { key, id, closed: true }); });
      netEvents.emit('conn', { key, id, remote: c.remote });
      return c;
    },
    /** Conexiones sin socket propio (WebSocket sobre HTTP, UDP): se registran y retiran a mano. */
    virtual(info = {}) {
      const st = state.get(key);
      const id = ++connSeq;
      const c = { id, server: key, proto: info.proto || 'tcp', local: info.local || '*', remote: info.remote || '?', remoteAddress: info.remote || '?', startedAt: Date.now(), lastActivity: Date.now(), bytesIn: 0, bytesOut: 0, user: info.user || '', state: info.state || 'ESTABLISHED', detail: info.detail || '' };
      conns.set(id, c);
      st.accepted++;
      return { conn: c, count(inB = 0, outB = 0) { c.bytesIn += inB; c.bytesOut += outB; st.bytesIn += inB; st.bytesOut += outB; c.lastActivity = Date.now(); }, close() { conns.delete(id); } };
    },
    reject() { state.get(key).rejected++; },
    stats: () => state.get(key),
  };
}

/** Termina una conexión (NETSTAT opción 4). */
export function endConnection(id) {
  const c = conns.get(Number(id));
  if (!c) return false;
  try { c.socket?.destroy(); } catch { /* ignorar */ }
  conns.delete(c.id);
  return true;
}

/** Asocia usuario/trabajo a una conexión ya registrada. */
export function tagConnection(c, { user, job, detail } = {}) {
  if (!c) return;
  if (user !== undefined) c.user = user;
  if (job !== undefined) c.job = job;
  if (detail !== undefined) c.detail = detail;
}

export function serverStatus() {
  return [...defs.values()].map((d) => {
    const st = state.get(d.key);
    const active = [...conns.values()].filter((c) => c.server === d.key);
    return {
      key: d.key, title: d.title, job: d.job, ports: d.ports, active: st.active, startedAt: st.startedAt, error: st.error,
      accepted: st.accepted, rejected: st.rejected, bytesIn: st.bytesIn, bytesOut: st.bytesOut, connections: active.length,
      jobNumber: st.job?.number || null, autostart: d.autostart,
    };
  });
}

export function connections() {
  return [...conns.values()].map((c) => ({
    id: c.id, server: c.server, proto: c.proto, local: c.local, remote: c.remote, state: c.state, user: c.user,
    job: c.job ? `${c.job.number}/${c.job.user}/${c.job.name}` : '', startedAt: c.startedAt, lastActivity: c.lastActivity,
    bytesIn: c.bytesIn, bytesOut: c.bytesOut, detail: c.detail,
  }));
}

/** Filas de NETSTAT *CNN: escuchas + conexiones establecidas. */
export function netstatRows() {
  const rows = [];
  for (const d of defs.values()) {
    if (!state.get(d.key).active) continue;
    for (const p of d.ports) rows.push({ remote: '*', rport: '*', local: p.port, state: p.proto === 'udp' ? '*UDP' : 'Listen', server: d.key, user: d.user, idle: 0, bytesIn: 0, bytesOut: 0 });
  }
  for (const c of conns.values()) {
    rows.push({ remote: c.remoteAddress, rport: c.remote.split(':').pop(), local: c.localPort || c.local.split(':').pop(), state: c.state === 'ESTABLISHED' ? 'Established' : c.state, server: c.server, user: c.user, idle: Math.round((Date.now() - c.lastActivity) / 1000), bytesIn: c.bytesIn, bytesOut: c.bytesOut, id: c.id });
  }
  return rows;
}

/** Puerto local de escucha de un servidor (para mensajes y paneles). */
export function portOf(key, label) {
  const d = defs.get(key);
  if (!d) return null;
  const p = label ? d.ports.find((x) => x.label === label) : d.ports[0];
  return p ? p.port : null;
}

export { setStatus };
