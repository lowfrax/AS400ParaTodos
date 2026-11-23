// Prueba de SDA (STRSDA) por el terminal 5250, como un usuario:
//   1. Diseñar pantallas: alta de registro, imagen con constantes y campos (+3(5), +B(30), &1 desde F10), F4 para
//      nombrar campos, palabras clave de registro, salida con guardado del DDS y CRTDSPF.
//   3. Probar el archivo de pantalla: valores de salida, visualización real, datos de entrada e indicadores.
//   2. Diseñar menús: texto, mandatos, creación de *FILE + *MSGF + *MENU y GO biblioteca/menú.
//   PDM opción 17 sobre el miembro DSPF.
// Ejecutar: node tests/sda-e2e.mjs
import { Term } from './client.mjs';

const BASE = process.env.API || 'http://localhost:10010';
const AUTH = { Authorization: `Basic ${Buffer.from('QSECOFR:QSECOFR').toString('base64')}` };
const LIB = 'SDATEST';
const show = process.env.SHOW === '1';
async function api(method, path, body) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, text: t }; }
}
const cmd = (c) => api('POST', '/commands', { command: c });
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `\n${extra}` : ''}`); if (!cond) failed++; };

await cmd(`DLTLIB LIB(${LIB})`);
await cmd(`CRTLIB LIB(${LIB})`);
await cmd(`CRTSRCPF FILE(${LIB}/QDDSSRC)`);
await api('POST', '/sql', { sql: `CREATE TABLE ${LIB}.CLIENTES (CODIGO DECIMAL(5, 0) NOT NULL, NOMBRE CHAR(30) NOT NULL, SALDO DECIMAL(9, 2) NOT NULL)` });

const t = new Term(process.env.WS || 'ws://localhost:5250/ws');
await t.connect();
await t.waitFor(/Sign On/, 120000);
await t.send('ENTER', { USER: 'QSECOFR', PWD: 'QSECOFR' });
await t.waitFor(/Main Menu/);
await t.cmd(`CHGCURLIB CURLIB(${LIB})`);
await t.cmd(`ADDLIBLE LIB(${LIB})`);
const dump = (l) => { if (show) console.log(`---- ${l}\n${t.text()}`); };

try {
  // ---------- 1. Diseñar pantallas ----------
  await t.cmd('STRSDA');
  await t.waitFor(/Screen Design Aid \(SDA\)/);
  check('STRSDA muestra el menú de SDA', /1\. Design screens/.test(t.text()) && /3\. Test display files/.test(t.text()));
  await t.cmd('1');
  await t.waitFor(/Design Screens/);
  await t.send('ENTER', { FILE: 'QDDSSRC', LIB, MBR: 'PANTA' });
  await t.waitFor(/Work with Display Records/);
  await t.send('ENTER', { AOPT: '1', AREC: 'FMT01', ATYPE: 'RECORD' });
  await t.waitFor(/Work screen for record FMT01/);
  check('alta de registro abre la imagen de diseño', !!t.screen.fields.find((f) => f.n === 'L0'));
  // F10: campos de la base de datos
  await t.send('F10');
  await t.waitFor(/Select Database Files/);
  await t.send('ENTER', { V: `${LIB}/CLIENTES` });
  await t.waitFor(/Select Database Fields/);
  dump('dbfields');
  const sFld = t.screen.fields.filter((f) => /^O\d+$/.test(f.n))[2];
  await t.send('ENTER', { [sFld.n]: '1' });
  await t.waitFor(/&1=SALDO/);
  check('F10 deja el campo SALDO listo para colocar con &1', true);
  await t.send('ENTER', {
    L0: "PANTA01                    'Alta de clientes'",
    L2: 'Codigo  . . . :  +3(5)',
    L3: 'Nombre  . . . :  +B(30)',
    L4: 'Saldo . . . . :  &1',
    L22: 'F3=Salir',
  });
  dump('imagen');
  check('la imagen se interpreta sin errores', !/overlaps|not valid|missing/i.test(t.screen.msg || ''), t.text());
  check('los campos se ven como 3333 / BBBB / 6666', /Codigo  \. \. \. :   33333/.test(t.text()) && /BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/.test(t.text()) && /666666666/.test(t.text()), t.text());
  // F4: nombrar los campos
  await t.send('F4');
  await t.waitFor(/Work with Fields/);
  dump('campos');
  const names = t.screen.fields.filter((f) => /^N\d+$/.test(f.n));
  check('Work with Fields lista FLD001, FLD002 y SALDO', names.map((f) => f.v).join(',') === 'FLD001,FLD002,SALDO', names.map((f) => f.v).join(','));
  await t.send('ENTER', { [names[0].n]: 'CODIGO', [names[1].n]: 'NOMBRE' });
  await t.waitFor(/Fields of record FMT01 updated/);
  // F14: palabras clave del registro
  await t.send('F14');
  await t.waitFor(/Select Record Keywords/);
  await t.send('ENTER', { K0: "CA03(03 'Salir')" });
  await t.waitFor(/Work screen|PANTA01/);
  // Atributo: H delante de la constante del título (posición del atributo)
  const l0 = t.screen.fields.find((f) => f.n === 'L0').v;
  const at = l0.indexOf('Alta de clientes');
  await t.send('ENTER', { L0: `${l0.slice(0, at - 1)}H${l0.slice(at)}` });
  await t.send('F3');
  await t.waitFor(/Work with Display Records/);
  check('el registro aparece en la lista', /FMT01\s+RECORD/.test(t.text()), t.text());
  await t.send('F3');
  await t.waitFor(/Exit SDA Work Screen/);
  await t.send('ENTER', { BATCH: 'N', TEXT: 'Alta de clientes' });
  await t.waitFor(/Design Screens/);
  dump('tras guardar');
  check('al salir se crea el archivo de pantalla', /PANTA/.test(t.screen.msg || '') && !/not created|error/i.test(t.screen.msg || ''), t.screen.msg);
  const src = await api('GET', `/sources/${LIB}/QDDSSRC/PANTA`);
  const dds = src.text || (src.lines || []).map((l) => (typeof l === 'string' ? l : l.text)).join('\n');
  if (show) console.log(dds);
  check('DDS: registro con CA03', /R FMT01\s+CA03\(03 'Salir'\)/.test(dds), dds);
  check('DDS: CODIGO 5Y 0I, NOMBRE 30 B, SALDO por referencia de salida', /CODIGO\s+5Y 0I  3 20/.test(dds) && /NOMBRE\s+30\s+B  4 20/.test(dds) && /SALDO\s+R\s+O  5 20/.test(dds), dds);
  check('DDS: REF al archivo de base de datos y DSPATR(HI) en el título', new RegExp(`REF\\(${LIB}/CLIENTES\\)`).test(dds) && /'Alta de clientes'\n\s+A\s+DSPATR\(HI\)/.test(dds), dds);
  const fo = await api('POST', '/sql', { sql: `SELECT ATTR FROM QSYS.OBJECTS WHERE LIB = '${LIB}' AND NAME = 'PANTA' AND TYPE = '*FILE'` });
  check('objeto PANTA *FILE DSPF', (fo.data || [])[0] && fo.data[0].ATTR === 'DSPF', JSON.stringify(fo));
  await t.send('F3');
  await t.waitFor(/Screen Design Aid \(SDA\)/);

  // ---------- 3. Probar el archivo de pantalla ----------
  await t.cmd('3');
  await t.waitFor(/Test Display File/);
  await t.send('ENTER', { FILE: 'PANTA', LIB, REC: 'FMT01' });
  await t.waitFor(/Set Test Output Data/);
  const vals = t.screen.fields.filter((f) => /^V\d+$/.test(f.n));
  await t.send('ENTER', { [vals[0].n]: 'ACME SA', [vals[1].n]: '1234.5' });
  await t.waitFor(/Alta de clientes/);
  dump('prueba');
  check('el registro se visualiza con los valores de prueba', /ACME SA/.test(t.text()) && /123450|1234[.,]50/.test(t.text()), t.text());
  await t.send('F3', { CODIGO: '42' });
  await t.waitFor(/Display Test Input Data/);
  dump('entrada');
  check('datos devueltos: tecla F3, indicador 03 y CODIGO 42', /Key pressed[ .:]+F3/.test(t.text()) && /Indicators on[ .:]+03/.test(t.text()) && /CODIGO\s+I\s+5\s+42/.test(t.text()), t.text());
  await t.send('F3');
  await t.waitFor(/Screen Design Aid \(SDA\)/);

  // ---------- 2. Diseñar menús ----------
  await t.cmd('2');
  await t.waitFor(/Design Menus/);
  await t.send('ENTER', { MENU: 'MIMENU', LIB, FILE: 'QDDSSRC' });
  await t.waitFor(/Define Menu/);
  await t.send('ENTER', { TEXT: 'Y', CMDS: 'Y' });
  await t.waitFor(/Type the menu text/);
  await t.send('F3', {
    L0: "MIMENU                     'Menu de ventas'",
    L4: "     '1. Mostrar la lista de bibliotecas'",
    L5: "     '2. Enviar un mensaje'",
    L6: '',
    L7: '',
  });
  await t.waitFor(/Define Menu Commands/);
  await t.send('ENTER', { C1: 'DSPLIBL', C2: "SNDMSG MSG('Hola desde el menu') TOUSR(QSECOFR)" });
  await t.waitFor(/Exit SDA Menus/);
  await t.send('ENTER', { SAVE: 'Y', CRT: 'Y' });
  await t.waitFor(/Design Menus/);
  check('se crean los objetos del menú', /Menu MIMENU created/.test(t.screen.msg || ''), t.screen.msg);
  await t.send('F3');
  await t.waitFor(/Screen Design Aid/);
  await t.send('F3');
  await t.waitFor(/Main Menu/);
  await t.cmd(`GO ${LIB}/MIMENU`);
  await t.waitFor(/Menu de ventas/);
  dump('menu');
  check('GO muestra el menú de usuario con línea de mandatos', /Mostrar la lista de bibliotecas/.test(t.text()) && /Selection or command/.test(t.text()) && !/Option 3/.test(t.text()), t.text());
  await t.cmd('1');
  await t.waitFor(/Display Library List/);
  check('la opción 1 ejecuta su mandato (USR0001 de MIMENUQQ)', /SDATEST/.test(t.text()));
  await t.send('F3');
  await t.waitFor(/Menu de ventas/);
  await t.cmd('2');
  await t.waitFor(/Menu de ventas/);
  check('la opción 2 envía el mensaje', !/not valid/.test(t.screen.msg || ''), t.screen.msg);
  await t.cmd('7');
  check('opción sin mandato: CPD6A01', /Selection 7 not valid|7/.test(t.screen.msg || ''), t.screen.msg);
  await t.send('F3');
  await t.waitFor(/Main Menu/);
  const mo = await api('POST', '/sql', { sql: `SELECT TYPE FROM QSYS.OBJECTS WHERE LIB = '${LIB}' AND NAME IN ('MIMENU', 'MIMENUQQ') ORDER BY TYPE` });
  check('objetos *FILE, *MENU y *MSGF', (mo.data || []).map((x) => x.TYPE).join(',') === '*FILE,*MENU,*MSGF', JSON.stringify(mo.data));
  const mm = await api('GET', `/sources/${LIB}/QDDSSRC/MIMENUQQ`);
  check('miembro MNUCMD con los mandatos', /01\s+DSPLIBL/.test(JSON.stringify(mm)), JSON.stringify(mm).slice(0, 300));

  // ---------- PDM opción 17 ----------
  await t.cmd(`WRKMBRPDM FILE(${LIB}/QDDSSRC)`);
  await t.waitFor(/Work with Members Using PDM/);
  const row = t.screen.fields.filter((f) => /^OPT\d+$/.test(f.n));
  const idx = t.text().split('\n').findIndex((l) => /PANTA\s+DSPF/.test(l));
  const optF = row.find((f) => f.r === idx + 1);
  await t.send('ENTER', { [optF.n]: '17' });
  await t.waitFor(/Work with Display Records/);
  check('PDM 17 abre SDA sobre el miembro', /FMT01/.test(t.text()) && /PANTA/.test(t.text()));
  await t.send('F12');
  await t.waitFor(/Work with Members Using PDM/);
  await t.send('F3');
} catch (e) {
  failed++;
  console.log(`FAIL ${e.message}`);
}
t.close();
if (!failed) await cmd(`DLTLIB LIB(${LIB})`);
console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
process.exit(failed ? 1 : 0);
