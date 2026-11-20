// Mini framework HTTP sin dependencias: rutas, estáticos, JSON y Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
};

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Hub de Server-Sent Events: los dashboards se suscriben y reciben datos en tiempo real.
export class SSEHub {
  constructor() { this.clients = new Set(); }
  handle(req, res, initial) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
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

export function createApp() {
  const routes = [];
  const statics = [];
  const app = {
    get: (p, h) => routes.push({ method: 'GET', p, h }),
    post: (p, h) => routes.push({ method: 'POST', p, h }),
    del: (p, h) => routes.push({ method: 'DELETE', p, h }),
    static: (prefix, dir) => statics.push({ prefix, dir: path.resolve(dir) }),
    server: null,
    listen(port, cb) {
      this.server = http.createServer(handler);
      this.server.listen(port, cb);
      return this.server;
    },
  };

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = match(r.p, url.pathname);
      if (!params) continue;
      req.params = params;
      req.query = Object.fromEntries(url.searchParams);
      try {
        if (req.method === 'POST') req.body = await readBody(req);
        await r.h(req, res);
      } catch (e) {
        console.error(`[http] ${req.method} ${url.pathname}:`, e);
        if (!res.headersSent) sendJson(res, 500, { error: e.message });
      }
      return;
    }
    if (req.method === 'GET') {
      for (const s of statics) {
        if (!url.pathname.startsWith(s.prefix)) continue;
        let rel = decodeURIComponent(url.pathname.slice(s.prefix.length));
        if (!rel || rel.endsWith('/')) rel += 'index.html';
        const file = path.resolve(s.dir, '.' + path.sep + rel);
        if (!file.startsWith(s.dir)) break;
        try {
          const st = fs.statSync(file);
          if (st.isFile()) {
            res.writeHead(200, {
              'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
              'Content-Length': st.size,
              'Cache-Control': 'no-cache',
            });
            fs.createReadStream(file).pipe(res);
            return;
          }
        } catch { /* sigue buscando */ }
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  }
  return app;
}

function match(pattern, pathname) {
  const pp = pattern.split('/').filter(Boolean);
  const up = pathname.split('/').filter(Boolean);
  if (pp.length !== up.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(up[i]);
    else if (pp[i] !== up[i]) return null;
  }
  return params;
}

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
