// Query/400: WRKQRY, RUNQRY, DLTQRY, STRQRY.
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const up = (s) => String(s ?? '').trim().toUpperCase();
const I = { interactive: true };
const scr = () => import('../screens/query.js');

def('STRQRY', 'Start Query', [], async (ctx) => { await (await scr()).strqry(ctx); return null; }, I);
def('WRKQRY', 'Work with Queries', [], async (ctx) => { await (await scr()).wrkqry(ctx); return null; }, I);

def('RUNQRY', 'Run Query', [
  P('QRY', 'Query', 'qual', 10, { dft: '*NONE', choices: 'Name, *NONE' }),
  P('QRYFILE', 'Query file (library/file)', 'list', 60, { dft: '*SAME' }),
  P('OUTTYPE', 'Report output type', 'name', 9, { dft: '*RUNOPT', choices: '*RUNOPT, *DISPLAY, *PRINTER, *OUTFILE' }),
  P('OUTFORM', 'Output form', 'name', 8, { dft: '*RUNOPT', choices: '*RUNOPT, *DETAIL, *SUMMARY' }),
  P('RCDSLT', 'Record selection', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }),
  P('OUTFILE', 'Output file', 'qual', 10, { dft: '*NONE' }),
], async (ctx, a) => {
  const S = await scr();
  const Q = await import('../query.js');
  let q;
  let o = null;
  if (!a.QRY || !a.QRY.obj || a.QRY.obj === '*NONE') {
    const f = [].concat(a.QRYFILE || [])[0];
    if (!f || f === '*SAME') throw new CLError('CPD0072', 'QRYFILE');
    const [l, n] = String(f).toUpperCase().replace(/[()]/g, '').split(/\s+/)[0].includes('/') ? String(f).toUpperCase().replace(/[()]/g, '').split(/\s+/)[0].split('/') : ['*LIBL', String(f).toUpperCase().replace(/[()]/g, '').split(/\s+/)[0]];
    const d = await obj.describeFile(gw, `${l}/${n}`, ctx.libl).catch(() => null);
    if (!d) throw new CLError('CPF9812', n, l);
    q = Q.emptyQuery();
    q.files.push({ lib: d.lib || d.schema, file: n, id: 'T01' });
    const row = await (await import('../security.js')).objectRow(d.lib || d.schema, n, '*FILE');
    if (row) await (await import('../security.js')).checkAuthority(ctx, row, 'READ');
  } else {
    const r = await S.loadQuery(ctx, a.QRY.lib, a.QRY.obj);
    o = r.o;
    q = r.q;
    // QRYFILE sustituye los archivos de la definición (misma descripción)
    const qf = [].concat(a.QRYFILE || []).filter((x) => x && x !== '*SAME');
    qf.forEach((x, i) => { const s = String(x).toUpperCase().replace(/[()]/g, '').split(/\s+/)[0]; const [l, n] = s.includes('/') ? s.split('/') : ['*LIBL', s]; if (q.files[i]) q.files[i] = { ...q.files[i], lib: l === '*LIBL' ? q.files[i].lib : l, file: n }; });
  }
  if (a.RCDSLT === '*YES') { if (!ctx.interactive) throw new CLError('CPD0031', 'RUNQRY RCDSLT(*YES)'); await S.runtimeSelect(ctx, q); }
  let outtype = { '*DISPLAY': 1, '*PRINTER': 2, '*OUTFILE': 3 }[a.OUTTYPE] || null;
  if (outtype === 3) {
    if (!a.OUTFILE || !a.OUTFILE.obj || a.OUTFILE.obj === '*NONE') { if (!q.output.file) throw new CLError('CPD0072', 'OUTFILE'); } else q.output = { ...q.output, file: up(a.OUTFILE.obj), lib: a.OUTFILE.lib === '*LIBL' ? '*CURLIB' : a.OUTFILE.lib, data: q.output.data === 3 ? 3 : 2 };
  }
  if (!outtype) outtype = q.output.type || 1;
  // La pantalla solo existe en un trabajo interactivo; en un trabajo por lotes la salida va a la impresora
  if (outtype === 1 && !ctx.interactive) outtype = 2;
  const outform = { '*DETAIL': 1, '*SUMMARY': 2 }[a.OUTFORM] || null;
  const res = await Q.runQuery(ctx, q, { outtype, outform, qname: o ? o.NAME : '*NONE' });
  if (res.kind === 'display') { await S.showReport(ctx, res, o ? o.NAME : '*NONE', o ? o.LIB : ''); return null; }
  return [{ id: res.kind === 'print' ? 'QWM2601' : 'QWM2602', text: res.kind === 'print' ? `Query ${o ? o.NAME : '*NONE'} ran; ${res.rows} records printed to spooled file QPQUPRFIL.` : res.lines[0], sev: 0 }];
});

def('DLTQRY', 'Delete Query', [P('QRY', 'Query', 'qual', 10, { req: true })], async (ctx, a) => {
  const o = await obj.findObject(gw, up(a.QRY.obj), '*QRYDFN', a.QRY.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(a.QRY.lib), ctx.libl);
  if (!o) throw new CLError('CPF2105', up(a.QRY.obj), a.QRY.lib, '*QRYDFN');
  await obj.deleteObject(o.LIB, o.NAME, '*QRYDFN');
  return [{ id: 'CPC2191', text: `Object ${o.NAME} in ${o.LIB} type *QRYDFN deleted.`, sev: 0 }];
});
