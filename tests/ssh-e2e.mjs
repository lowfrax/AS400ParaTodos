// Prueba del servidor SSH/SFTP con un cliente OpenSSH real (ssh/sftp del sistema; en Windows, C:\Windows\System32\OpenSSH).
// Autenticación por clave pública (~/.ssh/authorized_keys en el IFS), exec de QSH (system "CL", db2 "SQL"),
// SFTP sobre el IFS y sobre /QSYS.LIB (miembros fuente). Ejecutar: node tests/ssh-e2e.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.API || 'http://localhost:10010';
const USER = process.env.AS400_USER || 'QSECOFR';
const AUTH = { Authorization: `Basic ${Buffer.from(`${USER}:${process.env.AS400_PWD || 'QSECOFR'}`).toString('base64')}` };
const PORT = process.env.SSH_PORT || '2222';
const WIN = process.platform === 'win32';
const SSH = WIN ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
const SFTP = WIN ? 'C:\\Windows\\System32\\OpenSSH\\sftp.exe' : 'sftp';
const KEYGEN = WIN ? 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe' : 'ssh-keygen';

async function api(method, p, body, type = 'application/json') {
  const r = await fetch(`${BASE}/api/v1${p}`, { method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': type } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `  ${extra}` : ''}`); if (!cond) failed++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as400ssh-'));
const key = path.join(dir, 'id_ed25519');
execFileSync(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', key, '-C', 'prueba-as400']);
const opts = ['-i', key, '-p', PORT, '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${path.join(dir, 'known_hosts')}`, '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR'];
const ssh = (cmd) => spawnSync(SSH, [...opts, `${USER.toLowerCase()}@127.0.0.1`, cmd], { encoding: 'utf8', timeout: 30000 });

(async () => {
  // Clave pública autorizada en el directorio inicial del usuario (IFS)
  const pub = fs.readFileSync(`${key}.pub`, 'utf8');
  const up = await api('PUT', `/ifs/home/${USER}/.ssh/authorized_keys`, pub, 'text/plain');
  check('authorized_keys en el IFS', up.status < 300, up.text.slice(0, 200));

  const r1 = ssh('system "DSPLIBL"');
  check('ssh exec: system "DSPLIBL"', r1.status === 0 && /QSYS/.test(r1.stdout), `${r1.status} ${r1.stdout} ${r1.stderr}`);
  const r2 = ssh(`db2 "SELECT COUNT(*) AS N FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'QSYS2'"`);
  check('ssh exec: db2 "SELECT…"', r2.status === 0 && /\d/.test(r2.stdout), `${r2.status} ${r2.stdout} ${r2.stderr}`);
  const r3 = ssh('echo hola > /tmp/ssh_prueba.txt && cat /tmp/ssh_prueba.txt && whoami && uname');
  check('ssh exec: redirección, && y órdenes de QSH', r3.status === 0 && /hola/.test(r3.stdout) && /qsecofr|demo/i.test(r3.stdout) && /OS400/.test(r3.stdout), `${r3.stdout} ${r3.stderr}`);
  const r4 = ssh('system "CHKOBJ OBJ(QGPL/NOEXISTE) OBJTYPE(*PGM)"');
  check('ssh exec: código de salida distinto de 0 si falla el CL', r4.status !== 0 && /CPF9801/.test(r4.stdout + r4.stderr), `${r4.status} ${r4.stdout} ${r4.stderr}`);

  // Clave no autorizada → rechazo
  const bad = path.join(dir, 'otra');
  execFileSync(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', bad]);
  const r5 = spawnSync(SSH, [...opts.map((o) => (o === key ? bad : o)), `${USER.toLowerCase()}@127.0.0.1`, 'pwd'], { encoding: 'utf8', timeout: 30000 });
  check('clave no autorizada: Permission denied', r5.status !== 0 && /denied/i.test(r5.stderr), `${r5.status} ${r5.stderr}`);

  // SFTP: subir/bajar al IFS y a un miembro de /QSYS.LIB
  await api('POST', '/commands', { command: 'DLTLIB LIB(SFTPLIB)' });
  await api('POST', '/commands', { command: 'CRTLIB LIB(SFTPLIB)' });
  await api('POST', '/commands', { command: 'CRTSRCPF FILE(SFTPLIB/QRPGLESRC)' });
  const local = path.join(dir, 'HOLA.rpgle');
  fs.writeFileSync(local, "**FREE\ndsply 'Hola desde SFTP';\n*inlr = *on;\n");
  const batch = path.join(dir, 'batch.txt');
  const back = path.join(dir, 'vuelta.txt');
  fs.writeFileSync(batch, [
    'cd /tmp', `put ${local.replace(/\\/g, '/')} sftp_ifs.txt`, 'ls -l',
    `put ${local.replace(/\\/g, '/')} /QSYS.LIB/SFTPLIB.LIB/QRPGLESRC.FILE/HOLA.MBR`,
    'ls /QSYS.LIB/SFTPLIB.LIB/QRPGLESRC.FILE', `get /tmp/sftp_ifs.txt ${back.replace(/\\/g, '/')}`, 'mkdir /tmp/dirsftp', 'rmdir /tmp/dirsftp', 'bye',
  ].join('\n'));
  const s = spawnSync(SFTP, [...opts.map((o) => (o === '-p' ? '-P' : o)), '-b', batch, `${USER.toLowerCase()}@127.0.0.1`], { encoding: 'utf8', timeout: 60000 });
  check('sftp put/ls/get en el IFS', s.status === 0 && /sftp_ifs\.txt/.test(s.stdout) && fs.existsSync(back) && /Hola desde SFTP/.test(fs.readFileSync(back, 'utf8')), `${s.status} ${s.stdout} ${s.stderr}`);
  check('sftp put a un miembro de /QSYS.LIB', /HOLA\.MBR/.test(s.stdout), s.stdout);
  const src = await api('GET', '/sources/SFTPLIB/QRPGLESRC/HOLA');
  check('el miembro subido por SFTP contiene el fuente', /Hola desde SFTP/.test(src.text), src.text.slice(0, 200));
  const cmp = await api('POST', '/commands', { command: 'CRTBNDRPG PGM(SFTPLIB/HOLA) SRCFILE(SFTPLIB/QRPGLESRC)' });
  check('el fuente subido por SFTP compila', cmp.status === 200, cmp.text.slice(0, 300));
  const ns = await api('POST', '/commands', { command: 'NETSTAT OPTION(*CNN)' });
  check('NETSTAT conoce el servidor *SSHD', /SSH|22/.test(ns.text), ns.text.slice(0, 200));
  await api('POST', '/commands', { command: 'DLTLIB LIB(SFTPLIB)' });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
