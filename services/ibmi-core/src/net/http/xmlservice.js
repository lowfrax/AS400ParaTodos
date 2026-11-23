// XMLSERVICE (transporte HTTP de XMLCGI.PGM): el protocolo de los toolkits de IBM i para Python (itoolkit),
// Node.js (itoolkit), PHP (Toolkit) y Ruby. Admite <cmd>, <sh>/<qsh>, <pgm> (con <parm>/<data>/<ds> y <return>),
// <sql> (<connect> <query> <prepare> <execute> <fetch> <describe> <count> <free>) y <diag>.
// También se usa desde SQL: CALL XMLSERVICE.iPLUG512K(ipc, ctl, xmlin, ?) (ver sql/services.js).
import { send, sendJson } from '../../../../../shared/http.js';
import { parseXml, elems, local, esc, textOf, child } from '../../../../../shared/xml.js';
import { authenticate, authHttp } from '../../svc/auth.js';
import { pooledCtx, serverCtx, endServerCtx, runCmd, callPgm } from '../../svc/jobs.js';
import { runQsh } from '../qsh.js';
import { SYS } from '../../system.js';

const cdata = (s) => `<![CDATA[${String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const attrs = (o) => Object.entries(o).map(([k, v]) => ` ${k}='${esc(v)}'`).join('');

function parseType(t) {
  const m = /^(\d+)\s*([abphsifuc])\s*(\d*)$/i.exec(String(t || '').trim());
  if (!m) return { kind: 'a', len: 32, dec: 0 };
  return { kind: m[2].toLowerCase(), len: Number(m[1]), dec: Number(m[3] || 0) };
}
function toValue(text, t) {
  const x = parseType(t);
  if ('psifu'.includes(x.kind)) { const n = Number(String(text ?? '').trim() || 0); return Number.isFinite(n) ? n : 0; }
  return String(text ?? '');
}
function fromValue(v, t) {
  const x = parseType(t);
  if (x.kind === 'p' || x.kind === 's') return Number(v || 0).toFixed(x.dec);
  if (x.kind === 'i' || x.kind === 'u') return String(Math.trunc(Number(v || 0)));
  if (x.kind === 'f') return String(Number(v || 0).toFixed(x.dec || 2));
  return String(v ?? '').replace(/\s+$/, '');
}

/** Ejecuta un guion XMLSERVICE y devuelve el XML de salida. */
export async function runXmlService(ctx, xmlin) {
  const doc = parseXml(String(xmlin || ''));
  const script = elems(doc).find((n) => local(n.name).toLowerCase() === 'script') || doc;
  let out = "<?xml version='1.0'?>\n<script>\n";
  const stmts = ctx.xmlStmts || (ctx.xmlStmts = new Map());
  for (const n of elems(script)) {
    const tag = local(n.name).toLowerCase();
    try {
      if (tag === 'cmd') {
        const text = textOf(n);
        const r = await runCmd(ctx, text);
        out += `<cmd${attrs(n.attrs)}>${r.ok ? `<success>${cdata(`+++ success ${text}`)}</success>` : `<error>${cdata(`*** error ${text}`)}</error><error>${cdata(`${r.error.id} ${r.error.text}`)}</error>`}`;
        if (!r.ok || n.attrs.error === 'on') out += `<joblog job='${ctx.job.name}' user='${ctx.job.user}' nbr='${ctx.job.number}'>${cdata(r.joblog.map((e) => `${e.id || ''} ${e.text}`).join('\n'))}</joblog>`;
        out += '</cmd>\n';
      } else if (tag === 'sh' || tag === 'qsh') {
        const r = await runQsh(ctx, textOf(n));
        if (n.attrs.rows === 'on') out += `<${tag}${attrs(n.attrs)}>${r.text.replace(/\n$/, '').split('\n').map((l) => `<row>${cdata(l)}</row>`).join('')}</${tag}>\n`;
        else out += `<${tag}${attrs(n.attrs)}>${cdata(r.text)}</${tag}>\n`;
      } else if (tag === 'pgm') {
        out += await runPgm(ctx, n);
      } else if (tag === 'sql') {
        out += `<sql${attrs(n.attrs)}>`;
        for (const s of elems(n)) out += await runSqlNode(ctx, s, stmts);
        out += '</sql>\n';
      } else if (tag === 'diag') {
        out += `<diag${attrs(n.attrs)}><info><jobipc>*NA</jobipc><jobname>${ctx.job.name}</jobname><jobuser>${ctx.job.user}</jobuser><jobnbr>${ctx.job.number}</jobnbr><curuser>${ctx.job.user}</curuser><ccsid>37</ccsid><version>XML Toolkit 2.0.2 (AS400 para Todos ${SYS.release})</version><jobcpf></jobcpf></info></diag>\n`;
      } else if (tag === 'comment' || tag === 'start' || tag === 'end') {
        out += `<${tag}${attrs(n.attrs)}>${cdata(textOf(n))}</${tag}>\n`;
      }
    } catch (e) {
      out += `<${tag}${attrs(n.attrs)}><error>${cdata(`*** error ${e.msgId || ''} ${e.message}`)}</error></${tag}>\n`;
    }
  }
  return `${out}</script>`;
}

async function runPgm(ctx, n) {
  const name = String(n.attrs.name || '').toUpperCase();
  const lib = String(n.attrs.lib || '*LIBL').toUpperCase();
  const parms = elems(n).filter((x) => local(x.name).toLowerCase() === 'parm');
  // Cada <parm> es un parámetro; si contiene <ds>, sus <data> se concatenan como un carácter de longitud fija.
  const plan = parms.map((p) => {
    const ds = child(p, 'ds');
    const datas = ds ? elems(ds).filter((x) => local(x.name).toLowerCase() === 'data') : elems(p).filter((x) => local(x.name).toLowerCase() === 'data');
    return { p, ds, datas };
  });
  const values = plan.map(({ ds, datas }) => {
    if (ds) return datas.map((d) => { const t = parseType(d.attrs.type); const v = textOf(d); return 'psifu'.includes(t.kind) ? String(v).padStart(t.len) : String(v).padEnd(t.len).slice(0, t.len); }).join('');
    const d = datas[0];
    return d ? toValue(textOf(d), d.attrs.type) : '';
  });
  const r = await callPgm(ctx, name, lib, values);
  let xml = `<pgm${attrs(n.attrs)}>`;
  plan.forEach(({ p, ds, datas }, i) => {
    xml += `<parm${attrs(p.attrs)}>`;
    if (ds) {
      let off = 0;
      const raw = String(r.values[i] ?? '');
      xml += `<ds${attrs(ds.attrs)}>`;
      for (const d of datas) {
        const t = parseType(d.attrs.type);
        const piece = raw.slice(off, off + t.len);
        off += t.len;
        xml += `<data${attrs(d.attrs)}>${cdata(fromValue('psifu'.includes(t.kind) ? Number(piece.trim() || 0) : piece, d.attrs.type))}</data>`;
      }
      xml += '</ds>';
    } else {
      const d = datas[0];
      if (d) xml += `<data${attrs(d.attrs)}>${cdata(fromValue(r.values[i], d.attrs.type))}</data>`;
    }
    xml += '</parm>';
  });
  const ret = child(n, 'return');
  if (ret) { const d = child(ret, 'data'); xml += `<return${attrs(ret.attrs)}>${d ? `<data${attrs(d.attrs)}>0</data>` : ''}</return>`; }
  xml += `<success>${cdata(`+++ success ${lib} ${name}`)}</success></pgm>\n`;
  return xml;
}

async function runSqlNode(ctx, s, stmts) {
  const tag = local(s.name).toLowerCase();
  const id = s.attrs.stmt || 'stmt1';
  if (tag === 'connect' || tag === 'options') return `<${tag}${attrs({ ...s.attrs, conn: s.attrs.conn || 'conn1' })}><success>${cdata('+++ success')}</success></${tag}>`;
  if (tag === 'commit' || tag === 'rollback') {
    const r = tag === 'commit' ? await ctx.commit() : await ctx.rollback();
    return `<${tag}${attrs(s.attrs)}>${r?.error ? `<error>${cdata(r.error)}</error>` : `<success>${cdata(`+++ success ${tag}`)}</success>`}</${tag}>`;
  }
  if (tag === 'query' || tag === 'prepare') {
    const sql = textOf(s);
    if (tag === 'prepare') { stmts.set(id, { sql, rows: null }); return `<prepare${attrs({ ...s.attrs, conn: 'conn1', stmt: id })}><success>${cdata('+++ success')}</success></prepare>`; }
    const r = await ctx.sql(sql);
    if (r.error) return `<query${attrs({ ...s.attrs, conn: 'conn1', stmt: id })}><error>${cdata(`*** error ${sql}`)}</error><error>${cdata(`SQLSTATE=${r.sqlstate} SQLCODE=${r.sqlcode} ${r.error}`)}</error></query>`;
    stmts.set(id, { sql, result: r, pos: 0 });
    return `<query${attrs({ ...s.attrs, conn: 'conn1', stmt: id })}><success>${cdata(`+++ success ${sql}`)}</success></query>`;
  }
  if (tag === 'execute') {
    const st = stmts.get(id) || stmts.get([...stmts.keys()].pop());
    if (!st) return `<execute${attrs(s.attrs)}><error>${cdata('*** error no prepared statement')}</error></execute>`;
    const params = elems(s).filter((x) => local(x.name).toLowerCase() === 'parm').map((x) => textOf(x));
    const r = await ctx.sql(st.sql, params);
    if (r.error) return `<execute${attrs({ ...s.attrs, stmt: id })}><error>${cdata(`SQLSTATE=${r.sqlstate} SQLCODE=${r.sqlcode} ${r.error}`)}</error></execute>`;
    st.result = r;
    st.pos = 0;
    return `<execute${attrs({ ...s.attrs, stmt: id })}><success>${cdata('+++ success')}</success></execute>`;
  }
  if (tag === 'fetch') {
    const st = stmts.get(id) || stmts.get([...stmts.keys()].pop());
    if (!st?.result) return `<fetch${attrs(s.attrs)}><error>${cdata('*** error no result set')}</error></fetch>`;
    const r = st.result;
    const block = s.attrs.block === 'all' || !s.attrs.block ? Infinity : Number(s.attrs.block);
    const rows = r.rows.slice(st.pos, st.pos + block);
    st.pos += rows.length;
    let x = `<fetch${attrs({ ...s.attrs, stmt: id })}>`;
    for (const row of rows) x += `<row>${r.columns.map((c, i) => `<data desc='${esc(c.name)}'>${cdata(row[i] ?? '')}</data>`).join('')}</row>`;
    if (!rows.length) x += `<error>${cdata('*** error no more data')}</error>`;
    return `${x}</fetch>`;
  }
  if (tag === 'describe') {
    const st = stmts.get(id);
    const cols = st?.result?.columns || [];
    return `<describe${attrs({ ...s.attrs, stmt: id })}>${cols.map((c) => `<col><name>${esc(c.name)}</name><type>${esc(c.type)}</type><size>${c.precision || c.length || 0}</size><scale>${c.scale || 0}</scale><nullable>${c.nullable ? 1 : 0}</nullable></col>`).join('')}</describe>`;
  }
  if (tag === 'count' || tag === 'rowcount') {
    const st = stmts.get(id);
    return `<${tag}${attrs({ ...s.attrs, stmt: id })}>${st?.result ? st.result.rowCount : 0}</${tag}>`;
  }
  if (tag === 'free') { stmts.clear(); return `<free${attrs(s.attrs)}><success>${cdata('+++ success')}</success></free>`; }
  return `<${tag}${attrs(s.attrs)}><error>${cdata(`*** error ${tag} not supported`)}</error></${tag}>`;
}

/** Obtiene el contexto del trabajo XMLSERVICE: con IPC el trabajo persiste entre peticiones (ctl=*sbmjob). */
export async function xmlCtx(prf, ipc) {
  if (ipc && ipc !== '*NA' && ipc !== '*na') return pooledCtx(`XTOOLKIT:${String(ipc).slice(-20)}`, prf, { subsystem: 'QSYSWRK', type: 'BCH', fn: 'PGM-XMLSERVICE' });
  return serverCtx(prf, { name: 'QSQSRVR', subsystem: 'QSYSWRK', type: 'PJ', fn: 'PGM-XMLSERVICE' });
}

export function mountXmlService(app) {
  const handler = async (req, res) => {
    const p = { ...req.query, ...(typeof req.body === 'object' && req.body ? req.body : {}) };
    if (typeof req.body === 'string' && !p.xmlin) Object.assign(p, Object.fromEntries(new URLSearchParams(req.body)));
    if (!p.xmlin) {
      return send(res, 200, `<html><body><h3>XMLSERVICE (XMLCGI.PGM)</h3><p>POST: db2=*LOCAL, uid, pwd, ipc=*NA, ctl=*here, xmlin=&lt;script&gt;…&lt;/script&gt;, xmlout=500000</p></body></html>`, 'text/html; charset=utf-8');
    }
    let prf;
    try {
      if (p.uid && p.uid !== '*NONE') prf = await authenticate(p.uid, p.pwd, { service: 'XMLSERVICE', remote: req.socket.remoteAddress });
      else { const a = await authHttp(req); prf = a?.prf; }
      if (!prf) throw Object.assign(new Error('uid/pwd required'), { msgId: 'CPF22E2' });
    } catch (e) {
      return send(res, 200, `<?xml version='1.0'?><script><error>${cdata(`*** error XMLCGI login ${e.msgId || ''} ${e.message}`)}</error></script>`, 'text/xml; charset=utf-8');
    }
    const ctx = await xmlCtx(prf, p.ipc);
    try {
      const xml = await runXmlService(ctx, p.xmlin);
      send(res, 200, xml, 'text/xml; charset=utf-8');
    } finally {
      if (!p.ipc || p.ipc === '*NA' || p.ipc === '*na') endServerCtx(ctx);
    }
  };
  for (const pth of ['/cgi-bin/xmlcgi.pgm', '/cgi-bin/XMLCGI.PGM', '/xmlservice', '/QSYS.LIB/XMLSERVICE.LIB/XMLCGI.PGM']) { app.get(pth, handler); app.post(pth, handler); }
  app.get('/api/v1/xmlservice/sample', (req, res) => sendJson(res, 200, { xmlin: "<?xml version='1.0'?><script><cmd>CHGLIBL LIBL(DEMOLIB QGPL QTEMP)</cmd><pgm name='HELLO' lib='DEMOLIB'></pgm><sql><query>select * from demolib.items</query><fetch block='all' desc='on'/></sql><sh>ls /home</sh></script>" }));
}
