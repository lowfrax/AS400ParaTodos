// Seguridad de los servidores host: intercambio de semillas y verificación del sustituto de contraseña SHA-1
// (QPWDLVL 2/3), exactamente como lo calcula jt400 / IBM i Access:
//   token = SHA1(usuario UTF-16BE de 10 posiciones + contraseña UTF-16BE)
//   sustituto = SHA1(token + semilla servidor + semilla cliente + usuario UTF-16BE + secuencia 0000000000000001)
import crypto from 'node:crypto';
import { getUser, updateUser, sysval } from '../../objects.js';
import { logSecurity } from '../../svc/audit.js';
import { utf16be, unebc } from './ds.js';

// Códigos de retorno de seguridad de los servidores host (los que interpreta jt400)
export const RC = { OK: 0, USER_UNKNOWN: 0x00020001, USER_DISABLED: 0x00020002, PASSWORD_INCORRECT: 0x0003000b, PASSWORD_INCORRECT_DISABLED: 0x0003000c, PASSWORD_EXPIRED: 0x0003000d, AUTH_TYPE: 0x00010003 };

const SEQ = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);

export function substitute(tokenHex, serverSeed, clientSeed, user) {
  const uid = utf16be(String(user).toUpperCase().padEnd(10).slice(0, 10));
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(tokenHex, 'hex'), serverSeed, clientSeed, uid, SEQ])).digest();
}

/**
 * Verifica usuario (EBCDIC, 10 bytes) y sustituto de contraseña. Devuelve {rc, prf}.
 * authType: 1 = DES (8 bytes), 3 = SHA-1 (20 bytes), 7 = SHA-512 (64 bytes).
 */
export async function verifySubstitute(userEbcdic, authType, authBytes, serverSeed, clientSeed, { service, remote }) {
  const user = unebc(userEbcdic).trim().toUpperCase();
  const prf = user ? await getUser(user) : null;
  if (!prf) { logSecurity('PW', user, service, remote, 'User not found'); return { rc: RC.USER_UNKNOWN, user }; }
  if (prf.STATUS === '*DISABLED') { logSecurity('PW', user, service, remote, 'Profile disabled'); return { rc: RC.USER_DISABLED, user }; }
  if (authType !== 3 || authBytes.length !== 20) { logSecurity('PW', user, service, remote, `Unsupported password substitute type ${authType}`); return { rc: RC.PASSWORD_INCORRECT, user }; }
  const tokens = String(prf.PWDTOKEN || '').split(',').filter(Boolean);
  const ok = tokens.some((t) => crypto.timingSafeEqual(substitute(t, serverSeed, clientSeed, user), authBytes));
  if (!ok) {
    const max = Number((await sysval('QMAXSIGN')) || 3);
    const invalid = Number(prf.INVALID || 0) + 1;
    const disable = invalid >= max && user !== 'QSECOFR';
    await updateUser(user, { INVALID: invalid, ...(disable ? { STATUS: '*DISABLED' } : {}) });
    logSecurity('PW', user, service, remote, tokens.length ? 'Password not correct' : 'No password token (sign on once by 5250/FTP/REST to enable host servers)');
    return { rc: disable ? RC.PASSWORD_INCORRECT_DISABLED : RC.PASSWORD_INCORRECT, user };
  }
  if (Number(prf.INVALID || 0) > 0) await updateUser(user, { INVALID: 0 });
  logSecurity('SV', user, service, remote, 'Signed on');
  return { rc: RC.OK, prf, user };
}
