// APIs del sistema invocables desde RPG y CL:
//  - Programas (CALL / EXTPGM): QCMDEXC, QSNDDTAQ, QRCVDTAQ, QCLRDTAQ, QMHSNDPM (simplificada), QWCRDTAA no.
//  - Procedimientos (EXTPROC): QtmhWrStout/QtmhRdStin/QtmhGetEnv (CGI), getenv, system, sleep/usleep,
//    HTTPAPI (http_string, http_req, http_setAuth, http_error) para consumir servicios REST desde RPG.
import { CLError } from '../messages.js';
import { RpgError } from '../../../../shared/rpg/interpreter.js';
import { resolveDtaq, sendDtaq, receiveDtaq, clearDtaq } from '../dtaq.js';
import { logJob, qualifiedJob } from '../system.js';
import { httpRequest } from '../net/httpclient.js';

const str = (v) => (v === null || v === undefined ? '' : String(v));
const rtrim = (v) => str(v).replace(/\s+$/, '');
const num = (v) => Number(String(v ?? 0).trim() || 0);

// ---------- Programas del sistema ----------
const PROGRAMS = {
  async QCMDEXC(ctx, refs) {
    const cmd = str(refs[0]?.get());
    const len = refs[1] ? num(refs[1].get()) : cmd.length;
    const { runCommand } = await import('../commands/registry.js');
    const out = await runCommand(ctx, cmd.slice(0, len || cmd.length).trim(), { noAutoPrompt: !ctx.interactive });
    ctx.pgmMsgs = (ctx.pgmMsgs || []).concat(out);
  },

  // QSNDDTAQ(nombre, biblioteca, longitud, datos [, longitud clave, clave])
  async QSNDDTAQ(ctx, refs) {
    const q = await resolveDtaq(rtrim(refs[0]?.get()), rtrim(refs[1]?.get()) || '*LIBL', ctx.libl);
    const len = num(refs[2]?.get());
    const data = str(refs[3]?.get());
    const keylen = refs[4] ? num(refs[4].get()) : 0;
    const key = refs[5] ? str(refs[5].get()).slice(0, keylen || undefined) : '';
    await sendDtaq(q, len > 0 ? data.slice(0, len) : rtrim(data), { key, sender: q.senderInfo ? `${qualifiedJob(ctx.job)} ${ctx.job.user}` : '' });
  },

  // QRCVDTAQ(nombre, biblioteca, longitud(salida), datos(salida), espera [, orden clave, longitud clave, clave, long. remitente, remitente])
  async QRCVDTAQ(ctx, refs) {
    const q = await resolveDtaq(rtrim(refs[0]?.get()), rtrim(refs[1]?.get()) || '*LIBL', ctx.libl);
    const wait = refs[4] ? num(refs[4].get()) : 0;
    const order = refs[5] ? rtrim(refs[5].get()) || 'EQ' : 'EQ';
    const keylen = refs[6] ? num(refs[6].get()) : 0;
    const key = refs[7] && keylen ? str(refs[7].get()).slice(0, keylen) : undefined;
    const prev = ctx.job.status;
    ctx.job.status = 'DEQW';
    const ac = new AbortController();
    const poll = setInterval(() => { if (ctx.job.cancel) ac.abort(); }, 300);
    let e;
    try { e = await receiveDtaq(q, { wait, order, key, signal: ac.signal }); } finally { clearInterval(poll); ctx.job.status = prev; }
    if (ctx.job.cancel) { const { RpgCancel } = await import('../../../../shared/rpg/interpreter.js'); ctx.job.cancel = false; throw new RpgCancel(); }
    refs[2]?.set(e ? e.data.length : 0);
    refs[3]?.set(e ? e.data : '');
    if (e && refs[7] && keylen) refs[7].set(e.key);
    if (refs[9]) refs[9].set(e ? e.sender : '');
  },

  async QCLRDTAQ(ctx, refs) {
    const q = await resolveDtaq(rtrim(refs[0]?.get()), rtrim(refs[1]?.get()) || '*LIBL', ctx.libl);
    const order = refs[2] ? rtrim(refs[2].get()) : 'EQ';
    const keylen = refs[3] ? num(refs[3].get()) : 0;
    const key = refs[4] && keylen ? str(refs[4].get()).slice(0, keylen) : undefined;
    await clearDtaq(q, { key, order });
  },

  // QMHSNDPM(msgid, msgf, msgdta, msgdtalen, msgtype, callstack, counter, msgkey, errcode): se usa sobre todo para *ESCAPE/*DIAG/*COMP.
  async QMHSNDPM(ctx, refs) {
    const id = rtrim(refs[0]?.get()) || 'CPF9898';
    const data = str(refs[2]?.get()).slice(0, num(refs[3]?.get()) || undefined);
    const type = rtrim(refs[4]?.get()) || '*INFO';
    logJob(ctx.job, id, type, rtrim(data));
    if (type === '*ESCAPE') throw new CLError('CPF9898', rtrim(data));
    ctx.pgmMsgs = (ctx.pgmMsgs || []).concat([{ id, text: rtrim(data), sev: type === '*DIAG' ? 30 : 0 }]);
  },
};

// Interfaces de las APIs (para IWS, XMLSERVICE, /api/v1/programs y los servidores host).
const C = (len) => ({ t: 'char', len });
const PK = (digits, dec = 0) => ({ t: 'packed', digits, dec });
export const SYSTEM_PROGRAM_PARAMS = {
  QCMDEXC: [{ name: 'CMD', type: C(6000), io: 'in' }, { name: 'LEN', type: PK(15, 5), io: 'in' }],
  QSNDDTAQ: [{ name: 'DTAQ', type: C(10), io: 'in' }, { name: 'LIB', type: C(10), io: 'in' }, { name: 'LEN', type: PK(5), io: 'in' }, { name: 'DATA', type: C(64512), io: 'in' }, { name: 'KEYLEN', type: PK(3), io: 'in' }, { name: 'KEY', type: C(256), io: 'in' }],
  QRCVDTAQ: [{ name: 'DTAQ', type: C(10), io: 'in' }, { name: 'LIB', type: C(10), io: 'in' }, { name: 'LEN', type: PK(5), io: 'both' }, { name: 'DATA', type: C(64512), io: 'both' }, { name: 'WAIT', type: PK(5), io: 'in' }],
  QCLRDTAQ: [{ name: 'DTAQ', type: C(10), io: 'in' }, { name: 'LIB', type: C(10), io: 'in' }],
};

export function systemProgram(name) {
  return PROGRAMS[String(name || '').toUpperCase()] || null;
}

// ---------- Procedimientos del sistema ----------
const PROCS = {
  // CGI (QZHBCGI)
  QTMHWRSTOUT(ctx, [data, len]) {
    if (!ctx.cgi) throw new RpgError('00211', 'RNX0211', 'QtmhWrStout is only available in CGI programs (HTTP server).');
    const s = str(data);
    ctx.cgi.out.push(len !== undefined && num(len) >= 0 ? s.slice(0, num(len)) : s);
  },
  QTMHRDSTIN(ctx, [, buflen], places) {
    const body = ctx.cgi ? ctx.cgi.stdin.toString('utf8') : '';
    const chunk = body.slice(ctx.cgi?.stdinPos || 0, (ctx.cgi?.stdinPos || 0) + num(buflen));
    if (ctx.cgi) ctx.cgi.stdinPos = (ctx.cgi.stdinPos || 0) + chunk.length;
    places[0]?.set(chunk);
    places[2]?.set(chunk.length);
  },
  QTMHGETENV(ctx, [, buflen, , name, namelen], places) {
    const n = str(name).slice(0, num(namelen) || undefined).trim();
    const v = str(ctx.cgi?.env?.[n] ?? process.env[n] ?? '');
    places[0]?.set(v.slice(0, num(buflen) || v.length));
    places[2]?.set(v.length);
  },
  GETENV(ctx, [name]) {
    const n = str(name).split('\u0000')[0].trim();
    const v = ctx.cgi?.env?.[n] ?? process.env[n];
    return v === undefined ? null : `${v}\u0000`;
  },
  PUTENV(ctx, [kv]) {
    const [k, ...rest] = str(kv).split('\u0000')[0].split('=');
    if (ctx.cgi) ctx.cgi.env[k.trim()] = rest.join('='); else ctx.job.env = { ...(ctx.job.env || {}), [k.trim()]: rest.join('=') };
    return 0;
  },
  // C runtime (QC2LE): system() ejecuta un mandato CL y devuelve 0 (correcto) o 1 (error).
  async SYSTEM(ctx, [cmd]) {
    const { runCommand } = await import('../commands/registry.js');
    try {
      await runCommand(ctx, str(cmd).split('\u0000')[0].trim(), { noAutoPrompt: true });
      ctx.job.excpMsgId = '';
      return 0;
    } catch (e) {
      ctx.job.excpMsgId = e.msgId || 'CPF9898';
      logJob(ctx.job, e.msgId || 'CPF9898', '*ESCAPE', e.message, { sev: 40 });
      return 1;
    }
  },
  async SLEEP(ctx, [secs]) { await delay(ctx, num(secs) * 1000); return 0; },
  async USLEEP(ctx, [us]) { await delay(ctx, num(us) / 1000); return 0; },

  // HTTPAPI de Scott Klement (subconjunto): el RPG consume servicios REST/SOAP externos.
  async HTTP_STRING(ctx, [method, url, data, ctype]) {
    const r = await httpCall(ctx, rtrim(method) || 'GET', rtrim(url), data === undefined ? undefined : rtrim(data), ctype === undefined ? undefined : rtrim(ctype));
    if (r.status >= 300) throw new RpgError('00202', 'RNX9999', `HTTP ${r.status} from ${rtrim(url)}: ${r.body.slice(0, 200)}`);
    return r.body;
  },
  // http_req(method: url: resultStmf: resultStr: sendStmf: sendStr: contentType) → código HTTP (1 = error de red)
  async HTTP_REQ(ctx, [method, url, rstmf, , sstmf, sendStr, ctype], places) {
    let body;
    if (sstmf && rtrim(sstmf) && rtrim(sstmf) !== '*OMIT') {
      const { readFile } = await import('../ifs.js');
      body = (await readFile(rtrim(sstmf))).toString('utf8');
    } else if (sendStr !== undefined && sendStr !== null) body = rtrim(sendStr);
    const r = await httpCall(ctx, rtrim(method) || 'GET', rtrim(url), body, ctype ? rtrim(ctype) : undefined).catch((e) => ({ status: 1, body: '', error: e.message }));
    if (rstmf && rtrim(rstmf) && rtrim(rstmf) !== '*OMIT') {
      const { writeFile } = await import('../ifs.js');
      await writeFile(rtrim(rstmf), r.body || '');
    }
    places[3]?.set(r.body || '');
    return r.status;
  },
  HTTP_SETAUTH(ctx, [type, user, pwd]) { ctx.job.httpAuth = { type: rtrim(type), user: rtrim(user), pwd: rtrim(pwd) }; },
  HTTP_SETOPTION(ctx, [opt, val]) { ctx.job.httpOpts = { ...(ctx.job.httpOpts || {}), [rtrim(opt).toLowerCase()]: rtrim(val) }; },
  HTTP_XPROC() { /* sin efecto */ },
  HTTP_DEBUG() { /* sin efecto */ },
  HTTP_SETCCSIDS() { /* UTF-8 siempre */ },
  HTTP_ERROR(ctx) { return ctx.job.httpError || ''; },
  HTTP_URLENCODE(ctx, [s]) { return encodeURIComponent(rtrim(s)); },
};

async function httpCall(ctx, method, url, body, ctype) {
  const headers = {};
  const a = ctx.job.httpAuth;
  if (a && a.user) headers.Authorization = `Basic ${Buffer.from(`${a.user}:${a.pwd}`).toString('base64')}`;
  if (ctx.job.httpOpts?.['user-agent']) headers['User-Agent'] = ctx.job.httpOpts['user-agent'];
  if (body !== undefined) headers['Content-Type'] = ctype || ctx.job.httpOpts?.['content-type'] || 'text/plain; charset=utf-8';
  if (ctx.job.httpOpts?.['accept']) headers.Accept = ctx.job.httpOpts.accept;
  const prev = ctx.job.status;
  ctx.job.status = 'SELW';
  try {
    const r = await httpRequest({ method, url, headers, body, timeout: Number(ctx.job.httpOpts?.timeout || 60) * 1000, client: qualifiedJob(ctx.job) });
    ctx.job.httpError = r.status >= 300 ? `HTTP ${r.status}` : '';
    logJob(ctx.job, '', '*INFO', `HTTP ${method} ${url} -> ${r.status} (${r.body.length} bytes)`);
    return r;
  } catch (e) {
    ctx.job.httpError = e.message;
    throw e;
  } finally { ctx.job.status = prev; }
}

async function delay(ctx, ms) {
  const prev = ctx.job.status;
  ctx.job.status = 'DLYW';
  const until = Date.now() + ms;
  try {
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(300, until - Date.now())));
      if (ctx.job.cancel) { const { RpgCancel } = await import('../../../../shared/rpg/interpreter.js'); ctx.job.cancel = false; throw new RpgCancel(); }
    }
  } finally { ctx.job.status = prev; }
}

/** ¿Es un procedimiento del sistema (servicios de IBM enlazados por omisión: QC2LE, QZHBCGI, QTCP…)? */
export function isSystemProc(name) { return !!PROCS[String(name || '').toUpperCase()]; }

export async function callSystemProc(ctx, name, args, places = []) {
  const fn = PROCS[String(name || '').toUpperCase()];
  if (!fn) throw new RpgError('00211', 'RNX0211', `Program or procedure ${name} is not defined.`);
  try {
    return await fn(ctx, args, places);
  } catch (e) {
    if (e instanceof CLError) throw new RpgError('00202', e.msgId || 'CPF9898', e.message);
    throw e;
  }
}
