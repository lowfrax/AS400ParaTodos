// Especificación OpenAPI 3 de la API REST del sistema y una página de documentación con consola de pruebas.
import { SYS } from '../../system.js';

const J = { 'application/json': { schema: { type: 'object' } } };
const ok = (d = 'OK') => ({ 200: { description: d, content: J } });
const body = (props, required = []) => ({ required: true, content: { 'application/json': { schema: { type: 'object', properties: props, required } } } });
const S = (type, description, extra = {}) => ({ type, description, ...extra });
const pathP = (...names) => names.map((n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } }));

const PATHS = {
  '/api/v1/auth/token': { post: { tags: ['Seguridad'], summary: 'Obtiene un token JWT (Bearer) con un perfil de usuario', security: [], requestBody: body({ user: S('string', 'Perfil'), password: S('string', 'Contraseña'), expiresIn: S('integer', 'Segundos') }, ['user', 'password']), responses: ok('access_token') } },
  '/api/v1/auth/me': { get: { tags: ['Seguridad'], summary: 'Perfil autenticado', responses: ok() } },
  '/api/v1/system': { get: { tags: ['Sistema'], summary: 'Estado del sistema (WRKSYSSTS)', responses: ok() } },
  '/api/v1/system/values': { get: { tags: ['Sistema'], summary: 'Valores del sistema', responses: ok() } },
  '/api/v1/commands': { post: { tags: ['CL'], summary: 'Ejecuta un mandato CL (QCMDEXC)', requestBody: body({ command: S('string', "p. ej. CRTLIB LIB(PRUEBA)") }, ['command']), responses: ok('Mensajes de terminación') } },
  '/api/v1/sql': { post: { tags: ['SQL'], summary: 'Ejecuta SQL (Db2) con nomenclatura *SYS y servicios QSYS2', requestBody: body({ sql: S('string', 'Sentencia (o array)'), params: S('array', 'Marcadores ?', { items: {} }) }, ['sql']), responses: ok('columns + data') } },
  '/api/v1/programs/{lib}/{pgm}': { get: { tags: ['Programas'], summary: 'Describe los parámetros (*ENTRY / DCL-PI) de un programa', parameters: pathP('lib', 'pgm'), responses: ok() } },
  '/api/v1/programs/{lib}/{pgm}/call': { post: { tags: ['Programas'], summary: 'Llama a un programa RPG/CL con parámetros', parameters: pathP('lib', 'pgm'), requestBody: body({ params: S('object', 'Por nombre {CUENTA: 1001} o array posicional') }), responses: ok('outputs') } },
  '/api/v1/libraries': { get: { tags: ['Objetos'], summary: 'Bibliotecas', responses: ok() }, post: { tags: ['Objetos'], summary: 'Crea una biblioteca', requestBody: body({ name: S('string'), text: S('string') }, ['name']), responses: ok() } },
  '/api/v1/libraries/{lib}/objects': { get: { tags: ['Objetos'], summary: 'Objetos de una biblioteca', parameters: pathP('lib'), responses: ok() } },
  '/api/v1/files/{lib}/{file}': { get: { tags: ['Datos'], summary: 'Descripción de campos (DSPFFD)', parameters: pathP('lib', 'file'), responses: ok() } },
  '/api/v1/files/{lib}/{file}/records': { get: { tags: ['Datos'], summary: 'Registros (filtros por campo, limit, offset, orderBy)', parameters: pathP('lib', 'file'), responses: ok() }, post: { tags: ['Datos'], summary: 'Inserta registros', parameters: pathP('lib', 'file'), requestBody: body({}), responses: { 201: { description: 'Creado' } } } },
  '/api/v1/sources/{lib}/{file}/{mbr}': { get: { tags: ['Fuentes'], summary: 'Lee un miembro fuente', parameters: pathP('lib', 'file', 'mbr'), responses: ok() }, put: { tags: ['Fuentes'], summary: 'Escribe un miembro fuente', parameters: pathP('lib', 'file', 'mbr'), responses: ok() } },
  '/api/v1/spool': { get: { tags: ['Spool'], summary: 'Archivos en spool', responses: ok() } },
  '/api/v1/spool/{id}': { get: { tags: ['Spool'], summary: 'Contenido (format=text|pdf|json)', parameters: pathP('id'), responses: ok() }, delete: { tags: ['Spool'], summary: 'Borra un archivo en spool', parameters: pathP('id'), responses: ok() } },
  '/api/v1/messages/{queue}': { get: { tags: ['Mensajes'], summary: 'Mensajes de una cola (*SELF, QSYSOPR…)', parameters: pathP('queue'), responses: ok() } },
  '/api/v1/messages': { post: { tags: ['Mensajes'], summary: 'Envía un mensaje (SNDMSG)', requestBody: body({ to: S('string'), text: S('string') }, ['to', 'text']), responses: ok() } },
  '/api/v1/dataqueues': { get: { tags: ['Colas de datos'], summary: 'Colas de datos', responses: ok() } },
  '/api/v1/dataqueues/{lib}/{name}': { post: { tags: ['Colas de datos'], summary: 'Crea una cola (CRTDTAQ)', parameters: pathP('lib', 'name'), requestBody: body({ maxlen: S('integer'), seq: S('string', '*FIFO, *LIFO, *KEYED'), keylen: S('integer') }), responses: ok() } },
  '/api/v1/dataqueues/{lib}/{name}/send': { post: { tags: ['Colas de datos'], summary: 'QSNDDTAQ', parameters: pathP('lib', 'name'), requestBody: body({ data: S('string'), key: S('string') }, ['data']), responses: ok() } },
  '/api/v1/dataqueues/{lib}/{name}/receive': { get: { tags: ['Colas de datos'], summary: 'QRCVDTAQ (wait=segundos, key, order, peek)', parameters: pathP('lib', 'name'), responses: { ...ok(), 204: { description: 'Sin datos' } } } },
  '/api/v1/ifs/{path}': { get: { tags: ['IFS'], summary: 'Lee un archivo o lista un directorio (también /QSYS.LIB/…)', parameters: pathP('path'), responses: ok() }, put: { tags: ['IFS'], summary: 'Escribe un archivo', parameters: pathP('path'), responses: ok() }, delete: { tags: ['IFS'], summary: 'Borra', parameters: pathP('path'), responses: ok() } },
  '/api/v1/jobs': { get: { tags: ['Trabajos'], summary: 'Trabajos activos (WRKACTJOB)', responses: ok() } },
  '/api/v1/jobs/{number}/joblog': { get: { tags: ['Trabajos'], summary: 'Anotaciones del trabajo', parameters: pathP('number'), responses: ok() } },
  '/api/v1/network/servers': { get: { tags: ['Red'], summary: 'Servidores TCP/IP y su estado', responses: ok() } },
  '/api/v1/network/netstat': { get: { tags: ['Red'], summary: 'NETSTAT *CNN', responses: ok() } },
  '/api/v1/network/servers/{key}/{action}': { post: { tags: ['Red'], summary: 'STRTCPSVR / ENDTCPSVR (action=start|stop)', parameters: pathP('key', 'action'), responses: ok() } },
  '/api/v1/qsh': { post: { tags: ['QSH'], summary: 'Ejecuta un guion QSH (system, db2, ls, cat…)', requestBody: body({ script: S('string') }, ['script']), responses: ok() } },
  '/api/v1/mq/queues': { get: { tags: ['MQ'], summary: 'Colas del gestor MQ', responses: ok() } },
  '/api/v1/mq/queues/{q}/messages': { post: { tags: ['MQ'], summary: 'MQPUT', parameters: pathP('q'), responses: ok() }, delete: { tags: ['MQ'], summary: 'MQGET (wait=segundos)', parameters: pathP('q'), responses: ok() } },
  '/api/v1/audit': { get: { tags: ['Seguridad'], summary: 'Diario de auditoría (QAUDJRN)', responses: ok() } },
  '/api/v1/certs/ca.crt': { get: { tags: ['Seguridad'], summary: 'Certificado de la CA local (para TLS)', security: [], responses: ok() } },
  '/web/services': { get: { tags: ['IWS'], summary: 'Servicios web publicados (REST/SOAP)', security: [], responses: ok() } },
  '/web/services/pgm/{lib}/{pgm}': { post: { tags: ['IWS'], summary: 'Llama a cualquier programa (JSON)', parameters: pathP('lib', 'pgm'), responses: ok() } },
  '/cgi-bin/xmlcgi.pgm': { post: { tags: ['XMLSERVICE'], summary: 'XMLSERVICE (itoolkit): db2, uid, pwd, ipc, ctl, xmlin, xmlout (form-urlencoded)', security: [], responses: ok() } },
  '/ibmmq/rest/v3/messaging/qmgr/{qmgr}/queue/{q}/message': { post: { tags: ['MQ'], summary: 'IBM MQ REST: put', parameters: pathP('qmgr', 'q'), responses: { 201: { description: 'Put' } } }, delete: { tags: ['MQ'], summary: 'IBM MQ REST: get destructivo', parameters: pathP('qmgr', 'q'), responses: ok() }, get: { tags: ['MQ'], summary: 'IBM MQ REST: browse', parameters: pathP('qmgr', 'q'), responses: ok() } },
};

const extra = [];
export function addOpenApiPaths(paths) { extra.push(paths); }

export function openapi(req) {
  const host = req?.headers?.host || 'localhost:10010';
  const proto = req?.socket?.encrypted ? 'https' : 'http';
  return {
    openapi: '3.0.3',
    info: { title: `IBM i ${SYS.name} — API REST`, version: SYS.release, description: 'API del clon AS400 para Todos: CL, SQL, programas RPG, colas de datos, IFS, spool, MQ, IWS y core bancario. Autenticación Basic (perfil IBM i) o Bearer (POST /api/v1/auth/token).' },
    servers: [{ url: `${proto}://${host}` }],
    components: { securitySchemes: { basic: { type: 'http', scheme: 'basic' }, bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    security: [{ basic: [] }, { bearer: [] }],
    paths: Object.assign({}, PATHS, ...extra),
  };
}

export function docsPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>API REST — ${SYS.name}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#0f1720;color:#dbe7f3}header{padding:16px 24px;background:#132233;border-bottom:1px solid #24405e}h1{margin:0;font-size:20px}
main{display:grid;grid-template-columns:420px 1fr;gap:0;height:calc(100vh - 62px)}#list{overflow:auto;border-right:1px solid #24405e}.tag{padding:8px 16px;font-weight:600;color:#7fb3ff;background:#0c141d;position:sticky;top:0}
.op{padding:6px 16px;cursor:pointer;display:flex;gap:8px;align-items:baseline}.op:hover{background:#18293c}.m{font:600 11px monospace;padding:2px 6px;border-radius:3px;min-width:48px;text-align:center}
.GET{background:#1f6f43}.POST{background:#2457a6}.PUT{background:#8a5a00}.DELETE{background:#9b2c2c}.PATCH{background:#6b3fa0}code{color:#9fd0ff}
#try{padding:16px 24px;overflow:auto}input,textarea,select{width:100%;box-sizing:border-box;background:#0c141d;color:#dbe7f3;border:1px solid #24405e;border-radius:4px;padding:6px;font:13px monospace}
textarea{height:140px}button{background:#2457a6;color:#fff;border:0;border-radius:4px;padding:8px 16px;cursor:pointer;margin-top:8px}pre{background:#0c141d;border:1px solid #24405e;padding:12px;white-space:pre-wrap;max-height:50vh;overflow:auto}
label{display:block;margin-top:10px;font-size:12px;color:#8aa4bf}.row{display:flex;gap:8px}.row>*{flex:1}</style></head><body>
<header><h1>IBM i ${SYS.name} · API REST, IWS, XMLSERVICE y MQ</h1><small>OpenAPI: <a style="color:#9fd0ff" href="/openapi.json">/openapi.json</a> · CORS habilitado · Autenticación Basic o Bearer</small></header>
<main><div id="list"></div><div id="try"><div class="row"><div><label>Usuario</label><input id="u" value="DEMO"></div><div><label>Contraseña</label><input id="p" type="password" value="DEMO"></div></div>
<label>Método y ruta</label><div class="row"><select id="m" style="max-width:110px"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select><input id="path" value="/api/v1/system"></div>
<label>Cuerpo (JSON)</label><textarea id="b">{}</textarea><button id="go">Enviar</button><label>Respuesta</label><pre id="out">—</pre></div></main>
<script>
fetch('/openapi.json').then(r=>r.json()).then(spec=>{const by={};for(const[p,ops]of Object.entries(spec.paths))for(const[m,o]of Object.entries(ops)){(by[o.tags?.[0]||'Otros']??=[]).push([m.toUpperCase(),p,o])}
const L=document.getElementById('list');for(const[t,ops]of Object.entries(by)){L.insertAdjacentHTML('beforeend','<div class="tag">'+t+'</div>');for(const[m,p,o]of ops){const d=document.createElement('div');d.className='op';d.innerHTML='<span class="m '+m+'">'+m+'</span><div><code>'+p+'</code><div style="font-size:12px;color:#8aa4bf">'+(o.summary||'')+'</div></div>';
d.onclick=()=>{document.getElementById('m').value=m;document.getElementById('path').value=p.replace('{lib}','DEMOLIB').replace('{pgm}','HELLO').replace('{file}','CUSTOMER').replace('{name}','DEMOQ').replace('{queue}','*SELF').replace('{qmgr}','QM${SYS.name}').replace('{q}','DEV.QUEUE.1');
const props=o.requestBody?.content?.['application/json']?.schema?.properties;document.getElementById('b').value=props?JSON.stringify(Object.fromEntries(Object.keys(props).map(k=>[k,''])),null,2):'{}'};L.appendChild(d)}}});
document.getElementById('go').onclick=async()=>{const m=document.getElementById('m').value,p=document.getElementById('path').value,h={Authorization:'Basic '+btoa(document.getElementById('u').value+':'+document.getElementById('p').value)};
let body;if(m!=='GET'&&m!=='DELETE'){h['Content-Type']='application/json';body=document.getElementById('b').value}const t0=performance.now();const r=await fetch(p,{method:m,headers:h,body});const ct=r.headers.get('content-type')||'';
const txt=ct.includes('json')?JSON.stringify(await r.json(),null,2):await r.text();document.getElementById('out').textContent='HTTP '+r.status+'  ('+Math.round(performance.now()-t0)+' ms)\\n\\n'+txt};
</script></body></html>`;
}
