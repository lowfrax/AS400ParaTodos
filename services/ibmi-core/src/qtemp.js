// QTEMP: biblioteca temporal propia de cada trabajo, como en IBM i.
// Cada trabajo la ve como "QTEMP"; físicamente es el esquema QTnnnnnn (nnnnnn = número de trabajo), que se crea al
// usarse por primera vez y se borra con todo su contenido cuando el trabajo termina.
import { libExists, createLibrary, deleteLibrary, gw } from './objects.js';
import { jobEndHooks, qualifiedJob } from './system.js';

export const qtempName = (job) => `QT${job.number}`;
export const isQtempLib = (l) => /^QT\d{6}$/.test(String(l || ''));

/** Crea (una vez) el esquema físico de la QTEMP del trabajo. */
export async function ensureQtemp(job) {
  if (!job || job.qtemp) return;
  job.qtemp = true;
  const lib = qtempName(job);
  if (!(await libExists(lib))) {
    await createLibrary(lib, `QTEMP of job ${qualifiedJob(job)}`.slice(0, 50), '*TEST', job.user).catch((e) => { if (!/CPF2111/.test(e.msgId || e.message)) throw e; });
  }
}

/** Texto visible por el trabajo: el nombre físico se muestra como QTEMP. */
export function logicalText(job, s) {
  if (!job || s === null || s === undefined) return s;
  return String(s).split(qtempName(job)).join('QTEMP');
}

/** Sustituye QTEMP (fuera de literales) por el esquema físico en una sentencia SQL. */
export function physicalSql(job, sql) {
  let out = '';
  let q = null;
  const s = String(sql);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { out += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    if (/[Qq]/.test(c) && /^QTEMP\b/i.test(s.slice(i)) && !/[\w#@$]/.test(s[i - 1] || '')) { out += qtempName(job); i += 4; continue; }
    out += c;
  }
  return out;
}

jobEndHooks.push((job) => {
  if (job.qtemp) deleteLibrary(qtempName(job)).catch(() => {});
});

/** En el IPL: borra las QTEMP que quedaran de trabajos del arranque anterior. */
export async function cleanupQtemps() {
  const rows = await gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND TYPE = '*LIB' AND NAME LIKE 'QT%'`).catch(() => []);
  let n = 0;
  for (const r of rows) if (isQtempLib(r.NAME)) { await deleteLibrary(r.NAME).catch(() => {}); n++; }
  return n;
}
