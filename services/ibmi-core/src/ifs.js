// IFS (Integrated File System): directorios y archivos continuos (stream files) sobre un volumen del contenedor.
// /QSYS.LIB/... es un sistema de archivos virtual sobre bibliotecas, archivos y miembros (ver qsyslib.js).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLError } from './messages.js';
import * as aut from './ifsaut.js';

export const IFS_ROOT = path.resolve(process.env.IFS_ROOT || path.resolve('.ifs'));

export const BASE_DIRS = [
  '/home', '/tmp', '/QIBM', '/QIBM/UserData', '/QIBM/UserData/OS', '/QIBM/UserData/ICSS/Cert/Server', '/QIBM/ProdData',
  '/QOpenSys', '/QOpenSys/pkgs', '/QOpenSys/pkgs/bin', '/www', '/www/apachedft', '/www/apachedft/htdocs',
  '/banco', '/banco/entrada', '/banco/salida', '/banco/swift', '/banco/swift/in', '/banco/swift/out', '/banco/ach', '/banco/procesados', '/banco/error',
  '/QNTC', '/QDLS', '/QOPT',
];

export function initIfs() {
  for (const d of BASE_DIRS) fs.mkdirSync(real(d), { recursive: true });
  const index = real('/www/apachedft/htdocs/index.html');
  if (!fs.existsSync(index)) {
    fs.writeFileSync(index, `<!doctype html><html><head><meta charset="utf-8"><title>IBM HTTP Server</title></head><body style="font-family:sans-serif">
<h1>IBM HTTP Server for i</h1><p>Servidor HTTP del sistema (APACHEDFT). Los archivos de <code>/www/apachedft/htdocs</code> del IFS se publican aquí.</p>
<ul><li><a href="/openapi.json">API REST (OpenAPI)</a></li><li><a href="/docs/">Documentación de la API</a></li><li><a href="/web/services/">Servicios web (IWS)</a></li><li><a href="/cgi-bin/xmlcgi.pgm">XMLSERVICE</a></li></ul></body></html>\n`);
  }
  const readme = real('/banco/LEAME.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, 'Directorios de intercambio del core bancario:\n  entrada/  archivos CSV de transferencias a procesar (BANCO/CARGATRF)\n  salida/   extractos y reportes generados\n  swift/in  mensajes MT103 / pacs.008 entrantes\n  swift/out mensajes camt.053 / MT940 salientes\n  ach/      lotes de compensacion (NACHA / layout SPEI)\n');
  }
}

export function homeDir(user) {
  const d = `/home/${String(user).toUpperCase()}`;
  try { fs.mkdirSync(real(d), { recursive: true }); } catch { /* ignorar */ }
  aut.ensureHome(d, user).catch(() => {});
  return d;
}

const parentPath = (p) => (p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/');
/** Antes de crear p (y los directorios intermedios que falten): *WX sobre el directorio existente más cercano. */
async function beforeCreate(p) {
  let dir = parentPath(p);
  const missing = [];
  while (dir !== '/' && !fs.existsSync(real(dir))) { missing.unshift(dir); dir = parentPath(dir); }
  await aut.check(dir, 'create');
  return missing;
}
async function afterCreate(missing, p, opts) {
  for (const d of missing) await aut.created(d).catch(() => {});
  if (p) await aut.created(p, opts).catch(() => {});
}
/** Comprobación previa para quien abre la ruta directamente (SFTP): 'r', 'w' o creación. */
export async function checkOpen(p, write) {
  const n = normPath(p);
  if (fs.existsSync(real(n))) { await aut.check(n, write ? 'w' : 'r'); return async () => {}; }
  if (!write) return async () => {};
  const missing = await beforeCreate(n);
  return () => afterCreate(missing, n);
}

/** Normaliza una ruta IFS (absoluta o relativa al directorio actual). */
export function normPath(p, cwd = '/') {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  if (!s) s = cwd || '/';
  if (!s.startsWith('/')) s = `${cwd || '/'}/${s}`;
  const out = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return `/${out.join('/')}`;
}

export const isQsys = (p) => /^\/QSYS\.LIB(\/|$)/i.test(p);

/** Ruta real en disco para una ruta IFS (nunca sale de IFS_ROOT). */
export function real(p) {
  const n = normPath(p);
  const r = path.resolve(IFS_ROOT, `.${n}`);
  if (r !== IFS_ROOT && !r.startsWith(IFS_ROOT + path.sep)) throw new CLError('CPFA09C', p);
  return r;
}

export async function stat(p) {
  try {
    const st = await fsp.stat(real(p));
    const n = normPath(p);
    return { path: n, name: path.posix.basename(n) || '/', dir: st.isDirectory(), size: st.size, mtime: st.mtime, ctime: st.birthtime || st.ctime, type: st.isDirectory() ? '*DIR' : '*STMF', owner: aut.metaOf(n).owner };
  } catch { return null; }
}

export async function list(p) {
  const dir = real(p);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) await aut.check(normPath(p), 'list');
  let names;
  try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOTDIR') { const s = await stat(p); return s ? [s] : []; }
    throw new CLError('CPFA0A9', p);
  }
  const out = [];
  for (const d of names) {
    const child = normPath(`${normPath(p)}/${d.name}`);
    const s = await stat(child);
    if (s) out.push(s);
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return out;
}

export async function readFile(p) {
  if (fs.existsSync(real(p))) await aut.check(normPath(p), 'r');
  try { return await fsp.readFile(real(p)); } catch (e) {
    if (e.code === 'EISDIR') throw new CLError('CPFA0AB', p, 'Object is a directory.');
    throw new CLError('CPFA0A9', p);
  }
}

export async function writeFile(p, data, { append = false, replace = true } = {}) {
  const r = real(p);
  const n = normPath(p);
  const exists = fs.existsSync(r);
  if (!replace && exists) throw new CLError('CPFA0A0', p);
  let missing = [];
  if (exists) await aut.check(n, 'w'); else missing = await beforeCreate(n);
  try {
    await fsp.mkdir(path.dirname(r), { recursive: true });
    if (append) await fsp.appendFile(r, data); else await fsp.writeFile(r, data);
  } catch (e) { throw new CLError('CPFA0AB', p, e.message); }
  if (!exists) await afterCreate(missing, n);
}

export function writeStream(p, { append = false } = {}) {
  const r = real(p);
  fs.mkdirSync(path.dirname(r), { recursive: true });
  return fs.createWriteStream(r, { flags: append ? 'a' : 'w' });
}
export function readStream(p, start = 0) { return fs.createReadStream(real(p), { start }); }

export async function mkdir(p, { parents = false } = {}) {
  const r = real(p);
  const n = normPath(p);
  if (fs.existsSync(r)) throw new CLError('CPFA0A0', p);
  if (!parents && !fs.existsSync(path.dirname(r))) throw new CLError('CPFA0A9', p);
  const missing = await beforeCreate(n);
  try { await fsp.mkdir(r, { recursive: parents }); } catch (e) { throw new CLError(e.code === 'ENOENT' ? 'CPFA0A9' : 'CPFA0AB', p, e.message); }
  await afterCreate(missing, n);
}

export async function rmdir(p, { recursive = false } = {}) {
  const r = real(p);
  if (r === IFS_ROOT) throw new CLError('CPFA09C', p);
  const n = normPath(p);
  if (fs.existsSync(r)) {
    await aut.check(n, 'delete');
    // SUBTREE(*ALL): hace falta poder borrar cada objeto del subárbol
    if (recursive) for (const e of await walk(n, 64)) await aut.check(e.path, 'delete');
  }
  // fsp.rm sin recursive rechaza cualquier directorio (ERR_FS_EISDIR): un directorio vacío se borra con rmdir
  try { await (recursive ? fsp.rm(r, { recursive: true, force: false }) : fsp.rmdir(r)); } catch (e) {
    if (e.code === 'ENOENT') throw new CLError('CPFA0A9', p);
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') throw new CLError('CPFA0AB', p, 'Directory not empty.');
    throw new CLError('CPFA0AB', p, e.message);
  }
  await aut.removed(n).catch(() => {});
}

export async function unlink(p) {
  const s = await stat(p);
  if (!s) throw new CLError('CPFA0A9', p);
  if (s.dir) throw new CLError('CPFA0AB', p, 'Object is a directory. Use RMVDIR.');
  await aut.check(s.path, 'delete');
  await fsp.unlink(real(p));
  await aut.removed(s.path).catch(() => {});
}

export async function rename(from, to) {
  if (!(await stat(from))) throw new CLError('CPFA0A9', from);
  if (await stat(to)) throw new CLError('CPFA0A0', to);
  const f = normPath(from), t = normPath(to);
  await aut.check(f, 'rename');
  const missing = await beforeCreate(t);
  await fsp.mkdir(path.dirname(real(to)), { recursive: true });
  await fsp.rename(real(from), real(to));
  await afterCreate(missing, null);
  await aut.moved(f, t).catch(() => {});
}

export async function copy(from, to, { replace = false } = {}) {
  if (!(await stat(from))) throw new CLError('CPFA0A9', from);
  const exists = !!(await stat(to));
  if (!replace && exists) throw new CLError('CPFA0A0', to);
  const f = normPath(from), t = normPath(to);
  await aut.check(f, 'r');
  let missing = [];
  if (exists) await aut.check(t, 'w'); else missing = await beforeCreate(t);
  await fsp.mkdir(path.dirname(real(to)), { recursive: true });
  await fsp.copyFile(real(from), real(to));
  if (!exists) await afterCreate(missing, t, { from: f });
}

/** Estadísticas para QSYS2.IFS_OBJECT_STATISTICS. */
export async function walk(p, depth = 1) {
  const out = [];
  const go = async (dir, d) => {
    for (const e of await list(dir).catch(() => [])) {
      out.push(e);
      if (e.dir && d > 0) await go(e.path, d - 1);
    }
  };
  await go(p, depth);
  return out;
}

/** Permisos estilo UNIX para listados FTP/QSH. */
export function modeString(s) { return aut.modeString(s.path || '/', s.dir); }
