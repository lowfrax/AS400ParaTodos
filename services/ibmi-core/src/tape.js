// Cinta virtual, como en IBM i: descripciones de dispositivo de cinta (*DEVD, RSRCNAME(*VRT)), catálogos de imágenes
// (*IMGCLG de tipo *TAP con un directorio del IFS) y volúmenes virtuales (archivos de imagen en ese directorio).
// Un volumen contiene archivos de cinta secuenciales: número de secuencia, etiqueta (la biblioteca salvada, QFILEUPR
// para los datos de seguridad, QFILEIOC para la configuración…) y el contenido salvado (el mismo formato que un *SAVF).
// SEQNBR(*END) añade al final; SEQNBR(n) escribe en la posición n y borra lo que hubiera detrás, como una cinta real.
// ENDOPT(*REWIND) vuelve al principio, *LEAVE deja la cinta donde acabó y *UNLOAD descarga el volumen (y monta el
// siguiente volumen cargado del catálogo).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { gw, objectData, putObject } from './objects.js';
import { CLError } from './messages.js';
import * as ifs from './ifs.js';
import { SYS } from './system.js';

const VOL_FORMAT = 'AS400TDS-TAPE-1';
export const IMGCLG_LIB = 'QUSRSYS';
const up = (s) => String(s ?? '').trim().toUpperCase();

// ---------- Descripciones de dispositivo ----------
export async function deviceRow(name) {
  const r = await gw.rows(`SELECT NAME, ATTR, TEXT, OWNER, DATA FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*DEVD'`, [up(name)]);
  if (!r[0]) return null;
  return { ...r[0], data: r[0].DATA ? JSON.parse(r[0].DATA) : {} };
}
async function saveDevice(d) { await putObject('QSYS', d.NAME, '*DEVD', d.ATTR, d.TEXT, d.data, d.OWNER); }

export async function createTapeDevice(name, { rsrcname = '*VRT', text = '', online = '*YES', owner = 'QSYS' } = {}) {
  const n = up(name);
  if (await deviceRow(n)) throw new CLError('CPF9898', `Device description ${n} already exists.`);
  const vrt = up(rsrcname) === '*VRT';
  await putObject('QSYS', n, '*DEVD', vrt ? 'TAPVRT' : 'TAP', text || (vrt ? 'Virtual tape device' : 'Tape device'),
    { devclass: '*TAP', type: vrt ? '63B0' : '3580', model: vrt ? '001' : '004', rsrcname: up(rsrcname), online: up(online), status: up(online) === '*YES' ? 'VARIED ON' : 'VARIED OFF', imgclg: null, pos: 1 }, owner);
}

/** IPL: TAPVRT01 existe (como cuando se configura la cinta virtual) y los dispositivos ONLINE(*YES) se activan. */
export async function initTape() {
  if (!(await deviceRow('TAPVRT01'))) await createTapeDevice('TAPVRT01', { text: 'Virtual tape device' });
  for (const r of await gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND TYPE = '*DEVD'`)) {
    const d = await deviceRow(r.NAME);
    if (d.data.devclass !== '*TAP') continue;
    const st = d.data.online === '*YES' ? 'VARIED ON' : 'VARIED OFF';
    if (d.data.status !== st) { d.data.status = st; await saveDevice(d); }
  }
  for (const d of ['/backup', '/backup/tape']) await fs.promises.mkdir(ifs.real(d), { recursive: true });
}

export async function varyDevice(name, on) {
  const d = await deviceRow(name);
  if (!d) throw new CLError('CPF9814', up(name));
  if (!on && d.data.imgclg) throw new CLError('CPF9898', `Device ${d.NAME} has image catalog ${d.data.imgclg} loaded; unload it first (LODIMGCLG OPTION(*UNLOAD)).`);
  d.data.status = on ? 'VARIED ON' : 'VARIED OFF';
  await saveDevice(d);
  return d;
}

export async function deleteDevice(name) {
  const d = await deviceRow(name);
  if (!d) throw new CLError('CPF9814', up(name));
  if (d.data.status !== 'VARIED OFF') throw new CLError('CPF9898', `Device ${d.NAME} must be varied off before it is deleted.`);
  await gw.exec(`DELETE FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*DEVD'`, [d.NAME]);
}

export async function tapeDevices() {
  const out = [];
  for (const r of await gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND TYPE = '*DEVD' ORDER BY NAME`)) out.push(await deviceRow(r.NAME));
  return out.filter((d) => d && d.data.devclass === '*TAP');
}

// ---------- Catálogos de imágenes ----------
export async function catalogRow(name) {
  const r = await gw.rows(`SELECT NAME, ATTR, TEXT, OWNER FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = '*IMGCLG'`, [IMGCLG_LIB, up(name)]);
  if (!r[0]) return null;
  return { ...r[0], data: (await objectData(gw, IMGCLG_LIB, r[0].NAME, '*IMGCLG')) || { entries: [] } };
}
async function needCatalog(name) {
  const c = await catalogRow(name);
  if (!c) throw new CLError('CPF9898', `Image catalog ${up(name)} not found.`);
  return c;
}
async function saveCatalog(c) { await putObject(IMGCLG_LIB, c.NAME, '*IMGCLG', c.ATTR, c.TEXT, c.data, c.OWNER); }

export async function createCatalog(name, dir, { type = '*TAP', crtdir = false, text = '', owner } = {}) {
  const n = up(name);
  if (await catalogRow(n)) throw new CLError('CPF9898', `Image catalog ${n} already exists.`);
  if (up(type) !== '*TAP') throw new CLError('CPF9898', 'Only TYPE(*TAP) image catalogs are supported (there are no optical devices).');
  const p = ifs.normPath(dir);
  const st = await ifs.stat(p);
  if (!st) { if (!crtdir) throw new CLError('CPFA0A9', p); await ifs.mkdir(p, { parents: true }); } else if (!st.dir) throw new CLError('CPFA0AB', p, 'Not a directory.');
  await putObject(IMGCLG_LIB, n, '*IMGCLG', 'TAP', text, { type: '*TAP', dir: p, status: '*NOTREADY', dev: null, entries: [] }, owner);
}

export async function deleteCatalog(name, { keep = true } = {}) {
  const c = await needCatalog(name);
  if (c.data.dev) throw new CLError('CPF9898', `Image catalog ${c.NAME} is loaded on device ${c.data.dev}.`);
  if (!keep) for (const e of c.data.entries) await fs.promises.unlink(ifs.real(`${c.data.dir}/${e.file}`)).catch(() => {});
  await gw.exec(`DELETE FROM QSYS.OBJECTS WHERE LIB = ? AND NAME = ? AND TYPE = '*IMGCLG'`, [IMGCLG_LIB, c.NAME]);
}

export const catalogs = async () => {
  const out = [];
  for (const r of await gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = ? AND TYPE = '*IMGCLG' ORDER BY NAME`, [IMGCLG_LIB])) out.push(await catalogRow(r.NAME));
  return out;
};

const emptyVolume = (vol, owner = '') => ({ format: VOL_FORMAT, volume: vol, owner, created: new Date().toISOString(), density: '*VRT256K', files: [] });
function readVolume(file) {
  const p = ifs.real(file);
  if (!fs.existsSync(p) || !fs.statSync(p).size) return null;
  const v = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
  if (v.format !== VOL_FORMAT) throw new CLError('CPF9898', `${file} is not a virtual tape volume.`);
  return v;
}
function writeVolume(file, v, maxMB) {
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(v)));
  if (maxMB && buf.length > maxMB * 1024 * 1024) throw new CLError('CPF9898', `End of volume ${v.volume} reached (image size ${maxMB} MB). Add another volume to the image catalog.`);
  fs.mkdirSync(path.dirname(ifs.real(file)), { recursive: true });
  fs.writeFileSync(ifs.real(file), buf);
  return buf.length;
}

/** ADDIMGCLGE: FROMFILE(*NEW) crea un volumen vacío inicializado; FROMFILE(ruta) añade una imagen existente. */
export async function addEntry(name, { fromfile = '*NEW', tofile, volnam = '*TOFILE', imgsiz = 1000, text = '' } = {}) {
  const c = await needCatalog(name);
  const file = String(tofile && tofile !== '*FROMFILE' ? tofile : path.posix.basename(String(fromfile))).replace(/^.*\//, '');
  if (!file || file === '*NEW') throw new CLError('CPD0072', 'TOFILE');
  if (c.data.entries.some((e) => e.file === file)) throw new CLError('CPF9898', `Image file ${file} already in image catalog ${c.NAME}.`);
  const target = `${c.data.dir}/${file}`;
  let vol;
  if (up(fromfile) === '*NEW') {
    vol = up(volnam === '*TOFILE' || !volnam ? file : volnam).replace(/[^A-Z0-9#@$]/g, '').slice(0, 6) || 'VOL001';
    if (fs.existsSync(ifs.real(target))) throw new CLError('CPFA0A0', target);
    writeVolume(target, emptyVolume(vol));
  } else {
    const src = ifs.normPath(fromfile);
    const v = readVolume(src);
    if (!v) throw new CLError('CPFA0A9', src);
    if (src !== target) await ifs.copy(src, target);
    vol = v.volume;
  }
  const idx = (c.data.entries.reduce((m, e) => Math.max(m, e.idx), 0) || 0) + 1;
  c.data.entries.push({ idx, file, volume: vol, size: Number(imgsiz) || 1000, text, status: '*LOADED', wrtptc: '*NO' });
  // Si el catálogo está cargado y no hay volumen montado, el nuevo se monta
  if (c.data.dev && !c.data.entries.some((e) => e.status === '*MOUNTED')) c.data.entries[c.data.entries.length - 1].status = '*MOUNTED';
  await saveCatalog(c);
  return { idx, vol };
}

export async function removeEntry(name, { idx, volnam, keep = true } = {}) {
  const c = await needCatalog(name);
  const i = c.data.entries.findIndex((e) => (idx ? e.idx === Number(idx) : e.volume === up(volnam)));
  if (i < 0) throw new CLError('CPF9898', `Image catalog entry not found in ${c.NAME}.`);
  const [e] = c.data.entries.splice(i, 1);
  if (!keep) await fs.promises.unlink(ifs.real(`${c.data.dir}/${e.file}`)).catch(() => {});
  await saveCatalog(c);
}

export async function changeEntry(name, idx, { wrtptc } = {}) {
  const c = await needCatalog(name);
  const e = c.data.entries.find((x) => x.idx === Number(idx));
  if (!e) throw new CLError('CPF9898', `Image catalog entry ${idx} not found in ${c.NAME}.`);
  if (wrtptc && wrtptc !== '*SAME') e.wrtptc = up(wrtptc);
  await saveCatalog(c);
}

/** LODIMGCLG OPTION(*LOAD|*UNLOAD). Al cargar se monta el primer volumen cargado. */
export async function loadCatalog(name, devName, option = '*LOAD') {
  const c = await needCatalog(name);
  if (up(option) === '*UNLOAD') {
    const dev = c.data.dev ? await deviceRow(c.data.dev) : null;
    c.data.dev = null; c.data.status = '*NOTREADY';
    for (const e of c.data.entries) if (e.status === '*MOUNTED') e.status = '*LOADED';
    await saveCatalog(c);
    if (dev) { dev.data.imgclg = null; dev.data.pos = 1; await saveDevice(dev); }
    return;
  }
  const dev = await deviceRow(devName);
  if (!dev || dev.data.devclass !== '*TAP') throw new CLError('CPF9814', up(devName));
  if (dev.data.rsrcname !== '*VRT') throw new CLError('CPF9898', `Device ${dev.NAME} is not a virtual tape device (RSRCNAME(*VRT)).`);
  if (dev.data.status === 'VARIED OFF') throw new CLError('CPF9898', `Device ${dev.NAME} not varied on.`);
  if (dev.data.imgclg && dev.data.imgclg !== c.NAME) throw new CLError('CPF9898', `Image catalog ${dev.data.imgclg} already loaded on device ${dev.NAME}.`);
  if (c.data.dev && c.data.dev !== dev.NAME) throw new CLError('CPF9898', `Image catalog ${c.NAME} already loaded on device ${c.data.dev}.`);
  c.data.dev = dev.NAME; c.data.status = '*READY';
  if (!c.data.entries.some((e) => e.status === '*MOUNTED')) { const f = c.data.entries.find((e) => e.status === '*LOADED'); if (f) f.status = '*MOUNTED'; }
  await saveCatalog(c);
  dev.data.imgclg = c.NAME; dev.data.pos = 1;
  await saveDevice(dev);
}

/** LODIMGCLGE: monta, carga o descarga una entrada del catálogo. */
export async function loadEntry(name, idx, option = '*MOUNT') {
  const c = await needCatalog(name);
  const e = c.data.entries.find((x) => x.idx === Number(idx));
  if (!e) throw new CLError('CPF9898', `Image catalog entry ${idx} not found in ${c.NAME}.`);
  const o = up(option);
  if (o === '*MOUNT') { for (const x of c.data.entries) if (x.status === '*MOUNTED') x.status = '*LOADED'; e.status = '*MOUNTED'; }
  else if (o === '*LOAD') { if (e.status !== '*MOUNTED') e.status = '*LOADED'; }
  else if (o === '*UNLOAD') e.status = '*UNLOADED';
  await saveCatalog(c);
  if (c.data.dev && o === '*MOUNT') { const d = await deviceRow(c.data.dev); d.data.pos = 1; await saveDevice(d); }
}

// ---------- Acceso a la cinta montada ----------
/** Dispositivo de cinta listo con su volumen montado: { dev, clg, entry, file }. */
export async function mounted(devName) {
  const dev = await deviceRow(devName);
  if (!dev || dev.data.devclass !== '*TAP') throw new CLError('CPF9814', up(devName));
  if (dev.data.status === 'VARIED OFF') throw new CLError('CPF9898', `Device ${dev.NAME} not varied on.`);
  if (!dev.data.imgclg) throw new CLError('CPF9898', `No volume on device ${dev.NAME}. Load an image catalog (LODIMGCLG) on the device.`);
  const clg = await needCatalog(dev.data.imgclg);
  const entry = clg.data.entries.find((e) => e.status === '*MOUNTED');
  if (!entry) throw new CLError('CPF9898', `No volume mounted on device ${dev.NAME} (image catalog ${clg.NAME}).`);
  return { dev, clg, entry, file: `${clg.data.dir}/${entry.file}` };
}

async function afterOp(m, endopt, nextPos) {
  const o = up(endopt || '*REWIND');
  if (o === '*UNLOAD') {
    // Se descarga el volumen y se monta el siguiente cargado del catálogo
    const i = m.clg.data.entries.indexOf(m.clg.data.entries.find((e) => e.idx === m.entry.idx));
    m.clg.data.entries[i].status = '*LOADED';
    const next = m.clg.data.entries.slice(i + 1).find((e) => e.status === '*LOADED');
    if (next) next.status = '*MOUNTED';
    await saveCatalog(m.clg);
    m.dev.data.pos = 1;
  } else m.dev.data.pos = o === '*LEAVE' ? nextPos : 1;
  await saveDevice(m.dev);
}

/** INZTAP NEWVOL(...) CHECK(*YES|*NO): deja el volumen vacío con una etiqueta nueva. */
export async function initVolume(devName, { newvol = '*NONE', newownid = '', check = true, endopt = '*REWIND' } = {}) {
  const m = await mounted(devName);
  if (m.entry.wrtptc === '*YES') throw new CLError('CPF9898', `Volume ${m.entry.volume} is write protected.`);
  const old = readVolume(m.file);
  if (check && old && old.files.length) throw new CLError('CPF9898', `Active files exist on volume ${old.volume} on device ${m.dev.NAME}. Specify CHECK(*NO) to initialize it.`);
  const vol = up(newvol === '*NONE' ? (old ? old.volume : m.entry.volume) : newvol).slice(0, 6);
  writeVolume(m.file, emptyVolume(vol, newownid));
  m.entry.volume = vol;
  m.clg.data.entries.find((e) => e.idx === m.entry.idx).volume = vol;
  await saveCatalog(m.clg);
  await afterOp(m, endopt, 1);
  return vol;
}

/** Volumen montado (para DSPTAP/CHKTAP). */
export async function volumeOf(devName) {
  const m = await mounted(devName);
  const v = readVolume(m.file);
  if (!v) throw new CLError('CPF9898', `Volume on device ${m.dev.NAME} not initialized. Use INZTAP.`);
  return { ...m, vol: v };
}

/**
 * Escribe un archivo de cinta. seqnbr: '*END' o número. Devuelve { seq, volume }.
 * vol: nombre de volumen esperado (VOL) o '*MOUNTED'.
 */
export async function writeFile(devName, { label, content, seqnbr = '*END', endopt = '*REWIND', vol = '*MOUNTED', expdate = '*PERM' }) {
  const m = await mounted(devName);
  if (m.entry.wrtptc === '*YES') throw new CLError('CPF9898', `Volume ${m.entry.volume} on device ${m.dev.NAME} is write protected.`);
  const v = readVolume(m.file);
  if (!v) throw new CLError('CPF9898', `Volume on device ${m.dev.NAME} not initialized. Use INZTAP.`);
  if (vol && vol !== '*MOUNTED' && up(vol) !== v.volume) throw new CLError('CPF9898', `Volume ${v.volume} found on device ${m.dev.NAME}; volume ${up(vol)} expected.`);
  let seq;
  if (up(seqnbr) === '*END') seq = v.files.length + 1;
  else {
    seq = Number(seqnbr);
    if (!(seq >= 1) || seq > v.files.length + 1) throw new CLError('CPF9898', `Sequence number ${seqnbr} not valid for volume ${v.volume} (${v.files.length} files).`);
    // Escribir en mitad de la cinta deja inaccesible lo que había detrás
    v.files = v.files.slice(0, seq - 1);
  }
  const h = content.header || {};
  v.files.push({ seq, label: up(label).slice(0, 17), cmd: h.cmd, savedAt: h.savedAt || new Date().toISOString(), savedBy: h.savedBy, system: SYS.name, expdate, objects: content.ifs ? content.ifs.filter((x) => !x.parent).length : (content.objects || []).length, content });
  const size = writeVolume(m.file, v, m.entry.size);
  await afterOp(m, endopt, seq + 1);
  return { seq, volume: v.volume, size };
}

/**
 * Busca un archivo: por número de secuencia o, con SEQNBR(*SEARCH), por etiqueta desde la posición actual
 * (y luego desde el principio). Devuelve la entrada del archivo o lanza CPF3780.
 */
export async function readFile(devName, { label, seqnbr = '*SEARCH', endopt = '*REWIND', vol = '*MOUNTED' }) {
  const { vol: v, ...m } = await volumeOf(devName);
  if (vol && vol !== '*MOUNTED' && up(vol) !== v.volume) throw new CLError('CPF9898', `Volume ${v.volume} found on device ${m.dev.NAME}; volume ${up(vol)} expected.`);
  let f;
  if (up(seqnbr) === '*SEARCH') {
    const L = up(label);
    const from = m.dev.data.pos || 1;
    f = v.files.find((x) => x.seq >= from && x.label === L) || v.files.find((x) => x.label === L);
  } else f = v.files.find((x) => x.seq === Number(seqnbr));
  if (!f) throw new CLError('CPF3780', up(label));
  await afterOp(m, endopt, f.seq + 1);
  return f;
}

/** Todos los archivos del volumen (RSTLIB SAVLIB(*NONSYS|*ALLUSR|*IBM)). */
export async function allFiles(devName, endopt = '*REWIND') {
  const { vol: v, ...m } = await volumeOf(devName);
  await afterOp(m, endopt, v.files.length + 1);
  return v.files;
}
