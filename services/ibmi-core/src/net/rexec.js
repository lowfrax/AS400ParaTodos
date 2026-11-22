// Servidor REXEC (puerto 512, STRTCPSVR *REXEC): ejecución remota de mandatos CL o de QSH (prefijo "qsh ").
// Protocolo BSD rexec: [puerto stderr]\0 usuario\0 contraseña\0 mandato\0 → \0 + salida | \1 + error.
import net from 'node:net';
import { authenticate } from '../svc/auth.js';
import { serverCtx, endServerCtx, runCmd } from '../svc/jobs.js';
import { tagConnection } from './servers.js';
import { listen } from './telnet.js';
import { runQsh } from './qsh.js';

function handle(socket, ctl) {
  const conn = ctl.track(socket, { detail: 'REXEC' });
  let buf = Buffer.alloc(0);
  let done = false;
  socket.setTimeout(30000, () => socket.destroy());
  socket.on('data', async (d) => {
    if (done) return;
    buf = Buffer.concat([buf, d]);
    const parts = [];
    let start = 0;
    for (let i = 0; i < buf.length && parts.length < 4; i++) if (buf[i] === 0) { parts.push(buf.subarray(start, i).toString('utf8')); start = i + 1; }
    if (parts.length < 4) return;
    done = true;
    const [, user, pwd, command] = parts;
    let ctx = null;
    try {
      const prf = await authenticate(user, pwd, { service: 'REXEC', remote: conn.remoteAddress });
      ctx = await serverCtx(prf, { name: 'QTRXC00001', subsystem: 'QSYSWRK', type: 'BCH', fn: 'PGM-QTMXRXCS' });
      tagConnection(conn, { user: prf.NAME, job: ctx.job, detail: command.slice(0, 60) });
      socket.write(Buffer.from([0]));
      if (/^\s*(qsh|sh|bash)\b/i.test(command)) {
        const out = await runQsh(ctx, command.replace(/^\s*(qsh|sh|bash)\s*(-c\s*)?/i, '').replace(/^["']|["']$/g, ''));
        socket.end(out.text.replace(/\n/g, '\r\n'));
      } else {
        const r = await runCmd(ctx, command.trim());
        const lines = r.ok ? r.messages.map((m) => `${m.id ? `${m.id}: ` : ''}${m.text}`) : [`${r.error.id}: ${r.error.text}`];
        if (r.ok && !lines.length) lines.push(`Command ${command.trim().split(/\s|\(/)[0].toUpperCase()} completed.`);
        socket.end(`${lines.join('\r\n')}\r\n`);
      }
    } catch (e) {
      socket.end(Buffer.concat([Buffer.from([1]), Buffer.from(`${e.msgId ? `${e.msgId}: ` : ''}${e.message}\n`)]));
    } finally {
      if (ctx) endServerCtx(ctx);
    }
  });
  socket.on('error', () => {});
}

export function rexecServerDef() {
  const port = Number(process.env.REXEC_PORT || 512);
  return {
    key: '*REXEC', title: 'REXEC', job: 'QTRXC00001', subsystem: 'QSYSWRK', fn: 'PGM-QTMXRXCS',
    ports: [{ port, label: 'rexec' }],
    async start(ctl) {
      const s = net.createServer((sock) => handle(sock, ctl));
      await listen(s, port);
      return s;
    },
  };
}
