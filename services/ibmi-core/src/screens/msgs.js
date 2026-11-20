// DSPMSG, SNDMSG y DSPJOBLOG.
import { Panel, padR } from '../panel.js';
import { SYS, sysDate, sysTime } from '../system.js';
import { queueMessages, markQueueRead, removeMessage, clearQueue, sendToQueue } from '../objects.js';
import { wrapText } from '../session.js';
import { refreshMW } from '../mw.js';

export async function dspmsg(ctx, queue = ctx.job.user) {
  let message = null;
  let top = 0;
  for (;;) {
    const msgs = await queueMessages(queue);
    await markQueueRead(queue);
    refreshMW(queue);
    const p = new Panel({ fn: 'CMD-DSPMSG', keys: ['F3', 'F5', 'F11', 'F12', 'F13', 'F16', 'F24', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Display Messages');
    p.text(2, 54, 'System:', 'w').text(2, 64, SYS.name, 'w');
    p.info(3, 2, 'Queue', queue, 17); p.info(3, 42, 'Program', '*DSPMSG', 17);
    p.info(4, 4, 'Library', 'QUSRSYS', 15); p.info(4, 44, 'Library', '', 15);
    p.info(5, 2, 'Severity', '00', 17); p.info(5, 42, 'Delivery', '*HOLD', 17);
    p.text(7, 2, 'Type reply (if required), press Enter.', 'b');
    const lines = [];
    for (const m of msgs.slice().reverse()) {
      const head = m.FROMUSR && m.FROMUSR !== 'QSYS' && !m.MSGID ? `From  . . . :   ${m.FROMUSR}        ${fmt(m.SENT)}` : null;
      if (head) lines.push({ t: head, a: 'g', id: m.ID });
      for (const l of wrapText(m.TEXT, 74)) lines.push({ t: `  ${l}`, a: m.STATUS === 'NEW' ? 'w' : 'g', id: m.ID });
    }
    const page = 12;
    lines.slice(top, top + page).forEach((l, i) => p.text(8 + i, 2, l.t, l.a));
    if (!lines.length) p.text(8, 4, '(No messages)', 'g');
    p.more(20, top + page < lines.length);
    p.fkeys('F3=Exit             F11=Remove a message                 F12=Cancel', 'F13=Remove all      F16=Remove all except unanswered     F24=More keys');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12' || r.aid === 'ENTER') return null;
    if (r.aid === 'PAGEDOWN') { if (top + page < lines.length) top += page; else message = 'You have reached the bottom of the list.'; }
    if (r.aid === 'PAGEUP') { top = Math.max(0, top - page); }
    if (r.aid === 'F13' || r.aid === 'F16') { await clearQueue(queue); message = 'All messages removed.'; top = 0; }
    if (r.aid === 'F11') {
      const row = r.cursor[0] - 8 + top;
      const l = lines[row];
      if (l) { await removeMessage(l.id); message = 'Message removed.'; } else message = 'Place the cursor on a message and press F11.';
    }
  }
}

function fmt(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(ts) : `${sysDate(d)}   ${sysTime(d)}`;
}

export async function sndmsg(ctx, text, tousr) {
  const users = tousr === '*SYSOPR' ? ['QSYSOPR'] : [tousr];
  for (const u of users) {
    await sendToQueue(u, text, { from: ctx.job.user, fromJob: `${ctx.job.number}/${ctx.job.user}/${ctx.job.name}` });
    refreshMW(u);
  }
}

export async function dspjoblog(ctx, job = ctx.job) {
  let top = null;
  let detailed = false;
  let message = null;
  for (;;) {
    const lines = [];
    for (const e of job.joblog) {
      if (!detailed && e.type !== '*RQS' && !['CPF1124', 'CPF1164'].includes(e.id) && (e.sev || 0) < 30 && !e.id.startsWith('RNQ') && e.type !== '*COMP') continue;
      const prefix = e.type === '*RQS' ? '> ' : '  ';
      const w = wrapText(e.text, 72);
      w.forEach((l, i) => lines.push({ t: (i === 0 ? prefix : '    ') + l, a: e.type === '*RQS' ? 'g' : (e.sev || 0) >= 30 ? 'w' : 'g' }));
    }
    const page = 13;
    if (top === null) top = Math.max(0, lines.length - page);
    const p = new Panel({ fn: 'CMD-DSPJOBLOG', keys: ['F3', 'F5', 'F10', 'F12', 'F16', 'F24', 'PAGEUP', 'PAGEDOWN'] });
    p.title('Display Job Log');
    p.sysName();
    p.label(3, 2, 'Job', 8); p.text(3, 10, ':', 'g').text(3, 14, job.name, 'w');
    p.label(3, 27, 'User', 9); p.text(3, 36, ':', 'g').text(3, 40, job.user, 'w');
    p.label(3, 52, 'Number', 13); p.text(3, 65, ':', 'g').text(3, 69, job.number, 'w');
    lines.slice(top, top + page).forEach((l, i) => p.text(5 + i, 2, l.t, l.a));
    p.more(18, top + page < lines.length);
    p.text(19, 2, 'Press Enter to continue.', 'b');
    p.fkeys('F3=Exit   F5=Refresh   F10=Display detailed messages   F12=Cancel', 'F16=Job menu   F24=More keys');
    if (message) p.msg(message);
    message = null;
    const r = await ctx.display(p);
    if (['F3', 'F12', 'ENTER'].includes(r.aid)) return null;
    if (r.aid === 'F10') { detailed = !detailed; top = null; }
    if (r.aid === 'PAGEDOWN') { if (top + page < lines.length) top += page; else message = 'You have reached the bottom of the list.'; }
    if (r.aid === 'PAGEUP') { if (top > 0) top = Math.max(0, top - page); else message = 'You have reached the top of the list.'; }
    if (r.aid === 'F5') top = null;
  }
}

export { padR };
