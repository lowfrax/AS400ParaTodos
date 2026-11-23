// Mini framework HTTP sin dependencias: rutas, estáticos, JSON/XML/formularios, CORS y Server-Sent Events.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wsdl': 'text/xml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.crt': 'application/x-x509-ca-cert',
  '.pem': 'application/x-pem-file',
};
export const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

// ---------------- CORS ----------------
// CORS_ORIGINS: '*' (por omisión) o lista separada por comas (admite comodines: https://*.miempresa.com).
// CORS_CREDENTIALS=true permite cookies/Authorization desde navegadores (refleja el Origin en lugar de '*').
export function corsConfig(env = process.env) {
  const raw = String(env.CORS_ORIGINS ?? '*').trim();
  const list = raw === '*' || raw === '' ? ['*'] : raw.split(/[\s,]+/).filter(Boolean);
  return {
    origins: list,
    credentials: /^(1|true|yes)$/i.test(String(env.CORS_CREDENTIALS || '')),
    methods: 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    headers: env.CORS_HEADERS || 'Authorization,Content-Type,Accept,X-Requested-With,X-Client,X-Request-Id,SOAPAction,Idempotency-Key,X-IBM-Client-Id',
    expose: 'X-Job,X-Request-Id,X-Total-Count,Location,Content-Disposition,WWW-Authenticate',
    maxAge: Number(env.CORS_MAX_AGE || 600),
  };
}

function originAllowed(cfg, origin) {
  if (!origin) return false;
  return cfg.origins.some((o) => {
    if (o === '*') return true;
    if (!o.includes('*')) return o.toLowerCase() === origin.toLowerCase();
    const re = new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`, 'i');
    return re.test(origin);
  });
}

/** Aplica cabeceras CORS. Devuelve true si la petición era un preflight ya respondido. */
export function applyCors(req, res, cfg) {
  if (!cfg) return false;
  const origin = req.headers.origin;
  const wildcard = cfg.origins.includes('*');
  if (origin && originAllowed(cfg, origin)) {
    res.setHeader('Access-Control-Allow-Origin', wildcard && !cfg.credentials ? '*' : origin);
    if (!wildcard || cfg.credentials) res.setHeader('Vary', 'Origin');
    if (cfg.credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', cfg.expose);
  } else if (!origin && wildcard) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  if (req.method === 'OPTIONS' && origin && req.headers['access-control-request-method']) {
    if (!originAllowed(cfg, origin)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('CORS origin not allowed'); return true; }
    res.writeHead(204, {
      'Access-Control-Allow-Methods': cfg.methods,
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || cfg.headers,
      'Access-Control-Max-Age': String(cfg.maxAge),
      ...(req.headers['access-control-request-private-network'] ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
    });
    res.end();
    return true;
  }
  return false;
}

// ---------------- Respuestas ----------------
export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? Number(v) : v));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(data);
}

export function send(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

export function readRaw(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Lee el cuerpo según Content-Type: JSON → objeto, formulario → objeto, el resto → texto (req.rawBody siempre es Buffer). */
export async function readBody(req, limit) {
  const raw = await readRaw(req, limit);
  req.rawBody = raw;
  const type = String(req.headers['content-type'] || '').toLowerCase();
  const text = raw.toString('utf8');
  if (!text) return type.includes('json') || !type ? {} : '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  if (type.includes('json') || (!type && /^\s*[[{]/.test(text))) {
    try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  return text;
}

// Hub de Server-Sent Events: los dashboards se suscriben y reciben datos en tiempo real.
export class SSEHub {
  constructor() { this.clients = new Set(); }
  handle(req, res, initial) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    if (initial) for (const [ev, data] of initial) this.#write(res, ev, data);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }
  #write(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  broadcast(event, data) {
    for (const c of this.clients) this.#write(c, event, data);
  }
  get size() { return this.clients.size; }
}

/**
 * createApp({cors}) → app con get/post/put/patch/del/all(ruta, handler), use(middleware) y static(prefijo, dir).
 * Rutas: '/a/:x/b' (parámetros) y '/a/*' (resto de la ruta en req.params['*']).
 */
export function createApp(opts = {}) {
  const routes = [];
  const statics = [];
  const middleware = [];
  const cors = opts.cors === false ? null : (opts.cors || corsConfig());
  const add = (method) => (p, h) => routes.push({ method, p, h });
  const app = {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    del: add('DELETE'),
    all: add('*'),
    use: (fn) => middleware.push(fn),
    static: (prefix, dir) => statics.push({ prefix, dir: path.resolve(dir) }),
    cors,
    server: null,
    handler,
    listen(port, hostOrCb, cb) {
      const host = typeof hostOrCb === 'string' ? hostOrCb : undefined;
      const done = typeof hostOrCb === 'function' ? hostOrCb : cb;
      this.server = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler);
      this.server.listen(port, host, done);
      return this.server;
    },
  };

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    req.searchParams = url.searchParams;
    if (applyCors(req, res, cors)) return;
    if (req.method === 'OPTIONS') { res.writeHead(204, { Allow: cors?.methods || 'GET,POST,OPTIONS' }); return res.end(); }
    try {
      for (const m of middleware) if ((await m(req, res)) === false || res.writableEnded) return;
    } catch (e) {
      return fail(req, res, e);
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    for (const r of routes) {
      if (r.method !== '*' && r.method !== method) continue;
      const params = match(r.p, url.pathname);
      if (!params) continue;
      req.params = params;
      try {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !r.h.raw) req.body = await readBody(req);
        await r.h(req, res);
      } catch (e) {
        fail(req, res, e);
      }
      return;
    }
    if (method === 'GET') {
      for (const s of statics) {
        if (!url.pathname.startsWith(s.prefix)) continue;
        let rel;
        try { rel = decodeURIComponent(url.pathname.slice(s.prefix.length)); } catch { break; }
        if (!rel || rel.endsWith('/')) rel += 'index.html';
        const file = path.resolve(s.dir, '.' + path.sep + rel);
        if (!file.startsWith(s.dir)) break;
        try {
          const st = fs.statSync(file);
          if (st.isFile()) {
            res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
            if (req.method === 'HEAD') return res.end();
            fs.createReadStream(file).pipe(res);
            return;
          }
        } catch { /* sigue buscando */ }
      }
    }
    if (opts.notFound) return opts.notFound(req, res);
    sendJson(res, 404, { error: 'Not found', path: url.pathname });
  }

  function fail(req, res, e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[http] ${req.method} ${req.path}:`, e);
    if (opts.onError) return opts.onError(req, res, e);
    if (!res.headersSent) sendJson(res, status, { error: e.message, ...(e.msgId ? { msgId: e.msgId } : {}) }, e.headers || {});
    else res.end();
  }
  return app;
}

function match(pattern, pathname) {
  const pp = pattern.split('/').filter(Boolean);
  const up = pathname.split('/').filter(Boolean);
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i] === '*') {
      params['*'] = up.slice(i).map(safeDecode).join('/');
      return params;
    }
    if (i >= up.length) return null;
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = safeDecode(up[i]);
    else if (pp[i].toLowerCase() !== up[i].toLowerCase()) return null;
  }
  return pp.length === up.length ? params : null;
}
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// Cliente JSON sencillo para comunicación entre servicios.
export async function postJson(url, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await r.json();
    if (!r.ok && data && !data.sqlstate) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

export async function getJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
