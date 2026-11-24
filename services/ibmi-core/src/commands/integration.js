// Mandatos CL de conectividad e integración: TCP/IP (STRTCPSVR, ENDTCPSVR, NETSTAT, PING), colas de datos (CRTDTAQ…),
// control de compromiso (STRCMTCTL, COMMIT, ROLLBACK), IFS (WRKLNK, MKDIR, CPYTOSTMF, CPYTOIMPF…), QSH, correo (SNDSMTPEMM),
// IBM MQ (CRTMQMQ, WRKMQMQ…), servicios web (ADDIWSSVC) y auditoría (DSPAUDJRNE).
import net from 'node:net';
import dns from 'node:dns/promises';
import { def } from './registry.js';
import { CLError, msg, msgText } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { Panel, padR, padL } from '../panel.js';
import { serverKeys, startServer, stopServer, serverStatus, netstatRows, serverDef, endConnection } from '../net/servers.js';
import { createDtaq, deleteDtaq, resolveDtaq, clearDtaq, dtaqEntries, dtaqCount } from '../dtaq.js';
import * as ifs from '../ifs.js';
import { parseQsysPath, readQsysMember, writeQsysMember } from '../qsyslib.js';
import { Qsh, runQsh } from '../net/qsh.js';
import { SYS, logJob, qualifiedJob } from '../system.js';
import { auditEntries } from '../svc/audit.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const LIBQ = (kw, prompt, o = {}) => P(kw, prompt, 'qual', 10, { req: true, ...o });
const TEXT = P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' });
const textVal = (t) => (!t || t === '*BLANK' ? '' : t);
const I = { interactive: true };
const libOf = (ctx, l) => (l === '*LIBL' || !l ? '*LIBL' : ctx.resolveLib(l));

// ---------------- TCP/IP ----------------
const SERVER_CHOICES = () => serverKeys().join(', ');
def('STRTCPSVR', 'Start TCP/IP Server', [P('SERVER', 'Server application', 'list', 60, { dft: '*AUTOSTART', choices: '*ALL, *AUTOSTART, *TELNET, *FTP…' })], async (ctx, a) => {
  const keys = a.SERVER.includes('*ALL') || a.SERVER.includes('*AUTOSTART') ? serverKeys() : a.SERVER;
  const out = [];
  for (const k of keys) {
    if (!serverDef(k)) throw new CLError('TCP1A13', k, SERVER_CHOICES());
    const ok = await startServer(k).catch((e) => { throw new CLError('CPF9898', `${k}: ${e.message}`); });
    out.push(ok ? msg('TCP1A0F', k) : msg('TCP1A11', k));
  }
  return out;
});
def('ENDTCPSVR', 'End TCP/IP Server', [P('SERVER', 'Server application', 'list', 60, { req: true, choices: '*ALL, *TELNET, *FTP…' })], async (ctx, a) => {
  const keys = a.SERVER.includes('*ALL') ? serverKeys() : a.SERVER;
  const out = [];
  for (const k of keys) {
    if (!serverDef(k)) throw new CLError('TCP1A13', k, SERVER_CHOICES());
    if (k === '*HTTP' && ctx.job.name === 'QZHBHTTP') throw new CLError('CPF9898', 'The HTTP server cannot be ended from one of its own jobs.');
    out.push((await stopServer(k)) ? msg('TCP1A10', k) : msg('TCP1A12', k));
  }
  return out;
});

async function netstatScreen(ctx, opt) {
  let page = 0;
  for (;;) {
    const p = new Panel({ fn: 'CMD-NETSTAT', keys: ['F3', 'F5', 'F12', 'PAGEUP', 'PAGEDOWN', 'F11'] });
    if (opt === '*IFC' || opt === '1') {
      p.title('Work with TCP/IP Interface Status');
      p.sysName();
      p.text(4, 2, 'Type options, press Enter.', 'b');
      p.text(5, 4, '5=Display details   8=Display associated routes   9=Start   10=End', 'b');
      p.text(7, 6, 'Internet', 'w').text(7, 22, 'Network', 'w').text(7, 38, 'Line', 'w').text(7, 52, 'Interface', 'w');
      p.text(8, 2, 'Opt  Address', 'w').text(8, 22, 'Address', 'w').text(8, 38, 'Description', 'w').text(8, 52, 'Status', 'w');
      const os = await import('node:os');
      const rows = [['127.0.0.1', '127.0.0.0', '*LOOPBACK', 'Active']];
      for (const [name, list] of Object.entries(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) rows.push([i.address, i.cidr ? i.cidr.split('/')[0].replace(/\d+$/, '0') : '', name.toUpperCase().slice(0, 10), 'Active']);
      rows.forEach((r, i) => p.text(9 + i, 7, padR(r[0], 15)).text(9 + i, 22, padR(r[1], 15)).text(9 + i, 38, padR(r[2], 12)).text(9 + i, 52, r[3]));
      p.more(19, false);
      p.fkeys('F3=Exit   F4=Prompt   F5=Refresh   F11=Display line information   F12=Cancel');
      const r = await ctx.display(p);
      if (r.aid === 'F3' || r.aid === 'F12') return;
      continue;
    }
    if (opt === '*RTE' || opt === '2') {
      p.title('Display TCP/IP Route Information');
      p.sysName();
      p.text(5, 2, 'Route', 'w').text(5, 22, 'Subnet', 'w').text(5, 40, 'Next', 'w');
      p.text(6, 2, 'Destination', 'w').text(6, 22, 'Mask', 'w').text(6, 40, 'Hop', 'w').text(6, 58, 'Available', 'w');
      p.text(7, 2, '127.0.0.0').text(7, 22, '255.0.0.0').text(7, 40, '*DIRECT').text(7, 58, '*YES');
      p.text(8, 2, '*DFTROUTE').text(8, 22, '*NONE').text(8, 40, '*GATEWAY').text(8, 58, '*YES');
      p.more(19, false);
      p.fkeys('F3=Exit   F5=Refresh   F12=Cancel');
      const r = await ctx.display(p);
      if (r.aid === 'F3' || r.aid === 'F12') return;
      continue;
    }
    // *CNN (opción 3)
    const rows = netstatRows();
    const per = 11;
    const pages = Math.max(1, Math.ceil(rows.length / per));
    if (page >= pages) page = pages - 1;
    p.title('Work with IPv4 Connection Status');
    p.sysName();
    p.text(4, 2, 'Type options, press Enter.', 'b');
    p.text(5, 4, '3=Enable debug   4=End   5=Display details   6=Disable debug', 'b');
    p.text(6, 4, '8=Display jobs', 'b');
    p.text(8, 6, 'Remote', 'w').text(8, 23, 'Remote', 'w').text(8, 31, 'Local', 'w');
    p.text(9, 2, 'Opt  Address', 'w').text(9, 23, 'Port', 'w').text(9, 31, 'Port', 'w').text(9, 41, 'Idle Time', 'w').text(9, 53, 'State', 'w').text(9, 66, 'Server', 'w');
    rows.slice(page * per, page * per + per).forEach((r, i) => {
      const y = 10 + i;
      p.input(`OPT${i}`, y, 3, 2, {});
      const idle = `${String(Math.floor(r.idle / 3600)).padStart(3, '0')}:${String(Math.floor((r.idle % 3600) / 60)).padStart(2, '0')}:${String(r.idle % 60).padStart(2, '0')}`;
      p.text(y, 7, padR(r.remote, 15)).text(y, 23, padR(r.rport, 7)).text(y, 31, padR(r.local, 9)).text(y, 41, idle).text(y, 53, padR(r.state, 12)).text(y, 66, padR(r.server, 12), 'b');
    });
    p.more(21, page < pages - 1);
    p.fkeys('F3=Exit   F5=Refresh   F9=Command line   F11=Display byte counts   F12=Cancel', 'F14=Display port numbers   F22=Display entire field   F24=More keys');
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return;
    if (r.aid === 'PAGEDOWN') { if (page < pages - 1) page++; continue; }
    if (r.aid === 'PAGEUP') { if (page > 0) page--; continue; }
    if (r.aid === 'F11') {
      const q = new Panel({ fn: 'CMD-NETSTAT', keys: ['F3', 'F12'] });
      q.title('Work with IPv4 Connection Status');
      q.sysName();
      q.text(5, 2, 'Remote Address', 'w').text(5, 20, 'Local Port', 'w').text(5, 32, 'User', 'w').text(5, 44, 'Bytes Out', 'w').text(5, 58, 'Bytes In', 'w');
      rows.slice(0, 15).forEach((x, i) => q.text(6 + i, 2, padR(x.remote, 16)).text(6 + i, 20, padR(x.local, 10)).text(6 + i, 32, padR(x.user || '', 10)).text(6 + i, 44, padL(x.bytesOut, 11)).text(6 + i, 58, padL(x.bytesIn, 11)));
      q.fkeys('F3=Exit   F12=Cancel');
      await ctx.display(q);
      continue;
    }
    // Opción 4 = terminar conexión
    for (const [k, v] of Object.entries(r.fields)) {
      if (k.startsWith('OPT') && String(v).trim() === '4') {
        const row = rows[page * per + Number(k.slice(3))];
        if (row?.id) endConnection(row.id);
      }
    }
  }
}
def('NETSTAT', 'Work with Network Status', [P('OPTION', 'Option', 'char', 4, { dft: '*SELECT', choices: '*CNN, *IFC, *RTE' })], async (ctx, a) => {
  if (!ctx.interactive) return { text: netstatRows().map((r) => `${r.remote}:${r.rport} ${r.local} ${r.state} ${r.server}`).join('; ') };
  let opt = a.OPTION;
  if (opt === '*SELECT') {
    const p = new Panel({ fn: 'CMD-NETSTAT', keys: ['F3', 'F12'] });
    p.title('Work with TCP/IP Network Status');
    p.sysName();
    p.text(3, 2, 'Select one of the following:', 'b');
    ['Work with IPv4 interface status', 'Display IPv4 route information', 'Work with IPv4 connection status', 'Work with IPv6 interface status', 'Display IPv6 route information', 'Work with IPv6 connection status'].forEach((t, i) => p.text(5 + i, 6, `${i + 1}. ${t}`));
    p.text(20, 2, 'Selection or command', 'g');
    p.cmdLine(21, 'SEL', 70);
    p.fkeys('F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel');
    const r = await ctx.display(p);
    if (r.aid !== 'ENTER') return null;
    opt = { 1: '*IFC', 2: '*RTE', 3: '*CNN', 4: '*IFC', 5: '*RTE', 6: '*CNN' }[String(r.fields.SEL).trim()] || '*CNN';
  }
  await netstatScreen(ctx, opt);
  return null;
});
def('WRKTCPSTS', 'Work with TCP/IP Network Status', [P('OPTION', 'Option', 'char', 4, { dft: '*SELECT' })], async (ctx, a, info) => {
  const { COMMANDS } = await import('./registry.js');
  return COMMANDS.get('NETSTAT').run(ctx, a, info);
});
def('WRKSRVTBLE', 'Work with TCP/IP Servers', [], async (ctx) => {
  const p = new Panel({ fn: 'CMD-WRKSRVTBLE', keys: ['F3', 'F5', 'F12'] });
  p.title('Work with TCP/IP Servers');
  p.sysName();
  p.text(4, 2, 'Server', 'w').text(4, 16, 'Status', 'w').text(4, 26, 'Ports', 'w').text(4, 50, 'Conn', 'w').text(4, 57, 'Description', 'w');
  serverStatus().forEach((s, i) => p.text(5 + i, 2, padR(s.key, 13)).text(5 + i, 16, s.active ? 'ACTIVE' : 'ENDED', s.active ? 'w' : 'r').text(5 + i, 26, padR(s.ports.map((x) => `${x.port}${x.tls ? 's' : ''}`).join(','), 23)).text(5 + i, 50, padL(s.connections, 4)).text(5 + i, 57, padR(s.title, 23)));
  p.fkeys('F3=Exit   F5=Refresh   F12=Cancel');
  await ctx.display(p);
  return null;
}, I);
def('PING', 'Verify TCP/IP Connection', [P('RMTSYS', 'Remote system', 'text', 60, { req: true, lc: true }), P('PORT', 'Port (TCP probe)', 'int', 5, { dft: '80' }), P('NBRPKT', 'Number of packets', 'int', 3, { dft: '5' })], async (ctx, a) => {
  const host = String(a.RMTSYS).replace(/^\*INTNETADR$/i, '127.0.0.1');
  let addr;
  try { addr = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : (await dns.lookup(host)).address; } catch { throw new CLError('CPF9898', `TCP3202: Unknown host ${host}.`); }
  logJob(ctx.job, 'TCP3204', '*INFO', `Verifying connection to host system ${host} at address ${addr}.`);
  let ok = 0;
  const times = [];
  for (let i = 0; i < Math.min(20, Number(a.NBRPKT) || 5); i++) {
    const t0 = Date.now();
    const good = await new Promise((res) => { const s = net.connect({ host: addr, port: Number(a.PORT) || 80, timeout: 2000 }, () => { s.destroy(); res(true); }); s.on('error', (e) => res(e.code === 'ECONNREFUSED')); s.on('timeout', () => { s.destroy(); res(false); }); });
    if (good) { ok++; times.push(Date.now() - t0); logJob(ctx.job, 'TCP3215', '*INFO', `PING reply ${i + 1} from ${addr} took ${Date.now() - t0} ms.`); }
  }
  const n = Math.min(20, Number(a.NBRPKT) || 5);
  if (!ok) throw new CLError('CPF9898', `TCP3210: Connection verification statistics: 0 of ${n} successful (0 %).`);
  return [{ id: 'TCP3210', text: `Connection verification statistics: ${ok} of ${n} successful (${Math.round((ok / n) * 100)} %). Round-trip (millisecs) min/avg/max = ${Math.min(...times)}/${Math.round(times.reduce((x, y) => x + y, 0) / times.length)}/${Math.max(...times)}.`, sev: 0 }];
});

// ---------------- Colas de datos ----------------
def('CRTDTAQ', 'Create Data Queue', [
  LIBQ('DTAQ', 'Data queue', { lib: '*CURLIB', libChoices: 'Name, *CURLIB' }),
  P('TYPE', 'Type', 'char', 4, { dft: '*STD', choices: '*STD, *DDM' }),
  P('MAXLEN', 'Maximum entry length', 'int', 5, { req: true, choices: '1-64512' }),
  P('SEQ', 'Sequence', 'char', 6, { dft: '*FIFO', choices: '*FIFO, *LIFO, *KEYED', values: ['*FIFO', '*LIFO', '*KEYED'] }),
  P('KEYLEN', 'Key length', 'int', 3, { dft: '0', choices: '1-256' }),
  P('SENDERID', 'Include sender ID', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }),
  TEXT,
], async (ctx, a) => {
  const lib = ctx.resolveLib(a.DTAQ.lib);
  if (!(await obj.libExists(lib))) throw new CLError('CPF2110', lib);
  if (Number(a.MAXLEN) < 1 || Number(a.MAXLEN) > 64512) throw new CLError('CPD0074', a.MAXLEN, 'MAXLEN');
  await createDtaq(lib, a.DTAQ.obj, { maxlen: a.MAXLEN, seq: a.SEQ, keylen: a.KEYLEN, senderInfo: a.SENDERID === '*YES', text: textVal(a.TEXT), owner: ctx.job.user });
  return msg('CPC9801', a.DTAQ.obj, '*DTAQ', lib);
});
def('DLTDTAQ', 'Delete Data Queue', [LIBQ('DTAQ', 'Data queue')], async (ctx, a) => {
  const q = await resolveDtaq(a.DTAQ.obj, libOf(ctx, a.DTAQ.lib), ctx.libl);
  await deleteDtaq(q.lib, q.name);
  return msg('CPC2191', q.name, q.lib, '*DTAQ');
});
def('CLRDTAQ', 'Clear Data Queue', [LIBQ('DTAQ', 'Data queue')], async (ctx, a) => {
  const q = await resolveDtaq(a.DTAQ.obj, libOf(ctx, a.DTAQ.lib), ctx.libl);
  await clearDtaq(q);
  return { text: `Data queue ${q.name} in ${q.lib} cleared.` };
});
// Mandatos de conveniencia (no son de IBM; en IBM i se usa CALL QSNDDTAQ / QRCVDTAQ)
def('SNDDTAQ', 'Send to Data Queue (QSNDDTAQ)', [LIBQ('DTAQ', 'Data queue'), P('DATA', 'Data', 'text', 512, { req: true, promptLen: 120 }), P('KEY', 'Key', 'text', 64, { dft: '' })], async (ctx, a) => {
  const { sendDtaq } = await import('../dtaq.js');
  const q = await resolveDtaq(a.DTAQ.obj, libOf(ctx, a.DTAQ.lib), ctx.libl);
  await sendDtaq(q, a.DATA, { key: a.KEY || '', sender: q.senderInfo ? qualifiedJob(ctx.job) : '' });
  return { text: `Entry sent to data queue ${q.lib}/${q.name}.` };
});
def('DSPDTAQ', 'Display Data Queue Entries', [LIBQ('DTAQ', 'Data queue')], async (ctx, a) => {
  const q = await resolveDtaq(a.DTAQ.obj, libOf(ctx, a.DTAQ.lib), ctx.libl);
  const entries = await dtaqEntries(q);
  if (!ctx.interactive) return { text: `${entries.length} entries in ${q.lib}/${q.name}.` };
  let page = 0;
  for (;;) {
    const p = new Panel({ fn: 'CMD-DSPDTAQ', keys: ['F3', 'F5', 'F12', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Display Data Queue Entries');
    p.sysName();
    p.info(3, 2, 'Data queue', q.name, 20); p.info(3, 42, 'Library', q.lib, 14);
    p.info(4, 2, 'Sequence', q.seq, 20); p.info(4, 42, 'Max length', String(q.maxlen), 14);
    p.info(5, 2, 'Entries', String(await dtaqCount(q)), 20); p.info(5, 42, 'Key length', String(q.keylen || 0), 14);
    p.text(7, 2, 'Seq', 'w').text(7, 9, q.seq === '*KEYED' ? 'Key' : 'Enqueued', 'w').text(7, 30, 'Data', 'w');
    const per = 12;
    entries.slice(page * per, page * per + per).forEach((e, i) => p.text(8 + i, 2, padL(e.ordinal, 5)).text(8 + i, 9, padR(q.seq === '*KEYED' ? e.key : String(e.enqueued || '').slice(11, 19), 20)).text(8 + i, 30, padR(e.data.replace(/\s+/g, ' '), 50)));
    p.more(20, (page + 1) * per < entries.length);
    p.fkeys('F3=Exit   F5=Refresh   F12=Cancel');
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'PAGEDOWN' && (page + 1) * per < entries.length) page++;
    if (r.aid === 'PAGEUP' && page > 0) page--;
    if (r.aid === 'F5') entries.splice(0, entries.length, ...(await dtaqEntries(q)));
  }
});

// ---------------- Control de compromiso ----------------
def('STRCMTCTL', 'Start Commitment Control', [P('LCKLVL', 'Lock level', 'char', 4, { req: true, choices: '*CHG, *CS, *ALL', values: ['*CHG', '*CS', '*ALL'] }), P('CMTSCOPE', 'Commitment definition scope', 'char', 7, { dft: '*ACTGRP' })], async (ctx, a) => {
  await ctx.startCommit(a.LCKLVL);
  return msg('CPC8351', a.LCKLVL);
});
def('ENDCMTCTL', 'End Commitment Control', [], async (ctx) => {
  if (!ctx.job.cmt) throw new CLError('CPF8350');
  const pending = !!ctx.job.cmt.tx;
  await ctx.endCommit({ commit: false });
  return pending ? [msg('CPF8356', 'pending'), msg('CPC8355')] : msg('CPC8355');
});
def('COMMIT', 'Commit', [], async (ctx) => {
  const r = await ctx.commit();
  if (r?.error) throw new CLError('CPF9898', r.error);
  return msg('CPC8301');
});
def('ROLLBACK', 'Rollback', [], async (ctx) => {
  const r = await ctx.rollback();
  if (r?.error) throw new CLError('CPF9898', r.error);
  return msg('CPC8302');
});

// ---------------- IFS ----------------
const cwdOf = (ctx) => ctx.job.cwd || ifs.homeDir(ctx.job.user);
const absPath = (ctx, p) => ifs.normPath(String(p || '.').replace(/^'|'$/g, ''), cwdOf(ctx));

def('CHGCURDIR', 'Change Current Directory', [P('DIR', 'Directory', 'text', 256, { req: true, lc: true })], async (ctx, a) => {
  const p = absPath(ctx, a.DIR);
  const st = await ifs.stat(p);
  if (!ifs.isQsys(p) && (!st || !st.dir)) throw new CLError('CPFA0A9', p);
  ctx.job.cwd = p;
  return msg('CPCA081');
});
def('CD', 'Change Current Directory', [P('DIR', 'Directory', 'text', 256, { req: true, lc: true })], async (ctx, a, info) => {
  const { COMMANDS } = await import('./registry.js');
  return COMMANDS.get('CHGCURDIR').run(ctx, a, info);
});
def('DSPCURDIR', 'Display Current Directory', [], async (ctx) => ({ text: `Current directory is ${cwdOf(ctx)}.` }));
def('MKDIR', 'Make Directory', [P('DIR', 'Directory', 'text', 256, { req: true, lc: true })], async (ctx, a) => { await ifs.mkdir(absPath(ctx, a.DIR)); return msg('CPCA051'); });
def('CRTDIR', 'Create Directory', [P('DIR', 'Directory', 'text', 256, { req: true, lc: true })], async (ctx, a) => { await ifs.mkdir(absPath(ctx, a.DIR)); return msg('CPCA051'); });
def('RMVDIR', 'Remove Directory', [P('DIR', 'Directory', 'text', 256, { req: true, lc: true }), P('SUBTREE', 'Remove subtree', 'char', 5, { dft: '*NONE', choices: '*NONE, *ALL' })], async (ctx, a) => { await ifs.rmdir(absPath(ctx, a.DIR), { recursive: a.SUBTREE === '*ALL' }); return msg('CPCA052'); });
def('RMDIR', 'Remove Directory', [P('DIR', 'Directory', 'text', 256, { req: true, lc: true })], async (ctx, a) => { await ifs.rmdir(absPath(ctx, a.DIR)); return msg('CPCA052'); });
for (const name of ['DEL', 'RMVLNK', 'ERASE']) {
  def(name, 'Remove Link', [P('OBJLNK', 'Object link', 'text', 256, { req: true, lc: true })], async (ctx, a) => { const p = absPath(ctx, a.OBJLNK); await ifs.unlink(p); return msg('CPCA056', p); });
}
for (const name of ['RNM', 'REN']) {
  def(name, 'Rename Object', [P('OBJ', 'Object', 'text', 256, { req: true, lc: true }), P('NEWOBJ', 'New object', 'text', 256, { req: true, lc: true })], async (ctx, a) => {
    const from = absPath(ctx, a.OBJ);
    const to = a.NEWOBJ.includes('/') ? absPath(ctx, a.NEWOBJ) : `${from.slice(0, from.lastIndexOf('/'))}/${a.NEWOBJ}`;
    await ifs.rename(from, to);
    return msg('CPCA058');
  });
}
for (const name of ['CPY', 'COPY']) {
  def(name, 'Copy Object', [P('OBJ', 'Object', 'text', 256, { req: true, lc: true }), P('TOOBJ', 'To object', 'text', 256, { dft: '', lc: true }), P('TODIR', 'To directory', 'text', 256, { dft: '.', lc: true }), P('REPLACE', 'Replace object', 'char', 4, { dft: '*NO' })], async (ctx, a) => {
    const from = absPath(ctx, a.OBJ);
    const to = a.TOOBJ ? absPath(ctx, a.TOOBJ) : `${absPath(ctx, a.TODIR)}/${from.split('/').pop()}`;
    await ifs.copy(from, to, { replace: a.REPLACE === '*YES' });
    return { text: `Object copied to ${to}.` };
  });
}
def('DSPF', 'Display File (stream file)', [P('STMF', 'Stream file', 'text', 256, { req: true, lc: true })], async (ctx, a) => {
  const p = absPath(ctx, a.STMF);
  const text = ifs.isQsys(p) ? (await (async () => { const q = parseQsysPath(p); return readQsysMember(q.lib, q.obj, q.mbr || q.obj); })()).replace(/\r\n/g, '\n') : (await ifs.readFile(p)).toString('utf8');
  if (!ctx.interactive) return { text: text.slice(0, 500) };
  const lines = text.replace(/\t/g, '    ').split(/\r?\n/);
  let top = 0;
  let left = 0;
  for (;;) {
    const pn = new Panel({ fn: 'CMD-DSPF', keys: ['F3', 'F12', 'PAGEUP', 'PAGEDOWN', 'F19', 'F20'] });
    pn.text(1, 2, 'Browse :', 'w').text(1, 12, p.slice(-56), 'w').text(1, 70, `Rec : ${padL(top + 1, 4)}`, 'w');
    pn.text(2, 2, `Record : ${padL(top + 1, 6)}   of ${padL(lines.length, 6)} by  18     Column : ${padL(left + 1, 4)}`, 'g');
    pn.text(3, 2, ' ....+....1....+....2....+....3....+....4....+....5....+....6....+....7....+...', 'w');
    lines.slice(top, top + 18).forEach((l, i) => pn.text(4 + i, 2, l.slice(left, left + 78), 'g'));
    if (top + 18 >= lines.length) pn.text(4 + Math.min(18, lines.length - top), 2, '************End of Data********************', 'w');
    pn.fkeys('F3=Exit   F10=Display Hex   F12=Exit   F15=Services   F16=Repeat find', 'F19=Left   F20=Right');
    const r = await ctx.display(pn);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'PAGEDOWN') top = Math.min(Math.max(0, lines.length - 1), top + 18);
    if (r.aid === 'PAGEUP') top = Math.max(0, top - 18);
    if (r.aid === 'F20') left += 40;
    if (r.aid === 'F19') left = Math.max(0, left - 40);
  }
});
def('EDTF', 'Edit File (stream file)', [P('STMF', 'Stream file', 'text', 256, { req: true, lc: true })], async (ctx, a) => {
  const p = absPath(ctx, a.STMF);
  let lines = (await ifs.stat(p)) ? (await ifs.readFile(p)).toString('utf8').replace(/\r\n/g, '\n').split('\n') : [''];
  let top = 0;
  let message = null;
  for (;;) {
    const pn = new Panel({ fn: 'CMD-EDTF', keys: ['F2', 'F3', 'F12', 'PAGEUP', 'PAGEDOWN'] });
    pn.text(1, 2, 'Edit File:', 'w').text(1, 13, p.slice(-50), 'w').text(1, 66, `Record: ${padL(top + 1, 5)}`, 'w');
    pn.text(2, 2, 'Control :', 'g');
    pn.text(3, 2, '....+....1....+....2....+....3....+....4....+....5....+....6....+....7....+..', 'w');
    for (let i = 0; i < 18; i++) pn.input(`L${i}`, 4 + i, 2, 78, { value: lines[top + i] ?? '', lower: true, attr: 'g' });
    pn.fkeys('F2=Save   F3=Save/Exit   F12=Exit   F15=Services   F16=Repeat find', 'PageUp/PageDown=Scroll');
    if (message) pn.msg(message);
    message = null;
    const r = await ctx.display(pn);
    for (let i = 0; i < 18; i++) lines[top + i] = r.fields[`L${i}`] ?? '';
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    if (r.aid === 'F12') return null;
    if (r.aid === 'F2' || r.aid === 'F3') { await ifs.writeFile(p, `${lines.join('\n')}\n`); if (r.aid === 'F3') return { text: `File ${p} saved.` }; message = `File ${p} saved.`; }
    if (r.aid === 'PAGEDOWN') top += 18;
    if (r.aid === 'PAGEUP') top = Math.max(0, top - 18);
  }
}, I);
def('WRKLNK', 'Work with Object Links', [P('OBJ', 'Object', 'text', 256, { dft: '*', lc: true })], async (ctx, a) => {
  let dir = a.OBJ === '*' ? cwdOf(ctx) : absPath(ctx, a.OBJ);
  let page = 0;
  let message = null;
  for (;;) {
    let entries;
    if (ifs.isQsys(dir)) {
      const { listQsys } = await import('../qsyslib.js');
      entries = (await listQsys(parseQsysPath(dir))).map((e) => ({ name: e.name, type: e.type === '*MBR' ? '*MBR' : e.type, dir: e.dir, path: `${dir}/${e.name}`.replace('//', '/') }));
    } else {
      entries = (await ifs.list(dir)).map((e) => ({ ...e }));
      if (dir === '/') entries.unshift({ name: 'QSYS.LIB', type: '*LIB', dir: true, path: '/QSYS.LIB' });
    }
    const per = 12;
    const pages = Math.max(1, Math.ceil(entries.length / per));
    if (page >= pages) page = pages - 1;
    const p = new Panel({ fn: 'CMD-WRKLNK', keys: ['F3', 'F5', 'F12', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Work with Object Links');
    p.info(3, 2, 'Directory', dir.slice(-60), 18);
    p.text(5, 2, 'Type options, press Enter.', 'b');
    p.text(6, 4, '2=Edit   3=Copy   4=Remove   5=Display   7=Rename   8=Display attributes', 'b');
    p.text(7, 4, '9=Work with authority   11=Change current directory ...', 'b');
    p.text(9, 2, 'Opt   Object link            Type     Attribute    Text', 'w');
    entries.slice(page * per, page * per + per).forEach((e, i) => {
      p.input(`OPT${i}`, 10 + i, 3, 2, {});
      p.text(10 + i, 8, padR(e.name, 22)).text(10 + i, 31, padR(e.type, 8)).text(10 + i, 40, e.dir ? 'DIR' : 'STMF');
    });
    p.more(22, page < pages - 1);
    p.text(23, 2, 'Parameters or command', 'g');
    p.fkeys('F3=Exit   F4=Prompt   F5=Refresh   F9=Retrieve   F12=Cancel   F22=Display entire field');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'PAGEDOWN') { if (page < pages - 1) page++; continue; }
    if (r.aid === 'PAGEUP') { if (page > 0) page--; continue; }
    for (const [k, v] of Object.entries(r.fields)) {
      const o = String(v).trim();
      if (!k.startsWith('OPT') || !o) continue;
      const e = entries[page * per + Number(k.slice(3))];
      if (!e) continue;
      const { runCommand } = await import('./registry.js');
      try {
        if (o === '5') { if (e.dir) { dir = e.path; page = 0; } else await runCommand(ctx, `DSPF STMF('${e.path}')`); }
        else if (o === '2' && !e.dir) await runCommand(ctx, `EDTF STMF('${e.path}')`);
        else if (o === '4') { if (e.dir) await ifs.rmdir(e.path); else await ifs.unlink(e.path); message = `Object ${e.name} removed.`; }
        else if (o === '9') await runCommand(ctx, `WRKAUT OBJ('${e.path}')`);
        else if (o === '11' && e.dir) { ctx.job.cwd = e.path; message = msgText('CPCA081'); }
        else if (o === '8') message = `${e.path}: ${e.type}, ${e.size ?? 0} bytes, changed ${e.mtime ? new Date(e.mtime).toISOString().slice(0, 19).replace('T', ' ') : ''}`;
      } catch (err) { message = { id: err.msgId, text: err.message, sev: 40 }; }
    }
  }
}, I);
def('DSPLNK', 'Display Object Links', [P('OBJ', 'Object', 'text', 256, { dft: '*', lc: true })], async (ctx, a, info) => {
  const { COMMANDS } = await import('./registry.js');
  return COMMANDS.get('WRKLNK').run(ctx, a, info);
}, I);

// Miembros ⇄ archivos continuos
def('CPYTOSTMF', 'Copy To Stream File', [P('FROMMBR', 'From member or save file', 'text', 256, { req: true, lc: true }), P('TOSTMF', 'To stream file or directory', 'text', 256, { req: true, lc: true }), P('STMFOPT', 'Stream file option', 'char', 8, { dft: '*NONE', choices: '*NONE, *ADD, *REPLACE' }), P('STMFCCSID', 'Stream file CCSID', 'char', 8, { dft: '1208' })], async (ctx, a) => {
  const q = parseQsysPath(absPath(ctx, a.FROMMBR));
  if (!q?.obj) throw new CLError('CPFA0A9', a.FROMMBR);
  const text = await readQsysMember(q.lib, q.obj, q.mbr || q.obj);
  const to = absPath(ctx, a.TOSTMF);
  if (a.STMFOPT === '*NONE' && (await ifs.stat(to))) throw new CLError('CPFA0A0', to);
  await ifs.writeFile(to, text.replace(/\r\n/g, '\n'), { append: a.STMFOPT === '*ADD' });
  return msg('CPCA083');
});
def('CPYFRMSTMF', 'Copy From Stream File', [P('FROMSTMF', 'From stream file', 'text', 256, { req: true, lc: true }), P('TOMBR', 'To file member or save file', 'text', 256, { req: true, lc: true }), P('MBROPT', 'Replace or add records', 'char', 8, { dft: '*NONE', choices: '*NONE, *ADD, *REPLACE' })], async (ctx, a) => {
  const text = (await ifs.readFile(absPath(ctx, a.FROMSTMF))).toString('utf8');
  const q = parseQsysPath(absPath(ctx, a.TOMBR));
  if (!q?.obj) throw new CLError('CPFA0A9', a.TOMBR);
  await writeQsysMember(q.lib, q.obj, q.mbr || q.obj, text, { append: a.MBROPT === '*ADD' });
  return msg('CPCA082');
});

// Archivos de base de datos ⇄ CSV (formato de importación/exportación)
function csvField(v, strDlm, fldDlm) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v).replace(/\s+$/, '');
  return strDlm ? `${strDlm}${s.split(strDlm).join(strDlm + strDlm)}${strDlm}` : s.includes(fldDlm) ? `"${s}"` : s;
}
function parseCsvLine(line, fd, sd) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === sd && line[i + 1] === sd) { cur += sd; i++; } else if (c === sd) q = false; else cur += c; continue; }
    if (sd && c === sd) { q = true; continue; }
    if (c === fd) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
def('CPYTOIMPF', 'Copy To Import File', [
  LIBQ('FROMFILE', 'From file'), P('TOSTMF', 'To stream file', 'text', 256, { req: true, lc: true }),
  P('MBROPT', 'Replace or add records', 'char', 8, { dft: '*ADD', choices: '*ADD, *REPLACE' }),
  P('RCDDLM', 'Record delimiter', 'char', 6, { dft: '*CRLF', choices: '*CRLF, *LF, *CR' }),
  P('DTAFMT', 'Record format of import file', 'char', 6, { dft: '*DLM', choices: '*DLM, *FIXED' }),
  P('STRDLM', 'String delimiter', 'char', 5, { dft: '"', lc: true, choices: '", *NONE' }),
  P('FLDDLM', 'Field delimiter', 'char', 5, { dft: ',', lc: true, choices: ', ; *TAB' }),
  P('ADDCOLNAM', 'Column headings', 'char', 6, { dft: '*NONE', choices: '*NONE, *SQL, *SYS' }),
], async (ctx, a) => {
  const d = await obj.describeFile(gw, `${libOf(ctx, a.FROMFILE.lib)}/${a.FROMFILE.obj}`, ctx.libl).catch(() => { throw new CLError('CPF9812', a.FROMFILE.obj, a.FROMFILE.lib); });
  const r = await gw.exec(`SELECT * FROM ${d.schema}.${d.table}`);
  const rd = { '*CRLF': '\r\n', '*LF': '\n', '*CR': '\r' }[a.RCDDLM] || '\r\n';
  const fd = a.FLDDLM === '*TAB' ? '\t' : a.FLDDLM || ',';
  const sd = a.STRDLM === '*NONE' ? '' : a.STRDLM || '"';
  const lines = [];
  if (a.ADDCOLNAM !== '*NONE') lines.push(r.columns.map((c) => c.name).join(fd));
  for (const row of r.rows) {
    if (a.DTAFMT === '*FIXED') lines.push(d.fields.map((f, i) => String(row[i] ?? '').padEnd(Math.max(1, f.length || 10)).slice(0, Math.max(1, f.length || 10))).join(''));
    else lines.push(row.map((v) => csvField(v, sd, fd)).join(fd));
  }
  const to = absPath(ctx, a.TOSTMF);
  await ifs.writeFile(to, lines.join(rd) + (lines.length ? rd : ''), { append: a.MBROPT === '*ADD' });
  return msg('CPC2956', r.rows.length, to);
});
def('CPYFRMIMPF', 'Copy From Import File', [
  P('FROMSTMF', 'From stream file', 'text', 256, { req: true, lc: true }), LIBQ('TOFILE', 'To data base file'),
  P('MBROPT', 'Replace or add records', 'char', 8, { dft: '*ADD', choices: '*ADD, *REPLACE' }),
  P('STRDLM', 'String delimiter', 'char', 5, { dft: '"', lc: true }), P('FLDDLM', 'Field delimiter', 'char', 5, { dft: ',', lc: true }),
  P('RMVCOLNAM', 'Remove column names', 'char', 5, { dft: '*NO', choices: '*NO, *YES' }),
  P('ERRRCDFILE', 'Errors file', 'char', 10, { dft: '*NONE' }),
], async (ctx, a) => {
  const d = await obj.describeFile(gw, `${libOf(ctx, a.TOFILE.lib)}/${a.TOFILE.obj}`, ctx.libl).catch(() => { throw new CLError('CPF9812', a.TOFILE.obj, a.TOFILE.lib); });
  const text = (await ifs.readFile(absPath(ctx, a.FROMSTMF))).toString('utf8');
  const fd = a.FLDDLM === '*TAB' ? '\t' : a.FLDDLM || ',';
  const sd = a.STRDLM === '*NONE' ? '' : a.STRDLM || '"';
  let lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim());
  if (a.RMVCOLNAM === '*YES') lines = lines.slice(1);
  const stmts = [];
  if (a.MBROPT === '*REPLACE') stmts.push(`DELETE FROM ${d.schema}.${d.table}`);
  for (const l of lines) {
    const vals = parseCsvLine(l, fd, sd);
    const fields = d.fields.slice(0, vals.length);
    stmts.push({ sql: `INSERT INTO ${d.schema}.${d.table} (${fields.map((f) => `"${f.name}"`).join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, params: fields.map((f, i) => (['packed', 'zoned', 'int', 'uns', 'float'].includes(f.type.t) ? Number(String(vals[i]).trim() || 0) : vals[i])) });
  }
  let ok = 0;
  let bad = 0;
  for (let i = 0; i < stmts.length; i += 200) {
    const r = await gw.batch(stmts.slice(i, i + 200), []);
    for (const x of r.results) { if (x.ok) ok++; else { bad++; logJob(ctx.job, 'CPF2817', '*DIAG', `Record not copied: ${x.error}`, { sev: 30 }); } }
  }
  if (a.MBROPT === '*REPLACE') ok--;
  if (bad && !ok) throw new CLError('CPF2817');
  return msg('CPC2957', ok, a.FROMSTMF);
});

// ---------------- QSH ----------------
async function qshTerminal(ctx) {
  const sh = new Qsh(ctx);
  const buf = ['', '  QSH Command Entry', ''];
  for (;;) {
    const p = new Panel({ fn: 'PGM-QZSHQSHC', keys: ['F3', 'F5', 'F6', 'F7', 'F8', 'F9', 'F11', 'F12', 'F13', 'F21'] });
    p.center(1, 'QSH Command Entry', 'w');
    const view = buf.slice(-17);
    view.forEach((l, i) => p.text(3 + i, 2, l.slice(0, 78), 'g'));
    p.text(20, 2, '===>', 'g');
    p.input('CMD', 20, 7, 153, { lower: true });
    p.fkeys('F3=Exit   F6=Print   F9=Retrieve   F12=Disconnect', 'F13=Clear   F17=Top   F18=Bottom   F21=CL command entry');
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return;
    if (r.aid === 'F13') { buf.length = 0; continue; }
    const line = String(r.fields.CMD || '').trim();
    if (!line) continue;
    buf.push(`  > ${line}`);
    const out = await sh.exec(line);
    for (const l of out.out.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\n$/, '').split('\n')) if (l || out.out) buf.push(`    ${l}`);
    buf.push(`  $`);
    if (out.exit) return;
  }
}
for (const name of ['QSH', 'STRQSH']) {
  def(name, 'Start QSH', [P('CMD', 'Command', 'cmd', 512, { dft: '*NONE', promptLen: 120 })], async (ctx, a) => {
    if (a.CMD && a.CMD !== '*NONE') {
      const r = await runQsh(ctx, a.CMD);
      if (ctx.interactive && r.text.trim()) {
        const { programMessages } = await import('../runtime/call.js');
        await programMessages(ctx, r.text.replace(/\n/g, '  ').slice(0, 900), false);
      }
      if (r.code !== 0) throw new CLError('CPF9898', `QSH0005: Command ended normally with exit status ${r.code}.`);
      return { id: 'QSH0005', text: 'Command ended normally with exit status 0.' };
    }
    if (!ctx.interactive) throw new CLError('CPD0031', name);
    await qshTerminal(ctx);
    return null;
  });
}

// ---------------- Correo electrónico ----------------
def('SNDSMTPEMM', 'Send SMTP E-mail Message', [
  P('RCP', 'Recipient', 'text', 256, { req: true, lc: true, promptLen: 60 }),
  P('SUBJECT', 'Subject', 'text', 120, { req: true, lc: true, promptLen: 60 }),
  P('NOTE', 'Note', 'text', 2048, { dft: '', lc: true, promptLen: 120 }),
  P('ATTACH', 'Attachment', 'text', 512, { dft: '*NONE', lc: true, promptLen: 60 }),
  P('CONTENT', 'Content type', 'char', 7, { dft: '*PLAIN', choices: '*PLAIN, *HTML' }),
], async (ctx, a) => {
  const { sendMail } = await import('../net/smtp.js');
  const rcp = String(a.RCP).replace(/[()]/g, ' ').split(/[\s,;]+/).filter((x) => x.includes('@') && !x.startsWith('*'));
  const attach = a.ATTACH && a.ATTACH !== '*NONE' ? String(a.ATTACH).replace(/[()]/g, ' ').split(/\s+/).filter((x) => x.startsWith('/')) : [];
  const files = [];
  for (const f of attach) files.push({ name: f.split('/').pop(), data: await ifs.readFile(absPath(ctx, f)) });
  try {
    await sendMail({ from: `${ctx.job.user.toLowerCase()}@${SYS.name.toLowerCase()}.local`, to: rcp, subject: a.SUBJECT, text: a.NOTE || '', html: a.CONTENT === '*HTML', attachments: files, client: qualifiedJob(ctx.job) });
  } catch (e) { throw new CLError('TCP5091', e.message); }
  return msg('TCP5090', rcp.length);
});

// ---------------- IBM MQ ----------------
def('CRTMQMQ', 'Create MQ Queue', [P('QNAME', 'Queue name', 'text', 48, { req: true, lc: false }), P('MQMNAME', 'Message Queue Manager name', 'char', 48, { dft: '*DFT' }), P('QTYPE', 'Queue type', 'char', 6, { dft: '*LCL' }), P('TEXT', 'Text', 'text', 64, { dft: '' }), P('MAXDEPTH', 'Maximum queue depth', 'int', 9, { dft: '5000' })], async (ctx, a) => {
  const mq = await import('../net/mq.js');
  await mq.createQueue(a.QNAME, { descr: a.TEXT || '', maxdepth: a.MAXDEPTH });
  return { id: 'AMQ8006', text: `IBM MQ queue created: ${String(a.QNAME).toUpperCase()}.` };
});
def('DLTMQMQ', 'Delete MQ Queue', [P('QNAME', 'Queue name', 'text', 48, { req: true }), P('PURGE', 'Purge', 'char', 4, { dft: '*NO' })], async (ctx, a) => {
  const mq = await import('../net/mq.js');
  await mq.deleteQueue(a.QNAME, { purge: a.PURGE === '*YES' });
  return { id: 'AMQ8007', text: `IBM MQ queue deleted: ${String(a.QNAME).toUpperCase()}.` };
});
def('CLRMQMQ', 'Clear MQ Queue', [P('QNAME', 'Queue name', 'text', 48, { req: true })], async (ctx, a) => {
  const mq = await import('../net/mq.js');
  await mq.clearQueue(a.QNAME);
  return { id: 'AMQ8022', text: `IBM MQ queue cleared: ${String(a.QNAME).toUpperCase()}.` };
});
def('PUTMQMSG', 'Put MQ Message', [P('QNAME', 'Queue name', 'text', 48, { req: true }), P('MSG', 'Message', 'text', 2048, { req: true, lc: true, promptLen: 120 }), P('CORRELID', 'Correlation id', 'text', 48, { dft: '' })], async (ctx, a) => {
  const mq = await import('../net/mq.js');
  const r = await mq.mqSend(a.QNAME, a.MSG, { correlId: a.CORRELID || '', user: ctx.job.user });
  return { text: `Message ${r.messageId.slice(0, 16)}… put to ${String(a.QNAME).toUpperCase()}.` };
});
def('WRKMQMQ', 'Work with MQ Queues', [P('QNAME', 'Queue name', 'text', 48, { dft: '*ALL' })], async (ctx) => {
  const mq = await import('../net/mq.js');
  let message = null;
  for (;;) {
    const qs = await mq.listQueues();
    const p = new Panel({ fn: 'CMD-WRKMQMQ', keys: ['F3', 'F5', 'F12'] });
    p.title('Work with MQ Queues');
    p.info(3, 2, 'Queue Manager Name', mq.QMGR(), 22);
    p.text(5, 2, 'Type options, press Enter.', 'b');
    p.text(6, 4, '4=Delete   5=Display messages   14=Clear', 'b');
    p.text(8, 2, 'Opt  Name                                    Type  Depth   Puts    Gets', 'w');
    qs.slice(0, 12).forEach((q, i) => {
      p.input(`OPT${i}`, 9 + i, 3, 2, {});
      p.text(9 + i, 7, padR(q.name, 39)).text(9 + i, 47, '*LCL').text(9 + i, 52, padL(q.depth, 6)).text(9 + i, 59, padL(q.puts, 7)).text(9 + i, 67, padL(q.gets, 7));
    });
    p.more(21, qs.length > 12);
    p.fkeys('F3=Exit   F5=Refresh   F6=Create   F12=Cancel');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    for (const [k, v] of Object.entries(r.fields)) {
      const o = String(v).trim();
      const q = qs[Number(k.slice(3))];
      if (!o || !q) continue;
      try {
        if (o === '4') { await mq.deleteQueue(q.name, { purge: true }); message = `Queue ${q.name} deleted.`; }
        if (o === '14') { await mq.clearQueue(q.name); message = `Queue ${q.name} cleared.`; }
        if (o === '5') {
          const msgs = await mq.mqMessages(q.name, 14);
          const d = new Panel({ fn: 'CMD-WRKMQMSG', keys: ['F3', 'F12'] });
          d.title('Work with MQ Messages');
          d.info(3, 2, 'Queue name', q.name, 18);
          d.text(5, 2, 'Put user    Put time             Data', 'w');
          msgs.forEach((m, i) => d.text(6 + i, 2, padR(m.putUser, 11)).text(6 + i, 14, padR(String(m.putTime || '').slice(0, 19), 20)).text(6 + i, 35, padR(m.data.replace(/\s+/g, ' '), 45)));
          d.fkeys('F3=Exit   F12=Cancel');
          await ctx.display(d);
        }
      } catch (e) { message = { id: e.msgId, text: e.message, sev: 40 }; }
    }
  }
}, I);

// ---------------- Servicios web (IWS) ----------------
def('ADDIWSSVC', 'Add Web Service (IWS)', [
  P('SERVICE', 'Service name', 'char', 32, { req: true, lc: true }), LIBQ('PGM', 'Program'),
  P('METHOD', 'HTTP method', 'char', 6, { dft: 'POST', choices: 'GET, POST, PUT, DELETE' }), P('PATH', 'Path template', 'text', 128, { dft: '/', lc: true }),
  P('PUBLIC', 'No authentication', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }), P('TEXT', 'Description', 'text', 80, { dft: '', lc: true }),
], async (ctx, a) => {
  const { defineService, loadServices } = await import('../net/http/iws.js');
  const { systemProgram } = await import('../runtime/sysapi.js');
  const isApi = systemProgram(a.PGM.obj) && ['*LIBL', 'QSYS'].includes(a.PGM.lib);
  const lib = isApi ? 'QSYS' : a.PGM.lib === '*LIBL' ? (await obj.findObject(gw, a.PGM.obj, '*PGM', '*LIBL', ctx.libl))?.LIB : ctx.resolveLib(a.PGM.lib);
  if (!lib) throw new CLError('CPF9811', a.PGM.obj, a.PGM.lib);
  const prev = (await loadServices())[String(a.SERVICE).toLowerCase()];
  const ops = (prev?.operations || []).filter((o) => !(o.method === a.METHOD && o.path === a.PATH));
  ops.push({ method: a.METHOD, path: a.PATH });
  await defineService(a.SERVICE, { program: `${lib}/${a.PGM.obj}`, description: a.TEXT || prev?.description || '', public: a.PUBLIC === '*YES', operations: ops });
  return { text: `Web service ${String(a.SERVICE).toLowerCase()} deployed: ${a.METHOD} /web/services/${String(a.SERVICE).toLowerCase()}${a.PATH === '/' ? '' : a.PATH} -> ${lib}/${a.PGM.obj}.` };
});
def('RMVIWSSVC', 'Remove Web Service (IWS)', [P('SERVICE', 'Service name', 'char', 32, { req: true, lc: true })], async (ctx, a) => {
  const { removeService } = await import('../net/http/iws.js');
  await removeService(a.SERVICE);
  return { text: `Web service ${a.SERVICE} removed.` };
});

// ---------------- Auditoría ----------------
def('DSPAUDJRNE', 'Display Audit Journal Entries', [P('ENTTYP', 'Entry type', 'char', 4, { dft: '*ALL', choices: '*ALL, PW, SV, AF' }), P('USRPRF', 'User profile', 'name', 10, { dft: '*ALL' })], async (ctx, a) => {
  const e = auditEntries({ type: a.ENTTYP === '*ALL' ? undefined : a.ENTTYP, user: a.USRPRF === '*ALL' ? undefined : a.USRPRF, limit: 2000 });
  const lines = ['Display Audit Journal Entries (QAUDJRN)', '', 'Seq     Type Date/Time            User       Service    Remote           Text', ...e.map((x) => `${padL(x.seq, 6)}  ${padR(x.type, 4)} ${new Date(x.t).toISOString().slice(0, 19).replace('T', ' ')}  ${padR(x.user, 10)} ${padR(x.service, 10)} ${padR(x.remote, 16)} ${x.text}`)];
  await obj.createSpool(ctx.job, 'QPSYDSPAUD', lines, { usrdta: 'AUDJRN' });
  return { text: `${e.length} audit journal entries written to spooled file QPSYDSPAUD.` };
});
