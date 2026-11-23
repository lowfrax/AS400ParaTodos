// API Open Banking (estilo UK Open Banking / Berlin Group, v3.1) sobre el core bancario:
//   POST /oauth2/token (client_credentials; client_id/secret registrados en BANCO.OAUTHCLI)
//   AISP: /open-banking/v3.1/aisp/accounts, /accounts/{id}, /accounts/{id}/balances, /accounts/{id}/transactions
//   PISP: POST /open-banking/v3.1/pisp/domestic-payments (Idempotency-Key) → programa RPG BNKTRANSF
import crypto from 'node:crypto';
import { sendJson } from '../../../../shared/http.js';
import { signToken, verifyToken, parseBasic } from '../svc/auth.js';
import { pooledCtx, callPgm } from '../svc/jobs.js';
import { getUser } from '../objects.js';
import { secretHash } from './schema.js';

const V = '/open-banking/v3.1';
const idem = new Map(); // Idempotency-Key -> respuesta
const payments = new Map();

async function bankCtx() {
  const prf = (await getUser('BANCOSRV')) || (await getUser('QSECOFR'));
  return pooledCtx('BNKOPENBK', prf, { subsystem: 'QHTTPSVR', type: 'BCH', curlib: 'BANCO' });
}
const iso = (v) => (v ? new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z')).toISOString() : new Date().toISOString());
const links = (req, path) => ({ Self: `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}${path}` });
const meta = (n) => ({ TotalPages: 1, ...(n !== undefined ? { TotalRecords: n } : {}) });
const obError = (res, status, code, msg) => sendJson(res, status, { Code: String(status), Id: crypto.randomUUID(), Message: msg, Errors: [{ ErrorCode: code, Message: msg }] });

async function bearer(req, res, scope) {
  const h = req.headers.authorization || '';
  if (!/^Bearer /i.test(h)) { obError(res, 401, 'UK.OBIE.Header.Missing', 'Bearer token required (POST /oauth2/token).'); return null; }
  try {
    const c = verifyToken(h.slice(7).trim());
    if (!c.cid) throw new Error('Not an Open Banking token.');
    if (scope && !String(c.scope).split(' ').includes(scope)) { obError(res, 403, 'UK.OBIE.Resource.ConsentMismatch', `Scope ${scope} required.`); return null; }
    return c;
  } catch (e) { obError(res, 401, 'UK.OBIE.Header.Invalid', e.message); return null; }
}

export function mountOpenBanking(app) {
  // ---------- OAuth2 ----------
  app.post('/oauth2/token', async (req, res) => {
    const b = typeof req.body === 'object' && req.body ? req.body : Object.fromEntries(new URLSearchParams(String(req.body || '')));
    const basic = parseBasic(req.headers.authorization);
    const id = b.client_id || basic?.user;
    const secret = b.client_secret || basic?.password;
    if ((b.grant_type || 'client_credentials') !== 'client_credentials') return sendJson(res, 400, { error: 'unsupported_grant_type' });
    const c = await bankCtx();
    const r = await c.sql('SELECT CLIENTID, SECRETHASH, SCOPES, CLIENTE, ESTADO, NOMBRE FROM BANCO.OAUTHCLI WHERE CLIENTID = ?', [String(id || '')]);
    const row = r.rows?.[0];
    if (!row || row[1] !== secretHash(String(secret || '')) || row[4] !== 'A') return sendJson(res, 401, { error: 'invalid_client', error_description: 'Client authentication failed.' });
    const allowed = String(row[2]).split(/\s+/);
    const scope = (b.scope ? String(b.scope).split(/\s+/) : allowed).filter((s) => allowed.includes(s));
    const t = signToken({ sub: row[0], cid: row[0], cliente: Number(row[3]), scope: scope.join(' '), aud: 'open-banking' }, 3600);
    sendJson(res, 200, { access_token: t.token, token_type: 'Bearer', expires_in: t.expiresIn, scope: scope.join(' '), client_name: row[5] });
  });
  app.get('/.well-known/openid-configuration', (req, res) => {
    const base = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    sendJson(res, 200, { issuer: base, token_endpoint: `${base}/oauth2/token`, grant_types_supported: ['client_credentials'], scopes_supported: ['accounts', 'payments'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] });
  });

  // ---------- AISP ----------
  const accountOf = (r) => ({
    AccountId: String(r.CUENTA), Currency: r.MONEDA, AccountType: r.SEGMENTO === 'E' ? 'Business' : 'Personal',
    AccountSubType: r.TIPO === 'AHO' ? 'Savings' : r.TIPO === 'CTE' ? 'CurrentAccount' : 'Other', Nickname: r.TIPO === 'AHO' ? 'Ahorro' : 'Cheques',
    Status: r.ESTADO === 'A' ? 'Enabled' : 'Disabled', OpeningDate: r.APERTURA,
    Account: [{ SchemeName: 'UK.OBIE.IBAN', Identification: r.IBAN, Name: r.NOMBRE }, { SchemeName: 'MX.CLABE', Identification: String(r.CLABE).trim(), Name: r.NOMBRE }],
  });
  async function ownAccounts(claims, id) {
    const c = await bankCtx();
    const where = ['C.CLIENTE = ?'];
    const p = [claims.cliente];
    if (id) { where.push('C.CUENTA = ?'); p.push(Number(id) || 0); }
    const r = await c.sql(`SELECT C.CUENTA, C.TIPO, C.MONEDA, C.ESTADO, C.APERTURA, C.IBAN, C.CLABE, C.SALDO, C.DISPONIBLE, L.NOMBRE, L.SEGMENTO
                            FROM BANCO.CUENTAS C JOIN BANCO.CLIENTES L ON L.CLIENTE = C.CLIENTE WHERE ${where.join(' AND ')} ORDER BY C.CUENTA`, p);
    return (r.rows || []).map((row) => Object.fromEntries(r.columns.map((col, i) => [col.name, row[i]])));
  }
  app.get(`${V}/aisp/accounts`, async (req, res) => {
    const c = await bearer(req, res, 'accounts');
    if (!c) return;
    const a = await ownAccounts(c);
    sendJson(res, 200, { Data: { Account: a.map(accountOf) }, Links: links(req, req.path), Meta: meta(a.length) });
  });
  app.get(`${V}/aisp/accounts/:id`, async (req, res) => {
    const c = await bearer(req, res, 'accounts');
    if (!c) return;
    const a = await ownAccounts(c, req.params.id);
    if (!a.length) return obError(res, 404, 'UK.OBIE.Resource.NotFound', `Account ${req.params.id} not found for this consent.`);
    sendJson(res, 200, { Data: { Account: a.map(accountOf) }, Links: links(req, req.path), Meta: meta(1) });
  });
  app.get(`${V}/aisp/accounts/:id/balances`, async (req, res) => {
    const c = await bearer(req, res, 'accounts');
    if (!c) return;
    const a = (await ownAccounts(c, req.params.id))[0];
    if (!a) return obError(res, 404, 'UK.OBIE.Resource.NotFound', `Account ${req.params.id} not found for this consent.`);
    // El saldo se obtiene del programa RPG BNKSALDO (la lógica de negocio sigue en el IBM i)
    const r = await callPgm(await bankCtx(), 'BNKSALDO', 'BANCO', { PCUENTA: a.CUENTA });
    const bal = (type, amt) => ({ AccountId: String(a.CUENTA), Amount: { Amount: Number(amt).toFixed(2), Currency: r.outputs.PMONEDA }, CreditDebitIndicator: Number(amt) >= 0 ? 'Credit' : 'Debit', Type: type, DateTime: new Date().toISOString() });
    sendJson(res, 200, { Data: { Balance: [bal('InterimBooked', r.outputs.PSALDO), bal('InterimAvailable', r.outputs.PDISPONIBLE)] }, Links: links(req, req.path), Meta: meta(2) });
  });
  app.get(`${V}/aisp/accounts/:id/transactions`, async (req, res) => {
    const c = await bearer(req, res, 'accounts');
    if (!c) return;
    const a = (await ownAccounts(c, req.params.id))[0];
    if (!a) return obError(res, 404, 'UK.OBIE.Resource.NotFound', `Account ${req.params.id} not found for this consent.`);
    const where = ['CUENTA = ?'];
    const p = [a.CUENTA];
    if (req.query.fromBookingDateTime) { where.push('FECHA >= TIMESTAMP(?)'); p.push(String(req.query.fromBookingDateTime).replace('T', ' ').replace('Z', '').slice(0, 19)); }
    if (req.query.toBookingDateTime) { where.push('FECHA <= TIMESTAMP(?)'); p.push(String(req.query.toBookingDateTime).replace('T', ' ').replace('Z', '').slice(0, 19)); }
    const ctx = await bankCtx();
    const r = await ctx.sql(`SELECT MOVID, FECHA, TIPO, CONCEPTO, IMPORTE, SALDO, REFERENCIA, CANAL, CONTRAPARTE FROM BANCO.MOVIMIENTOS WHERE ${where.join(' AND ')} ORDER BY MOVID DESC FETCH FIRST ${Math.min(500, Number(req.query.limit || 100))} ROWS ONLY`, p);
    const tx = (r.rows || []).map((x) => ({
      AccountId: String(a.CUENTA), TransactionId: String(x[0]), TransactionReference: x[6], CreditDebitIndicator: x[2] === 'CR' ? 'Credit' : 'Debit', Status: 'Booked',
      BookingDateTime: iso(x[1]), ValueDateTime: iso(x[1]), TransactionInformation: x[3], Amount: { Amount: Number(x[4]).toFixed(2), Currency: a.MONEDA },
      Balance: { Amount: { Amount: Number(x[5]).toFixed(2), Currency: a.MONEDA }, CreditDebitIndicator: 'Credit', Type: 'InterimBooked' },
      BankTransactionCode: { Code: x[7], SubCode: x[2] }, ...(x[8] ? { CreditorAccount: { SchemeName: 'BANCO.Cuenta', Identification: x[8] } } : {}),
    }));
    sendJson(res, 200, { Data: { Transaction: tx }, Links: links(req, req.path), Meta: meta(tx.length) });
  });

  // ---------- PISP ----------
  app.post(`${V}/pisp/domestic-payments`, async (req, res) => {
    const c = await bearer(req, res, 'payments');
    if (!c) return;
    const key = req.headers['idempotency-key'];
    if (!key) return obError(res, 400, 'UK.OBIE.Header.Missing', 'Idempotency-Key header required.');
    if (idem.has(`${c.cid}:${key}`)) { const prev = idem.get(`${c.cid}:${key}`); return sendJson(res, prev.status, prev.body); }
    const ini = req.body?.Data?.Initiation;
    if (!ini) return obError(res, 400, 'UK.OBIE.Field.Missing', 'Data.Initiation required.');
    const debtor = String(ini.DebtorAccount?.Identification || '');
    const creditor = String(ini.CreditorAccount?.Identification || '');
    const own = await ownAccounts(c);
    const deb = own.find((a) => String(a.CUENTA) === debtor || a.IBAN === debtor || String(a.CLABE).trim() === debtor) || (!debtor ? own[0] : null);
    if (!deb) return obError(res, 403, 'UK.OBIE.Resource.ConsentMismatch', 'DebtorAccount does not belong to this consent.');
    const ctx = await bankCtx();
    // El acreedor puede venir por número de cuenta, IBAN o CLABE
    const cr = /^\d{1,10}$/.test(creditor)
      ? await ctx.sql('SELECT CUENTA FROM BANCO.CUENTAS WHERE CUENTA = ?', [Number(creditor)])
      : await ctx.sql('SELECT CUENTA FROM BANCO.CUENTAS WHERE IBAN = CAST(? AS VARCHAR(34)) OR CLABE = CAST(? AS VARCHAR(34))', [creditor, creditor]);
    const creditorAcct = cr.rows?.[0]?.[0];
    if (!creditorAcct) return obError(res, 400, 'UK.OBIE.Unsupported.AccountIdentifier', `CreditorAccount ${creditor} not found (use account number, IBAN or CLABE).`);
    const r = await callPgm(ctx, 'BNKTRANSF', 'BANCO', {
      PORIGEN: deb.CUENTA, PDESTINO: Number(creditorAcct), PIMPORTE: Number(ini.InstructedAmount?.Amount || 0),
      PCONCEPTO: String(ini.RemittanceInformation?.Unstructured || 'Pago Open Banking').slice(0, 60), PCANAL: 'OPBK', PREFER: String(ini.EndToEndIdentification || ini.InstructionIdentification || key).slice(0, 35),
    });
    const ok = r.outputs.PRC === '00';
    const id = ok ? `DP-${r.outputs.PFOLIO}` : `DP-REJ-${Date.now()}`;
    const body = {
      Data: { DomesticPaymentId: id, ConsentId: c.cid, Status: ok ? 'AcceptedSettlementCompleted' : 'Rejected', CreationDateTime: new Date().toISOString(), StatusUpdateDateTime: new Date().toISOString(),
        Initiation: ini, ...(ok ? {} : { StatusReason: [{ StatusReasonCode: r.outputs.PRC, StatusReasonDescription: r.outputs.PMENSAJE }] }) },
      Links: links(req, `${V}/pisp/domestic-payments/${id}`), Meta: {},
    };
    const status = ok ? 201 : 422;
    idem.set(`${c.cid}:${key}`, { status, body });
    payments.set(id, body);
    sendJson(res, status, body);
  });
  app.get(`${V}/pisp/domestic-payments/:id`, async (req, res) => {
    const c = await bearer(req, res, 'payments');
    if (!c) return;
    const p = payments.get(req.params.id);
    if (!p || p.Data.ConsentId !== c.cid) return obError(res, 404, 'UK.OBIE.Resource.NotFound', 'Payment not found.');
    sendJson(res, 200, p);
  });
}
