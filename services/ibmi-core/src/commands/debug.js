// STRDBG, ENDDBG, DSPMODSRC, ADDPGM, RMVPGM, ADDBKP, RMVBKP, DSPDBG.
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as D from '../debug.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const up = (s) => String(s ?? '').trim().toUpperCase();
const pgmList = (v) => [].concat(v ?? []).map((x) => String(x).toUpperCase()).filter((x) => x && x !== '*NONE').map((x) => (x.includes('/') ? { lib: x.split('/')[0], name: x.split('/')[1] } : { lib: '*LIBL', name: x }));

def('STRDBG', 'Start Debug', [
  P('PGM', 'Program', 'list', 100, { dft: '*NONE' }),
  P('UPDPROD', 'Update production files', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }),
  P('OPMSRC', 'OPM source level debug', 'char', 4, { dft: '*NO' }),
  P('SRVPGM', 'Service program', 'list', 60, { dft: '*NONE' }),
], async (ctx, a) => {
  const pgms = pgmList(a.PGM);
  const d = await D.startDebug(ctx, pgms, { updprod: a.UPDPROD === '*YES' });
  const first = [...d.pgms.values()][0];
  // Interactivo: se muestra el fuente para poner puntos de interrupción (F12 vuelve con el modo de depuración activo)
  if (ctx.session && first) await D.sourceScreen(ctx, first, null, null, 'Debug session started. Use F6 or BREAK to add breakpoints; F12 to return.');
  return [{ id: '', text: `Debug mode started for ${d.pgms.size} program(s).`, sev: 0 }];
});

def('ENDDBG', 'End Debug', [], async (ctx) => {
  if (!ctx.job.debug) throw new CLError('CPF1999', 'Debug mode not active.');
  ctx.job.debug = null;
  return [{ id: '', text: 'Debug mode ended.', sev: 0 }];
});

def('DSPMODSRC', 'Display Module Source', [P('PGM', 'Program', 'name', 10, { dft: '*FIRST' })], async (ctx, a) => {
  const d = D.dbg(ctx.job);
  if (!d) throw new CLError('CPF1999', 'Debug mode not active (STRDBG).');
  const dp = a.PGM === '*FIRST' ? [...d.pgms.values()][0] : [...d.pgms.values()].find((p) => p.name === up(a.PGM));
  if (!dp) throw new CLError('CPF1999', `Program ${a.PGM} not in debug mode.`);
  await D.sourceScreen(ctx, dp, null, null, null);
  return null;
}, { interactive: true });

def('ADDPGM', 'Add Program', [P('PGM', 'Program', 'list', 100, { req: true })], async (ctx, a) => {
  const d = D.dbg(ctx.job);
  if (!d) throw new CLError('CPF1999', 'Debug mode not active (STRDBG).');
  for (const p of pgmList(a.PGM)) { const dp = await D.debugProgram(ctx, p.name, p.lib); d.pgms.set(`${dp.lib}/${dp.name}`, dp); }
  return [{ id: '', text: 'Programs added to debug.', sev: 0 }];
});
def('RMVPGM', 'Remove Program', [P('PGM', 'Program', 'list', 100, { req: true })], async (ctx, a) => {
  const d = D.dbg(ctx.job);
  if (!d) throw new CLError('CPF1999', 'Debug mode not active (STRDBG).');
  for (const p of pgmList(a.PGM)) for (const [k, v] of d.pgms) if (v.name === p.name) d.pgms.delete(k);
  return [{ id: '', text: 'Programs removed from debug.', sev: 0 }];
});

// Puntos de interrupción sin pantalla (también desde un CL o la API): ADDBKP STMT(línea) PGM(programa) WHEN
def('ADDBKP', 'Add Breakpoint', [P('STMT', 'Statement identifier', 'list', 40, { req: true }), P('PGM', 'Program', 'name', 10, { dft: '*DFTPGM' }), P('WHEN', 'Condition', 'text', 80, { dft: '*NONE' })], async (ctx, a) => {
  const d = D.dbg(ctx.job);
  if (!d) throw new CLError('CPF1999', 'Debug mode not active (STRDBG).');
  const dp = a.PGM === '*DFTPGM' ? [...d.pgms.values()][0] : [...d.pgms.values()].find((p) => p.name === up(a.PGM));
  if (!dp) throw new CLError('CPF1999', `Program ${a.PGM} not in debug mode.`);
  for (const s of [].concat(a.STMT)) dp.bps.set(Number(s), a.WHEN === '*NONE' ? null : a.WHEN);
  return [{ id: '', text: `Breakpoint(s) added to program ${dp.name}.`, sev: 0 }];
});
def('RMVBKP', 'Remove Breakpoint', [P('STMT', 'Statement identifier', 'list', 40, { req: true, choices: 'Number, *ALL' }), P('PGM', 'Program', 'name', 10, { dft: '*DFTPGM' })], async (ctx, a) => {
  const d = D.dbg(ctx.job);
  if (!d) throw new CLError('CPF1999', 'Debug mode not active (STRDBG).');
  const dp = a.PGM === '*DFTPGM' ? [...d.pgms.values()][0] : [...d.pgms.values()].find((p) => p.name === up(a.PGM));
  if (!dp) throw new CLError('CPF1999', `Program ${a.PGM} not in debug mode.`);
  for (const s of [].concat(a.STMT)) { if (up(s) === '*ALL') dp.bps.clear(); else dp.bps.delete(Number(s)); }
  return [{ id: '', text: 'Breakpoint(s) removed.', sev: 0 }];
});
def('DSPDBG', 'Display Debug', [], async (ctx) => {
  const d = D.dbg(ctx.job);
  if (!d) throw new CLError('CPF1999', 'Debug mode not active (STRDBG).');
  return { text: [`Update production files . . :   ${d.updprod ? '*YES' : '*NO'}`, 'Program     Library     Breakpoints', ...[...d.pgms.values()].map((p) => `${p.name.padEnd(12)}${p.lib.padEnd(12)}${[...p.bps.entries()].map(([n, c]) => `${n}${c ? ` WHEN ${c}` : ''}`).join(', ') || '(none)'}`)].join('\n') };
});
