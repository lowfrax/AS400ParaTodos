// Catálogo de objetos IBM i sobre Db2: bibliotecas = esquemas, *FILE = tablas, el resto en QSYS.OBJECTS.
import { sqlTypeToRpg } from './rpg/types.js';

export class ObjectNotFound extends Error {
  constructor(msgId, message) { super(message); this.msgId = msgId; }
}

/** Busca un objeto en la lista de bibliotecas (o en una biblioteca concreta). */
export async function findObject(gw, name, type, lib, libl) {
  const libs = !lib || lib === '*LIBL' ? libl : [lib];
  if (!libs.length) return null;
  const rows = await gw.rows(
    `SELECT LIB, NAME, TYPE, ATTR, TEXT, OWNER, CREATED, CHANGED, OBJSIZE FROM QSYS.OBJECTS WHERE NAME = ? AND TYPE = ? AND LIB IN (${libs.map(() => '?').join(',')})`,
    [name, type, ...libs],
  );
  for (const l of libs) {
    const r = rows.find((x) => x.LIB === l);
    if (r) return r;
  }
  return null;
}

export async function objectData(gw, lib, name, type) {
  const r = await gw.rows(`SELECT DATA FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [lib, name, type]);
  if (!r.length || r[0].DATA === null) return null;
  return JSON.parse(r[0].DATA);
}

/** Describe un archivo físico (tabla) resolviendo *LIBL: campos con tipo RPG y campos clave. */
export async function describeFile(gw, qname, libl) {
  const [libPart, filePart] = qname.includes('/') ? qname.split('/') : ['*LIBL', qname];
  const file = filePart.toUpperCase();
  const libs = libPart === '*LIBL' ? libl : [libPart.toUpperCase()];
  for (const lib of libs) {
    const cols = await gw.columns(lib, file);
    if (!Array.isArray(cols) || !cols.length) continue;
    let keys = cols.filter((c) => c.keyseq).sort((a, b) => a.keyseq - b.keyseq).map((c) => c.name);
    let format = file;
    let keyDesc = [];
    let rrn = 'rid';
    let attr = 'PF';
    try {
      const meta = await objectData(gw, lib, file, '*FILE');
      if (meta && meta.keys && meta.keys.length) { keys = meta.keys; keyDesc = meta.keyDesc || []; }
      if (meta && meta.format) format = meta.format;
      if (meta && meta.kind === 'LF') { attr = 'LF'; rrn = meta.join ? null : 'col'; }
    } catch { /* tabla creada por SQL sin metadatos */ }
    return {
      lib, schema: lib, table: file, format, attr, rrn,
      fields: cols.filter((c) => c.name !== '$RRN').map((c) => ({ name: c.name, type: sqlTypeToRpg(c), sqlType: c.type, length: c.length, scale: c.scale, text: c.text })),
      keys, keyDesc,
    };
  }
  throw new ObjectNotFound('CPF4101', `File ${file} in library ${libPart} not found or inline data file missing.`);
}

/** Lee las líneas de un miembro fuente. */
export async function readMember(gw, lib, file, mbr) {
  const rows = await gw.rows(`SELECT SEQ, DAT, SRCDTA FROM QSYS.SOURCE WHERE LIB = ? AND SRCF = ? AND MBR = ? ORDER BY SEQ`, [lib, file, mbr]);
  return rows.map((r) => ({ seq: Number(r.SEQ), dat: Number(r.DAT), text: (r.SRCDTA || '').replace(/\s+$/, '') }));
}

export async function findMember(gw, lib, file, mbr, libl) {
  const libs = !lib || lib === '*LIBL' ? libl : [lib];
  for (const l of libs) {
    const r = await gw.rows(`SELECT LIB, SRCF, MBR, TYPE, TEXT FROM QSYS.MEMBERS WHERE LIB = ? AND SRCF = ? AND MBR = ?`, [l, file, mbr]);
    if (r.length) return r[0];
  }
  return null;
}
