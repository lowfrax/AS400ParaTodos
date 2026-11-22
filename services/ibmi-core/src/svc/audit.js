// Diario de auditoría de seguridad (equivalente simplificado a QAUDJRN): entradas PW (contraseña incorrecta),
// SV (inicio de sesión en un servidor), AF (autorización denegada), CA (cambio)… Se consulta con DSPAUDJRNE y la API REST.
import { EventEmitter } from 'node:events';

export const auditEvents = new EventEmitter();
const entries = [];
let seq = 0;

export function logSecurity(type, user, service, remote, text) {
  const e = { seq: ++seq, t: Date.now(), type, user: user || '', service, remote: String(remote || '').replace('::ffff:', ''), text };
  entries.push(e);
  if (entries.length > 2000) entries.shift();
  auditEvents.emit('entry', e);
  return e;
}

export function auditEntries({ type, user, limit = 200 } = {}) {
  let r = entries;
  if (type) r = r.filter((e) => e.type === type);
  if (user) r = r.filter((e) => e.user === user);
  return r.slice(-limit);
}
