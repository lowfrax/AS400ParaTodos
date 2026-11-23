// Servidor SSH (STRTCPSVR *SSHD, puerto 22): como el OpenSSH de IBM i (5733-SC1).
//   - Autenticación por contraseña del perfil de usuario y por clave pública (~/.ssh/authorized_keys en el IFS).
//   - exec y shell interactiva (con pty) sobre QSH: system "CL", db2 "SQL", ls, cat…
//   - Subsistema SFTP sobre el IFS, incluido /QSYS.LIB (bibliotecas, archivos fuente y miembros .MBR).
// La clave de host se genera una vez y se guarda en /QOpenSys/QIBM/UserData/SC1/OpenSSH/etc.
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { authenticate } from '../svc/auth.js';
import { serverCtx, endServerCtx } from '../svc/jobs.js';
import { getUser } from '../objects.js';
import { tagConnection } from './servers.js';
import { listen } from './telnet.js';
import { Qsh } from './qsh.js';
import * as ifs from '../ifs.js';
import { parseQsysPath, listQsys, readQsysMember, writeQsysMember } from '../qsyslib.js';
import { SYS, logJob } from '../system.js';

let ssh2 = null;
async function loadSsh2() {
  if (!ssh2) ssh2 = (await import('ssh2')).default;
  return ssh2;
}

const KEY_DIR = '/QOpenSys/QIBM/UserData/SC1/OpenSSH/etc';
function hostKey() {
  const file = ifs.real(`${KEY_DIR}/ssh_host_rsa_key`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  fs.writeFileSync(file, privateKey, { mode: 0o600 });
  return Buffer.from(privateKey);
}

async function authorizedKeys(user, utils) {
  const p = `${ifs.homeDir(user)}/.ssh/authorized_keys`;
  try {
    const text = String(await ifs.readFile(p));
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => utils.parseKey(l)).filter((k) => k && !(k instanceof Error));
  } catch { return []; }
}

// ---------- Atributos y nombres SFTP ----------
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
function attrsOf(st) {
  const t = Math.floor((st.mtime ? new Date(st.mtime).getTime() : Date.now()) / 1000);
  return { mode: (st.dir ? S_IFDIR | 0o755 : S_IFREG | 0o644), uid: 0, gid: 0, size: st.size || 0, atime: t, mtime: t };
}
function longname(name, st, user) {
  const d = st.mtime ? new Date(st.mtime) : new Date();
  const mon = d.toLocaleString('en-US', { month: 'short' });
  return `${st.dir ? 'drwxr-xr-x' : '-rw-r--r--'}   1 ${String(user).toLowerCase().padEnd(8)} 0        ${String(st.size || 0).padStart(10)} ${mon} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${name}`;
}

// /QSYS.LIB: bibliotecas y archivos como directorios, miembros como archivos de texto
async function qsysStat(p) {
  const q = parseQsysPath(p);
  if (!q) return null;
  if (q.mbr) {
    try { const t = await readQsysMember(q.lib, q.obj, q.mbr); return { dir: false, size: Buffer.byteLength(t), mtime: new Date() }; } catch { return null; }
  }
  try { await listQsys(q); return { dir: true, size: 0, mtime: new Date() }; } catch { return null; }
}
async function qsysList(p) {
  const q = parseQsysPath(p);
  const items = await listQsys(q);
  return items.map((it) => ({ name: it.name, dir: !!it.dir, size: it.size || 0, mtime: it.mtime || new Date() }));
}

function sftpSession(sftp, ctx, user, { OPEN_MODE, STATUS_CODE }) {
  const handles = new Map();
  let seq = 0;
  const home = ifs.homeDir(user);
  const abs = (p) => ifs.normPath(p === '.' || !p ? home : p, home);
  const newHandle = (h) => { const id = Buffer.alloc(4); id.writeUInt32BE(++seq); handles.set(id.toString('hex'), h); return id; };
  const get = (b) => handles.get(Buffer.from(b).toString('hex'));
  const fail = (reqid, e) => sftp.status(reqid, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : e && e.code === 'EACCES' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE, e ? String(e.message || e) : 'failure');
  const statAny = async (p) => (ifs.isQsys(p) ? qsysStat(p) : ifs.stat(p));
  const log = (op, p) => logJob(ctx.job, '', '*INFO', `SFTP ${op} ${p}`);

  sftp.on('REALPATH', (reqid, p) => {
    const r = abs(p);
    sftp.name(reqid, [{ filename: r, longname: r, attrs: {} }]);
  });
  sftp.on('STAT', async (reqid, p) => { const st = await statAny(abs(p)); if (!st) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); sftp.attrs(reqid, attrsOf(st)); });
  sftp.on('LSTAT', async (reqid, p) => { const st = await statAny(abs(p)); if (!st) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE); sftp.attrs(reqid, attrsOf(st)); });
  sftp.on('FSTAT', async (reqid, h) => {
    const x = get(h);
    if (!x) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (x.kind === 'mbr') return sftp.attrs(reqid, attrsOf({ dir: false, size: x.buf.length }));
    try { const st = await x.fh.stat(); sftp.attrs(reqid, attrsOf({ dir: false, size: st.size, mtime: st.mtime })); } catch (e) { fail(reqid, e); }
  });
  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));

  sftp.on('OPENDIR', async (reqid, p) => {
    const dir = abs(p);
    try {
      let items;
      if (ifs.isQsys(dir)) items = await qsysList(dir);
      else {
        const st = await ifs.stat(dir);
        if (!st || !st.dir) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        items = (await ifs.list(dir)).map((e) => ({ name: e.name, dir: e.dir, size: e.size, mtime: e.mtime }));
      }
      log('OPENDIR', dir);
      sftp.handle(reqid, newHandle({ kind: 'dir', items: [{ name: '.', dir: true }, { name: '..', dir: true }, ...items], done: false }));
    } catch (e) { fail(reqid, e); }
  });
  sftp.on('READDIR', (reqid, h) => {
    const x = get(h);
    if (!x || x.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (x.done) return sftp.status(reqid, STATUS_CODE.EOF);
    x.done = true;
    sftp.name(reqid, x.items.map((it) => ({ filename: it.name, longname: longname(it.name, it, user), attrs: attrsOf(it) })));
  });

  sftp.on('OPEN', async (reqid, filename, flags) => {
    const p = abs(filename);
    const write = !!(flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC));
    try {
      if (ifs.isQsys(p)) {
        const q = parseQsysPath(p);
        if (!q || !q.mbr) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Only members (.MBR) can be opened in /QSYS.LIB');
        let buf = Buffer.alloc(0);
        if (!write || (flags & OPEN_MODE.APPEND)) { try { buf = Buffer.from(await readQsysMember(q.lib, q.obj, q.mbr)); } catch (e) { if (!write) throw Object.assign(e, { code: 'ENOENT' }); } }
        log(write ? 'PUT' : 'GET', p);
        return sftp.handle(reqid, newHandle({ kind: 'mbr', q, buf, write, dirty: false }));
      }
      let mode = 'r';
      if (write) mode = flags & OPEN_MODE.APPEND ? 'a' : flags & OPEN_MODE.READ ? (flags & OPEN_MODE.TRUNC ? 'w+' : 'r+') : 'w';
      if (mode === 'r+' && !(await ifs.stat(p))) mode = 'w+';
      if (write) await fsp.mkdir(path.dirname(ifs.real(p)), { recursive: true });
      const fh = await fsp.open(ifs.real(p), mode);
      log(write ? 'PUT' : 'GET', p);
      sftp.handle(reqid, newHandle({ kind: 'file', fh, path: p }));
    } catch (e) { fail(reqid, e); }
  });
  sftp.on('READ', async (reqid, h, offset, length) => {
    const x = get(h);
    if (!x) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (x.kind === 'mbr') {
      if (offset >= x.buf.length) return sftp.status(reqid, STATUS_CODE.EOF);
      return sftp.data(reqid, x.buf.subarray(offset, Math.min(x.buf.length, offset + length)));
    }
    try {
      const b = Buffer.alloc(length);
      const { bytesRead } = await x.fh.read(b, 0, length, offset);
      if (!bytesRead) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, b.subarray(0, bytesRead));
    } catch (e) { fail(reqid, e); }
  });
  sftp.on('WRITE', async (reqid, h, offset, data) => {
    const x = get(h);
    if (!x) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (x.kind === 'mbr') {
      const end = offset + data.length;
      if (x.buf.length < end) x.buf = Buffer.concat([x.buf, Buffer.alloc(end - x.buf.length)]);
      data.copy(x.buf, offset);
      x.dirty = true;
      return sftp.status(reqid, STATUS_CODE.OK);
    }
    try { await x.fh.write(data, 0, data.length, offset); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); }
  });
  sftp.on('CLOSE', async (reqid, h) => {
    const x = get(h);
    if (!x) return sftp.status(reqid, STATUS_CODE.FAILURE);
    handles.delete(Buffer.from(h).toString('hex'));
    try {
      if (x.kind === 'file') await x.fh.close();
      if (x.kind === 'mbr' && x.write && x.dirty) await writeQsysMember(x.q.lib, x.q.obj, x.q.mbr, x.buf.toString('utf8').replace(/\r\n/g, '\n'));
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (e) { fail(reqid, e); }
  });
  sftp.on('REMOVE', async (reqid, p) => { try { await ifs.unlink(abs(p)); log('RM', abs(p)); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); } });
  sftp.on('MKDIR', async (reqid, p) => { try { await ifs.mkdir(abs(p)); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); } });
  sftp.on('RMDIR', async (reqid, p) => { try { await ifs.rmdir(abs(p)); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); } });
  sftp.on('RENAME', async (reqid, a, b) => { try { await ifs.rename(abs(a), abs(b)); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { fail(reqid, e); } });
  sftp.on('READLINK', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
  sftp.on('SYMLINK', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
  // EOF del cliente ('bye'): cerrar los archivos abiertos y el canal, o el cliente espera indefinidamente
  sftp.on('end', async () => {
    for (const x of handles.values()) if (x.kind === 'file') await x.fh.close().catch(() => {});
    handles.clear();
    sftp.end();
  });
}

// Shell interactiva: eco, retroceso y ejecución por líneas en QSH
function shellSession(stream, sh, pty, onExit) {
  const motd = `\r\n  ${SYS.name} - IBM i ${SYS.release} (AS400 para Todos)  OpenSSH / QSH\r\n  Escriba "help" para ver las ordenes; system "MANDATO CL" ejecuta CL.\r\n\r\n`;
  const nl = (s) => s.replace(/\r?\n/g, '\r\n');
  stream.write(motd + sh.prompt);
  let line = '';
  let busy = false;
  const queue = [];
  const run = async (l) => {
    busy = true;
    const r = await sh.exec(l).catch((e) => ({ out: `${e.message}\n`, code: 1 }));
    if (r.out) stream.write(nl(r.out));
    busy = false;
    if (r.exit) { onExit(r.code); return; }
    stream.write(sh.prompt);
    if (queue.length) run(queue.shift());
  };
  stream.on('data', (d) => {
    for (const ch of d.toString('utf8')) {
      if (ch === '\r' || ch === '\n') {
        if (ch === '\n' && pty && line === '' && d.length === 1) continue;
        if (pty) stream.write('\r\n');
        const l = line;
        line = '';
        if (busy) queue.push(l); else run(l);
      } else if (ch === '\u007f' || ch === '\b') {
        if (line.length) { line = line.slice(0, -1); if (pty) stream.write('\b \b'); }
      } else if (ch === '\u0003') { line = ''; if (pty) stream.write('^C\r\n' + sh.prompt); }
      else if (ch === '\u0004') { if (!line) onExit(0); }
      else if (ch >= ' ') { line += ch; if (pty) stream.write(ch); }
    }
  });
}

function handleClient(client, info, ctl, conn) {
  let prf = null;
  let ctx = null;
  client.on('authentication', async (a) => {
    try {
      if (a.method === 'password') {
        prf = await authenticate(a.username, a.password, { service: 'SSH', remote: info.ip });
        return a.accept();
      }
      if (a.method === 'publickey') {
        const u = String(a.username || '').toUpperCase();
        const p = await getUser(u);
        if (!p || p.STATUS === '*DISABLED') return a.reject(['password', 'publickey']);
        const keys = await authorizedKeys(u, ssh2.utils);
        const k = keys.find((x) => x.type === a.key.algo && Buffer.compare(x.getPublicSSH(), a.key.data) === 0);
        if (!k) return a.reject(['password', 'publickey']);
        if (a.signature && k.verify(a.blob, a.signature, a.hashAlgo) !== true) return a.reject(['password', 'publickey']);
        prf = p;
        return a.accept();
      }
      return a.reject(['password', 'publickey']);
    } catch {
      return a.reject(['password', 'publickey']);
    }
  });
  client.on('ready', async () => {
    ctx = await serverCtx(prf, { name: 'QP0ZSPWP', subsystem: 'QUSRWRK', type: 'BCI', fn: 'PGM-sshd' });
    tagConnection(conn, { user: prf.NAME, job: ctx.job, detail: 'SSH' });
    client.on('session', (accept) => {
      const session = accept();
      let pty = null;
      session.on('pty', (acc, rej, p) => { pty = p; if (acc) acc(); });
      session.on('window-change', (acc) => acc && acc());
      session.on('env', (acc) => acc && acc());
      session.on('exec', async (acc, rej, i) => {
        const stream = acc();
        const sh = new Qsh(ctx);
        const r = await sh.exec(i.command).catch((e) => ({ out: `${e.message}\n`, code: 1 }));
        const out = pty ? r.out.replace(/\r?\n/g, '\r\n') : r.out;
        if (r.code && /error|not found|CPF|CPD/i.test(out)) stream.stderr.write(out); else stream.write(out);
        stream.exit(r.code || 0);
        stream.end();
        logJob(ctx.job, '', '*INFO', `SSH exec: ${i.command.slice(0, 200)}`);
      });
      session.on('shell', (acc) => {
        const stream = acc();
        const sh = new Qsh(ctx);
        shellSession(stream, sh, !!pty, (code) => { stream.exit(code || 0); stream.end(); });
      });
      // ssh2 solo crea el servidor SFTP si hay oyente de 'sftp' (con 'subsystem' entrega un canal sin protocolo)
      session.on('subsystem', (acc, rej) => rej && rej());
      session.on('sftp', (acc) => {
        const sftp = acc();
        sftpSession(sftp, ctx, prf.NAME, ssh2.utils.sftp);
        tagConnection(conn, { user: prf.NAME, job: ctx.job, detail: 'SFTP' });
      });
    });
  });
  client.on('error', () => {});
  client.on('close', () => { if (ctx) endServerCtx(ctx); });
}

export function sshServerDef() {
  const port = Number(process.env.SSH_INTERNAL_PORT || 22);
  return {
    key: '*SSHD', title: 'SSH (OpenSSH)', job: 'QP0ZSPWP', subsystem: 'QUSRWRK', fn: 'PGM-sshd',
    ports: [{ port, label: 'ssh' }],
    async start(ctl) {
      const lib = await loadSsh2();
      const pending = new Map(); // ip:puerto → conexión de NETSTAT
      const keyOf = (ip, port) => `${String(ip || '').replace('::ffff:', '')}:${port}`;
      const srv = new lib.Server({ hostKeys: [hostKey()], ident: 'OpenSSH_9.6 IBM i (AS400 para Todos)', banner: `${SYS.name} - acceso autorizado solamente.\n` }, (client, info) => {
        const k = keyOf(info.ip, info.port);
        const conn = pending.get(k) || { remoteAddress: info.ip };
        pending.delete(k);
        handleClient(client, info, ctl, conn);
      });
      // Las conexiones pasan por un servidor TCP propio para contabilizarlas en NETSTAT / WRKTCPSTS
      const tcp = net.createServer((sock) => {
        const conn = ctl.track(sock, { detail: 'SSH' });
        const k = keyOf(sock.remoteAddress, sock.remotePort);
        pending.set(k, conn);
        sock.once('close', () => pending.delete(k));
        srv.injectSocket(sock);
      });
      await listen(tcp, port);
      return tcp;
    },
  };
}
