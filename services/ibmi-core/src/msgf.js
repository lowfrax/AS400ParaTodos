// Archivos de mensajes (*MSGF): descripciones de mensaje con texto de primer y segundo nivel, gravedad, formato de los
// datos de sustitución (FMT), respuestas (TYPE/LEN/VALUES/DFT). QCPFMSG (y QSYS/QCPFMSG) usa el catálogo del sistema.
import { gw, findObject, objectData, putObject } from './objects.js';
import { CLError, msgDef } from './messages.js';
import { toEbcdic } from '../../../shared/ebcdic.js';

const up = (s) => String(s || '').toUpperCase();

export function parseQual(q, dftLib = '*LIBL') {
  const s = up(q).replace(/['\s]/g, '');
  if (!s) return { lib: dftLib, obj: '' };
  return s.includes('/') ? { lib: s.split('/')[0], obj: s.split('/')[1] } : { lib: dftLib, obj: s };
}

const SYSTEM_MSGF = new Set(['QCPFMSG', 'QRPGLEMSG', 'QSQLMSG', 'QCPFMSGF']);

/** Busca el archivo de mensajes; para QCPFMSG devuelve el catálogo del sistema. */
export async function resolveMsgf(ctx, q) {
  const { lib, obj } = typeof q === 'string' ? parseQual(q) : q;
  if (SYSTEM_MSGF.has(obj)) return { lib: 'QSYS', name: obj, system: true };
  const libs = lib === '*LIBL' || !lib ? ctx.libl : [ctx.resolveLib(lib)];
  const o = await findObject(gw, obj, '*MSGF', lib === '*LIBL' || !lib ? '*LIBL' : ctx.resolveLib(lib), libs);
  if (!o) throw new CLError('CPF2407', `Message file ${obj} in ${lib} not found.`);
  const data = (await objectData(gw, o.LIB, o.NAME, '*MSGF')) || { msgs: {} };
  return { lib: o.LIB, name: o.NAME, data, o };
}

/** Descripción de un mensaje: {id, text, seclvl, sev, fmt, type, len, values, dft}. */
export async function getMsgd(ctx, msgid, q) {
  const id = up(msgid);
  const f = await resolveMsgf(ctx, q || 'QCPFMSG');
  if (f.system) {
    const m = msgDef(id);
    if (!m) throw new CLError('CPF2419', `Message identifier ${id} not found in message file ${f.name} in ${f.lib}.`);
    const seclvl = [m[2] && `Cause . . . . . :   ${m[2]}`, m[3] && `Recovery  . . . :   ${m[3]}`].filter(Boolean).join('&N');
    return { id, text: m[1], seclvl, sev: m[0], fmt: [], system: true, file: f };
  }
  const d = f.data.msgs[id];
  if (!d) throw new CLError('CPF2419', `Message identifier ${id} not found in message file ${f.name} in ${f.lib}.`);
  return { id, ...d, file: f };
}

/**
 * Sustituye &1..&n con los datos del mensaje según FMT ((*CHAR n) (*VARY n) (*DEC n d) (*BIN n) (*UBIN n) (*QTDSDATE)...).
 * Sin FMT (mensajes del sistema) los datos se reparten como texto de 10 en 10 o se usan como una sola variable.
 */
export function formatMsg(d, msgdta = '', args = null) {
  let vals;
  if (args) vals = args;
  else if (d.fmt && d.fmt.length) vals = sliceData(d.fmt, String(msgdta));
  else vals = [String(msgdta).trim()];
  const sub = (t) => String(t || '').replace(/&(\d{1,2})/g, (m, n) => {
    const v = vals[Number(n) - 1];
    return v === undefined ? '' : String(v).trim();
  }).replace(/&N\b/g, '\n').replace(/&B\b/g, '\n  ').replace(/&P\b/g, '\n    ');
  return { text: sub(d.text), seclvl: sub(d.seclvl || ''), values: vals };
}

function sliceData(fmt, data) {
  const out = [];
  let pos = 0;
  const bytes = toEbcdic(data);
  for (const f of fmt) {
    const t = up(f.type);
    const n = Number(f.len || 0);
    if (t === '*CHAR') { out.push(data.slice(pos, pos + n)); pos += n; continue; }
    if (t === '*VARY') {
      const w = n === 4 ? 4 : 2;
      const l = w === 2 ? ((bytes[pos] << 8) | bytes[pos + 1]) : bytes.readUInt32BE(pos);
      out.push(data.slice(pos + w, pos + w + l));
      pos += w + Number(f.max || l);
      continue;
    }
    if (t === '*DEC') {
      const bl = Math.floor(n / 2) + 1;
      let s = '';
      for (let i = 0; i < bl; i++) { const b = bytes[pos + i] || 0; s += (b >> 4).toString(16); if (i < bl - 1) s += (b & 15).toString(16); }
      const sign = (bytes[pos + bl - 1] || 0) & 15;
      const dec = Number(f.dec || 0);
      let v = /^\d+$/.test(s) ? Number(s) / 10 ** dec : 0;
      if (sign === 0xD || sign === 0xB) v = -v;
      out.push(dec ? v.toFixed(dec) : String(v));
      pos += bl;
      continue;
    }
    if (t === '*BIN' || t === '*UBIN') {
      const v = n === 2 ? (t === '*BIN' ? bytes.readInt16BE(pos) : bytes.readUInt16BE(pos)) : n === 8 ? Number(bytes.readBigInt64BE(pos)) : (t === '*BIN' ? bytes.readInt32BE(pos) : bytes.readUInt32BE(pos));
      out.push(String(v));
      pos += n || 4;
      continue;
    }
    if (t === '*HEX') { out.push(bytes.subarray(pos, pos + n).toString('hex').toUpperCase()); pos += n; continue; }
    // *QTDSDATE, *SPP, *SYP, *DTS, *ITV: se muestran como texto de su longitud
    const l = n || 8;
    out.push(data.slice(pos, pos + l));
    pos += l;
  }
  return out;
}

/** FMT((*CHAR 10) (*DEC 5 0)) → [{type, len, dec}] */
export function parseFmt(raw) {
  const s = String(raw || '').trim();
  if (!s || up(s) === '*NONE') return [];
  return (s.match(/\(([^()]*)\)/g) || [s]).map((g) => {
    const [type, len, dec] = g.replace(/[()]/g, ' ').trim().split(/\s+/);
    return { type: up(type), len: Number(len || 0), dec: Number(dec || 0) };
  });
}

export async function saveMsgf(f) {
  await putObject(f.lib, f.name, '*MSGF', '', f.o ? f.o.TEXT : '', f.data, f.o ? f.o.OWNER : 'QSECOFR');
}
