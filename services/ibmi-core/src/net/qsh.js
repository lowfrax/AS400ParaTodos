// QSH / PASE (subconjunto): intérprete de órdenes de estilo UNIX sobre el IFS y QSYS.LIB, con las utilidades
// de IBM i "system" (ejecuta CL) y "db2" (ejecuta SQL). Lo usan SSH, REXEC ("qsh …"), STRQSH/QSH y la API REST.
import * as ifs from '../ifs.js';
import * as ifsaut from '../ifsaut.js';
import { withCtx, currentCtx } from '../security.js';
import { parseQsysPath, listQsys, readQsysMember, writeQsysMember } from '../qsyslib.js';
import { runCmd } from '../svc/jobs.js';
import { SYS, allJobs } from '../system.js';

function tokenize(line) {
  const out = [];
  let cur = '', q = null, any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < line.length) cur += line[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; any = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; any = true; continue; }
    if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    if (c === '|' || c === ';' || c === '>' || c === '&') {
      if (cur || any) out.push(cur);
      cur = ''; any = false;
      if (c === '>' && line[i + 1] === '>') { out.push({ op: '>>' }); i++; } else if (c === '&' && line[i + 1] === '&') { out.push({ op: '&&' }); i++; } else out.push({ op: c });
      continue;
    }
    cur += c;
  }
  if (q) throw new Error('qsh: unmatched quote');
  if (cur || any) out.push(cur);
  return out;
}

export class Qsh {
  constructor(ctx) {
    this.ctx = ctx;
    this.cwd = ctx.job.cwd || ifs.homeDir(ctx.job.user);
    this.env = { HOME: `/home/${ctx.job.user}`, USER: ctx.job.user, LOGNAME: ctx.job.user, SHELL: '/QOpenSys/usr/bin/qsh', PATH: '/QOpenSys/pkgs/bin:/usr/bin', TERM: 'xterm', QIBM_SYSTEM_NAME: SYS.name };
    this.last = 0;
  }
  get prompt() { return `${this.ctx.job.user.toLowerCase()}@${SYS.name.toLowerCase()}:${this.cwd}$ `; }

  /** Ejecuta una línea (con |, ;, &&, > y >>). Devuelve {out, code, exit}. */
  async exec(line) {
    // Las operaciones del IFS se hacen con el perfil del trabajo (autorizaciones de datos y de objeto)
    if (currentCtx() !== this.ctx) return withCtx(this.ctx, () => this.exec(line));
    let toks;
    try { toks = tokenize(line.replace(/\$(\w+)|\$\{(\w+)\}/g, (_, a, b) => this.env[a || b] ?? (a === '?' ? String(this.last) : ''))); } catch (e) { return { out: `${e.message}\n`, code: 2 }; }
    // Separar por ; y &&
    const seqs = [];
    let cur = [];
    for (const t of toks) {
      if (typeof t === 'object' && (t.op === ';' || t.op === '&&')) { seqs.push({ toks: cur, and: t.op === '&&' }); cur = []; } else cur.push(t);
    }
    seqs.push({ toks: cur, and: false });
    let out = '';
    let prevAnd = false;
    for (const s of seqs) {
      if (prevAnd && this.last !== 0) break;
      prevAnd = s.and;
      if (!s.toks.length) continue;
      const r = await this.pipeline(s.toks);
      out += r.out;
      this.last = r.code;
      if (r.exit) return { out, code: r.code, exit: true };
    }
    return { out, code: this.last };
  }

  async pipeline(toks) {
    let redirect = null;
    const ri = toks.findIndex((t) => typeof t === 'object' && (t.op === '>' || t.op === '>>'));
    if (ri >= 0) { redirect = { file: toks[ri + 1], append: toks[ri].op === '>>' }; toks = toks.slice(0, ri); }
    const stages = [];
    let cur = [];
    for (const t of toks) { if (typeof t === 'object' && t.op === '|') { stages.push(cur); cur = []; } else if (typeof t === 'string') cur.push(t); }
    stages.push(cur);
    let input = '';
    let code = 0;
    let exit = false;
    for (const argv of stages) {
      if (!argv.length) continue;
      const r = await this.run(argv, input);
      input = r.out;
      code = r.code;
      exit = !!r.exit;
    }
    if (redirect && redirect.file) {
      const p = ifs.normPath(redirect.file, this.cwd);
      await ifs.writeFile(p, input, { append: redirect.append });
      return { out: '', code, exit };
    }
    return { out: input, code, exit };
  }

  path(p) { return ifs.normPath(p || '.', this.cwd); }

  async readAny(p) {
    if (ifs.isQsys(p)) {
      const q = parseQsysPath(p);
      if (!q.obj) throw new Error(`cat: ${p}: is a directory`);
      return (await readQsysMember(q.lib, q.obj, q.mbr || q.obj)).replace(/\r\n/g, '\n');
    }
    const st = await ifs.stat(p);
    if (!st) throw new Error(`${p}: No such file or directory`);
    if (st.dir) throw new Error(`${p}: Is a directory`);
    return (await ifs.readFile(p)).toString('utf8');
  }

  async run(argv, stdin) {
    const [cmd, ...a] = argv;
    const flags = new Set(a.filter((x) => /^-[a-zA-Z]+$/.test(x)).flatMap((x) => x.slice(1).split('')));
    const args = a.filter((x) => !/^-[a-zA-Z]+$/.test(x));
    const ok = (out = '') => ({ out, code: 0 });
    const err = (msg, code = 1) => ({ out: `${cmd}: ${msg}\n`, code });
    try {
      switch (cmd) {
        case 'system': {
          const text = args.join(' ');
          if (!text) return err('usage: system [-i] "CL command"');
          const r = await runCmd(this.ctx, text);
          const lines = r.ok ? r.messages.map((m) => `${m.id ? `${m.id}: ` : ''}${m.text}`) : [`${r.error.id}: ${r.error.text}`];
          return { out: lines.length ? `${lines.join('\n')}\n` : '', code: r.ok ? 0 : 255 };
        }
        case 'db2': case 'sql': {
          const sql = args.join(' ');
          const r = await this.ctx.sql(sql);
          if (r.error) return { out: `SQL${String(Math.abs(r.sqlcode || 0)).padStart(4, '0')}  ${r.error}\nSQLSTATE: ${r.sqlstate}\n`, code: 1 };
          if (!r.columns.length) return ok(`DB20000I  The SQL command completed successfully. ${r.rowCount} rows affected.\n`);
          return ok(formatTable(r));
        }
        case 'cd': {
          const p = this.path(args[0] || this.env.HOME);
          if (ifs.isQsys(p)) { this.cwd = p; return ok(); }
          const st = await ifs.stat(p);
          if (!st || !st.dir) return err(`${args[0]}: No such directory`);
          this.cwd = p;
          this.ctx.job.cwd = p;
          return ok();
        }
        case 'pwd': return ok(`${this.cwd}\n`);
        case 'ls': {
          const targets = args.length ? args : ['.'];
          let out = '';
          for (const t of targets) {
            const p = this.path(t);
            let entries;
            if (ifs.isQsys(p)) entries = (await listQsys(parseQsysPath(p))).map((e) => ({ name: e.name, dir: e.dir, size: e.size, mtime: e.mtime, owner: e.owner || 'QSYS' }));
            else {
              const st = await ifs.stat(p);
              if (!st) { out += `ls: ${t}: No such file or directory\n`; continue; }
              entries = st.dir ? await ifs.list(p) : [st];
              if (p === '/') entries.unshift({ name: 'QSYS.LIB', dir: true, size: 0, mtime: new Date() });
            }
            if (!flags.has('a')) entries = entries.filter((e) => !e.name.startsWith('.'));
            if (flags.has('l')) out += entries.map((e) => `${e.path && !ifs.isQsys(e.path) ? ifsaut.modeString(e.path, e.dir) : e.dir ? 'drwxrwsrwx' : '-rwxrwxrwx'}  1 ${String(e.owner || 'qsys').toLowerCase().padEnd(9)} ${String(e.path && !ifs.isQsys(e.path) ? ifsaut.mode(e.path).group : 0).toLowerCase().padEnd(9)} ${String(e.size).padStart(10)} ${fmtDate(e.mtime)} ${e.name}`).join('\n') + (entries.length ? '\n' : '');
            else out += entries.map((e) => e.name).join(flags.has('1') ? '\n' : '  ') + (entries.length ? '\n' : '');
          }
          return ok(out);
        }
        case 'cat': {
          if (!args.length) return ok(stdin);
          let out = '';
          for (const f of args) out += await this.readAny(this.path(f));
          return ok(out);
        }
        case 'echo': return ok(`${args.join(' ')}\n`);
        case 'printf': return ok((args[0] || '').replace(/\\n/g, '\n').replace(/%s/g, () => args.splice(1, 1)[0] || ''));
        case 'mkdir': for (const d of args) await ifs.mkdir(this.path(d), { parents: flags.has('p') }); return ok();
        case 'rmdir': for (const d of args) await ifs.rmdir(this.path(d)); return ok();
        case 'rm': for (const f of args) { const p = this.path(f); const st = await ifs.stat(p); if (st?.dir) { if (!flags.has('r')) return err(`${f}: is a directory`); await ifs.rmdir(p, { recursive: true }); } else await ifs.unlink(p); } return ok();
        case 'mv': await ifs.rename(this.path(args[0]), this.path(args[1])); return ok();
        case 'cp': {
          const to = this.path(args[1]);
          const from = this.path(args[0]);
          if (ifs.isQsys(to)) { const q = parseQsysPath(to); await writeQsysMember(q.lib, q.obj, q.mbr || q.obj, await this.readAny(from)); return ok(); }
          if (ifs.isQsys(from)) { await ifs.writeFile(to, await this.readAny(from)); return ok(); }
          await ifs.copy(from, to, { replace: true });
          return ok();
        }
        case 'chmod': {
          // chmod 750 archivo…  (modo octal: propietario, grupo primario y *PUBLIC → *RWX…)
          const [m, ...files] = args;
          if (!/^[0-7]{3,4}$/.test(m || '')) return err(`invalid mode: ${m || ''}`);
          for (const f of files) {
            const p = this.path(f);
            if (!(await ifs.stat(p))) return err(`${f}: No such file or directory`);
            await ifsaut.mayManage(p);
            await ifsaut.chmod(p, parseInt(m, 8) & 0o777);
          }
          return ok();
        }
        case 'chown': case 'chgrp': {
          const [who, ...files] = args;
          const { getUser } = await import('../objects.js');
          const { hasSpecial } = await import('../security.js');
          const name = String(who || '').toUpperCase();
          if (!(await getUser(name))) return err(`${who}: Invalid user`);
          for (const f of files) {
            const p = this.path(f);
            if (!(await ifs.stat(p))) return err(`${f}: No such file or directory`);
            const owner = ifsaut.metaOf(p).owner;
            if (!hasSpecial(this.ctx.user, '*ALLOBJ') && owner !== this.ctx.job.user) return err(`${f}: Permission denied`);
            if (cmd === 'chown') await ifsaut.changeOwner(p, name); else await ifsaut.changePgp(p, name);
          }
          return ok();
        }
        case 'touch': for (const f of args) { const p = this.path(f); if (!(await ifs.stat(p))) await ifs.writeFile(p, ''); } return ok();
        case 'head': case 'tail': {
          const ni = a.indexOf('-n');
          const n = ni >= 0 ? Number(a[ni + 1]) : 10;
          const files = a.filter((x, i) => x !== '-n' && i !== ni + 1);
          const text = files.length ? await this.readAny(this.path(files[0])) : stdin;
          const lines = text.replace(/\n$/, '').split('\n');
          const sel = cmd === 'head' ? lines.slice(0, n) : lines.slice(-n);
          return ok(sel.length && text ? `${sel.join('\n')}\n` : '');
        }
        case 'wc': {
          const text = args.length ? await this.readAny(this.path(args[0])) : stdin;
          const l = (text.match(/\n/g) || []).length;
          const w = text.split(/\s+/).filter(Boolean).length;
          return ok(flags.has('l') ? `${l}\n` : `${String(l).padStart(8)}${String(w).padStart(8)}${String(text.length).padStart(8)}\n`);
        }
        case 'grep': {
          const [pat, ...files] = args;
          const re = new RegExp(pat, flags.has('i') ? 'i' : '');
          const text = files.length ? await this.readAny(this.path(files[0])) : stdin;
          const hits = text.split('\n').filter((l) => (flags.has('v') ? !re.test(l) : re.test(l)));
          return { out: hits.length ? `${hits.join('\n')}\n` : '', code: hits.length ? 0 : 1 };
        }
        case 'sort': { const text = args.length ? await this.readAny(this.path(args[0])) : stdin; const l = text.replace(/\n$/, '').split('\n').sort(); if (flags.has('r')) l.reverse(); return ok(text ? `${l.join('\n')}\n` : ''); }
        case 'date': return ok(`${new Date().toString()}\n`);
        case 'whoami': case 'logname': return ok(`${this.ctx.job.user.toLowerCase()}\n`);
        case 'id': return ok(`uid=${100 + this.ctx.job.user.length}(${this.ctx.job.user.toLowerCase()}) gid=0(0)\n`);
        case 'hostname': return ok(`${SYS.name.toLowerCase()}\n`);
        case 'uname': return ok(flags.has('a') ? `OS400 ${SYS.name} 5 7 ${SYS.serial} ${SYS.model}\n` : 'OS400\n');
        case 'env': case 'printenv': return ok(Object.entries(this.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
        case 'export': for (const kv of args) { const i = kv.indexOf('='); if (i > 0) this.env[kv.slice(0, i)] = kv.slice(i + 1); } return ok();
        case 'liblist': return ok(this.ctx.libl.map((l) => `${l.padEnd(10)} ${['QSYS', 'QSYS2', 'QHLPSYS', 'QUSRSYS'].includes(l) ? 'SYSTEM' : l === this.ctx.job.curlib ? 'CURRENT' : 'USER'}`).join('\n') + '\n');
        case 'ps': return ok(`${'JOB'.padEnd(30)} ${'TYPE'.padEnd(4)} ${'STS'.padEnd(5)} FUNCTION\n${allJobs().map((j) => `${`${j.number}/${j.user}/${j.name}`.padEnd(30)} ${j.type.padEnd(4)} ${String(j.status).padEnd(5)} ${j.function || ''}`).join('\n')}\n`);
        case 'sleep': await new Promise((r) => setTimeout(r, Math.min(60, Number(args[0]) || 0) * 1000)); return ok();
        case 'true': return ok();
        case 'false': return { out: '', code: 1 };
        case 'clear': return ok('\u001b[2J\u001b[H');
        case 'exit': case 'logout': return { out: '', code: Number(args[0] || 0), exit: true };
        case 'help': return ok('QSH (AS400 para Todos). Ordenes: system "CL", db2 "SQL", ls, cd, pwd, cat, echo, printf, mkdir, rmdir, rm, mv, cp, touch, head, tail, wc, grep, sort,\n  date, whoami, id, hostname, uname, env, export, liblist, ps, sleep, clear, exit. Tuberias |, ; , &&, > y >>.\n  Rutas: IFS (/home, /tmp, /banco…) y /QSYS.LIB/BIB.LIB/ARCHIVO.FILE/MIEMBRO.MBR\n');
        default: return { out: `qsh: ${cmd}: command not found\n`, code: 127 };
      }
    } catch (e) {
      return err(e.message.replace(/^\w+: /, ''));
    }
  }
}

function fmtDate(d) {
  const t = d instanceof Date ? d : new Date(d);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MON[t.getMonth()]} ${String(t.getDate()).padStart(2)} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

export function formatTable(r) {
  const cols = r.columns.map((c) => c.name);
  const rows = r.rows.map((row) => row.map((v) => (v === null || v === undefined ? '-' : String(v))));
  const w = cols.map((c, i) => Math.min(60, Math.max(c.length, ...rows.map((x) => x[i].length))));
  const line = (vals) => vals.map((v, i) => String(v).slice(0, w[i]).padEnd(w[i])).join(' ').replace(/\s+$/, '');
  return `\n${line(cols)}\n${w.map((n) => '-'.repeat(n)).join(' ')}\n${rows.map(line).join('\n')}${rows.length ? '\n' : ''}\n  ${rows.length} record(s) selected.\n\n`;
}

/** Ejecuta un guion completo (varias líneas). */
export async function runQsh(ctx, script) {
  const sh = new Qsh(ctx);
  let text = '';
  let code = 0;
  for (const line of String(script).split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const r = await sh.exec(line);
    text += r.out;
    code = r.code;
    if (r.exit) break;
  }
  return { text, code };
}
