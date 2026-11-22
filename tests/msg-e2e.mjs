// Prueba de extremo a extremo de archivos de mensajes: CRTMSGF/ADDMSGD/CHGMSGD/RMVMSGD/DSPMSGD, RTVMSG, SNDPGMMSG
// con MSGID/MSGF/MSGDTA, *ESCAPE monitorizado con MONMSG y recibido con RCVMSG, QMHSNDPM desde RPG.
// Ejecutar: node tests/msg-e2e.mjs
const BASE = process.env.API || 'http://localhost:10010';
const AUTH = { Authorization: `Basic ${Buffer.from(`${process.env.AS400_USER || 'QSECOFR'}:${process.env.AS400_PWD || 'QSECOFR'}`).toString('base64')}` };
const LIB = 'MSGTEST';

async function api(method, path, body, raw) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (raw) return t;
  try { const j = JSON.parse(t); return Array.isArray(j) ? { status: r.status, list: j } : { status: r.status, ...j }; } catch { return { status: r.status, text: t }; }
}
const cmd = async (c, ok = true) => {
  const r = await api('POST', '/commands', { command: c });
  if (ok && r.status !== 200) throw new Error(`${c}\n${JSON.stringify(r, null, 1)}`);
  return r;
};
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `  ${extra}` : ''}`); if (!cond) failed++; };
const put = (file, mbr, type, text) => api('PUT', `/sources/${LIB}/${file}/${mbr}?type=${type}`, { lines: text.split('\n') });
const dta = async (n) => { const r = await cmd(`DSPDTAARA DTAARA(${LIB}/${n})`, false); return JSON.stringify(r); };

const PRINCIPAL = `PGM
  DCL VAR(&MSG) TYPE(*CHAR) LEN(132)
  DCL VAR(&ID) TYPE(*CHAR) LEN(7)
  DCL VAR(&DTA) TYPE(*CHAR) LEN(50)
  DCL VAR(&SEV) TYPE(*DEC) LEN(2 0)
  RTVMSG MSGID(USR0001) MSGF(${LIB}/USRMSG) MSGDTA('ACME      00042') MSG(&MSG) SEV(&SEV)
  CHGDTAARA DTAARA(${LIB}/R1) VALUE(&MSG)
  CHGVAR VAR(&MSG) VALUE(&SEV)
  CHGDTAARA DTAARA(${LIB}/R2) VALUE(&MSG)
  CHKOBJ OBJ(${LIB}/NOEXISTE) OBJTYPE(*PGM)
  MONMSG MSGID(CPF9801) EXEC(DO)
    RCVMSG MSGTYPE(*EXCP) MSGID(&ID) MSG(&MSG)
    CHGVAR VAR(&MSG) VALUE(&ID *BCAT &MSG)
    CHGDTAARA DTAARA(${LIB}/R3) VALUE(&MSG)
  ENDDO
  CALL PGM(${LIB}/LANZA)
  MONMSG MSGID(USR0002) EXEC(DO)
    RCVMSG MSGTYPE(*EXCP) MSGID(&ID) MSGDTA(&DTA) MSG(&MSG)
    CHGVAR VAR(&MSG) VALUE(&ID *BCAT %SST(&DTA 1 10) *BCAT &MSG)
    CHGDTAARA DTAARA(${LIB}/R4) VALUE(&MSG)
  ENDDO
  CALL PGM(${LIB}/RPGMSG)
  MONMSG MSGID(USR0003) EXEC(DO)
    RCVMSG MSGTYPE(*EXCP) MSGID(&ID) MSG(&MSG)
    CHGVAR VAR(&MSG) VALUE(&ID *BCAT &MSG)
    CHGDTAARA DTAARA(${LIB}/R5) VALUE(&MSG)
  ENDDO
  CRTDTAARA DTAARA(${LIB}/TMP) TYPE(*CHAR) LEN(10)
  RCVMSG MSGTYPE(*LAST) MSGID(&ID) MSG(&MSG)
  CHGVAR VAR(&MSG) VALUE(&ID *BCAT &MSG)
  CHGDTAARA DTAARA(${LIB}/R6) VALUE(&MSG)
ENDPGM`;

const LANZA = `PGM
  SNDPGMMSG MSGID(USR0002) MSGF(${LIB}/USRMSG) MSGDTA('0000001001') MSGTYPE(*ESCAPE)
ENDPGM`;

const RPGMSG = `**FREE
ctl-opt dftactgrp(*no);
dcl-pr QMHSNDPM extpgm('QMHSNDPM');
  msgid char(7) const;
  msgf char(20) const;
  msgdta char(256) const;
  msgdtalen int(10) const;
  msgtype char(10) const;
  stack char(10) const;
  stackctr int(10) const;
  msgkey char(4);
  errcode char(8);
end-pr;
dcl-s key char(4);
dcl-s err char(8) inz(*allx'00');
QMHSNDPM('USR0003': 'USRMSG    ${LIB.padEnd(10)}': 'VENTAS    ': 10: '*ESCAPE': '*': 1: key: err);
*inlr = *on;`;

(async () => {
  await cmd(`RMVLIBLE LIB(${LIB})`, false);
  await cmd(`DLTLIB LIB(${LIB})`, false);
  await cmd(`CRTLIB LIB(${LIB})`);
  await cmd(`CRTSRCPF FILE(${LIB}/QCLSRC)`);
  await cmd(`CRTSRCPF FILE(${LIB}/QRPGLESRC)`);
  const cm = await cmd(`CRTMSGF MSGF(${LIB}/USRMSG) TEXT('Mensajes de la aplicacion')`, false);
  check('CRTMSGF', cm.status === 200, JSON.stringify(cm).slice(0, 300));
  await cmd(`ADDMSGD MSGID(USR0001) MSGF(${LIB}/USRMSG) MSG('Cliente &1 tiene &2 movimientos pendientes') SECLVL('Revise la cuenta del cliente &1.') SEV(20) FMT((*CHAR 10) (*CHAR 5))`);
  await cmd(`ADDMSGD MSGID(USR0002) MSGF(${LIB}/USRMSG) MSG('Saldo insuficiente en la cuenta &1') SEV(40) FMT((*CHAR 10))`);
  await cmd(`ADDMSGD MSGID(USR0003) MSGF(${LIB}/USRMSG) MSG('Error al procesar el archivo &1') SEV(30) FMT((*CHAR 10))`);
  const dup = await cmd(`ADDMSGD MSGID(USR0001) MSGF(${LIB}/USRMSG) MSG('x')`, false);
  check('ADDMSGD duplicado: CPF2412', dup.error && dup.error.id === 'CPF2412', JSON.stringify(dup.error || dup).slice(0, 200));
  const bad = await cmd(`ADDMSGD MSGID(USR01) MSGF(${LIB}/USRMSG) MSG('x')`, false);
  check('identificador no válido: CPF2401', bad.error && bad.error.id === 'CPF2401', JSON.stringify(bad.error || bad).slice(0, 200));
  const dm = await cmd(`DSPMSGD RANGE(USR0001) MSGF(${LIB}/USRMSG)`, false);
  check('DSPMSGD muestra texto, gravedad y formato', /Cliente &1 tiene &2/.test(JSON.stringify(dm)) && /\*CHAR 10/.test(JSON.stringify(dm)), JSON.stringify(dm).slice(0, 400));
  const ds = await cmd(`DSPMSGD RANGE(CPF9801)`, false);
  check('DSPMSGD de un mensaje del sistema (QCPFMSG)', /CPF9801/.test(JSON.stringify(ds)), JSON.stringify(ds).slice(0, 300));
  for (const n of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) await cmd(`CRTDTAARA DTAARA(${LIB}/${n}) TYPE(*CHAR) LEN(132)`);
  await put('QCLSRC', 'PRINCIPAL', 'CLP', PRINCIPAL);
  await put('QCLSRC', 'LANZA', 'CLP', LANZA);
  await put('QRPGLESRC', 'RPGMSG', 'RPGLE', RPGMSG);
  for (const [m, c] of [['PRINCIPAL', 'CRTBNDCL'], ['LANZA', 'CRTBNDCL']]) {
    const r = await cmd(`${c} PGM(${LIB}/${m}) SRCFILE(${LIB}/QCLSRC)`, false);
    check(`${c} ${m}`, r.status === 200, JSON.stringify(r).slice(0, 400));
  }
  const cr = await cmd(`CRTBNDRPG PGM(${LIB}/RPGMSG) SRCFILE(${LIB}/QRPGLESRC)`, false);
  check('CRTBNDRPG RPGMSG', cr.status === 200, JSON.stringify(cr).slice(0, 400));
  const call = await cmd(`CALL PGM(${LIB}/PRINCIPAL)`, false);
  check('CALL PRINCIPAL', call.status === 200, JSON.stringify(call).slice(0, 600));
  check('RTVMSG con datos de sustitución', /Cliente ACME tiene 00042 movimientos pendientes/.test(await dta('R1')), await dta('R1'));
  check('RTVMSG devuelve la gravedad', /R2: 20/.test(await dta('R2')), await dta('R2'));
  check('MONMSG + RCVMSG *EXCP de un mensaje del sistema', /CPF9801/.test(await dta('R3')), await dta('R3'));
  check('*ESCAPE de un CL llamado con MSGF de usuario', /USR0002 0000001001 Saldo insuficiente en la cuenta 0000001001/.test(await dta('R4')), await dta('R4'));
  check('QMHSNDPM desde RPG con MSGF de usuario', /USR0003 Error al procesar el archivo VENTAS/.test(await dta('R5')), await dta('R5'));
  check('RCVMSG *LAST recibe el mensaje de terminación del mandato anterior', /CPC0904|TMP/.test(await dta('R6')) || /created/.test(await dta('R6')), await dta('R6'));
  const s9 = await cmd(`SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('Proceso cancelado por el usuario') MSGTYPE(*ESCAPE)`, false);
  check('SNDPGMMSG CPF9898 *ESCAPE con QCPFMSG', s9.error && s9.error.id === 'CPF9898' && /Proceso cancelado por el usuario/.test(s9.error.text), JSON.stringify(s9.error || s9).slice(0, 200));
  await cmd(`CHGMSGD MSGID(USR0002) MSGF(${LIB}/USRMSG) MSG('Fondos insuficientes: &1') SEV(50)`);
  const rv = await cmd(`RTVMSG MSGID(USR0002) MSGF(${LIB}/USRMSG) MSGDTA('0000009999')`, false);
  check('CHGMSGD + RTVMSG', /Fondos insuficientes: 0000009999/.test(JSON.stringify(rv)), JSON.stringify(rv).slice(0, 300));
  await cmd(`RMVMSGD MSGID(USR0003) MSGF(${LIB}/USRMSG)`);
  const gone = await cmd(`RTVMSG MSGID(USR0003) MSGF(${LIB}/USRMSG)`, false);
  check('RMVMSGD: CPF2419', gone.error && gone.error.id === 'CPF2419', JSON.stringify(gone.error || gone).slice(0, 200));
  if (!failed) await cmd(`DLTLIB LIB(${LIB})`, false);
  console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
