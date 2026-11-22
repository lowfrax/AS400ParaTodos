// Pruebas unitarias del compilador/intérprete RPG, CL y DDS (sin servicios). Ejecutar: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../shared/gateway.js';
import { compileRpg, CompileError } from '../shared/rpg/parser.js';
import { RpgProgram, RpgError } from '../shared/rpg/interpreter.js';
import { DiskFile } from '../shared/rpg/diskfile.js';
import { compileCL, evalCL, parseCommand } from '../shared/cl.js';
import { parsePF, parseDSPF, pfToSql } from '../shared/dds.js';
import { CUSTOMER_PF, CUSTINQD_DSPF, CUSTSFLD_DSPF, NIGHTLY_CL, FIXED_RPG } from '../services/ibmi-core/src/seed.js';

async function run(src, host = {}) {
  const out = [];
  const ir = compileRpg(Array.isArray(src) ? src : src.split('\n'));
  const p = new RpgProgram(ir, { dsply: async (t) => { out.push(t); return ''; }, ...host });
  await p.call([]);
  return { out, p };
}

test('aritmética empaquetada: trunca decimales y detecta desbordamiento', async () => {
  const { out } = await run(`**FREE
dcl-s a packed(5:2);
dcl-s b packed(3:0);
a = 10 / 3;
dsply %char(a);
eval(h) a = 2 / 3;
dsply %char(a);
monitor;
  b = 1000;
on-error 103;
  dsply 'overflow';
endmon;
*inlr = *on;`);
  assert.deepEqual(out, ['3.33', '.67', 'overflow']);
});

test('cadenas de longitud fija, VARCHAR y BIF', async () => {
  const { out } = await run(`**FREE
dcl-s c char(10) inz('ab');
dcl-s v varchar(20);
v = %trim(c) + '|' + c + '|';
dsply v;
dsply %char(%len(c)) + ' ' + %char(%len(%trim(c)));
dsply %upper(%subst('hola mundo':6:5));
dsply %xlate('abc':'xyz':'aabbcc');
dsply %char(%scan('mu':'hola mundo'));
dsply %scanrpl('o':'0':'foo');
*inlr = *on;`);
  assert.deepEqual(out, ['ab|ab        |', '10 2', 'MUNDO', 'xxyyzz', '6', 'f00']);
});

test('estructuras de datos calificadas, arrays y LIKEDS', async () => {
  const { out } = await run(`**FREE
dcl-ds t qualified template;
  id int(10);
  name varchar(10);
end-ds;
dcl-ds lista likeds(t) dim(3);
dcl-s i int(10);
for i = 1 to %elem(lista);
  lista(i).id = i * 10;
  lista(i).name = 'N' + %char(i);
endfor;
dsply lista(2).name + '=' + %char(lista(2).id);
*inlr = *on;`);
  assert.deepEqual(out, ['N2=20']);
});

test('procedimientos con parámetros por referencia y valor', async () => {
  const { out } = await run(`**FREE
dcl-s n int(10) inz(5);
incr(n);
dsply %char(n) + ' ' + %char(cuadrado(7));
*inlr = *on;
dcl-proc incr;
  dcl-pi *n;
    x int(10);
  end-pi;
  x += 1;
end-proc;
dcl-proc cuadrado;
  dcl-pi *n int(10);
    v int(10) value;
  end-pi;
  return v * v;
end-proc;`);
  assert.deepEqual(out, ['6 49']);
});

test('fechas: %DATE, %DAYS, %DIFF, %CHAR con formato', async () => {
  const { out } = await run(`**FREE
dcl-s d date inz(d'2024-01-31');
dsply %char(d + %months(1));
dsply %char(%diff(d'2024-03-01': d: *days));
dsply %char(d: *eur);
dsply %char(%date(20250704: *iso));
*inlr = *on;`);
  assert.deepEqual(out, ['2024-02-29', '30', '31.01.2024', '2025-07-04']);
});

test('ciclo RPG: sin *INLR los cálculos se repiten hasta RETURN', async () => {
  const { out } = await run(`**FREE
dcl-s n int(10) static;
n += 1;
dsply %char(n);
if n = 3;
  return;
endif;`);
  assert.deepEqual(out, ['1', '2', '3']);
});

test('error no monitorizado lanza RpgError con estado RPG', async () => {
  await assert.rejects(run(`**FREE
dcl-s a int(10);
a = 1 / a;
*inlr = *on;`), (e) => e instanceof RpgError && e.status === '00102');
});

test('RPG en columnas fijas (C-specs)', async () => {
  const { out } = await run(FIXED_RPG);
  assert.deepEqual(out.map((s) => s.trimEnd()), ['Suma 1..10 = 55.00']);
});

test('errores de compilación con número de línea', () => {
  assert.throws(() => compileRpg(['**FREE', "dsply 'sin cerrar;"]), (e) => e instanceof CompileError && e.line === 2);
  assert.throws(() => compileRpg(['**FREE', 'if 1 = 1;', 'dsply 1;']), CompileError);
});

// Se ejecuta contra IBM Db2 a través del DB2 Gateway (docker compose up); se omite si el sistema no está en marcha.
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:5252';
const gwReady = await createGateway(GATEWAY, 'unit-test').health().then((h) => h.status === 'ready').catch(() => false);

test('archivo con clave sobre Db2: SETLL/READ/READE/CHAIN/UPDATE/DELETE', { skip: !gwReady && `DB2 Gateway no disponible en ${GATEWAY}` }, async (t) => {
  const gw = createGateway(GATEWAY, 'unit-test');
  // Restos de una ejecución interrumpida: se borran solo si existen (para no dejar errores en el panel del gateway).
  if ((await gw.tables('QTEMP')).some?.((x) => x.name === 'UTKEYS')) await gw.exec('DROP TABLE QTEMP.UTKEYS');
  await gw.exec('CREATE TABLE QTEMP.UTKEYS (K1 CHAR(1) NOT NULL, K2 INTEGER NOT NULL, V CHAR(2) NOT NULL, PRIMARY KEY (K1, K2))');
  t.after(() => gw.sql('DROP TABLE QTEMP.UTKEYS'));
  for (const r of [['A', 1, 'a1'], ['A', 2, 'a2'], ['B', 1, 'b1'], ['C', 5, 'c5']]) await gw.exec('INSERT INTO QTEMP.UTKEYS VALUES (?, ?, ?)', r);
  const sql = (text, params) => gw.sql(text, params);
  const f = new DiskFile({ name: 'UTKEYS', schema: 'QTEMP', table: 'UTKEYS', fields: [{ name: 'K1', type: { t: 'char', len: 1 } }, { name: 'K2', type: { t: 'int', bits: 32 } }, { name: 'V', type: { t: 'char', len: 2 } }], keys: ['K1', 'K2'], sql });
  assert.equal(await f.setll(['A']), true);
  assert.equal((await f.reade(['A'])).V, 'a1');
  assert.equal((await f.reade(['A'])).V, 'a2');
  assert.equal(await f.reade(['A']), null);
  assert.equal((await f.read()).V, 'b1');
  assert.equal((await f.readp()).V, 'a2');
  const r = await f.chain(['C', 5]);
  assert.equal(r.V, 'c5');
  await f.update({ K1: 'C', K2: 5, V: 'zz' });
  assert.equal((await f.chain(['C', 5])).V, 'zz');
  assert.equal(await f.delete(['B', 1]), true);
  await f.setll('*START');
  const all = [];
  for (let x = await f.read(); x; x = await f.read()) all.push(x.V);
  assert.deepEqual(all, ['a1', 'a2', 'zz']);
});

test('archivo con claves duplicadas y descendentes, y archivo sin clave por orden de llegada (RRN)', { skip: !gwReady && `DB2 Gateway no disponible en ${GATEWAY}` }, async (t) => {
  const gw = createGateway(GATEWAY, 'unit-test');
  if ((await gw.tables('QTEMP')).some?.((x) => x.name === 'UTDUPS')) await gw.exec('DROP TABLE QTEMP.UTDUPS');
  await gw.exec('CREATE TABLE QTEMP.UTDUPS (REG CHAR(4) NOT NULL, IMP DECIMAL(7, 2) NOT NULL, V CHAR(3) NOT NULL)');
  t.after(() => gw.sql('DROP TABLE QTEMP.UTDUPS'));
  // 70 filas con la misma clave (más que el bloque de 64 filas) y filas idénticas
  const rows = [['SUR', 5, 's1'], ['NORT', 1, 'n1'], ['NORT', 3, 'n2'], ['SUR', 9, 's2'], ['NORT', 3, 'n3'], ['DUP', 1, 'dd'], ['DUP', 1, 'dd']];
  for (let i = 0; i < 70; i++) rows.push(['MUCH', i, `m${i}`]);
  for (const r of rows) await gw.exec('INSERT INTO QTEMP.UTDUPS VALUES (?, ?, ?)', r);
  const sql = (text, params) => gw.sql(text, params);
  const fields = [{ name: 'REG', type: { t: 'char', len: 4 } }, { name: 'IMP', type: { t: 'packed', digits: 7, dec: 2 } }, { name: 'V', type: { t: 'char', len: 3 } }];
  const byReg = new DiskFile({ name: 'UTDUPS', schema: 'QTEMP', table: 'UTDUPS', fields, keys: ['REG'], sql });
  // SETLL + READE recorre todas las claves duplicadas (en orden de llegada)
  await byReg.setll(['NORT']);
  const nort = [];
  for (let x = await byReg.reade(['NORT']); x; x = await byReg.reade(['NORT'])) nort.push(x.V.trim());
  assert.deepEqual(nort, ['n1', 'n2', 'n3']);
  await byReg.setll(['MUCH']);
  let n = 0;
  for (let x = await byReg.reade(['MUCH']); x; x = await byReg.reade(['MUCH'])) n++;
  assert.equal(n, 70);
  // Clave descendente por importe
  const desc = new DiskFile({ name: 'UTDUPS', schema: 'QTEMP', table: 'UTDUPS', fields, keys: ['REG', 'IMP'], keyDesc: [false, true], sql });
  await desc.setll(['SUR']);
  const sur = [];
  for (let x = await desc.reade(['SUR']); x; x = await desc.reade(['SUR'])) sur.push(x.V.trim());
  assert.deepEqual(sur, ['s2', 's1']);
  await desc.setll(['NORT']);
  const nd = [];
  for (let x = await desc.reade(['NORT']); x; x = await desc.reade(['NORT'])) nd.push(x.V.trim());
  assert.deepEqual(nd, ['n2', 'n3', 'n1']);
  // Sin clave: orden de llegada; UPDATE/DELETE de filas idénticas afecta a una sola
  const seq = new DiskFile({ name: 'UTDUPS', schema: 'QTEMP', table: 'UTDUPS', fields, keys: [], sql });
  const first = [];
  for (let i = 0; i < 3; i++) first.push((await seq.read()).V.trim());
  assert.deepEqual(first, ['s1', 'n1', 'n2']);
  await byReg.setll(['DUP']);
  const d1 = await byReg.reade(['DUP']);
  await byReg.update({ ...d1, V: 'd1' });
  const cnt = await gw.sql("SELECT V, COUNT(*) AS N FROM QTEMP.UTDUPS WHERE REG = 'DUP' GROUP BY V ORDER BY V");
  assert.deepEqual(cnt.rows.map((r) => `${r[0].trim()}:${r[1]}`), ['d1:1', 'dd:1']);
  const d2 = await byReg.reade(['DUP']);
  assert.equal(d2.V.trim(), 'dd');
  assert.equal(await byReg.delete(), true);
  const left = await gw.sql("SELECT COUNT(*) FROM QTEMP.UTDUPS WHERE REG = 'DUP'");
  assert.equal(Number(left.rows[0][0]), 1);
  // CHAIN por número relativo de registro en un archivo sin clave
  assert.equal((await seq.chain(2)).V.trim(), 'n1');
});

test('CL: análisis de mandatos, expresiones y programa NIGHTLY', () => {
  const c = parseCommand("CRTLIB LIB(MILIB) TEXT('Mi biblioteca')");
  assert.equal(c.name, 'CRTLIB');
  assert.equal(c.params.TEXT, "'Mi biblioteca'");
  const pos = parseCommand('CALL HELLO');
  assert.deepEqual(pos.positional, ['HELLO']);
  const vars = { '&A': { value: 'X  ' }, '&N': { value: 4 } };
  assert.equal(evalCL("'a' *CAT 'b' *BCAT &A *TCAT 'z'", (n) => vars[n]), 'ab Xz');
  assert.equal(evalCL('(&N * 2 + 1) *GT 8 *AND &A *EQ X', (n) => vars[n]), true);
  const ir = compileCL(NIGHTLY_CL.split('\n'));
  assert.equal(ir.dcls.length, 3);
  assert.ok(ir.body.some((n) => n.t === 'dofor'));
  const chk = ir.body.find((n) => n.t === 'cmd' && n.cmd.name === 'CHKOBJ');
  assert.equal(chk.monmsg[0].msgids[0], 'CPF9801');
  assert.ok(chk.monmsg[0].body.length === 1);
});

test('DDS: archivo físico y archivos de pantalla con subarchivo', () => {
  const pf = parsePF(CUSTOMER_PF);
  assert.equal(pf.format, 'CUSTREC');
  assert.deepEqual(pf.keys, ['CUSTNO']);
  assert.equal(pf.unique, true);
  assert.match(pfToSql('DEMOLIB', 'CUSTOMER', pf), /"BALANCE" DECIMAL\(9, 2\)/);
  const d = parseDSPF(CUSTINQD_DSPF);
  assert.deepEqual(Object.keys(d.formats), ['PROMPT', 'DETAIL']);
  assert.equal(d.keys[0].key, 'F3');
  const cust = d.formats.PROMPT.fields.find((f) => f.name === 'CUSTNO');
  assert.equal(cust.usage, 'B');
  assert.equal(cust.errmsg[0].cond[0].ind, '90');
  const s = parseDSPF(CUSTSFLD_DSPF);
  assert.equal(s.formats.CUSTCTL.sflctl, 'CUSTSFL');
  assert.equal(s.formats.CUSTCTL.sflpag, 12);
  assert.equal(s.formats.CUSTCTL.sfldspInd[0].ind, '31');
});
