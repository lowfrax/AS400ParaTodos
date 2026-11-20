// Programming Development Manager: STRPDM, WRKLIBPDM, WRKOBJPDM, WRKMBRPDM.
import { Panel, padR } from '../panel.js';
import { workWith, execFromLine, retrieve, confirmDelete } from './common.js';
import { libraries, listObjects, listMembers, removeMember, updateMemberInfo, syncSqlTables, gw, findObject, readMember, createSpool, libExists } from '../objects.js';
import { CLError, msgText } from '../messages.js';
import { seu } from './seu.js';
import { COMPILE_CMD, submitJob } from '../runtime/build.js';

const PDM_FKEYS = ['F3=Exit          F4=Prompt             F5=Refresh            F6=Create', 'F9=Retrieve      F10=Command entry     F23=More options      F24=More keys'];

export async function strpdm(ctx) {
  let message = null;
  const st = {};
  let cmdValue = '';
  for (;;) {
    const p = new Panel({ fn: 'MNU-PDM', keys: ['F3', 'F4', 'F9', 'F10', 'F12', 'F18'] });
    p.center(1, 'Programming Development Manager (PDM)', 'w');
    p.text(3, 2, 'Select one of the following:', 'b');
    p.text(5, 7, ' 1. Work with libraries', 'g');
    p.text(6, 7, ' 2. Work with objects', 'g');
    p.text(7, 7, ' 3. Work with members', 'g');
    p.text(9, 7, ' 9. Work with user-defined options', 'g');
    p.text(19, 2, 'Selection or command', 'g');
    p.cmdLine(20, 'CMD', 153, cmdValue);
    p.fkeys('F3=Exit     F4=Prompt     F9=Retrieve     F10=Command entry', 'F12=Cancel     F18=Change defaults');
    if (message) p.msg(message);
    message = null;
    cmdValue = '';
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'F9') { cmdValue = retrieve(ctx.session, st) || ''; continue; }
    if (r.aid === 'F10') { message = await execFromLine(ctx, 'CALL QCMD'); continue; }
    const v = (r.fields.CMD || '').trim();
    if (v === '1') message = await specify(ctx, 'Libraries');
    else if (v === '2') message = await specify(ctx, 'Objects');
    else if (v === '3') message = await specify(ctx, 'Members');
    else if (v === '9') message = 'User-defined options are not available.';
    else if (v) message = await execFromLine(ctx, v, r.aid === 'F4');
  }
}

async function specify(ctx, what) {
  const p = new Panel({ fn: 'MNU-PDM', keys: ['F3', 'F4', 'F5', 'F12'] });
  p.center(1, `Specify ${what} to Work With`, 'w');
  p.text(3, 2, 'Type choice, press Enter.', 'b');
  if (what === 'Libraries') {
    p.label(5, 2, 'Library', 32); p.input('LIB', 5, 36, 10, { value: '*LIBL' }); p.text(5, 49, '*LIBL, name, *generic*,', 'g');
    p.text(6, 49, '*ALL, *ALLUSR, *USRLIBL,', 'g'); p.text(7, 49, '*CURLIB', 'g');
  } else if (what === 'Objects') {
    p.label(5, 2, 'Library', 32); p.input('LIB', 5, 36, 10, { value: ctx.curlib }); p.text(5, 49, '*CURLIB, name', 'g');
    p.text(7, 2, 'Object:', 'g');
    p.label(8, 4, 'Name', 30); p.input('OBJ', 8, 36, 10, { value: '*ALL' }); p.text(8, 49, '*ALL, name, *generic*', 'g');
    p.label(9, 4, 'Type', 30); p.input('TYPE', 9, 36, 10, { value: '*ALL' }); p.text(9, 49, '*ALL, *type', 'g');
  } else {
    p.label(5, 2, 'File', 32); p.input('FILE', 5, 36, 10, { value: 'QRPGLESRC' }); p.text(5, 49, 'Name, F4 for list', 'g');
    p.label(6, 4, 'Library', 30); p.input('LIB', 6, 38, 10, { value: ctx.curlib }); p.text(6, 51, '*CURLIB, *LIBL, name', 'g');
    p.text(8, 2, 'Member:', 'g');
    p.label(9, 4, 'Name', 30); p.input('MBR', 9, 36, 10, { value: '*ALL' }); p.text(9, 49, '*ALL, name, *generic*', 'g');
    p.label(10, 4, 'Type', 30); p.input('TYPE', 10, 36, 10, { value: '*ALL' }); p.text(10, 49, '*ALL, type, *generic*', 'g');
  }
  p.fkeys('F3=Exit   F4=Prompt   F5=Refresh   F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return null;
  const f = (n) => (r.fields[n] || '').trim().toUpperCase();
  try {
    if (what === 'Libraries') await wrklibpdm(ctx, f('LIB') || '*LIBL');
    else if (what === 'Objects') await wrkobjpdm(ctx, ctx.resolveLib(f('LIB')), f('OBJ') || '*ALL', f('TYPE') || '*ALL');
    else await wrkmbrpdm(ctx, f('LIB') === '*LIBL' ? null : ctx.resolveLib(f('LIB')), f('FILE'), f('MBR') || '*ALL', f('TYPE') || '*ALL');
  } catch (e) {
    if (e instanceof CLError) return { id: e.msgId, text: e.message, sev: e.sev };
    throw e;
  }
  return null;
}

export async function wrklibpdm(ctx, list = '*LIBL') {
  return workWith(ctx, {
    fn: 'CMD-WRKLIBPDM',
    title: 'Work with Libraries Using PDM',
    header: (p) => { p.label(3, 2, 'List type', 25); p.text(3, 27, ':', 'g'); p.text(3, 30, list, 'w'); return 5; },
    opts: [' 2=Change         3=Copy           5=Display        7=Rename', ' 8=Display description             9=Save          10=Restore  ...'],
    colHead: 'Opt  Library     Type        Text',
    load: async () => {
      const libs = await libraries();
      const byName = new Map(libs.map((l) => [l.NAME, l]));
      if (list === '*LIBL') return ctx.libl.filter((n) => byName.has(n)).map((n) => byName.get(n));
      if (list === '*USRLIBL') return ctx.job.libl.filter((n) => byName.has(n)).map((n) => byName.get(n));
      if (list === '*CURLIB') return byName.has(ctx.curlib) ? [byName.get(ctx.curlib)] : [];
      if (list === '*ALLUSR') return libs.filter((l) => !l.NAME.startsWith('Q') || ['QGPL'].includes(l.NAME));
      if (list === '*ALL') return libs;
      if (list.endsWith('*')) return libs.filter((l) => l.NAME.startsWith(list.slice(0, -1)));
      return libs.filter((l) => l.NAME === list);
    },
    key: (l) => l.NAME,
    row: (l) => `${padR(l.NAME, 10)}  ${padR(`*${l.ATTR}${l.NAME.startsWith('Q') && l.NAME !== 'QGPL' && l.NAME !== 'QTEMP' ? '-SYS' : ''}`, 10)}  ${padR(l.TEXT, 50)}`,
    fkeys: PDM_FKEYS,
    keys: { F6: async () => execFromLine(ctx, 'CRTLIB', true), F10: async () => execFromLine(ctx, 'CALL QCMD') },
    act: async (sels) => {
      let last = null;
      for (const s of sels) {
        if (s.opt === '12' || s.opt === '5') await wrkobjpdm(ctx, s.item.NAME);
        else if (s.opt === '4') last = await execFromLine(ctx, `DLTLIB LIB(${s.item.NAME})`);
        else if (s.opt === '8') last = { text: `Library ${s.item.NAME}: ${s.item.TEXT || '(no text)'}, owner ${s.item.OWNER}.` };
        else last = { id: 'CPD6A01', text: msgText('CPD6A01', s.opt), sev: 30 };
      }
      return last;
    },
  });
}

export async function wrkobjpdm(ctx, lib, obj = '*ALL', type = '*ALL') {
  if (!(await libExists(lib))) throw new CLError('CPF2110', lib);
  return workWith(ctx, {
    fn: 'CMD-WRKOBJPDM',
    title: 'Work with Objects Using PDM',
    header: (p) => {
      p.label(3, 2, 'Library', 17); p.text(3, 19, ':', 'g'); p.text(3, 22, lib, 'w');
      p.label(3, 38, 'Position to', 28); p.input('POS', 3, 67, 10, {});
      p.label(4, 38, 'Position to type', 28); p.input('POST', 4, 67, 10, {});
      return 6;
    },
    opts: ['2=Change        3=Copy          4=Delete       5=Display       7=Rename', '8=Display description           9=Save        10=Restore      11=Move ...'],
    colHead: 'Opt  Object      Type        Attribute   Text',
    load: async () => { await syncSqlTables(lib); return (await listObjects(lib, obj, type)).filter((o) => !(lib === 'QSYS' && o.TYPE === '*LIB')); },
    key: (o) => `${o.NAME}/${o.TYPE}`,
    row: (o) => `${padR(o.NAME, 10)}  ${padR(o.TYPE, 10)}  ${padR(o.ATTR, 10)}  ${padR(o.TEXT, 40)}`,
    fkeys: PDM_FKEYS,
    keys: { F6: async () => execFromLine(ctx, 'CRTSRCPF', true), F10: async () => execFromLine(ctx, 'CALL QCMD') },
    act: async (sels) => {
      let last = null;
      const del = sels.filter((s) => s.opt === '4');
      if (del.length && await confirmDelete(ctx, 'Confirm Delete of Objects', 'Opt  Object      Type        Attribute', del.map((s) => `${padR(s.item.NAME, 10)}  ${padR(s.item.TYPE, 10)}  ${s.item.ATTR}`))) {
        for (const s of del) last = await execFromLine(ctx, `DLTOBJ OBJ(${lib}/${s.item.NAME}) OBJTYPE(${s.item.TYPE})`);
      }
      for (const s of sels) {
        const o = s.item;
        if (s.opt === '4') continue;
        if (s.opt === '12') {
          if (o.TYPE === '*FILE' && o.ATTR === 'PF-SRC') await wrkmbrpdm(ctx, lib, o.NAME);
          else last = { text: `Option 12 not valid for object type ${o.TYPE}.`, sev: 30 };
        } else if (s.opt === '16') {
          if (o.TYPE === '*PGM') last = await execFromLine(ctx, `CALL PGM(${lib}/${o.NAME})`);
          else last = { id: 'CPD6A01', text: `Option 16 not valid for object type ${o.TYPE}.`, sev: 30 };
        } else if (s.opt === '5') {
          if (o.TYPE === '*FILE' && (o.ATTR === 'PF' || o.ATTR === 'LF')) last = await execFromLine(ctx, `DSPPFM FILE(${lib}/${o.NAME})`);
          else if (o.TYPE === '*FILE' && o.ATTR === 'PF-SRC') await wrkmbrpdm(ctx, lib, o.NAME);
          else last = await execFromLine(ctx, `DSPOBJD OBJ(${lib}/${o.NAME}) OBJTYPE(${o.TYPE})`);
        } else if (s.opt === '8') last = await execFromLine(ctx, `DSPOBJD OBJ(${lib}/${o.NAME}) OBJTYPE(${o.TYPE})`);
        else if (s.opt === '18' && o.TYPE === '*FILE') last = await execFromLine(ctx, `DSPPFM FILE(${lib}/${o.NAME})`);
        else last = { id: 'CPD6A01', text: msgText('CPD6A01', s.opt), sev: 30 };
      }
      return last;
    },
  });
}

export async function wrkmbrpdm(ctx, libIn, file, mbr = '*ALL', type = '*ALL') {
  let lib = libIn;
  if (!lib) {
    const o = await findObject(gw, file, '*FILE', '*LIBL', ctx.libl);
    if (!o) throw new CLError('CPF9812', file, '*LIBL');
    lib = o.LIB;
  }
  const fo = await findObject(gw, file, '*FILE', lib, []);
  if (!fo) throw new CLError('CPF9812', file, lib);
  return workWith(ctx, {
    fn: 'CMD-WRKMBRPDM',
    title: 'Work with Members Using PDM',
    header: (p) => {
      p.label(3, 2, 'File', 17); p.text(3, 19, ':', 'g'); p.text(3, 22, file, 'w');
      p.label(4, 4, 'Library', 15); p.text(4, 19, ':', 'g'); p.text(4, 24, lib, 'w');
      p.label(4, 44, 'Position to', 22); p.input('POS', 4, 67, 10, {});
      return 6;
    },
    opts: ['2=Edit         3=Copy  4=Delete 5=Display       6=Print     7=Rename', '8=Display description  9=Save  13=Change text  14=Compile  15=Create module...'],
    colHead: 'Opt  Member      Type        Text',
    load: async () => (await listMembers(lib, file)).filter((m) => (mbr === '*ALL' || m.MBR === mbr || (mbr.endsWith('*') && m.MBR.startsWith(mbr.slice(0, -1)))) && (type === '*ALL' || m.TYPE === type)),
    key: (m) => m.MBR,
    row: (m) => `${padR(m.MBR, 10)}  ${padR(m.TYPE, 10)}  ${padR(m.TEXT, 50)}`,
    fkeys: PDM_FKEYS,
    keys: {
      F6: async () => execFromLine(ctx, `STRSEU SRCFILE(${lib}/${file})`, true),
      F10: async () => execFromLine(ctx, 'CALL QCMD'),
    },
    act: async (sels) => {
      let last = null;
      const del = sels.filter((s) => s.opt === '4');
      if (del.length && await confirmDelete(ctx, 'Confirm Delete of Members', 'Opt  Member      Type', del.map((s) => `${padR(s.item.MBR, 10)}  ${s.item.TYPE}`))) {
        for (const s of del) { await removeMember(lib, file, s.item.MBR); last = { id: 'CPC3101', text: msgText('CPC3101', s.item.MBR, file, lib) }; }
      }
      for (const s of sels) {
        const m = s.item;
        switch (s.opt) {
          case '4': break;
          case '2': last = await seu(ctx, { lib, file, mbr: m.MBR, type: m.TYPE, mode: 'edit' }); break;
          case '5': last = await seu(ctx, { lib, file, mbr: m.MBR, type: m.TYPE, mode: 'browse' }); break;
          case '6': {
            const src = await readMember(gw, lib, file, m.MBR);
            await createSpool(ctx.job, m.MBR, src.map((l) => `${(l.seq.toFixed(2)).padStart(7, '0')}  ${l.text}`), { usrdta: file });
            last = { text: `Member ${m.MBR} printed to spooled file ${m.MBR}.` };
            break;
          }
          case '13': last = await changeText(ctx, lib, file, m); break;
          case '14': {
            const cmd = COMPILE_CMD[m.TYPE];
            if (!cmd) { last = { text: `Member type ${m.TYPE} cannot be compiled.`, sev: 30 }; break; }
            const kw = cmd === 'CRTPF' || cmd === 'CRTDSPF' ? 'FILE' : cmd === 'CRTSQLRPGI' ? 'OBJ' : 'PGM';
            const extra = cmd === 'CRTPF' ? ' REPLACE(*YES)' : '';
            last = await submitJob(ctx, `${cmd} ${kw}(${ctx.curlib === lib ? lib : lib}/${m.MBR}) SRCFILE(${lib}/${file}) SRCMBR(${m.MBR})${extra}`, m.MBR);
            break;
          }
          case '8': last = { text: `Member ${m.MBR}: type ${m.TYPE}, ${m.NLINES} records, changed ${String(m.CHANGED || '').slice(0, 19)}.` }; break;
          default: last = { id: 'CPD6A01', text: msgText('CPD6A01', s.opt), sev: 30 };
        }
      }
      return last;
    },
  });
}

async function changeText(ctx, lib, file, m) {
  const p = new Panel({ fn: 'CMD-CHGPFM', keys: ['F12'] });
  p.center(1, 'Change Text', 'w');
  p.info(3, 2, 'Member', m.MBR, 20);
  p.info(4, 2, 'File', file, 20);
  p.label(6, 2, 'Text', 20); p.input('TEXT', 6, 24, 50, { value: m.TEXT, lower: true });
  p.fkeys('F12=Cancel');
  const r = await ctx.display(p);
  if (r.aid !== 'ENTER') return null;
  await updateMemberInfo(lib, file, m.MBR, { type: m.TYPE, text: r.fields.TEXT.trim() });
  return { text: `Text for member ${m.MBR} changed.` };
}
