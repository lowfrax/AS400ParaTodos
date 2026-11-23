// Cliente HTTP saliente del sistema (QSYS2.HTTP_*, SYSTOOLS.HTTP*CLOB, HTTPAPI desde RPG, webhooks).
// Registra cada llamada para el panel de conexiones salientes y respeta una lista blanca opcional (HTTP_ALLOW).
import { EventEmitter } from 'node:events';

export const outboundEvents = new EventEmitter();
const log = [];

function allowed(url) {
  const list = String(process.env.HTTP_ALLOW || '').split(/[\s,]+/).filter(Boolean);
  if (!list.length) return true;
  const host = new URL(url).hostname;
  return list.some((h) => h === host || (h.startsWith('*.') && host.endsWith(h.slice(1))));
}

/** Petición HTTP(S). Devuelve {status, headers, body(string)}. */
export async function httpRequest({ method = 'GET', url, headers = {}, body, timeout = 60000, client = '' }) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error(`URL not valid: ${url}`);
  if (!allowed(url)) throw new Error(`Host not allowed by HTTP_ALLOW: ${new URL(url).hostname}`);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const entry = { t: t0, method: String(method).toUpperCase(), url: String(url), client, status: 0, ms: 0, bytes: 0 };
  try {
    const r = await fetch(url, { method: entry.method, headers, body: ['GET', 'HEAD'].includes(entry.method) ? undefined : body, signal: ctrl.signal, redirect: 'follow' });
    const text = await r.text();
    entry.status = r.status;
    entry.bytes = text.length;
    return { status: r.status, headers: Object.fromEntries(r.headers), body: text };
  } catch (e) {
    entry.error = e.name === 'AbortError' ? `Timeout after ${timeout} ms` : e.message;
    throw new Error(entry.error);
  } finally {
    clearTimeout(timer);
    entry.ms = Date.now() - t0;
    log.push(entry);
    if (log.length > 200) log.shift();
    outboundEvents.emit('request', entry);
  }
}

export function outboundLog(n = 100) { return log.slice(-n); }
