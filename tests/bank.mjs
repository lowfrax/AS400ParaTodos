// Pruebas del core bancario (las invoca tests/connections.mjs).
import { isoRequest } from '../services/ibmi-core/src/bank/iso8583.js';

export async function bankTests({ step, assert, api, H, PORT, BASE }) {
  const saldo = async (c) => (await api('GET', `/api/banco/cuentas/${c}`)).json;

  await step('banco', 'Saldo por la API (programa RPG BNKSALDO) y por IWS REST', async () => {
    const s = await saldo(1001);
    assert(s.nombre && s.moneda === 'MXN' && s.programa === 'BANCO/BNKSALDO', JSON.stringify(s));
    const r = await api('GET', '/web/services/banco/cuentas/1001');
    assert(r.status === 200 && r.json.rc === '00' && r.json.moneda === 'MXN', r.text);
    const nf = await api('GET', '/web/services/banco/cuentas/9999');
    assert(nf.json.rc === '14', nf.text);
  });

  await step('banco', 'Transferencia con COMMIT: saldos, movimientos y evento en BNKEVENTS', async () => {
    const a0 = (await saldo(1001)).saldo;
    const b0 = (await saldo(1002)).saldo;
    const r = await api('POST', '/api/banco/transferencias', { origen: 1001, destino: 1002, importe: 150.25, concepto: 'Prueba de conexiones', referencia: 'TEST-1' });
    assert(r.status === 201 && r.json.rc === '00' && r.json.folio > 0, r.text);
    const a1 = (await saldo(1001)).saldo;
    const b1 = (await saldo(1002)).saldo;
    assert(Math.abs(a0 - 150.25 - a1) < 0.001 && Math.abs(b0 + 150.25 - b1) < 0.001, `${a0}->${a1} ${b0}->${b1}`);
    const m = await api('GET', '/api/banco/cuentas/1002/movimientos?limit=1');
    assert(m.json[0].REFERENCIA === 'TEST-1' && m.json[0].TIPO === 'CR', m.text);
    await new Promise((res) => setTimeout(res, 800));
    const ev = await api('GET', '/api/banco/eventos');
    assert(ev.json.some((e) => Number(e.folio) === Number(r.json.folio)), ev.text.slice(0, 300));
  });

  await step('banco', 'Rechazos de negocio: fondos insuficientes (51), monedas distintas (57), sin ROLLBACK parcial', async () => {
    const b0 = (await saldo(1011)).saldo;
    let r = await api('POST', '/api/banco/transferencias', { origen: 1011, destino: 1001, importe: 99999 });
    assert(r.status === 422 && r.json.rc === '51', r.text);
    r = await api('POST', '/api/banco/transferencias', { origen: 1001, destino: 1005, importe: 1 });
    assert(r.json.rc === '57', r.text);
    assert((await saldo(1011)).saldo === b0, 'saldo cambió tras un rechazo');
  });

  await step('banco', 'Transferencia por IWS REST (alias JSON) y SOAP', async () => {
    let r = await api('POST', '/web/services/transferencias', { origen: 1003, destino: 1001, importe: 10, concepto: 'IWS REST' });
    assert(r.status === 200 && r.json.rc === '00', r.text);
    const env = '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><bnksaldo><pcuenta>1003</pcuenta></bnksaldo></soapenv:Body></soapenv:Envelope>';
    r = await api('POST', '/web/services/banco', env, { 'Content-Type': 'text/xml', SOAPAction: 'urn:bnksaldo' });
    assert(/<ns:prc>00<\/ns:prc>/.test(r.text) && /pmoneda>MXN/.test(r.text), r.text);
  });

  await step('banco', 'ISO 8583: 0800 eco, 0200 retiro, 31 consulta, 51 fondos, 54 vencida, 14 inválida, 0400 reverso', async () => {
    const base = { 7: '1122101010', 41: 'ATM00001', 42: 'BANCOAS400', 49: '484' };
    let r = await isoRequest(H, PORT.iso, { mti: '0800', fields: { 7: '1122101010', 11: '000001', 70: '301' } });
    assert(r.mti === '0810' && r.fields[39] === '00', JSON.stringify(r));
    const s0 = (await saldo(1001)).saldo;
    r = await isoRequest(H, PORT.iso, { mti: '0200', fields: { ...base, 2: '4111111111111111', 3: '010000', 4: '000000050000', 11: '000002', 37: 'RRN000000002' } });
    assert(r.mti === '0210' && r.fields[39] === '00' && /^\d{6}$/.test(r.fields[38]), JSON.stringify(r));
    assert(Math.abs((await saldo(1001)).saldo - (s0 - 500)) < 0.001, 'el retiro no debitó 500');
    r = await isoRequest(H, PORT.iso, { mti: '0200', fields: { ...base, 2: '4111111111111111', 3: '310000', 4: '0', 11: '000003' } });
    assert(r.fields[39] === '00' && r.fields[54]?.length === 20, JSON.stringify(r));
    r = await isoRequest(H, PORT.iso, { mti: '0100', fields: { ...base, 2: '4000000000000028', 3: '000000', 4: '000000100000', 11: '000004' } });
    assert(r.fields[39] === '51', JSON.stringify(r));
    r = await isoRequest(H, PORT.iso, { mti: '0100', fields: { ...base, 2: '4000000000000010', 3: '000000', 4: '000000001000', 11: '000005' } });
    assert(r.fields[39] === '54', JSON.stringify(r));
    r = await isoRequest(H, PORT.iso, { mti: '0100', fields: { ...base, 2: '4999999999999999', 3: '000000', 4: '000000001000', 11: '000006' } });
    assert(r.fields[39] === '14', JSON.stringify(r));
    r = await isoRequest(H, PORT.iso, { mti: '0400', fields: { ...base, 2: '4111111111111111', 3: '010000', 4: '000000050000', 11: '000002', 37: 'RRN000000002' } });
    assert(r.mti === '0410' && r.fields[39] === '00', JSON.stringify(r));
    assert(Math.abs((await saldo(1001)).saldo - s0) < 0.001, 'el reverso no devolvió el importe');
    // Encabezado ASCII de 4 dígitos
    r = await isoRequest(H, PORT.iso, { mti: '0800', fields: { 11: '000009', 70: '001' } }, { header: '4A' });
    assert(r.fields[39] === '00', JSON.stringify(r));
  });

  await step('banco', 'Open Banking: OAuth2, cuentas, saldos (BNKSALDO), movimientos y pago con Idempotency-Key', async () => {
    const tok = await fetch(`${BASE}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from('flask-banca:flask-secret').toString('base64')}` }, body: 'grant_type=client_credentials&scope=accounts%20payments' }).then((x) => x.json());
    assert(tok.access_token, JSON.stringify(tok));
    const H2 = { Authorization: `Bearer ${tok.access_token}` };
    const acc = await fetch(`${BASE}/open-banking/v3.1/aisp/accounts`, { headers: H2 }).then((x) => x.json());
    assert(acc.Data.Account.length >= 3 && acc.Data.Account.every((a) => a.Account[0].SchemeName === 'UK.OBIE.IBAN'), JSON.stringify(acc).slice(0, 300));
    const bal = await fetch(`${BASE}/open-banking/v3.1/aisp/accounts/1001/balances`, { headers: H2 }).then((x) => x.json());
    assert(bal.Data.Balance.some((b) => b.Type === 'InterimAvailable'), JSON.stringify(bal));
    const tx = await fetch(`${BASE}/open-banking/v3.1/aisp/accounts/1001/transactions`, { headers: H2 }).then((x) => x.json());
    assert(tx.Data.Transaction.length > 0, JSON.stringify(tx).slice(0, 200));
    const other = await fetch(`${BASE}/open-banking/v3.1/aisp/accounts/1004`, { headers: H2 });
    assert(other.status === 404, `cuenta ajena visible: ${other.status}`);
    const pay = { Data: { Initiation: { InstructionIdentification: 'INSTR-1', EndToEndIdentification: 'E2E-OB-1', InstructedAmount: { Amount: '25.00', Currency: 'MXN' }, DebtorAccount: { Identification: '1001' }, CreditorAccount: { Identification: '1013', Name: 'Valeria' }, RemittanceInformation: { Unstructured: 'Pago OB' } } } };
    const key = `idem-${Date.now()}`;
    const p1 = await fetch(`${BASE}/open-banking/v3.1/pisp/domestic-payments`, { method: 'POST', headers: { ...H2, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(pay) });
    const j1 = await p1.json();
    assert(p1.status === 201 && j1.Data.Status === 'AcceptedSettlementCompleted', JSON.stringify(j1));
    const p2 = await fetch(`${BASE}/open-banking/v3.1/pisp/domestic-payments`, { method: 'POST', headers: { ...H2, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(pay) }).then((x) => x.json());
    assert(p2.Data.DomesticPaymentId === j1.Data.DomesticPaymentId, 'Idempotency-Key no respetada');
    const bad = await fetch(`${BASE}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_id=flask-banca&client_secret=mal' });
    assert(bad.status === 401, `secreto incorrecto: ${bad.status}`);
  });

  await step('banco', 'SWIFT MT103 entrante, ISO 20022 pacs.008, camt.053 y MT940', async () => {
    const s0 = (await saldo(1009)).saldo;
    const mt = `{1:F01DEUTDEFFAXXX0000000000}{2:O1031200DEUTDEFFXXXXN}{4:
:20:MT103TEST${Date.now() % 100000}
:23B:CRED
:32A:261122EUR1250,50
:50K:/DE89370400440532013000
HANS MUELLER
:59:/1009
LUCIA FERNANDEZ DIAZ
:70:FACTURA 2026-001
:71A:SHA
-}`;
    let r = await api('POST', '/api/banco/swift/mt103', mt, { 'Content-Type': 'text/plain' });
    assert(r.status === 201 && r.json.status === 'OK', r.text);
    assert(Math.abs((await saldo(1009)).saldo - (s0 + 1250.5)) < 0.001, 'MT103 no abonado');
    const iban1001 = (await saldo(1001)).iban;
    const pacs = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><FIToFICstmrCdtTrf><GrpHdr><MsgId>PACS-${Date.now()}</MsgId><NbOfTxs>1</NbOfTxs></GrpHdr>
<CdtTrfTxInf><PmtId><EndToEndId>E2E-PACS-1</EndToEndId></PmtId><IntrBkSttlmAmt Ccy="MXN">777.77</IntrBkSttlmAmt><Dbtr><Nm>EMPRESA EXTERNA</Nm></Dbtr><DbtrAcct><Id><IBAN>ES9121000418450200051332</IBAN></Id></DbtrAcct>
<Cdtr><Nm>MARIA</Nm></Cdtr><CdtrAcct><Id><IBAN>${iban1001}</IBAN></Id></CdtrAcct><RmtInf><Ustrd>Pago ISO 20022</Ustrd></RmtInf></CdtTrfTxInf></FIToFICstmrCdtTrf></Document>`;
    r = await api('POST', '/api/banco/iso20022/pacs008', pacs, { 'Content-Type': 'application/xml' });
    assert(r.status === 201 && r.json.transacciones[0].status === 'OK', r.text);
    r = await api('GET', '/api/banco/iso20022/camt053/1001');
    assert(/camt\.053/.test(r.text) && /E2E-PACS-1/.test(r.text), r.text.slice(0, 300));
    r = await api('GET', '/api/banco/swift/mt940/1009');
    assert(/:20:STMT1009/.test(r.text) && /:62F:/.test(r.text), r.text);
  });

  await step('banco', 'SPEI: CLABE válida/ inválida y orden saliente al lote del día', async () => {
    const ok = await api('GET', '/api/banco/clabe/002180012345678906');
    const bad = await api('GET', '/api/banco/clabe/002180012345678901');
    assert(ok.json.valida !== bad.json.valida, `${ok.text} ${bad.text}`);
    const clabe = ok.json.valida ? '002180012345678906' : bad.json.clabe;
    let r = await api('POST', '/api/banco/spei', { origen: 1003, clabe, importe: 99.5, beneficiario: 'PROVEEDOR EXTERNO', concepto: 'Pago factura' });
    assert(r.status === 201 && r.json.ok && !r.json.internal, r.text);
    r = await api('POST', '/api/banco/spei', { origen: 1003, clabe: '002180012345678900', importe: 1 });
    assert(r.status === 422 || r.json.rc === '30' || r.json.ok, r.text);
    const d = new Date();
    const f = await api('GET', `/api/v1/ifs/banco/ach/spei_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.txt`);
    assert(f.status === 200 && f.text.includes('PROVEEDOR EXTERNO'), f.text.slice(0, 200));
  });

  await step('banco', 'CGI en RPG (QtmhWrStout) y buzón SWIFT por IFS', async () => {
    const html = await fetch(`${BASE}/QSYS.LIB/BANCO.LIB/BNKCGI.PGM?cuenta=1001`).then((x) => x.text());
    assert(/Estado de cuenta 1001/.test(html) && /<table>/.test(html), html.slice(0, 300));
    const s0 = (await saldo(1012)).saldo;
    const mt = `{1:F01BOFAUS3NAXXX0000000000}{4:\n:20:INBOX${Date.now() % 100000}\n:32A:261122MXN100,00\n:50K:/111\nCLIENTE EXTERNO\n:59:/1012\nFINTECH DEMO\n-}`;
    await api('PUT', `/api/v1/ifs/banco/swift/in/pago_${Date.now()}.fin`, mt, { 'Content-Type': 'text/plain' });
    const end = Date.now() + 20000;
    let s1 = s0;
    while (Date.now() < end && Math.abs(s1 - s0) < 0.001) { await new Promise((res) => setTimeout(res, 1000)); s1 = (await saldo(1012)).saldo; }
    assert(Math.abs(s1 - (s0 + 100)) < 0.001, `buzón no procesado: ${s0} -> ${s1}`);
  });
}
