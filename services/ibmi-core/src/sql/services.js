// Servicios SQL de IBM i (Db2 for i) resueltos en el núcleo antes de llegar a Db2:
//  - Procedimientos: QSYS2.QCMDEXC, QCMDEXC, QSYS2.SEND_DATA_QUEUE, QSYS2.CLEAR_DATA_QUEUE.
//  - Funciones escalares: QSYS2.HTTP_GET/POST/PUT/PATCH/DELETE(_VERBOSE), SYSTOOLS.HTTPGETCLOB/HTTPPOSTCLOB/…,
//    QSYS2.MQSEND/MQREAD/MQRECEIVE (y sin calificar).
//  - Funciones de tabla y vistas dinámicas: ACTIVE_JOB_INFO, SYSTEM_STATUS_INFO, NETSTAT_INFO, DATA_QUEUE_INFO,
//    DATA_QUEUE_ENTRIES, RECEIVE_DATA_QUEUE, LIBRARY_LIST_INFO, OBJECT_STATISTICS, JOBLOG_INFO, IFS_OBJECT_STATISTICS…
// Las vistas fijas sobre el catálogo (USER_INFO, SYSTABLES, SYSCOLUMNS…) se crean como vistas reales en Db2 (catalog.js),
// así también las ven los clientes que se conectan directamente por DRDA.
import { CLError } from '../messages.js';
import { allJobs, systemStatus, SYS } from '../system.js';
import { httpRequest } from '../net/httpclient.js';
import { resolveDtaq, sendDtaq, receiveDtaq, clearDtaq, dtaqEntries, allDtaqs, dtaqCount } from '../dtaq.js';
import { netstatRows } from '../net/servers.js';
import { gw } from '../objects.js';

// ---------- Utilidades de análisis ----------
const mask = (s) => s.replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length)).replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
const sqlStr = (v) => `'${String(v ?? '').replace(/'/g, "''")}'`;

function matchParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitArgs(text, masked) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out.map((s) => s.trim());
}

const countMarks = (masked, upTo) => (masked.slice(0, upTo).match(/\?/g) || []).length;

/** Evalúa un argumento simple: literal, ?, número, NULL, CAST(? AS …). Devuelve {ok, value, name?}. */
function evalArg(raw, params, markIdx) {
  let s = raw.trim();
  let name = null;
  const nm = /^([A-Z_][A-Z0-9_]*)\s*=>\s*([\s\S]+)$/i.exec(s);
  if (nm) { name = nm[1].toUpperCase(); s = nm[2].trim(); }
  const cast = /^CAST\s*\(([\s\S]+)\s+AS\s+[\w\s(),]+\)$/i.exec(s);
  if (cast) s = cast[1].trim();
  if (/^'(?:[^']|'')*'$/s.test(s)) return { ok: true, value: s.slice(1, -1).replace(/''/g, "'"), name };
  if (s === '?') return { ok: true, value: params[markIdx.i++], name, mark: true };
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return { ok: true, value: Number(s), name };
  if (/^NULL$/i.test(s)) return { ok: true, value: null, name };
  if (/^(DEFAULT)$/i.test(s)) return { ok: true, value: undefined, name };
  return { ok: false, raw, name };
}

/**
 * Reescribe llamadas a funciones: re = /\bNOMBRE\s*\(/, handler(args) → {sql, params} sustituye la llamada.
 * Mantiene el orden de los marcadores ? del resto de la sentencia.
 */
async function rewriteCalls(text, params, re, handler) {
  let out = text;
  let outParams = [...params];
  let guard = 0;
  for (;;) {
    if (guard++ > 50) break;
    const masked = mask(out);
    const m = re.exec(masked);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const close = matchParen(masked, open);
    if (close < 0) break;
    const before = countMarks(masked, m.index);
    const inner = out.slice(open + 1, close);
    const innerMasked = masked.slice(open + 1, close);
    const rawArgs = splitArgs(inner, innerMasked);
    const usedMarks = (innerMasked.match(/\?/g) || []).length;
    const idx = { i: before };
    const args = rawArgs.map((a) => evalArg(a, outParams, idx));
    if (args.some((a) => !a.ok)) throw new CLError('CPF9898', `SQL service ${m[0].replace(/\s*\($/, '')}: only literals and parameter markers are supported as arguments.`);
    const rep = await handler(args, m);
    out = out.slice(0, m.index) + rep.sql + out.slice(close + 1);
    outParams = [...outParams.slice(0, before), ...(rep.params || []), ...outParams.slice(before + usedMarks)];
  }
  return { sql: out, params: outParams };
}

const named = (args, names) => {
  const o = {};
  args.forEach((a, i) => { const k = a.name || names[i]; if (k) o[k] = a.value; });
  return o;
};

// ---------- Tablas virtuales (VALUES en línea con tipos explícitos) ----------
function valuesTable(cols, rows) {
  const typed = (v, t) => {
    if (/^(INTEGER|BIGINT|SMALLINT|DECIMAL|DOUBLE)/i.test(t)) return `CAST(${Number.isFinite(Number(v)) ? Number(v) : 0} AS ${t})`;
    if (/^TIMESTAMP/i.test(t)) return v ? `TIMESTAMP(${sqlStr(v)})` : 'CAST(NULL AS TIMESTAMP)';
    return `CAST(${sqlStr(v)} AS ${t})`;
  };
  const names = cols.map((c) => c[0]).join(', ');
  if (!rows.length) {
    return `(SELECT * FROM (VALUES (${cols.map(([, t]) => typed(/^(INTEGER|BIGINT|SMALLINT|DECIMAL|DOUBLE)/i.test(t) ? 0 : '', t)).join(', ')})) AS V(${names}) WHERE 1 = 0)`;
  }
  return `(SELECT * FROM (VALUES ${rows.map((r) => `(${cols.map(([n, t], i) => typed(r[i], t)).join(', ')})`).join(', ')}) AS V(${names}))`;
}

const tsOf = (ms) => {
  if (!ms) return null;
  const d = new Date(ms);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000`;
};

const VIRTUAL = {
  async ACTIVE_JOB_INFO() {
    const cols = [['ORDINAL_POSITION', 'INTEGER'], ['JOB_NAME', 'VARCHAR(28)'], ['JOB_NAME_SHORT', 'VARCHAR(10)'], ['JOB_USER', 'VARCHAR(10)'], ['JOB_NUMBER', 'VARCHAR(6)'],
      ['SUBSYSTEM', 'VARCHAR(10)'], ['SUBSYSTEM_LIBRARY_NAME', 'VARCHAR(10)'], ['AUTHORIZATION_NAME', 'VARCHAR(10)'], ['JOB_TYPE', 'VARCHAR(3)'], ['FUNCTION_TYPE', 'VARCHAR(3)'],
      ['FUNCTION', 'VARCHAR(10)'], ['JOB_STATUS', 'VARCHAR(4)'], ['ELAPSED_CPU_PERCENTAGE', 'DECIMAL(10,1)'], ['CPU_TIME', 'BIGINT'], ['RUN_PRIORITY', 'INTEGER'],
      ['THREAD_COUNT', 'INTEGER'], ['MEMORY_POOL', 'VARCHAR(10)'], ['JOB_ENTERED_SYSTEM_TIME', 'TIMESTAMP'], ['JOB_ACTIVE_TIME', 'TIMESTAMP']];
    const rows = allJobs().map((j, i) => {
      const fn = String(j.function || '');
      const [ft, f] = fn.includes('-') ? [fn.split('-')[0], fn.split('-').slice(1).join('-')] : ['', fn];
      return [i + 1, `${j.number}/${j.user}/${j.name}`, j.name, j.user, j.number, j.subsystem, 'QSYS', j.user, j.type, ft.slice(0, 3), f.slice(0, 10), String(j.status).slice(0, 4), j.cpuPct || 0, Math.round(j.cpuMs || 0), j.priority || 20, j.threads || 1, j.type === 'BCH' ? '*BASE' : '*INTERACT', tsOf(j.startedAt), tsOf(j.startedAt)];
    });
    return valuesTable(cols, rows);
  },
  async SYSTEM_STATUS_INFO() {
    const s = systemStatus();
    const cols = [['HOST_NAME', 'VARCHAR(255)'], ['TOTAL_JOBS_IN_SYSTEM', 'INTEGER'], ['ACTIVE_JOBS_IN_SYSTEM', 'INTEGER'], ['ELAPSED_CPU_USED', 'DECIMAL(10,1)'],
      ['CONFIGURED_CPUS', 'INTEGER'], ['MAIN_STORAGE_SIZE', 'BIGINT'], ['SYSTEM_ASP_USED', 'DECIMAL(10,4)'], ['SERIAL_NUMBER', 'VARCHAR(10)'], ['MACHINE_MODEL', 'VARCHAR(4)'],
      ['MACHINE_TYPE', 'VARCHAR(4)'], ['OS_VERSION', 'VARCHAR(10)'], ['OS_RELEASE', 'VARCHAR(10)'], ['LAST_IPL_TIME', 'TIMESTAMP'], ['ELAPSED_TIME', 'INTEGER']];
    return valuesTable(cols, [[SYS.name, s.jobs, s.jobs, s.cpuPct, s.cpus, Math.round(s.memTotal / 1024), s.aspUsedPct, SYS.serial, SYS.model.split('-')[1], SYS.model.split('-')[0], '7', '5', tsOf(SYS.iplAt), s.uptime]]);
  },
  async NETSTAT_INFO() {
    const cols = [['CONNECTION_TYPE', 'VARCHAR(10)'], ['REMOTE_ADDRESS', 'VARCHAR(45)'], ['REMOTE_PORT', 'INTEGER'], ['LOCAL_ADDRESS', 'VARCHAR(45)'], ['LOCAL_PORT', 'INTEGER'],
      ['TCP_STATE', 'VARCHAR(11)'], ['IDLE_TIME', 'BIGINT'], ['BYTES_SENT_REMOTELY', 'BIGINT'], ['BYTES_RECEIVED_LOCALLY', 'BIGINT'], ['SERVER_NAME', 'VARCHAR(20)'], ['AUTHORIZATION_NAME', 'VARCHAR(10)']];
    const rows = netstatRows().map((r) => [r.state === '*UDP' ? 'IPV4' : 'IPV4', r.remote === '*' ? '0.0.0.0' : r.remote, Number(r.rport) || 0, '0.0.0.0', Number(r.local) || 0,
      r.state === 'Listen' ? 'LISTEN' : r.state === '*UDP' ? 'UDP' : 'ESTABLISHED', r.idle * 1000, r.bytesOut, r.bytesIn, r.server, r.user || '']);
    return valuesTable(cols, rows);
  },
  async DATA_QUEUE_INFO() {
    const cols = [['DATA_QUEUE_NAME', 'VARCHAR(10)'], ['DATA_QUEUE_LIBRARY', 'VARCHAR(10)'], ['DATA_QUEUE_TYPE', 'VARCHAR(8)'], ['MAXIMUM_MESSAGE_LENGTH', 'INTEGER'],
      ['SEQUENCE', 'VARCHAR(6)'], ['KEY_LENGTH', 'INTEGER'], ['INCLUDE_SENDER_ID', 'VARCHAR(3)'], ['CURRENT_MESSAGES', 'INTEGER'], ['TEXT_DESCRIPTION', 'VARCHAR(50)']];
    const rows = [];
    for (const q of await allDtaqs()) {
      const d = JSON.parse(q.DATA || '{}');
      rows.push([q.NAME, q.LIB, 'STANDARD', d.maxlen || 0, String(d.seq || '*FIFO').replace('*', ''), d.keylen || 0, d.senderInfo ? 'YES' : 'NO', await dtaqCount({ lib: q.LIB, name: q.NAME }), q.TEXT || '']);
    }
    return valuesTable(cols, rows);
  },
  async LIBRARY_LIST_INFO(ctx) {
    const cols = [['ORDINAL_POSITION', 'INTEGER'], ['SCHEMA_NAME', 'VARCHAR(128)'], ['SYSTEM_SCHEMA_NAME', 'VARCHAR(10)'], ['TYPE', 'VARCHAR(7)']];
    const sysl = ['QSYS', 'QSYS2', 'QHLPSYS', 'QUSRSYS'];
    return valuesTable(cols, ctx.libl.map((l, i) => [i + 1, l, l, sysl.includes(l) ? 'SYSTEM' : l === ctx.job.curlib ? 'CURRENT' : 'USER']));
  },
  async JOBLOG_INFO(ctx) {
    const cols = [['ORDINAL_POSITION', 'INTEGER'], ['MESSAGE_ID', 'VARCHAR(7)'], ['MESSAGE_TYPE', 'VARCHAR(13)'], ['SEVERITY', 'INTEGER'], ['MESSAGE_TIMESTAMP', 'TIMESTAMP'], ['MESSAGE_TEXT', 'VARCHAR(1024)']];
    return valuesTable(cols, ctx.job.joblog.slice(-500).map((e, i) => [i + 1, (e.id || '').slice(0, 7), String(e.type || '').replace('*', ''), e.sev || 0, tsOf(e.time), String(e.text || '').slice(0, 1024)]));
  },
  async ENVIRONMENT_VARIABLE_INFO(ctx) {
    const cols = [['ENVIRONMENT_VARIABLE_TYPE', 'VARCHAR(6)'], ['ENVIRONMENT_VARIABLE_NAME', 'VARCHAR(128)'], ['ENVIRONMENT_VARIABLE_VALUE', 'VARCHAR(1024)']];
    const env = { QIBM_SYSTEM_NAME: SYS.name, TZ: process.env.TZ || 'UTC', ...(ctx.job.env || {}) };
    return valuesTable(cols, Object.entries(env).map(([k, v]) => ['JOB', k, String(v)]));
  },
};

// Funciones de tabla con argumentos (TABLE(QSYS2.X(...)))
const TABLE_FUNCS = {
  async DATA_QUEUE_ENTRIES(ctx, a) {
    const o = named(a, ['DATA_QUEUE', 'DATA_QUEUE_LIBRARY', 'SELECTION_TYPE', 'KEY_DATA', 'KEY_ORDER']);
    const q = await resolveDtaq(o.DATA_QUEUE, o.DATA_QUEUE_LIBRARY || '*LIBL', ctx.libl);
    const cols = [['ORDINAL_POSITION', 'INTEGER'], ['MESSAGE_DATA', 'VARCHAR(32000)'], ['MESSAGE_DATA_UTF8', 'VARCHAR(32000)'], ['KEY_DATA', 'VARCHAR(256)'], ['MESSAGE_ENQUEUE_TIMESTAMP', 'TIMESTAMP'], ['SENDER_JOB_NAME', 'VARCHAR(80)']];
    const rows = (await dtaqEntries(q)).map((e) => [e.ordinal, e.data.slice(0, 32000), e.data.slice(0, 32000), e.key, String(e.enqueued || '').replace('T', ' ').replace('Z', ''), e.sender]);
    return valuesTable(cols, rows);
  },
  async RECEIVE_DATA_QUEUE(ctx, a) {
    const o = named(a, ['DATA_QUEUE', 'DATA_QUEUE_LIBRARY', 'WAIT_TIME', 'KEY_DATA', 'KEY_ORDER', 'REMOVE']);
    const q = await resolveDtaq(o.DATA_QUEUE, o.DATA_QUEUE_LIBRARY || '*LIBL', ctx.libl);
    const e = await receiveDtaq(q, { wait: Number(o.WAIT_TIME ?? 0), key: o.KEY_DATA, order: o.KEY_ORDER || 'EQ', peek: String(o.REMOVE || 'YES').toUpperCase() === 'NO' });
    const cols = [['MESSAGE_DATA', 'VARCHAR(32000)'], ['MESSAGE_DATA_UTF8', 'VARCHAR(32000)'], ['MESSAGE_DATA_BINARY', 'VARCHAR(32000)'], ['KEY_DATA', 'VARCHAR(256)'], ['SENDER_JOB_NAME', 'VARCHAR(80)'], ['SENDER_CURRENT_USER', 'VARCHAR(10)']];
    return valuesTable(cols, e ? [[e.data, e.data, e.data, e.key, e.sender, '']] : []);
  },
  async OBJECT_STATISTICS(ctx, a) {
    const o = named(a, ['OBJECT_SCHEMA', 'OBJTYPELIST', 'OBJECT_NAME']);
    const lib = String(o.OBJECT_SCHEMA || '*LIBL').toUpperCase();
    const libs = lib === '*LIBL' ? ctx.libl : lib === '*ALLUSR' || lib === '*ALL' ? null : [lib];
    const types = String(o.OBJTYPELIST || '*ALL').toUpperCase().split(/[\s,]+/).filter((t) => t && t !== '*ALL');
    const where = [];
    const p = [];
    if (libs) { where.push(`LIB IN (${libs.map(() => '?').join(',')})`); p.push(...libs); }
    if (types.length) { where.push(`TYPE IN (${types.map(() => '?').join(',')})`); p.push(...types); }
    if (o.OBJECT_NAME && o.OBJECT_NAME !== '*ALL') { where.push('NAME = ?'); p.push(String(o.OBJECT_NAME).toUpperCase()); }
    const rows = await gw.rows(`SELECT LIB, NAME, TYPE, ATTR, TEXT, OWNER, CREATED, CHANGED, OBJSIZE FROM QSYS.OBJECTS ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY LIB, NAME`, p);
    const cols = [['OBJNAME', 'VARCHAR(10)'], ['OBJTYPE', 'VARCHAR(8)'], ['OBJOWNER', 'VARCHAR(10)'], ['OBJDEFINER', 'VARCHAR(10)'], ['OBJCREATED', 'TIMESTAMP'], ['OBJSIZE', 'BIGINT'],
      ['OBJTEXT', 'VARCHAR(50)'], ['OBJATTRIBUTE', 'VARCHAR(10)'], ['OBJLIB', 'VARCHAR(10)'], ['LAST_USED_TIMESTAMP', 'TIMESTAMP'], ['CHANGE_TIMESTAMP', 'TIMESTAMP']];
    return valuesTable(cols, rows.map((r) => [r.NAME, r.TYPE, r.OWNER, r.OWNER, r.CREATED, Number(r.OBJSIZE || 0), r.TEXT || '', r.ATTR || '', r.LIB, r.CHANGED, r.CHANGED]));
  },
  async IFS_OBJECT_STATISTICS(ctx, a) {
    const o = named(a, ['START_PATH_NAME', 'OMIT_LIST', 'SUBTREE_DIRECTORIES', 'OBJECT_TYPE_LIST']);
    const { walk, stat } = await import('../ifs.js');
    const root = String(o.START_PATH_NAME || '/');
    const sub = String(o.SUBTREE_DIRECTORIES || 'NO').toUpperCase() === 'YES';
    const list = [await stat(root), ...(await walk(root, sub ? 8 : 0))].filter(Boolean);
    const cols = [['PATH_NAME', 'VARCHAR(1024)'], ['OBJECT_TYPE', 'VARCHAR(10)'], ['DATA_SIZE', 'BIGINT'], ['OBJECT_OWNER', 'VARCHAR(10)'], ['CREATE_TIMESTAMP', 'TIMESTAMP'], ['DATA_CHANGE_TIMESTAMP', 'TIMESTAMP'], ['CCSID', 'INTEGER']];
    return valuesTable(cols, list.map((s) => [s.path, s.type, s.size, 'QSYS', tsOf(+s.ctime), tsOf(+s.mtime), 1208]));
  },
};
for (const k of Object.keys(VIRTUAL)) if (!TABLE_FUNCS[k]) TABLE_FUNCS[k] = (ctx) => VIRTUAL[k](ctx);

// ---------- HTTP ----------
const HTTP_FN = /\b(?:QSYS2\s*\.\s*)?(HTTP_(GET|POST|PUT|PATCH|DELETE)(_BLOB)?(_VERBOSE)?)\s*\(/i;
const SYSTOOLS_FN = /\bSYSTOOLS\s*\.\s*HTTP(GET|POST|PUT|DELETE|HEAD)(CLOB|BLOB)(VERBOSE)?\s*\(/i;

function headerOptions(opt) {
  // options JSON de QSYS2.HTTP_*: {"header":"Content-Type,application/json", "headers":{...}, "basicAuth":"user,pwd", "connectTimeout":...}
  const out = { headers: {}, timeout: 60000 };
  if (!opt) return out;
  let o;
  try { o = typeof opt === 'string' ? JSON.parse(opt) : opt; } catch { return out; }
  const addHeader = (h) => { const i = String(h).indexOf(','); if (i > 0) out.headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); };
  if (o.header) (Array.isArray(o.header) ? o.header : [o.header]).forEach(addHeader);
  if (o.headers && typeof o.headers === 'object') Object.assign(out.headers, o.headers);
  if (o.basicAuth) { const [u, p] = String(o.basicAuth).split(','); out.headers.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`; }
  if (o.bearerToken) out.headers.Authorization = `Bearer ${o.bearerToken}`;
  if (o.ioTimeout || o.connectTimeout) out.timeout = Number(o.ioTimeout || o.connectTimeout);
  return out;
}

function systoolsHeaders(xml) {
  // <httpHeader connectTimeout="10000"><header name="Content-Type" value="application/json"/></httpHeader>
  const out = { headers: {}, timeout: 60000 };
  if (!xml) return out;
  for (const m of String(xml).matchAll(/<header\s+name\s*=\s*"([^"]+)"\s+value\s*=\s*"([^"]*)"/gi)) out.headers[m[1]] = m[2];
  const t = /connectTimeout\s*=\s*"(\d+)"/i.exec(String(xml));
  if (t) out.timeout = Number(t[1]);
  return out;
}

async function doHttp(ctx, method, url, body, opts) {
  const r = await httpRequest({ method, url, headers: opts.headers, body: body === null || body === undefined ? undefined : String(body), timeout: opts.timeout, client: ctx.client });
  return r;
}

// ---------- MQ (funciones de Db2 for i: MQSEND, MQREAD, MQRECEIVE) ----------
const MQ_FN = /\b(?:QSYS2\s*\.\s*|DB2MQ\s*\.\s*)?(MQSEND|MQREAD|MQRECEIVE)\s*\(/i;

// ---------- Punto de entrada ----------
/** Devuelve un resultado si la sentencia es un servicio del núcleo; si no, null (y Ctx la envía a Db2). */
export async function sqlServices(ctx, text, params = []) {
  const T = text.trim().replace(/;\s*$/, '');
  const U = mask(T).toUpperCase();
  if (!/QCMDEXC|QSYS2|SYSTOOLS|HTTP_|MQSEND|MQREAD|MQRECEIVE|DATA_QUEUE/.test(U)) return null;
  // CALL QSYS2.QCMDEXC('mandato') / CALL QCMDEXC('mandato', 0000000010.00000)
  let m;
  if ((m = /^CALL\s+(?:QSYS2\s*\.\s*|QSYS\s*\.\s*)?(QCMDEXC|SEND_DATA_QUEUE|CLEAR_DATA_QUEUE)\s*\(/i.exec(T))) {
    const open = m[0].length - 1;
    const masked = mask(T);
    const close = matchParen(masked, open);
    const args = splitArgs(T.slice(open + 1, close), masked.slice(open + 1, close)).map((a) => evalArg(a, params, { i: countMarks(masked, open) }));
    if (args.some((a) => !a.ok)) return { error: 'Only literals and parameter markers are supported.', sqlstate: '42601', sqlcode: -104 };
    const proc = m[1].toUpperCase();
    try {
      if (proc === 'QCMDEXC') {
        const o = named(args, ['COMMAND', 'LENGTH']);
        const cmd = String(o.COMMAND ?? '').slice(0, o.LENGTH ? Number(o.LENGTH) : undefined).trim();
        const { runCommand } = await import('../commands/registry.js');
        await runCommand(ctx, cmd, { noAutoPrompt: true });
        return { columns: [], rows: [], rowCount: 0 };
      }
      if (proc === 'SEND_DATA_QUEUE') {
        const o = named(args, ['MESSAGE_DATA', 'DATA_QUEUE', 'DATA_QUEUE_LIBRARY', 'KEY_DATA']);
        const data = o.MESSAGE_DATA ?? o.MESSAGE_DATA_UTF8 ?? o.MESSAGE_DATA_BINARY ?? '';
        const q = await resolveDtaq(o.DATA_QUEUE, o.DATA_QUEUE_LIBRARY || '*LIBL', ctx.libl);
        await sendDtaq(q, data, { key: o.KEY_DATA || '', sender: q.senderInfo ? ctx.client : '' });
        return { columns: [], rows: [], rowCount: 0 };
      }
      const o = named(args, ['DATA_QUEUE', 'DATA_QUEUE_LIBRARY', 'KEY_DATA', 'KEY_ORDER']);
      const q = await resolveDtaq(o.DATA_QUEUE, o.DATA_QUEUE_LIBRARY || '*LIBL', ctx.libl);
      await clearDtaq(q, { key: o.KEY_DATA, order: o.KEY_ORDER || 'EQ' });
      return { columns: [], rows: [], rowCount: 0 };
    } catch (e) {
      // SQL0443: la rutina devolvió un error (el mensaje CPF va en el texto, como en IBM i).
      return { error: `SQL0443 Trigger program or external routine detected an error. ${e.msgId || 'CPF9898'}: ${e.message}`, sqlstate: '38501', sqlcode: -443 };
    }
  }

  let sql = T;
  let p = [...params];
  try {
    // HTTP_* de QSYS2
    if (HTTP_FN.test(mask(sql))) {
      ({ sql, params: p } = await rewriteCalls(sql, p, new RegExp(HTTP_FN.source, 'i'), async (args, mm) => {
        const method = mm[2].toUpperCase();
        const verbose = !!mm[4];
        const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
        const o = named(args, hasBody ? ['URL', 'REQUEST_MESSAGE', 'OPTIONS'] : ['URL', 'OPTIONS']);
        const opts = headerOptions(o.OPTIONS);
        const r = await doHttp(ctx, method, o.URL, o.REQUEST_MESSAGE, opts);
        if (verbose) {
          const hdr = JSON.stringify({ HTTP_STATUS_CODE: r.status, ...r.headers });
          return { sql: `(SELECT * FROM (VALUES (CAST(? AS CLOB(16M)), CAST(? AS CLOB(1M)))) AS HV(RESPONSE_MESSAGE, RESPONSE_HTTP_HEADER))`, params: [r.body, hdr] };
        }
        if (r.status >= 400) throw Object.assign(new Error(`HTTP request failed with status ${r.status}: ${r.body.slice(0, 200)}`), { sqlstate: '38000', sqlcode: -4302 });
        return { sql: 'CAST(? AS CLOB(16M))', params: [r.body] };
      }));
    }
    // SYSTOOLS.HTTPGETCLOB(url, header) / HTTPPOSTCLOB(url, header, body)
    if (SYSTOOLS_FN.test(mask(sql))) {
      ({ sql, params: p } = await rewriteCalls(sql, p, new RegExp(SYSTOOLS_FN.source, 'i'), async (args, mm) => {
        const method = mm[1].toUpperCase();
        const verbose = !!mm[3];
        const [url, header, body] = args.map((a) => a.value);
        const r = await doHttp(ctx, method, url, body, systoolsHeaders(header));
        if (verbose) return { sql: `(SELECT * FROM (VALUES (CAST(? AS CLOB(16M)), CAST(? AS CLOB(1M)))) AS HV(RESPONSEMSG, RESPONSEHTTPHEADER))`, params: [r.body, JSON.stringify({ status: r.status, ...r.headers })] };
        return { sql: 'CAST(? AS CLOB(16M))', params: [r.body] };
      }));
    }
    // MQSEND / MQREAD / MQRECEIVE
    if (MQ_FN.test(mask(sql))) {
      const mq = await import('../net/mq.js');
      ({ sql, params: p } = await rewriteCalls(sql, p, new RegExp(MQ_FN.source, 'i'), async (args, mm) => {
        const fn = mm[1].toUpperCase();
        const v = args.map((a) => a.value);
        if (fn === 'MQSEND') {
          // MQSEND(msg) | MQSEND(servicio, msg) | MQSEND(servicio, política, msg [, correlid])
          const [svc, pol, msg, corr] = v.length === 1 ? [null, null, v[0]] : v.length === 2 ? [v[0], null, v[1]] : v;
          await mq.mqSend(svc, msg, { correlId: corr, user: ctx.job.user, policy: pol });
          return { sql: `CAST('1' AS VARCHAR(1))`, params: [] };
        }
        const [svc, pol] = v;
        const msg = fn === 'MQREAD' ? await mq.mqBrowse(svc, { policy: pol }) : await mq.mqReceive(svc, { policy: pol });
        return msg === null ? { sql: 'CAST(NULL AS VARCHAR(32000))', params: [] } : { sql: 'CAST(? AS VARCHAR(32000))', params: [msg.data] };
      }));
    }
    // Funciones de tabla: TABLE(QSYS2.NOMBRE(args))
    const TF = new RegExp(`\\bTABLE\\s*\\(\\s*(?:QSYS2\\s*\\.\\s*)?(${Object.keys(TABLE_FUNCS).join('|')})\\s*\\(`, 'i');
    for (let guard = 0; guard < 20 && TF.test(mask(sql)); guard++) {
      const masked = mask(sql);
      const mm = TF.exec(masked);
      const tableOpen = masked.indexOf('(', mm.index);
      const tableClose = matchParen(masked, tableOpen);
      const name = mm[1].toUpperCase();
      const fnOpen = mm.index + mm[0].length - 1;
      const fnClose = matchParen(masked, fnOpen);
      const before = countMarks(masked, mm.index);
      const innerMasked = masked.slice(fnOpen + 1, fnClose);
      const args = splitArgs(sql.slice(fnOpen + 1, fnClose), innerMasked).map((a) => evalArg(a, p, { i: before }));
      if (args.some((a) => !a.ok)) throw new Error(`Table function ${name}: only literals and parameter markers are supported.`);
      const used = (masked.slice(mm.index, tableClose + 1).match(/\?/g) || []).length;
      const rep = await TABLE_FUNCS[name](ctx, args);
      sql = sql.slice(0, mm.index) + rep + withAlias(sql, tableClose + 1, name) + sql.slice(tableClose + 1);
      p = [...p.slice(0, before), ...p.slice(before + used)];
    }
    // Vistas dinámicas sin argumentos: QSYS2.ACTIVE_JOB_INFO, …
    const VV = new RegExp(`\\bQSYS2\\s*\\.\\s*(${Object.keys(VIRTUAL).join('|')})\\b(?!\\s*\\()`, 'i');
    for (let guard = 0; guard < 20 && VV.test(mask(sql)); guard++) {
      const mm = VV.exec(mask(sql));
      const name = mm[1].toUpperCase();
      const end = mm.index + mm[0].length;
      const rep = await VIRTUAL[name](ctx);
      sql = sql.slice(0, mm.index) + rep + withAlias(sql, end, name) + sql.slice(end);
    }
  } catch (e) {
    return { error: e.message, sqlstate: e.sqlstate || '38000', sqlcode: e.sqlcode ?? -443 };
  }
  if (sql === T) return null;
  const { qualifySql } = await import('../ctx.js');
  const q = await qualifySql(sql, ctx.libl, ctx.curlib);
  await ctx.ensureCommit();
  return gw.sql(q, p, { client: ctx.client, tx: ctx.job.cmt?.tx });
}

// Si tras la referencia no hay un alias, se añade uno con el nombre original para que NOMBRE.COLUMNA siga funcionando.
function withAlias(sql, pos, name) {
  const rest = mask(sql.slice(pos));
  const m = /^\s*(AS\s+)?([A-Z_][A-Z0-9_#@$]*)/i.exec(rest);
  const KW = new Set(['WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'ON', 'ORDER', 'GROUP', 'HAVING', 'FETCH', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'FOR', 'WITH', 'OFFSET', 'OPTIMIZE']);
  if (m && (m[1] || !KW.has(m[2].toUpperCase()))) return '';
  return ` AS ${name}`;
}
