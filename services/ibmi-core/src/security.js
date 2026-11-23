// Seguridad a nivel de objeto, como en IBM i (QSECURITY 40):
//   autorizaciones de objeto  *OBJOPR *OBJMGT *OBJEXIST *OBJALTER *OBJREF
//   autorizaciones de datos   *READ *ADD *UPD *DLT *EXECUTE
//   conjuntos                 *ALL  *CHANGE  *USE  *EXCLUDE   (y *AUTL: la del *PUBLIC de la lista de autorizaciones)
// Orden de comprobación: *ALLOBJ → propietario → autorización privada del usuario → del perfil de grupo
//   → lista de autorizaciones que protege el objeto → *PUBLIC (por omisión, QCRTAUT = *CHANGE).
// Las filas viven en QSYS.OBJAUT (LIB, NAME, TYPE, USR, AUT); USR = '*PUBLIC' o '*AUTL' (AUT = nombre de la lista).
import { AsyncLocalStorage } from 'node:async_hooks';
import { gw } from './objects.js';
import { CLError } from './messages.js';

export const OBJ_AUTS = ['*OBJOPR', '*OBJMGT', '*OBJEXIST', '*OBJALTER', '*OBJREF'];
export const DATA_AUTS = ['*READ', '*ADD', '*UPD', '*DLT', '*EXECUTE'];
const ALL_SPECIFIC = [...OBJ_AUTS, ...DATA_AUTS];
const SETS = {
  '*ALL': ALL_SPECIFIC,
  '*CHANGE': ['*OBJOPR', ...DATA_AUTS],
  '*USE': ['*OBJOPR', '*READ', '*EXECUTE'],
  '*EXCLUDE': [],
};
// Lo que hace falta para cada operación
export const NEED = {
  USE: ['*OBJOPR', '*READ', '*EXECUTE'],
  READ: ['*OBJOPR', '*READ'],
  EXECUTE: ['*OBJOPR', '*EXECUTE'],
  CHANGE: ['*OBJOPR', '*READ', '*ADD', '*UPD', '*DLT'],
  ADD: ['*OBJOPR', '*ADD'],
  UPD: ['*OBJOPR', '*UPD'],
  DLT: ['*OBJOPR', '*DLT'],
  EXIST: ['*OBJEXIST'],
  MGT: ['*OBJOPR', '*OBJMGT'],
  ALTER: ['*OBJOPR', '*OBJALTER'],
  ALL: ALL_SPECIFIC,
};

/** Conjunto de autorizaciones específicas a partir de una lista (*CHANGE, *READ…). */
export function expand(list) {
  const out = new Set();
  for (const a of [].concat(list || []).flatMap((x) => String(x).toUpperCase().split(/\s+/)).filter(Boolean)) {
    if (SETS[a]) SETS[a].forEach((x) => out.add(x));
    else if (ALL_SPECIFIC.includes(a)) out.add(a);
  }
  return out;
}

/** Nombre del conjunto (*ALL/*CHANGE/*USE/*EXCLUDE) o USER DEF, como en EDTOBJAUT/DSPOBJAUT. */
export function setName(auts) {
  const s = auts instanceof Set ? auts : expand(auts);
  for (const [n, v] of Object.entries(SETS)) if (v.length === s.size && v.every((x) => s.has(x))) return n;
  return 'USER DEF';
}

// ---------- Usuario actual (para las comprobaciones de bajo nivel) ----------
export const als = new AsyncLocalStorage();
export const currentCtx = () => als.getStore() || null;
export const withCtx = (ctx, fn) => (ctx ? als.run(ctx, fn) : fn());

// ---------- Autorizaciones especiales ----------
const CLASS_SPCAUT = {
  '*SECOFR': ['*ALLOBJ', '*SECADM', '*SAVSYS', '*JOBCTL', '*SPLCTL', '*SERVICE', '*AUDIT', '*IOSYSCFG'],
  '*SECADM': ['*SECADM'],
  '*PGMR': ['*SAVSYS', '*JOBCTL'],
  '*SYSOPR': ['*SAVSYS', '*JOBCTL'],
  '*USER': [],
};
export function specialAuthorities(prf) {
  if (!prf) return [];
  const raw = String(prf.SPCAUT || '*USRCLS').trim().toUpperCase();
  if (raw === '*USRCLS' || !raw) return CLASS_SPCAUT[prf.USRCLS] || [];
  if (raw === '*NONE') return [];
  return raw.split(/\s+/);
}
export const hasSpecial = (prf, a) => specialAuthorities(prf).includes(a);

// ---------- Filas de autorización (con caché) ----------
const cache = new Map();
const key = (lib, name, type) => `${lib}/${name}/${type}`;
export function invalidateAuth(lib, name, type) { if (lib) cache.delete(key(lib, name, type)); else cache.clear(); }

export async function authRows(lib, name, type) {
  const k = key(lib, name, type);
  if (cache.has(k)) return cache.get(k);
  const rows = await gw.rows(`SELECT USR, AUT FROM QSYS.OBJAUT WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [lib, name, type]).catch(() => []);
  cache.set(k, rows);
  return rows;
}

async function autlData(name) {
  const r = await gw.rows(`SELECT DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*AUTL'`, [name]).catch(() => []);
  return r[0] && r[0].DATA ? JSON.parse(r[0].DATA) : null;
}

async function publicDefault(lib) {
  const r = await gw.rows(`SELECT DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'`, [lib]).catch(() => []);
  const d = r[0] && r[0].DATA ? JSON.parse(r[0].DATA) : null;
  if (d && d.crtaut && d.crtaut !== '*SYSVAL') return d.crtaut;
  const sv = await gw.rows(`SELECT SVALUE FROM QSYS.SYSVAL WHERE NAME = 'QCRTAUT'`).catch(() => []);
  return (sv[0] && sv[0].SVALUE) || '*CHANGE';
}

/**
 * Autorización efectiva de un perfil sobre un objeto (fila de QSYS.OBJECTS con LIB, NAME, TYPE, OWNER).
 * Devuelve { auts: Set, source: 'ALLOBJ'|'OWNER'|'PRIVATE'|'GROUP'|'AUTL'|'PUBLIC' }.
 */
export async function effectiveAuthority(prf, o) {
  if (!prf) return { auts: new Set(ALL_SPECIFIC), source: 'SYSTEM' };
  if (hasSpecial(prf, '*ALLOBJ')) return { auts: new Set(ALL_SPECIFIC), source: 'ALLOBJ' };
  const rows = await authRows(o.LIB, o.NAME, o.TYPE);
  const row = (u) => rows.find((r) => r.USR === u);
  const user = prf.NAME;
  if (o.OWNER === user) return { auts: row(user) ? expand(row(user).AUT) : new Set(ALL_SPECIFIC), source: 'OWNER' };
  if (row(user)) return { auts: expand(row(user).AUT), source: 'PRIVATE' };
  const grp = prf.GRPPRF && prf.GRPPRF !== '*NONE' ? prf.GRPPRF : null;
  if (grp) {
    if (o.OWNER === grp) return { auts: row(grp) ? expand(row(grp).AUT) : new Set(ALL_SPECIFIC), source: 'GROUP' };
    if (row(grp)) return { auts: expand(row(grp).AUT), source: 'GROUP' };
  }
  const autlRow = row('*AUTL');
  const autl = autlRow ? await autlData(autlRow.AUT) : null;
  if (autl) {
    const e = autl.entries || {};
    if (e[user]) return { auts: expand(e[user]), source: 'AUTL' };
    if (grp && e[grp]) return { auts: expand(e[grp]), source: 'AUTL' };
  }
  const pub = row('*PUBLIC');
  if (pub) {
    if (String(pub.AUT).toUpperCase() === '*AUTL') return { auts: expand(autl ? autl.public || '*EXCLUDE' : '*EXCLUDE'), source: 'AUTL' };
    return { auts: expand(pub.AUT), source: 'PUBLIC' };
  }
  return { auts: expand(await publicDefault(o.LIB)), source: 'PUBLIC' };
}

export async function hasAuthority(prf, o, need) {
  const req = Array.isArray(need) ? need : NEED[need] || [need];
  const { auts } = await effectiveAuthority(prf, o);
  return req.every((a) => auts.has(a));
}

// Mensajes de IBM i para cada tipo de comprobación
function denied(o, need) {
  if (o.TYPE === '*LIB') return new CLError('CPF9820', o.NAME);
  if (need === 'EXIST') return new CLError('CPF2189', o.NAME, o.LIB, o.TYPE);
  return new CLError('CPF9802', o.NAME, o.LIB);
}

/**
 * Comprueba la autorización del usuario del contexto (o del contexto actual). Lanza CPF9802/CPF9820/CPF2189.
 * Comprueba también *EXECUTE sobre la biblioteca, como hace IBM i al resolver el objeto.
 */
export async function checkAuthority(ctx, o, need = 'USE', { library = true } = {}) {
  const c = ctx || currentCtx();
  const prf = c && (c.user || null);
  if (!c || !prf || !o) return;
  if (hasSpecial(prf, '*ALLOBJ')) return;
  if (library && o.TYPE !== '*LIB' && o.LIB && o.LIB !== 'QSYS') {
    const lib = await gw.rows(`SELECT LIB, NAME, TYPE, OWNER FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'`, [o.LIB]).catch(() => []);
    if (lib[0] && !(await hasAuthority(prf, lib[0], ['*EXECUTE']))) throw new CLError('CPF9820', o.LIB);
  }
  if (!(await hasAuthority(prf, o, need))) throw denied(o, need);
}

/** Fila de objeto (LIB, NAME, TYPE, OWNER) o null. */
export async function objectRow(lib, name, type) {
  const r = await gw.rows(`SELECT LIB, NAME, TYPE, ATTR, OWNER, TEXT FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [lib, name, type]).catch(() => []);
  return r[0] || null;
}

// ---------- Cambios de autorización ----------
export async function setPrivate(lib, name, type, user, auts) {
  await gw.exec(`DELETE FROM QSYS.OBJAUT WHERE LIB = ? AND NAME = ? AND TYPE = ? AND USR = ?`, [lib, name, type, user]);
  if (auts !== null) await gw.exec(`INSERT INTO QSYS.OBJAUT (LIB, NAME, TYPE, USR, AUT) VALUES (?, ?, ?, ?, ?)`, [lib, name, type, user, auts]);
  invalidateAuth(lib, name, type);
}

/** Lista para EDTOBJAUT / DSPOBJAUT: propietario, privadas, *PUBLIC y lista de autorizaciones. */
export async function authorityList(o) {
  const rows = await authRows(o.LIB, o.NAME, o.TYPE);
  const autl = rows.find((r) => r.USR === '*AUTL');
  const users = [];
  const own = rows.find((r) => r.USR === o.OWNER);
  users.push({ user: o.OWNER, auts: own ? expand(own.AUT) : new Set(ALL_SPECIFIC), owner: true });
  for (const r of rows) if (!['*PUBLIC', '*AUTL', o.OWNER].includes(r.USR)) users.push({ user: r.USR, auts: expand(r.AUT) });
  const pub = rows.find((r) => r.USR === '*PUBLIC');
  users.push({ user: '*PUBLIC', auts: pub ? (String(pub.AUT).toUpperCase() === '*AUTL' ? '*AUTL' : expand(pub.AUT)) : expand(await publicDefault(o.LIB)) });
  return { users, autl: autl ? autl.AUT : '*NONE' };
}

/** Al borrar un objeto desaparecen sus autorizaciones privadas. */
export async function dropAuthorities(lib, name, type) {
  await gw.exec(`DELETE FROM QSYS.OBJAUT WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [lib, name, type]).catch(() => {});
  invalidateAuth(lib, name, type);
}

// ---------- SQL: tablas que toca una sentencia ----------
/** [{lib, name, need}] de una sentencia SQL ya cualificada. */
export function sqlTargets(sql) {
  const s = String(sql).replace(/'(?:[^']|'')*'/g, "''");
  const verb = (/^\s*(\w+)/.exec(s) || [])[1]?.toUpperCase() || '';
  const out = [];
  const re = /\b(FROM|JOIN|INTO|UPDATE|TABLE|USING)\s+"?([A-Z#@$][\w#@$]*)"?\s*\.\s*"?([A-Z#@$][\w#@$]*)"?/gi;
  let m;
  let first = true;
  while ((m = re.exec(s))) {
    const kw = m[1].toUpperCase();
    let need = 'READ';
    if (verb === 'INSERT' && kw === 'INTO' && first) need = 'ADD';
    else if (verb === 'UPDATE' && kw === 'UPDATE' && first) need = 'UPD';
    else if (verb === 'DELETE' && kw === 'FROM' && first) need = 'DLT';
    else if (verb === 'MERGE' && kw === 'INTO' && first) need = 'CHANGE';
    else if (verb === 'DROP' && kw === 'TABLE') need = 'EXIST';
    else if (verb === 'ALTER' && kw === 'TABLE') need = 'ALTER';
    else if (verb === 'CREATE') continue;
    out.push({ lib: m[2].toUpperCase(), name: m[3].toUpperCase(), need });
    first = false;
  }
  return out;
}
