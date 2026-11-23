// Pantallas varias: DSPLIBL, DSPPFM, DSPFFD, DSPOBJD, WRKUSRPRF, WRKSYSVAL, QCMD (Command Entry).
import { Panel, padR, padL } from '../panel.js';
import { SYS, sysDate, sysTime } from '../system.js';
import { workWith, viewText, execFromLine, toMsg } from './common.js';
import { libraries, listObjects, listUsers, sysvals, setSysval, gw, findObject, describeFile } from '../objects.js';
import { CLError, msgText } from '../messages.js';
import { wrapText } from '../session.js';
import { charLen } from '../../../../shared/rpg/types.js';
import { runCommand } from '../commands/registry.js';
import { RpgCancel } from '../../../../shared/rpg/interpreter.js';

export async function dsplibl(ctx) {
  const libs = await libraries();
  const text = new Map(libs.map((l) => [l.NAME, l.TEXT]));
  return workWith(ctx, {
    fn: 'CMD-DSPLIBL',
    title: 'Display Library List',
    sysRight: false,
    header: (p) => { p.sysName(); return 3; },
    opts: ['5=Display objects in library'],
    optLen: 1,
    colHead: 'Opt  Library     Type      Text',
    cmd: false,
    load: async () => ctx.libl.map((l) => ({ name: l === `QT${ctx.job.number}` ? 'QTEMP' : l, type: ['QSYS', 'QSYS2', 'QHLPSYS', 'QUSRSYS'].includes(l) ? 'SYS' : l === ctx.job.curlib ? 'CUR' : 'USR' })),
    key: (l) => l.name,
    row: (l) => `${padR(l.name, 10)}  ${padR(l.type, 8)}  ${padR(text.get(l.name) || '', 50)}`,
    fkeys: ['F3=Exit   F12=Cancel   F17=Top   F18=Bottom'],
    enterExits: true,
    act: async (sels) => {
      for (const s of sels) if (s.opt === '5') await dsplib(ctx, s.item.name);
      return null;
    },
  });
}

export async function dsplib(ctx, lib) {
  const libs = await libraries();
  const L = libs.find((l) => l.NAME === lib);
  if (!L) throw new CLError('CPF2110', lib);
  const objs = (await listObjects(lib)).filter((o) => !(lib === 'QSYS' && o.TYPE === '*LIB'));
  return workWith(ctx, {
    fn: 'CMD-DSPLIB',
    title: 'Display Library',
    header: (p) => {
      p.info(3, 2, 'Library', lib, 24); p.info(3, 42, 'Number of objects', String(objs.length), 24);
      p.info(4, 2, 'Type', L.ATTR, 24); p.info(4, 42, 'Library ASP number', '1', 24);
      p.info(5, 2, 'Create authority', '*SYSVAL', 24);
      return 7;
    },
    opts: ['5=Display full attributes   8=Display service attributes'],
    optLen: 1,
    colHead: 'Opt  Object      Type      Attribute       Size  Text',
    cmd: false,
    load: async () => objs,
    key: (o) => `${o.NAME}/${o.TYPE}`,
    row: (o) => `${padR(o.NAME, 10)}  ${padR(o.TYPE, 8)}  ${padR(o.ATTR, 10)}${padL(Math.max(4096, Number(o.OBJSIZE || 0)), 10)}  ${padR(o.TEXT, 24)}`,
    fkeys: ['F3=Exit   F12=Cancel   F17=Top   F18=Bottom'],
    enterExits: true,
    act: async (sels) => {
      for (const s of sels) await dspobjd(ctx, lib, s.item.NAME, s.item.TYPE);
      return null;
    },
  });
}

export async function dspobjd(ctx, lib, name, type) {
  const libs = lib === '*LIBL' ? ctx.libl : [lib];
  const o = await findObject(gw, name, type, '*LIBL', libs);
  if (!o) throw new CLError('CPF9801', name, lib);
  const p = new Panel({ fn: 'CMD-DSPOBJD', keys: ['F3', 'F12'] });
  p.title('Display Object Description - Basic');
  p.text(2, 65, 'Library 1 of 1', 'g');
  p.info(3, 2, 'Object', o.NAME, 22); p.info(3, 42, 'Attribute', o.ATTR, 22);
  p.info(4, 4, 'Library', o.LIB, 20); p.info(4, 42, 'Owner', o.OWNER, 22);
  p.info(5, 2, 'Type', o.TYPE, 22); p.info(5, 42, 'Primary group', '*NONE', 22);
  p.text(7, 2, 'User-defined information:', 'g');
  p.info(8, 4, 'Attribute', '', 36);
  p.info(9, 4, 'Text', o.TEXT, 36);
  p.text(11, 2, 'Creation information:', 'g');
  const d = o.CREATED ? new Date(String(o.CREATED).replace(' ', 'T')) : new Date();
  p.info(12, 4, 'Creation date/time', `${sysDate(d)}  ${sysTime(d)}`, 36);
  p.info(13, 4, 'Created by user', o.OWNER, 36);
  p.info(14, 4, 'System created on', SYS.name, 36);
  p.info(15, 4, 'Object domain', '*SYSTEM', 36);
  p.more(18, false);
  p.text(19, 2, 'Press Enter to continue.', 'b');
  p.fkeys('F3=Exit   F12=Cancel');
  await ctx.display(p);
  return null;
}

async function fileOf(ctx, q) {
  const libl = q.lib === '*LIBL' ? ctx.libl : [ctx.resolveLib(q.lib)];
  try { return await describeFile(gw, `${libl.length === 1 ? libl[0] : '*LIBL'}/${q.obj}`, ctx.libl); } catch (e) {
    throw new CLError('CPF9812', q.obj, q.lib);
  }
}

export async function dsppfm(ctx, q) {
  const d = await fileOf(ctx, q);
  const r = await gw.sql(`SELECT * FROM ${d.schema}.${d.table}${d.keys.length ? ` ORDER BY ${d.keys.map((k) => `"${k}"`).join(', ')}` : ''} FETCH FIRST 5000 ROWS ONLY`);
  if (r.error) throw new CLError('CPF9898', r.error);
  const lines = r.rows.map((row) => d.fields.map((f, i) => {
    const t = f.type;
    const v = row[r.columns.findIndex((c) => c.name.toUpperCase() === f.name)] ?? row[i];
    if (t.t === 'packed' || t.t === 'zoned') return String(Math.round(Math.abs(Number(v || 0)) * 10 ** t.dec)).padStart(t.digits, '0');
    if (t.t === 'int') return String(v ?? 0).padStart(charLen(t), ' ');
    return String(v ?? '').padEnd(charLen(t)).slice(0, Math.max(charLen(t), 1));
  }).join(''));
  if (!lines.length) lines.push('');
  return viewText(ctx, {
    fn: 'CMD-DSPPFM',
    title: 'Display Physical File Member',
    head: (p, st) => {
      p.label(2, 2, 'File', 19); p.text(2, 19, ':', 'g'); p.text(2, 23, d.table, 'w');
      p.label(2, 42, 'Library', 19); p.text(2, 59, ':', 'g'); p.text(2, 63, d.lib, 'w');
      p.label(3, 2, 'Member', 19); p.text(3, 19, ':', 'g'); p.text(3, 23, d.table, 'w');
      p.label(3, 42, 'Record', 19); p.text(3, 59, ':', 'g'); p.text(3, 63, String(st.top + 1), 'w');
      return 4;
    },
    lines,
    attr: 'g',
  });
}

export async function dspffd(ctx, q) {
  const d = await fileOf(ctx, q);
  const out = [];
  out.push(` Display File Field Description`);
  out.push(` Input parameters`);
  out.push(`   File  . . . . . . . . . . . . . . . . . . . :   ${d.table}`);
  out.push(`     Library . . . . . . . . . . . . . . . . . :     ${d.lib}`);
  out.push(` File Information`);
  out.push(`   File  . . . . . . . . . . . . . . . . . . . :   ${d.table}`);
  out.push(`   File type . . . . . . . . . . . . . . . . . :   PHYSICAL`);
  out.push(` Record Format Information`);
  out.push(`   Record format . . . . . . . . . . . . . . . :   ${d.format}`);
  out.push(`   Number of fields  . . . . . . . . . . . . . :   ${d.fields.length}`);
  out.push(`   Key fields  . . . . . . . . . . . . . . . . :   ${d.keys.join(', ') || '*NONE'}`);
  out.push(' Field Level Information');
  out.push('              Data        Field  Buffer    Buffer        Field    Column');
  out.push('   Field      Type       Length  Length  Position        Usage    Heading');
  let pos = 1;
  for (const f of d.fields) {
    const t = f.type;
    const tn = { char: 'CHAR', varchar: 'VARCHAR', packed: 'PACKED', zoned: 'ZONED', int: 'BINARY', float: 'FLOAT', date: 'DATE', time: 'TIME', timestamp: 'TIMESTAMP' }[t.t] || t.t.toUpperCase();
    const len = t.t === 'packed' || t.t === 'zoned' ? `${t.digits}  ${t.dec}` : String(charLen(t));
    const buf = t.t === 'packed' ? Math.floor(t.digits / 2) + 1 : t.t === 'int' ? t.bits / 8 : charLen(t);
    out.push(`   ${padR(f.name, 10)} ${padR(tn, 9)} ${padL(len, 7)} ${padL(buf, 7)} ${padL(pos, 9)}        Both     ${f.text || f.name}`);
    pos += buf;
  }
  return viewText(ctx, { fn: 'CMD-DSPFFD', title: 'Display Spooled File', head: (p) => { p.text(2, 2, 'File  . . . . . :', 'g').text(2, 21, 'QPDSPFFD', 'w'); return 3; }, lines: out });
}

export async function wrkusrprf(ctx) {
  return workWith(ctx, {
    fn: 'CMD-WRKUSRPRF',
    title: 'Work with User Profiles',
    opts: ['1=Create   2=Change   3=Copy   4=Delete   5=Display', '12=Work with objects by owner'],
    colHead: 'Opt  User Profile  Class      Status     Text',
    load: listUsers,
    key: (u) => u.NAME,
    row: (u) => `${padR(u.NAME, 12)}  ${padR(u.USRCLS, 9)}  ${padR(u.STATUS, 9)}  ${padR(u.TEXT, 38)}`,
    fkeys: ['F3=Exit   F5=Refresh   F6=Create   F12=Cancel   F24=More keys'],
    keys: { F6: async () => execFromLine(ctx, 'CRTUSRPRF', true) },
    act: async (sels) => {
      let last = null;
      for (const s of sels) {
        if (s.opt === '4') last = await execFromLine(ctx, `DLTUSRPRF USRPRF(${s.item.NAME})`);
        else if (s.opt === '2') last = await execFromLine(ctx, `CHGUSRPRF USRPRF(${s.item.NAME})`, true);
        else if (s.opt === '5') last = { text: `${s.item.NAME}: class ${s.item.USRCLS}, ${s.item.STATUS}, current library ${s.item.CURLIB}, last sign-on ${s.item.LASTSIGN || 'never'}.` };
        else last = { id: 'CPD6A01', text: msgText('CPD6A01', s.opt), sev: 30 };
      }
      return last;
    },
  });
}

export async function wrksysval(ctx) {
  return workWith(ctx, {
    fn: 'CMD-WRKSYSVAL',
    title: 'Work with System Values',
    opts: ['2=Change   5=Display'],
    optLen: 1,
    colHead: 'Opt  System Value  Value       Description',
    load: sysvals,
    key: (v) => v.NAME,
    row: (v) => `${padR(v.NAME, 12)}  ${padR(v.VALUE, 10)}  ${padR(v.TEXT, 44)}`,
    fkeys: ['F3=Exit   F5=Refresh   F12=Cancel   F24=More keys'],
    act: async (sels) => {
      let last = null;
      for (const s of sels) {
        if (s.opt === '2') {
          const p = new Panel({ fn: 'CMD-CHGSYSVAL', keys: ['F12'] });
          p.title('Change System Value');
          p.info(3, 2, 'System value', s.item.NAME, 22);
          p.info(4, 2, 'Description', s.item.TEXT, 22);
          p.text(6, 2, 'Type choice, press Enter.', 'b');
          p.label(8, 2, 'Value', 22); p.input('V', 8, 26, 40, { value: s.item.VALUE });
          p.fkeys('F12=Cancel');
          const r = await ctx.display(p);
          if (r.aid === 'ENTER') { await setSysval(s.item.NAME, r.fields.V.trim().toUpperCase()); last = { text: `System value ${s.item.NAME} changed.` }; }
        } else last = { text: `${s.item.NAME} = ${s.item.VALUE}  (${s.item.TEXT})` };
      }
      return last;
    },
  });
}

// CALL QCMD: pantalla "Command Entry".
export async function commandEntry(ctx) {
  const hist = [];
  let cmdValue = '';
  let ret = null;
  let detailed = false;
  for (;;) {
    const p = new Panel({ fn: 'PGM-QCMD', keys: ['F3', 'F4', 'F9', 'F10', 'F11', 'F12', 'F13', 'F24', 'PAGEUP', 'PAGEDOWN'] });
    p.center(1, 'Command Entry', 'w');
    p.sysRight(1);
    p.text(2, 56, 'Request level:', 'g').text(2, 72, '1', 'w');
    p.text(3, 2, 'Previous commands and messages:', 'g');
    const shown = hist.filter((h) => detailed || !h.detail).slice(-14);
    shown.forEach((h, i) => p.text(4 + i, 2, h.t.slice(0, 79), h.a));
    p.more(18, false);
    p.text(19, 2, 'Type command, press Enter.', 'b');
    p.cmdLine(20, 'CMD', 153, cmdValue);
    p.fkeys('F3=Exit   F4=Prompt   F9=Retrieve   F10=Include detailed messages', 'F11=Display full      F12=Cancel    F13=Information Assistant  F24=More keys');
    cmdValue = '';
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'F10') { detailed = !detailed; continue; }
    if (r.aid === 'F9') {
      const cmds = hist.filter((h) => h.cmd);
      if (cmds.length) { ret = ret === null ? cmds.length - 1 : (ret - 1 + cmds.length) % cmds.length; cmdValue = cmds[ret].cmd; }
      continue;
    }
    const cmd = (r.fields.CMD || '').trim();
    if (!cmd) continue;
    ret = null;
    hist.push({ t: ` > ${cmd}`, a: 'w', cmd });
    try {
      const out = await runCommand(ctx, cmd, { prompt: r.aid === 'F4' });
      for (const m of out) for (const l of wrapText(m.text, 74)) hist.push({ t: `    ${l}`, a: 'g', detail: (m.sev || 0) === 0 && false });
    } catch (e) {
      if (e.signoff || e.disconnected) throw e;
      const m = e instanceof RpgCancel ? { text: msgText('CPF0549') } : toMsg(e);
      for (const l of wrapText(m.text, 74)) hist.push({ t: `    ${l}`, a: 'w' });
    }
  }
}
