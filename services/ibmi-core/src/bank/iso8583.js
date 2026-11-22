// Switch ISO 8583:1987 (ASCII, mapa de bits hexadecimal) para cajeros (ATM) y terminales punto de venta (POS).
// Puerto 8583. Encabezado de longitud de 2 bytes binarios (por omisión) o 4 dígitos ASCII (se detecta solo).
// 0100/0200 → BANCO/BNKAUTH (RPG) → 0110/0210 · 0400/0420 reverso → 0410/0430 · 0800 gestión de red → 0810.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { serverCtx, callPgm } from '../svc/jobs.js';
import { tagConnection } from '../net/servers.js';
import { listen } from '../net/telnet.js';
import { getUser } from '../objects.js';

export const isoEvents = new EventEmitter();
export const isoLog = [];

// Formatos: [tipo, longitud, var] tipo n=numérico, an/ans=alfanumérico, z=track, b=binario (hex en ASCII); var=0 fijo, 2=LLVAR, 3=LLLVAR
const F = {};
const def = (n, t, len, v = 0) => { F[n] = { t, len, v }; };
def(1, 'b', 16); def(2, 'n', 19, 2); def(3, 'n', 6); def(4, 'n', 12); def(5, 'n', 12); def(6, 'n', 12); def(7, 'n', 10); def(8, 'n', 8);
def(9, 'n', 8); def(10, 'n', 8); def(11, 'n', 6); def(12, 'n', 6); def(13, 'n', 4); def(14, 'n', 4); def(15, 'n', 4); def(16, 'n', 4);
def(17, 'n', 4); def(18, 'n', 4); def(19, 'n', 3); def(20, 'n', 3); def(21, 'n', 3); def(22, 'n', 3); def(23, 'n', 3); def(24, 'n', 3);
def(25, 'n', 2); def(26, 'n', 2); def(27, 'n', 1); def(28, 'an', 9); def(29, 'an', 9); def(30, 'an', 9); def(31, 'an', 9);
def(32, 'n', 11, 2); def(33, 'n', 11, 2); def(34, 'ans', 28, 2); def(35, 'z', 37, 2); def(36, 'n', 104, 3); def(37, 'an', 12); def(38, 'an', 6);
def(39, 'an', 2); def(40, 'an', 3); def(41, 'ans', 8); def(42, 'ans', 15); def(43, 'ans', 40); def(44, 'an', 25, 2); def(45, 'an', 76, 2);
for (const n of [46, 47, 48]) def(n, 'ans', 999, 3);
def(49, 'an', 3); def(50, 'an', 3); def(51, 'an', 3); def(52, 'b', 16); def(53, 'n', 16); def(54, 'an', 120, 3);
for (let n = 55; n <= 63; n++) def(n, 'ans', 999, 3);
def(64, 'b', 16); def(65, 'b', 16); def(66, 'n', 1); def(67, 'n', 2); def(68, 'n', 3); def(69, 'n', 3); def(70, 'n', 3); def(71, 'n', 4); def(72, 'n', 4);
def(73, 'n', 6); for (let n = 74; n <= 81; n++) def(n, 'n', 10); for (let n = 82; n <= 85; n++) def(n, 'n', 12); for (let n = 86; n <= 89; n++) def(n, 'n', 16);
def(90, 'n', 42); def(91, 'an', 1); def(92, 'an', 2); def(93, 'an', 5); def(94, 'an', 7); def(95, 'an', 42); def(96, 'b', 16); def(97, 'an', 17);
def(98, 'ans', 25); def(99, 'n', 11, 2); def(100, 'n', 11, 2); def(101, 'ans', 17, 2); def(102, 'ans', 28, 2); def(103, 'ans', 28, 2);
def(104, 'ans', 100, 3); for (let n = 105; n <= 127; n++) def(n, 'ans', 999, 3); def(128, 'b', 16);

export const FIELD_NAMES = {
  2: 'PAN', 3: 'Processing code', 4: 'Amount', 7: 'Transmission date/time', 11: 'STAN', 12: 'Local time', 13: 'Local date', 14: 'Expiration',
  18: 'MCC', 22: 'POS entry mode', 25: 'POS condition', 32: 'Acquirer', 35: 'Track 2', 37: 'RRN', 38: 'Auth code', 39: 'Response', 41: 'Terminal',
  42: 'Merchant', 43: 'Merchant name/location', 48: 'Additional data', 49: 'Currency', 52: 'PIN block', 54: 'Additional amounts', 70: 'Network code', 90: 'Original data', 102: 'Account 1', 103: 'Account 2',
};

/** Decodifica un mensaje ISO 8583 (Buffer o string ASCII, sin encabezado de longitud). */
export function unpack(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  let p = 0;
  const take = (n) => { if (p + n > s.length) throw new Error(`ISO8583: message truncated at position ${p}`); const v = s.slice(p, p + n); p += n; return v; };
  const mti = take(4);
  if (!/^\d{4}$/.test(mti)) throw new Error(`ISO8583: invalid MTI ${JSON.stringify(mti)}`);
  let bitmap = BigInt(`0x${take(16)}`).toString(2).padStart(64, '0');
  if (bitmap[0] === '1') bitmap += BigInt(`0x${take(16)}`).toString(2).padStart(64, '0');
  const fields = {};
  for (let i = 1; i < bitmap.length; i++) {
    if (bitmap[i] !== '1') continue;
    const n = i + 1;
    const f = F[n];
    if (!f) throw new Error(`ISO8583: field ${n} not defined`);
    const len = f.v ? Number(take(f.v)) : f.len;
    if (f.v && len > f.len) throw new Error(`ISO8583: field ${n} length ${len} > ${f.len}`);
    fields[n] = take(len);
  }
  return { mti, fields };
}

/** Codifica {mti, fields} en ASCII. */
export function pack({ mti, fields }) {
  const nums = Object.keys(fields).map(Number).filter((n) => n > 1 && fields[n] !== undefined && fields[n] !== null).sort((a, b) => a - b);
  const secondary = nums.some((n) => n > 64);
  const bits = Array(secondary ? 128 : 64).fill('0');
  if (secondary) bits[0] = '1';
  let body = '';
  for (const n of nums) {
    const f = F[n];
    let v = String(fields[n]);
    bits[n - 1] = '1';
    if (f.v) {
      v = v.slice(0, f.len);
      body += String(v.length).padStart(f.v, '0') + v;
    } else {
      v = f.t === 'n' ? v.padStart(f.len, '0').slice(-f.len) : v.padEnd(f.len).slice(0, f.len);
      body += v;
    }
  }
  const hex = (b) => BigInt(`0b${b.join('')}`).toString(16).toUpperCase().padStart(16, '0');
  const bm = secondary ? hex(bits.slice(0, 64)) + hex(bits.slice(64)) : hex(bits);
  return Buffer.from(`${mti}${bm}${body}`, 'latin1');
}

export function frame(msg, header = '2B') {
  if (header === '4A') return Buffer.concat([Buffer.from(String(msg.length).padStart(4, '0')), msg]);
  const h = Buffer.alloc(2);
  h.writeUInt16BE(msg.length);
  return Buffer.concat([h, msg]);
}

const CUR = { 484: 'MXN', 840: 'USD', 978: 'EUR', 170: 'COP', 604: 'PEN' };
const CUR_N = Object.fromEntries(Object.entries(CUR).map(([k, v]) => [v, k]));
const pad2 = (n) => String(n).padStart(2, '0');
const nowFields = () => { const d = new Date(); return { 7: `${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`, 12: `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`, 13: `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` }; };

// Cada enlace (cajero, red POS, switch) tiene su propio trabajo: las transacciones de uno no se mezclan con las de otro.
async function linkCtx(name = 'BNKISO8583') {
  const prf = (await getUser('BANCOSRV')) || (await getUser('QSECOFR'));
  return serverCtx(prf, { name, subsystem: 'QSYSWRK', type: 'BCH', fn: 'PGM-BNKAUTH', curlib: 'BANCO' });
}
let sharedCtx = null;

/** Procesa una petición y devuelve la respuesta {mti, fields}. */
export async function processIso(req, c0 = null) {
  const f = req.fields;
  const echo = (nums) => Object.fromEntries(nums.filter((n) => f[n] !== undefined).map((n) => [n, f[n]]));
  const respMti = req.mti.slice(0, 2) + String(Number(req.mti[2]) + 1) + req.mti[3];
  if (req.mti === '0800') return { mti: '0810', fields: { ...echo([7, 11, 12, 13, 32, 70]), ...(!f[7] ? nowFields() : {}), 39: '00' } };
  const c = c0 || sharedCtx || (sharedCtx = await linkCtx('BNKISOAPI'));
  if (req.mti === '0100' || req.mti === '0200') {
    const pan = (f[2] || (f[35] || '').split(/[=D]/)[0] || '').trim();
    const amount = Number(f[4] || 0) / 100;
    const cur = CUR[f[49]] || 'MXN';
    const rrn = f[37] || `${Date.now()}`.slice(-12);
    const r = await callPgm(c, 'BNKAUTH', 'BANCO', [pan, f[3] || '000000', amount, cur, f[41] || '', f[42] || '', f[11] || '', rrn]);
    const o = r.outputs;
    const bal = Math.round(Number(o.PSALDO || 0) * 100);
    const out = { ...echo([2, 3, 4, 7, 11, 12, 13, 32, 37, 41, 42, 49]), 37: rrn, 39: o.PRESP || '96' };
    if (o.PRESP === '00') {
      if (o.PCODAUT) out[38] = o.PCODAUT;
      // Campo 54: tipo de cuenta(2) tipo de importe(2: 02 disponible) moneda(3) signo(C/D) importe(12)
      out[54] = `1002${CUR_N[cur] || '484'}${bal >= 0 ? 'C' : 'D'}${String(Math.abs(bal)).padStart(12, '0')}`;
    }
    out[44] = String(o.PTEXTO || '').trim().slice(0, 25);
    return { mti: respMti, fields: out };
  }
  if (req.mti === '0400' || req.mti === '0420') {
    // Reverso: busca la autorización original por STAN/RRN y devuelve el importe
    const stan = f[90] ? f[90].slice(4, 10) : f[11];
    const pan = (f[2] || '').trim();
    const rows = await c.sql(`SELECT AUTHID, IMPORTE, PAN, REVERSADA FROM BANCO.AUTORIZA WHERE PAN = ? AND (STAN = ? OR RRN = ?) AND RESP = '00' ORDER BY AUTHID DESC FETCH FIRST 1 ROWS ONLY`, [pan, stan || '', f[37] || '']);
    const a = rows.rows?.[0];
    if (!a) return { mti: respMti, fields: { ...echo([2, 3, 4, 7, 11, 37, 41, 42, 49]), 39: '25' } };
    if (a[3] === 'Y') return { mti: respMti, fields: { ...echo([2, 3, 4, 7, 11, 37, 41, 42, 49]), 39: '00' } };
    await c.startCommit('*CHG').catch(() => {});
    const tarj = await c.sql('SELECT CUENTA FROM BANCO.TARJETAS WHERE PAN = ?', [pan]);
    const cuenta = tarj.rows?.[0]?.[0];
    await c.sql('UPDATE BANCO.CUENTAS SET SALDO = SALDO + ?, DISPONIBLE = DISPONIBLE + ?, ULTMOV = CURRENT TIMESTAMP WHERE CUENTA = ?', [a[1], a[1], cuenta]);
    const s = await c.sql('SELECT SALDO FROM BANCO.CUENTAS WHERE CUENTA = ?', [cuenta]);
    await c.sql(`INSERT INTO BANCO.MOVIMIENTOS (CUENTA, TIPO, CONCEPTO, IMPORTE, SALDO, REFERENCIA, CANAL) VALUES (?, 'CR', 'Reverso de autorizacion', ?, ?, ?, 'ATM')`, [cuenta, a[1], s.rows?.[0]?.[0] ?? 0, f[37] || stan]);
    await c.sql(`UPDATE BANCO.AUTORIZA SET REVERSADA = 'Y' WHERE AUTHID = ?`, [a[0]]);
    await c.endCommit({ commit: true });
    return { mti: respMti, fields: { ...echo([2, 3, 4, 7, 11, 37, 41, 42, 49]), 39: '00' } };
  }
  return { mti: respMti, fields: { ...echo([2, 3, 4, 7, 11, 37, 41]), 39: '12' } };
}

function logIso(dir, msg, remote, ms) {
  const e = { t: Date.now(), dir, mti: msg.mti, stan: msg.fields[11], pan: msg.fields[2] ? `${msg.fields[2].slice(0, 6)}******${msg.fields[2].slice(-4)}` : '', amount: msg.fields[4] ? Number(msg.fields[4]) / 100 : null, resp: msg.fields[39] || '', remote, ms };
  isoLog.push(e);
  if (isoLog.length > 200) isoLog.shift();
  isoEvents.emit('message', e);
}

function handle(socket, ctl) {
  const conn = ctl.track(socket, { detail: 'ISO8583' });
  let buf = Buffer.alloc(0);
  let header = null;
  let chain = Promise.resolve();
  let linkJob = null;
  socket.on('close', () => { if (linkJob) import('../svc/jobs.js').then((m) => m.endServerCtx(linkJob)); });
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) return;
      // 4 dígitos ASCII = longitud ASCII; un encabezado binario de 2 bytes nunca empieza por dígitos ASCII.
      if (!header) header = /^\d{4}$/.test(buf.subarray(0, 4).toString('latin1')) ? '4A' : '2B';
      const hl = header === '4A' ? 4 : 2;
      const len = header === '4A' ? Number(buf.subarray(0, 4).toString('latin1')) : buf.readUInt16BE(0);
      if (buf.length < hl + len) return;
      const msg = buf.subarray(hl, hl + len);
      buf = buf.subarray(hl + len);
      chain = chain.then(async () => {
        const t0 = Date.now();
        let req;
        try { req = unpack(msg); } catch (e) { console.error(`[iso8583] ${e.message}`); return; }
        logIso('IN', req, conn.remoteAddress, 0);
        tagConnection(conn, { detail: `ISO8583 ${req.mti} ${req.fields[41] || ''}`.trim(), user: 'BANCOSRV' });
        let resp;
        try { linkJob = linkJob || (await linkCtx(`BNKISO${String(conn.id % 10000).padStart(4, '0')}`)); resp = await processIso(req, linkJob); } catch (e) {
          console.error('[iso8583]', e);
          resp = { mti: req.mti.slice(0, 2) + String(Number(req.mti[2]) + 1) + req.mti[3], fields: { 11: req.fields[11], 37: req.fields[37], 39: '96' } };
        }
        socket.write(frame(pack(resp), header));
        logIso('OUT', resp, conn.remoteAddress, Date.now() - t0);
      });
    }
  });
  socket.on('error', () => {});
}

/** Cliente ISO 8583 (simulador de cajero / pruebas). */
export async function isoRequest(host, port, msg, { header = '2B', timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host, () => s.write(frame(pack(msg), header)));
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { s.destroy(); reject(new Error('ISO8583 timeout')); }, timeout);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const hl = header === '4A' ? 4 : 2;
      if (buf.length < hl) return;
      const len = header === '4A' ? Number(buf.subarray(0, 4).toString()) : buf.readUInt16BE(0);
      if (buf.length < hl + len) return;
      clearTimeout(t);
      s.end();
      resolve(unpack(buf.subarray(hl, hl + len)));
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export function isoServerDef() {
  const port = Number(process.env.ISO8583_PORT || 8583);
  return {
    key: '*ISO8583', title: 'Switch ISO 8583 (ATM/POS)', job: 'BNKISO8583', user: 'BANCOSRV', subsystem: 'QSYSWRK', fn: 'PGM-BNKAUTH',
    ports: [{ port, label: 'iso8583' }],
    async start(ctl) {
      const s = net.createServer((sock) => handle(sock, ctl));
      await listen(s, port);
      return s;
    },
  };
}
