// Prueba de extremo a extremo de ILE en el sistema en marcha: CRTRPGMOD, CRTSRVPGM con lenguaje enlazador y firma,
// CRTBNDDIR/ADDBNDDIRE, CRTBNDRPG con BNDDIR, CRTPGM de varios módulos, almacenamiento estático del programa de
// servicio entre llamadas, CPD5D02 por símbolo no resuelto y MCH4431 por cambio de firma.
// Ejecutar: node tests/ile-e2e.mjs
const BASE = process.env.API || 'http://localhost:10010';
const AUTH = { Authorization: `Basic ${Buffer.from(`${process.env.AS400_USER || 'QSECOFR'}:${process.env.AS400_PWD || 'QSECOFR'}`).toString('base64')}` };
const LIB = 'ILETEST';

async function api(method, path, body, raw) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
async function lastSpool(name) {
  const r = await api('GET', '/spool');
  const s = (r.list || []).filter((x) => x.NAME === name).sort((a, b) => Number(b.ID) - Number(a.ID))[0];
  return s ? (await api('GET', `/spool/${s.ID}`, undefined, true)).replace(/\n$/, '').split('\n').filter((l) => l.trim()) : [];
}
const joblogIds = (r) => (r.joblog || []).map((m) => m.id).filter(Boolean);

const UTILS = `**FREE
ctl-opt nomain;
dcl-s llamadas int(10) inz(0);
dcl-proc SUMAR export;
  dcl-pi *n int(10);
    a int(10) const;
    b int(10) const;
  end-pi;
  return a + b;
end-proc;
dcl-proc CONTADOR export;
  dcl-pi *n int(10) end-pi;
  llamadas += 1;
  return llamadas;
end-proc;
dcl-proc SALUDO export;
  dcl-pi *n varchar(40);
    nombre varchar(20) const;
  end-pi;
  return 'Hola, ' + nombre + '!';
end-proc;
dcl-proc DUPLICA export;
  dcl-pi *n;
    n packed(7:2);
  end-pi;
  n = n * 2;
end-proc;`;

const BND_V1 = `STRPGMEXP PGMLVL(*CURRENT) SIGNATURE('UTILS_V1')
  EXPORT SYMBOL(SUMAR)
  EXPORT SYMBOL(CONTADOR)
  EXPORT SYMBOL(SALUDO)
  EXPORT SYMBOL(DUPLICA)
ENDPGMEXP`;

const USAUTIL = `**FREE
ctl-opt dftactgrp(*no) actgrp('ILEAG') bnddir('MIBND');
dcl-f QSYSPRT printer(132);
dcl-pr sumar int(10);
  a int(10) const;
  b int(10) const;
end-pr;
dcl-pr contador int(10) end-pr;
dcl-pr saludo varchar(40);
  nombre varchar(20) const;
end-pr;
dcl-pr duplica;
  n packed(7:2);
end-pr;
dcl-s linea char(132);
dcl-s importe packed(7:2) inz(10.25);
duplica(importe);
linea = 'SUMA=' + %char(sumar(40:2)) + ' CONT=' + %char(contador()) + ' ' + saludo('ILE') + ' DUP=' + %char(importe);
write QSYSPRT linea;
*inlr = *on;`;

const SINBND = `**FREE
ctl-opt dftactgrp(*no);
dcl-pr sumar int(10);
  a int(10) const;
  b int(10) const;
end-pr;
dsply %char(sumar(1:2));
*inlr = *on;`;

const MAIN2 = `**FREE
ctl-opt dftactgrp(*no);
dcl-f QSYSPRT printer(132);
dcl-pr triple int(10);
  n int(10) const;
end-pr;
dcl-s linea char(132);
linea = 'TRIPLE=' + %char(triple(14));
write QSYSPRT linea;
*inlr = *on;`;

const CALC = `**FREE
ctl-opt nomain;
dcl-proc TRIPLE export;
  dcl-pi *n int(10);
    n int(10) const;
  end-pi;
  return n * 3;
end-proc;`;

(async () => {
  await cmd(`RCLACTGRP ACTGRP(*ELIGIBLE)`, false);
  await cmd(`RMVLIBLE LIB(${LIB})`, false);
  await cmd(`DLTLIB LIB(${LIB})`, false);
  await cmd(`CRTLIB LIB(${LIB}) TEXT('Pruebas ILE')`);
  for (const f of ['QRPGLESRC', 'QSRVSRC']) await cmd(`CRTSRCPF FILE(${LIB}/${f})`);
  await cmd(`ADDLIBLE LIB(${LIB})`, false);
  await put('QRPGLESRC', 'UTILS', 'RPGLE', UTILS);
  await put('QSRVSRC', 'UTILS', 'BND', BND_V1);
  await put('QRPGLESRC', 'USAUTIL', 'RPGLE', USAUTIL);
  await put('QRPGLESRC', 'SINBND', 'RPGLE', SINBND);
  await put('QRPGLESRC', 'MAIN2', 'RPGLE', MAIN2);
  await put('QRPGLESRC', 'CALC', 'RPGLE', CALC);

  const m = await cmd(`CRTRPGMOD MODULE(${LIB}/UTILS) SRCFILE(${LIB}/QRPGLESRC)`, false);
  check('CRTRPGMOD de un módulo NOMAIN', m.status === 200 && /Module UTILS placed/.test(JSON.stringify(m)), JSON.stringify(m).slice(0, 400));
  const dm = await cmd(`DSPMOD MODULE(${LIB}/UTILS)`, false);
  check('DSPMOD lista las exportaciones', /SUMAR CONTADOR SALUDO DUPLICA/.test(JSON.stringify(dm)), JSON.stringify(dm).slice(0, 300));
  const sp = await cmd(`CRTSRVPGM SRVPGM(${LIB}/UTILS) MODULE(${LIB}/UTILS) EXPORT(*SRCFILE) SRCFILE(${LIB}/QSRVSRC)`, false);
  check('CRTSRVPGM con lenguaje enlazador', sp.status === 200, JSON.stringify(sp).slice(0, 400));
  const ds = await cmd(`DSPSRVPGM SRVPGM(${LIB}/UTILS)`, false);
  check('DSPSRVPGM: firma y exportaciones', /UTILS_V1/.test(JSON.stringify(ds)) && /DUPLICA/.test(JSON.stringify(ds)), JSON.stringify(ds).slice(0, 300));

  const nb = await cmd(`CRTBNDRPG PGM(${LIB}/SINBND) SRCFILE(${LIB}/QRPGLESRC)`, false);
  check('CRTBNDRPG sin el programa de servicio: CPD5D02 + CPF5D04', nb.status !== 200 && joblogIds(nb).includes('CPD5D02') && nb.error && nb.error.id === 'CPF5D04', JSON.stringify(nb).slice(0, 500));

  await cmd(`CRTBNDDIR BNDDIR(${LIB}/MIBND)`);
  await cmd(`ADDBNDDIRE BNDDIR(${LIB}/MIBND) OBJ((${LIB}/UTILS *SRVPGM))`);
  const dbd = await cmd(`DSPBNDDIR BNDDIR(${LIB}/MIBND)`, false);
  check('DSPBNDDIR', /UTILS\s+\*SRVPGM/.test(JSON.stringify(dbd)), JSON.stringify(dbd).slice(0, 300));
  const cu = await cmd(`CRTBNDRPG PGM(${LIB}/USAUTIL) SRCFILE(${LIB}/QRPGLESRC)`, false);
  check('CRTBNDRPG con BNDDIR en CTL-OPT', cu.status === 200, JSON.stringify(cu).slice(0, 500));
  const c1 = await cmd(`CALL PGM(${LIB}/USAUTIL)`, false);
  const s1 = await lastSpool('QSYSPRT');
  check('llamada a procedimientos del programa de servicio', c1.status === 200 && /SUMA=42 CONT=1 Hola, ILE! DUP=20\.50/.test(s1[0] || ''), `${JSON.stringify(c1).slice(0, 300)} ${s1[0]}`);
  await cmd(`CALL PGM(${LIB}/USAUTIL)`, false);
  const s2 = await lastSpool('QSYSPRT');
  check('almacenamiento estático del programa de servicio persiste en el trabajo', /CONT=2/.test(s2[0] || ''), s2[0]);
  await cmd(`RCLACTGRP ACTGRP(*ELIGIBLE)`);
  await cmd(`CALL PGM(${LIB}/USAUTIL)`, false);
  const s3 = await lastSpool('QSYSPRT');
  check('RCLACTGRP reinicia el programa de servicio', /CONT=1/.test(s3[0] || ''), s3[0]);

  // Cambio de firma sin nivel anterior → MCH4431; con PGMLVL(*PRV) vuelve a funcionar
  await put('QSRVSRC', 'UTILS', 'BND', BND_V1.replace('UTILS_V1', 'UTILS_V2'));
  await cmd(`CRTSRVPGM SRVPGM(${LIB}/UTILS) MODULE(${LIB}/UTILS) EXPORT(*SRCFILE) SRCFILE(${LIB}/QSRVSRC)`);
  const c4 = await cmd(`CALL PGM(${LIB}/USAUTIL)`, false);
  check('firma cambiada: MCH4431', c4.status !== 200 && /MCH4431|signature/i.test(JSON.stringify(c4)), JSON.stringify(c4).slice(0, 400));
  await put('QSRVSRC', 'UTILS', 'BND', `${BND_V1.replace('UTILS_V1', 'UTILS_V2')}\n${BND_V1.replace('*CURRENT', '*PRV')}`);
  await cmd(`CRTSRVPGM SRVPGM(${LIB}/UTILS) MODULE(${LIB}/UTILS) EXPORT(*SRCFILE) SRCFILE(${LIB}/QSRVSRC)`);
  const c5 = await cmd(`CALL PGM(${LIB}/USAUTIL)`, false);
  check('con PGMLVL(*PRV) el programa enlazado a la firma anterior sigue funcionando', c5.status === 200, JSON.stringify(c5).slice(0, 300));

  // Programa de varios módulos
  await cmd(`CRTRPGMOD MODULE(${LIB}/MAIN2) SRCFILE(${LIB}/QRPGLESRC)`);
  await cmd(`CRTRPGMOD MODULE(${LIB}/CALC) SRCFILE(${LIB}/QRPGLESRC)`);
  const cp = await cmd(`CRTPGM PGM(${LIB}/P2) MODULE(${LIB}/MAIN2 ${LIB}/CALC) ENTMOD(MAIN2)`, false);
  check('CRTPGM de dos módulos', cp.status === 200, JSON.stringify(cp).slice(0, 400));
  const c6 = await cmd(`CALL PGM(${LIB}/P2)`, false);
  const s6 = await lastSpool('QSYSPRT');
  check('llamada entre módulos del mismo programa', c6.status === 200 && /TRIPLE=42/.test(s6[0] || ''), `${JSON.stringify(c6).slice(0, 300)} ${s6[0]}`);
  const cpn = await cmd(`CRTPGM PGM(${LIB}/P3) MODULE(${LIB}/CALC)`, false);
  check('CRTPGM sólo con módulos NOMAIN: CPF5D0B', cpn.error && cpn.error.id === 'CPF5D0B', JSON.stringify(cpn).slice(0, 300));
  const rb = await cmd(`RTVBNDSRC MODULE(${LIB}/UTILS) SRCFILE(${LIB}/QSRVSRC) SRCMBR(GENERADO)`, false);
  const gen = await api('GET', `/sources/${LIB}/QSRVSRC/GENERADO`, undefined, true);
  check('RTVBNDSRC genera el lenguaje enlazador', rb.status === 200 && /EXPORT SYMBOL\(SALUDO\)/.test(gen), gen.slice(0, 200));

  if (!failed) { await cmd(`RMVLIBLE LIB(${LIB})`, false); await cmd(`DLTLIB LIB(${LIB})`, false); }
  console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
