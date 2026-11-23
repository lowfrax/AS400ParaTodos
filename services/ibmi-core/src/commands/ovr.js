// OVRDBF, OVRPRTF, DLTOVR y DSPOVR: alteraciones temporales de archivos de base de datos y de impresora.
import { def } from './registry.js';
import { CLError } from '../messages.js';
import { addOverride, deleteOverride, listOverrides, callLevel } from '../runtime/overrides.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const q2s = (q) => (!q || !q.obj || q.obj === '*FILE' ? null : `${q.lib && q.lib !== '*LIBL' ? q.lib : '*LIBL'}/${q.obj}`);

def('OVRDBF', 'Override with Data Base File', [
  P('FILE', 'File being overridden', 'name', 10, { req: true }),
  P('TOFILE', 'Overriding to data base file', 'qual', 10, { dft: '*FILE' }),
  P('MBR', 'Overriding member', 'name', 10, { dft: '*FIRST' }),
  P('POSITION', 'Starting position in file', 'list', 30, { dft: '*NONE' }),
  P('SHARE', 'Share open data path', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }),
  P('OVRSCOPE', 'Override scope', 'name', 10, { dft: '*ACTGRPDFN', choices: '*ACTGRPDFN, *CALLLVL, *JOB' }),
  P('SECURE', 'Secure from other overrides', 'char', 4, { dft: '*NO' }),
  P('SEQONLY', 'Limit to sequential only', 'list', 20, { dft: '*NO' }),
  P('NBRRCDS', 'Records retrieved at once', 'int', 5, { dft: '*NONE' }),
  P('LVLCHK', 'Record format level check', 'char', 4, { dft: '*NO' }),
], async (ctx, a) => {
  const pos = [].concat(a.POSITION || '*NONE');
  addOverride(ctx.job, {
    kind: 'DB', file: a.FILE, tofile: q2s(a.TOFILE), mbr: a.MBR, position: pos[0] === '*NONE' ? null : pos.join(' '),
    share: a.SHARE === '*YES', scope: a.OVRSCOPE === '*JOB' ? '*JOB' : '*CALLLVL', cmd: 'OVRDBF',
  });
  return null;
});

def('OVRPRTF', 'Override with Printer File', [
  P('FILE', 'File being overridden', 'name', 10, { req: true }),
  P('TOFILE', 'Overriding to printer file', 'qual', 10, { dft: '*FILE' }),
  P('PAGESIZE', 'Page size', 'list', 12, { dft: '*SAME' }),
  P('OVRFLW', 'Overflow line number', 'int', 3, { dft: '*SAME' }),
  P('OUTQ', 'Output queue', 'qual', 10, { dft: '*SAME' }),
  P('COPIES', 'Copies', 'int', 3, { dft: '*SAME' }),
  P('HOLD', 'Hold spooled file', 'char', 4, { dft: '*SAME', choices: '*SAME, *YES, *NO' }),
  P('SAVE', 'Save spooled file', 'char', 4, { dft: '*SAME' }),
  P('SPLFNAME', 'Spooled file name', 'name', 10, { dft: '*SAME' }),
  P('USRDTA', 'User data', 'text', 10, { dft: '*SAME' }),
  P('OVRSCOPE', 'Override scope', 'name', 10, { dft: '*ACTGRPDFN', choices: '*ACTGRPDFN, *CALLLVL, *JOB' }),
], async (ctx, a) => {
  const ps = a.PAGESIZE && a.PAGESIZE !== '*SAME' ? [].concat(a.PAGESIZE).join(' ').replace(/[()]/g, ' ').trim().split(/\s+/).map(Number) : null;
  const same = (v) => (v === undefined || v === '*SAME' ? undefined : v);
  addOverride(ctx.job, {
    kind: 'PRT', file: a.FILE, tofile: q2s(a.TOFILE), pagelen: ps ? ps[0] : undefined, width: ps ? ps[1] : undefined,
    ovrflw: same(a.OVRFLW) !== undefined ? Number(a.OVRFLW) : undefined,
    outq: a.OUTQ && a.OUTQ.obj && a.OUTQ.obj !== '*SAME' ? a.OUTQ.obj : undefined,
    copies: same(a.COPIES) !== undefined ? Number(a.COPIES) : undefined,
    hold: same(a.HOLD) !== undefined ? a.HOLD === '*YES' : undefined,
    splfname: same(a.SPLFNAME), usrdta: same(a.USRDTA), scope: a.OVRSCOPE === '*JOB' ? '*JOB' : '*CALLLVL', cmd: 'OVRPRTF',
  });
  return null;
});

def('DLTOVR', 'Delete Override', [
  P('FILE', 'Overridden file name', 'name', 10, { req: true, choices: 'Name, *ALL, *PRTF' }),
  P('LVL', 'Call level', 'name', 10, { dft: '*' }),
], async (ctx, a) => {
  const n = deleteOverride(ctx.job, a.FILE, { all: a.FILE === '*ALL' });
  if (!n && a.FILE !== '*ALL') throw new CLError('CPF9841', `Override not found for file ${a.FILE}.`);
  return null;
});

def('DSPOVR', 'Display Override', [P('FILE', 'File', 'name', 10, { dft: '*ALL' }), P('MRGOVR', 'Merge overrides', 'char', 4, { dft: '*YES' })], async (ctx, a) => {
  const list = listOverrides(ctx.job).filter((o) => a.FILE === '*ALL' || o.file === String(a.FILE).toUpperCase());
  const lines = [`Call level  . . . :   ${callLevel(ctx.job)}`, '', 'File        Level  Type    Keyword specifications',
    ...list.map((o) => `${o.file.padEnd(12)}${(o.scope === '*JOB' ? '*JOB' : String(o.level)).padEnd(7)}${o.cmd.padEnd(8)}${[o.tofile && `TOFILE(${o.tofile})`, o.position && `POSITION(${o.position})`, o.outq && `OUTQ(${o.outq})`, o.hold !== undefined && `HOLD(${o.hold ? '*YES' : '*NO'})`, o.splfname && `SPLFNAME(${o.splfname})`, o.usrdta && `USRDTA(${o.usrdta})`, o.copies && `COPIES(${o.copies})`, o.pagelen && `PAGESIZE(${o.pagelen} ${o.width || ''})`].filter(Boolean).join(' ')}`)];
  if (!list.length) throw new CLError('CPF9842', 'No overrides found.');
  return { text: lines.join('\n') };
});
