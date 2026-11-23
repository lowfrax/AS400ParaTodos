// Servidor FTP de IBM i (QTFTPxxxxx): nomenclatura NAMEFMT 0 (BIB/ARCHIVO.MIEMBRO) y 1 (/QSYS.LIB/…, IFS),
// LISTFMT 0 (formato IBM) y 1 (formato UNIX), mandatos remotos (QUOTE RCMD), pasivo (PASV/EPSV), activo (PORT/EPRT)
// y FTPS explícito (AUTH TLS) o implícito (puerto 990).
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as ifs from '../ifs.js';
import { parseQsysPath, parseNameFmt0, listQsys, readQsysMember, writeQsysMember, deleteQsysObject, qsysPath } from '../qsyslib.js';
import { authenticate } from '../svc/auth.js';
import { serverCtx, endServerCtx, runCmd } from '../svc/jobs.js';
import { tagConnection } from './servers.js';
import { listen } from './telnet.js';
import { SYS } from '../system.js';
import { libExists, createLibrary } from '../objects.js';
import * as obj from '../objects.js';

const PASV_MIN = Number(process.env.FTP_PASV_MIN || 30000);
const PASV_MAX = Number(process.env.FTP_PASV_MAX || 30009);
let nextPasv = PASV_MIN;

const pad2 = (n) => String(n).padStart(2, '0');
const ibmDate = (d) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${String(d.getFullYear()).slice(2)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const unixDate = (d) => `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${(Date.now() - d) > 180 * 864e5 ? ` ${d.getFullYear()}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`}`;

class FtpSession {
  constructor(socket, ctl, opts) {
    this.ctl = ctl;
    this.opts = opts;
    this.conn = ctl.track(socket, { detail: 'FTP' });
    this.setSocket(socket);
    this.user = null;
    this.prf = null;
    this.ctx = null;
    this.namefmt = 0;
    this.listfmt = Number(process.env.FTP_LISTFMT || 0);
    this.curlib = 'QGPL';
    this.cwd = '/';
    this.type = 'A';
    this.pasv = null;
    this.active = null;
    this.rnfr = null;
    this.protP = !!opts.implicit;
    this.secure = !!opts.implicit;
    this.queue = Promise.resolve();
    this.reply(220, [`-QTCP at ${SYS.name.toLowerCase()}.`, ' Connection will close if idle more than 5 minutes.']);
  }

  setSocket(s) {
    if (this.sock && this.onData) this.sock.off('data', this.onData);
    this.sock = s;
    let buf = '';
    const dec = new StringDecoder('utf8');
    s.setTimeout(5 * 60 * 1000, () => { this.reply(421, 'Idle time-out. Connection closed.'); s.end(); });
    this.onData = (d) => {
      buf += dec.write(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        this.queue = this.queue.then(() => this.command(line)).catch((e) => this.reply(550, e.message || String(e)));
      }
    };
    s.on('data', this.onData);
    s.on('close', () => this.cleanup());
    s.on('error', () => this.cleanup());
  }

  reply(code, text) {
    try {
      if (Array.isArray(text)) {
        const lines = text.map((t, i) => (i === text.length - 1 ? `${code} ${t.replace(/^-/, '')}` : `${code}${t.startsWith('-') ? t : `-${t}`}`));
        this.sock.write(`${lines.join('\r\n')}\r\n`);
      } else this.sock.write(`${code} ${text}\r\n`);
    } catch { /* desconectado */ }
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;
    if (this.pasv) { try { this.pasv.server.close(); } catch { /* ignorar */ } }
    if (this.ctx) endServerCtx(this.ctx);
  }

  // ---------- Nombres ----------
  /** Resuelve un argumento de ruta: {kind:'ifs', path} | {kind:'qsys', q, path} */
  resolve(arg = '') {
    const a = String(arg).trim().replace(/^"|"$/g, '');
    if (this.namefmt === 0 && a && !a.startsWith('/') && !/^\.\.?$/.test(a)) {
      const q = parseNameFmt0(a, this.curlib);
      if (q) return { kind: 'qsys', q, path: qsysPath(q.lib, q.obj, '*FILE', q.mbr) };
    }
    const base = this.namefmt === 0 ? qsysPath(this.curlib) : this.cwd;
    const p = ifs.normPath(a || '.', base);
    if (ifs.isQsys(p)) return { kind: 'qsys', q: parseQsysPath(p), path: p };
    return { kind: 'ifs', path: p };
  }

  // ---------- Conexión de datos ----------
  async openData() {
    if (this.pasv) {
      const p = this.pasv;
      this.pasv = null;
      const s = await Promise.race([p.conn, new Promise((_, rej) => setTimeout(() => rej(new Error('425 Data connection timed out.')), 15000))]);
      try { p.server.close(); } catch { /* ignorar */ }
      return this.protP ? this.wrapTls(s) : s;
    }
    if (this.active) {
      const { host, port } = this.active;
      this.active = null;
      const s = await new Promise((res, rej) => { const c = net.connect(port, host, () => res(c)); c.on('error', rej); });
      return this.protP ? this.wrapTls(s) : s;
    }
    throw new Error('425 Use PORT or PASV first.');
  }

  wrapTls(s) {
    const creds = this.opts.tls?.();
    return new Promise((res, rej) => {
      const t = new tls.TLSSocket(s, { isServer: true, key: creds.key, cert: creds.cert });
      t.once('secure', () => res(t));
      t.once('error', rej);
      setTimeout(() => res(t), 3000);
    });
  }

  async sendData(data, label) {
    this.reply(150, `File status okay; about to open data connection${label ? ` for ${label}` : ''}.`);
    let s;
    try { s = await this.openData(); } catch (e) { this.reply(425, e.message.replace(/^425 /, '')); return; }
    const out = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    await new Promise((r) => s.end(out, r));
    this.conn.bytesOut += out.length;
    this.reply(226, 'File transfer completed successfully.');
  }

  async recvData() {
    this.reply(150, 'Sending file to member or stream file.');
    const s = await this.openData();
    const chunks = [];
    await new Promise((res, rej) => { s.on('data', (c) => chunks.push(c)); s.on('end', res); s.on('close', res); s.on('error', rej); });
    return Buffer.concat(chunks);
  }

  // ---------- Listados ----------
  async listing(arg, namesOnly) {
    const flags = String(arg || '').match(/^-\w+\s*/);
    let target = (flags ? arg.slice(flags[0].length) : arg).trim();
    let r;
    let m;
    if (this.namefmt === 0 && (m = /^([\w#@$]{1,10})\/(\*|\*ALL)?$/i.exec(target))) r = { kind: 'qsys', q: { lib: m[1].toUpperCase() } };
    else if (this.namefmt === 0 && (m = /^(?:([\w#@$]{1,10})\/)?([\w#@$]{1,10})\.\*$/i.exec(target))) r = { kind: 'qsys', q: { lib: (m[1] || this.curlib).toUpperCase(), obj: m[2].toUpperCase(), type: '*FILE' } };
    else {
      if (target === '*' || target === '*.*') target = '';
      r = this.resolve(target || '');
    }
    const lines = [];
    if (r.kind === 'qsys') {
      const q = r.q;
      // Comodines tipo DEMOLIB/Q* o *.MBR se filtran después
      const entries = await listQsys(q.mbr || (q.obj && q.type !== '*FILE') ? { lib: q.lib } : q).catch((e) => { throw new Error(`550 ${e.message}`); });
      const fmt0 = this.namefmt === 0;
      for (const e of entries) {
        const name = fmt0 ? (e.mbr && !q.mbr ? `${q.lib}/${q.obj}.${e.mbr}` : e.type === '*LIB' ? e.obj : `${q.lib}/${e.obj}${e.mbr ? `.${e.mbr}` : ''}`) : e.name;
        if (namesOnly) { lines.push(name); continue; }
        if (this.listfmt === 1) lines.push(`${e.dir ? 'drwx---rwx' : '-rwx---rwx'}   1 ${String(e.owner || 'QSYS').padEnd(8)} 0 ${String(e.size).padStart(12)} ${unixDate(e.mtime)} ${e.name}`);
        else lines.push(`${String(e.owner || 'QSYS').padEnd(10)} ${String(e.size).padStart(11)} ${ibmDate(e.mtime)} ${String(e.type === '*MBR' ? '*MEM' : e.type).padEnd(10)} ${name}${e.dir && !fmt0 ? '/' : ''}`);
      }
      return lines;
    }
    const st = await ifs.stat(r.path);
    if (!st) throw new Error(`550 Specified directory does not exist or cannot be accessed: ${r.path}`);
    const entries = st.dir ? await ifs.list(r.path) : [st];
    for (const e of entries) {
      if (namesOnly) { lines.push(e.name); continue; }
      if (this.listfmt === 1) lines.push(`${ifs.modeString(e)}   1 ${'QSYS'.padEnd(8)} 0 ${String(e.size).padStart(12)} ${unixDate(e.mtime)} ${e.name}`);
      else lines.push(`${'QSYS'.padEnd(10)} ${String(e.size).padStart(11)} ${ibmDate(e.mtime)} ${(e.dir ? '*DIR' : '*STMF').padEnd(10)} ${e.name}${e.dir ? '/' : ''}`);
    }
    // /QSYS.LIB aparece en la raíz como en un IBM i real
    if (r.path === '/' && !namesOnly) lines.unshift(this.listfmt === 1 ? `drwx---rwx   1 QSYS     0 ${'0'.padStart(12)} ${unixDate(new Date())} QSYS.LIB` : `${'QSYS'.padEnd(10)} ${'0'.padStart(11)} ${ibmDate(new Date())} ${'*DIR'.padEnd(10)} QSYS.LIB/`);
    else if (r.path === '/' && namesOnly) lines.unshift('QSYS.LIB');
    return lines;
  }

  // ---------- Mandatos ----------
  async command(line) {
    const sp = line.indexOf(' ');
    const verb = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1);
    tagConnection(this.conn, { detail: `FTP ${verb}` });
    const open = ['USER', 'PASS', 'QUIT', 'SYST', 'FEAT', 'AUTH', 'PBSZ', 'PROT', 'NOOP', 'HELP', 'OPTS'];
    if (!this.prf && !open.includes(verb)) return this.reply(530, 'Log on attempt by user rejected. Enter USER and PASS first.');
    switch (verb) {
      case 'USER': this.user = arg.trim().toUpperCase(); return this.reply(331, 'Enter password.');
      case 'PASS': {
        try {
          this.prf = await authenticate(this.user, arg, { service: 'FTP', remote: this.conn.remoteAddress });
        } catch (e) { return this.reply(530, `Log on attempt by user ${this.user} rejected. ${e.message}`); }
        this.ctx = await serverCtx(this.prf, { name: `QTFTP${String(this.conn.id % 100000).padStart(5, '0')}`, subsystem: 'QSYSWRK', type: 'BCH', fn: 'PGM-QTMFTPS' });
        this.curlib = this.ctx.job.curlib || 'QGPL';
        this.cwd = ifs.homeDir(this.prf.NAME);
        tagConnection(this.conn, { user: this.prf.NAME, job: this.ctx.job });
        return this.reply(230, `${this.prf.NAME} logged on.`);
      }
      case 'SYST': return this.reply(215, ` OS/400 is the remote operating system. The TCP/IP version is "${SYS.release}".`);
      case 'FEAT': return this.reply(211, ['-Extensions supported:', ' AUTH TLS', ' PBSZ', ' PROT', ' SIZE', ' MDTM', ' UTF8', ' EPSV', ' EPRT', ' REST STREAM', 'END']);
      case 'OPTS': return this.reply(200, 'OPTS command successful.');
      case 'NOOP': return this.reply(250, 'NOOP subcommand was successful.');
      case 'HELP': return this.reply(214, ['-The following subcommands are recognized:', ' ABOR APPE AUTH CDUP CWD DELE EPRT EPSV FEAT HELP LIST MDTM MKD NLST NOOP PASS PASV PBSZ PORT PROT PWD QUIT RCMD RETR RMD RNFR RNTO SITE SIZE STAT STOR SYST TYPE USER XCWD XMKD XPWD XRMD', 'End of HELP.']);
      case 'AUTH': {
        if (!/^(TLS|SSL|TLS-C)$/i.test(arg.trim())) return this.reply(504, 'Security mechanism not supported.');
        const creds = this.opts.tls?.();
        if (!creds) return this.reply(431, 'TLS not available: no system certificate.');
        this.reply(234, 'Security environment established - ready for negotiation.');
        const raw = this.sock;
        raw.off('data', this.onData);
        this.onData = null;
        const t = new tls.TLSSocket(raw, { isServer: true, key: creds.key, cert: creds.cert });
        this.secure = true;
        this.setSocket(t);
        return undefined;
      }
      case 'PBSZ': return this.reply(200, 'PBSZ subcommand processed.');
      case 'PROT': this.protP = /^P$/i.test(arg.trim()); return this.reply(200, `Protection level ${this.protP ? 'Private' : 'Clear'} selected.`);
      case 'QUIT': this.reply(221, 'QUIT subcommand received.'); this.sock.end(); return undefined;
      case 'TYPE': {
        const t = arg.trim().toUpperCase()[0];
        this.type = t === 'I' || t === 'L' ? 'I' : 'A';
        return this.reply(200, this.type === 'I' ? 'Representation type is binary IMAGE.' : 'Representation type is ASCII nonprint.');
      }
      case 'MODE': return this.reply(200, 'Data transfer mode is STREAM.');
      case 'STRU': return this.reply(200, 'Data structure is file.');
      case 'PWD': case 'XPWD':
        return this.namefmt === 0 ? this.reply(257, `"${this.curlib}" is current library.`) : this.reply(257, `"${this.cwd}" is current directory.`);
      case 'CWD': case 'XCWD': case 'CDUP': case 'XCUP': {
        const a = verb.includes('UP') ? '..' : arg.trim();
        if (this.namefmt === 0 && a.startsWith('/')) this.namefmt = 1;
        if (this.namefmt === 0) {
          const lib = a.replace(/\.LIB$/i, '').toUpperCase();
          if (lib === '..') return this.reply(250, `"${this.curlib}" is current library.`);
          if (!(await libExists(lib))) return this.reply(550, `Specified library ${lib} does not exist or cannot be accessed.`);
          this.curlib = lib;
          return this.reply(250, `"${lib}" is current library.`);
        }
        const p = ifs.normPath(a, this.cwd);
        if (ifs.isQsys(p)) {
          const q = parseQsysPath(p);
          if (q.lib && q.lib !== 'QSYS' && !(await libExists(q.lib))) return this.reply(550, `Specified directory does not exist or cannot be accessed.`);
          this.cwd = p;
          if (q.lib && q.lib !== 'QSYS') this.curlib = q.lib;
          return this.reply(250, `"${p}" is current directory.`);
        }
        const st = await ifs.stat(p);
        if (!st || !st.dir) return this.reply(550, `Specified directory does not exist or cannot be accessed: ${p}`);
        this.cwd = p;
        return this.reply(250, `"${p}" is current directory.`);
      }
      case 'SITE': {
        const [k, v] = arg.trim().split(/\s+/);
        const K = (k || '').toUpperCase();
        if (K === 'NAMEFMT') {
          this.namefmt = Number(v) === 1 ? 1 : 0;
          if (this.namefmt === 1 && this.cwd === '/') this.cwd = ifs.homeDir(this.prf.NAME);
          return this.reply(250, ` Now using naming format "${this.namefmt}".`);
        }
        if (K === 'LISTFMT') { this.listfmt = Number(v) === 1 ? 1 : 0; return this.reply(250, ` Now using list format "${this.listfmt}".`); }
        if (['TRIM', 'CRTCCSID', 'SEQNUMS', 'RECFM', 'CCSID'].includes(K)) return this.reply(250, `${K} subcommand processed.`);
        if (K === 'RCMD') return this.rcmd(arg.trim().slice(4).trim());
        return this.reply(500, `Subcommand SITE ${K} not valid.`);
      }
      case 'RCMD': return this.rcmd(arg);
      case 'PASV': case 'EPSV': {
        if (this.pasv) { try { this.pasv.server.close(); } catch { /* ignorar */ } }
        const server = net.createServer();
        let port = 0;
        for (let i = 0; i <= PASV_MAX - PASV_MIN; i++) {
          const p = nextPasv;
          nextPasv = nextPasv >= PASV_MAX ? PASV_MIN : nextPasv + 1;
          try { await listen(server, p); port = p; break; } catch { /* ocupado */ }
        }
        if (!port) return this.reply(425, 'No passive data ports available.');
        const conn = new Promise((res) => server.once('connection', res));
        this.pasv = { server, conn };
        if (verb === 'EPSV') return this.reply(229, `Entering Extended Passive Mode (|||${port}|)`);
        const host = (process.env.FTP_PASV_ADDRESS || this.sock.localAddress || '127.0.0.1').replace('::ffff:', '');
        const h = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.') : ['127', '0', '0', '1'];
        return this.reply(227, `Entering Passive Mode (${h.join(',')},${port >> 8},${port & 255}).`);
      }
      case 'PORT': {
        const n = arg.split(',').map(Number);
        if (n.length !== 6 || n.some(Number.isNaN)) return this.reply(501, 'PORT subcommand parameters not valid.');
        this.active = { host: n.slice(0, 4).join('.'), port: n[4] * 256 + n[5] };
        return this.reply(200, 'PORT subcommand request successful.');
      }
      case 'EPRT': {
        const parts = arg.split(arg[0]).filter(Boolean);
        this.active = { host: parts[1], port: Number(parts[2]) };
        return this.reply(200, 'EPRT subcommand request successful.');
      }
      case 'LIST': case 'NLST': {
        let lines;
        try { lines = await this.listing(arg, verb === 'NLST'); } catch (e) {
          const m = /^(\d{3}) (.*)$/.exec(e.message);
          return this.reply(m ? Number(m[1]) : 550, m ? m[2] : e.message);
        }
        return this.sendData(lines.length ? `${lines.join('\r\n')}\r\n` : '', 'list');
      }
      case 'SIZE': case 'MDTM': {
        const r = this.resolve(arg);
        if (r.kind === 'qsys') {
          if (verb === 'MDTM') return this.reply(213, ts(new Date()));
          const data = await this.readTarget(r).catch(() => null);
          return data === null ? this.reply(550, 'File not found.') : this.reply(213, String(data.length));
        }
        const st = await ifs.stat(r.path);
        if (!st || st.dir) return this.reply(550, `${r.path}: not a plain file.`);
        return this.reply(213, verb === 'SIZE' ? String(st.size) : ts(st.mtime));
      }
      case 'RETR': {
        const r = this.resolve(arg);
        let data;
        try { data = await this.readTarget(r); } catch (e) { return this.reply(550, e.message); }
        return this.sendData(data, r.path);
      }
      case 'STOR': case 'APPE': {
        const r = this.resolve(arg);
        let data;
        try { data = await this.recvData(); } catch (e) { return this.reply(425, e.message); }
        try {
          if (r.kind === 'qsys') {
            const q = r.q;
            if (!q.obj) throw new Error('A file and member name are required.');
            // Archivo de salvar (*SAVF) en binario: el contenido del SAVF (se crea si no existe y los datos son de salvar)
            const sv = await this.savfTarget(q);
            if (sv || (this.type === 'I' && data[0] === 0x1f && data[1] === 0x8b && (!q.mbr || q.mbr === q.obj))) {
              const S = await import('../savrst.js');
              if (!sv) await S.createSavf(q.lib, q.obj.toUpperCase(), 'Created by FTP', this.prf.NAME);
              await S.loadSavfBytes(q.lib, q.obj.toUpperCase(), data);
              return this.reply(226, `File transfer completed successfully. Save file ${q.obj.toUpperCase()} in ${q.lib} loaded (${data.length} bytes).`);
            }
            const n = await writeQsysMember(q.lib, q.obj, q.mbr || q.obj, data.toString('utf8'), { append: verb === 'APPE' });
            return this.reply(226, `File transfer completed successfully. ${n} records written to member ${q.mbr || q.obj} in file ${q.lib}/${q.obj}.`);
          }
          await ifs.writeFile(r.path, data, { append: verb === 'APPE' });
          return this.reply(226, 'File transfer completed successfully.');
        } catch (e) { return this.reply(550, e.message); }
      }
      case 'DELE': {
        const r = this.resolve(arg);
        try {
          if (r.kind === 'qsys') await deleteQsysObject(r.q); else await ifs.unlink(r.path);
          return this.reply(250, `Deletion of ${r.path} successful.`);
        } catch (e) { return this.reply(550, e.message); }
      }
      case 'MKD': case 'XMKD': {
        const r = this.resolve(arg);
        try {
          if (r.kind === 'qsys') {
            if (r.q.obj) await obj.createSourceFile(r.q.lib, r.q.obj, 112, ''); else await createLibrary(r.q.lib, '', 'PROD', this.prf.NAME);
          } else await ifs.mkdir(r.path);
          return this.reply(257, `"${r.path}" created.`);
        } catch (e) { return this.reply(550, e.message); }
      }
      case 'RMD': case 'XRMD': {
        const r = this.resolve(arg);
        try {
          if (r.kind === 'qsys') await deleteQsysObject(r.q); else await ifs.rmdir(r.path);
          return this.reply(250, `"${r.path}" removed.`);
        } catch (e) { return this.reply(550, e.message); }
      }
      case 'RNFR': this.rnfr = this.resolve(arg); return this.reply(350, 'Enter RNTO subcommand.');
      case 'RNTO': {
        const to = this.resolve(arg);
        if (!this.rnfr || this.rnfr.kind !== 'ifs' || to.kind !== 'ifs') return this.reply(550, 'Rename is only supported for stream files.');
        try { await ifs.rename(this.rnfr.path, to.path); this.rnfr = null; return this.reply(250, 'File renamed.'); } catch (e) { return this.reply(550, e.message); }
      }
      case 'STAT': return this.reply(211, [`-Status of ${SYS.name}:`, ` User ${this.prf.NAME}, NAMEFMT ${this.namefmt}, LISTFMT ${this.listfmt}, TYPE ${this.type}, ${this.secure ? 'TLS' : 'clear'}`, 'End of status.']);
      case 'ABOR': return this.reply(226, 'ABOR subcommand successful.');
      case 'REST': return this.reply(350, 'Restarting at 0.');
      default: return this.reply(500, `Subcommand ${verb} not valid.`);
    }
  }

  /** Objeto *SAVF designado por la ruta (BIB/ARCHIVO o /QSYS.LIB/BIB.LIB/ARCHIVO.FILE), o null. */
  async savfTarget(q) {
    if (!q || !q.obj || (q.mbr && q.mbr.toUpperCase() !== q.obj.toUpperCase())) return null;
    const { gw: g, findObject: fo } = await import('../objects.js');
    const o = await fo(g, q.obj.toUpperCase(), '*FILE', q.lib, []);
    return o && o.ATTR === 'SAVF' ? o : null;
  }

  async readTarget(r) {
    if (r.kind === 'qsys') {
      const q = r.q;
      if (!q.obj) throw new Error('A file name is required.');
      const sv = await this.savfTarget(q);
      if (sv) return (await import('../savrst.js')).savfBytes(sv.LIB, sv.NAME);
      const text = await readQsysMember(q.lib, q.obj, q.mbr || q.obj);
      return Buffer.from(text, 'utf8');
    }
    const st = await ifs.stat(r.path);
    if (!st) throw new Error(`Specified file or directory does not exist: ${r.path}`);
    if (st.dir) throw new Error(`${r.path} is a directory.`);
    return ifs.readFile(r.path);
  }

  async rcmd(cmd) {
    if (!cmd.trim()) return this.reply(501, 'RCMD requires a CL command.');
    const r = await runCmd(this.ctx, cmd.trim());
    if (r.ok) return this.reply(250, `Command ${cmd.trim().split(/\s|\(/)[0].toUpperCase()} successful.${r.messages.length ? ` ${r.messages.map((m) => `${m.id ? `${m.id} ` : ''}${m.text}`).join(' ')}` : ''}`);
    return this.reply(550, [`-${r.error.id}: ${r.error.text}`, `Command ${cmd.trim().split(/\s|\(/)[0].toUpperCase()} not successful.`]);
  }
}

const ts = (d) => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;

export function ftpServerDef(api) {
  const port = Number(process.env.FTP_PORT || 21);
  const sport = Number(process.env.FTPS_PORT || 990);
  return {
    key: '*FTP', title: 'FTP / FTPS', job: 'QTFTP00000', subsystem: 'QSYSWRK', fn: 'PGM-QTMFTPS',
    ports: [{ port, label: 'ftp' }, { port: sport, tls: true, label: 'ftps' }, { port: `${PASV_MIN}-${PASV_MAX}`, label: 'ftp-pasv' }],
    async start(ctl) {
      const handles = [];
      const plain = net.createServer((s) => new FtpSession(s, ctl, { tls: api.tls }));
      await listen(plain, port);
      handles.push(plain);
      const creds = api.tls?.();
      if (creds) {
        const implicit = tls.createServer({ key: creds.key, cert: creds.cert }, (s) => new FtpSession(s, ctl, { tls: api.tls, implicit: true }));
        await listen(implicit, sport).then(() => handles.push(implicit)).catch((e) => console.error(`[tcp] FTPS ${sport}: ${e.message}`));
      }
      return handles;
    },
  };
}

export { path };
