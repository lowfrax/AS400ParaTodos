// Mandatos de archivos de mensajes: CRTMSGF, DLTMSGF, ADDMSGD, CHGMSGD, RMVMSGD, DSPMSGD, WRKMSGD, WRKMSGF, MRGMSGF,
// y SNDPGMMSG / RTVMSG / SNDUSRMSG como mandatos (también se ejecutan dentro de los programas CL).
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { Panel } from '../panel.js';
import { logJob, qualifiedJob } from '../system.js';
import { resolveMsgf, getMsgd, formatMsg, parseFmt, saveMsgf } from '../msgf.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const LIBQ = (kw, prompt, o = {}) => P(kw, prompt, 'qual', 10, { req: true, ...o });
const TEXT = P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' });
const textVal = (t) => (!t || t === '*BLANK' ? '' : t);
const I = { interactive: true };
const qs = (q) => `${q.lib || '*LIBL'}/${q.obj}`;
const validId = (id) => /^[A-Z@#$][A-Z0-9@#$]{2}[0-9A-F]{4}$/.test(id);

def('CRTMSGF', 'Create Message File', [LIBQ('MSGF', 'Message file', { lib: '*CURLIB' }), P('SIZE', 'Initial storage size', 'list', 20, { dft: '10 2 *NOMAX' }), TEXT], async (ctx, a) => {
  const lib = ctx.resolveLib(a.MSGF.lib === '*LIBL' ? '*CURLIB' : a.MSGF.lib);
  if (await obj.findObject(gw, a.MSGF.obj, '*MSGF', lib, [])) throw new CLError('CPF2112', a.MSGF.obj, lib, '*MSGF');
  await obj.putObject(lib, a.MSGF.obj, '*MSGF', '', textVal(a.TEXT), { msgs: {} }, ctx.job.user);
  return [{ id: 'CPC2411', text: `Message file ${a.MSGF.obj} created in library ${lib}.`, sev: 0 }];
});

def('DLTMSGF', 'Delete Message File', [LIBQ('MSGF', 'Message file')], async (ctx, a) => {
  const f = await resolveMsgf(ctx, { lib: a.MSGF.lib, obj: a.MSGF.obj });
  if (f.system) throw new CLError('CPF2189', `Not authorized to delete system message file ${f.name}.`);
  await obj.deleteObject(f.lib, f.name, '*MSGF');
  return [{ id: 'CPC2191', text: `Object ${f.name} in ${f.lib} type *MSGF deleted.`, sev: 0 }];
});

const MSGD_PARMS = (req) => [
  P('MSGID', 'Message identifier', 'name', 7, { req: true }),
  LIBQ('MSGF', 'Message file'),
  P('MSG', 'First-level message text', 'text', 132, { req, dft: req ? undefined : '*SAME' }),
  P('SECLVL', 'Second-level message text', 'text', 512, { dft: req ? '*NONE' : '*SAME' }),
  P('SEV', 'Severity code', 'int', 2, { dft: req ? '00' : '*SAME' }),
  P('FMT', 'Message data fields formats', 'text', 200, { dft: req ? '*NONE' : '*SAME' }),
  P('TYPE', 'Reply type', 'name', 7, { dft: req ? '*NONE' : '*SAME', choices: '*NONE, *CHAR, *DEC, *ALPHA, *NAME' }),
  P('LEN', 'Maximum reply length', 'list', 10, { dft: req ? '*TYPE' : '*SAME' }),
  P('VALUES', 'Valid reply values', 'list', 60, { dft: req ? '*NONE' : '*SAME' }),
  P('DFT', 'Default reply value', 'text', 32, { dft: req ? '*NONE' : '*SAME' }),
];

function applyMsgd(d, a, isAdd) {
  const keep = (v) => v === undefined || v === '*SAME';
  if (!keep(a.MSG)) d.text = a.MSG;
  if (!keep(a.SECLVL)) d.seclvl = a.SECLVL === '*NONE' ? '' : a.SECLVL;
  if (!keep(a.SEV)) d.sev = Number(a.SEV) || 0;
  if (!keep(a.FMT)) d.fmt = parseFmt(a.FMT);
  if (!keep(a.TYPE)) d.type = a.TYPE === '*NONE' ? null : a.TYPE;
  if (!keep(a.LEN)) d.len = Array.isArray(a.LEN) ? a.LEN.join(' ') : a.LEN;
  if (!keep(a.VALUES)) d.values = a.VALUES === '*NONE' || (Array.isArray(a.VALUES) && a.VALUES[0] === '*NONE') ? [] : [].concat(a.VALUES);
  if (!keep(a.DFT)) d.dft = a.DFT === '*NONE' ? null : a.DFT;
  if (isAdd) { d.created = new Date().toISOString(); d.seclvl = d.seclvl || ''; d.fmt = d.fmt || []; d.sev = d.sev || 0; }
  return d;
}

def('ADDMSGD', 'Add Message Description', MSGD_PARMS(true), async (ctx, a) => {
  const id = String(a.MSGID).toUpperCase();
  if (!validId(id)) throw new CLError('CPF2401', `Message identifier ${id} not valid (3 characters followed by 4 hexadecimal digits).`);
  const f = await resolveMsgf(ctx, { lib: a.MSGF.lib, obj: a.MSGF.obj });
  if (f.system) throw new CLError('CPF2189', `Not authorized to change system message file ${f.name}.`);
  if (f.data.msgs[id]) throw new CLError('CPF2412', `Message identifier ${id} already exists in message file ${f.name} in ${f.lib}.`);
  f.data.msgs[id] = applyMsgd({}, a, true);
  await saveMsgf(f);
  return null;
});

def('CHGMSGD', 'Change Message Description', MSGD_PARMS(false), async (ctx, a) => {
  const id = String(a.MSGID).toUpperCase();
  const f = await resolveMsgf(ctx, { lib: a.MSGF.lib, obj: a.MSGF.obj });
  if (f.system) throw new CLError('CPF2189', `Not authorized to change system message file ${f.name}.`);
  if (!f.data.msgs[id]) throw new CLError('CPF2419', `Message identifier ${id} not found in message file ${f.name} in ${f.lib}.`);
  applyMsgd(f.data.msgs[id], a, false);
  await saveMsgf(f);
  return null;
});

def('RMVMSGD', 'Remove Message Description', [P('MSGID', 'Message identifier', 'name', 7, { req: true }), LIBQ('MSGF', 'Message file')], async (ctx, a) => {
  const id = String(a.MSGID).toUpperCase();
  const f = await resolveMsgf(ctx, { lib: a.MSGF.lib, obj: a.MSGF.obj });
  if (f.system) throw new CLError('CPF2189', `Not authorized to change system message file ${f.name}.`);
  if (!f.data.msgs[id]) throw new CLError('CPF2419', `Message identifier ${id} not found in message file ${f.name} in ${f.lib}.`);
  delete f.data.msgs[id];
  await saveMsgf(f);
  return null;
});

def('MRGMSGF', 'Merge Message File', [LIBQ('FROMMSGF', 'From message file'), LIBQ('TOMSGF', 'To message file'), P('SELECT', 'Message IDs to select', 'list', 60, { dft: '*ALL' })], async (ctx, a) => {
  const from = await resolveMsgf(ctx, { lib: a.FROMMSGF.lib, obj: a.FROMMSGF.obj });
  const to = await resolveMsgf(ctx, { lib: a.TOMSGF.lib, obj: a.TOMSGF.obj });
  if (from.system || to.system) throw new CLError('CPF2189', 'System message files cannot be merged.');
  const sel = [].concat(a.SELECT || '*ALL');
  let n = 0;
  for (const [id, d] of Object.entries(from.data.msgs)) if (sel.includes('*ALL') || sel.includes(id)) { to.data.msgs[id] = JSON.parse(JSON.stringify(d)); n++; }
  await saveMsgf(to);
  return [{ id: 'CPC2409', text: `${n} message descriptions merged into ${to.name} in ${to.lib}.`, sev: 0 }];
});

function describe(d, f) {
  return [
    `Message ID  . . . . . . . . . :   ${d.id}`, `Message file  . . . . . . . . :   ${f.name}`, `  Library . . . . . . . . . . :   ${f.lib}`, '',
    `Message . . . . :   ${d.text}`, ...(d.seclvl ? [`Message help  . :   ${String(d.seclvl).replace(/&N/g, ' ')}`] : []), '',
    `Severity  . . . . . . . . . . :   ${String(d.sev || 0).padStart(2, '0')}`,
    `Message data fields . . . . . :   ${(d.fmt || []).map((x, i) => `&${i + 1}=${x.type} ${x.len}${x.dec ? ` ${x.dec}` : ''}`).join('  ') || '*NONE'}`,
    `Reply type  . . . . . . . . . :   ${d.type || '*NONE'}${d.values && d.values.length ? `   Valid values: ${d.values.join(' ')}` : ''}${d.dft ? `   Default: ${d.dft}` : ''}`,
  ];
}

def('DSPMSGD', 'Display Message Description', [P('RANGE', 'Range of message identifiers', 'name', 7, { req: true }), LIBQ('MSGF', 'Message file', { req: false, dft: 'QCPFMSG' })], async (ctx, a) => {
  const id = String(a.RANGE).toUpperCase();
  const f = await resolveMsgf(ctx, a.MSGF && a.MSGF.obj ? { lib: a.MSGF.lib, obj: a.MSGF.obj } : 'QCPFMSG');
  const d = await getMsgd(ctx, id, f.system ? f.name : `${f.lib}/${f.name}`);
  const lines = describe(d, f);
  if (!ctx.interactive) return { text: lines.join('\n') };
  const p = new Panel({ fn: 'CMD-DSPMSGD', keys: ['F3', 'F12'] });
  p.title('Display Formatted Message Text');
  p.sysName();
  lines.forEach((l, i) => p.text(3 + i, 2, l, i === 4 ? 'w' : 'g'));
  p.fkeys('F3=Exit   F12=Cancel');
  await ctx.display(p);
  return null;
});

def('WRKMSGD', 'Work with Message Descriptions', [LIBQ('MSGF', 'Message file'), P('MSGID', 'Starting message identifier', 'name', 7, { dft: '*FIRST' })], async (ctx, a) => {
  const f = await resolveMsgf(ctx, { lib: a.MSGF.lib, obj: a.MSGF.obj });
  if (f.system) throw new CLError('CPF2189', 'Use DSPMSGD to display system messages.');
  const ids = Object.keys(f.data.msgs).sort().filter((x) => a.MSGID === '*FIRST' || x >= String(a.MSGID).toUpperCase());
  const rows = ids.map((id) => ({ id, ...f.data.msgs[id] }));
  if (!ctx.interactive) return { text: rows.map((r) => `${r.id}  ${String(r.sev || 0).padStart(2, '0')}  ${r.text}`).join('\n') || '(no message descriptions)' };
  let top = 0;
  let msg = '';
  for (;;) {
    const p = new Panel({ fn: 'WRKMSGD', keys: ['F3', 'F5', 'F6', 'F12', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Work with Message Descriptions');
    p.sysName();
    p.text(3, 2, `Message file:   ${f.name}        Library:   ${f.lib}`, 'g');
    p.text(5, 2, 'Type options, press Enter.', 'b');
    p.text(6, 4, '2=Change   4=Remove   5=Display details', 'b');
    p.text(8, 2, 'Opt  Message ID  Severity  Message Text', 'w');
    const page = rows.slice(top, top + 12);
    page.forEach((r, i) => {
      p.input(`OPT${i}`, 9 + i, 2, 2);
      p.text(9 + i, 7, `${r.id}     ${String(r.sev || 0).padStart(2, '0')}       ${String(r.text).slice(0, 52)}`, 'g');
    });
    p.more(21, top + 12 < rows.length);
    p.fkeys('F3=Exit   F5=Refresh   F6=Add   F12=Cancel');
    if (msg) p.msg(msg);
    const r = await ctx.display(p);
    msg = '';
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'PAGEDOWN') { if (top + 12 < rows.length) top += 12; continue; }
    if (r.aid === 'PAGEUP') { top = Math.max(0, top - 12); continue; }
    if (r.aid === 'F6') { msg = `Use ADDMSGD MSGF(${f.lib}/${f.name}) to add a message description.`; continue; }
    for (let i = 0; i < page.length; i++) {
      const o = String(r.fields[`OPT${i}`] || '').trim();
      if (o === '5') { const lines = describe({ ...page[i] }, f); msg = lines.slice(4, 6).join(' ').slice(0, 78); }
      if (o === '4') { delete f.data.msgs[page[i].id]; await saveMsgf(f); rows.splice(rows.indexOf(page[i]), 1); msg = `Message description ${page[i].id} removed.`; }
    }
  }
}, I);

def('WRKMSGF', 'Work with Message Files', [LIBQ('MSGF', 'Message file', { dft: '*ALL', lib: '*LIBL' })], async (ctx, a) => {
  const libs = a.MSGF.lib && a.MSGF.lib !== '*LIBL' ? [ctx.resolveLib(a.MSGF.lib)] : ctx.libl;
  const out = [];
  for (const l of libs) for (const o of await obj.listObjects(l, a.MSGF.obj && a.MSGF.obj !== '*ALL' ? a.MSGF.obj : '*ALL', '*MSGF')) out.push(`${o.NAME.padEnd(12)}${o.LIB.padEnd(12)}${o.TEXT || ''}`);
  return { text: ['Message File  Library     Text', ...out, 'QCPFMSG     QSYS        System messages'].join('\n') };
});

// Como mandato (línea de mandatos o QCMDEXC): envía un mensaje de programa
def('SNDPGMMSG', 'Send Program Message', [
  P('MSG', 'Message text, or', 'text', 256, { promptLen: 120 }),
  P('MSGID', 'Message identifier', 'name', 7, { dft: '*NONE' }),
  LIBQ('MSGF', 'Message file', { req: false, dft: 'QCPFMSG' }),
  P('MSGDTA', 'Message data field values', 'text', 256, { dft: '*NONE' }),
  P('TOPGMQ', 'Call stack entry message queue', 'list', 20, { dft: '*PRV' }),
  P('TOMSGQ', 'Send to non-program msg queue', 'list', 30, { dft: '*TOPGMQ' }),
  P('MSGTYPE', 'Message type', 'name', 7, { dft: '*INFO', choices: '*INFO, *INQ, *COMP, *DIAG, *NOTIFY, *ESCAPE, *RQS, *STATUS' }),
], async (ctx, a) => {
  let text = a.MSG && a.MSG !== '*NONE' ? a.MSG : '';
  let id = a.MSGID && a.MSGID !== '*NONE' ? String(a.MSGID).toUpperCase() : '';
  let sev = 0;
  const data = a.MSGDTA && a.MSGDTA !== '*NONE' ? a.MSGDTA : '';
  if (!text && id) {
    const d = await getMsgd(ctx, id, a.MSGF && a.MSGF.obj ? qs(a.MSGF) : 'QCPFMSG');
    text = formatMsg(d, data).text;
    sev = d.sev || 0;
  }
  if (!text && !id) throw new CLError('CPD2439', 'Either MSG or MSGID must be specified.');
  const tomsgq = [].concat(a.TOMSGQ || '*TOPGMQ')[0];
  if (tomsgq && tomsgq !== '*TOPGMQ') {
    await obj.sendToQueue(tomsgq === '*SYSOPR' ? 'QSYSOPR' : String(tomsgq).replace(/^.*\//, ''), text, { msgid: id, type: a.MSGTYPE, sev, from: ctx.job.user, fromJob: qualifiedJob(ctx.job) });
    return null;
  }
  logJob(ctx.job, id, a.MSGTYPE, text, { sev, data });
  if (a.MSGTYPE === '*ESCAPE') { const e = new CLError(id || 'CPF9898', text); e.message = text; e.msgId = id || 'CPF9898'; e.msgdta = data; throw e; }
  return { id, text, sev: a.MSGTYPE === '*DIAG' ? Math.max(30, sev) : sev };
});

// RTVMSG fuera de un CL: devuelve el texto formateado
def('RTVMSG', 'Retrieve Message', [P('MSGID', 'Message identifier', 'name', 7, { req: true }), LIBQ('MSGF', 'Message file', { req: false, dft: 'QCPFMSG' }), P('MSGDTA', 'Message data field values', 'text', 256, { dft: '*NONE' })], async (ctx, a) => {
  const d = await getMsgd(ctx, a.MSGID, a.MSGF && a.MSGF.obj ? qs(a.MSGF) : 'QCPFMSG');
  const f = formatMsg(d, a.MSGDTA === '*NONE' ? '' : a.MSGDTA);
  return { id: String(a.MSGID).toUpperCase(), text: f.text, sev: 0 };
});

void logJob;
