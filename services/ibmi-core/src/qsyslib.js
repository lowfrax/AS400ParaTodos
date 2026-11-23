// Sistema de archivos QSYS.LIB: /QSYS.LIB/BIB.LIB/ARCHIVO.FILE/MIEMBRO.MBR y nomenclatura NAMEFMT 0 (BIB/ARCHIVO.MIEMBRO).
// Lo usan FTP, CPYTOSTMF/CPYFRMSTMF, la API REST y QSH para leer y escribir miembros fuente y de datos.
import * as obj from './objects.js';
import { gw, describeFile, readMember } from './objects.js';
import { CLError } from './messages.js';
import { invalidateTables } from './ctx.js';

const TYPE_EXT = { '*LIB': 'LIB', '*FILE': 'FILE', '*PGM': 'PGM', '*SRVPGM': 'SRVPGM', '*DTAARA': 'DTAARA', '*DTAQ': 'DTAQ', '*USRPRF': 'USRPRF', '*MSGQ': 'MSGQ', '*OUTQ': 'OUTQ', '*CMD': 'CMD', '*JOBD': 'JOBD', '*USRSPC': 'USRSPC', '*SBSD': 'SBSD' };
const EXT_TYPE = Object.fromEntries(Object.entries(TYPE_EXT).map(([k, v]) => [v, k]));

/** Analiza /QSYS.LIB/... → {lib, obj, type, mbr} (en mayúsculas). */
export function parseQsysPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts[0].toUpperCase() !== 'QSYS.LIB') return null;
  const out = { lib: null, obj: null, type: null, mbr: null };
  const split = (s) => { const i = s.lastIndexOf('.'); return i < 0 ? [s.toUpperCase(), ''] : [s.slice(0, i).toUpperCase(), s.slice(i + 1).toUpperCase()]; };
  let i = 1;
  if (parts[i]) {
    const [n, e] = split(parts[i]);
    if (e === 'LIB') { out.lib = n; i++; } else out.lib = 'QSYS';
  }
  if (parts[i]) { const [n, e] = split(parts[i]); out.obj = n; out.type = EXT_TYPE[e] || `*${e}`; i++; }
  if (parts[i]) { const [n, e] = split(parts[i]); if (e !== 'MBR') throw new CLError('CPFA0A9', p); out.mbr = n; }
  return out;
}

/** NAMEFMT 0: BIB/ARCHIVO.MIEMBRO, BIB/ARCHIVO, ARCHIVO.MIEMBRO (biblioteca actual). */
export function parseNameFmt0(p, curlib) {
  const s = String(p).trim().toUpperCase();
  const m = /^(?:([A-Z0-9_#@$]{1,10})\/)?([A-Z0-9_#@$]{1,10})(?:\.([A-Z0-9_#@$*]{1,10}))?$/.exec(s);
  if (!m) return null;
  return { lib: m[1] || curlib, obj: m[2], type: '*FILE', mbr: m[3] || null };
}

export const qsysPath = (lib, objName, type, mbr) => {
  let s = '/QSYS.LIB';
  if (lib) s += `/${lib}.LIB`;
  if (objName) s += `/${objName}.${TYPE_EXT[type] || String(type || '*FILE').replace('*', '')}`;
  if (mbr) s += `/${mbr}.MBR`;
  return s;
};

/** Lista el contenido de un nivel de QSYS.LIB como entradas tipo directorio. */
export async function listQsys(q) {
  if (!q.lib || (q.lib === 'QSYS' && !q.obj)) {
    const libs = await obj.libraries();
    return libs.map((l) => ({ name: `${l.NAME}.LIB`, dir: true, type: '*LIB', size: 0, mtime: l.CREATED ? new Date(String(l.CREATED).replace(' ', 'T')) : new Date(), text: l.TEXT, owner: l.OWNER, lib: 'QSYS', obj: l.NAME }));
  }
  if (!q.obj) {
    if (!(await obj.libExists(q.lib))) throw new CLError('CPF2110', q.lib);
    await obj.syncSqlTables(q.lib).catch(() => {});
    const objs = await obj.listObjects(q.lib);
    return objs.map((o) => ({ name: `${o.NAME}.${TYPE_EXT[o.TYPE] || o.TYPE.replace('*', '')}`, dir: o.TYPE === '*FILE', type: o.TYPE, attr: o.ATTR, size: Number(o.OBJSIZE || 0), mtime: o.CHANGED ? new Date(String(o.CHANGED).replace(' ', 'T')) : new Date(), text: o.TEXT, owner: o.OWNER, lib: q.lib, obj: o.NAME }));
  }
  if (q.type === '*FILE' && !q.mbr) {
    const o = await obj.findObject(gw, q.obj, '*FILE', q.lib, []);
    if (!o) throw new CLError('CPF9812', q.obj, q.lib);
    if (o.ATTR === 'PF-SRC') {
      const ms = await obj.listMembers(q.lib, q.obj);
      return ms.map((m) => ({ name: `${m.MBR}.MBR`, dir: false, type: '*MBR', attr: m.TYPE, size: Number(m.NLINES || 0) * 92, mtime: m.CHANGED ? new Date(String(m.CHANGED).replace(' ', 'T')) : new Date(), text: m.TEXT, lib: q.lib, obj: q.obj, mbr: m.MBR, srctype: m.TYPE }));
    }
    return [{ name: `${q.obj}.MBR`, dir: false, type: '*MBR', attr: 'PF-DTA', size: 0, mtime: new Date(), text: o.TEXT, lib: q.lib, obj: q.obj, mbr: q.obj }];
  }
  return [];
}

async function fileKind(lib, file) {
  const o = await obj.findObject(gw, file, '*FILE', lib, []);
  if (o) return o.ATTR === 'PF-SRC' ? 'SRC' : 'DTA';
  const t = await gw.tables(lib).catch(() => []);
  if (Array.isArray(t) && t.some((x) => x.name === file)) return 'DTA';
  return null;
}

// ---------- Miembros de datos como texto de longitud fija ----------
function fieldWidth(f) {
  const t = f.type;
  switch (t.t) {
    case 'packed': case 'zoned': return t.digits + (t.dec ? 1 : 0) + 1;
    case 'int': case 'uns': return t.bits === 64 ? 21 : t.bits === 16 ? 6 : 11;
    case 'float': return 24;
    case 'date': return 10;
    case 'time': return 8;
    case 'timestamp': return 26;
    case 'ind': return 1;
    default: return Math.max(1, Number(t.len || f.length || 1));
  }
}
function fmtField(f, v) {
  const w = fieldWidth(f);
  if (v === null || v === undefined) return ' '.repeat(w);
  if (['packed', 'zoned', 'int', 'uns', 'float'].includes(f.type.t)) {
    const s = f.type.dec ? Number(v).toFixed(f.type.dec) : String(v);
    return s.padStart(w).slice(-w);
  }
  return String(v).replace(/[\r\n]/g, ' ').padEnd(w).slice(0, w);
}

export async function recordLayout(lib, file) {
  const d = await describeFile(gw, `${lib}/${file}`, [lib]);
  let pos = 1;
  return { desc: d, fields: d.fields.map((f) => { const w = fieldWidth(f); const r = { ...f, pos, width: w }; pos += w; return r; }), reclen: pos - 1 };
}

/** Lee un miembro (fuente o datos) como texto. */
export async function readQsysMember(lib, file, mbr, { seqnbr = false } = {}) {
  const kind = await fileKind(lib, file);
  if (!kind) throw new CLError('CPF9812', file, lib);
  if (kind === 'SRC') {
    const m = await obj.findMember(gw, lib, file, mbr, []);
    if (!m) throw new CLError('CPF9815', mbr, file, lib);
    const lines = await readMember(gw, lib, file, mbr);
    return lines.map((l) => (seqnbr ? `${String(Math.round(l.seq * 100)).padStart(6, '0')}${String(l.dat || 0).padStart(6, '0')}${l.text}` : l.text)).join('\r\n') + (lines.length ? '\r\n' : '');
  }
  const lay = await recordLayout(lib, file);
  const r = await gw.exec(`SELECT * FROM ${lay.desc.schema}.${lay.desc.table}`);
  return r.rows.map((row) => lay.fields.map((f, i) => fmtField(f, row[i])).join('')).join('\r\n') + (r.rows.length ? '\r\n' : '');
}

/** Escribe un miembro desde texto (sustituye o añade). Crea el miembro fuente si no existe. */
export async function writeQsysMember(lib, file, mbr, text, { append = false, srctype = '' } = {}) {
  const kind = await fileKind(lib, file);
  if (!kind) throw new CLError('CPF9812', file, lib);
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (kind === 'SRC') {
    if (!(await obj.findMember(gw, lib, file, mbr, []))) {
      const type = srctype || ({ QRPGLESRC: 'RPGLE', QRPGSRC: 'RPG', QS36SRC: 'RPG36', QCLLESRC: 'CLLE', QCLSRC: 'CLP', QDDSSRC: 'PF', QSQLSRC: 'SQL', QTXTSRC: 'TXT' }[file] || 'TXT');
      await obj.addMember(lib, file, mbr, type, '');
    }
    let existing = append ? await readMember(gw, lib, file, mbr) : [];
    const start = existing.length;
    existing = existing.concat(lines.map((t, i) => ({ seq: start + i + 1, dat: 0, text: t })));
    await obj.writeMember(lib, file, mbr, existing.map((l, i) => ({ ...l, seq: i + 1 })));
    return lines.length;
  }
  const lay = await recordLayout(lib, file);
  const stmts = [];
  if (!append) stmts.push(`DELETE FROM ${lay.desc.schema}.${lay.desc.table}`);
  for (const line of lines) {
    if (!line.trim()) continue;
    const vals = lay.fields.map((f) => {
      const raw = line.slice(f.pos - 1, f.pos - 1 + f.width);
      if (['packed', 'zoned', 'int', 'uns', 'float'].includes(f.type.t)) {
        const t = raw.trim();
        if (!t) return 0;
        // Formato zonificado sin punto decimal (como sale de IBM i): 0001234 con 2 decimales → 12.34
        if (f.type.dec && !t.includes('.') && /^-?\d+$/.test(t) && t.replace('-', '').length >= f.type.digits) return Number(t) / 10 ** f.type.dec;
        return Number(t) || 0;
      }
      return raw.replace(/\s+$/, '');
    });
    stmts.push({ sql: `INSERT INTO ${lay.desc.schema}.${lay.desc.table} (${lay.fields.map((f) => `"${f.name}"`).join(', ')}) VALUES (${lay.fields.map(() => '?').join(', ')})`, params: vals });
  }
  for (let i = 0; i < stmts.length; i += 200) {
    const r = await gw.batch(stmts.slice(i, i + 200), []);
    const bad = r.results.find((x) => !x.ok);
    if (bad) throw new CLError('CPF9898', `Error writing member ${mbr}: ${bad.error}`);
  }
  invalidateTables(lib);
  return stmts.length - (append ? 0 : 1);
}

export async function deleteQsysObject(q) {
  if (q.mbr) {
    if ((await fileKind(q.lib, q.obj)) === 'SRC') return obj.removeMember(q.lib, q.obj, q.mbr);
    throw new CLError('CPF3141', q.mbr);
  }
  if (q.obj) return obj.deleteObject(q.lib, q.obj, q.type);
  return obj.deleteLibrary(q.lib);
}

export { TYPE_EXT, EXT_TYPE };
