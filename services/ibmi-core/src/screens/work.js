// WRKACTJOB, WRKSYSSTS, WRKSBS: datos reales del sistema en ejecución.
import os from 'node:os';
import { Panel, padR, padL } from '../panel.js';
import { workWith, execFromLine, retrieve, confirmDelete } from './common.js';
import { SYS, allJobs, SUBSYSTEMS, metrics, sysDate, sysTime, endJob, logJob } from '../system.js';
import { msg } from '../messages.js';

const fmtPct = (n) => (n === 0 ? '.0' : n < 1 ? `.${Math.round(n * 10)}` : n.toFixed(1));
const elapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':');
};

export async function wrkactjob(ctx, sbsFilter = '*ALL') {
  const startedAt = { t: Date.now() };
  return workWith(ctx, {
    fn: 'CMD-WRKACTJOB',
    title: 'Work with Active Jobs',
    header: (p, items) => {
      const d = new Date();
      p.text(2, 62, `${sysDate(d)}  ${sysTime(d)}`, 'w');
      p.text(3, 2, 'CPU %:', 'g').text(3, 10, padL(fmtPct(metrics.cpuPct), 6), 'w');
      p.text(3, 20, 'Elapsed time:', 'g').text(3, 36, elapsed(Date.now() - startedAt.t), 'w');
      p.text(3, 49, 'Active jobs:', 'g').text(3, 64, padL(allJobs().length, 5), 'w');
      return 5;
    },
    opts: ['2=Change   3=Hold   4=End   5=Work with   6=Release   7=Display message', '8=Work with spooled files   13=Disconnect ...'],
    colHead: 'Opt  Subsystem/Job  User        Type  CPU %  Function        Status',
    optCol: 3,
    optLen: 2,
    load: async () => {
      const jobs = allJobs();
      const out = [];
      for (const sbs of SUBSYSTEMS) {
        if (sbsFilter !== '*ALL' && sbs !== sbsFilter) continue;
        const sj = jobs.find((j) => j.type === 'SBS' && j.name === sbs);
        if (sj) out.push(sj);
        jobs.filter((j) => j.subsystem === sbs && j.type !== 'SBS').sort((a, b) => a.name.localeCompare(b.name) || a.number.localeCompare(b.number)).forEach((j) => out.push(j));
      }
      return out;
    },
    key: (j) => j.number,
    row: (j) => [
      [j.type === 'SBS' ? 7 : 9, padR(j.name, 10), 'g'],
      [22, padR(j.user, 10), 'g'],
      [34, padR(j.type, 4), 'g'],
      [40, padL(fmtPct(j.cpuPct || 0), 5), 'g'],
      [47, padR(j.function || '', 15), 'g'],
      [63, padR(j.status, 6), 'g'],
    ],
    keys: {
      F10: async () => { startedAt.t = Date.now(); return { text: 'Statistics restarted.' }; },
      F7: async () => ({ text: 'Find not available. Use the Subsystem/Job column.' }),
    },
    fkeys: ['F3=Exit   F5=Refresh   F7=Find   F10=Restart statistics', 'F11=Display elapsed data   F12=Cancel   F23=More options   F24=More keys'],
    act: async (sels) => {
      let last = null;
      const toEnd = sels.filter((s) => s.opt === '4');
      if (toEnd.length) {
        if (!(await confirmDelete(ctx, 'Confirm End of Jobs', 'Opt  Subsystem/Job  User        Type', toEnd.map((s) => `${padR(s.item.name, 10)}     ${padR(s.item.user, 10)}  ${s.item.type}`)))) return null;
        for (const s of toEnd) {
          const j = s.item;
          if (j.system) { last = { id: 'CPF1362', text: `Job ${j.number}/${j.user}/${j.name} cannot be ended (system job).`, sev: 40 }; continue; }
          if (j === ctx.job) { last = { id: 'CPF1362', text: 'Cannot end your own job from WRKACTJOB. Use SIGNOFF.', sev: 40 }; continue; }
          j.cancel = true;
          logJob(j, 'CPF1164', '*COMP', 'Job ended by ENDJOB command.');
          if (j.session) { j.session.forceSignoff = true; j.session.send({ t: 'notice', text: `Job ended by ${ctx.job.user}.` }); if (j.session.pending) { const p = j.session.pending; j.session.pending = null; p.reject(Object.assign(new Error('ended'), { signoff: true })); } } else endJob(j, 30);
          last = msg('CPC1224', j.number, j.user, j.name);
        }
      }
      for (const s of sels) {
        if (s.opt === '5') { const { dspjoblog } = await import('./msgs.js'); await dspjoblog(ctx, s.item); }
        else if (s.opt === '8') { const { wrksplf } = await import('./spool.js'); await wrksplf(ctx, s.item.user, s.item.number); }
        else if (s.opt !== '4') last = { id: 'CPD6A01', text: `Option ${s.opt} not supported on this system.`, sev: 30 };
      }
      return last;
    },
  });
}

export async function wrksyssts(ctx) {
  const t0 = Date.now();
  let message = null;
  let cmdValue = '';
  const st = {};
  for (;;) {
    const p = new Panel({ fn: 'CMD-WRKSYSSTS', keys: ['F3', 'F4', 'F5', 'F9', 'F10', 'F12', 'F19', 'F24'] });
    p.title('Work with System Status');
    p.sysRight(1);
    const d = new Date();
    p.text(2, 62, `${sysDate(d)}  ${sysTime(d)}`, 'w');
    const totalMem = os.totalmem() / (1 << 20);
    const usedPct = ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
    const aspG = (os.totalmem() / (1 << 30)) * 8;
    const jobs = allJobs().length;
    const rss = process.memoryUsage().rss / (1 << 20);
    const L = (r, label, v, c = 2) => { p.label(r, c, label, 25); p.text(r, c + 25, ':', 'g'); p.text(r, c + 27, padL(v, 11), 'w'); };
    L(3, '% CPU used', fmtPct(metrics.cpuPct));
    L(4, '% DB capability', fmtPct(Math.min(99.9, (metrics.ext.gateway?.history?.slice(-1)[0]?.qps || 0) * 0.3)));
    L(5, 'Elapsed time', elapsed(Date.now() - t0));
    L(6, 'Jobs in system', String(jobs));
    L(7, '% perm addresses', '.008');
    L(8, '% temp addresses', '.010');
    p.text(3, 45, 'Auxiliary storage:', 'g');
    const R = (r, label, v) => { p.label(r, 47, label, 23); p.text(r, 69, ':', 'g'); p.text(r, 71, padL(v, 9), 'w'); };
    R(4, 'System ASP', `${aspG.toFixed(1)} G`);
    R(5, '% system ASP used', usedPct.toFixed(4));
    R(6, 'Total', `${aspG.toFixed(1)} G`);
    R(7, 'Current unprotect used', `${Math.round(rss)} M`);
    R(8, 'Maximum unprotect', `${Math.round(rss * 1.3)} M`);
    p.text(10, 2, 'Type changes (if allowed), press Enter.', 'b');
    p.text(12, 2, 'System     Pool    Reserved    Max   -----DB-----  ---Non-DB---', 'w');
    p.text(13, 2, ' Pool    Size (M)  Size (M)  Active  Fault  Pages  Fault  Pages', 'w');
    const pools = [[1, totalMem * 0.15, totalMem * 0.07, '+++++'], [2, totalMem * 0.55, 11.13, '114'], [3, totalMem * 0.2, 0, '11'], [4, totalMem * 0.1, 0, '5']];
    pools.forEach(([n, size, res, act], i) => {
      const f = () => (Math.random() < 0.3 ? (Math.random() * 2).toFixed(1) : '.0').replace(/^0/, '');
      p.text(14 + i, 2, `${padL(n, 5)}   ${padL(size.toFixed(2), 10)}${padL(res === 0 ? '.00' : res.toFixed(2), 10)}   ${padL(act, 5)}  ${padL(f(), 5)}  ${padL(f(), 5)}  ${padL(f(), 5)}  ${padL(f(), 5)}`, 'g');
    });
    p.more(18, false);
    p.text(19, 2, 'Command', 'g');
    p.text(20, 2, '===>', 'g');
    p.input('CMD', 20, 7, 73, { value: cmdValue, lower: true });
    p.fkeys('F3=Exit   F4=Prompt   F5=Refresh   F9=Retrieve   F10=Restart   F12=Cancel', 'F19=Extended system status          F24=More keys');
    if (message) p.msg(message);
    message = null;
    cmdValue = '';
    const r = await ctx.display(p);
    if (r.aid === 'F3' || r.aid === 'F12') return;
    if (r.aid === 'F9') { cmdValue = retrieve(ctx.session, st) || ''; continue; }
    if (r.aid === 'F19') { message = 'Extended system status not available.'; continue; }
    const cmd = (r.fields.CMD || '').trim();
    if (cmd) message = await execFromLine(ctx, cmd, r.aid === 'F4');
  }
}

export async function wrksbs(ctx) {
  return workWith(ctx, {
    fn: 'CMD-WRKSBS',
    title: 'Work with Subsystems',
    opts: ['4=End subsystem   5=Display subsystem description', '8=Work with subsystem jobs'],
    colHead2: '                    Total     -----------Subsystem Pools------------',
    colHead: 'Opt  Subsystem     Storage (M)  1   2   3   4   5   6   7   8   9  10',
    load: async () => SUBSYSTEMS.map((s) => ({ name: s, jobs: allJobs().filter((j) => j.subsystem === s && j.type !== 'SBS').length })),
    key: (s) => s.name,
    row: (s) => `${padR(s.name, 10)}        .00     ${s.name === 'QINTER' ? '   3' : s.name === 'QBATCH' ? '   2' : '   2'}`,
    act: async (sels) => {
      for (const s of sels) {
        if (s.opt === '8') await wrkactjob(ctx, s.item.name);
        else if (s.opt === '4') return { id: 'CPF1054', text: `Subsystem ${s.item.name} cannot be ended in this clone.`, sev: 40 };
        else if (s.opt === '5') return { text: `Subsystem ${s.item.name}: ${s.item.jobs} active job(s).` };
      }
      return null;
    },
    fkeys: ['F3=Exit   F5=Refresh   F11=Display system data   F12=Cancel', 'F14=Work with system status'],
  });
}

export { execFromLine };
