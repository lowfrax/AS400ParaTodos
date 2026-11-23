// Intérprete de programas CL (CLLE): variables, control de flujo, MONMSG y mandatos del sistema.
import { evalCL, truthyCL, parseCommand, splitList, unquote, quote, qualified } from '../../../../shared/cl.js';
import { RpgCancel } from '../../../../shared/rpg/interpreter.js';
import { CLError, msgText } from '../messages.js';
import { logJob, sysDate, sysTime, SYS, qualifiedJob } from '../system.js';
import { sysval, gw, findObject, objectData, putObject, sendToQueue } from '../objects.js';
import { getMsgd, formatMsg } from '../msgf.js';

class Goto { constructor(label) { this.label = label; } }
const LEAVE = { s: 'leave' };
const ITERATE = { s: 'iterate' };
const RETURN = { s: 'return' };

function coerceCl(v, value) {
  switch (v.type) {
    case '*DEC': {
      const n = typeof value === 'number' ? value : Number(String(value).trim() || 0);
      if (Number.isNaN(n)) throw new CLError('CPF0818', `Value '${value}' for variable ${v.name} not valid.`);
      const f = 10 ** v.dec;
      return Math.trunc(Number((n * f).toFixed(6))) / f;
    }
    case '*INT': case '*UINT': return Math.trunc(Number(value) || 0);
    case '*LGL': return truthyCL(value) ? '1' : '0';
    default: {
      const s = typeof value === 'boolean' ? (value ? '1' : '0') : String(value ?? '');
      return s.length >= v.len ? s.slice(0, v.len) : s.padEnd(v.len);
    }
  }
}

export async function runCl(ctx, pgmName, ir, refs) {
  const vars = new Map();
  for (const d of ir.dcls) {
    const v = { name: d.name, type: d.type, len: d.len, dec: d.dec, value: null };
    v.value = coerceCl(v, d.value !== null ? unquote(d.value) : (d.type === '*DEC' || d.type === '*INT' ? 0 : d.type === '*LGL' ? '0' : ''));
    vars.set(d.name, v);
  }
  // Variables de sistema útiles
  const bound = [];
  ir.parms.forEach((p, i) => {
    const v = vars.get(p);
    if (v && refs[i]) { v.value = coerceCl(v, refs[i].get()); bound.push([v, refs[i]]); }
  });
  const getVar = (n) => vars.get(n.toUpperCase());
  // Cola de mensajes del programa: escapes monitorizados, mensajes de terminación de los mandatos y SNDPGMMSG TOPGMQ(*SAME)
  const pgmq = [];
  let msgKey = 0;
  const qmsg = (m) => { pgmq.push({ key: ++msgKey, data: '', msgf: '', sev: 0, ...m }); };

  const matches = (monmsg, id) => monmsg.msgids.some((m) => m === id || (m.endsWith('0000') && id.startsWith(m.slice(0, 3))) || (m.endsWith('00') && id.startsWith(m.slice(0, 5))));

  const substitute = (raw) => {
    // Sustituye &VAR y evalúa expresiones *CAT/*BCAT/*TCAT dentro de valores de parámetros.
    const s = raw.trim();
    if (/^&[\w#@$]+$/.test(s)) {
      const v = getVar(s);
      if (!v) throw new CLError('CPD0727', `Variable ${s} referred to but not declared.`);
      return v.type === '*CHAR' ? quote(String(v.value).replace(/\s+$/, '')) : String(v.value);
    }
    if (/(\*[BT]?CAT\b|\|\||\|>|\|<|%\w+\()/i.test(s) && s.includes('&') || /^%\w+\(/i.test(s)) {
      const val = evalCL(s, getVar);
      return typeof val === 'number' ? String(val) : quote(String(val).replace(/\s+$/, ''));
    }
    if (s.startsWith('(') || !s.includes('&')) return s;
    return s.replace(/'(?:[^']|'')*'|&[\w#@$]+/g, (tok) => {
      if (tok.startsWith("'")) return tok;
      const v = getVar(tok);
      if (!v) throw new CLError('CPD0727', `Variable ${tok} referred to but not declared.`);
      const val = String(v.value).replace(/\s+$/, '');
      return v.type === '*CHAR' && /[\s']/.test(val) ? quote(val) : val;
    });
  };

  const setVar = (name, value) => {
    const v = getVar(name);
    if (!v) throw new CLError('CPD0727', `Variable ${name} referred to but not declared.`);
    v.value = coerceCl(v, value);
  };

  const pv = (cmd, kw, pos) => (cmd.params[kw] !== undefined ? cmd.params[kw] : cmd.positional[pos]);

  async function execCommand(node) {
    const cmd = node.cmd;
    const { runCommand } = await import('../commands/registry.js');
    switch (cmd.name) {
      case 'SNDPGMMSG': case 'SNDUSRMSG': {
        // SNDPGMMSG MSG() | MSGID() MSGF() MSGDTA() TOPGMQ(*PRV|*SAME|*EXT) TOMSGQ() MSGTYPE() KEYVAR()
        const msgid = unquote(substitute(pv(cmd, 'MSGID', 1) || '')).toUpperCase();
        const msgfQ = unquote(substitute(pv(cmd, 'MSGF', 2) || 'QCPFMSG'));
        const raw = pv(cmd, 'MSG', 0);
        const dta = unquote(substitute(pv(cmd, 'MSGDTA', 3) || "''"));
        let text = raw ? unquote(substitute(raw)) : '';
        let sev = 0;
        if (!raw && msgid) {
          const d = await getMsgd(ctx, msgid, msgfQ);
          text = formatMsg(d, dta).text;
          sev = d.sev || 0;
        }
        const type = (pv(cmd, 'MSGTYPE', 6) || (cmd.name === 'SNDUSRMSG' ? '*INQ' : '*INFO')).toUpperCase();
        const topgmq = String(pv(cmd, 'TOPGMQ', 4) || '*PRV').toUpperCase().replace(/[()]/g, ' ').trim().split(/\s+/)[0];
        const tomsgq = pv(cmd, 'TOMSGQ', 5) ? unquote(substitute(pv(cmd, 'TOMSGQ', 5))).toUpperCase() : null;
        if (tomsgq && tomsgq !== '*TOPGMQ') {
          const q = tomsgq === '*SYSOPR' ? 'QSYSOPR' : tomsgq.replace(/^.*\//, '');
          await sendToQueue(q, text, { msgid, type, sev, from: ctx.job.user, fromJob: qualifiedJob(ctx.job) });
          if (cmd.params.KEYVAR) setVar(cmd.params.KEYVAR, String(++msgKey).padStart(4, '0'));
          return;
        }
        logJob(ctx.job, msgid, type, text, { sev: type === '*ESCAPE' ? Math.max(40, sev) : sev, data: dta });
        if (type === '*ESCAPE') {
          const e = new CLError(msgid || 'CPF9898', text);
          e.message = text;
          e.msgId = msgid || 'CPF9898';
          e.msgdta = dta;
          e.msgf = msgfQ;
          throw e;
        }
        if (type === '*STATUS') { ctx.job.statusMsg = text; return; }
        if (cmd.params.KEYVAR) setVar(cmd.params.KEYVAR, String(msgKey + 1).padStart(4, '0'));
        if (topgmq === '*SAME') qmsg({ id: msgid, type, text, data: dta, msgf: msgfQ, sev });
        else ctx.pgmMsgs.push({ id: msgid, text, sev: type === '*DIAG' ? Math.max(sev, 30) : sev, type, data: dta });
        return;
      }
      case 'RTVMSG': {
        // RTVMSG MSGID() MSGF() MSGDTA() MSG(&) MSGLEN(&) SECLVL(&) SECLVLLEN(&) SEV(&)
        const msgid = unquote(substitute(pv(cmd, 'MSGID', 0) || '')).toUpperCase();
        const d = await getMsgd(ctx, msgid, unquote(substitute(pv(cmd, 'MSGF', 1) || 'QCPFMSG')));
        const f = formatMsg(d, unquote(substitute(pv(cmd, 'MSGDTA', 2) || "''")));
        if (cmd.params.MSG) setVar(cmd.params.MSG, f.text);
        if (cmd.params.MSGLEN) setVar(cmd.params.MSGLEN, f.text.length);
        if (cmd.params.SECLVL) setVar(cmd.params.SECLVL, f.seclvl);
        if (cmd.params.SECLVLLEN) setVar(cmd.params.SECLVLLEN, f.seclvl.length);
        if (cmd.params.SEV) setVar(cmd.params.SEV, d.sev || 0);
        return;
      }
      case 'RCVMSG': {
        // RCVMSG PGMQ(*SAME) MSGTYPE(*ANY|*LAST|*EXCP|*COMP|*DIAG|*INFO|*FIRST|*NEXT) RMV(*YES|*NO) MSG(&) MSGDTA(&) MSGID(&) SEV(&) MSGF(&) MSGTYPE
        const want = String(pv(cmd, 'MSGTYPE', 1) || '*ANY').toUpperCase();
        const rmv = String(cmd.params.RMV || '*YES').toUpperCase() !== '*NO';
        const typeOk = (m) => want === '*ANY' || want === '*LAST' || want === '*FIRST' || want === '*NEXT' || (want === '*EXCP' ? ['*ESCAPE', '*NOTIFY'].includes(m.type) : m.type === want);
        const cand = pgmq.filter(typeOk);
        const m = want === '*LAST' || want === '*EXCP' ? cand[cand.length - 1] : cand[0];
        const val = (x) => (m ? x : '');
        if (cmd.params.MSG) setVar(cmd.params.MSG, val(m && m.text));
        if (cmd.params.MSGLEN) setVar(cmd.params.MSGLEN, m ? m.text.length : 0);
        if (cmd.params.MSGDTA) setVar(cmd.params.MSGDTA, val(m && m.data));
        if (cmd.params.MSGDTALEN) setVar(cmd.params.MSGDTALEN, m ? String(m.data || '').length : 0);
        if (cmd.params.MSGID) setVar(cmd.params.MSGID, val(m && m.id));
        if (cmd.params.SEV) setVar(cmd.params.SEV, m ? m.sev : 0);
        if (cmd.params.MSGF) setVar(cmd.params.MSGF, val(m && String(m.msgf || '').replace(/^.*\//, '')));
        if (cmd.params.RTNTYPE) setVar(cmd.params.RTNTYPE, m ? ({ '*COMP': '01', '*DIAG': '02', '*INFO': '04', '*INQ': '05', '*ESCAPE': '15', '*NOTIFY': '14', '*STATUS': '12' }[m.type] || '04') : '  ');
        if (cmd.params.KEYVAR) setVar(cmd.params.KEYVAR, m ? String(m.key).padStart(4, '0') : '');
        if (m && rmv) pgmq.splice(pgmq.indexOf(m), 1);
        return;
      }
      case 'RMVMSG': { pgmq.length = 0; return; }
      case 'RTVJOBA': {
        const map = {
          JOB: ctx.job.name, USER: ctx.job.user, NBR: ctx.job.number, CURUSER: ctx.job.user,
          CURLIB: ctx.job.curlib || '*NONE', TYPE: ctx.interactive ? '1' : '0', USRLIBL: ctx.job.libl.join(' '),
          SYSLIBL: 'QSYS QSYS2 QHLPSYS QUSRSYS', DATE: sysDate().replace(/\//g, ''), SBMMSGQ: '*NONE', OUTQ: 'PRT01',
          SUBTYPE: ctx.interactive ? ' ' : ' ', ENDSTS: '0', DATFMT: '*MDY', DATSEP: '/', TIMSEP: ':',
        };
        for (const [kw, raw] of Object.entries(cmd.params)) if (map[kw] !== undefined) setVar(raw.trim(), map[kw]);
        return;
      }
      case 'RTVSYSVAL': {
        const sv = (pv(cmd, 'SYSVAL', 0) || '').toUpperCase();
        const target = pv(cmd, 'RTNVAR', 1);
        const d = new Date();
        const special = {
          QDATE: sysDate(d).replace(/\//g, ''), QTIME: sysTime(d).replace(/:/g, ''), QYEAR: String(d.getFullYear()).slice(2),
          QMONTH: String(d.getMonth() + 1).padStart(2, '0'), QDAY: String(d.getDate()).padStart(2, '0'),
          QHOUR: String(d.getHours()).padStart(2, '0'), QMINUTE: String(d.getMinutes()).padStart(2, '0'),
          QSECOND: String(d.getSeconds()).padStart(2, '0'), QCENTURY: d.getFullYear() >= 2000 ? '1' : '0',
        };
        const val = special[sv] ?? (await sysval(sv));
        if (val === null || val === undefined) throw new CLError('CPF1028', `System value ${sv} not found.`);
        setVar(target, val);
        return;
      }
      case 'RTVDTAARA': {
        const q = qualified(unquote(substitute(pv(cmd, 'DTAARA', 0) || '')).replace(/\(.*\)$/, ''));
        const o = await findObject(gw, q.obj, '*DTAARA', q.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(q.lib), ctx.libl);
        if (!o) throw new CLError('CPF1015', `Data area ${q.obj} in ${q.lib} not found.`);
        const d = await objectData(gw, o.LIB, q.obj, '*DTAARA');
        setVar(pv(cmd, 'RTNVAR', 1), d ? d.value : '');
        return;
      }
      case 'CHGDTAARA': {
        const raw = pv(cmd, 'DTAARA', 0) || '';
        const q = qualified(unquote(substitute(raw)).replace(/\(.*\)$/, ''));
        const o = await findObject(gw, q.obj, '*DTAARA', q.lib === '*LIBL' ? '*LIBL' : ctx.resolveLib(q.lib), ctx.libl);
        if (!o) throw new CLError('CPF1015', `Data area ${q.obj} in ${q.lib} not found.`);
        const d = (await objectData(gw, o.LIB, q.obj, '*DTAARA')) || {};
        d.value = unquote(substitute(pv(cmd, 'VALUE', 1) || "''"));
        await putObject(o.LIB, q.obj, '*DTAARA', d.type || '*CHAR', o.TEXT, d, o.OWNER);
        return;
      }
      case 'CALL': {
        const pgm = qualified(unquote(substitute(pv(cmd, 'PGM', 0) || '')));
        const parms = splitList(pv(cmd, 'PARM', 1) || '');
        const refs = parms.map((p) => {
          if (/^&[\w#@$]+$/.test(p)) {
            const v = getVar(p);
            if (!v) throw new CLError('CPD0727', `Variable ${p} referred to but not declared.`);
            return { get: () => v.value, set: (x) => { v.value = coerceCl(v, x); } };
          }
          if (/^'.*'$/s.test(p)) { const val = unquote(p).padEnd(32); return { get: () => val, set: () => {} }; }
          if (/^[-+]?\d*\.?\d+$/.test(p)) { const n = Number(p); return { get: () => n, set: () => {} }; }
          const val = substitute(p);
          return { get: () => unquote(val), set: () => {} };
        });
        const { callProgram } = await import('./call.js');
        const saved = ctx.pgmMsgs;
        const msgs = await callProgram(ctx, pgm.obj, pgm.lib, refs);
        ctx.pgmMsgs = saved;
        for (const m of msgs || []) ctx.pgmMsgs.push(m);
        return;
      }
      case 'DLYJOB': {
        const secs = Number(unquote(substitute(pv(cmd, 'DLY', 0) || '1'))) || 1;
        const prev = ctx.job.status;
        ctx.job.status = 'DLYW';
        const until = Date.now() + secs * 1000;
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
          if (ctx.job.cancel) { ctx.job.cancel = false; throw new RpgCancel(); }
        }
        ctx.job.status = prev;
        return;
      }
      default: {
        const parts = [cmd.lib ? `${cmd.lib}/${cmd.name}` : cmd.name];
        cmd.positional.forEach((p) => parts.push(substitute(p)));
        for (const [kw, raw] of Object.entries(cmd.params)) parts.push(`${kw}(${substitute(raw)})`);
        const out = await runCommand(ctx, parts.join(' '), { noAutoPrompt: true });
        for (const m of out) {
          ctx.pgmMsgs.push(m);
          // Los mensajes de terminación de los mandatos quedan en la cola del programa CL (RCVMSG)
          if (m && (m.id || m.text)) qmsg({ id: m.id || '', type: m.sev >= 30 ? '*DIAG' : '*COMP', text: m.text || '', sev: m.sev || 0 });
        }
      }
    }
  }

  async function execNode(node) {
    if (ctx.job.cancel) { ctx.job.cancel = false; throw new RpgCancel(); }
    switch (node.t) {
      case 'nop': return null;
      case 'chgvar': {
        const target = (node.var || '').trim().toUpperCase();
        const raw = node.value ?? "''";
        const v = getVar(target);
        if (!v) throw new CLError('CPD0727', `Variable ${target} referred to but not declared.`);
        let val = evalCL(raw, getVar);
        if (v.type === '*DEC' || v.type === '*INT') val = typeof val === 'number' ? val : Number(String(val).trim() || 0);
        v.value = coerceCl(v, val);
        return null;
      }
      case 'if': {
        const c = truthyCL(evalCL(node.cond, getVar));
        if (c) return execList(node.then);
        if (node.else) return execList(node.else);
        return null;
      }
      case 'do': return execList(node.body);
      case 'dowhile':
        while (truthyCL(evalCL(node.cond, getVar))) {
          const s = await execList(node.body);
          if (s === LEAVE) break;
          if (s && s !== ITERATE) return s;
          await new Promise((r) => setImmediate(r));
        }
        return null;
      case 'dountil':
        do {
          const s = await execList(node.body);
          if (s === LEAVE) break;
          if (s && s !== ITERATE) return s;
          await new Promise((r) => setImmediate(r));
        } while (!truthyCL(evalCL(node.cond, getVar)));
        return null;
      case 'dofor': {
        const v = getVar(node.var);
        if (!v) throw new CLError('CPD0727', `Variable ${node.var} referred to but not declared.`);
        v.value = coerceCl(v, evalCL(node.from, getVar));
        const by = Number(evalCL(node.by, getVar));
        for (;;) {
          const to = Number(evalCL(node.to, getVar));
          if (by >= 0 ? v.value > to : v.value < to) break;
          const s = await execList(node.body);
          if (s === LEAVE) break;
          if (s && s !== ITERATE) return s;
          v.value = coerceCl(v, Number(v.value) + by);
          await new Promise((r) => setImmediate(r));
        }
        return null;
      }
      case 'select': {
        for (const w of node.whens) if (truthyCL(evalCL(w.cond, getVar))) return execList(w.then);
        if (node.other) return execList(node.other);
        return null;
      }
      case 'leave': return LEAVE;
      case 'iterate': return ITERATE;
      case 'return': return RETURN;
      case 'goto': throw new Goto(node.target);
      case 'cmd': {
        try {
          await execCommand(node);
        } catch (e) {
          if (e instanceof RpgCancel || e.cancel || e.signoff || e.disconnected || e instanceof Goto) throw e;
          const id = e.msgId || 'CPF9999';
          const mon = node.monmsg.find((m) => matches(m, id)) || ir.monmsg.find((m) => matches(m, id));
          if (!mon) throw e;
          logJob(ctx.job, id, '*ESCAPE', e.message, { sev: 40, monitored: true });
          qmsg({ id, type: '*ESCAPE', text: e.message, data: e.msgdta !== undefined ? e.msgdta : (e.args && e.args.length ? e.args.map((x) => String(x ?? '').padEnd(10)).join('') : ''), msgf: e.msgf || 'QCPFMSG', sev: e.sev || 40 });
          if (mon.body) return execList(mon.body);
          if (mon.exec) {
            const inner = parseCommand(mon.exec);
            if (inner.name === 'GOTO') throw new Goto((inner.params.CMDLBL || inner.positional[0] || '').toUpperCase());
            if (inner.name === 'RETURN') return RETURN;
            if (inner.name === 'CHGVAR') return execNode({ t: 'chgvar', var: inner.params.VAR || inner.positional[0], value: inner.params.VALUE || inner.positional[1] });
            await execNode({ t: 'cmd', cmd: inner, monmsg: [] });
          }
        }
        return null;
      }
      default: return null;
    }
  }

  async function execList(list, startIdx = 0) {
    for (let i = startIdx; i < list.length; i++) {
      if (ctx.job.debug && list[i] && list[i].line !== undefined) {
        const D = await import('../debug.js');
        await D.onStatement(ctx, null, pgmName, list[i].line, D.clApi(getVar, coerceCl));
      }
      const s = await execNode(list[i]);
      if (s) return s;
    }
    return null;
  }

  // Bucle principal con soporte de GOTO a etiquetas del nivel superior.
  let start = 0;
  try {
    for (;;) {
      try {
        await execList(ir.body, start);
        break;
      } catch (e) {
        if (!(e instanceof Goto)) throw e;
        const idx = ir.body.findIndex((n) => n.label === e.label);
        if (idx < 0) throw new CLError('CPD0725', `Label ${e.label} not defined.`);
        start = idx;
        await new Promise((r) => setImmediate(r));
      }
    }
  } finally {
    for (const [v, ref] of bound) ref.set(v.value);
  }
  return { SYS, qualifiedJob };
}
