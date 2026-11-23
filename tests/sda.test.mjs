// Pruebas unitarias del modelo de SDA (sin servicios): DDS ↔ registros, imagen de diseño y regeneración.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDdsModel, generateDds, recordImage, applyImage, newRecord } from '../shared/sda.js';
import { parseDSPF } from '../shared/dds.js';
import { CUSTINQD_DSPF, CUSTSFLD_DSPF } from '../services/ibmi-core/src/seed.js';

const lines = (x) => (Array.isArray(x) ? x : x.split('\n'));

test('SDA: cargar y regenerar el DDS conserva exactamente el archivo de pantalla', () => {
  for (const src of [CUSTINQD_DSPF, CUSTSFLD_DSPF].map(lines)) {
    const gen = generateDds(parseDdsModel(src));
    assert.deepEqual(parseDSPF(gen), parseDSPF(src));
  }
});

test('SDA: imagen de diseño con constantes, campos nuevos, atributos y errores', () => {
  const model = { comments: [], fileKws: [{ cond: '', text: 'DSPSIZ(24 80 *DS3)' }], records: [] };
  const rec = newRecord('FMT01');
  model.records.push(rec);
  const img = recordImage(rec);
  img[0] = " 'Mantenimiento de clientes'".padEnd(80);
  img[2] = ' Codigo:  +3(5)    Nombre: +BBBBBBBBBB   Importe: +6(9,2)'.padEnd(80);
  assert.equal(applyImage(model, rec, img).ok, true);
  const out = recordImage(rec);
  assert.match(out[0], /^ {2}Mantenimiento de clientes/);
  assert.match(out[2], /Codigo: {3}33333/);
  assert.match(out[2], /Nombre: {2}BBBBBBBBBB/);
  assert.match(out[2], /Importe: {2}666666666/);
  const f = rec.items.filter((i) => i.kind === 'F');
  assert.deepEqual(f.map((x) => [x.name, x.usage, x.len, x.dtype, x.dec]), [['FLD001', 'I', 5, 'Y', '0'], ['FLD002', 'B', 10, '', ''], ['FLD003', 'O', 9, 'Y', '2']]);
  // H en la posición del atributo de la constante y D delante de un campo
  const img2 = recordImage(rec);
  img2[0] = ` H${img2[0].slice(2)}`;
  const c = img2[2].indexOf('BBBB');
  img2[2] = `${img2[2].slice(0, c - 1)}D${img2[2].slice(c)}`;
  assert.equal(applyImage(model, rec, img2).ok, true);
  const dds = generateDds(model).join('\n');
  assert.match(dds, /'Mantenimiento de clientes'\n\s+A\s+DSPATR\(HI\)/);
  assert.doesNotMatch(dds, /FLD002/);
  assert.match(dds, /FLD001\s+5Y 0I  3 12/);
  // Un campo que pisa una constante
  const img3 = recordImage(rec);
  img3[5] = ' +B(20) texto'.padEnd(80);
  const r = applyImage(model, rec, img3);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].text, /overlaps/);
});

test('SDA: palabras clave largas se continúan con "-" y se vuelven a leer igual', () => {
  const model = { comments: [], fileKws: [], records: [newRecord('R1')] };
  const long = "'Este es un texto de constante bastante largo para la línea'";
  model.records[0].items.push({ kind: 'C', name: '', cond: '', ref: '', len: 0, dtype: '', dec: '', usage: '', row: 2, col: 2, kws: [{ cond: '', text: long }] });
  const gen = generateDds(model);
  assert.ok(gen.length >= 3 && gen.every((l) => l.length <= 80));
  assert.equal(parseDdsModel(gen).records[0].items[0].kws[0].text, long);
});
