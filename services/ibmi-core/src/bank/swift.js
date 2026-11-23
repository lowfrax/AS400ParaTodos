// Mensajería interbancaria del core: SWIFT MT103 (entrante) / MT940 (extracto), ISO 20022 pacs.008 (entrante) /
// camt.053 (extracto) y SPEI (salida con CLABE, lote en /banco/ach). Los mensajes llegan por REST o como archivos en el
// buzón del IFS /banco/swift/in (p. ej. subidos por FTP/SFTP), se abonan con BNKTRANSF desde la cuenta puente de la
// moneda y se archivan en /banco/procesados o /banco/error.
import { parseXml, path as xpath, children, child, textOf, esc } from '../../../../shared/xml.js';
import { callPgm } from '../svc/jobs.js';
import * as ifs from '../ifs.js';
import { validClabe, validIban } from './schema.js';
import { SYS } from '../system.js';

export const NOSTRO = { MXN: 9000000001, USD: 9000000002, EUR: 9000000003 };
export const SPEI_CLEARING = 9000000004;

// ---------- MT103 ----------
export function parseMT103(text) {
  const t = String(text).replace(/\r\n/g, '\n');
  const b4 = /\{4:\n?([\s\S]*?)\n?-\}/.exec(t);
  const body = b4 ? b4[1] : t;
  const tags = {};
  let cur = null;
  for (const line of body.split('\n')) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) { cur = m[1]; tags[cur] = m[2]; } else if (cur) tags[cur] += `\n${line}`;
  }
  const b1 = /\{1:F01([A-Z0-9]{8,12})/.exec(t);
  const b2 = /\{2:[IO]103([A-Z0-9]{8,12})?/.exec(t);
  const m32 = /^(\d{6})([A-Z]{3})([\d,]+)$/.exec((tags['32A'] || '').trim());
  if (!tags['20'] || !m32) throw new Error('MT103: tags :20: and :32A: are required.');
  const acct = (v) => { const l = String(v || '').split('\n'); return { account: l[0].startsWith('/') ? l[0].slice(1).trim() : '', name: (l[0].startsWith('/') ? l.slice(1) : l).join(' ').trim() }; };
  return {
    format: 'MT103', reference: tags['20'].trim(), date: m32[1], currency: m32[2], amount: Number(m32[3].replace(',', '.')),
    ordering: acct(tags['50K'] || tags['50A'] || tags['50F']), beneficiary: acct(tags['59'] || tags['59A'] || tags['59F']),
    remittance: (tags['70'] || '').replace(/\n/g, ' ').trim(), charges: (tags['71A'] || '').trim(), sender: b1?.[1] || '', receiver: b2?.[1] || '',
  };
}

export function buildMT103({ reference, currency, amount, ordering, beneficiary, remittance = '', sender = `BAS4${SYS.name.slice(0, 4)}XXX`, receiver = 'DEUTDEFFXXX' }) {
  const d = new Date();
  const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `{1:F01${sender.padEnd(12, 'X').slice(0, 12)}0000000000}{2:I103${receiver.padEnd(12, 'X').slice(0, 12)}N}{3:{108:${reference.slice(0, 16)}}}{4:
:20:${reference.slice(0, 16)}
:23B:CRED
:32A:${yymmdd}${currency}${Number(amount).toFixed(2).replace('.', ',')}
:50K:/${ordering.account}
${ordering.name.slice(0, 35)}
:59:/${beneficiary.account}
${beneficiary.name.slice(0, 35)}
:70:${remittance.slice(0, 35)}
:71A:SHA
-}`;
}

// ---------- ISO 20022 ----------
export function parsePacs008(xml) {
  const doc = parseXml(xml);
  const root = xpath(doc, 'Document', 'FIToFICstmrCdtTrf');
  if (!root) throw new Error('pacs.008: Document/FIToFICstmrCdtTrf not found.');
  const msgId = textOf(xpath(root, 'GrpHdr', 'MsgId'));
  const acctId = (n) => textOf(xpath(n, 'Id', 'IBAN')) || textOf(xpath(n, 'Id', 'Othr', 'Id'));
  return children(root, 'CdtTrfTxInf').map((tx) => {
    const amt = child(tx, 'IntrBkSttlmAmt') || xpath(tx, 'Amt', 'InstdAmt');
    return {
      format: 'pacs.008', msgId, reference: textOf(xpath(tx, 'PmtId', 'EndToEndId')) || textOf(xpath(tx, 'PmtId', 'InstrId')) || msgId,
      currency: amt?.attrs?.Ccy || 'EUR', amount: Number(textOf(amt) || 0),
      ordering: { name: textOf(xpath(tx, 'Dbtr', 'Nm')), account: acctId(child(tx, 'DbtrAcct')) },
      beneficiary: { name: textOf(xpath(tx, 'Cdtr', 'Nm')), account: acctId(child(tx, 'CdtrAcct')) },
      remittance: textOf(xpath(tx, 'RmtInf', 'Ustrd')),
    };
  });
}

export async function camt053(ctx, cuenta, { from, to } = {}) {
  const a = await ctx.sql(`SELECT C.CUENTA, C.MONEDA, C.SALDO, C.IBAN, L.NOMBRE FROM BANCO.CUENTAS C JOIN BANCO.CLIENTES L ON L.CLIENTE = C.CLIENTE WHERE C.CUENTA = ?`, [Number(cuenta)]);
  const acc = a.rows?.[0];
  if (!acc) throw Object.assign(new Error(`Account ${cuenta} not found.`), { status: 404 });
  const where = ['CUENTA = ?'];
  const p = [Number(cuenta)];
  if (from) { where.push('DATE(FECHA) >= DATE(?)'); p.push(from); }
  if (to) { where.push('DATE(FECHA) <= DATE(?)'); p.push(to); }
  const m = await ctx.sql(`SELECT MOVID, FECHA, TIPO, CONCEPTO, IMPORTE, SALDO, REFERENCIA, CANAL FROM BANCO.MOVIMIENTOS WHERE ${where.join(' AND ')} ORDER BY MOVID FETCH FIRST 1000 ROWS ONLY`, p);
  const rows = m.rows || [];
  const [cta, ccy, saldo, iban, nombre] = acc;
  const first = rows[0];
  const opening = first ? Number(first[5]) - (first[2] === 'CR' ? Number(first[4]) : -Number(first[4])) : Number(saldo);
  const closing = rows.length ? Number(rows[rows.length - 1][5]) : Number(saldo);
  const now = new Date().toISOString();
  const d = (v) => String(v).slice(0, 10);
  const bal = (code, amt) => `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${ccy}">${Math.abs(amt).toFixed(2)}</Amt><CdtDbtInd>${amt >= 0 ? 'CRDT' : 'DBIT'}</CdtDbtInd><Dt><Dt>${now.slice(0, 10)}</Dt></Dt></Bal>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>STMT-${cta}-${Date.now()}</MsgId><CreDtTm>${now}</CreDtTm></GrpHdr>
    <Stmt>
      <Id>${cta}-${now.slice(0, 10)}</Id><CreDtTm>${now}</CreDtTm>
      <Acct><Id><IBAN>${esc(iban)}</IBAN></Id><Ccy>${ccy}</Ccy><Ownr><Nm>${esc(nombre)}</Nm></Ownr></Acct>
      ${bal('OPBD', opening)}
      ${bal('CLBD', closing)}
      <TxsSummry><TtlNtries><NbOfNtries>${rows.length}</NbOfNtries></TtlNtries></TxsSummry>
${rows.map((r) => `      <Ntry><NtryRef>${r[0]}</NtryRef><Amt Ccy="${ccy}">${Number(r[4]).toFixed(2)}</Amt><CdtDbtInd>${r[2] === 'CR' ? 'CRDT' : 'DBIT'}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${d(r[1])}</Dt></BookgDt><ValDt><Dt>${d(r[1])}</Dt></ValDt><BkTxCd><Prtry><Cd>${esc(r[7])}</Cd></Prtry></BkTxCd><NtryDtls><TxDtls><Refs><EndToEndId>${esc(r[6] || 'NOTPROVIDED')}</EndToEndId></Refs><RmtInf><Ustrd>${esc(r[3])}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`).join('\n')}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}

export async function mt940(ctx, cuenta) {
  const x = await camt053(ctx, cuenta);
  const doc = parseXml(x);
  const stmt = xpath(doc, 'Document', 'BkToCstmrStmt', 'Stmt');
  const ccy = textOf(xpath(stmt, 'Acct', 'Ccy'));
  const d6 = (s) => s.slice(2, 4) + s.slice(5, 7) + s.slice(8, 10);
  const balLine = (b) => `${textOf(child(b, 'CdtDbtInd')) === 'CRDT' ? 'C' : 'D'}${d6(textOf(xpath(b, 'Dt', 'Dt')))}${ccy}${textOf(child(b, 'Amt')).replace('.', ',')}`;
  const [op, cl] = children(stmt, 'Bal');
  const lines = [`:20:STMT${cuenta}`, `:25:${textOf(xpath(stmt, 'Acct', 'Id', 'IBAN'))}`, ':28C:1/1', `:60F:${balLine(op)}`];
  for (const n of children(stmt, 'Ntry')) {
    const dt = textOf(xpath(n, 'BookgDt', 'Dt'));
    lines.push(`:61:${d6(dt)}${dt.slice(5, 7)}${dt.slice(8, 10)}${textOf(child(n, 'CdtDbtInd')) === 'CRDT' ? 'C' : 'D'}${textOf(child(n, 'Amt')).replace('.', ',')}NTRF${textOf(child(n, 'NtryRef'))}`);
    lines.push(`:86:${textOf(xpath(n, 'NtryDtls', 'TxDtls', 'RmtInf', 'Ustrd')).slice(0, 65)}`);
  }
  lines.push(`:62F:${balLine(cl)}`);
  return `{1:F01BAS4${SYS.name.slice(0, 4).padEnd(4, 'X')}XXX0000000000}{2:I940CUSTOMERXXXXN}{4:\n${lines.join('\n')}\n-}`;
}

// ---------- Abono de un pago entrante ----------
export async function resolveAccount(ctx, ident) {
  const id = String(ident || '').replace(/\s+/g, '').toUpperCase();
  if (/^\d{1,10}$/.test(id)) {
    const r = await ctx.sql('SELECT CUENTA FROM BANCO.CUENTAS WHERE CUENTA = ?', [Number(id)]);
    return r.rows?.[0]?.[0] ?? null;
  }
  // Parámetros con tipo explícito: sin CAST, Db2 tiparía el marcador de CLABE como CHAR(18) y truncaría un IBAN.
  const r = await ctx.sql('SELECT CUENTA FROM BANCO.CUENTAS WHERE IBAN = CAST(? AS VARCHAR(34)) OR CLABE = CAST(? AS VARCHAR(34))', [id, id]);
  return r.rows?.[0]?.[0] ?? null;
}

export async function applyInbound(ctx, p, raw) {
  const nostro = NOSTRO[p.currency];
  const benef = await resolveAccount(ctx, p.beneficiary.account);
  let estado = 'OK';
  let detalle = '';
  let folio = 0;
  if (!nostro) { estado = 'RECHAZADO'; detalle = `Moneda ${p.currency} no operada`; }
  else if (!benef) { estado = 'RECHAZADO'; detalle = `Cuenta beneficiaria ${p.beneficiary.account} inexistente`; }
  else {
    const r = await callPgm(ctx, 'BNKTRANSF', 'BANCO', { PORIGEN: nostro, PDESTINO: Number(benef), PIMPORTE: p.amount, PCONCEPTO: `${p.format} ${p.ordering.name || ''} ${p.remittance || ''}`.trim().slice(0, 60), PCANAL: 'SWFT', PREFER: String(p.reference).slice(0, 35) });
    if (r.outputs.PRC !== '00') { estado = 'RECHAZADO'; detalle = `${r.outputs.PRC} ${r.outputs.PMENSAJE}`; } else { folio = r.outputs.PFOLIO; detalle = `Abonado a ${benef}, folio ${folio}`; }
  }
  await ctx.sql('INSERT INTO BANCO.SWIFTMSG (DIRECCION, FORMATO, REFERENCIA, IMPORTE, MONEDA, ESTADO, DETALLE, CONTENIDO) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['IN', p.format, String(p.reference).slice(0, 35), p.amount, p.currency, estado, detalle.slice(0, 200), String(raw || '').slice(0, 900000)]);
  return { reference: p.reference, format: p.format, amount: p.amount, currency: p.currency, beneficiary: p.beneficiary, status: estado, detail: detalle, folio };
}

// ---------- SPEI saliente ----------
export async function speiOut(ctx, { origen, clabe, importe, beneficiario = '', concepto = 'Pago SPEI', referencia = '' }) {
  if (!validClabe(String(clabe))) return { ok: false, rc: '30', message: `CLABE ${clabe} no valida (digito de control)` };
  // La CLABE interna (banco 999) se liquida como transferencia interna
  const internal = await resolveAccount(ctx, clabe);
  const destino = internal || SPEI_CLEARING;
  const ref = referencia || `SPEI${Date.now().toString().slice(-10)}`;
  const r = await callPgm(ctx, 'BNKTRANSF', 'BANCO', { PORIGEN: Number(origen), PDESTINO: Number(destino), PIMPORTE: Number(importe), PCONCEPTO: `SPEI ${concepto}`.slice(0, 60), PCANAL: 'SPEI', PREFER: ref });
  if (r.outputs.PRC !== '00') return { ok: false, rc: r.outputs.PRC, message: r.outputs.PMENSAJE };
  if (!internal) {
    await ctx.sql(`UPDATE BANCO.TRANSFER SET TIPO = 'SPEI', ESTADO = 'ENV', DESTINO = ?, BENEFICIARIO = ?, BANCODEST = ? WHERE TRFID = ?`, [String(clabe), String(beneficiario).slice(0, 60), String(clabe).slice(0, 3), r.outputs.PFOLIO]);
    // Lote de compensación de ancho fijo (registro por orden): tipo|fecha|folio|clabe ordenante|clabe beneficiaria|importe|beneficiario|concepto|referencia
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const ori = await ctx.sql('SELECT CLABE FROM BANCO.CUENTAS WHERE CUENTA = ?', [Number(origen)]);
    const line = `02${ymd}${String(r.outputs.PFOLIO).padStart(15, '0')}${String(ori.rows?.[0]?.[0] || '').padEnd(18)}${String(clabe).padEnd(18)}${String(Math.round(Number(importe) * 100)).padStart(15, '0')}${String(beneficiario).toUpperCase().padEnd(40).slice(0, 40)}${String(concepto).toUpperCase().padEnd(40).slice(0, 40)}${ref.padEnd(20).slice(0, 20)}\n`;
    await ifs.writeFile(`/banco/ach/spei_${ymd}.txt`, line, { append: true });
  }
  return { ok: true, rc: '00', folio: r.outputs.PFOLIO, internal: !!internal, reference: ref, message: internal ? 'Liquidada internamente' : 'Enviada a SPEI (lote del dia)' };
}

// ---------- Buzón del IFS ----------
export async function processInboxFile(ctx, path) {
  const raw = (await ifs.readFile(path)).toString('utf8');
  const name = path.split('/').pop();
  let results;
  try {
    if (/<\s*Document[\s>]/.test(raw) && /FIToFICstmrCdtTrf/.test(raw)) results = await Promise.all(parsePacs008(raw).map((p) => applyInbound(ctx, p, raw)));
    else if (/\{4:/.test(raw) || /:32A:/.test(raw)) results = [await applyInbound(ctx, parseMT103(raw), raw)];
    else throw new Error('Formato no reconocido (se esperaba MT103 o pacs.008)');
    const allOk = results.every((r) => r.status === 'OK');
    await ifs.rename(path, `/banco/${allOk ? 'procesados' : 'error'}/${Date.now()}_${name}`);
    if (!allOk) await ifs.writeFile(`/banco/error/${Date.now()}_${name}.log`, JSON.stringify(results, null, 2));
    return results;
  } catch (e) {
    await ifs.rename(path, `/banco/error/${Date.now()}_${name}`).catch(() => {});
    await ifs.writeFile(`/banco/error/${Date.now()}_${name}.log`, `${e.message}\n`).catch(() => {});
    return [{ status: 'ERROR', detail: e.message, file: name }];
  }
}

export function startInboxWatcher(getCtx, onResult) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const files = (await ifs.list('/banco/swift/in').catch(() => [])).filter((f) => !f.dir);
      if (files.length) {
        const ctx = await getCtx();
        for (const f of files) {
          // Se espera a que el archivo deje de crecer (subidas FTP en curso)
          if (Date.now() - new Date(f.mtime).getTime() < 1500) continue;
          const r = await processInboxFile(ctx, f.path);
          onResult?.(f.name, r);
        }
      }
    } catch (e) { console.error('[banco] buzón SWIFT:', e.message); } finally { busy = false; }
  }, 4000);
  timer.unref();
  return timer;
}

export { validClabe, validIban };
