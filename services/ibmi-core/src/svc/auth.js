// Autenticación de los servidores (FTP, REXEC, HTTP, Mapepire, servidores host…) contra los perfiles de usuario,
// con las mismas reglas que Sign On: QMAXSIGN, perfiles *DISABLED y contraseñas *NONE.
// Además: tokens JWT (HS256) para la API REST y OAuth2 (client_credentials) para Open Banking.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getUser, updateUser, hashPassword, sysval, passwordTokens } from '../objects.js';
import { msgText } from '../messages.js';
import { logSecurity } from './audit.js';

export class AuthError extends Error {
  constructor(msgId, text, status = 401) { super(text); this.msgId = msgId; this.status = status; }
}

/** Valida usuario/contraseña. Devuelve la fila de QSYS.USRPRF o lanza AuthError. */
export async function authenticate(user, password, { service = 'API', remote = '' } = {}) {
  const u = String(user || '').trim().toUpperCase();
  const pwd = String(password ?? '').trim().toUpperCase();
  if (!u) throw new AuthError('CPF1120', msgText('CPF1120', ''), 401);
  const prf = await getUser(u);
  if (!prf) { logSecurity('PW', u, service, remote, 'User not found'); throw new AuthError('CPF2204', msgText('CPF2204S', u)); }
  if (prf.STATUS === '*DISABLED') { logSecurity('PW', u, service, remote, 'Profile disabled'); throw new AuthError('CPF22E3', msgText('CPF22E3', u), 403); }
  if (!prf.PWDHASH || prf.PWDHASH !== hashPassword(u, pwd)) {
    const max = Number((await sysval('QMAXSIGN')) || 3);
    const invalid = Number(prf.INVALID || 0) + 1;
    const disable = invalid >= max && u !== 'QSECOFR';
    await updateUser(u, { INVALID: invalid, ...(disable ? { STATUS: '*DISABLED' } : {}) });
    logSecurity('PW', u, service, remote, disable ? 'Profile disabled after QMAXSIGN' : 'Password not correct');
    throw new AuthError(disable ? 'CPF22E3' : 'CPF22E2', disable ? msgText('CPF22E3', u) : msgText('CPF22E2', u));
  }
  if (Number(prf.INVALID || 0) > 0) await updateUser(u, { INVALID: 0 });
  if (!prf.PWDTOKEN) await updateUser(u, { PWDTOKEN: passwordTokens(u, pwd) }).catch(() => {});
  logSecurity('SV', u, service, remote, 'Signed on');
  return prf;
}

// ---------- Basic ----------
export function parseBasic(header) {
  const m = /^Basic\s+(.+)$/i.exec(String(header || ''));
  if (!m) return null;
  const raw = Buffer.from(m[1], 'base64').toString('utf8');
  const i = raw.indexOf(':');
  return i < 0 ? null : { user: raw.slice(0, i), password: raw.slice(i + 1) };
}

// ---------- JWT HS256 ----------
const keyFile = () => path.join(process.env.IFS_ROOT || path.resolve('.ifs'), 'QIBM', 'UserData', 'OS', 'jwt.key');
let secret = null;
function jwtSecret() {
  if (secret) return secret;
  if (process.env.JWT_SECRET) return (secret = Buffer.from(process.env.JWT_SECRET));
  const f = keyFile();
  try { secret = fs.readFileSync(f); } catch {
    secret = crypto.randomBytes(48);
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, secret, { mode: 0o600 }); } catch { /* sin IFS: clave volátil */ }
  }
  return secret;
}
const b64u = (b) => Buffer.from(b).toString('base64url');

export function signToken(claims, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: `ibmi:${process.env.SYSTEM_NAME || 'AS400TDS'}`, iat: now, exp: now + ttlSeconds, jti: crypto.randomUUID(), ...claims };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const pay = b64u(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', jwtSecret()).update(`${head}.${pay}`).digest('base64url');
  return { token: `${head}.${pay}.${sig}`, expiresIn: ttlSeconds, claims: body };
}

export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError('CPF22E2', 'Malformed token.');
  const expect = crypto.createHmac('sha256', jwtSecret()).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) throw new AuthError('CPF22E2', 'Invalid token signature.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) throw new AuthError('CPF22E2', 'Token expired.');
  return claims;
}

/**
 * Resuelve el usuario de una petición HTTP: Authorization Basic (perfil IBM i) o Bearer (JWT emitido por /api/v1/auth/token).
 * Devuelve {prf, claims, method} o null si no hay credenciales.
 */
export async function authHttp(req) {
  const h = req.headers.authorization;
  if (!h) return null;
  if (/^Bearer\s+/i.test(h)) {
    const claims = verifyToken(h.replace(/^Bearer\s+/i, '').trim());
    const prf = claims.usr ? await getUser(claims.usr) : null;
    if (claims.usr && (!prf || prf.STATUS === '*DISABLED')) throw new AuthError('CPF22E3', `User profile ${claims.usr} cannot be used.`, 403);
    return { prf, claims, method: 'bearer' };
  }
  const b = parseBasic(h);
  if (!b) throw new AuthError('CPF22E2', 'Unsupported authorization scheme.');
  const prf = await authenticate(b.user, b.password, { service: 'HTTP', remote: req.socket?.remoteAddress || '' });
  return { prf, claims: null, method: 'basic' };
}
