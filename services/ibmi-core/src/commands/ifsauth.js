// Seguridad del IFS: CHGAUT, DSPAUT, WRKAUT, CHGOWN, CHGPGP y CPYAUT (ver ifsaut.js).
import { def } from './registry.js';
import { CLError } from '../messages.js';
import * as obj from '../objects.js';
import { Panel, padR } from '../panel.js';
import * as ifs from '../ifs.js';
import * as aut from '../ifsaut.js';
import { hasSpecial } from '../security.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const up = (s) => String(s ?? '').trim().toUpperCase();
const list = (v) => [].concat(v ?? []).flatMap((x) => String(x).toUpperCase().split(/\s+/)).filter(Boolean);
const cwdOf = (ctx) => ctx.job.cwd || ifs.homeDir(ctx.job.user);
const absPath = (ctx, p) => ifs.normPath(String(p || '.').replace(/^'|'$/g, ''), cwdOf(ctx));
const OBJ = P('OBJ', 'Object', 'text', 256, { req: true, lc: true });
const SUBTREE = P('SUBTREE', 'Directory subtree', 'char', 5, { dft: '*NONE', choices: '*NONE, *ALL, *DIR' });
const SYMLNK = P('SYMLNK', 'Symbolic link', 'char', 4, { dft: '*NO', choices: '*NO, *YES' });

/** Objetos que designa OBJ: ruta o patrón (*, ?) en el último componente, y SUBTREE. */
async function targets(ctx, raw, subtree = '*NONE') {
  const p = absPath(ctx, raw);
  if (ifs.isQsys(p)) throw new CLError('CPF9898', 'Use GRTOBJAUT, RVKOBJAUT or EDTOBJAUT for objects in /QSYS.LIB.');
  const base = p.slice(p.lastIndexOf('/') + 1);
  let out;
  if (/[*?]/.test(base)) {
    const dir = p.slice(0, p.lastIndexOf('/')) || '/';
    const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    out = (await ifs.list(dir)).filter((e) => re.test(e.name));
  } else {
    const st = await ifs.stat(p);
    if (!st) throw new CLError('CPFA0A9', p);
    out = [st];
  }
  if (subtree !== '*NONE') {
    const more = [];
    for (const e of out) if (e.dir) more.push(...(await ifs.walk(e.path, 64)).filter((x) => subtree === '*ALL' || x.dir));
    out.push(...more);
  }
  if (!out.length) throw new CLError('CPFA0A9', p);
  return out;
}

const userExists = async (u) => u === '*PUBLIC' || !!(await obj.getUser(u));

def('CHGAUT', 'Change Authority', [
  OBJ,
  P('USER', 'User', 'list', 100, { dft: '*NONE', choices: 'Name, *PUBLIC' }),
  P('DTAAUT', 'New data authorities', 'name', 8, { dft: '*NONE', choices: '*NONE, *RWX, *RX, *RW, *WX, *R, *W, *X, *EXCLUDE, *AUTL, *SAME' }),
  P('OBJAUT', 'New object authorities', 'list', 60, { dft: '*NONE', choices: '*NONE, *ALL, *OBJEXIST, *OBJMGT, *OBJALTER, *OBJREF, *SAME' }),
  P('AUTL', 'Authorization list', 'name', 10, { dft: '*NONE', choices: 'Name, *NONE, *REMOVE' }),
  SUBTREE, SYMLNK,
], async (ctx, a) => {
  const users = list(a.USER).filter((x) => x !== '*NONE');
  const autl = up(a.AUTL || '*NONE');
  const dta = up(a.DTAAUT || '*NONE');
  if (!users.length && autl === '*NONE') throw new CLError('CPD0072', 'USER');
  if (![...aut.DTA_VALUES, '*AUTL', '*SAME'].includes(dta)) throw new CLError('CPF9898', `Value ${dta} for DTAAUT not valid.`);
  if (!['*NONE', '*REMOVE'].includes(autl) && !(await obj.gw.rows(`SELECT NAME FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*AUTL'`, [autl])).length) throw new CLError('CPF2283', autl);
  for (const u of users) if (!(await userExists(u))) throw new CLError('CPF2204', u);
  const objs = await targets(ctx, a.OBJ, a.SUBTREE);
  let n = 0;
  for (const o of objs) {
    await aut.mayManage(o.path);
    for (const u of users) await aut.changeAuth(o.path, u, dta, list(a.OBJAUT));
    if (autl !== '*NONE') await aut.setAutl(o.path, autl === '*REMOVE' ? '*NONE' : autl);
    n++;
  }
  return { text: `Authority changed for ${n} object(s).` };
});

def('CHGOWN', 'Change Owner', [OBJ, P('NEWOWN', 'New owner', 'name', 10, { req: true }), P('RVKOLDAUT', 'Revoke current owner authority', 'char', 4, { dft: '*YES', choices: '*YES, *NO' }), SUBTREE, SYMLNK], async (ctx, a) => {
  const nu = up(a.NEWOWN);
  if (!(await obj.getUser(nu))) throw new CLError('CPF2204', nu);
  const objs = await targets(ctx, a.OBJ, a.SUBTREE);
  for (const o of objs) {
    if (!hasSpecial(ctx.user, '*ALLOBJ') && aut.metaOf(o.path).owner !== ctx.job.user) throw new CLError('CPFA09C', o.path);
    await aut.changeOwner(o.path, nu, a.RVKOLDAUT !== '*NO');
  }
  return { text: `Ownership changed for ${objs.length} object(s).` };
});

def('CHGPGP', 'Change Primary Group', [OBJ, P('NEWPGP', 'New primary group', 'name', 10, { req: true, choices: 'Name, *NONE' }), P('RVKOLDAUT', 'Revoke old authority', 'char', 4, { dft: '*YES', choices: '*YES, *NO' }), SUBTREE, SYMLNK], async (ctx, a) => {
  const g = up(a.NEWPGP);
  if (g !== '*NONE') {
    const prf = await obj.getUser(g);
    if (!prf) throw new CLError('CPF2204', g);
  }
  const objs = await targets(ctx, a.OBJ, a.SUBTREE);
  for (const o of objs) {
    if (!hasSpecial(ctx.user, '*ALLOBJ') && aut.metaOf(o.path).owner !== ctx.job.user) throw new CLError('CPFA09C', o.path);
    if (g !== '*NONE' && aut.metaOf(o.path).owner === g) throw new CLError('CPF9898', `Primary group ${g} cannot be the owner of ${o.path}.`);
    await aut.changePgp(o.path, g, a.RVKOLDAUT !== '*NO');
  }
  return { text: `Primary group changed for ${objs.length} object(s).` };
});

def('CPYAUT', 'Copy Authority', [P('FROMOBJ', 'From object', 'text', 256, { req: true, lc: true }), P('TOOBJ', 'To object', 'text', 256, { req: true, lc: true })], async (ctx, a) => {
  const from = absPath(ctx, a.FROMOBJ);
  if (!(await ifs.stat(from))) throw new CLError('CPFA0A9', from);
  const objs = await targets(ctx, a.TOOBJ);
  for (const o of objs) { await aut.mayManage(o.path); await aut.copyAuth(from, o.path); }
  return { text: `Authority copied to ${objs.length} object(s).` };
});

// ---------- DSPAUT / WRKAUT ----------
const X = (s, k) => (s.has(k) ? 'X' : ' ');
function authorityLines(path, type) {
  const l = aut.authorityList(path);
  const lines = [
    `Object . . . . . . . . . . . :   ${path}`,
    `Type . . . . . . . . . . . . :   ${type}`,
    `Owner  . . . . . . . . . . . :   ${l.owner}`,
    `Primary group  . . . . . . . :   ${l.pgp}`,
    `Authorization list . . . . . :   ${l.autl}`,
    '',
    '                     Data      --Object Authorities--',
    'User                 Authority  Exist  Mgt  Alter  Ref',
  ];
  for (const u of l.users) lines.push(`${padR(u.user, 21)}${padR(aut.dtaLabel(u), 11)}  ${X(u.obj, '*OBJEXIST')}     ${X(u.obj, '*OBJMGT')}     ${X(u.obj, '*OBJALTER')}     ${X(u.obj, '*OBJREF')}`);
  return lines;
}

def('DSPAUT', 'Display Authority', [OBJ, P('OUTPUT', 'Output', 'char', 6, { dft: '*', choices: '*, *PRINT' })], async (ctx, a) => {
  const [o] = await targets(ctx, a.OBJ);
  const lines = authorityLines(o.path, o.dir ? '*DIR' : '*STMF');
  if (a.OUTPUT === '*PRINT') await obj.createSpool(ctx.job, 'QSYSPRT', lines, { usrdta: 'DSPAUT' });
  if (!ctx.interactive || a.OUTPUT === '*PRINT') return { text: lines.join('\n') };
  const p = new Panel({ fn: 'CMD-DSPAUT', keys: ['F3', 'F12'] });
  p.title('Display Authority');
  lines.forEach((l, i) => p.text(3 + i, 1, l.slice(0, 79), i === 6 || i === 7 ? 'w' : 'g'));
  p.more(21, false);
  p.fkeys('F3=Exit   F11=Display detail data authorities   F12=Cancel');
  await ctx.display(p);
  return null;
}, { interactive: false });

async function editUser(ctx, path, user, cur) {
  const q = new Panel({ fn: 'CMD-WRKAUT-CHG', keys: ['F12'] });
  q.title(cur ? 'Change User Authority' : 'Add User');
  q.info(3, 2, 'Object', path.slice(-50), 18);
  q.text(5, 2, 'Type choices, press Enter.', 'b');
  q.label(7, 2, 'User'); q.input('U', 7, 36, 10, { value: user || '' });
  q.label(8, 2, 'New data authorities'); q.input('D', 8, 36, 8, { value: cur ? aut.dtaLabel(cur) : '*NONE' });
  q.text(8, 48, '*NONE, *RWX, *RX, *RW, *WX...', 'b');
  q.label(9, 2, 'New object authorities');
  const objs = cur ? [...cur.obj] : [];
  for (let i = 0; i < 4; i++) q.input(`O${i}`, 9 + i, 36, 10, { value: objs[i] || (i === 0 ? '*NONE' : '') });
  q.text(9, 48, '*NONE, *ALL, *OBJEXIST...', 'b');
  q.fkeys('F12=Cancel');
  const z = await ctx.display(q);
  if (z.aid !== 'ENTER') return null;
  const u = up(z.fields.U);
  if (!u) return null;
  if (!(await userExists(u))) throw new CLError('CPF2204', u);
  const ol = [0, 1, 2, 3].map((i) => up(z.fields[`O${i}`])).filter(Boolean);
  await aut.changeAuth(path, u, up(z.fields.D) || '*NONE', ol.length ? ol : ['*NONE']);
  return u;
}

def('WRKAUT', 'Work with Authority', [OBJ], async (ctx, a) => {
  const [o] = await targets(ctx, a.OBJ);
  let message = null;
  for (;;) {
    const l = aut.authorityList(o.path);
    const p = new Panel({ fn: 'CMD-WRKAUT', keys: ['F3', 'F5', 'F12'] });
    p.title('Work with Authority');
    p.info(3, 1, 'Object', o.path.slice(-55), 22);
    p.info(4, 1, 'Type', o.dir ? '*DIR' : '*STMF', 22);
    p.info(5, 1, 'Owner', l.owner, 22);
    p.info(6, 1, 'Primary group', l.pgp, 22);
    p.info(7, 1, 'Authorization list', l.autl, 22);
    p.text(9, 1, 'Type options, press Enter.', 'b');
    p.text(10, 3, '1=Add user   2=Change user authority   4=Remove user', 'b');
    p.text(12, 1, '                        Data      --Object Authorities--', 'w');
    p.text(13, 1, 'Opt  User                Authority  Exist  Mgt  Alter  Ref', 'w');
    p.input('NEW', 14, 2, 2, {});
    p.input('NEWU', 14, 6, 10, {});
    const rows = l.users.slice(0, 7);
    rows.forEach((u, i) => {
      p.input(`OPT${i}`, 15 + i, 2, 2, {});
      p.text(15 + i, 6, `${padR(u.user, 20)}${padR(aut.dtaLabel(u), 11)} ${X(u.obj, '*OBJEXIST')}      ${X(u.obj, '*OBJMGT')}     ${X(u.obj, '*OBJALTER')}     ${X(u.obj, '*OBJREF')}`);
    });
    p.more(22, l.users.length > 7);
    p.fkeys('F3=Exit   F5=Refresh   F11=Nondisplay detail   F12=Cancel   F24=More keys');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'F5') continue;
    try {
      if (String(r.fields.NEW || '').trim() === '1') {
        await aut.mayManage(o.path);
        const u = await editUser(ctx, o.path, up(r.fields.NEWU), null);
        if (u) message = { text: `Authority given to user ${u}.` };
        continue;
      }
      for (const [i, u] of rows.entries()) {
        const opt = String(r.fields[`OPT${i}`] || '').trim();
        if (!opt) continue;
        await aut.mayManage(o.path);
        if (opt === '2') { if (await editUser(ctx, o.path, u.user, u)) message = { text: `Authority changed for user ${u.user}.` }; }
        else if (opt === '4') {
          if (u.kind === 'owner' || u.kind === 'public') throw new CLError('CPF9898', `Authority for ${u.user} cannot be removed; change it with option 2.`);
          await aut.changeAuth(o.path, u.user, '*NONE', ['*NONE']);
          if (u.kind === 'pgp') await aut.changePgp(o.path, '*NONE');
          message = { text: `Authority removed for user ${u.user}.` };
        } else message = { text: `Option ${opt} not valid.`, sev: 30 };
      }
    } catch (e) { message = { id: e.msgId, text: e.message, sev: 40 }; }
  }
}, { interactive: true });
