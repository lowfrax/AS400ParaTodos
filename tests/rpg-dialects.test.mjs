// Pruebas de los dialectos de RPG en columnas fijas (RPG II / RPG III / RPG/400 / RPG IV) y del ciclo RPG.
// No requieren servicios: los archivos de disco y la impresora se simulan en memoria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRpg, detectDialect } from '../shared/rpg/parser.js';
import { RpgProgram } from '../shared/rpg/interpreter.js';
import { editWord } from '../shared/rpg/cycle.js';
import { cvtrpgsrc } from '../shared/rpg/cvtrpgsrc.js';

// Construye una línea fuente colocando cada texto en su columna (base 1)
function L(spec, cols = {}) {
  let s = '     ' + spec;
  for (const [pos, text] of Object.entries(cols).sort((a, b) => a[0] - b[0])) {
    const p = Number(pos) - 1;
    s = s.padEnd(p) + text;
  }
  return s;
}

function memFile(fields, rows) {
  const out = [];
  return {
    desc: { schema: 'QTEMP', table: 'X', format: 'X', fields, keys: [] },
    out,
    open() {
      let i = -1;
      return {
        cur: null,
        async read() { i++; this.cur = rows[i] || null; return this.cur; },
        async write(r) { out.push({ ...r }); },
        async update(r) { out.push({ upd: r }); },
        async delete() { out.push({ del: true }); },
        close() {},
      };
    },
  };
}

async function runOnce(lines, files, dialect) {
  const spool = [];
  const msgs = [];
  const ir = compileRpg(lines, { name: 'T', dialect });
  const host = {
    describeFile: async (n) => files[n].desc,
    openDisk: (desc) => Object.values(files).find((f) => f.desc === desc).open(),
    openPrinter: () => ({ write: (l) => spool.push(l), close: async () => {} }),
    dsply: async (t) => { msgs.push(t); return ''; },
  };
  const p = new RpgProgram(ir, host);
  await p.call([]);
  return { spool, msgs, p, ir };
}

// Ejecuta el fuente; si es RPG III, además lo convierte con CVTRPGSRC y comprueba que el RPG IV resultante se comporta igual.
async function runSrc(lines, { files = {}, dialect } = {}) {
  const r = await runOnce(lines, files, dialect);
  if (!dialect && detectDialect(lines) === 'RPG3') {
    const conv = cvtrpgsrc(lines).lines;
    if (process.env.SHOW_CVT) console.log(conv.join('\n'));
    const r4 = await runOnce(conv, files, 'RPG4');
    assert.deepEqual(r4.msgs, r.msgs, 'CVTRPGSRC: DSPLY distintos');
    assert.deepEqual(r4.spool, r.spool, 'CVTRPGSRC: salida impresa distinta');
  }
  return r;
}

const Z = (d, dec = 0) => ({ t: 'zoned', digits: d, dec });
const C = (n) => ({ t: 'char', len: n });

test('detección de dialecto RPG III frente a RPG IV', () => {
  assert.equal(detectDialect([L('C', { 18: 'A', 28: 'ADD', 33: 'B', 43: 'C' })]), 'RPG3');
  assert.equal(detectDialect([L('C', { 12: 'A', 26: 'ADD', 36: 'B', 50: 'C' })]), 'RPG4');
  assert.equal(detectDialect(['**FREE', 'dsply x;']), 'RPG4');
});

test('palabras de edición', () => {
  assert.equal(editWord(1234.5, '   ,  0.  ', 2), '  1,234.50');
  assert.equal(editWord(-5.25, '   ,  0.  CR', 2), '      5.25CR');
  assert.equal(editWord(0, '   ,   ', 0), '       ');
  assert.equal(editWord(42, '0   ', 0), ' 042');
});

test('RPG III: ciclo con archivo primario, ruptura L1, CTDATA y O-specs con PAGE y códigos de edición', async () => {
  const sales = memFile([
    { name: 'REGION', type: C(4) }, { name: 'VEND', type: C(4) }, { name: 'IMPORT', type: Z(7, 2) }, { name: 'MESNUM', type: Z(2) },
  ], [
    { REGION: 'NORT', VEND: 'V001', IMPORT: 100.5, MESNUM: 1 },
    { REGION: 'NORT', VEND: 'V002', IMPORT: 200, MESNUM: 2 },
    { REGION: 'SUR ', VEND: 'V003', IMPORT: 1000.25, MESNUM: 12 },
  ]);
  const src = [
    L('H'),
    L('F', { 7: 'SALES', 15: 'IP', 19: 'F', 24: '  17', 40: 'DISK' }),
    L('F', { 7: 'QPRINT', 15: 'O', 19: 'F', 24: ' 132', 33: 'OF', 40: 'PRINTER' }),
    L('L', { 7: 'QPRINT', 15: '020', 18: 'FL', 20: '018', 23: 'OL' }),
    L('E', { 27: 'MES', 33: '  6', 36: '  12', 40: '  3' }),
    L('I', { 7: 'SALES', 15: 'AA', 19: '01' }),
    L('I', { 44: '   1', 48: '   4', 53: 'REGION', 59: 'L1' }),
    L('I', { 44: '   5', 48: '   8', 53: 'VEND' }),
    L('I', { 44: '   9', 48: '  15', 52: '2', 53: 'IMPORT' }),
    L('I', { 44: '  16', 48: '  17', 52: '0', 53: 'MESNUM' }),
    L('C', { 9: '01', 18: 'IMPORT', 28: 'ADD', 33: 'TOTREG', 43: 'TOTREG', 49: '  9', 52: '2' }),
    L('C', { 9: '01', 28: 'MOVE', 33: 'MES,MESNUM', 43: 'NOMMES', 49: '  3' }),
    L('C', { 7: 'L1', 18: 'TOTREG', 28: 'ADD', 33: 'TOTGEN', 43: 'TOTGEN', 49: '  9', 52: '2' }),
    L('O', { 7: 'QPRINT', 15: 'H', 18: '2', 19: '01', 23: '1P' }),
    L('O', { 14: 'OR', 23: 'OF' }),
    L('O', { 40: '  25', 45: "'REPORTE DE VENTAS'" }),
    L('O', { 32: 'PAGE', 38: 'Z', 40: '  40' }),
    L('O', { 7: 'QPRINT', 15: 'D', 18: '1', 23: '01' }),
    L('O', { 32: 'REGION', 40: '   6' }),
    L('O', { 32: 'VEND', 40: '  12' }),
    L('O', { 32: 'NOMMES', 40: '  18' }),
    L('O', { 32: 'IMPORT', 38: '1', 40: '  32' }),
    L('O', { 7: 'QPRINT', 15: 'T', 18: '2', 23: 'L1' }),
    L('O', { 40: '  15', 45: "'TOTAL REGION'" }),
    L('O', { 32: 'REGION', 40: '  20' }),
    L('O', { 32: 'TOTREG', 38: '1', 39: 'B', 40: '  32' }),
    L('O', { 7: 'QPRINT', 15: 'T', 18: '1', 23: 'LR' }),
    L('O', { 40: '  15', 45: "'TOTAL GENERAL'" }),
    L('O', { 32: 'TOTGEN', 38: 'J', 40: '  33' }),
    '**',
    'ENEFEBMARABRMAYJUN',
    'JULAGOSEPOCTNOVDIC',
  ];
  const { spool } = await runSrc(src, { files: { SALES: sales } });
  if (process.env.SHOW) console.log(spool.map((l) => `|${l}|`).join('\n'));
  const text = spool.map((l) => l.replace(/\s+$/, ''));
  const nonEmpty = text.filter(Boolean);
  assert.deepEqual(nonEmpty, [
    '        REPORTE DE VENTAS              1',
    '  NORT  V001   ENE        100.50',
    '  NORT  V002   FEB        200.00',
    '   TOTAL REGION NORT      300.50',
    '  SUR   V003   DIC      1,000.25',
    '   TOTAL REGION SUR     1,000.25',
    '  TOTAL GENERAL         1,300.75',
  ]);
  // La cabecera se imprime en la línea 1 tras saltar (skip before 01) y deja una línea en blanco (space after 2)
  assert.equal(text[0].trim(), 'REPORTE DE VENTAS              1');
  assert.equal(text[1], '');
});

test('RPG III: operaciones clásicas (MOVEL, MOVEA, Z-ADD, MULT/DIV/MVR, CABxx/TAG/GOTO, DO, LOOKUP, CAT, SCAN)', async () => {
  const src = [
    L('E', { 27: 'ARR', 36: '   5', 40: '  1' }),
    L('E', { 27: 'TABCOD', 33: '  3', 36: '   3', 40: '  2', 46: 'TABDES', 52: ' 10' }),
    L('C', { 28: 'Z-ADD', 33: '17', 43: 'A', 49: '  5', 52: '0' }),
    L('C', { 18: 'A', 28: 'DIV', 33: '5', 43: 'Q', 49: '  5', 52: '0' }),
    L('C', { 28: 'MVR', 43: 'R', 49: '  5', 52: '0' }),
    L('C', { 18: 'Q', 28: 'MULT', 33: '10', 43: 'M', 49: '  5', 52: '0' }),
    L('C', { 28: 'MOVEL', 33: "'HOLA'", 43: 'S', 49: ' 10' }),
    L('C', { 28: 'MOVEA', 33: "'ABCDE'", 43: 'ARR' }),
    L('C', { 28: 'Z-ADD', 33: '0', 43: 'N', 49: '  3', 52: '0' }),
    L('C', { 18: 'LOOP', 28: 'TAG' }),
    L('C', { 28: 'ADD', 33: '1', 43: 'N' }),
    L('C', { 18: 'N', 28: 'CABLT', 33: '3', 43: 'LOOP' }),
    L('C', { 28: 'Z-ADD', 33: '0', 43: 'SUMA', 49: '  5', 52: '0' }),
    L('C', { 18: '1', 28: 'DO', 33: '4', 43: 'I', 49: '  3', 52: '0' }),
    L('C', { 28: 'ADD', 33: 'I', 43: 'SUMA' }),
    L('C', { 28: 'END' }),
    L('C', { 18: "'02'", 28: 'LOOKU', 33: 'TABCOD', 43: 'TABDES', 58: '50' }),
    L('C', { 18: 'S', 28: 'CAT', 33: "'MUNDO':1", 43: 'S2', 49: ' 20' }),
    L('C', { 18: "'MUN'", 28: 'SCAN', 33: 'S2', 43: 'P', 49: '  3', 52: '0' }),
    L('C', { 28: 'EXSR', 33: 'MOSTRA' }),
    L('C', { 28: 'SETON', 54: 'LR' }),
    L('C', { 7: 'SR', 18: 'MOSTRA', 28: 'BEGSR' }),
    L('C', { 18: 'A', 28: 'DSPLY' }),
    L('C', { 18: 'Q', 28: 'DSPLY' }),
    L('C', { 18: 'R', 28: 'DSPLY' }),
    L('C', { 18: 'M', 28: 'DSPLY' }),
    L('C', { 18: 'S', 28: 'DSPLY' }),
    L('C', { 18: 'ARR,3', 28: 'DSPLY' }),
    L('C', { 18: 'N', 28: 'DSPLY' }),
    L('C', { 18: 'SUMA', 28: 'DSPLY' }),
    L('C', { 9: '50', 18: 'TABDES', 28: 'DSPLY' }),
    L('C', { 18: 'S2', 28: 'DSPLY' }),
    L('C', { 18: 'P', 28: 'DSPLY' }),
    L('C', { 28: 'ENDSR' }),
    '**',
    '01UNO       02DOS       03TRES      ',
  ];
  const { msgs } = await runSrc(src);
  assert.deepEqual(msgs.map((m) => m.trim()), ['17', '3', '2', '30', 'HOLA', 'C', '3', '10', 'DOS', 'HOLA MUNDO', '6']);
});

test('RPG III: indicadores de resultado en COMP/ADD/SUB y condicionamiento con AN/OR', async () => {
  const src = [
    L('C', { 28: 'Z-ADD', 33: '5', 43: 'X', 49: '  3', 52: '0' }),
    L('C', { 18: 'X', 28: 'COMP', 33: '3', 54: '10', 56: '20', 58: '30' }),
    L('C', { 28: 'SUB', 33: '5', 43: 'X', 58: '40' }),
    L('C', { 9: '10', 18: "'MAYOR'", 28: 'DSPLY' }),
    L('C', { 9: '20', 18: "'MENOR'", 28: 'DSPLY' }),
    L('C', { 9: '10', 12: '40', 18: "'AMBOS'", 28: 'DSPLY' }),
    L('C', { 9: 'N30', 18: "'NOIGUAL'", 28: 'DSPLY' }),
    L('C', { 9: '20' }),
    L('C', { 7: 'OR', 9: '40', 18: "'OR'", 28: 'DSPLY' }),
    L('C', { 28: 'SETON', 54: 'LR' }),
  ];
  const { msgs } = await runSrc(src);
  assert.deepEqual(msgs.map((m) => m.trim()), ['MAYOR', 'AMBOS', 'NOIGUAL', 'OR']);
});

test('RPG III: EXCPT con nombre hacia impresora y desbordamiento (OF)', async () => {
  const src = [
    L('F', { 7: 'QPRINT', 15: 'O', 19: 'F', 24: ' 132', 33: 'OF', 40: 'PRINTER' }),
    L('L', { 7: 'QPRINT', 15: '010', 18: 'FL', 20: '006', 23: 'OL' }),
    L('C', { 28: 'EXCPT', 33: 'CAB' }),
    L('C', { 18: '1', 28: 'DO', 33: '8', 43: 'I', 49: '  3', 52: '0' }),
    L('C', { 9: 'OF', 28: 'EXCPT', 33: 'CAB' }),
    L('C', { 9: 'OF', 28: 'SETOF', 54: 'OF' }),
    L('C', { 28: 'EXCPT', 33: 'DET' }),
    L('C', { 28: 'END' }),
    L('C', { 28: 'SETON', 54: 'LR' }),
    L('O', { 7: 'QPRINT', 15: 'E', 18: '1', 19: '01', 32: 'CAB' }),
    L('O', { 40: '  10', 45: "'CABECERA'" }),
    L('O', { 7: 'QPRINT', 15: 'E', 18: '1', 32: 'DET' }),
    L('O', { 32: 'I', 38: 'Z', 40: '   5' }),
  ];
  const { spool } = await runSrc(src);
  // Páginas de 10 líneas: la cabecera vuelve a salir al superar la línea de desbordamiento 6
  const pages = [];
  for (let i = 0; i < spool.length; i += 10) pages.push(spool.slice(i, i + 10).map((x) => x.trim()).filter(Boolean));
  assert.deepEqual(pages[0], ['CABECERA', '1', '2', '3', '4', '5']);
  assert.deepEqual(pages[1], ['CABECERA', '6', '7', '8']);
});

test('RPG IV en columnas fijas: I/O-specs, EXCEPT, *ENTRY PLIST y factor 2 ampliado continuado', async () => {
  const src = [
    L('F', { 7: 'QPRINT', 17: 'O', 22: 'F', 23: '  132', 36: 'PRINTER', 44: 'OFLIND(*INOF)' }),
    L('D', { 7: 'TOTAL', 24: 'S', 33: '      9', 41: ' 2', 44: 'INZ(12.5)' }),
    L('D', { 7: 'NOMBRE', 24: 'S', 33: '     20', 44: "INZ('Prueba')" }),
    L('C', { 26: 'EVAL', 36: 'TOTAL = TOTAL +' }),
    L('C', { 36: '        7.25' }),
    L('C', { 26: 'EXCEPT', 36: 'LINEA' }),
    L('C', { 26: 'EVAL', 36: '*INLR = *ON' }),
    L('O', { 7: 'QPRINT', 17: 'E', 30: 'LINEA', 43: '  1' }),
    L('O', { 30: 'NOMBRE', 47: '   20' }),
    L('O', { 30: 'TOTAL', 44: '1', 47: '   35' }),
    L('O', { 53: "'FIN'", 47: '   40' }),
  ];
  const { spool } = await runSrc(src);
  assert.deepEqual(spool.filter((x) => x.trim()), ['Prueba' + ' '.repeat(24) + '19.75' + '  FIN']);
});

test('RPG III: registros coincidentes (M1/MR) entre archivo primario y secundario', async () => {
  const maestro = memFile([{ name: 'ID', type: C(3) }, { name: 'NOMBRE', type: C(10) }], [
    { ID: '001', NOMBRE: 'A' }, { ID: '002', NOMBRE: 'B' }, { ID: '004', NOMBRE: 'D' },
  ]);
  const movs = memFile([{ name: 'ID', type: C(3) }, { name: 'IMPORTE', type: Z(5, 2) }], [
    { ID: '001', IMPORTE: 10 }, { ID: '001', IMPORTE: 5 }, { ID: '003', IMPORTE: 7 }, { ID: '004', IMPORTE: 1 },
  ]);
  const src = [
    L('F', { 7: 'MAESTRO', 15: 'IP', 19: 'F', 24: '  13', 40: 'DISK' }),
    L('F', { 7: 'MOVS', 15: 'IS', 19: 'F', 24: '   8', 40: 'DISK' }),
    L('I', { 7: 'MAESTRO', 15: 'AA', 19: '01' }),
    L('I', { 44: '   1', 48: '   3', 53: 'ID', 61: 'M1' }),
    L('I', { 7: 'MOVS', 15: 'BB', 19: '02' }),
    L('I', { 44: '   1', 48: '   3', 53: 'ID', 61: 'M1' }),
    L('I', { 44: '   4', 48: '   8', 52: '2', 53: 'IMP' }),
    L('C', { 9: '01', 18: "'M'", 28: 'CAT', 33: 'ID:0', 43: 'MSG', 49: '  6' }),
    L('C', { 9: '02', 18: "'S'", 28: 'CAT', 33: 'ID:0', 43: 'MSG' }),
    L('C', { 9: 'MR', 18: 'MSG', 28: 'CAT', 33: "'*':0", 43: 'MSG' }),
    L('C', { 18: 'MSG', 28: 'DSPLY' }),
    L('C', { 9: '02', 18: 'IMP', 28: 'ADD', 33: 'TOT', 43: 'TOT', 49: '  7', 52: '2' }),
    L('C', { 7: 'LR', 18: 'TOT', 28: 'DSPLY' }),
  ];
  const { msgs, ir } = await runSrc(src, { files: { MAESTRO: maestro, MOVS: movs } });
  if (process.env.SHOW) console.log(JSON.stringify(ir.main, null, 0).slice(0, 3000));
  assert.deepEqual(msgs.map((m) => m.trim()), ['M001*', 'S001*', 'S001*', 'M002', 'S003', 'M004*', 'S004*', '23.00']);
});

test('RPG III: IFxx/ELSE/END, DOWxx, CASxx, SELEC/WHxx/OTHER y MOVEL sin relleno', async () => {
  const src = [
    L('C', { 28: 'Z-ADD', 33: '5', 43: 'X', 49: '  3', 52: '0' }),
    L('C', { 18: 'X', 28: 'IFGT', 33: '3' }),
    L('C', { 28: 'MOVEL', 33: "'GRANDE'", 43: 'T', 49: '  8' }),
    L('C', { 28: 'ELSE' }),
    L('C', { 28: 'MOVEL', 33: "'CHICO'", 43: 'T' }),
    L('C', { 28: 'END' }),
    L('C', { 28: 'Z-ADD', 33: '1', 43: 'X' }),
    L('C', { 18: 'X', 28: 'IFGT', 33: '3' }),
    L('C', { 28: 'MOVEL', 33: "'GRANDE'", 43: 'T' }),
    L('C', { 28: 'ELSE' }),
    L('C', { 28: 'MOVEL', 33: "'CHICO'", 43: 'T' }),
    L('C', { 28: 'END' }),
    L('C', { 18: 'T', 28: 'DSPLY' }),
    L('C', { 18: 'X', 28: 'DOWLT', 33: '4' }),
    L('C', { 28: 'ADD', 33: '1', 43: 'X' }),
    L('C', { 18: 'X', 28: 'CASEQ', 33: '2', 43: 'SR2' }),
    L('C', { 18: 'X', 28: 'CASEQ', 33: '3', 43: 'SR3' }),
    L('C', { 28: 'CAS', 43: 'SROTRO' }),
    L('C', { 28: 'END' }),
    L('C', { 28: 'END' }),
    L('C', { 28: 'SELEC' }),
    L('C', { 18: 'X', 28: 'WHEQ', 33: '9' }),
    L('C', { 18: "'NUEVE'", 28: 'DSPLY' }),
    L('C', { 18: 'X', 28: 'WHEQ', 33: '4' }),
    L('C', { 18: "'CUATRO'", 28: 'DSPLY' }),
    L('C', { 28: 'OTHER' }),
    L('C', { 18: "'OTRO'", 28: 'DSPLY' }),
    L('C', { 28: 'ENDSL' }),
    L('C', { 28: 'MOVE', 33: '1', 43: '*INLR' }),
    L('C', { 18: 'SR2', 28: 'BEGSR' }),
    L('C', { 18: "'DOS'", 28: 'DSPLY' }),
    L('C', { 28: 'ENDSR' }),
    L('C', { 18: 'SR3', 28: 'BEGSR' }),
    L('C', { 18: "'TRES'", 28: 'DSPLY' }),
    L('C', { 28: 'ENDSR' }),
    L('C', { 18: 'SROTRO', 28: 'BEGSR' }),
    L('C', { 18: "'OTRO'", 28: 'DSPLY' }),
    L('C', { 28: 'ENDSR' }),
  ];
  const { msgs } = await runSrc(src);
  assert.deepEqual(msgs.map((m) => m.trim()), ['CHICOE', 'DOS', 'TRES', 'OTRO', 'CUATRO']);
});

test('estructuras de datos como en IBM i: OVERLAY/POS/*NEXT, zona de signo, empaquetado, arrays solapados y error decimal', async () => {
  const src = `**FREE
dcl-ds fecha;
  fec char(8) inz('20261122');
  anio char(4) overlay(fec);
  mes  char(2) overlay(fec:5);
  dia  char(2) overlay(fec:*next);
end-ds;
dcl-ds num;
  numc char(5);
  numz zoned(5:0) overlay(numc);
end-ds;
dcl-ds pk;
  pkc char(3);
  pkv packed(5:0) pos(1);
end-ds;
dcl-ds arr;
  tabla char(6) inz('ABCDEF');
  letra char(1) dim(6) overlay(tabla);
end-ds;
dcl-ds sininz;
  n packed(5:0);
end-ds;
dcl-ds coninz inz;
  m packed(5:0);
  c char(3);
end-ds;
dsply anio + '/' + mes + '/' + dia;
numc = '00123';
dsply %char(numz);
numz = -45;
dsply numc;
pkv = 12345;
dsply %char(%len(pkc)) + ' ' + %char(%size(pk)) + ' ' + %char(%size(pkv));
letra(3) = 'z';
dsply tabla;
monitor;
  dsply %char(n + 1);
on-error 907;
  dsply 'decimal';
endmon;
dsply %char(m + 1) + '[' + c + ']';
fecha = '19991231';
dsply dia;
pkc = x'00123F';
dsply %char(pkv);
*inlr = *on;`;
  const { msgs } = await runSrc(src.split('\n'));
  assert.deepEqual(msgs, ['2026/11/22', '123', '0004N', '3 3 3', 'ABzDEF', 'decimal', '1[   ]', '31', '123']);
});

test('DS en columnas fijas: RPG IV con posiciones en bytes (P/B) y RPG III con I-specs', async () => {
  const src4 = [
    L('D', { 7: 'REC', 24: 'DS' }),
    L('D', { 7: 'CODE', 26: '      1', 33: '      3' }),
    L('D', { 7: 'AMT', 26: '      4', 33: '      8', 40: 'P', 41: ' 2' }),
    L('D', { 7: 'QTY', 26: '      9', 33: '     10', 40: 'B', 41: ' 0' }),
    L('C', { 26: 'EVAL', 36: 'AMT = 123.45' }),
    L('C', { 26: 'EVAL', 36: 'QTY = 7' }),
    L('C', { 26: 'EVAL', 36: "CODE = 'ABC'" }),
    L('C', { 26: 'EVAL', 36: "*INLR = *ON" }),
    L('C', { 12: 'AMT', 26: 'DSPLY' }),
    L('C', { 26: 'EVAL', 36: "CODE = %CHAR(%SIZE(REC))" }),
    L('C', { 12: 'CODE', 26: 'DSPLY' }),
  ];
  const r4 = await runSrc(src4, { dialect: 'RPG4' });
  assert.deepEqual(r4.msgs.map((m) => m.trim()), ['123.45', '10']);
  const src3 = [
    L('I', { 7: 'DATOS', 19: 'DS' }),
    L('I', { 44: '   1', 48: '   8', 53: 'FECHA' }),
    L('I', { 44: '   1', 48: '   4', 53: 'ANIO' }),
    L('I', { 44: '   5', 48: '   6', 53: 'MES' }),
    L('I', { 44: '   7', 48: '   8', 52: '0', 53: 'DIA' }),
    L('C', { 28: 'MOVE', 33: "'20260131'", 43: 'FECHA' }),
    L('C', { 18: 'ANIO', 28: 'DSPLY' }),
    L('C', { 18: 'MES', 28: 'DSPLY' }),
    L('C', { 18: 'DIA', 28: 'ADD', 33: '1', 43: 'SIG', 49: '  2', 52: '0' }),
    L('C', { 18: 'SIG', 28: 'DSPLY' }),
    L('C', { 28: 'SETON', 54: 'LR' }),
  ];
  const r3 = await runSrc(src3);
  assert.deepEqual(r3.msgs.map((m) => m.trim()), ['2026', '01', '32']);
});

test('DS de múltiples apariciones: OCCURS, %OCCUR, %SIZE(*ALL), %ELEM, INZ y fuera de rango', async () => {
  const src = `**FREE
dcl-ds ventas occurs(12) inz;
  mes zoned(2:0);
  importe packed(9:2);
  nombre char(10);
end-ds;
dcl-ds copia likeds(ventas);
dcl-ds otra occurs(12);
  x char(1);
end-ds;
dcl-s i int(10);
dcl-s total packed(11:2);
dsply %char(importe);
for i = 1 to 12;
  %occur(ventas) = i;
  mes = i;
  importe = i * 100.5;
endfor;
%occur(ventas) = 3;
dsply %char(mes) + ' ' + %char(importe);
dsply %char(%occur(ventas));
for i = 1 to %elem(ventas);
  %occur(ventas) = i;
  total += importe;
endfor;
dsply %char(total);
dsply %char(%size(ventas)) + ' ' + %char(%size(ventas: *all));
%occur(ventas) = 5;
nombre = 'QUINTO';
copia = ventas;
dsply copia.nombre;
%occur(ventas) = 6;
dsply '[' + nombre + ']';
%occur(otra) = 5;
%occur(ventas) = otra;
dsply nombre;
monitor;
  %occur(ventas) = 13;
on-error 122;
  dsply 'rango';
endmon;
dsply %char(%occur(ventas));
*inlr = *on;`;
  const { msgs } = await runSrc(src.split('\n'));
  assert.deepEqual(msgs.map((m) => m.trimEnd()), ['.00', '3 301.50', '3', '7839.00', '17 204', 'QUINTO', '[          ]', 'QUINTO', 'rango', '5']);
});

test('OCCUR en columnas fijas: RPG IV (D OCCURS) y RPG III (I-spec DS con apariciones) con indicador de error', async () => {
  const src4 = [
    L('D', { 7: 'TABLA', 24: 'DS', 44: 'OCCURS(3)' }),
    L('D', { 7: 'COD', 33: '      3' }),
    L('D', { 7: 'N', 33: '      5', 40: 'S', 41: ' 0' }),
    L('D', { 7: 'P', 24: 'S', 33: '      3', 40: 'S', 41: ' 0' }),
    L('C', { 12: '2', 26: 'OCCUR', 36: 'TABLA' }),
    L('C', { 26: 'EVAL', 36: "COD = 'DOS'" }),
    L('C', { 12: '1', 26: 'OCCUR', 36: 'TABLA' }),
    L('C', { 26: 'EVAL', 36: "COD = 'UNO'" }),
    L('C', { 12: '2', 26: 'OCCUR', 36: 'TABLA', 50: 'P' }),
    L('C', { 12: 'COD', 26: 'DSPLY' }),
    L('C', { 12: 'P', 26: 'DSPLY' }),
    L('C', { 12: '4', 26: 'OCCUR', 36: 'TABLA', 73: '90' }),
    L('C', { 12: "'ERR'", 26: 'DSPLY', 9: '90' }),
    L('C', { 26: 'OCCUR', 36: 'TABLA', 50: 'P' }),
    L('C', { 12: 'P', 26: 'DSPLY' }),
    L('C', { 26: 'EVAL', 36: '*INLR = *ON' }),
  ];
  const r4 = await runSrc(src4, { dialect: 'RPG4' });
  assert.deepEqual(r4.msgs.map((m) => m.trim()), ['DOS', '2', 'ERR', '2']);
  const src3 = [
    L('I', { 7: 'MESES', 19: 'DS', 44: '  12' }),
    L('I', { 44: '   1', 48: '   3', 53: 'ABREV' }),
    L('I', { 44: '   4', 48: '   5', 52: '0', 53: 'DIAS' }),
    L('C', { 28: 'Z-ADD', 33: '0', 43: 'I', 49: '  2', 52: '0' }),
    L('C', { 18: 'I', 28: 'DOULT', 33: '12' }),
    L('C', { 28: 'ADD', 33: '1', 43: 'I' }),
    L('C', { 18: 'I', 28: 'OCUR', 33: 'MESES' }),
    L('C', { 28: 'Z-ADD', 33: '30', 43: 'DIAS' }),
    L('C', { 28: 'END' }),
    L('C', { 18: '2', 28: 'OCUR', 33: 'MESES' }),
    L('C', { 28: 'MOVEL', 33: "'FEB'", 43: 'ABREV' }),
    L('C', { 28: 'Z-ADD', 33: '28', 43: 'DIAS' }),
    L('C', { 18: '1', 28: 'OCUR', 33: 'MESES' }),
    L('C', { 18: 'DIAS', 28: 'DSPLY' }),
    L('C', { 18: '2', 28: 'OCUR', 33: 'MESES', 43: 'J', 49: '  2', 52: '0' }),
    L('C', { 18: 'ABREV', 28: 'DSPLY' }),
    L('C', { 18: 'DIAS', 28: 'DSPLY' }),
    L('C', { 18: 'J', 28: 'DSPLY' }),
    L('C', { 18: '13', 28: 'OCUR', 33: 'MESES', 56: '91' }),
    L('C', { 9: '91', 18: "'FUERA'", 28: 'DSPLY' }),
    L('C', { 28: 'SETON', 54: 'LR' }),
  ];
  const r3 = await runSrc(src3);
  assert.deepEqual(r3.msgs.map((m) => m.trim()), ['30', 'FEB', '28', '2', 'FUERA']);
});

test('SQL incrustado de varias filas: FETCH … FOR n ROWS y INSERT … n ROWS con DS de múltiples apariciones y arrays de DS', async () => {
  const data = [[1, 'ANA'], [2, 'LUIS'], [3, 'EVA'], [4, 'PEPE'], [5, 'SARA']];
  const inserted = [];
  const host = {
    async sql(text, params) {
      if (/^SELECT/i.test(text)) return { columns: [{ name: 'ID' }, { name: 'NOMBRE' }], rows: data, rowCount: data.length };
      if (/^INSERT/i.test(text)) { inserted.push({ text, params }); return { columns: [], rows: [], rowCount: params.length / 2 }; }
      return { columns: [], rows: [], rowCount: 0 };
    },
  };
  const src = `**FREE
dcl-ds cli occurs(2) qualified;
  id int(10);
  nombre char(10);
end-ds;
dcl-ds arr qualified dim(10);
  id int(10);
  nombre char(10);
end-ds;
dcl-s n int(10) inz(2);
dcl-s s varchar(80);
exec sql declare c1 cursor for select id, nombre from clientes order by id;
exec sql open c1;
dow 1 = 1;
  exec sql fetch next from c1 for :n rows into :cli;
  if sqlcode = 100;
    leave;
  endif;
  s = %char(sqlerrd(3)) + ':';
  %occur(cli) = 1;
  s += %trim(cli.nombre);
  if sqlerrd(3) > 1;
    %occur(cli) = 2;
    s += ',' + %trim(cli.nombre);
  endif;
  dsply (s + ' ' + %char(sqlerrd(5)));
enddo;
exec sql close c1;
exec sql open c1;
exec sql fetch c1 for 10 rows into :arr;
dsply (%char(sqlerrd(3)) + ' ' + %trim(arr(5).nombre));
arr(1).id = 7; arr(1).nombre = 'NUEVO';
arr(2).id = 8; arr(2).nombre = 'OTRO';
exec sql insert into clientes 2 rows values(:arr);
dsply %char(sqlerrd(3));
*inlr = *on;`;
  const ir = compileRpg(src.split('\n'));
  const msgs = [];
  const p = new RpgProgram(ir, { dsply: async (t) => { msgs.push(t); return ''; }, ...host });
  await p.call([]);
  assert.deepEqual(msgs, ['2:ANA,LUIS 0', '2:EVA,PEPE 0', '1:SARA 100', '5 SARA', '2']);
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].text, /INSERT INTO clientes VALUES \(\?, \?\), \(\?, \?\)/i);
  assert.deepEqual(inserted[0].params, [7, 'NUEVO', 8, 'OTRO']);
});
