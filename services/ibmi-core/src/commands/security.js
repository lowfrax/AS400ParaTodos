// Mandatos de seguridad de objetos: GRTOBJAUT, RVKOBJAUT, EDTOBJAUT, DSPOBJAUT, CHGOBJOWN, WRKOBJOWN y listas de
// autorizaciones (CRTAUTL, DLTAUTL, ADDAUTLE, CHGAUTLE, RMVAUTLE, DSPAUTL, EDTAUTL, DSPAUTLOBJ). CHGLIB CRTAUT.
import { def } from './registry.js';
import { CLError, msg } from '../messages.js';
import * as obj from '../objects.js';
import { gw } from '../objects.js';
import { Panel, padR } from '../panel.js';
import * as sec from '../security.js';

const P = (kw, prompt, type, len, o = {}) => ({ kw, prompt, type, len, ...o });
const up = (s) => String(s ?? '').trim().toUpperCase();
const list = (v) => [].concat(v ?? []).flatMap((x) => String(x).toUpperCase().split(/\s+/)).filter(Boolean);
const AUT_CHOICES = '*CHANGE, *ALL, *USE, *EXCLUDE, *AUTL, *OBJOPR, *OBJMGT, *OBJEXIST, *OBJALTER, *OBJREF, *READ, *ADD, *UPD, *DLT, *EXECUTE';

/** Objetos que designa OBJ(bib/nombre|genérico*|*ALL) OBJTYPE(tipo|*ALL). */
async function resolveObjects(ctx, q, type) {
  const name = up(q.obj);
  const t = up(type || '*ALL');
  if (t === '*LIB' || (q.lib === 'QSYS' && t === '*LIB')) {
    const r = await sec.objectRow('QSYS', name, '*LIB');
    if (!r) throw new CLError('CPF2110', name);
    return [r];
  }
  const libs = !q.lib || q.lib === '*LIBL' ? ctx.libl : [ctx.resolveLib(q.lib)];
  const out = [];
  for (const lib of libs) {
    let rows = await gw.rows(`SELECT LIB, NAME, TYPE, ATTR, OWNER, TEXT FROM QSYS.OBJECTS WHERE LIB = ?${t === '*ALL' ? '' : ' AND TYPE = ?'}`, t === '*ALL' ? [lib] : [lib, t]);
    rows = rows.filter((r) => name === '*ALL' || r.NAME === name || (name.endsWith('*') && r.NAME.startsWith(name.slice(0, -1))));
    out.push(...rows);
    if (rows.length && (!q.lib || q.lib === '*LIBL') && !name.endsWith('*') && name !== '*ALL') break;
  }
  if (!out.length) {
    if (t !== '*ALL' && t !== '*FILE') throw new CLError('CPF9801', name, q.lib || '*LIBL');
    const f = t === '*FILE' ? await obj.findObject(gw, name, '*FILE', !q.lib || q.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(q.lib), ctx.libl) : null;
    if (f) return [f];
    throw new CLError('CPF9801', name, q.lib || '*LIBL');
  }
  return out;
}

/** El que cambia autorizaciones debe ser el propietario, tener *ALLOBJ o *OBJMGT sobre el objeto. */
async function mayManage(ctx, o) {
  if (sec.hasSpecial(ctx.user, '*ALLOBJ') || o.OWNER === ctx.job.user) return;
  if (!(await sec.hasAuthority(ctx.user, o, ['*OBJMGT']))) throw new CLError('CPF2189', o.NAME, o.LIB, o.TYPE);
}

async function userOrAutlExists(u) {
  if (u === '*PUBLIC') return true;
  return !!(await obj.getUser(u));
}

async function grant(ctx, o, users, auts, { replace = false } = {}) {
  const rows = await sec.authRows(o.LIB, o.NAME, o.TYPE);
  for (const u of users) {
    if (!(await userOrAutlExists(u))) throw new CLError('CPF2204', u);
    const prev = rows.find((r) => r.USR === u);
    let value;
    if (auts.includes('*AUTL')) {
      if (u !== '*PUBLIC') throw new CLError('CPF9898', 'AUT(*AUTL) is valid only for USER(*PUBLIC).');
      value = '*AUTL';
    } else if (replace || !prev || String(prev.AUT).toUpperCase() === '*AUTL') value = [...sec.expand(auts)].join(' ');
    else value = [...new Set([...sec.expand(prev.AUT), ...sec.expand(auts)])].join(' ');
    if (auts.includes('*EXCLUDE')) value = '*EXCLUDE';
    await sec.setPrivate(o.LIB, o.NAME, o.TYPE, u, value || '*EXCLUDE');
  }
}

def('GRTOBJAUT', 'Grant Object Authority', [
  P('OBJ', 'Object', 'qual', 10, { req: true, choices: 'Name, generic*, *ALL' }),
  P('OBJTYPE', 'Object type', 'name', 10, { req: true, choices: '*ALL, *CMD, *DTAARA, *DTAQ, *FILE, *LIB, *MENU, *MSGF, *PGM, *SRVPGM, *USRPRF…' }),
  P('USER', 'Users', 'list', 100, { dft: '*NONE', choices: 'Name, *PUBLIC' }),
  P('AUT', 'Authority', 'list', 100, { dft: '*CHANGE', choices: AUT_CHOICES }),
  P('AUTL', 'Authorization list', 'name', 10, { dft: '*NONE' }),
  P('REPLACE', 'Replace authority', 'char', 4, { dft: '*NO', choices: '*NO, *YES' }),
], async (ctx, a) => {
  const objs = await resolveObjects(ctx, a.OBJ, a.OBJTYPE);
  const users = list(a.USER).filter((x) => x !== '*NONE');
  const autl = up(a.AUTL || '*NONE');
  if (!users.length && autl === '*NONE') throw new CLError('CPD0072', 'USER');
  if (autl !== '*NONE' && !(await sec.objectRow('QSYS', autl, '*AUTL'))) throw new CLError('CPF2283', autl);
  for (const o of objs) {
    await mayManage(ctx, o);
    if (users.length) await grant(ctx, o, users, list(a.AUT), { replace: a.REPLACE === '*YES' });
    if (autl !== '*NONE') await sec.setPrivate(o.LIB, o.NAME, o.TYPE, '*AUTL', autl);
  }
  return [msg('CPC2201')];
});

def('RVKOBJAUT', 'Revoke Object Authority', [
  P('OBJ', 'Object', 'qual', 10, { req: true, choices: 'Name, generic*, *ALL' }),
  P('OBJTYPE', 'Object type', 'name', 10, { req: true }),
  P('USER', 'Users', 'list', 100, { dft: '*NONE', choices: 'Name, *PUBLIC, *ALL' }),
  P('AUT', 'Authority', 'list', 100, { dft: '*CHANGE', choices: `${AUT_CHOICES}, *ALL` }),
  P('AUTL', 'Authorization list', 'name', 10, { dft: '*NONE' }),
], async (ctx, a) => {
  const objs = await resolveObjects(ctx, a.OBJ, a.OBJTYPE);
  const users = list(a.USER).filter((x) => x !== '*NONE');
  const autl = up(a.AUTL || '*NONE');
  for (const o of objs) {
    await mayManage(ctx, o);
    const rows = await sec.authRows(o.LIB, o.NAME, o.TYPE);
    const targets = users.includes('*ALL') ? rows.filter((r) => !['*PUBLIC', '*AUTL', o.OWNER].includes(r.USR)).map((r) => r.USR) : users;
    for (const u of targets) {
      const prev = rows.find((r) => r.USR === u);
      if (!prev && u !== '*PUBLIC') continue;
      const revoke = sec.expand(list(a.AUT));
      const cur = prev ? sec.expand(prev.AUT) : sec.expand('*CHANGE');
      const rest = list(a.AUT).includes('*ALL') ? [] : [...cur].filter((x) => !revoke.has(x));
      // Si se revoca todo a un usuario se borra su autorización privada; al *PUBLIC le queda *EXCLUDE
      await sec.setPrivate(o.LIB, o.NAME, o.TYPE, u, rest.length ? rest.join(' ') : u === '*PUBLIC' ? '*EXCLUDE' : null);
    }
    if (autl !== '*NONE') {
      const r = rows.find((x) => x.USR === '*AUTL');
      if (r && r.AUT === autl) await sec.setPrivate(o.LIB, o.NAME, o.TYPE, '*AUTL', null);
    }
  }
  return [msg('CPC2202')];
});

def('CHGOBJOWN', 'Change Object Owner', [
  P('OBJ', 'Object', 'qual', 10, { req: true }),
  P('OBJTYPE', 'Object type', 'name', 10, { req: true }),
  P('NEWOWN', 'New owner', 'name', 10, { req: true }),
  P('CUROWNAUT', 'Current owner authority', 'name', 8, { dft: '*REVOKE', choices: '*REVOKE, *SAME' }),
], async (ctx, a) => {
  const [o] = await resolveObjects(ctx, a.OBJ, a.OBJTYPE);
  if (!sec.hasSpecial(ctx.user, '*ALLOBJ') && o.OWNER !== ctx.job.user) throw new CLError('CPF2189', o.NAME, o.LIB, o.TYPE);
  const nu = up(a.NEWOWN);
  if (!(await obj.getUser(nu))) throw new CLError('CPF2204', nu);
  const prevOwner = o.OWNER;
  await gw.exec(`UPDATE QSYS.OBJECTS SET OWNER = ? WHERE LIB = ? AND NAME = ? AND TYPE = ?`, [nu, o.LIB, o.NAME, o.TYPE]);
  // El propietario anterior conserva *ALL como autorización privada salvo CUROWNAUT(*REVOKE)
  if (a.CUROWNAUT === '*SAME' && prevOwner && prevOwner !== nu) await sec.setPrivate(o.LIB, o.NAME, o.TYPE, prevOwner, '*OBJOPR *OBJMGT *OBJEXIST *OBJALTER *OBJREF *READ *ADD *UPD *DLT *EXECUTE');
  else await sec.setPrivate(o.LIB, o.NAME, o.TYPE, prevOwner, null);
  await sec.setPrivate(o.LIB, o.NAME, o.TYPE, nu, null);
  return [msg('CPC2206', o.NAME, o.LIB, o.TYPE)];
});

// ---------- Visualización y edición ----------
function autColumns(auts) {
  if (auts === '*AUTL') return { set: '*AUTL', flags: '' };
  return { set: sec.setName(auts), flags: [...sec.OBJ_AUTS, ...sec.DATA_AUTS].map((x) => (auts.has(x) ? 'X' : ' ')).join('    ') };
}

async function authorityText(o) {
  const { users, autl } = await sec.authorityList(o);
  const lines = [
    `Object . . . . . . . :   ${o.NAME}         Owner  . . . . . . . :   ${o.OWNER}`,
    `  Library  . . . . . :     ${o.LIB}       Primary group  . . . :   *NONE`,
    `Object type  . . . . :   ${o.TYPE}         ASP device . . . . . :   *SYSBAS`,
    `Authorization list . :   ${autl}`,
    '',
    '                     Object    ----------Object-----------  ---------Data----------',
    'User        Group    Authority  Opr  Mgt  Exist  Alter  Ref  Read  Add  Update  Delete  Execute',
  ];
  for (const u of users) {
    const c = autColumns(u.auts);
    lines.push(`${padR(u.user, 12)}         ${padR(c.set, 10)} ${c.flags}`);
  }
  return lines;
}

def('DSPOBJAUT', 'Display Object Authority', [P('OBJ', 'Object', 'qual', 10, { req: true }), P('OBJTYPE', 'Object type', 'name', 10, { req: true }), P('OUTPUT', 'Output', 'char', 6, { dft: '*', choices: '*, *PRINT' })], async (ctx, a) => {
  const [o] = await resolveObjects(ctx, a.OBJ, a.OBJTYPE);
  const lines = await authorityText(o);
  if (!ctx.interactive || a.OUTPUT === '*PRINT') {
    if (a.OUTPUT === '*PRINT') await obj.createSpool(ctx.job, 'QPOBJAUT', lines, { usrdta: 'DSPOBJAUT' });
    return { text: lines.join('\n') };
  }
  const p = new Panel({ fn: 'CMD-DSPOBJAUT', keys: ['F3', 'F12'] });
  p.title('Display Object Authority');
  lines.forEach((l, i) => p.text(3 + i, 2, l, i === 5 || i === 6 ? 'w' : 'g'));
  p.fkeys('F3=Exit   F11=Display detail object authorities   F12=Cancel');
  await ctx.display(p);
  return null;
}, { interactive: false });

def('EDTOBJAUT', 'Edit Object Authority', [P('OBJ', 'Object', 'qual', 10, { req: true }), P('OBJTYPE', 'Object type', 'name', 10, { req: true })], async (ctx, a) => {
  const [o] = await resolveObjects(ctx, a.OBJ, a.OBJTYPE);
  let message = null;
  for (;;) {
    const { users, autl } = await sec.authorityList(o);
    const p = new Panel({ fn: 'CMD-EDTOBJAUT', keys: ['F3', 'F5', 'F6', 'F12'] });
    p.title('Edit Object Authority');
    p.info(3, 2, 'Object', o.NAME, 20); p.info(3, 42, 'Owner', o.OWNER, 16);
    p.info(4, 4, 'Library', o.LIB, 18); p.info(4, 42, 'Primary group', '*NONE', 16);
    p.info(5, 2, 'Object type', o.TYPE, 20);
    p.text(7, 2, 'Type changes to current authorities, press Enter.', 'b');
    p.info(9, 4, 'Object secured by authorization list', autl, 38);
    p.text(11, 2, '            Object', 'w');
    p.text(12, 2, 'User        Authority', 'w');
    users.slice(0, 9).forEach((u, i) => {
      p.text(13 + i, 2, padR(u.user, 10), 'g');
      p.input(`A${i}`, 13 + i, 14, 8, { value: u.auts === '*AUTL' ? '*AUTL' : sec.setName(u.auts) === 'USER DEF' ? 'USER DEF' : sec.setName(u.auts) });
    });
    p.fkeys('F3=Exit   F5=Refresh   F6=Add new users   F11=Display detail', 'F12=Cancel   F17=Top   F18=Bottom');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    if (r.aid === 'F5') continue;
    try {
      await mayManage(ctx, o);
      if (r.aid === 'F6') {
        const q = new Panel({ fn: 'CMD-ADDUSRAUT', keys: ['F12'] });
        q.title('Add New Users');
        q.info(3, 2, 'Object', o.NAME, 20); q.info(4, 4, 'Library', o.LIB, 18);
        q.text(6, 2, 'Type new users, press Enter.', 'b');
        q.text(8, 2, '            Object', 'w'); q.text(9, 2, 'User        Authority', 'w');
        for (let i = 0; i < 8; i++) { q.input(`U${i}`, 10 + i, 2, 10, {}); q.input(`T${i}`, 10 + i, 14, 8, { value: '*USE' }); }
        q.fkeys('F12=Cancel');
        const z = await ctx.display(q);
        if (z.aid !== 'ENTER') continue;
        for (let i = 0; i < 8; i++) {
          const u = up(z.fields[`U${i}`]);
          if (!u) continue;
          await grant(ctx, o, [u], [up(z.fields[`T${i}`]) || '*USE'], { replace: true });
        }
        message = { text: 'Users added.' };
        continue;
      }
      let n = 0;
      for (const [i, u] of users.slice(0, 9).entries()) {
        const v = up(r.fields[`A${i}`]);
        const cur = u.auts === '*AUTL' ? '*AUTL' : sec.setName(u.auts);
        if (!v || v === cur || v === 'USER DEF') continue;
        if (!['*ALL', '*CHANGE', '*USE', '*EXCLUDE', '*AUTL'].includes(v)) { message = { text: `Authority ${v} not valid.`, sev: 30 }; break; }
        await sec.setPrivate(o.LIB, o.NAME, o.TYPE, u.user, v === '*AUTL' ? '*AUTL' : [...sec.expand(v)].join(' ') || '*EXCLUDE');
        n++;
      }
      if (n) message = { text: 'Authorities changed.' };
    } catch (e) { message = { text: e.message, sev: 30 }; }
  }
}, { interactive: true });

// ---------- Listas de autorizaciones (*AUTL en QSYS) ----------
async function autl(name) {
  const o = await sec.objectRow('QSYS', up(name), '*AUTL');
  if (!o) throw new CLError('CPF2283', up(name));
  const d = (await obj.objectData(gw, 'QSYS', o.NAME, '*AUTL')) || { entries: {}, public: '*EXCLUDE' };
  return { o, d };
}
const saveAutl = async (o, d) => { await obj.putObject('QSYS', o.NAME, '*AUTL', '', o.TEXT, d, o.OWNER); sec.invalidateAuth(); };
const autlManage = (ctx, o) => { if (!sec.hasSpecial(ctx.user, '*ALLOBJ') && o.OWNER !== ctx.job.user) throw new CLError('CPF2189', o.NAME, 'QSYS', '*AUTL'); };

def('CRTAUTL', 'Create Authorization List', [P('AUTL', 'Authorization list', 'name', 10, { req: true }), P('AUT', 'Authority', 'name', 8, { dft: '*EXCLUDE', choices: '*CHANGE, *ALL, *USE, *EXCLUDE' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*BLANK' })], async (ctx, a) => {
  const n = up(a.AUTL);
  if (await sec.objectRow('QSYS', n, '*AUTL')) throw new CLError('CPF2282', n);
  await obj.putObject('QSYS', n, '*AUTL', '', a.TEXT === '*BLANK' ? '' : a.TEXT, { entries: {}, public: up(a.AUT) }, ctx.job.user);
  return [msg('CPC2242', n)];
});
def('DLTAUTL', 'Delete Authorization List', [P('AUTL', 'Authorization list', 'name', 10, { req: true })], async (ctx, a) => {
  const { o } = await autl(a.AUTL);
  autlManage(ctx, o);
  const used = await gw.rows(`SELECT LIB, NAME FROM QSYS.OBJAUT WHERE USR = '*AUTL' AND AUT = ?`, [o.NAME]);
  if (used.length) throw new CLError('CPF9898', `Authorization list ${o.NAME} secures ${used.length} object(s) (${used[0].LIB}/${used[0].NAME}); not deleted.`);
  await gw.exec(`DELETE FROM QSYS.OBJECTS WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*AUTL'`, [o.NAME]);
  sec.invalidateAuth();
  return [msg('CPC2263', o.NAME)];
});
for (const [cmd, title] of [['ADDAUTLE', 'Add Authorization List Entry'], ['CHGAUTLE', 'Change Authorization List Entry']]) {
  def(cmd, title, [P('AUTL', 'Authorization list', 'name', 10, { req: true }), P('USER', 'User', 'list', 100, { req: true, choices: 'Name, *PUBLIC' }), P('AUT', 'Authority', 'list', 60, { dft: '*USE', choices: AUT_CHOICES })], async (ctx, a) => {
    const { o, d } = await autl(a.AUTL);
    autlManage(ctx, o);
    for (const u of list(a.USER)) {
      if (u === '*PUBLIC') { d.public = list(a.AUT).join(' '); continue; }
      if (!(await obj.getUser(u))) throw new CLError('CPF2204', u);
      if (cmd === 'ADDAUTLE' && d.entries[u]) throw new CLError('CPF9898', `User ${u} already on authorization list ${o.NAME}.`);
      if (cmd === 'CHGAUTLE' && !d.entries[u]) throw new CLError('CPF9898', `User ${u} not on authorization list ${o.NAME}.`);
      d.entries[u] = list(a.AUT).join(' ');
    }
    await saveAutl(o, d);
    return { text: `Authorization list ${o.NAME} ${cmd === 'ADDAUTLE' ? 'entries added' : 'entries changed'}.` };
  });
}
def('RMVAUTLE', 'Remove Authorization List Entry', [P('AUTL', 'Authorization list', 'name', 10, { req: true }), P('USER', 'User', 'list', 100, { req: true })], async (ctx, a) => {
  const { o, d } = await autl(a.AUTL);
  autlManage(ctx, o);
  for (const u of list(a.USER)) delete d.entries[u];
  await saveAutl(o, d);
  return { text: `Entries removed from authorization list ${o.NAME}.` };
});
async function autlText(name) {
  const { o, d } = await autl(name);
  const rows = [[o.OWNER, '*ALL'], ...Object.entries(d.entries).filter(([u]) => u !== o.OWNER), ['*PUBLIC', d.public]];
  return ['Authorization list . . . . . . . . :   ' + o.NAME, `  Library  . . . . . . . . . . . . :     QSYS`, `Owner  . . . . . . . . . . . . . . :   ${o.OWNER}`, '',
    'User        Object Authority  List Mgt', ...rows.map(([u, x]) => `${padR(u, 12)}${padR(sec.setName(x), 18)}${u === o.OWNER ? 'X' : ''}`)];
}
def('DSPAUTL', 'Display Authorization List', [P('AUTL', 'Authorization list', 'name', 10, { req: true })], async (ctx, a) => ({ text: (await autlText(a.AUTL)).join('\n') }));
def('EDTAUTL', 'Edit Authorization List', [P('AUTL', 'Authorization list', 'name', 10, { req: true })], async (ctx, a) => {
  let message = null;
  for (;;) {
    const { o, d } = await autl(a.AUTL);
    const rows = [...Object.entries(d.entries), ['*PUBLIC', d.public]];
    const p = new Panel({ fn: 'CMD-EDTAUTL', keys: ['F3', 'F6', 'F12'] });
    p.title('Edit Authorization List');
    p.info(3, 2, 'Object', o.NAME, 18); p.info(3, 42, 'Owner', o.OWNER, 16); p.info(4, 4, 'Library', 'QSYS', 16);
    p.text(6, 2, 'Type changes to current authorities, press Enter.', 'b');
    p.text(8, 2, '            Object     List', 'w'); p.text(9, 2, 'User        Authority  Mgt', 'w');
    p.text(10, 2, padR(o.OWNER, 10)); p.text(10, 14, '*ALL'); p.text(10, 25, 'X');
    rows.slice(0, 10).forEach(([u, x], i) => { p.text(11 + i, 2, padR(u, 10)); p.input(`A${i}`, 11 + i, 14, 8, { value: sec.setName(x) }); });
    p.fkeys('F3=Exit   F5=Refresh   F6=Add new users   F12=Cancel');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return null;
    try {
      autlManage(ctx, o);
      if (r.aid === 'F6') {
        const u = up(await (async () => { const q = new Panel({ fn: 'CMD-ADDAUTLE', keys: ['F12'] }); q.title('Add New Users'); q.text(4, 2, 'User . . . :'); q.input('U', 4, 16, 10, {}); q.text(5, 2, 'Authority  :'); q.input('T', 5, 16, 8, { value: '*USE' }); q.fkeys('F12=Cancel'); const z = await ctx.display(q); return z.aid === 'ENTER' ? `${z.fields.U} ${z.fields.T}` : ''; })());
        const [nu, at] = u.split(/\s+/);
        if (nu) { if (!(await obj.getUser(nu))) throw new CLError('CPF2204', nu); d.entries[nu] = at || '*USE'; await saveAutl(o, d); message = { text: `User ${nu} added.` }; }
        continue;
      }
      rows.slice(0, 10).forEach(([u], i) => {
        const v = up(r.fields[`A${i}`]);
        if (!v) return;
        if (u === '*PUBLIC') d.public = v; else if (v === '*REMOVE' || v === '') delete d.entries[u]; else d.entries[u] = v;
      });
      await saveAutl(o, d);
      message = { text: 'Authorization list changed.' };
    } catch (e) { message = { text: e.message, sev: 30 }; }
  }
}, { interactive: true });
def('DSPAUTLOBJ', 'Display Authorization List Objects', [P('AUTL', 'Authorization list', 'name', 10, { req: true })], async (ctx, a) => {
  const { o } = await autl(a.AUTL);
  const rows = await gw.rows(`SELECT LIB, NAME, TYPE FROM QSYS.OBJAUT WHERE USR = '*AUTL' AND AUT = ? ORDER BY LIB, NAME`, [o.NAME]);
  return { text: [`Objects secured by authorization list ${o.NAME}:`, 'Object      Library     Type', ...rows.map((r) => `${padR(r.NAME, 12)}${padR(r.LIB, 12)}${r.TYPE}`)].join('\n') };
});

// ---------- WRKOBJOWN y CHGLIB CRTAUT ----------
def('WRKOBJOWN', 'Work with Objects by Owner', [P('USRPRF', 'User profile', 'name', 10, { dft: '*CURRENT' })], async (ctx, a) => {
  const u = a.USRPRF === '*CURRENT' ? ctx.job.user : up(a.USRPRF);
  const rows = await gw.rows(`SELECT LIB, NAME, TYPE, ATTR FROM QSYS.OBJECTS WHERE OWNER = ? AND TYPE NOT IN ('*LIB') ORDER BY LIB, NAME`, [u]);
  return { text: [`Objects owned by ${u}:`, 'Object      Library     Type        Attribute', ...rows.slice(0, 500).map((r) => `${padR(r.NAME, 12)}${padR(r.LIB, 12)}${padR(r.TYPE, 12)}${r.ATTR || ''}`)].join('\n') };
});
def('CHGLIB', 'Change Library', [P('LIB', 'Library', 'name', 10, { req: true }), P('TYPE', 'Library type', 'char', 5, { dft: '*SAME' }), P('TEXT', "Text 'description'", 'text', 50, { dft: '*SAME' }), P('CRTAUT', 'Create authority', 'name', 8, { dft: '*SAME', choices: '*SAME, *SYSVAL, *CHANGE, *ALL, *USE, *EXCLUDE' })], async (ctx, a) => {
  const o = await sec.objectRow('QSYS', up(a.LIB), '*LIB');
  if (!o) throw new CLError('CPF2110', up(a.LIB));
  await mayManage(ctx, o);
  const d = (await obj.objectData(gw, 'QSYS', o.NAME, '*LIB').catch(() => null)) || {};
  if (a.CRTAUT !== '*SAME') d.crtaut = up(a.CRTAUT);
  await gw.exec(`UPDATE QSYS.OBJECTS SET DATA = ?, TEXT = ?, ATTR = ? WHERE LIB = 'QSYS' AND NAME = ? AND TYPE = '*LIB'`, [JSON.stringify(d), a.TEXT === '*SAME' ? o.TEXT : a.TEXT, a.TYPE === '*SAME' ? o.ATTR : String(a.TYPE).replace('*', ''), o.NAME]);
  return { id: 'CPC2103', text: `Library ${o.NAME} changed.` };
});
