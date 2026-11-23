// Prueba de extremo a extremo de los dialectos RPG en el sistema en marcha (docker compose up):
//   RPG III (CRTRPGPGM) con archivo primario descrito por programa sobre un PF real de Db2, ruptura de nivel e impresión,
//   CVTRPGSRC a RPG IV + CRTBNDRPG, y comparación de los archivos en spool de ambos programas.
// Ejecutar: node tests/rpg-e2e.mjs
const BASE = process.env.API || 'http://localhost:10010';
const AUTH = { Authorization: `Basic ${Buffer.from(`${process.env.AS400_USER || 'QSECOFR'}:${process.env.AS400_PWD || 'QSECOFR'}`).toString('base64')}` };
const LIB = 'RPGDIALT';

async function api(method, path, body, raw) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const t = await r.text();
  if (raw) return t;
  try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, text: t }; }
}
const cmd = async (c, ok = true) => {
  const r = await api('POST', '/commands', { command: c });
  if (ok && r.status !== 200) throw new Error(`${c}\n${JSON.stringify(r, null, 1)}`);
  return r;
};
function L(spec, cols = {}) {
  let s = '     ' + spec;
  for (const [pos, text] of Object.entries(cols).sort((a, b) => a[0] - b[0])) s = s.padEnd(Number(pos) - 1) + text;
  return s;
}
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`); if (!cond) failed++; };

const RPG3 = [
  L('H'),
  L('F', { 7: '* VENTRPT - Reporte de ventas por region (RPG III, ciclo)' }),
  L('F', { 7: 'VENTAS', 15: 'IP', 19: 'F', 24: '  20', 40: 'DISK' }),
  L('F', { 7: 'QPRINT', 15: 'O', 19: 'F', 24: ' 132', 33: 'OF', 40: 'PRINTER' }),
  L('I', { 7: 'VENTAS', 15: 'AA', 19: '01' }),
  L('I', { 44: '   1', 48: '   4', 53: 'REGION', 59: 'L1' }),
  L('I', { 44: '   5', 48: '  14', 53: 'CLIENT' }),
  L('I', { 43: 'P', 44: '  15', 48: '  19', 52: '2', 53: 'IMPORT' }),
  L('C', { 9: '01', 18: 'IMPORT', 28: 'ADD', 33: 'TOTREG', 43: 'TOTREG', 49: '  9', 52: '2' }),
  L('C', { 9: '01', 28: 'ADD', 33: '1', 43: 'CUENTA', 49: '  5', 52: '0' }),
  L('C', { 7: 'L1', 18: 'TOTREG', 28: 'ADD', 33: 'TOTGEN', 43: 'TOTGEN', 49: ' 11', 52: '2' }),
  L('O', { 7: 'QPRINT', 15: 'H', 18: '2', 19: '01', 23: '1P' }),
  L('O', { 14: 'OR', 23: 'OF' }),
  L('O', { 40: '  30', 45: "'VENTAS POR REGION'" }),
  L('O', { 32: 'UDATE', 38: 'Y', 40: '  50' }),
  L('O', { 40: '  56', 45: "'PAG.'" }),
  L('O', { 32: 'PAGE', 38: 'Z', 40: '  61' }),
  L('O', { 7: 'QPRINT', 15: 'D', 18: '1', 23: '01' }),
  L('O', { 32: 'REGION', 40: '   6' }),
  L('O', { 32: 'CLIENT', 40: '  18' }),
  L('O', { 32: 'IMPORT', 38: 'J', 40: '  32' }),
  L('O', { 7: 'QPRINT', 15: 'T', 18: '2', 23: 'L1' }),
  L('O', { 40: '  18', 45: "'* TOTAL REGION'" }),
  L('O', { 32: 'TOTREG', 38: 'J', 39: 'B', 40: '  32' }),
  L('O', { 7: 'QPRINT', 15: 'T', 18: '1', 23: 'LR' }),
  L('O', { 40: '  16', 45: "'** TOTAL GENERAL'" }),
  L('O', { 32: 'TOTGEN', 38: 'J', 40: '  32' }),
  L('O', { 32: 'CUENTA', 38: 'Z', 40: '  40' }),
  L('O', { 40: '  50', 45: "'REGISTROS'" }),
];

const DDS = [
  '     A          R VENTASR',
  '     A            REGION         4A',
  '     A            CLIENT        10A',
  '     A            IMPORT         9P 2',
];

// DDS en columnas: nombre 19, longitud 30-34, tipo 35, decimales 36-37, línea 39-41, posición 42-44, palabras clave 45
function A(cols = {}) {
  let s = '     A';
  for (const [pos, text] of Object.entries(cols).sort((a, b) => a[0] - b[0])) s = s.padEnd(Number(pos) - 1) + text;
  return s;
}
const LF_DDS = [
  A({ 17: 'R', 19: 'VENTASLR', 45: 'PFILE(VENTAS)' }),
  A({ 17: 'K', 19: 'REGION', 45: 'DESCEND' }),
  A({ 17: 'K', 19: 'IMPORT' }),
  A({ 17: 'O', 19: 'IMPORT', 45: 'COMP(LE 10)' }),
];
const REG_DDS = [
  A({ 17: 'R', 19: 'REGIONR' }),
  A({ 19: 'REGION', 33: ' 4', 35: 'A' }),
  A({ 19: 'NOMREG', 33: '15', 35: 'A' }),
  A({ 17: 'K', 19: 'REGION' }),
];
const JLF_DDS = [
  A({ 17: 'R', 19: 'VENTJR', 45: 'JFILE(VENTAS REGIONES)' }),
  A({ 17: 'J', 45: 'JOIN(VENTAS REGIONES)' }),
  A({ 45: 'JFLD(REGION REGION)' }),
  A({ 19: 'REGION', 45: 'JREF(1)' }),
  A({ 19: 'NOMREG' }),
  A({ 19: 'CLIENT' }),
  A({ 19: 'IMPORT' }),
  A({ 17: 'K', 19: 'CLIENT' }),
];
const PRTF_DDS = [
  A({ 17: 'R', 19: 'CABECERA', 45: 'SKIPB(1) SPACEA(2)' }),
  A({ 42: '  2', 45: "'LISTADO POR LOGICO'" }),
  A({ 42: ' 40', 45: 'DATE EDTCDE(Y)' }),
  A({ 42: ' 52', 45: "'PAG'" }),
  A({ 42: ' 56', 45: 'PAGNBR EDTCDE(Z)' }),
  A({ 17: 'R', 19: 'DETALLE', 45: 'SPACEA(1)' }),
  A({ 19: 'REGION', 33: ' 4', 35: 'A', 42: '  2' }),
  A({ 19: 'CLIENT', 32: ' 10', 35: 'A', 42: '  8' }),
  A({ 19: 'IMPORT', 33: ' 9', 35: 'P', 36: ' 2', 42: ' 20', 45: 'EDTCDE(J)' }),
  A({ 9: '50', 42: ' 35', 45: "'*ALTO*'" }),
  A({ 17: 'R', 19: 'TOTAL', 45: 'SPACEB(1)' }),
  A({ 42: '  2', 45: "'TOTAL'" }),
  A({ 19: 'TOTAL', 32: ' 11', 35: 'P', 36: ' 2', 42: ' 18', 45: 'EDTCDE(J)' }),
];
const LSTLOG = `**FREE
ctl-opt dftactgrp(*no);
dcl-f VENTASL keyed;
dcl-f LISTADO printer oflind(*in90);
write CABECERA;
read VENTASL;
dow not %eof(VENTASL);
  *in50 = IMPORT > 500;
  TOTAL += IMPORT;
  if *in90;
    write CABECERA;
    *in90 = *off;
  endif;
  write DETALLE;
  read VENTASL;
enddo;
write TOTAL;
*inlr = *on;`;

async function lastSpool(name) {
  const list = await api('GET', '/spool');
  const arr = Array.isArray(list) ? list : Object.values(list).filter((x) => x && x.ID);
  const s = arr.filter((x) => x.NAME === name).sort((a, b) => Number(b.ID) - Number(a.ID))[0];
  if (!s) return null;
  return (await api('GET', `/spool/${s.ID}`, undefined, true)).replace(/\n$/, '').split('\n');
}

(async () => {
  await cmd(`RMVLIBLE LIB(${LIB})`, false);
  await cmd(`DLTLIB LIB(${LIB})`, false);
  await cmd(`CRTLIB LIB(${LIB}) TEXT('Pruebas de dialectos RPG')`);
  for (const f of ['QRPGSRC', 'QRPGLESRC', 'QDDSSRC']) await cmd(`CRTSRCPF FILE(${LIB}/${f})`);
  await api('PUT', `/sources/${LIB}/QDDSSRC/VENTAS?type=PF`, { lines: DDS });
  await cmd(`CRTPF FILE(${LIB}/VENTAS) SRCFILE(${LIB}/QDDSSRC)`);
  const rows = [['NORT', 'ACME', 120.5], ['NORT', 'GLOBEX', 79.5], ['SUR', 'INITECH', 1000], ['SUR', 'UMBRELLA', 0.25], ['SUR', 'HOOLI', 15]];
  for (const r of rows) await api('POST', '/sql', { sql: `INSERT INTO ${LIB}.VENTAS VALUES (?, ?, ?)`, params: r });
  const put = await api('PUT', `/sources/${LIB}/QRPGSRC/VENTRPT?type=RPG`, { lines: RPG3 });
  check('fuente RPG III guardado', put.lines === RPG3.length, JSON.stringify(put));

  const c3 = await cmd(`CRTRPGPGM PGM(${LIB}/VENTRPT) SRCFILE(${LIB}/QRPGSRC)`, false);
  check('CRTRPGPGM compila RPG III', c3.status === 200, JSON.stringify(c3.messages || c3).slice(0, 600));
  await cmd(`ADDLIBLE LIB(${LIB})`, false);
  const call3 = await cmd(`CALL PGM(${LIB}/VENTRPT)`, false);
  check('CALL del programa RPG III', call3.status === 200, JSON.stringify(call3).slice(0, 400));
  const sp3 = await lastSpool('QPRINT');
  const body3 = (sp3 || []).filter((l) => l.trim());
  console.log(body3.map((l) => `    |${l}`).join('\n'));
  check('cabecera con PAGE', /VENTAS POR REGION.*PAG\.\s+1$/.test(body3[0] || ''));
  check('detalle y totales de nivel', body3.some((l) => /\* TOTAL REGION\s+200\.00/.test(l)) && body3.some((l) => /\* TOTAL REGION\s+1,015\.25/.test(l)));
  check('total general LR', body3.some((l) => /\*\* TOTAL GENERAL\s+1,215\.25\s+5 REGISTROS/.test(l)));

  const cv = await cmd(`CVTRPGSRC FROMFILE(${LIB}/QRPGSRC) FROMMBR(VENTRPT) TOFILE(${LIB}/QRPGLESRC)`, false);
  check('CVTRPGSRC', cv.status === 200, JSON.stringify(cv).slice(0, 300));
  const c4 = await cmd(`CRTBNDRPG PGM(${LIB}/VENTRPT4) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(VENTRPT)`, false);
  check('CRTBNDRPG del fuente convertido', c4.status === 200, JSON.stringify(c4.messages || c4).slice(0, 600));
  await cmd(`CALL PGM(${LIB}/VENTRPT4)`, false);
  const sp4 = await lastSpool('QPRINT');
  check('RPG IV convertido imprime lo mismo que RPG III', !!sp3 && !!sp4 && JSON.stringify(sp4) === JSON.stringify(sp3));
  const list = JSON.parse(await api('GET', `/libraries/${LIB}/objects`, undefined, true));
  const a3 = list.find((o) => o.NAME === 'VENTRPT');
  const a4 = list.find((o) => o.NAME === 'VENTRPT4');
  check('atributos de objeto RPG / RPGLE', a3 && a3.ATTR === 'RPG' && a4 && a4.ATTR === 'RPGLE', `${a3 && a3.ATTR} ${a4 && a4.ATTR}`);

  // ---------- Archivos lógicos (CRTLF) y de impresora (CRTPRTF) ----------
  await api('PUT', `/sources/${LIB}/QDDSSRC/VENTASL?type=LF`, { lines: LF_DDS });
  const clf = await cmd(`CRTLF FILE(${LIB}/VENTASL) SRCFILE(${LIB}/QDDSSRC)`, false);
  check('CRTLF con clave DESCEND y selección/omisión', clf.status === 200, JSON.stringify(clf).slice(0, 400));
  await api('PUT', `/sources/${LIB}/QDDSSRC/REGIONES?type=PF`, { lines: REG_DDS });
  await cmd(`CRTPF FILE(${LIB}/REGIONES) SRCFILE(${LIB}/QDDSSRC)`);
  for (const r of [['NORT', 'Norte'], ['SUR', 'Sur']]) await api('POST', '/sql', { sql: `INSERT INTO ${LIB}.REGIONES VALUES (?, ?)`, params: r });
  await api('PUT', `/sources/${LIB}/QDDSSRC/VENTJ?type=LF`, { lines: JLF_DDS });
  const cj = await cmd(`CRTLF FILE(${LIB}/VENTJ) SRCFILE(${LIB}/QDDSSRC)`, false);
  check('CRTLF lógico de unión (JFILE/JOIN/JFLD)', cj.status === 200, JSON.stringify(cj).slice(0, 400));
  const jr = await api('POST', '/sql', { sql: `SELECT CLIENT, NOMREG FROM ${LIB}.VENTJ ORDER BY CLIENT` });
  check('el lógico de unión devuelve los nombres de región', (jr.data || []).length === 5 && jr.data[0].NOMREG.trim() === 'Norte', JSON.stringify(jr.data || jr).slice(0, 300));
  const dl = await cmd(`DLTF FILE(${LIB}/VENTAS)`, false);
  check('DLTF de un físico con lógicos dependientes: CPF3220', dl.error && dl.error.id === 'CPF3220', JSON.stringify(dl.error || dl).slice(0, 200));
  const dbr = await cmd(`DSPDBR FILE(${LIB}/VENTAS)`, false);
  const dbrText = JSON.stringify(dbr);
  check('DSPDBR lista los lógicos', /VENTASL/.test(dbrText) && /VENTJ/.test(dbrText), dbrText.slice(0, 200));

  await api('PUT', `/sources/${LIB}/QDDSSRC/LISTADO?type=PRTF`, { lines: PRTF_DDS });
  const cp = await cmd(`CRTPRTF FILE(${LIB}/LISTADO) SRCFILE(${LIB}/QDDSSRC) PAGESIZE(66 80) OVRFLW(60)`, false);
  check('CRTPRTF', cp.status === 200, JSON.stringify(cp).slice(0, 400));
  await api('PUT', `/sources/${LIB}/QRPGLESRC/LSTLOG?type=RPGLE`, { lines: LSTLOG.split('\n') });
  const cl = await cmd(`CRTBNDRPG PGM(${LIB}/LSTLOG) SRCFILE(${LIB}/QRPGLESRC)`, false);
  check('CRTBNDRPG con lógico y PRTF externos', cl.status === 200, JSON.stringify(cl.messages || cl).slice(0, 600));
  const call5 = await cmd(`CALL PGM(${LIB}/LSTLOG)`, false);
  check('CALL LSTLOG', call5.status === 200, JSON.stringify(call5).slice(0, 300));
  const sp5 = (await lastSpool('LISTADO')) || [];
  console.log(sp5.filter((l) => l.trim()).map((l) => `    |${l}`).join('\n'));
  const det = sp5.filter((l) => /^ (NORT|SUR )/.test(l)).map((l) => l.slice(1, 18).replace(/\s+/g, ' ').trim());
  check('orden del lógico: REGION descendente, IMPORT ascendente, omitidos <= 10', JSON.stringify(det) === JSON.stringify(['SUR HOOLI', 'SUR INITECH', 'NORT GLOBEX', 'NORT ACME']), JSON.stringify(det));
  check('PRTF: EDTCDE(J), indicador 50 y PAGNBR', sp5.some((l) => /INITECH\s+1,000\.00\s+\*ALTO\*/.test(l)) && /LISTADO POR LOGICO.*PAG\s+1/.test(sp5[0] || ''));
  check('PRTF: total con SPACEB', sp5.some((l) => /^ TOTAL\s+1,215\.00/.test(l)));

  // SQL incrustado de varias filas sobre Db2 real: FETCH FOR n ROWS en una DS de múltiples apariciones e INSERT n ROWS
  const MULTI = `**FREE
ctl-opt dftactgrp(*no);
dcl-f QSYSPRT printer(132);
dcl-ds fila occurs(3) qualified;
  region char(4);
  cliente char(10);
  importe packed(9:2);
end-ds;
dcl-ds nuevos qualified dim(2);
  region char(4);
  cliente char(10);
  importe packed(9:2);
end-ds;
dcl-s linea char(132);
dcl-s i int(10);
dcl-s leidas int(10);
exec sql set option commit = *none;
exec sql declare c cursor for select region, client, import from ventas order by client;
exec sql open c;
dou sqlcode <> 0 or sqlerrd(5) = 100;
  exec sql fetch c for 3 rows into :fila;
  if sqlcode <> 0;
    leave;
  endif;
  for i = 1 to sqlerrd(3);
    %occur(fila) = i;
    linea = 'FILA ' + fila.cliente + ' ' + %char(fila.importe);
    write QSYSPRT linea;
    leidas += 1;
  endfor;
enddo;
exec sql close c;
nuevos(1).region = 'ESTE'; nuevos(1).cliente = 'UMBRELLA'; nuevos(1).importe = 77.70;
nuevos(2).region = 'ESTE'; nuevos(2).cliente = 'WAYNE'; nuevos(2).importe = 88.80;
exec sql insert into ventas 2 rows values(:nuevos);
linea = 'LEIDAS ' + %char(leidas) + ' INSERTADAS ' + %char(sqlerrd(3)) + ' SQLCODE ' + %char(sqlcode);
write QSYSPRT linea;
*inlr = *on;`;
  await api('PUT', `/sources/${LIB}/QRPGLESRC/MULTI?type=SQLRPGLE`, { lines: MULTI.split('\n') });
  const cm = await cmd(`CRTSQLRPGI OBJ(${LIB}/MULTI) SRCFILE(${LIB}/QRPGLESRC) COMMIT(*NONE)`, false);
  check('CRTSQLRPGI con FETCH/INSERT de varias filas', cm.status === 200, JSON.stringify(cm.messages || cm).slice(0, 500));
  const nVentas = await api('POST', '/sql', { sql: `SELECT COUNT(*) AS N FROM ${LIB}.VENTAS` });
  const before = Number(nVentas.data && nVentas.data[0] && nVentas.data[0].N);
  const cmc = await cmd(`CALL PGM(${LIB}/MULTI)`, false);
  check('CALL MULTI', cmc.status === 200, JSON.stringify(cmc).slice(0, 300));
  const spm = (await lastSpool('QSYSPRT')) || [];
  const filas = spm.filter((l) => /^FILA /.test(l.trim()));
  check('FETCH FOR 3 ROWS lee todas las filas en bloques', filas.length === before && before > 3, `${filas.length} de ${before}: ${spm.join(' | ')}`);
  check('INSERT 2 ROWS: SQLERRD(3) = 2', spm.some((l) => new RegExp(`LEIDAS ${before} INSERTADAS 2 SQLCODE 0`).test(l)), spm.join(' | '));
  const ins = await api('POST', '/sql', { sql: `SELECT CLIENT, IMPORT FROM ${LIB}.VENTAS WHERE REGION = 'ESTE' ORDER BY CLIENT` });
  check('las filas insertadas están en Db2', JSON.stringify((ins.data || []).map((r) => ({ ...r, CLIENT: r.CLIENT.trim() }))) === JSON.stringify([{ CLIENT: 'UMBRELLA', IMPORT: 77.7 }, { CLIENT: 'WAYNE', IMPORT: 88.8 }]), JSON.stringify(ins.data || ins));

  if (!failed) { await cmd(`RMVLIBLE LIB(${LIB})`, false); await cmd(`DLTLIB LIB(${LIB})`, false); }
  console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
