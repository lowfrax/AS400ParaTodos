// Utilidades del servidor HTTP: autenticación por petición, trabajo de servidor del usuario y respuestas de error.
import { sendJson } from '../../../../../shared/http.js';
import { authHttp, AuthError } from '../../svc/auth.js';
import { pooledCtx, serverCtx, endServerCtx } from '../../svc/jobs.js';
import { getUser } from '../../objects.js';
import { withCtx } from '../../security.js';

export const isSecofr = (prf) => ['*SECOFR', '*SECADM'].includes(prf?.USRCLS);

/** Exige credenciales (Basic con perfil IBM i o Bearer JWT). Devuelve {prf, claims}. */
export async function requireAuth(req, res, { realm = 'IBM i', scope } = {}) {
  let a;
  try { a = await authHttp(req); } catch (e) {
    const status = e.status || 401;
    sendJson(res, status, { error: { id: e.msgId || 'CPF22E2', text: e.message } }, status === 401 ? { 'WWW-Authenticate': `Basic realm="${realm}"` } : {});
    return null;
  }
  if (!a) {
    sendJson(res, 401, { error: { id: 'CPF22E2', text: 'Authentication required (Basic with an IBM i user profile, or Bearer token from POST /api/v1/auth/token).' } }, { 'WWW-Authenticate': `Basic realm="${realm}"` });
    return null;
  }
  if (scope && a.claims && a.claims.scope && !String(a.claims.scope).split(/\s+/).includes(scope) && !String(a.claims.scope).split(/\s+/).includes('*ALL')) {
    sendJson(res, 403, { error: { id: 'CPF2189', text: `Token scope does not include ${scope}.` } });
    return null;
  }
  if (!a.prf && a.claims?.usr) a.prf = await getUser(a.claims.usr);
  return a;
}

/** Contexto (trabajo QZHBHTTP del usuario) para atender la petición. */
export async function userCtx(prf, kind = 'QZHBHTTP') {
  return pooledCtx(kind, prf, { subsystem: 'QHTTPSVR', type: 'BCH', fn: 'PGM-QZHBHTTP' });
}

/** Contexto efímero (para operaciones que cambian el estado del trabajo, p. ej. transacciones o CGI). */
export async function freshCtx(prf, name = 'QZHBHTTP') {
  return serverCtx(prf, { name, subsystem: 'QHTTPSVR', type: 'BCH', fn: 'PGM-QZHBHTTP' });
}
export { endServerCtx };

export function fail(res, e, status) {
  const st = status || e.status || (e instanceof AuthError ? 401 : e.msgId && /^CPF(9801|9811|9812|9815|2105|2110|4101)|^CPFA0A9/.test(e.msgId) ? 404 : e.msgId === 'CPFA09C' || e.msgId === 'CPF9802' ? 403 : e.msgId ? 400 : 500);
  if (st >= 500) console.error('[http]', e);
  return sendJson(res, st, { error: { id: e.msgId || e.sqlstate || 'CPF9898', text: e.message, ...(e.sqlstate ? { sqlstate: e.sqlstate, sqlcode: e.sqlcode } : {}) } });
}

/** Envuelve un manejador que necesita usuario: h(req, res, {prf, ctx, claims}). */
export function authed(h, opts = {}) {
  return async (req, res) => {
    const a = await requireAuth(req, res, opts);
    if (!a) return;
    if (opts.secofr && !isSecofr(a.prf)) return sendJson(res, 403, { error: { id: 'CPF2189', text: 'Not authorized. User class *SECOFR required.' } });
    try {
      const ctx = a.prf ? await userCtx(a.prf) : null;
      await withCtx(ctx, () => h(req, res, { ...a, ctx }));
    } catch (e) { fail(res, e); }
  };
}

export const upper = (s) => String(s || '').trim().toUpperCase();
export const rowsToObjects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])));
