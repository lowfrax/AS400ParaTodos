// CGI de IBM HTTP Server: /cgi-bin/PGM.pgm y /QSYS.LIB/BIB.LIB/PGM.PGM ejecutan programas RPG/CL que escriben la
// respuesta con QtmhWrStout y leen la entrada con QtmhRdStin / QtmhGetEnv (o getenv). Se ejecutan con el perfil
// QTMHHTP1, como en IBM i. También publica el contenido estático de /www/apachedft/htdocs (IFS).
import path from 'node:path';
import { send } from '../../../../../shared/http.js';
import { mimeOf } from '../../../../../shared/http.js';
import { serverCtx, endServerCtx } from '../../svc/jobs.js';
import { callProgram } from '../../runtime/call.js';
import * as ifs from '../../ifs.js';
import { getUser } from '../../objects.js';
import { SYS } from '../../system.js';

const CGI_LIB = () => String(process.env.CGI_LIBRARY || 'DEMOLIB').toUpperCase();

async function runCgi(req, res, lib, pgm) {
  const prf = (await getUser('QTMHHTP1')) || (await getUser('QSECOFR'));
  const ctx = await serverCtx(prf, { name: 'QZHBHTTP', subsystem: 'QHTTPSVR', type: 'BCH', fn: `PGM-${pgm}` });
  ctx.job.libl = [lib, ...ctx.job.libl.filter((l) => l !== lib)];
  const url = new URL(req.url, 'http://x');
  ctx.cgi = {
    stdin: req.rawBody || Buffer.alloc(0),
    out: [],
    env: {
      REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1), CONTENT_LENGTH: String(req.rawBody?.length || 0), CONTENT_TYPE: req.headers['content-type'] || '',
      PATH_INFO: '', SCRIPT_NAME: url.pathname, SERVER_NAME: SYS.name, SERVER_SOFTWARE: 'IBM_HTTP_Server/7.5 (AS400 para Todos)', SERVER_PROTOCOL: 'HTTP/1.1',
      REMOTE_ADDR: (req.socket.remoteAddress || '').replace('::ffff:', ''), HTTP_USER_AGENT: req.headers['user-agent'] || '', HTTP_COOKIE: req.headers.cookie || '',
      HTTP_ACCEPT: req.headers.accept || '', REMOTE_USER: '', GATEWAY_INTERFACE: 'CGI/1.1', CGI_MODE: 'EBCDIC',
    },
  };
  try {
    await callProgram(ctx, pgm, lib, []);
  } catch (e) {
    endServerCtx(ctx, false);
    return send(res, 500, `<html><body><h1>500 Internal Server Error</h1><p>${e.msgId || ''} ${String(e.message).replace(/</g, '&lt;')}</p></body></html>`, 'text/html; charset=utf-8');
  }
  endServerCtx(ctx);
  const raw = ctx.cgi.out.join('');
  // Cabeceras CGI: hasta la primera línea en blanco
  const m = /\r?\n\r?\n/.exec(raw);
  let headers = { 'Content-Type': 'text/html; charset=utf-8' };
  let body = raw;
  let status = 200;
  if (m && /^[\w-]+:/.test(raw)) {
    body = raw.slice(m.index + m[0].length);
    for (const line of raw.slice(0, m.index).split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (/^status$/i.test(k)) status = Number(v.split(' ')[0]) || 200;
      else if (/^content-type$/i.test(k)) headers['Content-Type'] = /charset/i.test(v) || !/^text\//i.test(v) ? v : `${v}; charset=utf-8`;
      else headers[k] = v;
    }
    if (headers.Location && status === 200) status = 302;
  }
  send(res, status, body, headers['Content-Type'], headers);
}

export function mountCgi(app) {
  app.all('/cgi-bin/:pgm', (req, res) => {
    const pgm = String(req.params.pgm).replace(/\.pgm$/i, '').toUpperCase();
    return runCgi(req, res, CGI_LIB(), pgm);
  });
  app.all('/QSYS.LIB/:lib/:pgm', (req, res) => {
    const lib = String(req.params.lib).replace(/\.LIB$/i, '').toUpperCase();
    const pgm = String(req.params.pgm).replace(/\.PGM$/i, '').toUpperCase();
    return runCgi(req, res, lib, pgm);
  });
}

/** Archivos estáticos del IFS (document root de APACHEDFT). */
export async function serveHtdocs(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let p = ifs.normPath(`/www/apachedft/htdocs${decodeURIComponent(req.path || '/')}`);
  if (!p.startsWith('/www/apachedft/htdocs')) return false;
  let st = await ifs.stat(p);
  if (st?.dir) { p = `${p}/index.html`; st = await ifs.stat(p); }
  if (!st || st.dir) return false;
  send(res, 200, req.method === 'HEAD' ? '' : await ifs.readFile(p), mimeOf(path.basename(p)));
  return true;
}
