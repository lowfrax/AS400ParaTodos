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
  if (!failed) { await cmd(`RMVLIBLE LIB(${LIB})`, false); await cmd(`DLTLIB LIB(${LIB})`, false); }
  console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
