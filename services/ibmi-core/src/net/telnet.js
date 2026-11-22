// Servidor TELNET TN5250 (RFC 1205 / RFC 2877 / RFC 4777): permite conectar emuladores reales
// (IBM i Access Client Solutions, tn5250j, tn5250, Mocha TN5250, Rumba…) a las mismas sesiones del sistema.
// Puerto 23 en claro y 992 con TLS. La negociación (TERMINAL-TYPE, EOR, BINARY, NEW-ENVIRON) sigue la de IBM i.
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { encodeScreen, decodeRecord, record, queryCommand, OPCODE, FLAG } from './tn5250/stream.js';
import { tagConnection } from './servers.js';

const IAC = 0xff, DONT = 0xfe, DO = 0xfd, WONT = 0xfc, WILL = 0xfb, SB = 0xfa, SE = 0xf0, EOR = 0xef, IP = 0xf4, AO = 0xf5, AYT = 0xf6, BRK = 0xf3;
const OPT = { BINARY: 0, TTYPE: 24, EOR: 25, NEW_ENVIRON: 39 };
const ENV = { IS: 0, SEND: 1, INFO: 2, VAR: 0, VALUE: 1, ESC: 2, USERVAR: 3 };

// Tipos de terminal 5250 aceptados (pantalla 24x80; los de 27x132 también muestran 24x80).
const TERMINALS = /^IBM-(3179-2|3180-2|3196-A1|3477-F[CG]|3486-BA|3487-H[ACGM]|5251-11|5291-1|5292-2|5555-[BC]01)/i;

/** Terminal 5250 sobre un socket: se comporta como el WebSocket del emulador web para la clase Session. */
class TnTerminal extends EventEmitter {
  constructor(socket, { ccsid, termType, env }) {
    super();
    this.socket = socket;
    this.ccsid = ccsid;
    this.termType = termType;
    this.env = env;
    this.fields = [];
    this.mw = false;
    this.closed = false;
  }
  write5250(opcode, data, flags = 0) {
    if (this.closed) return;
    const rec = record(opcode, data, flags);
    const parts = [];
    for (const b of rec) { parts.push(b); if (b === IAC) parts.push(IAC); }
    parts.push(IAC, EOR);
    this.socket.write(Buffer.from(parts));
  }
  // Session.send(JSON) → flujo 5250
  send(json) {
    let m;
    try { m = JSON.parse(json); } catch { return; }
    if (m.t === 'screen') {
      if (typeof m.mw === 'boolean') this.mw = m.mw;
      const { data, fields } = encodeScreen(m, { ccsid: this.ccsid, mw: this.mw });
      this.fields = fields;
      this.write5250(m.lock ? OPCODE.OUTPUT_ONLY : OPCODE.PUT_GET, data);
    } else if (m.t === 'mw') {
      this.mw = !!m.on;
      this.write5250(m.on ? OPCODE.MSG_ON : OPCODE.MSG_OFF, Buffer.alloc(0));
    }
  }
  // Registro 5250 recibido → mensaje {t:'aid'} para Session
  onRecord(buf) {
    const r = decodeRecord(buf, { ccsid: this.ccsid });
    if (!r) return;
    if (r.flags & FLAG.SRQ) { this.emit('message', JSON.stringify({ t: 'sysreq' })); return; }
    if (r.flags & FLAG.ATN) { this.emit('message', JSON.stringify({ t: 'attn' })); return; }
    if (!r.aid || r.aid === 'SFREPLY' || r.aid === 'INQUIRY') return;
    const fields = {};
    const changed = [];
    for (const f of this.fields) fields[f.n] = f.value.replace(/\s+$/, '');
    for (const md of r.mdt) {
      const f = this.fields.find((x) => x.row === md.row && x.col === md.col);
      if (!f) continue;
      fields[f.n] = md.text.padEnd(f.len).slice(0, f.len).replace(/\s+$/, '');
      changed.push(f.n);
    }
    this.emit('message', JSON.stringify({ t: 'aid', aid: r.aid === 'RECBKSP' ? 'ENTER' : r.aid, cursor: r.cursor, fields, changed }));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(); } catch { /* ignorar */ }
    this.emit('close');
  }
}

/** Gestiona una conexión TELNET: negociación de opciones y paso de registros EOR. */
function handleConnection(socket, ctl, api) {
  const conn = ctl.track(socket, { detail: 'negotiating' });
  socket.setNoDelay(true);
  const st = { ttype: null, env: {}, eor: false, binary: false, started: false, buf: [], sb: null, iac: false, verb: 0 };
  let term = null;
  const send = (...b) => { try { socket.write(Buffer.from(b)); } catch { /* ignorar */ } };

  send(IAC, DO, OPT.NEW_ENVIRON, IAC, DO, OPT.TTYPE);
  const fallback = setTimeout(() => { if (!st.started) start(); }, 6000);

  function maybeStart() { if (!st.started && st.ttype && st.eor && st.binary) start(); }

  function start() {
    st.started = true;
    clearTimeout(fallback);
    if (!st.ttype || !TERMINALS.test(st.ttype)) {
      // Cliente de línea (telnet de Windows/Linux, PuTTY…): IBM i exige un terminal 5250 en este puerto.
      const msg = `\r\nAS400 para Todos - IBM i TELNET server\r\nTerminal type "${st.ttype || 'unknown'}" is not a 5250 display station.\r\n` +
        'Use a TN5250 emulator (IBM i Access Client Solutions, tn5250j, tn5250) with terminal type IBM-3179-2,\r\n' +
        'or the web emulator at http://<host>:5250/ .\r\n\r\n';
      socket.end(msg);
      return;
    }
    const ccsid = Number(api.ccsid?.() || process.env.TELNET_CCSID || 37);
    term = new TnTerminal(socket, { ccsid, termType: st.ttype, env: st.env });
    const devname = String(st.env.DEVNAME || '').toUpperCase().replace(/[^A-Z0-9_#@$]/g, '').slice(0, 10);
    const session = api.attachSession(term, socket.remoteAddress?.replace('::ffff:', ''), { device: devname || null, kind: 'tn5250', termType: st.ttype, tls: !!socket.encrypted });
    tagConnection(conn, { detail: `${st.ttype} ${session.device}` });
    session.onJob = (job) => tagConnection(conn, { user: job?.user || '', job: job || null });
    // Consulta de capacidades 5250 (la respuesta se ignora, como hacen muchos hosts).
    term.write5250(OPCODE.NOOP, queryCommand());
  }

  function onCommand(verb, opt) {
    if (verb === WILL) {
      if (opt === OPT.NEW_ENVIRON) send(IAC, SB, OPT.NEW_ENVIRON, ENV.SEND, ENV.VAR, ENV.USERVAR, IAC, SE);
      else if (opt === OPT.TTYPE) send(IAC, SB, OPT.TTYPE, ENV.SEND, IAC, SE);
      else if (opt === OPT.EOR) { st.eor = true; maybeStart(); }
      else if (opt === OPT.BINARY) { st.binary = true; maybeStart(); }
      else send(IAC, DONT, opt);
    } else if (verb === WONT) {
      if (opt === OPT.TTYPE) start();
    } else if (verb === DO) {
      if (opt !== OPT.EOR && opt !== OPT.BINARY) send(IAC, WONT, opt);
    }
  }

  function onSub(data) {
    const opt = data[0];
    if (opt === OPT.TTYPE && data[1] === ENV.IS) {
      st.ttype = Buffer.from(data.slice(2)).toString('ascii').trim().toUpperCase();
      send(IAC, DO, OPT.EOR, IAC, WILL, OPT.EOR, IAC, DO, OPT.BINARY, IAC, WILL, OPT.BINARY);
      maybeStart();
    } else if (opt === OPT.NEW_ENVIRON && (data[1] === ENV.IS || data[1] === ENV.INFO)) {
      let i = 2, name = null, cur = null, mode = null;
      const flush = () => { if (name !== null) st.env[name.toUpperCase()] = cur ?? ''; name = null; cur = null; };
      while (i < data.length) {
        let b = data[i++];
        if (b === ENV.VAR || b === ENV.USERVAR) { flush(); name = ''; mode = 'name'; continue; }
        if (b === ENV.VALUE) { cur = ''; mode = 'value'; continue; }
        if (b === ENV.ESC && i < data.length) b = data[i++];
        const ch = String.fromCharCode(b);
        if (mode === 'name') name += ch; else if (mode === 'value') cur += ch;
      }
      flush();
    }
  }

  socket.on('data', (chunk) => {
    for (const b of chunk) {
      if (st.sb) {
        if (st.iac) {
          st.iac = false;
          if (b === SE) { onSub(st.sb); st.sb = null; continue; }
          if (b === IAC) { st.sb.push(IAC); continue; }
          continue;
        }
        if (b === IAC) { st.iac = true; continue; }
        st.sb.push(b);
        continue;
      }
      if (st.verb) { onCommand(st.verb, b); st.verb = 0; continue; }
      if (st.iac) {
        st.iac = false;
        if (b === IAC) { st.buf.push(IAC); continue; }
        if (b === EOR) { const rec = Buffer.from(st.buf); st.buf = []; if (term) term.onRecord(rec); continue; }
        if (b === SB) { st.sb = []; continue; }
        if (b === WILL || b === WONT || b === DO || b === DONT) { st.verb = b; continue; }
        if (b === IP || b === BRK) { if (term) term.emit('message', JSON.stringify({ t: 'attn' })); continue; }
        if (b === AYT) { send(...Buffer.from('\r\n[Yes]\r\n')); continue; }
        if (b === AO) continue;
        continue;
      }
      if (b === IAC) { st.iac = true; continue; }
      st.buf.push(b);
      if (st.buf.length > 65536) st.buf = [];
    }
  });
  const done = () => { clearTimeout(fallback); if (term) term.close(); };
  socket.on('close', done);
  socket.on('error', done);
  socket.setTimeout(Number(process.env.TELNET_IDLE_TIMEOUT || 0) * 1000 || 0);
}

export function telnetServerDef(api) {
  const port = Number(process.env.TELNET_PORT || 23);
  const sport = Number(process.env.TELNETS_PORT || 992);
  return {
    key: '*TELNET', title: 'TELNET (TN5250)', job: 'QTVTELNET', subsystem: 'QSYSWRK', fn: 'PGM-QTVTELNET',
    ports: [{ port, proto: 'tcp', label: 'telnet' }, { port: sport, proto: 'tcp', tls: true, label: 'telnet-ssl' }],
    async start(ctl) {
      const handles = [];
      const plain = net.createServer((s) => handleConnection(s, ctl, api));
      await listen(plain, port);
      handles.push(plain);
      const creds = api.tls?.();
      if (creds) {
        const secure = tls.createServer({ key: creds.key, cert: creds.cert }, (s) => handleConnection(s, ctl, api));
        secure.on('tlsClientError', () => ctl.reject());
        await listen(secure, sport).then(() => handles.push(secure)).catch((e) => console.error(`[tcp] TELNET-SSL ${sport}: ${e.message}`));
      }
      return handles;
    },
  };
}

export function listen(server, port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}
