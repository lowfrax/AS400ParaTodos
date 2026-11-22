// Integrated Web Services (IWS): programas RPG/CL publicados como servicios REST (JSON) y SOAP (con WSDL).
// Los servicios se definen en /QIBM/UserData/OS/iws/services.json (o con el mandato ADDIWSSVC / la API /web/admin).
// Además, /web/services/pgm/{LIB}/{PGM} llama a cualquier programa con parámetros JSON.
import { sendJson, send } from '../../../../../shared/http.js';
import { parseXml, path as xpath, elems, local, esc, textOf } from '../../../../../shared/xml.js';
import { requireAuth, userCtx, fail, upper } from './common.js';
import { callPgm, describeProgram } from '../../svc/jobs.js';
import * as ifs from '../../ifs.js';
import { SYS } from '../../system.js';

const FILE = '/QIBM/UserData/OS/iws/services.json';
let cache = null;

export async function loadServices() {
  if (cache) return cache;
  try { cache = JSON.parse((await ifs.readFile(FILE)).toString('utf8')); } catch { cache = {}; }
  return cache;
}
export async function saveServices(svcs) {
  cache = svcs;
  await ifs.writeFile(FILE, JSON.stringify(svcs, null, 2));
}
/** Define (o sustituye) un servicio. op: {method, path, params:{NOMBRE:'path'|'query'|'body'|'header'}, status} */
export async function defineService(name, def) {
  const s = await loadServices();
  s[name.toLowerCase()] = { name: name.toLowerCase(), public: false, ...def };
  await saveServices(s);
  return s[name.toLowerCase()];
}
export async function removeService(name) {
  const s = await loadServices();
  delete s[name.toLowerCase()];
  await saveServices(s);
}

function matchOp(op, method, rest) {
  if (String(op.method || 'POST').toUpperCase() !== method) return null;
  const pp = String(op.path || '/').split('/').filter(Boolean);
  const up = rest.split('/').filter(Boolean);
  if (pp.length !== up.length) return null;
  const out = {};
  for (let i = 0; i < pp.length; i++) {
    const m = /^\{(\w+)\}$/.exec(pp[i]);
    if (m) out[m[1].toUpperCase()] = decodeURIComponent(up[i]);
    else if (pp[i].toLowerCase() !== up[i].toLowerCase()) return null;
  }
  return out;
}

const typeName = (t) => (['packed', 'zoned', 'float', 'bindec'].includes(t.t) ? 'decimal' : ['int', 'uns'].includes(t.t) ? 'int' : t.t === 'ind' ? 'boolean' : 'string');

async function callService(req, res, svc, values, ctxUser) {
  const [lib, pgm] = String(svc.program).toUpperCase().split('/');
  const ctx = await userCtx(ctxUser, 'QZHBIWS');
  const desc = await describeProgram(ctx, pgm, lib);
  const r = await callPgm(ctx, pgm, lib, values, desc);
  return { r, desc };
}

function pickOutput(svc, op, desc, r) {
  const out = {};
  const want = op?.response && op.response !== '*ALL' ? op.response.map((x) => x.toUpperCase()) : desc.params.filter((p) => p.io !== 'in').map((p) => p.name);
  for (const n of want) {
    const p = desc.params.find((x) => x.name === n);
    let v = r.outputs[n];
    if (p && typeName(p.type) === 'decimal' && typeof v === 'string') v = Number(v);
    out[(op?.names?.[n]) || n.toLowerCase()] = v;
  }
  return out;
}

export function mountIws(app) {
  // Índice de servicios
  app.get('/web/services', async (req, res) => {
    const s = await loadServices();
    sendJson(res, 200, Object.values(s).map((x) => ({ name: x.name, program: x.program, description: x.description || '', operations: (x.operations || []).map((o) => `${o.method} /web/services/${x.name}${o.path || ''}`), wsdl: `/web/services/${x.name}?wsdl` })));
  });

  // Cualquier programa: POST /web/services/pgm/LIB/PGM {PARAM: valor}
  app.post('/web/services/pgm/:lib/:pgm', async (req, res) => {
    const a = await requireAuth(req, res);
    if (!a) return;
    try {
      const ctx = await userCtx(a.prf, 'QZHBIWS');
      const r = await callPgm(ctx, upper(req.params.pgm), upper(req.params.lib), req.body?.params ?? req.body ?? {});
      sendJson(res, 200, r.outputs, { 'X-Job': r.job });
    } catch (e) { fail(res, e); }
  });

  app.all('/web/services/:svc/*', (req, res) => dispatch(req, res, req.params.svc, `/${req.params['*'] || ''}`));
  app.all('/web/services/:svc', (req, res) => dispatch(req, res, req.params.svc, '/'));

  async function dispatch(req, res, name, rest) {
    const svcs = await loadServices();
    const svc = svcs[String(name).toLowerCase()];
    if (!svc) return sendJson(res, 404, { error: { id: 'IWS0001', text: `Web service ${name} not found.` } });
    if (req.method === 'GET' && ('wsdl' in req.query || 'WSDL' in req.query)) return wsdl(req, res, svc);
    const isSoap = req.method === 'POST' && (/xml/.test(req.headers['content-type'] || '') || req.headers.soapaction !== undefined) && typeof req.body === 'string' && /Envelope/.test(req.body);
    let user;
    if (!svc.public) {
      const a = await requireAuth(req, res, { realm: `IWS ${svc.name}` });
      if (!a) return;
      user = a.prf;
    } else {
      const { getUser } = await import('../../objects.js');
      user = await getUser(svc.runAs || 'QUSER') || await getUser('QSECOFR');
    }
    try {
      if (isSoap) return await soap(req, res, svc, user);
      const ops = svc.operations?.length ? svc.operations : [{ method: 'POST', path: '/', params: {} }];
      let op = null;
      let pathVals = null;
      for (const o of ops) { pathVals = matchOp(o, req.method, rest); if (pathVals) { op = o; break; } }
      if (!op) return sendJson(res, 405, { error: { id: 'IWS0002', text: `No operation for ${req.method} ${rest} in service ${svc.name}.` } });
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      const values = {};
      const keyed = (o, k) => o[k] ?? o[k.toLowerCase()] ?? Object.entries(o).find(([x]) => x.toUpperCase() === k)?.[1];
      for (const [k, v] of Object.entries(pathVals)) values[k] = v;
      for (const [k, v] of Object.entries(req.query)) values[k.toUpperCase()] = v;
      for (const [k, v] of Object.entries(body)) values[k.toUpperCase()] = typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
      // Alias de entrada: {"origen": 1001} → parámetro PORIGEN
      for (const [alias, param] of Object.entries(op.in || {})) {
        const v = body[alias] ?? req.query[alias];
        if (v !== undefined) values[param.toUpperCase()] = v;
      }
      for (const [k, src] of Object.entries(op.params || {})) {
        if (src === 'header') values[k.toUpperCase()] = req.headers[k.toLowerCase()];
        if (typeof src === 'object' && src.const !== undefined) values[k.toUpperCase()] = src.const;
      }
      const { r, desc } = await callService(req, res, svc, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, keyed(values, k) ?? v])), user);
      const out = pickOutput(svc, op, desc, r);
      // Código HTTP desde un parámetro de salida (p. ej. HTTPSTS) o fijo
      let status = op.status || (req.method === 'POST' ? 200 : 200);
      if (op.statusParam && r.outputs[op.statusParam.toUpperCase()] !== undefined) status = Number(r.outputs[op.statusParam.toUpperCase()]) || status;
      if (op.wrap === false && Object.keys(out).length === 1) return sendJson(res, status, Object.values(out)[0], { 'X-Job': r.job });
      sendJson(res, status, out, { 'X-Job': r.job });
    } catch (e) { fail(res, e); }
  }

  async function soap(req, res, svc, user) {
    const doc = parseXml(req.body);
    const body = xpath(doc, 'Envelope', 'Body');
    const opEl = body ? elems(body)[0] : null;
    if (!opEl) return send(res, 500, soapFault('Client', 'SOAP Body is empty.'), 'text/xml; charset=utf-8');
    const values = {};
    const walk = (n) => { for (const c of elems(n)) { if (elems(c).length) walk(c); else values[local(c.name).toUpperCase()] = textOf(c); } };
    walk(opEl);
    try {
      const { r, desc } = await callService(req, res, svc, values, user);
      const opName = local(opEl.name);
      const outs = desc.params.filter((p) => p.io !== 'in');
      const ns = `http://${svc.name}.ws.${SYS.name.toLowerCase()}`;
      const xml = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${ns}"><soapenv:Body>` +
        `<ns:${opName}Response><ns:return>${outs.map((p) => `<ns:${p.name.toLowerCase()}>${esc(r.outputs[p.name])}</ns:${p.name.toLowerCase()}>`).join('')}</ns:return></ns:${opName}Response>` +
        '</soapenv:Body></soapenv:Envelope>';
      send(res, 200, xml, 'text/xml; charset=utf-8', { 'X-Job': r.job });
    } catch (e) {
      send(res, 500, soapFault('Server', `${e.msgId ? `${e.msgId}: ` : ''}${e.message}`), 'text/xml; charset=utf-8');
    }
  }

  async function wsdl(req, res, svc) {
    const [lib, pgm] = String(svc.program).toUpperCase().split('/');
    const { getUser } = await import('../../objects.js');
    const ctx = await userCtx(await getUser('QSECOFR'), 'QZHBIWS');
    let desc;
    try { desc = await describeProgram(ctx, pgm, lib); } catch (e) { return fail(res, e); }
    const ns = `http://${svc.name}.ws.${SYS.name.toLowerCase()}`;
    const op = svc.soapOperation || pgm.toLowerCase();
    const xsd = (t) => ({ decimal: 'xs:decimal', int: 'xs:int', boolean: 'xs:boolean' }[typeName(t)] || 'xs:string');
    const ins = desc.params;
    const outs = desc.params.filter((p) => p.io !== 'in');
    const host = req.headers.host || `localhost`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:ns="${ns}" targetNamespace="${ns}" name="${svc.name}">
  <wsdl:documentation>${esc(svc.description || `Programa ${lib}/${pgm} publicado por IWS`)}</wsdl:documentation>
  <wsdl:types><xs:schema elementFormDefault="qualified" targetNamespace="${ns}">
    <xs:element name="${op}"><xs:complexType><xs:sequence>${ins.map((p) => `<xs:element name="${p.name.toLowerCase()}" type="${xsd(p.type)}" minOccurs="0"/>`).join('')}</xs:sequence></xs:complexType></xs:element>
    <xs:element name="${op}Response"><xs:complexType><xs:sequence><xs:element name="return"><xs:complexType><xs:sequence>${outs.map((p) => `<xs:element name="${p.name.toLowerCase()}" type="${xsd(p.type)}"/>`).join('')}</xs:sequence></xs:complexType></xs:element></xs:sequence></xs:complexType></xs:element>
  </xs:schema></wsdl:types>
  <wsdl:message name="${op}Request"><wsdl:part name="parameters" element="ns:${op}"/></wsdl:message>
  <wsdl:message name="${op}Response"><wsdl:part name="parameters" element="ns:${op}Response"/></wsdl:message>
  <wsdl:portType name="${svc.name}PortType"><wsdl:operation name="${op}"><wsdl:input message="ns:${op}Request"/><wsdl:output message="ns:${op}Response"/></wsdl:operation></wsdl:portType>
  <wsdl:binding name="${svc.name}SOAP" type="ns:${svc.name}PortType"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="${op}"><soap:operation soapAction="urn:${op}"/><wsdl:input><soap:body use="literal"/></wsdl:input><wsdl:output><soap:body use="literal"/></wsdl:output></wsdl:operation></wsdl:binding>
  <wsdl:service name="${svc.name}"><wsdl:port name="${svc.name}HttpSoap11Endpoint" binding="ns:${svc.name}SOAP"><soap:address location="http://${esc(host)}/web/services/${svc.name}"/></wsdl:port></wsdl:service>
</wsdl:definitions>`;
    send(res, 200, xml, 'text/xml; charset=utf-8');
  }

  // Administración de servicios (como la consola de IWS)
  app.get('/web/admin/services', async (req, res) => { const a = await requireAuth(req, res); if (!a) return; sendJson(res, 200, await loadServices()); });
  app.put('/web/admin/services/:name', async (req, res) => {
    const a = await requireAuth(req, res);
    if (!a) return;
    try { sendJson(res, 200, await defineService(req.params.name, req.body)); } catch (e) { fail(res, e); }
  });
  app.del('/web/admin/services/:name', async (req, res) => {
    const a = await requireAuth(req, res);
    if (!a) return;
    await removeService(req.params.name);
    sendJson(res, 200, { deleted: req.params.name });
  });
}

function soapFault(code, text) {
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>soapenv:${code}</faultcode><faultstring>${esc(text)}</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`;
}
