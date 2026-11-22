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
