// Pantallas de arranque (IPL) y de inicio de sesión (Sign On).
import { Panel } from '../panel.js';
import { SYS, createJob, logJob } from '../system.js';
import { msgText } from '../messages.js';
import { getUser, updateUser, hashPassword, sysval, libExists, passwordTokens } from '../objects.js';

export const IPL_STEPS = [
  'Storage Management Recovery',
  'Authority Recovery',
  'Journal Recovery',
  'Database Recovery',
  'Journal Synchronization',
  'Commit Recovery',
  'Data Base Initialization',
  'Start the Operating System',
];

export async function showIpl(session) {
  while (SYS.status !== 'READY' && !session.closed) {
    const p = new Panel({ fn: 'IPL' });
    p.title('IPL Step in Progress');
    p.label(3, 2, 'IPL step', 20);
    p.text(3, 22, ':', 'g').text(3, 25, SYS.iplStep, 'w');
    const cur = Math.max(0, IPL_STEPS.indexOf(SYS.iplStep));
    p.text(5, 2, 'IPL steps:', 'g');
    IPL_STEPS.forEach((s, i) => {
      p.text(6 + i, 4, i === cur ? '>' : ' ', 'w');
      p.text(6 + i, 6, s, i < cur ? 'g' : i === cur ? 'w' : 'b');
    });
    const el = Math.round((Date.now() - SYS.iplAt) / 1000);
    p.label(16, 2, 'Elapsed time', 20);
    p.text(16, 22, ':', 'g').text(16, 25, `${String(Math.floor(el / 60)).padStart(2, '0')}:${String(el % 60).padStart(2, '0')}`, 'w');
    if (SYS.iplDetail) p.text(18, 2, SYS.iplDetail.slice(0, 78), 'b');
    p.text(24, 2, 'The database (IBM Db2) is starting. The first IPL can take several minutes.', 'w');
    session.send({ ...p.toJSON(), lock: true, dev: session.device });
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Muestra Sign On hasta que el usuario inicia sesión. Devuelve el perfil y crea el trabajo. */
export async function signOn(session) {
  let message = null;
  let user = '';
  for (;;) {
    const p = new Panel({ fn: 'SIGNON', keys: ['F3', 'F12'] });
    p.center(1, 'Sign On', 'w');
    p.info(2, 48, 'System', SYS.name, 20);
    p.info(3, 48, 'Subsystem', 'QINTER', 20);
    p.info(4, 48, 'Display', session.device, 20);
    const rows = [['User', 'USER'], ['Password', 'PWD'], ['Program/procedure', 'PGM'], ['Menu', 'MENU'], ['Current library', 'CURLIB']];
    rows.forEach(([l, n], i) => {
      p.label(6 + i, 18, l, 34);
      p.input(n, 6 + i, 54, 10, { value: n === 'USER' ? user : '', nd: n === 'PWD', attr: n === 'PWD' ? 'gn' : 'gu' });
    });
    if (message) p.msg(message);
    else p.text(24, 44, '(C) COPYRIGHT IBM CORP. 1980, 2009.', 'w');
    message = null;
    p.cursorTo(user ? 'PWD' : 'USER');
    const r = await session.display(p);
    if (r.aid !== 'ENTER') continue;
    user = (r.fields.USER || '').trim().toUpperCase();
    const pwd = (r.fields.PWD || '').trim().toUpperCase();
    if (!user) continue;
    const prf = await getUser(user);
    if (!prf) { message = { id: 'CPF1120', text: msgText('CPF1120', user), sev: 30 }; user = ''; continue; }
    if (prf.STATUS === '*DISABLED') { message = { id: 'CPF1394', text: msgText('CPF1394', user), sev: 30 }; continue; }
    if (!prf.PWDHASH || prf.PWDHASH !== hashPassword(user, pwd)) {
      const max = Number((await sysval('QMAXSIGN')) || 3);
      const invalid = Number(prf.INVALID || 0) + 1;
      const disable = invalid >= max && user !== 'QSECOFR';
      await updateUser(user, { INVALID: invalid, ...(disable ? { STATUS: '*DISABLED' } : {}) });
      message = disable ? { id: 'CPF1394', text: msgText('CPF1394', user), sev: 30 } : { id: 'CPF1107', text: msgText('CPF1107'), sev: 30 };
      continue;
    }
    const curlibIn = (r.fields.CURLIB || '').trim().toUpperCase();
    if (curlibIn && curlibIn !== '*USRPRF' && !(await libExists(curlibIn))) {
      message = { id: 'CPF2110', text: msgText('CPF2110', curlibIn), sev: 40 };
      continue;
    }
    if (!prf.PWDTOKEN) await updateUser(user, { PWDTOKEN: passwordTokens(user, pwd) }).catch(() => {});
    await updateUser(user, { INVALID: 0, LASTSIGN: new Date().toISOString().replace('T', ' ').slice(0, 19), SIGNONS: Number(prf.SIGNONS || 0) + 1 });
    const job = createJob({ name: session.device, user, type: 'INT', subsystem: 'QINTER', fn: '', status: 'RUN' });
    const usrlibl = String((await sysval('QUSRLIBL')) || 'QGPL QTEMP').split(/\s+/).filter(Boolean);
    job.libl = usrlibl;
    const cl = curlibIn && curlibIn !== '*USRPRF' ? curlibIn : prf.CURLIB;
    job.curlib = cl && cl !== '*CRTDFT' && cl !== '*NONE' ? cl : null;
    job.session = session;
    if (prf.LASTSIGN) logJob(job, 'CPF1124I', '*INFO', `Previous sign-on was ${prf.LASTSIGN}.`);
    return {
      prf,
      job,
      pgm: (r.fields.PGM || '').trim().toUpperCase(),
      menu: (r.fields.MENU || '').trim().toUpperCase(),
    };
  }
}
