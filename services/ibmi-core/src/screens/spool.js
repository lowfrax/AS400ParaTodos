// WRKSPLF y visualización de archivos en spool (DSPSPLF).
import { padR, padL } from '../panel.js';
import { workWith, viewText, confirmDelete } from './common.js';
import { listSpool, spoolData, deleteSpool, setSpoolStatus } from '../objects.js';
import { msgText } from '../messages.js';

export async function wrksplf(ctx, user = ctx.job.user, jobNbr = null) {
  return workWith(ctx, {
    fn: 'CMD-WRKSPLF',
    title: user === '*ALL' ? 'Work with All Spooled Files' : 'Work with All Spooled Files',
    opts: ['1=Send   2=Change   3=Hold   4=Delete   5=Display   6=Release   7=Messages', '8=Attributes        9=Work with printing status'],
    colHead2: '                             Device or                     Total     Cur',
    colHead: 'Opt  File        User        Queue       User Data   Sts   Pages    Page  Copy',
    optCol: 3,
    optLen: 1,
    load: async () => {
      const all = await listSpool(user);
      return jobNbr ? all.filter((s) => s.JOBNBR === jobNbr) : all;
    },
    key: (s) => s.ID,
    empty: '(No spooled files)',
    row: (s) => `${padR(s.NAME, 10)}  ${padR(s.JOBUSER, 10)}  ${padR(s.OUTQ, 10)}  ${padR(s.USRDTA, 10)}  ${padR(s.STATUS, 4)} ${padL(s.PAGES, 6)}              1`,
    fkeys: ['F3=Exit   F10=View 3   F11=View 2   F12=Cancel   F22=Printers   F24=More keys'],
    cmdLabel: 'Parameters for options 1, 2, 3 or command',
    act: async (sels) => {
      let last = null;
      const del = sels.filter((s) => s.opt === '4');
      if (del.length) {
        if (await confirmDelete(ctx, 'Confirm Delete of Spooled Files', 'Opt  File        User        Queue', del.map((s) => `${padR(s.item.NAME, 10)}  ${padR(s.item.JOBUSER, 10)}  ${s.item.OUTQ}`))) {
          for (const s of del) await deleteSpool(s.item.ID);
          last = { id: 'CPC3309', text: `${del.length} spooled file(s) deleted.` };
        }
      }
      for (const s of sels) {
        if (s.opt === '5') await dspsplf(ctx, s.item);
        else if (s.opt === '3') { await setSpoolStatus(s.item.ID, 'HLD'); last = { text: `Spooled file ${s.item.NAME} held.` }; }
        else if (s.opt === '6') { await setSpoolStatus(s.item.ID, 'RDY'); last = { text: `Spooled file ${s.item.NAME} released.` }; }
        else if (!['4', '5'].includes(s.opt)) last = { id: 'CPD6A01', text: msgText('CPD6A01', s.opt), sev: 30 };
      }
      return last;
    },
  });
}

export async function dspsplf(ctx, s) {
  const lines = (await spoolData(s.ID)) || [];
  return viewText(ctx, {
    fn: 'CMD-DSPSPLF',
    title: 'Display Spooled File',
    head: (p, st) => {
      p.text(2, 2, 'File  . . . . . :', 'g').text(2, 21, s.NAME, 'w');
      p.text(2, 54, 'Page/Line', 'g').text(2, 66, `${Math.floor(st.top / 60) + 1}/${(st.top % 60) + 1}`, 'w');
      return 3;
    },
    lines,
  });
}
