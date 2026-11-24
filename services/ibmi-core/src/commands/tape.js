// Cinta virtual: CRTDEVTAP, DLTDEVD, DSPDEVD, WRKDEVD, VRYCFG, WRKCFGSTS, CRTIMGCLG, DLTIMGCLG, ADDIMGCLGE,
// RMVIMGCLGE, CHGIMGCLGE, LODIMGCLG, LODIMGCLGE, WRKIMGCLG, WRKIMGCLGE, INZTAP, DSPTAP, CHKTAP (ver tape.js).
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { Panel, padR, padL } from '../panel.js';
import * as T from '../tape.js';
import { sysDate, sysTime } from '../system.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const up = (s) => String(s ?? '').trim().toUpperCase();
const textVal = (t) => (!t || t === '*BLANK' ? '' : t);
const sec = () => import('../security.js');
async function needIoSysCfg(ctx, what) {
  const s = await sec();
  if (!s.hasSpecial(ctx.user, '*IOSYSCFG') && !s.hasSpecial(ctx.user, '*ALLOBJ')) throw new CLError('CPF9898', `Special authority *IOSYSCFG required for ${what}.`);
}
const when = (iso) => (iso ? `${sysDate(new Date(iso))} ${sysTime(new Date(iso))}` : '');

/** Muestra líneas de texto en un panel con desplazamiento (o las devuelve en lote). */
async function showLines(ctx, fn, title, lines, headRows = 0) {
  if (!ctx.interactive) return { text: lines.join('\n') };
  let top = 0;
  const per = 18 - headRows;
  for (;;) {
    const p = new Panel({ fn, keys: ['F3', 'F12', 'PAGEUP', 'PAGEDOWN'] });
    p.title(title);
    lines.slice(0, headRows).forEach((l, i) => p.text(3 + i, 2, l.slice(0, 78), i === headRows - 1 ? 'w' : 'g'));
    const body = lines.slice(headRows);
    body.slice(top, top + per).forEach((l, i) => p.text(3 + headRows + i, 2, l.slice(0, 78)));
    p.more(21, top + per < body.length);
    p.fkeys('F3=Exit   F12=Cancel');
    const r = await ctx.display(p);
    if (r.aid === 'PAGEDOWN') { if (top + per < body.length) top += per; continue; }
    if (r.aid === 'PAGEUP') { top = Math.max(0, top - per); continue; }
    return null;
  }
}

// ---------- Dispositivos ----------
def('CRTDEVTAP', 'Create Device Desc (Tape)', [P('DEVD', 'Device description', 'name', 10, { req: true }), P('RSRCNAME', 'Resource name', 'name', 10, { req: true, choices: 'Name, *VRT' }), P('ONLINE', 'Online at IPL', 'char', 4, { dft: '*YES', choices: '*YES, *NO' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' })], async (ctx, a) => {
  await needIoSysCfg(ctx, 'CRTDEVTAP');
  if (a.RSRCNAME !== '*VRT') throw new CLError('CPF9898', `Resource ${a.RSRCNAME} not found. This system has no tape hardware; specify RSRCNAME(*VRT) for a virtual tape device.`);
  await T.createTapeDevice(a.DEVD, { rsrcname: a.RSRCNAME, online: a.ONLINE, text: textVal(a.TEXT), owner: ctx.job.user });
  return { text: `Description for device ${a.DEVD} created.` };
});
def('DLTDEVD', 'Delete Device Description', [P('DEVD', 'Device description', 'name', 10, { req: true })], async (ctx, a) => {
  await needIoSysCfg(ctx, 'DLTDEVD');
  await T.deleteDevice(a.DEVD);
  return { text: `Description for device ${a.DEVD} deleted.` };
});
def('VRYCFG', 'Vary Configuration', [P('CFGOBJ', 'Configuration object', 'list', 100, { req: true }), P('CFGTYPE', 'Type', 'name', 5, { req: true, choices: '*DEV, *NWI, *LIN, *CTL' }), P('STATUS', 'Status', 'name', 8, { req: true, choices: '*ON, *OFF, *RESET' })], async (ctx, a) => {
  if (a.CFGTYPE !== '*DEV') throw new CLError('CPF9898', `CFGTYPE(${a.CFGTYPE}): only device descriptions (*DEV) can be varied on this system.`);
  const out = [];
  for (const n of a.CFGOBJ) {
    if (n === '*ALL' || n.endsWith('*')) {
      for (const d of (await T.tapeDevices()).filter((x) => n === '*ALL' || x.NAME.startsWith(n.slice(0, -1)))) { await T.varyDevice(d.NAME, a.STATUS !== '*OFF'); out.push({ id: '', text: `Vary ${a.STATUS === '*OFF' ? 'off' : 'on'} completed for device ${d.NAME}.`, sev: 0 }); }
      continue;
    }
    const d = await T.deviceRow(n);
    if (!d) throw new CLError('CPF9814', n);
    await T.varyDevice(n, a.STATUS !== '*OFF');
    out.push({ id: '', text: `Vary ${a.STATUS === '*OFF' ? 'off' : 'on'} completed for device ${d.NAME}.`, sev: 0 });
  }
  return out;
});
async function devdLines(d) {
  return [
    `Device description . . . . . . :   ${d.NAME}`, `Option . . . . . . . . . . . . :   *BASIC`, `Category of device . . . . . . :   *TAP`,
    `Device type  . . . . . . . . . :   ${d.data.type}`, `Device model . . . . . . . . . :   ${d.data.model}`, `Resource name  . . . . . . . . :   ${d.data.rsrcname}`,
    `Online at IPL  . . . . . . . . :   ${d.data.online}`, `Unload device at vary off  . . :   *YES`, `Status . . . . . . . . . . . . :   ${d.data.status}`,
    `Image catalog  . . . . . . . . :   ${d.data.imgclg || '*NONE'}`, `Text . . . . . . . . . . . . . :   ${d.TEXT}`,
  ];
}
def('DSPDEVD', 'Display Device Description', [P('DEVD', 'Device description', 'name', 10, { req: true }), P('OUTPUT', 'Output', 'char', 6, { dft: '*' })], async (ctx, a) => {
  const d = await T.deviceRow(a.DEVD);
  if (!d) throw new CLError('CPF9814', a.DEVD);
  return showLines(ctx, 'CMD-DSPDEVD', 'Display Device Description', await devdLines(d));
});
async function cfgList(filter) {
  const f = up(filter || '*ALL');
  return (await T.tapeDevices()).filter((d) => f === '*ALL' || d.NAME === f || (f.endsWith('*') && d.NAME.startsWith(f.slice(0, -1))) || (f === '*TAP'));
}
def('WRKDEVD', 'Work with Device Descriptions', [P('DEVD', 'Device description', 'name', 10, { dft: '*ALL' })], async (ctx, a) => {
  const l = await cfgList(a.DEVD);
  return showLines(ctx, 'CMD-WRKDEVD', 'Work with Device Descriptions', ['Device      Type   Text', ...l.map((d) => `${padR(d.NAME, 12)}${padR(d.data.type, 7)}${d.TEXT}`)], 1);
});
def('WRKCFGSTS', 'Work with Configuration Status', [P('CFGTYPE', 'Type', 'name', 5, { req: true, choices: '*DEV, *NWI, *LIN, *CTL, *NET' }), P('CFGD', 'Configuration description', 'name', 10, { dft: '*ALL', choices: 'Name, generic*, *ALL, *TAP' })], async (ctx, a) => {
  if (a.CFGTYPE !== '*DEV') return { text: `No ${a.CFGTYPE} configuration descriptions on this system.` };
  let message = null;
  for (;;) {
    const l = await cfgList(a.CFGD);
    const lines = l.map((d) => `${padR(d.NAME, 18)}${padR(d.data.status, 14)}${d.data.imgclg ? `Image catalog ${d.data.imgclg}` : ''}`);
    if (!ctx.interactive) return { text: ['Description       Status        -------------Job--------------', ...lines].join('\n') };
    const p = new Panel({ fn: 'CMD-WRKCFGSTS', keys: ['F3', 'F5', 'F12'] });
    p.title('Work with Configuration Status');
    p.sysName(2, 62);
    p.text(4, 2, 'Type options, press Enter.', 'b');
    p.text(5, 4, '1=Vary on   2=Vary off   5=Work with job   8=Work with description', 'b');
    p.text(6, 4, '9=Display mode status   13=Work with APPN status...', 'b');
    p.text(8, 2, 'Opt  Description     Status                -------------Job--------------', 'w');
    l.slice(0, 12).forEach((d, i) => { p.input(`O${i}`, 9 + i, 3, 2, {}); p.text(9 + i, 7, lines[i]); });
    p.more(21, l.length > 12);
    p.fkeys('F3=Exit   F4=Prompt   F12=Cancel   F23=More options   F24=More keys');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    try {
      for (const [i, d] of l.slice(0, 12).entries()) {
        const o = String(r.fields[`O${i}`] || '').trim();
        if (o === '1' || o === '2') { await T.varyDevice(d.NAME, o === '1'); message = { text: `Vary ${o === '1' ? 'on' : 'off'} completed for device ${d.NAME}.` }; }
        else if (o === '8') await showLines(ctx, 'CMD-DSPDEVD', 'Display Device Description', await devdLines(d));
        else if (o) message = { text: `Option ${o} not valid for device ${d.NAME}.`, sev: 30 };
      }
    } catch (e) { message = { id: e.msgId, text: e.message, sev: 40 }; }
  }
});

// ---------- Catálogos de imágenes ----------
def('CRTIMGCLG', 'Create Image Catalog', [P('IMGCLG', 'Image catalog', 'name', 10, { req: true }), P('DIR', 'Directory', 'text', 256, { req: true, lc: true }), P('TYPE', 'Type', 'name', 4, { dft: '*OPT', choices: '*OPT, *TAP' }), P('CRTDIR', 'Create directory', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' })], async (ctx, a) => {
  await needIoSysCfg(ctx, 'CRTIMGCLG');
  await T.createCatalog(a.IMGCLG, a.DIR, { type: a.TYPE, crtdir: a.CRTDIR === '*YES', text: textVal(a.TEXT), owner: ctx.job.user });
  return { text: `Image catalog ${a.IMGCLG} created.` };
});
def('DLTIMGCLG', 'Delete Image Catalog', [P('IMGCLG', 'Image catalog', 'name', 10, { req: true }), P('KEEP', 'Keep image files', 'char', 4, { dft: '*YES', choices: '*YES, *NO' })], async (ctx, a) => {
  await needIoSysCfg(ctx, 'DLTIMGCLG');
  await T.deleteCatalog(a.IMGCLG, { keep: a.KEEP !== '*NO' });
  return { text: `Image catalog ${a.IMGCLG} deleted.` };
});
def('ADDIMGCLGE', 'Add Image Catalog Entry', [P('IMGCLG', 'Image catalog', 'name', 10, { req: true }), P('FROMFILE', 'From file', 'text', 256, { req: true, lc: true, choices: "'path', *NEW" }), P('TOFILE', 'To file', 'text', 256, { dft: '*FROMFILE', lc: true }), P('IMGCLGIDX', 'Index', 'char', 6, { dft: '*AVAIL' }), P('IMGSIZ', 'Image size (MB)', 'char', 8, { dft: '1000' }), P('VOLNAM', 'Volume name', 'name', 6, { dft: '*TOFILE' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' })], async (ctx, a) => {
  await needIoSysCfg(ctx, 'ADDIMGCLGE');
  const r = await T.addEntry(a.IMGCLG, { fromfile: a.FROMFILE, tofile: a.TOFILE, volnam: a.VOLNAM, imgsiz: Number(String(a.IMGSIZ).replace(/\D/g, '')) || 1000, text: textVal(a.TEXT) });
  return { text: `Image catalog entry ${r.idx} (volume ${r.vol}) added to image catalog ${a.IMGCLG}.` };
});
def('RMVIMGCLGE', 'Remove Image Catalog Entry', [P('IMGCLG', 'Image catalog', 'name', 10, { req: true }), P('IMGCLGIDX', 'Index', 'char', 6, { dft: '*VOLNAM' }), P('VOLNAM', 'Volume name', 'name', 6, { dft: '*NONE' }), P('KEEP', 'Keep image file', 'char', 4, { dft: '*YES', choices: '*YES, *NO' })], async (ctx, a) => {
  await needIoSysCfg(ctx, 'RMVIMGCLGE');
  await T.removeEntry(a.IMGCLG, { idx: /^\d+$/.test(a.IMGCLGIDX) ? Number(a.IMGCLGIDX) : null, volnam: a.VOLNAM, keep: a.KEEP !== '*NO' });
  return { text: `Image catalog entry removed from image catalog ${a.IMGCLG}.` };
});
def('CHGIMGCLGE', 'Change Image Catalog Entry', [P('IMGCLG', 'Image catalog', 'name', 10, { req: true }), P('IMGCLGIDX', 'Index', 'char', 6, { req: true }), P('WRTPTC', 'Write protect', 'char', 5, { dft: '*SAME', choices: '*SAME, *YES, *NO' })], async (ctx, a) => {
  await T.changeEntry(a.IMGCLG, a.IMGCLGIDX, { wrtptc: a.WRTPTC });
  return { text: `Image catalog entry ${a.IMGCLGIDX} changed.` };
});
def('LODIMGCLG', 'Load or Unload Image Catalog', [P('IMGCLG', 'Image catalog', 'name', 10, { req: true }), P('DEV', 'Device', 'name', 10, { dft: '*NONE' }), P('OPTION', 'Option', 'name', 8, { dft: '*LOAD', choices: '*LOAD, *UNLOAD' })], async (ctx, a) => {
  if (a.OPTION === '*LOAD' && a.DEV === '*NONE') throw new CLError('CPD0072', 'DEV');
  await T.loadCatalog(a.IMGCLG, a.DEV, a.OPTION);
  return { text: a.OPTION === '*UNLOAD' ? `Image catalog ${a.IMGCLG} unloaded.` : `Image catalog ${a.IMGCLG} loaded on device ${a.DEV}.` };
});
def('LODIMGCLGE', 'Load/Unload/Mount IMGCLG Entry', [P('IMGCLG', 'Image catalog', 'name', 10, { req: true }), P('IMGCLGIDX', 'Index', 'char', 6, { req: true }), P('OPTION', 'Option', 'name', 8, { dft: '*MOUNT', choices: '*MOUNT, *LOAD, *UNLOAD' })], async (ctx, a) => {
  await T.loadEntry(a.IMGCLG, a.IMGCLGIDX, a.OPTION);
  return { text: `Image catalog entry ${a.IMGCLGIDX} ${a.OPTION === '*MOUNT' ? 'mounted' : a.OPTION === '*LOAD' ? 'loaded' : 'unloaded'}.` };
});
def('WRKIMGCLG', 'Work with Image Catalogs', [P('IMGCLG', 'Image catalog', 'name', 10, { dft: '*ALL' })], async (ctx, a) => {
  const l = (await T.catalogs()).filter((c) => a.IMGCLG === '*ALL' || c.NAME === a.IMGCLG);
  return showLines(ctx, 'CMD-WRKIMGCLG', 'Work with Image Catalogs', ['Catalog     Status      Type  Device      Text', ...l.map((c) => `${padR(c.NAME, 12)}${padR(c.data.status === '*READY' ? 'Ready' : 'Not ready', 12)}${padR(c.data.type.replace('*', ''), 6)}${padR(c.data.dev || '', 12)}${c.TEXT}`)], 1);
});
def('WRKIMGCLGE', 'Work with Image Catalog Entries', [P('IMGCLG', 'Image catalog', 'name', 10, { req: true })], async (ctx, a) => {
  const c = await T.catalogRow(a.IMGCLG);
  if (!c) throw new CLError('CPF9898', `Image catalog ${a.IMGCLG} not found.`);
  const lines = [
    `Image catalog  . . . :   ${c.NAME}      Status . . . :   ${c.data.status === '*READY' ? 'Ready' : 'Not ready'}`,
    `  Directory  . . . . :   ${c.data.dir}`,
    `Virtual device . . . :   ${c.data.dev || '*NONE'}`, '',
    'Index  Status      Volume   Image file              Size (MB)  Wrt ptc',
    ...c.data.entries.map((e) => `${padL(e.idx, 5)}  ${padR({ '*MOUNTED': 'Mounted', '*LOADED': 'Loaded', '*UNLOADED': 'Unloaded' }[e.status] || e.status, 12)}${padR(e.volume, 9)}${padR(e.file, 24)}${padL(e.size, 9)}  ${e.wrtptc === '*YES' ? 'Y' : 'N'}`),
  ];
  return showLines(ctx, 'CMD-WRKIMGCLGE', 'Work with Image Catalog Entries', lines, 5);
});

// ---------- Volúmenes ----------
def('INZTAP', 'Initialize Tape', [P('DEV', 'Device', 'name', 10, { req: true }), P('NEWVOL', 'New volume identifier', 'name', 6, { dft: '*NONE' }), P('NEWOWNID', 'New owner identifier', 'text', 14, { dft: '*BLANK' }), P('VOL', 'Volume identifier', 'name', 6, { dft: '*MOUNTED' }), P('CHECK', 'Check for active files', 'char', 6, { dft: '*YES', choices: '*YES, *NO, *FIRST' }), P('DENSITY', 'Tape density', 'char', 10, { dft: '*DEVTYPE' }), P('ENDOPT', 'End of tape option', 'name', 7, { dft: '*REWIND', choices: '*REWIND, *UNLOAD' }), P('CLEAR', 'Clear', 'char', 4, { dft: '*NO' })], async (ctx, a) => {
  const v = await T.initVolume(a.DEV, { newvol: a.NEWVOL, newownid: textVal(a.NEWOWNID), check: a.CHECK !== '*NO', endopt: a.ENDOPT });
  return { text: `Volume ${v} initialized on device ${a.DEV}.` };
});
async function volumeLines(dev, a) {
  const m = await T.volumeOf(dev);
  const v = m.vol;
  const lines = [
    `Volume identifier  . . . . . . . :   ${v.volume}`, `Owner identifier . . . . . . . . :   ${v.owner || ''}`, `Volume type  . . . . . . . . . . :   SL`,
    `Device . . . . . . . . . . . . . :   ${m.dev.NAME}`, `Image catalog / file . . . . . . :   ${m.clg.NAME} / ${m.entry.file}`, `Density  . . . . . . . . . . . . :   ${v.density}`,
    `Files on volume  . . . . . . . . :   ${v.files.length}`, '',
  ];
  const seq = a.SEQNBR && a.SEQNBR !== '*ALL' ? Number(a.SEQNBR) : null;
  const label = a.LABEL && a.LABEL !== '*ALL' ? up(a.LABEL) : null;
  const files = v.files.filter((f) => (!seq || f.seq === seq) && (!label || f.label === label));
  if (a.DATA === '*SAVRST') {
    for (const f of files) {
      const c = f.content || {};
      lines.push(`File sequence ${f.seq}   Label ${f.label}   Command ${f.cmd || ''}   Saved ${when(f.savedAt)} by ${f.savedBy || ''}`);
      lines.push('  Object                  Type      Attribute   Owner       Text');
      for (const o of c.objects || []) lines.push(`  ${padR(o.name, 24)}${padR(o.type, 10)}${padR(o.attr || '', 12)}${padR(o.owner || '', 12)}${String(o.text || '').slice(0, 20)}`);
      for (const o of (c.ifs || []).filter((x) => !x.parent)) lines.push(`  ${padR(o.path, 40).slice(0, 40)}  ${o.dir ? '*DIR' : '*STMF'}`);
      if (c.privateAuthorities) lines.push(`  ${(c.objects || []).filter((o) => o.type === '*USRPRF').length} user profiles, ${c.privateAuthorities.length} private authorities`);
      if (c.sysvals) lines.push(`  ${c.sysvals.length} system values`);
      lines.push('');
    }
  } else {
    lines.push('Seq    Label              Command     Objects  Save date/time        Expires');
    for (const f of files) lines.push(`${padL(f.seq, 5)}  ${padR(f.label, 19)}${padR(f.cmd || '', 12)}${padL(f.objects ?? 0, 7)}  ${padR(when(f.savedAt), 22)}${f.expdate || '*PERM'}`);
  }
  return lines;
}
def('DSPTAP', 'Display Tape', [P('DEV', 'Device', 'name', 10, { req: true }), P('VOL', 'Volume identifier', 'name', 6, { dft: '*MOUNTED' }), P('LABEL', 'File label', 'char', 17, { dft: '*ALL' }), P('SEQNBR', 'Sequence number', 'char', 8, { dft: '*ALL' }), P('DATA', 'Data type', 'name', 8, { dft: '*LABELS', choices: '*LABELS, *SAVRST, *VOLLABEL' }), P('ENDOPT', 'End of tape option', 'name', 7, { dft: '*REWIND' }), P('OUTPUT', 'Output', 'char', 6, { dft: '*', choices: '*, *PRINT' })], async (ctx, a) => {
  const lines = await volumeLines(a.DEV, a);
  if (a.DATA === '*VOLLABEL') lines.splice(8);
  if (a.OUTPUT === '*PRINT') { await obj.createSpool(ctx.job, 'QSYSTAP', lines, { usrdta: 'DSPTAP' }); return { text: lines.join('\n') }; }
  return showLines(ctx, 'CMD-DSPTAP', 'Display Tape Volume Information', lines, 8);
});
def('CHKTAP', 'Check Tape', [P('DEV', 'Device', 'name', 10, { req: true }), P('VOL', 'Volume identifier', 'name', 6, { dft: '*MOUNTED' }), P('SEQNBR', 'File sequence number', 'char', 8, { dft: '*NONE' }), P('LABEL', 'File label', 'char', 17, { dft: '*NONE' }), P('ENDOPT', 'End of tape option', 'name', 7, { dft: '*REWIND' })], async (ctx, a) => {
  const m = await T.volumeOf(a.DEV);
  if (a.VOL !== '*MOUNTED' && a.VOL !== m.vol.volume) throw new CLError('CPF9898', `Volume ${m.vol.volume} found on device ${a.DEV}; volume ${a.VOL} expected.`);
  if (a.LABEL !== '*NONE' || a.SEQNBR !== '*NONE') await T.readFile(a.DEV, { label: a.LABEL, seqnbr: a.SEQNBR === '*NONE' ? '*SEARCH' : a.SEQNBR, endopt: a.ENDOPT });
  return { text: `Volume ${m.vol.volume} on device ${a.DEV} checked: ${m.vol.files.length} files.` };
});
