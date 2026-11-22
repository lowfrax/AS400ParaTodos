// API REST del core bancario para canales (banca en línea, app móvil, Flask, integraciones):
// /api/banco/... — autenticación Basic/Bearer con perfiles IBM i. La lógica de negocio está en los programas RPG.
import { sendJson, send } from '../../../../shared/http.js';
import { authed, fail } from '../net/http/common.js';
import { callPgm, runCmd } from '../svc/jobs.js';
import { camt053, mt940, parseMT103, parsePacs008, applyInbound, speiOut, buildMT103 } from './swift.js';
import { validClabe, validIban } from './schema.js';
import { isoLog, isoRequest } from './iso8583.js';
import { bankEvents, recentEvents } from './events.js';
import { SSEHub } from '../../../../shared/http.js';

const rows = (r) => (r.rows || []).map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])));
const hub = new SSEHub();
bankEvents.on('event', (e) => hub.broadcast('evento', e));

export function mountBankApi(app) {
  const B = '/api/banco';
  const q = async (ctx, sql, p = []) => {
    const r = await ctx.sql(sql, p);
    if (r.error) throw Object.assign(new Error(r.error), { sqlstate: r.sqlstate, sqlcode: r.sqlcode, status: 400 });
    return rows(r);
  };

  app.get(`${B}/resumen`, authed(async (req, res, { ctx }) => {
    const [t] = await q(ctx, `SELECT (SELECT COUNT(*) FROM BANCO.CLIENTES) AS CLIENTES, (SELECT COUNT(*) FROM BANCO.CUENTAS) AS CUENTAS,
      (SELECT COUNT(*) FROM BANCO.MOVIMIENTOS) AS MOVIMIENTOS, (SELECT COUNT(*) FROM BANCO.TRANSFER) AS TRANSFERENCIAS,
      (SELECT COUNT(*) FROM BANCO.AUTORIZA) AS AUTORIZACIONES FROM SYSIBM.SYSDUMMY1`);
    const saldos = await q(ctx, `SELECT MONEDA, SUM(SALDO) AS SALDO, COUNT(*) AS CUENTAS FROM BANCO.CUENTAS WHERE TIPO <> 'PTE' GROUP BY MONEDA ORDER BY MONEDA`);
    sendJson(res, 200, { ...t, saldosPorMoneda: saldos });
  }));
  app.get(`${B}/clientes`, authed(async (req, res, { ctx }) => sendJson(res, 200, await q(ctx, 'SELECT * FROM BANCO.CLIENTES ORDER BY CLIENTE'))));
  app.get(`${B}/clientes/:id`, authed(async (req, res, { ctx }) => {
    const c = await q(ctx, 'SELECT * FROM BANCO.CLIENTES WHERE CLIENTE = ?', [Number(req.params.id)]);
    if (!c.length) return sendJson(res, 404, { error: { id: '14', text: 'Cliente inexistente' } });
    sendJson(res, 200, { ...c[0], cuentas: await q(ctx, 'SELECT * FROM BANCO.CUENTAS WHERE CLIENTE = ? ORDER BY CUENTA', [Number(req.params.id)]) });
  }));
  app.get(`${B}/cuentas`, authed(async (req, res, { ctx }) => {
    const where = req.query.cliente ? 'WHERE C.CLIENTE = ?' : '';
    sendJson(res, 200, await q(ctx, `SELECT C.*, L.NOMBRE FROM BANCO.CUENTAS C JOIN BANCO.CLIENTES L ON L.CLIENTE = C.CLIENTE ${where} ORDER BY C.CUENTA`, req.query.cliente ? [Number(req.query.cliente)] : []));
  }));
  // Saldo a través del programa RPG BNKSALDO
  app.get(`${B}/cuentas/:id`, authed(async (req, res, { ctx }) => {
    const r = await callPgm(ctx, 'BNKSALDO', 'BANCO', { PCUENTA: Number(req.params.id) });
    const o = r.outputs;
    if (o.PRC !== '00') return sendJson(res, o.PRC === '14' ? 404 : 500, { rc: o.PRC, mensaje: o.PMENSAJE });
    const [x] = await q(ctx, 'SELECT CLABE, IBAN, TASA, APERTURA, CLIENTE FROM BANCO.CUENTAS WHERE CUENTA = ?', [Number(req.params.id)]);
    sendJson(res, 200, { cuenta: Number(req.params.id), nombre: o.PNOMBRE, tipo: o.PTIPO, moneda: o.PMONEDA, saldo: o.PSALDO, disponible: o.PDISPONIBLE, estado: o.PESTADO, clabe: String(x.CLABE).trim(), iban: x.IBAN, tasa: x.TASA, apertura: x.APERTURA, cliente: x.CLIENTE, programa: 'BANCO/BNKSALDO', trabajo: r.job });
  }));
  app.get(`${B}/cuentas/:id/movimientos`, authed(async (req, res, { ctx }) => {
    sendJson(res, 200, await q(ctx, `SELECT * FROM BANCO.MOVIMIENTOS WHERE CUENTA = ? ORDER BY MOVID DESC FETCH FIRST ${Math.min(500, Number(req.query.limit || 50))} ROWS ONLY`, [Number(req.params.id)]));
  }));
  // Transferencia a través del programa RPG BNKTRANSF (con COMMIT/ROLLBACK)
  app.post(`${B}/transferencias`, authed(async (req, res, { ctx }) => {
    const b = req.body || {};
    const r = await callPgm(ctx, 'BNKTRANSF', 'BANCO', { PORIGEN: Number(b.origen), PDESTINO: Number(b.destino), PIMPORTE: Number(b.importe), PCONCEPTO: String(b.concepto || ''), PCANAL: String(b.canal || 'API'), PREFER: String(b.referencia || '') });
    const o = r.outputs;
    sendJson(res, o.PRC === '00' ? 201 : 422, { rc: o.PRC, mensaje: o.PMENSAJE, folio: o.PFOLIO, programa: 'BANCO/BNKTRANSF', trabajo: r.job });
  }));
  app.get(`${B}/transferencias`, authed(async (req, res, { ctx }) => sendJson(res, 200, await q(ctx, `SELECT * FROM BANCO.TRANSFER ORDER BY TRFID DESC FETCH FIRST ${Math.min(500, Number(req.query.limit || 50))} ROWS ONLY`))));
  app.get(`${B}/tarjetas`, authed(async (req, res, { ctx }) => sendJson(res, 200, await q(ctx, 'SELECT PAN, CUENTA, TITULAR, VENCE, ESTADO, LIMDIARIO, MARCA FROM BANCO.TARJETAS ORDER BY CUENTA'))));
  app.get(`${B}/autorizaciones`, authed(async (req, res, { ctx }) => sendJson(res, 200, await q(ctx, `SELECT * FROM BANCO.AUTORIZA ORDER BY AUTHID DESC FETCH FIRST ${Math.min(500, Number(req.query.limit || 50))} ROWS ONLY`))));

  // ---------- SPEI / CLABE ----------
  app.get(`${B}/clabe/:clabe`, (req, res) => sendJson(res, 200, { clabe: req.params.clabe, valida: validClabe(req.params.clabe), banco: req.params.clabe.slice(0, 3), plaza: req.params.clabe.slice(3, 6) }));
  app.get(`${B}/iban/:iban`, (req, res) => sendJson(res, 200, { iban: req.params.iban, valido: validIban(req.params.iban) }));
  app.post(`${B}/spei`, authed(async (req, res, { ctx }) => {
    const r = await speiOut(ctx, req.body || {});
    sendJson(res, r.ok ? 201 : 422, r);
  }));

  // ---------- SWIFT / ISO 20022 ----------
  app.post(`${B}/swift/mt103`, authed(async (req, res, { ctx }) => {
    try {
      const raw = typeof req.body === 'string' ? req.body : req.body.mensaje || req.body.message || '';
      const r = await applyInbound(ctx, parseMT103(raw), raw);
      sendJson(res, r.status === 'OK' ? 201 : 422, r);
    } catch (e) { fail(res, e, 400); }
  }));
  app.post(`${B}/iso20022/pacs008`, authed(async (req, res, { ctx }) => {
    try {
      const raw = typeof req.body === 'string' ? req.body : '';
      const out = [];
      for (const p of parsePacs008(raw)) out.push(await applyInbound(ctx, p, raw));
      sendJson(res, out.every((x) => x.status === 'OK') ? 201 : 422, { transacciones: out });
    } catch (e) { fail(res, e, 400); }
  }));
  app.get(`${B}/iso20022/camt053/:cuenta`, authed(async (req, res, { ctx }) => {
    try { send(res, 200, await camt053(ctx, req.params.cuenta, { from: req.query.desde, to: req.query.hasta }), 'application/xml; charset=utf-8'); } catch (e) { fail(res, e); }
  }));
  app.get(`${B}/swift/mt940/:cuenta`, authed(async (req, res, { ctx }) => {
    try { send(res, 200, await mt940(ctx, req.params.cuenta)); } catch (e) { fail(res, e); }
  }));
  app.post(`${B}/swift/mt103/generar`, authed(async (req, res) => send(res, 200, buildMT103(req.body || {}))));
  app.get(`${B}/swift/mensajes`, authed(async (req, res, { ctx }) => sendJson(res, 200, await q(ctx, 'SELECT MSGID, DIRECCION, FORMATO, REFERENCIA, IMPORTE, MONEDA, ESTADO, DETALLE, FECHA FROM BANCO.SWIFTMSG ORDER BY MSGID DESC FETCH FIRST 100 ROWS ONLY'))));

  // ---------- ISO 8583 (simulador de cajero por HTTP) ----------
  app.get(`${B}/iso8583/log`, authed(async (req, res) => sendJson(res, 200, isoLog.slice(-100))));
  app.post(`${B}/iso8583/simular`, authed(async (req, res) => {
    const b = req.body || {};
    const d = new Date();
    const stan = String(b.stan || Math.floor(Math.random() * 999999)).padStart(6, '0');
    const fields = { 2: b.pan || '4111111111111111', 3: b.proc || '010000', 4: String(Math.round(Number(b.importe || 0) * 100)), 7: `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${d.toISOString().slice(11, 19).replace(/:/g, '')}`, 11: stan, 41: b.terminal || 'ATM00001', 42: b.comercio || 'BANCOAS400', 49: b.moneda || '484' };
    try {
      const r = await isoRequest('127.0.0.1', Number(process.env.ISO8583_PORT || 8583), { mti: b.mti || '0200', fields });
      sendJson(res, 200, { solicitud: { mti: b.mti || '0200', fields }, respuesta: r });
    } catch (e) { fail(res, e, 502); }
  }));

  // ---------- Lote y eventos ----------
  app.post(`${B}/cierre`, authed(async (req, res, { ctx }) => {
    const r = await runCmd(ctx, 'SBMJOB CMD(CALL PGM(BANCO/BNKCIERRE)) JOB(CIERRE)');
    sendJson(res, r.ok ? 202 : 400, r);
  }));
  app.get(`${B}/eventos`, authed(async (req, res) => sendJson(res, 200, recentEvents())));
  app.get(`${B}/eventos/stream`, async (req, res) => hub.handle(req, res, [['eventos', recentEvents()]]));
}
