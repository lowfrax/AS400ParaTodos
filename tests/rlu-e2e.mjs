// Prueba de RLU (STRRLU) por el terminal 5250: título, registro DETALLE (DR), campos XXXX y 9,999.99 (CF),
// nombres y códigos de edición (DF), prototipo (F6), salida con CRTPRTF y uso del archivo desde RPG.
// Ejecutar: node tests/rlu-e2e.mjs
import { Term } from './client.mjs';

const BASE = process.env.API || 'http://localhost:10010';
const AUTH = { Authorization: `Basic ${Buffer.from('QSECOFR:QSECOFR').toString('base64')}` };
const LIB = 'RLUTEST';
const show = process.env.SHOW === '1';
async function api(method, path, body, raw) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (raw) return t;
  try { const j = JSON.parse(t); return Array.isArray(j) ? { status: r.status, list: j } : { status: r.status, ...j }; } catch { return { status: r.status, text: t }; }
}
const cmd = (c) => api('POST', '/commands', { command: c });
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `\n${extra}` : ''}`); if (!cond) failed++; };
async function lastSpool(name) {
  const r = await api('GET', '/spool');
  const s = (r.list || []).filter((x) => x.NAME === name).sort((a, b) => b.ID - a.ID)[0];
  return s ? api('GET', `/spool/${s.ID}`, undefined, true) : '';
}

await cmd(`DLTLIB LIB(${LIB})`);
await cmd(`CRTLIB LIB(${LIB})`);
await cmd(`CRTSRCPF FILE(${LIB}/QDDSSRC)`);
await cmd(`CRTSRCPF FILE(${LIB}/QRPGLESRC)`);

const t = new Term(process.env.WS || 'ws://localhost:5250/ws');
await t.connect();
await t.waitFor(/Sign On/, 120000);
await t.send('ENTER', { USER: 'QSECOFR', PWD: 'QSECOFR' });
await t.waitFor(/Main Menu/);
const dump = (l) => { if (show) console.log(`---- ${l}\n${t.text()}`); };
try {
  await t.cmd(`STRRLU SRCFILE(${LIB}/QDDSSRC) SRCMBR(LISTADO)`);
  await t.waitFor(/Design Report/);
  check('STRRLU muestra la hoja de diseño con el formato TITULO', /TITULO/.test(t.text()) && /Beginning of data/.test(t.text()), t.text());
  await t.send('ENTER', { L0: '          LISTADO DE CLIENTES', C2: 'DR' });
  await t.waitFor(/Define Record Format/);
  await t.send('ENTER', { N: 'DETALLE' });
  await t.waitFor(/Design Report/);
  check('DR define el registro DETALLE', /DETALLE/.test(t.text()), t.text());
  await t.send('ENTER', { C2: 'CF', L2: '  XXXXXXXXXX   9,999.99' });
  await t.waitFor(/Design Report/);
  dump('cf');
  check('CF convierte XXXX y 9,999.99 en campos', !/overlap|not valid/.test(t.screen.msg || '') && /XXXXXXXXXX   9,999\.99/.test(t.text()), `${t.screen.msg}\n${t.text()}`);
  await t.send('ENTER', { C2: 'DF' });
  await t.waitFor(/Define Field/);
  await t.send('ENTER', { N0: 'NOMBRE', N1: 'SALDO' });
  await t.waitFor(/Design Report/);
  await t.send('F6');
  await t.waitFor(/Prototype/);
  const proto = await lastSpool('LISTADO');
  check('F6: prototipo del informe en spool', /LISTADO DE CLIENTES/.test(proto) && /XXXXXXXXXX\s+9,999\.99/.test(proto), proto);
  await t.send('F3');
  await t.waitFor(/Exit RLU/);
  await t.send('ENTER', { SAVE: 'Y', TEXT: 'Listado de clientes', CRT: 'Y' });
  await t.waitFor(/Main Menu/);
  check('al salir se guarda el fuente y se crea el archivo de impresora', /LISTADO|created/.test(t.screen.msg || ''), t.screen.msg);
  const dds = await api('GET', `/sources/${LIB}/QDDSSRC/LISTADO`, undefined, true);
  if (show) console.log(dds);
  check('DDS: R TITULO SKIPB(1) y constante en la columna 11', /R TITULO\s+SKIPB\(1\)/.test(dds) && /\s11'LISTADO DE CLIENTES'/.test(dds), dds);
  check('DDS: R DETALLE SPACEB(1), NOMBRE 10A y SALDO 6S 2 EDTCDE(J)', /R DETALLE\s+SPACEB\(1\)/.test(dds) && /NOMBRE\s+10A\s+3/.test(dds) && /SALDO\s+6S 2\s+16EDTCDE\(J\)/.test(dds), dds);
  const pf = await api('POST', '/sql', { sql: `SELECT ATTR FROM QSYS.OBJECTS WHERE LIB = '${LIB}' AND NAME = 'LISTADO' AND TYPE = '*FILE'` });
  check('objeto LISTADO *FILE PRTF', (pf.data || [])[0] && pf.data[0].ATTR === 'PRTF', JSON.stringify(pf));
  // Uso desde RPG
  await api('PUT', `/sources/${LIB}/QRPGLESRC/IMPRIME?type=RPGLE`, { lines: ['**FREE', 'dcl-f LISTADO printer;', 'write TITULO;', "NOMBRE = 'ANA';", 'SALDO = 1234.5;', 'write DETALLE;', "NOMBRE = 'LUIS';", 'SALDO = 20;', 'write DETALLE;', '*inlr = *on;'] });
  const c = await cmd(`CRTBNDRPG PGM(${LIB}/IMPRIME) SRCFILE(${LIB}/QRPGLESRC)`);
  check('un programa RPG usa el archivo de impresora diseñado', c.status === 200, JSON.stringify(c).slice(0, 400));
  await cmd(`ADDLIBLE LIB(${LIB})`);
  await cmd(`CALL PGM(${LIB}/IMPRIME)`);
  await cmd(`RMVLIBLE LIB(${LIB})`);
  const out = await lastSpool('LISTADO');
  if (show) console.log(out);
  check('el informe impreso sigue el diseño', /^ {10}LISTADO DE CLIENTES/m.test(out) && /^ {2}ANA\s+1,234\.50/m.test(out) && /^ {2}LUIS\s+20\.00/m.test(out), out);
  // Volver a abrir el diseño
  await t.cmd(`STRRLU SRCFILE(${LIB}/QDDSSRC) SRCMBR(LISTADO)`);
  await t.waitFor(/Design Report/);
  check('al volver a abrir se ven el título y los campos', /LISTADO DE CLIENTES/.test(t.text()) && /XXXXXXXXXX   9,999\.99/.test(t.text()), t.text());
  await t.send('F12');
  await t.waitFor(/Main Menu/);
} catch (e) { failed++; console.log(`FAIL ${e.message}`); }
t.close();
if (!failed) await cmd(`DLTLIB LIB(${LIB})`);
console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
process.exit(failed ? 1 : 0);
