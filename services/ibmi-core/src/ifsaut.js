// Seguridad del IFS ("root" y QOpenSys), como en IBM i:
//   autorización de datos    *R  *W  *X  (y combinaciones *RW *RX *WX *RWX, *EXCLUDE, *NONE)
//   autorizaciones de objeto *OBJEXIST *OBJMGT *OBJALTER *OBJREF   (*ALL / *NONE)
// Cada objeto tiene propietario, grupo primario, lista de autorizaciones, autorizaciones privadas y *PUBLIC.
// Un objeto nuevo pertenece al usuario que lo crea y hereda del directorio padre las autorizaciones de *PUBLIC,
// del grupo primario y las privadas (como CRTDIR/open() en IBM i). Un objeto sin entrada propia (anterior a esta
// función o creado fuera del sistema) toma la del antepasado más cercano que la tenga.
// Comprobaciones (Authority requirements for IFS): *X en cada directorio de la ruta; leer *R, escribir *W;
// crear o borrar en un directorio *WX sobre él; borrar además *OBJEXIST; renombrar o mover *OBJMGT.
// Filas: QSYS.IFSOBJ (PATH, OWNER, PGP, AUTL) y QSYS.IFSAUT (PATH, USR, DTA, OBJ); USR = '*PUBLIC' o perfil.
// Todo se mantiene en memoria (solo este proceso las cambia) y se escribe en Db2.
import { gw } from './objects.js';
import { CLError } from './messages.js';
import { currentCtx, hasSpecial } from './security.js';

export const DDL = [
  `CREATE TABLE QSYS.IFSOBJ (PATH VARCHAR(1000) NOT NULL, OWNER VARCHAR(10) NOT NULL DEFAULT 'QSYS',
     PGP VARCHAR(10) NOT NULL DEFAULT '*NONE', AUTL VARCHAR(10) NOT NULL DEFAULT '*NONE')`,
  `CREATE TABLE QSYS.IFSAUT (PATH VARCHAR(1000) NOT NULL, USR VARCHAR(10) NOT NULL, DTA VARCHAR(10) NOT NULL DEFAULT '*NONE',
     OBJ VARCHAR(60) NOT NULL DEFAULT '')`,
];

export const DTA_VALUES = ['*RWX', '*RW', '*RX', '*WX', '*R', '*W', '*X', '*EXCLUDE', '*NONE'];
export const OBJ_VALUES = ['*OBJEXIST', '*OBJMGT', '*OBJALTER', '*OBJREF'];

/** '*RX' → Set('R','X'); '*EXCLUDE'/'*NONE' → vacío. */
export function dtaSet(v) {
  const s = String(v || '').toUpperCase();
  if (s === '*EXCLUDE' || s === '*NONE' || !s) return new Set();
  return new Set(s.replace('*', '').split('').filter((c) => 'RWX'.includes(c)));
}
export function dtaName(set) {
  const s = ['R', 'W', 'X'].filter((c) => set.has(c)).join('');
  return s ? `*${s}` : '*EXCLUDE';
}
export function objSet(v) {
  const l = [].concat(v || []).flatMap((x) => String(x).toUpperCase().split(/\s+/)).filter(Boolean);
  if (l.includes('*ALL')) return new Set(OBJ_VALUES);
  return new Set(l.filter((x) => OBJ_VALUES.includes(x)));
}
const objStr = (set) => OBJ_VALUES.filter((x) => set.has(x)).join(' ');
const FULL = () => ({ dta: new Set(['R', 'W', 'X']), obj: new Set(OBJ_VALUES) });
const clone = (a) => ({ dta: new Set(a.dta), obj: new Set(a.obj) });

// ---------- Caché ----------
/** path → { owner, pgp, autl, auth: Map(usr → {dta:Set, obj:Set, pgp?:true}) }  (auth incluye '*PUBLIC') */
const meta = new Map();
let loaded = false;

const parentOf = (p) => (p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/');
const under = (p, root) => p === root || (root === '/' ? p.startsWith('/') : p.startsWith(`${root}/`));

export async function initIfsAuth() {
  const existing = await gw.tables('QSYS');
  const have = new Set((Array.isArray(existing) ? existing : []).map((t) => t.name));
  const missing = DDL.filter((s) => !have.has(/^CREATE TABLE QSYS\.(\w+)/.exec(s)[1]));
  if (missing.length) await gw.batch(missing, ['42710']);
  meta.clear();
  for (const r of await gw.rows('SELECT PATH, OWNER, PGP, AUTL FROM QSYS.IFSOBJ')) meta.set(r.PATH, { owner: r.OWNER, pgp: r.PGP || '*NONE', autl: r.AUTL || '*NONE', auth: new Map() });
  for (const r of await gw.rows('SELECT PATH, USR, DTA, OBJ FROM QSYS.IFSAUT')) {
    const m = meta.get(r.PATH);
    if (m) m.auth.set(r.USR, { dta: dtaSet(r.DTA), obj: objSet(r.OBJ) });
  }
  loaded = true;
  // Raíz del sistema: QSYS, *PUBLIC *RWX sin autorizaciones de objeto (como en un IBM i recién instalado)
  if (!meta.has('/')) await setMeta('/', { owner: 'QSYS', pgp: '*NONE', autl: '*NONE', auth: new Map([['*PUBLIC', { dta: new Set(['R', 'W', 'X']), obj: new Set() }]]) });
  // Directorios de intercambio del core bancario: los procesos de canales mueven y borran lo que dejan otros usuarios
  if (!meta.has('/banco')) await setMeta('/banco', { owner: 'QSYS', pgp: '*NONE', autl: '*NONE', auth: new Map([['*PUBLIC', FULL()]]) });
}

async function persist(p) {
  await gw.exec('DELETE FROM QSYS.IFSOBJ WHERE PATH = ?', [p]);
  await gw.exec('DELETE FROM QSYS.IFSAUT WHERE PATH = ?', [p]);
  const m = meta.get(p);
  if (!m) return;
  await gw.exec('INSERT INTO QSYS.IFSOBJ (PATH, OWNER, PGP, AUTL) VALUES (?, ?, ?, ?)', [p, m.owner, m.pgp, m.autl]);
  for (const [u, a] of m.auth) await gw.exec('INSERT INTO QSYS.IFSAUT (PATH, USR, DTA, OBJ) VALUES (?, ?, ?, ?)', [p, u, dtaName(a.dta), objStr(a.obj)]);
}
async function setMeta(p, m) { meta.set(p, m); await persist(p); }

/** Entrada efectiva de un objeto: la suya o la del antepasado más cercano (copiada). */
export function metaOf(p) {
  for (let q = p; q; q = parentOf(q)) {
    const m = meta.get(q);
    if (m) return { ...m, path: q, own: q === p };
  }
  return { owner: 'QSYS', pgp: '*NONE', autl: '*NONE', auth: new Map([['*PUBLIC', FULL()]]), path: '/', own: false };
}

// ---------- Autorización efectiva ----------
let autlCache = new Map();
async function autlEntries(name) {
  if (autlCache.has(name)) return autlCache.get(name);
  const r = await gw.rows(`SELECT DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*AUTL'`, [name]).catch(() => []);
  const d = r[0] && r[0].DATA ? JSON.parse(r[0].DATA) : null;
  autlCache.set(name, d);
  setTimeout(() => autlCache.delete(name), 5000).unref?.();
  return d;
}
// *USE/*CHANGE/*ALL/*EXCLUDE de una lista de autorizaciones → datos y objeto del IFS
function fromObjAut(v) {
  const s = String(v || '').toUpperCase().split(/\s+/);
  if (s.includes('*ALL')) return FULL();
  if (s.includes('*CHANGE')) return { dta: new Set(['R', 'W', 'X']), obj: new Set() };
  if (s.includes('*USE')) return { dta: new Set(['R', 'X']), obj: new Set() };
  const dta = new Set();
  if (s.includes('*READ')) dta.add('R');
  if (s.some((x) => ['*ADD', '*UPD', '*DLT'].includes(x))) dta.add('W');
  if (s.includes('*EXECUTE')) dta.add('X');
  return { dta, obj: new Set(s.filter((x) => OBJ_VALUES.includes(x))) };
}

/** { dta:Set, obj:Set, source } del perfil sobre la ruta. */
export async function effective(prf, p) {
  if (!prf || hasSpecial(prf, '*ALLOBJ')) return { ...FULL(), source: prf ? 'ALLOBJ' : 'SYSTEM' };
  const m = metaOf(p);
  const user = prf.NAME;
  const grp = prf.GRPPRF && prf.GRPPRF !== '*NONE' ? prf.GRPPRF : null;
  if (m.owner === user) return { ...(m.auth.get(user) ? clone(m.auth.get(user)) : FULL()), source: 'OWNER' };
  if (m.auth.has(user)) return { ...clone(m.auth.get(user)), source: 'PRIVATE' };
  if (grp) {
    if (m.owner === grp) return { ...(m.auth.get(grp) ? clone(m.auth.get(grp)) : FULL()), source: 'GROUP' };
    if (m.auth.has(grp)) return { ...clone(m.auth.get(grp)), source: m.pgp === grp ? 'PGP' : 'GROUP' };
  }
  const pub = m.auth.get('*PUBLIC');
  if (m.autl && m.autl !== '*NONE') {
    const d = await autlEntries(m.autl);
    if (d) {
      const e = d.entries || {};
      if (e[user]) return { ...fromObjAut(e[user]), source: 'AUTL' };
      if (grp && e[grp]) return { ...fromObjAut(e[grp]), source: 'AUTL' };
      if (pub && pub.autl) return { ...fromObjAut(d.public || '*EXCLUDE'), source: 'AUTL' };
    }
  }
  if (pub && !pub.autl) return { ...clone(pub), source: 'PUBLIC' };
  return { dta: new Set(), obj: new Set(), source: 'PUBLIC' };
}

function denied(p) { const e = new CLError('CPFA09C', p); e.code = 'EACCES'; return e; }

/**
 * Comprueba que el usuario del trabajo actual pueda hacer `op` sobre la ruta:
 *   'r' leer, 'w' escribir, 'x' recorrer/ejecutar, 'create' crear dentro de la ruta (directorio padre),
 *   'delete' borrar el objeto, 'rename' renombrarlo/moverlo, 'list' listar un directorio.
 * Sin trabajo (procesos del sistema) o con *ALLOBJ no se comprueba nada.
 */
export async function check(p, op, ctx = currentCtx()) {
  const prf = ctx && ctx.user;
  if (!loaded || !prf || hasSpecial(prf, '*ALLOBJ')) return;
  // *X en todos los directorios de la ruta (sin incluir el objeto)
  const parts = [];
  for (let q = parentOf(p); q; q = parentOf(q)) parts.unshift(q);
  for (const d of parts) if (!(await effective(prf, d)).dta.has('X')) throw denied(d);
  const a = await effective(prf, p);
  const parent = parentOf(p);
  const need = (cond, at = p) => { if (!cond) throw denied(at); };
  switch (op) {
    case 'r': case 'list': need(a.dta.has('R')); break;
    case 'w': need(a.dta.has('W')); break;
    case 'x': need(a.dta.has('X')); break;
    case 'create': { const d = await effective(prf, p); need(d.dta.has('W') && d.dta.has('X')); break; }
    case 'delete': {
      if (parent) { const d = await effective(prf, parent); need(d.dta.has('W') && d.dta.has('X'), parent); }
      need(a.obj.has('*OBJEXIST'));
      break;
    }
    case 'rename': {
      if (parent) { const d = await effective(prf, parent); need(d.dta.has('W') && d.dta.has('X'), parent); }
      need(a.obj.has('*OBJMGT'));
      break;
    }
    default: break;
  }
}

// ---------- Ciclo de vida de los objetos ----------
const who = (ctx = currentCtx()) => (ctx && ctx.job && ctx.job.user) || (ctx && ctx.user && ctx.user.NAME) || 'QSYS';

/** Objeto nuevo: propietario = usuario actual; hereda *PUBLIC, grupo primario y privadas del directorio padre. */
export async function created(p, { owner, from } = {}) {
  if (!loaded || meta.has(p)) return;
  const src = from ? metaOf(from) : metaOf(parentOf(p) || '/');
  const own = owner || who();
  const auth = new Map();
  for (const [u, a] of src.auth) if (from || u !== src.owner) auth.set(u, clone(a));
  if (!from) auth.delete(own);
  await setMeta(p, { owner: own, pgp: src.pgp || '*NONE', autl: src.autl || '*NONE', auth });
}

/** Objeto (y su subárbol) borrado. */
export async function removed(p) {
  if (!loaded) return;
  let hit = false;
  for (const k of [...meta.keys()]) if (under(k, p)) { meta.delete(k); hit = true; }
  if (!hit) return;
  const like = `${p.replace(/[\\%_]/g, '\\$&')}/%`;
  await gw.exec("DELETE FROM QSYS.IFSOBJ WHERE PATH = ? OR PATH LIKE ? ESCAPE '\\'", [p, like]);
  await gw.exec("DELETE FROM QSYS.IFSAUT WHERE PATH = ? OR PATH LIKE ? ESCAPE '\\'", [p, like]);
}

/** Objeto (y su subárbol) renombrado o movido: conserva propietario y autorizaciones. */
export async function moved(from, to) {
  if (!loaded) return;
  const keys = [...meta.keys()].filter((k) => under(k, from));
  if (!keys.length) { await created(to, { from }); return; }
  for (const k of keys) {
    const nk = to + k.slice(from.length);
    meta.set(nk, meta.get(k));
    meta.delete(k);
  }
  await removed(from).catch(() => {});
  for (const k of keys) await persist(to + k.slice(from.length));
}

/** Directorio personal: pertenece a su usuario. */
export async function ensureHome(dir, user) {
  if (!loaded || meta.has(dir)) return;
  await setMeta(dir, { owner: String(user).toUpperCase(), pgp: '*NONE', autl: '*NONE', auth: new Map([['*PUBLIC', { dta: new Set(['R', 'X']), obj: new Set() }]]) });
}

// ---------- Cambios (CHGAUT, CHGOWN, CHGPGP, CPYAUT) ----------
/** Copia propia de la entrada efectiva para poder modificarla. */
function own(p) {
  const m = metaOf(p);
  if (m.own) return meta.get(p);
  const c = { owner: m.owner, pgp: m.pgp, autl: m.autl, auth: new Map([...m.auth].map(([u, a]) => [u, clone(a)])) };
  meta.set(p, c);
  return c;
}

/** Puede cambiar autorizaciones: propietario, *ALLOBJ o *OBJMGT sobre el objeto. */
export async function mayManage(p, ctx = currentCtx()) {
  const prf = ctx && ctx.user;
  if (!prf || hasSpecial(prf, '*ALLOBJ')) return;
  const m = metaOf(p);
  if (m.owner === prf.NAME) return;
  if (!(await effective(prf, p)).obj.has('*OBJMGT')) throw denied(p);
}

/** dta: '*RX'…, '*AUTL' (solo *PUBLIC), '*SAME'; obj: lista, '*SAME'. dta y obj '*NONE' → se quita la privada. */
export async function changeAuth(p, user, dta, obj) {
  const m = own(p);
  const prev = m.auth.get(user) || (user === m.owner ? FULL() : { dta: new Set(), obj: new Set() });
  const d = String(dta || '*SAME').toUpperCase();
  const objList = [].concat(obj || '*SAME').flatMap((x) => String(x).toUpperCase().split(/\s+/)).filter(Boolean);
  if (d === '*AUTL') {
    if (user !== '*PUBLIC') throw new CLError('CPF9898', 'DTAAUT(*AUTL) is valid only for USER(*PUBLIC).');
    m.auth.set('*PUBLIC', { dta: new Set(), obj: new Set(), autl: true });
  } else {
    const nd = d === '*SAME' ? prev.dta : dtaSet(d);
    const no = objList.includes('*SAME') ? prev.obj : objSet(objList);
    if (d === '*NONE' && objList.includes('*NONE') && user !== '*PUBLIC' && user !== m.owner) m.auth.delete(user);
    else m.auth.set(user, { dta: d === '*EXCLUDE' ? new Set() : nd, obj: d === '*EXCLUDE' ? new Set() : no });
  }
  await persist(p);
}
export async function setAutl(p, autl) { const m = own(p); m.autl = autl; if (autl === '*NONE') { const pub = m.auth.get('*PUBLIC'); if (pub && pub.autl) m.auth.set('*PUBLIC', { dta: new Set(), obj: new Set() }); } await persist(p); }
export async function changeOwner(p, newOwner, revokeOld = true) {
  const m = own(p);
  const old = m.owner;
  if (old !== newOwner) {
    const oldAuth = m.auth.get(old) || FULL();
    m.auth.delete(old);
    if (!revokeOld) m.auth.set(old, oldAuth);
    const mine = m.auth.get(newOwner);
    m.auth.delete(newOwner);
    if (mine) { /* el nuevo propietario recibe la autorización de propietario completa */ }
  }
  m.owner = newOwner;
  await persist(p);
}
export async function changePgp(p, pgp, revokeOld = true) {
  const m = own(p);
  const old = m.pgp;
  const oldAuth = old && old !== '*NONE' ? m.auth.get(old) : null;
  if (old && old !== '*NONE' && revokeOld) m.auth.delete(old);
  m.pgp = pgp;
  if (pgp !== '*NONE' && !m.auth.has(pgp)) m.auth.set(pgp, oldAuth ? clone(oldAuth) : { dta: new Set(), obj: new Set() });
  await persist(p);
}
export async function copyAuth(from, to) {
  const s = metaOf(from);
  const m = own(to);
  m.pgp = s.pgp; m.autl = s.autl;
  m.auth = new Map([...s.auth].filter(([u]) => u !== m.owner).map(([u, a]) => [u, clone(a)]));
  await persist(to);
}

/** Lista para DSPAUT/WRKAUT: propietario, grupo primario, privadas y *PUBLIC. */
export function authorityList(p) {
  const m = metaOf(p);
  const users = [{ user: m.owner, kind: 'owner', ...(m.auth.get(m.owner) ? clone(m.auth.get(m.owner)) : FULL()) }];
  if (m.pgp && m.pgp !== '*NONE') users.push({ user: m.pgp, kind: 'pgp', ...(m.auth.get(m.pgp) ? clone(m.auth.get(m.pgp)) : { dta: new Set(), obj: new Set() }) });
  for (const [u, a] of [...m.auth].sort(([x], [y]) => x.localeCompare(y))) if (u !== m.owner && u !== m.pgp && u !== '*PUBLIC') users.push({ user: u, kind: 'private', ...clone(a) });
  const pub = m.auth.get('*PUBLIC') || { dta: new Set(), obj: new Set() };
  users.push({ user: '*PUBLIC', kind: 'public', ...clone(pub), autl: !!pub.autl });
  return { owner: m.owner, pgp: m.pgp, autl: m.autl, users };
}
export const dtaLabel = (u) => (u.autl ? '*AUTL' : dtaName(u.dta));

/** Bits UNIX (propietario/grupo/público) para ls -l, FTP y SFTP. */
export function mode(p) {
  const m = metaOf(p);
  const bits = (a) => (a ? (a.dta.has('R') ? 4 : 0) | (a.dta.has('W') ? 2 : 0) | (a.dta.has('X') ? 1 : 0) : 0);
  const o = bits(m.auth.get(m.owner) || FULL());
  const g = m.pgp && m.pgp !== '*NONE' ? bits(m.auth.get(m.pgp)) : 0;
  const pub = m.auth.get('*PUBLIC');
  return { owner: m.owner, group: m.pgp && m.pgp !== '*NONE' ? m.pgp : '0', bits: (o << 6) | (g << 3) | bits(pub && !pub.autl ? pub : null) };
}
export function modeString(p, dir) {
  const { bits } = mode(p);
  const s = (n) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
  return `${dir ? 'd' : '-'}${s(bits >> 6)}${s((bits >> 3) & 7)}${s(bits & 7)}`;
}

/** chmod de QSH/SFTP: bits de propietario, grupo primario y *PUBLIC → autorizaciones de datos. */
export async function chmod(p, bits) {
  const m = own(p);
  const toSet = (n) => new Set([n & 4 ? 'R' : '', n & 2 ? 'W' : '', n & 1 ? 'X' : ''].filter(Boolean));
  const ownerAuth = m.auth.get(m.owner) || FULL();
  m.auth.set(m.owner, { dta: toSet(bits >> 6), obj: ownerAuth.obj });
  if (m.auth.get(m.owner).dta.size === 3 && ownerAuth.obj.size === OBJ_VALUES.length) m.auth.delete(m.owner);
  if (m.pgp && m.pgp !== '*NONE') m.auth.set(m.pgp, { dta: toSet((bits >> 3) & 7), obj: (m.auth.get(m.pgp) || { obj: new Set() }).obj });
  const pub = m.auth.get('*PUBLIC') || { obj: new Set() };
  m.auth.set('*PUBLIC', { dta: toSet(bits & 7), obj: pub.obj || new Set() });
  await persist(p);
}

/** Filas de QSYS2.IFS_OBJECT_PRIVILEGES. */
export function privileges(p) {
  const l = authorityList(p);
  return l.users.map((u) => ({ user: u.user, dta: dtaLabel(u), obj: u.obj, owner: l.owner, pgp: l.pgp, autl: l.autl }));
}
