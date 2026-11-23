// Prueba de Query/400: WRKQRY por el terminal 5250 (unión de dos archivos, selección y orden de campos,
// selección de registros, ordenación, funciones de resumen, corte de control y salida a impresora), RUNQRY a
// archivo de base de datos, RUNQRY *NONE en pantalla y en lote, DLTQRY. Ejecutar: node tests/qry-e2e.mjs
import { Term } from './client.mjs';

const BASE = process.env.API || 'http://localhost:10010';
const AUTH = { Authorization: `Basic ${Buffer.from('QSECOFR:QSECOFR').toString('base64')}` };
const LIB = 'QRYTEST';
const show = process.env.SHOW === '1';
async function api(method, path, body, raw) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (raw) return t;
  try { const j = JSON.parse(t); return Array.isArray(j) ? { status: r.status, list: j } : { status: r.status, ...j }; } catch { return { status: r.status, text: t }; }
}
const cmd = (c) => api('POST', '/commands', { command: c });
const sql = (s) => api('POST', '/sql', { sql: s });
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `\n${extra}` : ''}`); if (!cond) failed++; };
async function lastSpool(name) {
  const r = await api('GET', '/spool');
  const s = (r.list || []).filter((x) => x.NAME === name).sort((a, b) => b.ID - a.ID)[0];
  return s ? api('GET', `/spool/${s.ID}`, undefined, true) : '';
}

await cmd(`DLTLIB LIB(${LIB})`);
await cmd(`CRTLIB LIB(${LIB})`);
await sql(`CREATE TABLE ${LIB}.CLIENTES (ID INT NOT NULL PRIMARY KEY, NOMBRE CHAR(10), REGION CHAR(4))`);
await sql(`INSERT INTO ${LIB}.CLIENTES VALUES (1, 'ANA', 'NORT'), (2, 'LUIS', 'SUR'), (3, 'EVA', 'NORT')`);
await sql(`CREATE TABLE ${LIB}.VENTAS (ID INT NOT NULL, CLIENTE INT, IMPORTE DECIMAL(9, 2))`);
await sql(`INSERT INTO ${LIB}.VENTAS VALUES (1, 1, 100), (2, 1, 30), (3, 2, 200), (4, 3, 80), (5, 3, 70)`);

const q1 = await cmd(`RUNQRY QRY(*NONE) QRYFILE((${LIB}/CLIENTES))`);
const sp1 = await lastSpool('QPQUPRFIL');
check('RUNQRY *NONE en un trabajo no interactivo: informe impreso del archivo', q1.status === 200 && /ANA/.test(sp1) && /LUIS/.test(sp1) && /E N D  O F  R E P O R T/.test(sp1), sp1);

const t = new Term(process.env.WS || 'ws://localhost:5250/ws');
await t.connect();
await t.waitFor(/Sign On/, 120000);
await t.send('ENTER', { USER: 'QSECOFR', PWD: 'QSECOFR' });
await t.waitFor(/Main Menu/);
const dump = (l) => { if (show) console.log(`---- ${l}\n${t.text()}`); };
try {
  await t.cmd('STRQRY');
  await t.waitFor(/Query Utilities/);
  check('STRQRY: menú de utilidades de Query', /Work with queries/.test(t.text()));
  await t.cmd('1');
  await t.waitFor(/Work with Queries/);
  await t.send('ENTER', { OPT: '1', QRY: 'VTASREG', LIB });
  await t.waitFor(/Define the Query/);
  check('Define the Query con sus 11 apartados', /Specify file selections/.test(t.text()) && /Select output type and output form/.test(t.text()) && /Define report breaks/.test(t.text()));
  await t.send('ENTER');
  await t.waitFor(/Specify File Selections/);
  await t.send('F9', { F0: 'VENTAS', L0: LIB });
  await t.waitFor(/Specify File Selections/);
  await t.send('ENTER', { F1: 'CLIENTES', L1: LIB });
  await t.waitFor(/Specify Type of Join/);
  await t.send('ENTER', { T: '1' });
  await t.waitFor(/Specify How to Join Files/);
  await t.send('ENTER', { A0: 'T01.CLIENTE', T0: 'EQ', B0: 'T02.ID' });
  await t.waitFor(/Define the Query/);
  check('los archivos quedan marcados con >', /> {2}Specify file selections/.test(t.text()), t.text());
  await t.send('ENTER', { O2: '1', O3: '1', O4: '1', O7: '1', O8: '1', O9: '1' });
  await t.waitFor(/Select and Sequence Fields/);
  dump('fields');
  await t.send('ENTER', { S_T02_REGION: '10', S_T02_NOMBRE: '20', S_T01_IMPORTE: '30' });
  await t.waitFor(/Select Records/);
  await t.send('ENTER', { F0: 'T01.IMPORTE', T0: 'GT', V0: '50' });
  await t.waitFor(/Select Sort Fields/);
  await t.send('ENTER', { P_T02_REGION: '10', P_T02_NOMBRE: '20' });
  await t.waitFor(/Select Report Summary Functions/);
  await t.send('ENTER', { F0_T01_IMPORTE: '1', F1_T01_IMPORTE: '5' });
  await t.waitFor(/Define Report Breaks/);
  await t.send('ENTER', { B_T02_REGION: '1' });
  await t.waitFor(/Select Output Type and Output Form/);
  await t.send('ENTER', { T: '2', F: '1' });
  await t.waitFor(/Define the Query/);
  await t.send('F5');
  await t.waitFor(/Display Report/);
  dump('report');
  check('F5 muestra el informe en pantalla', /ANA/.test(t.text()) && /LUIS/.test(t.text()) && !/  30\.00/.test(t.text()), t.text());
  await t.send('F3');
  await t.waitFor(/Define the Query/);
  await t.send('F3');
  await t.waitFor(/Exit this Query/);
  await t.send('ENTER', { SAVE: 'Y', RUN: '1', TEXT: 'Ventas por region' });
  await t.waitFor(/Work with Queries/);
  check('al salir se guarda y se ejecuta (salida a impresora)', /saved|printed|QPQUPRFIL/.test(t.screen.msg || ''), t.screen.msg);
  const rpt = await lastSpool('QPQUPRFIL');
  if (show) console.log(rpt);
  const det = rpt.split('\n').filter((l) => /^(NORT|SUR)\s/.test(l)).map((l) => l.replace(/\s+/g, ' ').trim());
  check('detalle: unión, selección IMPORTE > 50 y orden REGION, NOMBRE', JSON.stringify(det) === JSON.stringify(['NORT ANA 100.00', 'NORT EVA 80.00', 'NORT EVA 70.00', 'SUR LUIS 200.00']), `${JSON.stringify(det)}\n${rpt}`);
  check('corte de control por REGION con total y cuenta', /BREAK LEVEL 1\s+REGION NORT/.test(rpt) && /TOTAL\s+250\.00/.test(rpt) && /COUNT\s+3/.test(rpt), rpt);
  check('totales finales', /FINAL TOTALS/.test(rpt) && /TOTAL\s+450\.00/.test(rpt) && /COUNT\s+4/.test(rpt), rpt);
  await t.send('ENTER', { OPT: '5', QRY: 'VTASREG', LIB });
  await t.waitFor(/Display Query/);
  check('opción 5: definición de la consulta', /T01 {2}QRYTEST\/VENTAS/.test(t.text()) && /IMPORTE GT 50/.test(t.text()), t.text());
  await t.send('F3');
  await t.waitFor(/Work with Queries/);
  await t.send('F3');
  await t.waitFor(/Query Utilities/);
  await t.send('F3');
  await t.waitFor(/Main Menu/);
  await t.cmd(`RUNQRY QRY(*NONE) QRYFILE((${LIB}/CLIENTES))`);
  await t.waitFor(/Display Report/);
  check('RUNQRY *NONE interactivo: Display Report', /EVA/.test(t.text()) && /NORT/.test(t.text()), t.text());
  await t.send('F3');
  await t.waitFor(/Main Menu/);
} catch (e) { failed++; console.log(`FAIL ${e.message}`); }
t.close();

const of = await cmd(`RUNQRY QRY(${LIB}/VTASREG) OUTTYPE(*OUTFILE) OUTFILE(${LIB}/RESUMEN)`);
const rs = await sql(`SELECT REGION, NOMBRE, IMPORTE FROM ${LIB}.RESUMEN ORDER BY IMPORTE DESC`);
check('RUNQRY OUTTYPE(*OUTFILE): las filas en un archivo de base de datos', of.status === 200 && (rs.data || []).length === 4 && rs.data[0].IMPORTE === 200, [of, rs]);
const sm = await cmd(`RUNQRY QRY(${LIB}/VTASREG) OUTFORM(*SUMMARY)`);
const sp2 = await lastSpool('QPQUPRFIL');
check('OUTFORM(*SUMMARY): solo los totales', sm.status === 200 && /FINAL TOTALS/.test(sp2) && !/ANA/.test(sp2), sp2);
const dq = await cmd(`DLTQRY QRY(${LIB}/VTASREG)`);
check('DLTQRY', dq.status === 200 && (await cmd(`RUNQRY QRY(${LIB}/VTASREG)`)).status !== 200);
if (!failed) await cmd(`DLTLIB LIB(${LIB})`);
console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
process.exit(failed ? 1 : 0);
