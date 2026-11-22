// Core bancario "Banco AS400" (biblioteca BANCO): datos, programas RPG/CL, pantallas 5250 y todos sus canales:
// switch ISO 8583 (ATM/POS), Open Banking (OAuth2), API REST de canales, IWS (REST/SOAP), SWIFT MT103/MT940,
// ISO 20022 pacs.008/camt.053, SPEI con CLABE, cola de datos de eventos → webhooks/correo, MQ y cierre diario por lotes.
import { addServer } from '../net/index.js';
import { addHttpMount } from '../net/http/server.js';
import { addOpenApiPaths } from '../net/http/openapi.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { Ctx } from '../ctx.js';
import { createJob, endJob } from '../system.js';
import { compileObject } from '../runtime/build.js';
import { createDtaq } from '../dtaq.js';
import { pooledCtx } from '../svc/jobs.js';
import { BANK_DDL, CLIENTES, CUENTAS, TARJETAS, OAUTH_CLIENTS, makeClabe, makeIban, secretHash } from './schema.js';
import { BANK_SOURCES, BANK_COMPILE } from './sources.js';
import { isoServerDef } from './iso8583.js';
import { mountOpenBanking } from './openbanking.js';
import { mountBankApi } from './api.js';
import { startEventMonitor } from './events.js';
import { startInboxWatcher } from './swift.js';

const IWS_SERVICES = {
  banco: {
    program: 'BANCO/BNKSALDO', description: 'Consulta de saldo (BNKSALDO)',
    operations: [{ method: 'GET', path: '/cuentas/{PCUENTA}', names: { PNOMBRE: 'nombre', PTIPO: 'tipo', PMONEDA: 'moneda', PSALDO: 'saldo', PDISPONIBLE: 'disponible', PESTADO: 'estado', PRC: 'rc', PMENSAJE: 'mensaje' } }],
  },
  transferencias: {
    program: 'BANCO/BNKTRANSF', description: 'Transferencia entre cuentas (BNKTRANSF)',
    operations: [{ method: 'POST', path: '/', in: { origen: 'PORIGEN', destino: 'PDESTINO', importe: 'PIMPORTE', concepto: 'PCONCEPTO', canal: 'PCANAL', referencia: 'PREFER' }, names: { PFOLIO: 'folio', PRC: 'rc', PMENSAJE: 'mensaje' } }],
  },
  autorizaciones: {
    program: 'BANCO/BNKAUTH', description: 'Autorizacion de tarjeta (BNKAUTH)',
    operations: [{ method: 'POST', path: '/', in: { pan: 'PPAN', proceso: 'PPROC', importe: 'PIMPORTE', moneda: 'PMONEDA', terminal: 'PTERMINAL', comercio: 'PCOMERCIO', stan: 'PSTAN', rrn: 'PRRN' }, names: { PRESP: 'respuesta', PCODAUT: 'autorizacion', PSALDO: 'saldo', PTEXTO: 'texto' } }],
  },
};

async function seedBank() {
  const isNew = !(await obj.libExists('BANCO'));
  if (isNew) {
    console.log('[ipl] Creando el core bancario (biblioteca BANCO)…');
    await obj.createLibrary('BANCO', 'Core bancario Banco AS400', 'PROD', 'QSECOFR');
  }
  const r = await gw.batch(BANK_DDL, ['42710', '42704', '01550']); // 01550 = el índice ya existe (re-IPL)
  const bad = r.results.find((x) => !x.ok);
  if (bad) throw new Error(`BANCO DDL: ${bad.error}`);
  if (isNew || !(await gw.rows('SELECT COUNT(*) AS N FROM BANCO.CLIENTES'))[0]?.N) {
    const stmts = [];
    for (const c of CLIENTES) stmts.push({ sql: 'INSERT INTO BANCO.CLIENTES (CLIENTE, NOMBRE, DOCUMENTO, EMAIL, TELEFONO, CIUDAD, PAIS, SEGMENTO) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', params: c });
    for (const [cuenta, cliente, tipo, moneda, saldo, tasa] of CUENTAS) {
      stmts.push({ sql: 'INSERT INTO BANCO.CUENTAS (CUENTA, CLIENTE, TIPO, MONEDA, SALDO, DISPONIBLE, TASA, CLABE, IBAN, ULTMOV) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT TIMESTAMP)', params: [cuenta, cliente, tipo, moneda, saldo, saldo, tasa, makeClabe(cuenta), makeIban(cuenta)] });
      if (saldo > 0) stmts.push({ sql: `INSERT INTO BANCO.MOVIMIENTOS (CUENTA, TIPO, CONCEPTO, IMPORTE, SALDO, REFERENCIA, CANAL) VALUES (?, 'CR', 'Deposito inicial', ?, ?, 'APERTURA', 'SUC')`, params: [cuenta, saldo, saldo] });
    }
    for (const t of TARJETAS) stmts.push({ sql: 'INSERT INTO BANCO.TARJETAS (PAN, CUENTA, TITULAR, VENCE, ESTADO, LIMDIARIO, MARCA) VALUES (?, ?, ?, ?, ?, ?, ?)', params: t });
    for (const [id, secret, nombre, scopes, cliente] of OAUTH_CLIENTS) stmts.push({ sql: 'INSERT INTO BANCO.OAUTHCLI (CLIENTID, SECRETHASH, NOMBRE, SCOPES, CLIENTE) VALUES (?, ?, ?, ?, ?)', params: [id, secretHash(secret), nombre, scopes, cliente] });
    const d = await gw.batch(stmts, ['23505']);
    const e = d.results.find((x) => !x.ok);
    if (e) throw new Error(`BANCO datos: ${e.error}`);
    for (const [t, text] of [['CLIENTES', 'Clientes'], ['CUENTAS', 'Cuentas'], ['MOVIMIENTOS', 'Movimientos'], ['TARJETAS', 'Tarjetas'], ['AUTORIZA', 'Autorizaciones ATM/POS'], ['TRANSFER', 'Transferencias'], ['SWIFTMSG', 'Mensajes SWIFT/ISO 20022'], ['OAUTHCLI', 'Clientes OAuth2 (Open Banking)']]) {
      await gw.sql(`COMMENT ON TABLE BANCO.${t} IS '${text}'`);
    }
  }
  await obj.syncSqlTables('BANCO');

  // Perfiles del banco
  if (!(await obj.getUser('BANCOSRV'))) await obj.createUser({ name: 'BANCOSRV', password: 'BANCOSRV', usrcls: '*USER', text: 'Usuario de servicio de canales', curlib: 'BANCO' });
  if (!(await obj.getUser('CAJERO'))) await obj.createUser({ name: 'CAJERO', password: 'CAJERO', usrcls: '*USER', text: 'Cajero de sucursal', curlib: 'BANCO', inlpgm: 'BANCO/BNKTELLER' });

  // Cola de eventos
  if (!(await obj.findObject(gw, 'BNKEVENTS', '*DTAQ', 'BANCO', []))) await createDtaq('BANCO', 'BNKEVENTS', { maxlen: 1024, text: 'Eventos del core bancario' });

  // Fuentes y compilación
  for (const f of ['QRPGLESRC', 'QDDSSRC', 'QCLLESRC']) {
    if (!(await obj.findObject(gw, f, '*FILE', 'BANCO', []))) await obj.createSourceFile('BANCO', f, 112, { QRPGLESRC: 'RPG IV source', QDDSSRC: 'DDS source', QCLLESRC: 'CL source' }[f]);
  }
  // Las fuentes del sistema se actualizan si cambiaron en una versión nueva (y se recompilan).
  const changed = new Set();
  for (const s of BANK_SOURCES) {
    const lines = (s.lines || s.src.split('\n')).map((t) => t.replace(/\s+$/, ''));
    const m = await obj.findMember(gw, 'BANCO', s.file, s.mbr, []);
    if (m) {
      const cur = (await obj.readMember(gw, 'BANCO', s.file, s.mbr)).map((l) => l.text);
      if (cur.join('\n') === lines.join('\n')) continue;
      changed.add(s.mbr);
    } else await obj.addMember('BANCO', s.file, s.mbr, s.type, s.text);
    await obj.writeMember('BANCO', s.file, s.mbr, lines.map((t, i) => ({ seq: i + 1, dat: 0, text: t })));
  }
  const job = createJob({ name: 'QSYSARB', user: 'QSECOFR', type: 'BCH', subsystem: 'QCTL', fn: 'PGM-QWCSEED' });
  job.libl = ['BANCO', 'QGPL', 'QTEMP'];
  job.curlib = 'BANCO';
  const ctx = new Ctx({ job, user: await obj.getUser('QSECOFR'), interactive: false });
  for (const [type, name, src] of BANK_COMPILE) {
    const kind = type === 'DSPF' ? '*FILE' : '*PGM';
    if (!changed.has(name) && (await obj.findObject(gw, name, kind, 'BANCO', []))) continue;
    try {
      const out = await compileObject(ctx, { type, obj: { lib: 'BANCO', obj: name }, srcfile: { lib: 'BANCO', obj: src }, srcmbr: name, text: '*SRCMBRTXT' });
      console.log(`[ipl]   ${out[0]?.text}`);
    } catch (e) { console.error(`[ipl]   BANCO/${name}: ${e.message}`); }
  }
  endJob(job);

  // Servicios web IWS del banco
  const { loadServices, defineService } = await import('../net/http/iws.js');
  const svcs = await loadServices();
  for (const [name, d] of Object.entries(IWS_SERVICES)) if (!svcs[name]) await defineService(name, d);
}

export async function register() {
  addServer(isoServerDef);
  addHttpMount(mountOpenBanking);
  addHttpMount(mountBankApi);
  addOpenApiPaths({
    '/api/banco/cuentas/{id}': { get: { tags: ['Banco'], summary: 'Saldo de una cuenta (programa RPG BNKSALDO)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } } },
    '/api/banco/cuentas/{id}/movimientos': { get: { tags: ['Banco'], summary: 'Movimientos de una cuenta', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } } },
    '/api/banco/transferencias': { post: { tags: ['Banco'], summary: 'Transferencia (programa RPG BNKTRANSF con COMMIT/ROLLBACK)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { origen: { type: 'integer' }, destino: { type: 'integer' }, importe: { type: 'number' }, concepto: { type: 'string' } } } } } }, responses: { 201: { description: 'Aplicada' } } } },
    '/api/banco/spei': { post: { tags: ['Banco'], summary: 'Transferencia SPEI saliente (valida CLABE)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { origen: { type: 'integer' }, clabe: { type: 'string' }, importe: { type: 'number' }, beneficiario: { type: 'string' } } } } } }, responses: { 201: { description: 'Enviada' } } } },
    '/api/banco/swift/mt103': { post: { tags: ['Banco'], summary: 'Recibe un MT103 (texto)', responses: { 201: { description: 'Abonado' } } } },
    '/api/banco/iso20022/pacs008': { post: { tags: ['Banco'], summary: 'Recibe un pacs.008 (XML)', responses: { 201: { description: 'Abonado' } } } },
    '/api/banco/iso20022/camt053/{cuenta}': { get: { tags: ['Banco'], summary: 'Extracto camt.053', parameters: [{ name: 'cuenta', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'XML' } } } },
    '/api/banco/iso8583/simular': { post: { tags: ['Banco'], summary: 'Envía una transacción ISO 8583 al switch (simulador ATM/POS)', responses: { 200: { description: 'Respuesta' } } } },
    '/oauth2/token': { post: { tags: ['Open Banking'], summary: 'Token OAuth2 (client_credentials)', security: [], responses: { 200: { description: 'Token' } } } },
    '/open-banking/v3.1/aisp/accounts': { get: { tags: ['Open Banking'], summary: 'Cuentas del consentimiento', responses: { 200: { description: 'OK' } } } },
    '/open-banking/v3.1/pisp/domestic-payments': { post: { tags: ['Open Banking'], summary: 'Pago doméstico (Idempotency-Key)', responses: { 201: { description: 'Aceptado' } } } },
  });
  await seedBank();
  const getCtx = async () => pooledCtx('BNKMONITOR', (await obj.getUser('BANCOSRV')) || (await obj.getUser('QSECOFR')), { subsystem: 'QSYSWRK', type: 'BCH', curlib: 'BANCO' });
  startEventMonitor(getCtx);
  startInboxWatcher(getCtx, (file, r) => console.log(`[banco] buzón SWIFT ${file}: ${r.map((x) => `${x.status} ${x.detail || ''}`).join('; ')}`));
}
