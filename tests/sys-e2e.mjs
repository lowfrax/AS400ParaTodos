// Prueba de los servicios de sistema de IBM i: QTEMP por trabajo, seguridad de objetos (autorizaciones privadas,
// de grupo, *PUBLIC, listas de autorizaciones, biblioteca, *OBJEXIST, propietario), diarios, salvar/restaurar,
// mandatos de usuario (CRTCMD). Ejecutar: node tests/sys-e2e.mjs [seccion…]
const BASE = process.env.API || 'http://localhost:10010';
const auth = (u, p = u) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });
const SECOFR = auth('QSECOFR');
const LIB = 'SVCTEST';
const only = new Set(process.argv.slice(2));
import net from 'node:net';

// Cliente FTP mínimo (modo pasivo) para RETR/STOR binarios
async function ftp(cmds, { user = 'QSECOFR', pwd = 'QSECOFR', host = '127.0.0.1', port = Number(process.env.FTP_PORT || 21) } = {}) {
  const sock = net.connect(port, host);
  let buf = '';
  const waiters = [];
  sock.on('data', (d) => { buf += d.toString('latin1'); let m; while ((m = /^(\d{3}) .*\r?\n/m.exec(buf))) { const line = buf.slice(0, m.index + m[0].length); buf = buf.slice(m.index + m[0].length); const w = waiters.shift(); if (w) w(line); } });
  const reply = () => new Promise((r) => waiters.push(r));
  const send = async (c) => { sock.write(`${c}\r\n`); return reply(); };
  await reply();
  await send(`USER ${user}`); await send(`PASS ${pwd}`); await send('TYPE I');
  const out = {};
  for (const [verb, arg, data] of cmds) {
    if (verb === 'RETR' || verb === 'STOR') {
      const pasv = await send('PASV');
      const n = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv).slice(1).map(Number);
      const ds = net.connect(n[4] * 256 + n[5], host);
      await new Promise((r) => ds.once('connect', r));
      const chunks = [];
      const done = new Promise((r) => ds.on('end', r).on('close', r));
      ds.on('data', (c) => chunks.push(c));
      const first = await send(`${verb} ${arg}`);
      if (verb === 'STOR') { ds.end(data); }
      if (/^[45]/.test(first)) ds.destroy();
      await done;
      const last = /^1/.test(first) ? await reply() : first;
      out[arg] = { reply: last, data: Buffer.concat(chunks) };
    } else out[arg || verb] = await send(`${verb}${arg ? ` ${arg}` : ''}`);
  }
  await send('QUIT').catch(() => {});
  sock.destroy();
  return out;
}
const want = (s) => !only.size || only.has(s);

async function api(method, path, body, h = SECOFR, type = 'application/json') {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { ...h, ...(body !== undefined ? { 'Content-Type': type } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const t = await r.text();
  try { const j = JSON.parse(t); return Array.isArray(j) ? { status: r.status, list: j } : { status: r.status, ...j }; } catch { return { status: r.status, text: t }; }
}
const cmd = (c, h = SECOFR) => api('POST', '/commands', { command: c }, h);
const sql = (s, h = SECOFR) => api('POST', '/sql', { sql: s }, h);
const errId = (r) => (r.error && (r.error.id || (r.error.sqlcode !== undefined ? `SQL${String(Math.abs(r.error.sqlcode)).padStart(4, '0')}` : ''))) || (r.ok === false ? 'ERR' : '');
const ok = (r) => r.status === 200 && !r.error;
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `  ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); if (!cond) failed++; };
const put = (file, mbr, type, text) => api('PUT', `/sources/${LIB}/${file}/${mbr}?type=${type}`, { lines: text.split('\n') });

(async () => {
  await cmd(`DLTLIB LIB(${LIB})`);
  await cmd(`CRTLIB LIB(${LIB})`);
  await cmd(`CRTSRCPF FILE(${LIB}/QCLSRC)`);

  if (want('qtemp')) {
    await cmd('DLTOBJ OBJ(QTEMP/TMPDTA) OBJTYPE(*DTAARA)');
    await sql('DROP TABLE QTEMP.TRABAJO');
    const a = await cmd('CRTDTAARA DTAARA(QTEMP/TMPDTA) TYPE(*CHAR) LEN(10) VALUE(PROPIO)');
    check('QTEMP: CRTDTAARA en la QTEMP del trabajo', ok(a) && /library QTEMP/.test(JSON.stringify(a.messages)), a);
    check('QTEMP: el mismo trabajo la ve', /PROPIO/.test(JSON.stringify(await cmd('DSPDTAARA DTAARA(QTEMP/TMPDTA)'))));
    const o = await cmd('CHKOBJ OBJ(QTEMP/TMPDTA) OBJTYPE(*DTAARA)', auth('DEMO'));
    check('QTEMP: otro trabajo no la ve (CPF9801)', errId(o) === 'CPF9801', o);
    await sql('CREATE TABLE QTEMP.TRABAJO (N INT)');
    await sql('INSERT INTO QTEMP.TRABAJO VALUES (1), (2)');
    const s1 = await sql('SELECT COUNT(*) AS N FROM QTEMP.TRABAJO');
    const s2 = await sql('SELECT COUNT(*) AS N FROM QTEMP.TRABAJO', auth('DEMO'));
    check('QTEMP: tablas SQL propias del trabajo', s1.data && s1.data[0].N === 2 && errId(s2) === 'SQL0204' && /QTEMP/.test(JSON.stringify(s2.error)), [s1, s2]);
    const libs = await sql("SELECT COUNT(*) AS N FROM QSYS2.SYSSCHEMAS WHERE SCHEMA_NAME = 'QTEMP'");
    check('QTEMP: no aparece el nombre físico en DSPLIBL', /QTEMP/.test(JSON.stringify(await cmd('DSPLIBL'))) && !/QT\d{6}/.test(JSON.stringify(await cmd('DSPLIBL'))), libs);
    // Un trabajo por lotes tiene su propia QTEMP
    await cmd(`CRTDTAARA DTAARA(${LIB}/RESQT) TYPE(*CHAR) LEN(20)`);
    await put('QCLSRC', 'QTBATCH', 'CLP', `PGM
  CHKOBJ OBJ(QTEMP/TMPDTA) OBJTYPE(*DTAARA)
  MONMSG MSGID(CPF9801) EXEC(DO)
    CHGDTAARA DTAARA(${LIB}/RESQT) VALUE('NO LA VE')
    RETURN
  ENDDO
  CHGDTAARA DTAARA(${LIB}/RESQT) VALUE('LA VE')
ENDPGM`);
    await cmd(`CRTBNDCL PGM(${LIB}/QTBATCH) SRCFILE(${LIB}/QCLSRC)`);
    await cmd(`SBMJOB CMD(CALL PGM(${LIB}/QTBATCH)) JOB(QTBATCH)`);
    let v = '';
    for (let i = 0; i < 20 && !/VE/.test(v); i++) { await new Promise((r) => setTimeout(r, 500)); v = JSON.stringify(await cmd(`DSPDTAARA DTAARA(${LIB}/RESQT)`)); }
    check('QTEMP: un trabajo por lotes no ve la QTEMP del que lo envía', /NO LA VE/.test(v), v);
  }

  if (want('sec')) {
    for (const u of ['USRA', 'USRB', 'GRUPO']) await cmd(`DLTUSRPRF USRPRF(${u})`);
    await cmd('DLTAUTL AUTL(LISTA1)');
    await cmd('CRTUSRPRF USRPRF(GRUPO) PASSWORD(*NONE)');
    await cmd('CRTUSRPRF USRPRF(USRA)');
    const cb = await cmd('CRTUSRPRF USRPRF(USRB) GRPPRF(GRUPO)');
    check('CRTUSRPRF con GRPPRF', ok(cb), cb);
    const A = auth('USRA');
    const B = auth('USRB');
    await sql(`CREATE TABLE ${LIB}.SALARIOS (NOMBRE VARCHAR(20), SUELDO DECIMAL(9, 2))`);
    await sql(`INSERT INTO ${LIB}.SALARIOS VALUES ('ANA', 1000)`);
    await cmd(`CRTDTAARA DTAARA(${LIB}/DA) TYPE(*CHAR) LEN(10) VALUE(X)`);
    await put('QCLSRC', 'HOLA', 'CLP', `PGM\n  CHGDTAARA DTAARA(${LIB}/DA) VALUE('HOLA')\nENDPGM`);
    await cmd(`CRTBNDCL PGM(${LIB}/HOLA) SRCFILE(${LIB}/QCLSRC)`);

    check('sin autorizaciones privadas, *PUBLIC *CHANGE (QCRTAUT): USRA lee la tabla', ok(await sql(`SELECT * FROM ${LIB}.SALARIOS`, A)));
    await cmd(`GRTOBJAUT OBJ(${LIB}/SALARIOS) OBJTYPE(*FILE) USER(*PUBLIC) AUT(*EXCLUDE)`);
    const s1 = await sql(`SELECT * FROM ${LIB}.SALARIOS`, A);
    check('*PUBLIC *EXCLUDE: SELECT da SQL0551 (42501)', errId(s1) === 'SQL0551' && s1.error.sqlstate === '42501', s1);
    check('*ALLOBJ (QSECOFR) sigue teniendo acceso', ok(await sql(`SELECT * FROM ${LIB}.SALARIOS`)));
    await cmd(`GRTOBJAUT OBJ(${LIB}/SALARIOS) OBJTYPE(*FILE) USER(USRA) AUT(*USE)`);
    check('autorización privada *USE: USRA lee', ok(await sql(`SELECT * FROM ${LIB}.SALARIOS`, A)));
    check('*USE no permite INSERT', errId(await sql(`INSERT INTO ${LIB}.SALARIOS VALUES ('X', 1)`, A)) === 'SQL0551');
    await cmd(`GRTOBJAUT OBJ(${LIB}/SALARIOS) OBJTYPE(*FILE) USER(USRA) AUT(*ADD)`);
    check('GRTOBJAUT añade *ADD a la autorización existente: INSERT sí, DELETE no', ok(await sql(`INSERT INTO ${LIB}.SALARIOS VALUES ('LUIS', 900)`, A)) && errId(await sql(`DELETE FROM ${LIB}.SALARIOS`, A)) === 'SQL0551');
    const dsp = await cmd(`DSPOBJAUT OBJ(${LIB}/SALARIOS) OBJTYPE(*FILE)`);
    const dspT = JSON.stringify(dsp);
    check('DSPOBJAUT: propietario *ALL, USRA USER DEF, *PUBLIC *EXCLUDE', /QSECOFR\s+\*ALL/.test(dspT) && /USRA\s+USER DEF/.test(dspT) && /\*PUBLIC\s+\*EXCLUDE/.test(dspT), dspT);
    await cmd(`RVKOBJAUT OBJ(${LIB}/SALARIOS) OBJTYPE(*FILE) USER(USRA) AUT(*ALL)`);
    check('RVKOBJAUT *ALL: USRA vuelve a *PUBLIC', errId(await sql(`SELECT * FROM ${LIB}.SALARIOS`, A)) === 'SQL0551');
    check('perfil de grupo: USRB sin autorización', errId(await sql(`SELECT * FROM ${LIB}.SALARIOS`, B)) === 'SQL0551');
    await cmd(`GRTOBJAUT OBJ(${LIB}/SALARIOS) OBJTYPE(*FILE) USER(GRUPO) AUT(*CHANGE)`);
    check('autorización del grupo GRUPO *CHANGE: USRB actualiza', ok(await sql(`UPDATE ${LIB}.SALARIOS SET SUELDO = SUELDO + 1`, B)));

    // Programas, listas de autorizaciones y biblioteca
    check('CALL con *PUBLIC *CHANGE', ok(await cmd(`CALL PGM(${LIB}/HOLA)`, A)));
    await cmd(`GRTOBJAUT OBJ(${LIB}/HOLA) OBJTYPE(*PGM) USER(*PUBLIC) AUT(*EXCLUDE)`);
    const c1 = await cmd(`CALL PGM(${LIB}/HOLA)`, A);
    check('CALL sin autorización: CPF9802', errId(c1) === 'CPF9802', c1);
    check('CRTAUTL', ok(await cmd('CRTAUTL AUTL(LISTA1) AUT(*EXCLUDE)')));
    await cmd('ADDAUTLE AUTL(LISTA1) USER(USRA) AUT(*USE)');
    const g = await cmd(`GRTOBJAUT OBJ(${LIB}/HOLA) OBJTYPE(*PGM) USER(*PUBLIC) AUT(*AUTL) AUTL(LISTA1)`);
    check('GRTOBJAUT AUTL(LISTA1) con *PUBLIC *AUTL', ok(g), g);
    check('lista de autorizaciones: USRA (*USE en la lista) llama al programa', ok(await cmd(`CALL PGM(${LIB}/HOLA)`, A)));
    check('lista de autorizaciones: USRB (no está) recibe CPF9802', errId(await cmd(`CALL PGM(${LIB}/HOLA)`, B)) === 'CPF9802');
    check('DSPAUTLOBJ lista el programa', /HOLA/.test(JSON.stringify(await cmd('DSPAUTLOBJ AUTL(LISTA1)'))));
    const del = await cmd('DLTAUTL AUTL(LISTA1)');
    check('DLTAUTL de una lista que protege objetos se rechaza', !ok(del), del);
    await cmd(`GRTOBJAUT OBJ(${LIB}) OBJTYPE(*LIB) USER(USRA) AUT(*EXCLUDE)`);
    const c2 = await cmd(`CALL PGM(${LIB}/HOLA)`, A);
    check('sin *EXECUTE sobre la biblioteca: CPF9820', errId(c2) === 'CPF9820', c2);
    await cmd(`RVKOBJAUT OBJ(${LIB}) OBJTYPE(*LIB) USER(USRA) AUT(*ALL)`);

    // *OBJEXIST y propietario
    const d1 = await cmd(`DLTOBJ OBJ(${LIB}/DA) OBJTYPE(*DTAARA)`, A);
    check('*PUBLIC *CHANGE no permite borrar (CPF2189)', errId(d1) === 'CPF2189', d1);
    const ch1 = await cmd(`CHGDTAARA DTAARA(${LIB}/DA) VALUE(OTRA)`, A);
    check('*CHANGE sí permite cambiar el área de datos', ok(ch1), ch1);
    check('CHGOBJOWN por quien no es propietario: CPF2189', errId(await cmd(`CHGOBJOWN OBJ(${LIB}/DA) OBJTYPE(*DTAARA) NEWOWN(USRA)`, A)) === 'CPF2189');
    check('CHGOBJOWN', ok(await cmd(`CHGOBJOWN OBJ(${LIB}/DA) OBJTYPE(*DTAARA) NEWOWN(USRA)`)));
    check('el nuevo propietario puede borrarlo', ok(await cmd(`DLTOBJ OBJ(${LIB}/DA) OBJTYPE(*DTAARA)`, A)));
    await cmd('CRTDTAARA DTAARA(QGPL/DAUSRA) TYPE(*CHAR) LEN(5)', A);
    const own = await sql("SELECT OWNER FROM QSYS.OBJECTS WHERE LIB = 'QGPL' AND NAME = 'DAUSRA' AND TYPE = '*DTAARA'");
    check('el creador de un objeto es su propietario', own.data && own.data[0] && own.data[0].OWNER === 'USRA', own);
    await cmd('DLTOBJ OBJ(QGPL/DAUSRA) OBJTYPE(*DTAARA)', A);
    const ck = await cmd(`CHKOBJ OBJ(${LIB}/SALARIOS) OBJTYPE(*FILE) AUT(*CHANGE)`, A);
    check('CHKOBJ AUT(*CHANGE) sin autorización: CPF9802', errId(ck) === 'CPF9802', ck);
    check('CHKOBJ AUT(*CHANGE) del grupo', ok(await cmd(`CHKOBJ OBJ(${LIB}/SALARIOS) OBJTYPE(*FILE) AUT(*CHANGE)`, B)));
    const gu = await cmd(`GRTOBJAUT OBJ(${LIB}/SALARIOS) OBJTYPE(*FILE) USER(USRA) AUT(*ALL)`, B);
    check('sin *OBJMGT no se pueden conceder autorizaciones', !ok(gu), gu);
    await cmd(`GRTOBJAUT OBJ(${LIB}/HOLA) OBJTYPE(*PGM) USER(*PUBLIC) AUT(*CHANGE) REPLACE(*YES)`);
    await cmd(`RVKOBJAUT OBJ(${LIB}/HOLA) OBJTYPE(*PGM) USER(*PUBLIC) AUTL(LISTA1)`);
    check('DLTAUTL cuando ya no protege nada', ok(await cmd('DLTAUTL AUTL(LISTA1)')));
    for (const u of ['USRA', 'USRB', 'GRUPO']) await cmd(`DLTUSRPRF USRPRF(${u})`);
  }

  if (want('jrn')) {
    await sql(`CREATE TABLE ${LIB}.CTAS (ID INT NOT NULL, NOMBRE VARCHAR(20), SALDO DECIMAL(9, 2))`);
    await sql(`CREATE TABLE ${LIB}.SINJRN (ID INT)`);
    check('CRTJRNRCV', ok(await cmd(`CRTJRNRCV JRNRCV(${LIB}/RCV0001) TEXT('Receptor 1')`)));
    const cj = await cmd(`CRTJRN JRN(${LIB}/JRN) JRNRCV(${LIB}/RCV0001)`);
    check('CRTJRN', ok(cj), cj);
    const sj = await cmd(`STRJRNPF FILE(${LIB}/CTAS) JRN(${LIB}/JRN) IMAGES(*BOTH)`);
    check('STRJRNPF IMAGES(*BOTH)', ok(sj), sj);
    check('STRJRNPF de un archivo ya registrado: CPF7030', errId(await cmd(`STRJRNPF FILE(${LIB}/CTAS) JRN(${LIB}/JRN)`)) === 'CPF7030');
    await sql(`INSERT INTO ${LIB}.CTAS VALUES (1, 'ANA', 100), (2, 'LUIS', 200)`);
    await sql(`UPDATE ${LIB}.CTAS SET SALDO = 150 WHERE ID = 1`);
    await sql(`DELETE FROM ${LIB}.CTAS WHERE ID = 2`, auth('DEMO'));
    const dj = await cmd(`DSPJRN JRN(${LIB}/JRN)`);
    const djT = (dj.messages || []).map((m) => m.text).join('\n');
    check('DSPJRN: F/JM, 2 × R/PT, R/UB, R/UP y R/DL', /F\s+JM/.test(djT) && (djT.match(/R\s+PT/g) || []).length === 2 && /R\s+UB/.test(djT) && /R\s+UP/.test(djT) && /R\s+DL/.test(djT), djT);
    check('DSPJRN: usuario y trabajo de cada cambio (también DEMO)', /R\s+PT\s+CTAS\s+\S+\s+QZHBHTTP\s+QSECOFR/.test(djT) && /R\s+DL\s+CTAS\s+\S+\s+QZHBHTTP\s+DEMO/.test(djT), djT);
    const of = await cmd(`DSPJRN JRN(${LIB}/JRN) FILE(${LIB}/CTAS) JRNCDE(R) OUTPUT(*OUTFILE) OUTFILE(${LIB}/JRNOUT)`);
    const out = await sql(`SELECT JOENTT, JOUSER, JOESD FROM ${LIB}.JRNOUT ORDER BY JOSEQN`);
    check('DSPJRN OUTPUT(*OUTFILE) en formato QADSPJRN', ok(of) && (out.data || []).map((r) => r.JOENTT).join(',') === 'PT,PT,UB,UP,DL' && /LUIS/.test(JSON.stringify(out.data)), [of, out]);
    // Control de compromiso: SQL7008 sin diario; con diario, ROLLBACK
    await cmd('ROLLBACK'); await cmd('ENDCMTCTL');
    await cmd('STRCMTCTL LCKLVL(*CHG)');
    const s7 = await sql(`INSERT INTO ${LIB}.SINJRN VALUES (1)`);
    check('bajo control de compromiso, tabla sin diario: SQL7008', errId(s7) === 'SQL7008' && s7.error.sqlstate === '55019', s7);
    await sql(`INSERT INTO ${LIB}.CTAS VALUES (3, 'EVA', 300)`);
    await cmd('ROLLBACK');
    const n3 = await sql(`SELECT COUNT(*) AS N FROM ${LIB}.CTAS`);
    check('tabla en diario bajo compromiso: ROLLBACK deshace', n3.data && n3.data[0].N === 1, n3);
    await cmd('ENDCMTCTL');
    // Receptores
    const ch = await cmd(`CHGJRN JRN(${LIB}/JRN) JRNRCV(*GEN)`);
    check('CHGJRN JRNRCV(*GEN) conecta RCV0002', ok(ch) && /RCV0002/.test(JSON.stringify(ch)), ch);
    check('DSPJRNRCVA: RCV0001 desconectado', /ONLINE/.test(JSON.stringify(await cmd(`DSPJRNRCVA JRNRCV(${LIB}/RCV0001)`))));
    check('DLTJRNRCV del receptor conectado: CPF7022', errId(await cmd(`DLTJRNRCV JRNRCV(${LIB}/RCV0002)`)) === 'CPF7022');
    const cur = (await cmd(`DSPJRN JRN(${LIB}/JRN)`)).messages.map((m) => m.text).join('');
    const chain = (await cmd(`DSPJRN JRN(${LIB}/JRN) RCVRNG(*CURCHAIN)`)).messages.map((m) => m.text).join('');
    check('RCVRNG(*CURRENT) solo ve el receptor nuevo (J/PR); *CURCHAIN ve todo', /J\s+PR/.test(cur) && !/R\s+PT/.test(cur) && /R\s+PT/.test(chain), cur);
    // Deshacer y volver a aplicar
    const all = await sql(`SELECT MIN(SEQ) AS F, MAX(SEQ) AS L FROM QSYS.JRNENT WHERE JRNLIB = '${LIB}' AND JRN = 'JRN' AND CODE = 'R'`);
    const [first, last] = [all.data[0].F, all.data[0].L];
    const rm = await cmd(`RMVJRNCHG JRN(${LIB}/JRN) FILE(${LIB}/CTAS) FROMENT(${last}) TOENT(${first})`);
    const after = await sql(`SELECT COUNT(*) AS N FROM ${LIB}.CTAS`);
    check('RMVJRNCHG deshace todos los cambios (tabla vacía)', ok(rm) && after.data[0].N === 0, [rm, after]);
    const ap = await cmd(`APYJRNCHG JRN(${LIB}/JRN) FILE(${LIB}/CTAS) FROMENT(${first}) TOENT(${last})`);
    const back = await sql(`SELECT ID, NOMBRE, SALDO FROM ${LIB}.CTAS ORDER BY ID`);
    check('APYJRNCHG vuelve a aplicarlos', ok(ap) && JSON.stringify(back.data) === JSON.stringify([{ ID: 1, NOMBRE: 'ANA', SALDO: 150 }]), [ap, back]);
    check('SNDJRNE (entrada de usuario U/01)', ok(await cmd(`SNDJRNE JRN(${LIB}/JRN) TYPE(01) ENTDTA('Cierre del dia')`)) && /U\s+01/.test(JSON.stringify(await cmd(`DSPJRN JRN(${LIB}/JRN) JRNCDE(U)`))));
    check('WRKJRNA muestra el archivo y los receptores', /CTAS/.test(JSON.stringify(await cmd(`WRKJRNA JRN(${LIB}/JRN)`))) && /RCV0002/.test(JSON.stringify(await cmd(`WRKJRNA JRN(${LIB}/JRN)`))));
    check('DLTJRN con archivos registrados: CPF7021', errId(await cmd(`DLTJRN JRN(${LIB}/JRN)`)) === 'CPF7021');
    check('ENDJRNPF', ok(await cmd(`ENDJRNPF FILE(${LIB}/CTAS)`)));
    await sql(`INSERT INTO ${LIB}.CTAS VALUES (9, 'SIN', 0)`);
    const nj = await sql(`SELECT COUNT(*) AS N FROM QSYS.JRNENT WHERE JRNLIB = '${LIB}' AND OBJ = 'CTAS' AND SALDO IS NULL`).catch(() => null);
    void nj;
    const cnt = await sql(`SELECT COUNT(*) AS N FROM QSYS.JRNENT WHERE JRNLIB = '${LIB}' AND OBJ = 'CTAS' AND ENTT = 'PT' AND DATA LIKE '%SIN%'`);
    check('tras ENDJRNPF los cambios ya no se registran', cnt.data && cnt.data[0].N === 0, cnt);
    // Esquema SQL: QSQJRN automático
    await sql('DROP SCHEMA SQLESQ RESTRICT');
    await cmd('DLTLIB LIB(SQLESQ)');
    const cs = await sql('CREATE SCHEMA SQLESQ');
    await sql('CREATE TABLE SQLESQ.PEDIDOS (ID INT, IMPORTE DECIMAL(9, 2))');
    const q = await sql("SELECT JRN, IMAGES FROM QSYS.JRNPF WHERE LIB = 'SQLESQ' AND FILE = 'PEDIDOS'");
    check('CREATE SCHEMA crea QSQJRN y CREATE TABLE queda registrada (*BOTH)', ok(cs) && q.data && q.data[0] && q.data[0].JRN === 'QSQJRN' && q.data[0].IMAGES === '*BOTH', [cs, q]);
    await cmd('STRCMTCTL LCKLVL(*CHG)');
    check('tabla de un esquema SQL bajo compromiso: sin SQL7008', ok(await sql('INSERT INTO SQLESQ.PEDIDOS VALUES (1, 10)')));
    await cmd('COMMIT'); await cmd('ENDCMTCTL');
    const bk = await sql("SELECT COUNT(*) AS N FROM QSYS.JRNPF WHERE LIB = 'BANCO' AND JRN = 'QSQJRN'");
    check('las tablas de BANCO están en BANCO/QSQJRN', bk.data && bk.data[0].N >= 5, bk);
    await cmd('DLTLIB LIB(SQLESQ)');
  }

  if (want('sav')) {
    for (const l of [LIB, 'SVCCOPY']) await cmd(`DLTLIB LIB(${l})`);
    await cmd(`CRTLIB LIB(${LIB}) TEXT('Biblioteca a salvar')`);
    for (const f of ['SVCSAVF', 'SVCSAVF2', 'SVCCHG', 'SECSAVF']) await cmd(`DLTF FILE(QGPL/${f})`);
    await sql(`CREATE TABLE ${LIB}.CLIENTES (ID INT NOT NULL PRIMARY KEY, NOMBRE VARCHAR(30) NOT NULL, ALTA DATE, SALDO DECIMAL(11, 2) DEFAULT 0)`);
    await sql(`INSERT INTO ${LIB}.CLIENTES VALUES (1, 'ANA', '2024-01-15', 100.50), (2, 'LUIS', NULL, 2000)`);
    await sql(`CREATE VIEW ${LIB}.VCLI AS SELECT ID, NOMBRE FROM ${LIB}.CLIENTES WHERE SALDO > 500`);
    await cmd(`CRTSRCPF FILE(${LIB}/QCLSRC)`);
    await put('QCLSRC', 'HOLA', 'CLP', `PGM\n  CHGDTAARA DTAARA(${LIB}/DA) VALUE('RESTAURADO')\nENDPGM`);
    await cmd(`CRTBNDCL PGM(${LIB}/HOLA) SRCFILE(${LIB}/QCLSRC)`);
    await cmd(`CRTDTAARA DTAARA(${LIB}/DA) TYPE(*CHAR) LEN(20) VALUE(ORIGINAL)`);
    await cmd(`CRTDTAQ DTAQ(${LIB}/COLA) MAXLEN(100)`);
    await sql(`CALL QSYS2.SEND_DATA_QUEUE(MESSAGE_DATA => 'mensaje 1', DATA_QUEUE => 'COLA', DATA_QUEUE_LIBRARY => '${LIB}')`);
    await cmd(`GRTOBJAUT OBJ(${LIB}/CLIENTES) OBJTYPE(*FILE) USER(*PUBLIC) AUT(*EXCLUDE)`);
    check('CRTSAVF', ok(await cmd('CRTSAVF FILE(QGPL/SVCSAVF)')));
    const sl = await cmd(`SAVLIB LIB(${LIB}) DEV(*SAVF) SAVF(QGPL/SVCSAVF)`);
    check('SAVLIB a un archivo de salvar', ok(sl) && /objects saved from library/.test(JSON.stringify(sl)), sl);
    const ds = await cmd('DSPSAVF FILE(QGPL/SVCSAVF)');
    const dsT = (ds.messages || []).map((m) => m.text).join('\n');
    check('DSPSAVF lista los objetos salvados', /CLIENTES\s+\*FILE\s+PF/.test(dsT) && /VCLI\s+\*FILE\s+LF/.test(dsT) && /HOLA\s+\*PGM/.test(dsT) && /COLA\s+\*DTAQ/.test(dsT) && /SAVLIB/.test(dsT), dsT);
    check('SAVLIB sobre un SAVF con datos sin CLEAR: rechazado', !ok(await cmd(`SAVLIB LIB(${LIB}) DEV(*SAVF) SAVF(QGPL/SVCSAVF)`)));
    check('DEV(TAP01): CPF9814', errId(await cmd(`SAVLIB LIB(${LIB}) DEV(TAP01)`)) === 'CPF9814');

    // Pérdida total de la biblioteca y restauración
    await cmd(`DLTLIB LIB(${LIB})`);
    const rl = await cmd(`RSTLIB SAVLIB(${LIB}) DEV(*SAVF) SAVF(QGPL/SVCSAVF)`);
    check('RSTLIB restaura la biblioteca', ok(rl) && /objects restored/.test(JSON.stringify(rl)), rl);
    const cl = await sql(`SELECT ID, NOMBRE, ALTA, SALDO FROM ${LIB}.CLIENTES ORDER BY ID`);
    check('datos de la tabla (DATE, DECIMAL, NULL)', JSON.stringify(cl.data) === JSON.stringify([{ ID: 1, NOMBRE: 'ANA', ALTA: '2024-01-15', SALDO: 100.5 }, { ID: 2, NOMBRE: 'LUIS', ALTA: null, SALDO: 2000 }]), cl);
    check('la clave primaria se conserva', errId(await sql(`INSERT INTO ${LIB}.CLIENTES (ID, NOMBRE) VALUES (1, 'DUP')`)) === 'SQL0803');
    check('el valor por omisión de la columna se conserva', ok(await sql(`INSERT INTO ${LIB}.CLIENTES (ID, NOMBRE) VALUES (3, 'EVA')`)) && (await sql(`SELECT SALDO FROM ${LIB}.CLIENTES WHERE ID = 3`)).data[0].SALDO === 0);
    check('la vista (LF) funciona', JSON.stringify((await sql(`SELECT NOMBRE FROM ${LIB}.VCLI`)).data) === JSON.stringify([{ NOMBRE: 'LUIS' }]));
    check('miembro fuente restaurado', /CHGDTAARA/.test((await api('GET', `/sources/${LIB}/QCLSRC/HOLA`)).text || ''));
    check('área de datos restaurada', /ORIGINAL/.test(JSON.stringify(await cmd(`DSPDTAARA DTAARA(${LIB}/DA)`))));
    check('el programa restaurado se ejecuta', ok(await cmd(`CALL PGM(${LIB}/HOLA)`)) && /RESTAURADO/.test(JSON.stringify(await cmd(`DSPDTAARA DTAARA(${LIB}/DA)`))));
    const q = await sql(`SELECT MESSAGE_DATA FROM TABLE(QSYS2.DATA_QUEUE_ENTRIES(DATA_QUEUE => 'COLA', DATA_QUEUE_LIBRARY => '${LIB}'))`);
    check('entradas de la cola de datos restauradas', /mensaje 1/.test(JSON.stringify(q)), q);
    check('la autorización *PUBLIC *EXCLUDE se conserva', errId(await sql(`SELECT * FROM ${LIB}.CLIENTES`, auth('DEMO'))) === 'SQL0551');
    // Copia en otra biblioteca
    const cp = await cmd(`RSTLIB SAVLIB(${LIB}) DEV(*SAVF) SAVF(QGPL/SVCSAVF) RSTLIB(SVCCOPY)`);
    check('RSTLIB RSTLIB(otra): copia de la biblioteca, la vista apunta a la nueva', ok(cp) && JSON.stringify((await sql('SELECT NOMBRE FROM SVCCOPY.VCLI')).data) === JSON.stringify([{ NOMBRE: 'LUIS' }]), cp);
    await cmd('DLTLIB LIB(SVCCOPY)');

    // SAVOBJ / RSTOBJ y recuperación con el diario
    await cmd(`CRTJRNRCV JRNRCV(${LIB}/RCV0001)`);
    await cmd(`CRTJRN JRN(${LIB}/JRN) JRNRCV(${LIB}/RCV0001)`);
    await sql(`CREATE TABLE ${LIB}.MOVTOS (ID INT NOT NULL, IMPORTE DECIMAL(9, 2))`);
    await cmd(`STRJRNPF FILE(${LIB}/MOVTOS) JRN(${LIB}/JRN) IMAGES(*BOTH)`);
    await sql(`INSERT INTO ${LIB}.MOVTOS VALUES (1, 10), (2, 20)`);
    await cmd('CRTSAVF FILE(QGPL/SVCSAVF2)');
    const so = await cmd(`SAVOBJ OBJ(MOVTOS CLIENTES) LIB(${LIB}) DEV(*SAVF) SAVF(QGPL/SVCSAVF2)`);
    check('SAVOBJ de dos archivos', ok(so) && /2 objects saved/.test(JSON.stringify(so)), so);
    await sql(`INSERT INTO ${LIB}.MOVTOS VALUES (3, 30), (4, 40)`);
    await sql(`UPDATE ${LIB}.MOVTOS SET IMPORTE = 11 WHERE ID = 1`);
    const dl = await cmd(`DLTF FILE(${LIB}/MOVTOS)`);
    check('se pierde el archivo (DLTF)', ok(dl), dl);
    const ro = await cmd(`RSTOBJ OBJ(MOVTOS) SAVLIB(${LIB}) DEV(*SAVF) SAVF(QGPL/SVCSAVF2)`);
    const m1 = await sql(`SELECT ID, IMPORTE FROM ${LIB}.MOVTOS ORDER BY ID`);
    check('RSTOBJ devuelve el archivo al momento del salvado', ok(ro) && JSON.stringify(m1.data) === JSON.stringify([{ ID: 1, IMPORTE: 10 }, { ID: 2, IMPORTE: 20 }]), [ro, m1]);
    check('el archivo restaurado sigue registrado en su diario', /MOVTOS/.test(JSON.stringify(await sql(`SELECT FILE FROM QSYS.JRNPF WHERE LIB = '${LIB}'`))));
    const ap = await cmd(`APYJRNCHG JRN(${LIB}/JRN) FILE(${LIB}/MOVTOS)`);
    const m2 = await sql(`SELECT ID, IMPORTE FROM ${LIB}.MOVTOS ORDER BY ID`);
    check('APYJRNCHG FROMENT(*LASTSAVE): recupera los cambios posteriores al salvado', ok(ap) && JSON.stringify(m2.data) === JSON.stringify([{ ID: 1, IMPORTE: 11 }, { ID: 2, IMPORTE: 20 }, { ID: 3, IMPORTE: 30 }, { ID: 4, IMPORTE: 40 }]), [ap, m2]);
    await sql(`DELETE FROM ${LIB}.CLIENTES WHERE ID > 0`);
    const ro2 = await cmd(`RSTOBJ OBJ(CLIENTES) SAVLIB(${LIB}) DEV(*SAVF) SAVF(QGPL/SVCSAVF2) MBROPT(*ALL)`);
    check('RSTOBJ sobre un objeto existente lo sustituye', ok(ro2) && (await sql(`SELECT COUNT(*) AS N FROM ${LIB}.CLIENTES`)).data[0].N === 3, ro2);
    check('RSTOBJ MBROPT(*NEW) no toca un archivo existente', /not restored/.test(JSON.stringify(await cmd(`RSTOBJ OBJ(CLIENTES) SAVLIB(${LIB}) DEV(*SAVF) SAVF(QGPL/SVCSAVF2) MBROPT(*NEW)`))));

    // SAVCHGOBJ
    await new Promise((r) => setTimeout(r, 1200));
    await cmd(`CHGDTAARA DTAARA(${LIB}/DA) VALUE(CAMBIADA)`);
    await cmd('CRTSAVF FILE(QGPL/SVCCHG)');
    const sc = await cmd(`SAVCHGOBJ OBJ(*ALL) LIB(${LIB}) DEV(*SAVF) SAVF(QGPL/SVCCHG) REFDATE(*SAVLIB)`);
    const scT = (await cmd('DSPSAVF FILE(QGPL/SVCCHG)')).messages.map((m) => m.text).join('\n');
    check('SAVCHGOBJ REFDATE(*SAVLIB) salva solo lo cambiado desde el último salvado', ok(sc) && /DA\s+\*DTAARA/.test(scT) && !/HOLA\s+\*PGM/.test(scT), scT);

    // FTP en binario: bajar el SAVF y subirlo a otro
    const got = await ftp([['RETR', 'QGPL/SVCSAVF']]);
    check('FTP: GET binario de un SAVF', got['QGPL/SVCSAVF'].data.length > 100 && got['QGPL/SVCSAVF'].data[0] === 0x1f, got['QGPL/SVCSAVF'].reply);
    await cmd('DLTF FILE(QGPL/SVCSAVF2)');
    const putR = await ftp([['STOR', 'QGPL/SVCSAVF2', got['QGPL/SVCSAVF'].data]]);
    const ds2 = (await cmd('DSPSAVF FILE(QGPL/SVCSAVF2)')).messages.map((m) => m.text).join('\n');
    check('FTP: PUT binario crea y carga el SAVF', /loaded/.test(putR['QGPL/SVCSAVF2'].reply) && /VCLI\s+\*FILE/.test(ds2), [putR['QGPL/SVCSAVF2'].reply, ds2]);

    // Datos de seguridad
    await cmd('DLTUSRPRF USRPRF(TESTSEC)');
    await cmd('CRTUSRPRF USRPRF(TESTSEC) PASSWORD(CLAVE1) TEXT(\'Usuario de prueba\')');
    await cmd(`GRTOBJAUT OBJ(${LIB}/CLIENTES) OBJTYPE(*FILE) USER(TESTSEC) AUT(*USE)`);
    await cmd('CRTSAVF FILE(QGPL/SECSAVF)');
    check('SAVSECDTA', ok(await cmd('SAVSECDTA DEV(*SAVF) SAVF(QGPL/SECSAVF)')));
    await cmd('DLTUSRPRF USRPRF(TESTSEC)');
    check('el perfil borrado no puede conectarse', !(await api('GET', '/system', undefined, auth('TESTSEC', 'CLAVE1'))).name);
    const ru = await cmd('RSTUSRPRF DEV(*SAVF) SAVF(QGPL/SECSAVF) USRPRF(TESTSEC)');
    const si = await api('GET', '/system', undefined, auth('TESTSEC', 'CLAVE1'));
    check('RSTUSRPRF: el perfil vuelve con su contraseña', ok(ru) && si.name === 'AS400TDS', si);
    const ra = await cmd('RSTAUT USRPRF(TESTSEC) SAVF(QGPL/SECSAVF)');
    check('RSTAUT: vuelven sus autorizaciones privadas', ok(ra) && ok(await sql(`SELECT COUNT(*) FROM ${LIB}.CLIENTES`, auth('TESTSEC', 'CLAVE1'))), ra);
    await cmd('DLTUSRPRF USRPRF(TESTSEC)');
    for (const f of ['SVCSAVF', 'SVCSAVF2', 'SVCCHG', 'SECSAVF']) await cmd(`DLTF FILE(QGPL/${f})`);
  }

  if (want('cmd')) {
    await cmd(`CRTSRCPF FILE(${LIB}/QCMDSRC)`);
    await cmd(`CRTSRCPF FILE(${LIB}/QCLSRC)`);
    await cmd(`CRTDTAARA DTAARA(${LIB}/RES) TYPE(*CHAR) LEN(60)`);
    await put('QCMDSRC', 'SALUDAR', 'CMD', [
      "             CMD        PROMPT('Saludar a un cliente')",
      "             PARM       KWD(NOMBRE) TYPE(*CHAR) LEN(20) MIN(1) +",
      "                          PROMPT('Nombre del cliente') CASE(*MIXED)",
      "             PARM       KWD(VECES) TYPE(*DEC) LEN(3 0) DFT(1) PROMPT('Veces')",
      "             PARM       KWD(SALIDA) TYPE(Q1) MIN(1) PROMPT('Area de datos')",
      "             PARM       KWD(FORMAL) TYPE(*CHAR) LEN(4) RSTD(*YES) VALUES(*YES *NO) DFT(*NO) PROMPT('Formal')",
      " Q1:         QUAL       TYPE(*NAME) LEN(10)",
      "             QUAL       TYPE(*NAME) LEN(10) DFT(*LIBL) SPCVAL((*LIBL) (*CURLIB)) PROMPT('Biblioteca')",
    ].join('\n'));
    await put('QCLSRC', 'SALUDARC', 'CLP', [
      'PGM PARM(&NOMBRE &VECES &SALIDA &FORMAL)',
      '  DCL VAR(&NOMBRE) TYPE(*CHAR) LEN(20)',
      '  DCL VAR(&VECES) TYPE(*DEC) LEN(3 0)',
      '  DCL VAR(&SALIDA) TYPE(*CHAR) LEN(20)',
      '  DCL VAR(&FORMAL) TYPE(*CHAR) LEN(4)',
      '  DCL VAR(&DA) TYPE(*CHAR) LEN(10)',
      '  DCL VAR(&LIB) TYPE(*CHAR) LEN(10)',
      '  DCL VAR(&TXT) TYPE(*CHAR) LEN(60)',
      '  DCL VAR(&N) TYPE(*CHAR) LEN(3)',
      '  CHGVAR VAR(&DA) VALUE(%SST(&SALIDA 1 10))',
      '  CHGVAR VAR(&LIB) VALUE(%SST(&SALIDA 11 10))',
      '  CHGVAR VAR(&N) VALUE(&VECES)',
      "  IF COND(&FORMAL *EQ '*YES') THEN(CHGVAR VAR(&TXT) VALUE('Estimado' *BCAT &NOMBRE))",
      "  ELSE CMD(CHGVAR VAR(&TXT) VALUE('Hola' *BCAT &NOMBRE))",
      "  CHGVAR VAR(&TXT) VALUE(&TXT *TCAT ' x' *CAT &N)",
      '  CHGDTAARA DTAARA(&LIB/&DA) VALUE(&TXT)',
      'ENDPGM',
    ].join('\n'));
    await put('QCLSRC', 'SALUDARV', 'CLP', [
      'PGM PARM(&NOMBRE &VECES &SALIDA &FORMAL)',
      '  DCL VAR(&NOMBRE) TYPE(*CHAR) LEN(20)',
      '  DCL VAR(&VECES) TYPE(*DEC) LEN(3 0)',
      '  DCL VAR(&SALIDA) TYPE(*CHAR) LEN(20)',
      '  DCL VAR(&FORMAL) TYPE(*CHAR) LEN(4)',
      "  IF COND(&VECES *GT 5) THEN(SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('Como mucho 5 veces') MSGTYPE(*ESCAPE))",
      'ENDPGM',
    ].join('\n'));
    for (const p of ['SALUDARC', 'SALUDARV']) await cmd(`CRTBNDCL PGM(${LIB}/${p}) SRCFILE(${LIB}/QCLSRC)`);
    const cc = await cmd(`CRTCMD CMD(${LIB}/SALUDAR) PGM(${LIB}/SALUDARC) SRCFILE(${LIB}/QCMDSRC) VLDCKR(${LIB}/SALUDARV)`);
    check('CRTCMD', ok(cc) && /SALUDAR created/.test(JSON.stringify(cc)), cc);
    await cmd(`ADDLIBLE LIB(${LIB})`);
    const r1 = await cmd(`SALUDAR NOMBRE('Ana Lopez') SALIDA(${LIB}/RES)`);
    const v1 = JSON.stringify(await cmd(`DSPDTAARA DTAARA(${LIB}/RES)`));
    check('el mandato llama al CPP con *CHAR (mayúsculas/minúsculas), *DEC por omisión y nombre cualificado', ok(r1) && /Hola Ana Lopez x\s*0*1/.test(v1), [r1, v1]);
    const r2 = await cmd(`${LIB}/SALUDAR 'Luis' 3 RES *YES`);
    const v2 = JSON.stringify(await cmd(`DSPDTAARA DTAARA(${LIB}/RES)`));
    check('parámetros posicionales, cualificado BIB/MANDATO y QUAL con *LIBL', ok(r2) && /Estimado Luis x\s*0*3/.test(v2), [r2, v2]);
    check('parámetro obligatorio que falta: CPD0072', errId(await cmd(`SALUDAR SALIDA(${LIB}/RES)`)) === 'CPD0072');
    check('RSTD(*YES) con un valor no permitido: CPD0074', errId(await cmd(`SALUDAR NOMBRE(X) SALIDA(${LIB}/RES) FORMAL(QUIZA)`)) === 'CPD0074');
    check('palabra clave desconocida: CPD0043', errId(await cmd(`SALUDAR NOMBRE(X) SALIDA(${LIB}/RES) COLOR(ROJO)`)) === 'CPD0043');
    const vk = await cmd(`SALUDAR NOMBRE(X) VECES(9) SALIDA(${LIB}/RES)`);
    check('el programa de validación (VLDCKR) rechaza VECES(9): CPF0006', errId(vk) === 'CPF0006' && /Como mucho 5 veces/.test(JSON.stringify(vk)), vk);
    const dc = JSON.stringify(await cmd(`DSPCMD CMD(${LIB}/SALUDAR)`));
    check('DSPCMD', /SALUDARC/.test(dc) && /NOMBRE\s+\*CHAR/.test(dc) && /Saludar a un cliente/.test(dc), dc);
    // Un mandato de usuario con el nombre de uno del sistema solo se usa cualificado
    await put('QCMDSRC', 'DSPLIBL', 'CMD', "             CMD        PROMPT('Mi DSPLIBL')\n             PARM       KWD(NOMBRE) TYPE(*CHAR) LEN(20) DFT('sistema no')\n             PARM       KWD(VECES) TYPE(*DEC) LEN(3 0) DFT(7)\n             PARM       KWD(SALIDA) TYPE(*CHAR) LEN(20) DFT(RES)\n             PARM       KWD(FORMAL) TYPE(*CHAR) LEN(4) DFT(*NO)");
    await cmd(`CRTCMD CMD(${LIB}/DSPLIBL) PGM(${LIB}/SALUDARC) SRCFILE(${LIB}/QCMDSRC)`);
    check('DSPLIBL sin cualificar es el del sistema (QSYS va primero)', /Library List/.test(JSON.stringify(await cmd('DSPLIBL'))));
    const bad = [
      "             CMD        PROMPT('Erroneo')",
      '             PARM       TYPE(*CHAR) LEN(10)',
    ].join('\n');
    await put('QCMDSRC', 'MALO', 'CMD', bad);
    const cb = await cmd(`CRTCMD CMD(${LIB}/MALO) PGM(${LIB}/SALUDARC) SRCFILE(${LIB}/QCMDSRC)`);
    check('fuente erróneo: CPF0201 con diagnóstico CPD0204', errId(cb) === 'CPF0201' && /CPD0204/.test(JSON.stringify(cb.joblog || [])), cb);
    check('DLTCMD', ok(await cmd(`DLTCMD CMD(${LIB}/SALUDAR)`)) && errId(await cmd(`SALUDAR NOMBRE(X) SALIDA(${LIB}/RES)`)) === 'CPD0030');
    await cmd(`RMVLIBLE LIB(${LIB})`);
  }

  if (want('ifsaut')) {
    // Autorizaciones del IFS: datos (*R *W *X), objeto (*OBJEXIST *OBJMGT), propietario, grupo primario, lista de autorizaciones
    const D = '/tmp/autprueba';
    const U = auth('IFSUSR');
    const ifsGet = (p, h = SECOFR) => fetch(`${BASE}/api/v1/ifs${p}`, { headers: h }).then(async (r) => ({ status: r.status, text: await r.text() }));
    const ifsPut = (p, body, h = SECOFR) => fetch(`${BASE}/api/v1/ifs${p}`, { method: 'PUT', headers: { ...h, 'Content-Type': 'text/plain' }, body }).then(async (r) => ({ status: r.status, text: await r.text() }));
    const ifsDel = (p, h = SECOFR) => fetch(`${BASE}/api/v1/ifs${p}`, { method: 'DELETE', headers: h }).then(async (r) => ({ status: r.status, text: await r.text() }));
    await cmd(`RMVDIR DIR('${D}') SUBTREE(*ALL)`);
    for (const u of ['IFSUSR', 'IFSGRP']) await cmd(`DLTUSRPRF USRPRF(${u})`);
    await cmd('DLTAUTL AUTL(IFSAUTL)');
    await cmd("CRTUSRPRF USRPRF(IFSGRP) PASSWORD(*NONE) USRCLS(*USER) TEXT('Grupo IFS')");
    await cmd("CRTUSRPRF USRPRF(IFSUSR) PASSWORD(IFSUSR) USRCLS(*USER) TEXT('Usuario IFS')");
    check('MKDIR', ok(await cmd(`MKDIR DIR('${D}')`)));
    await ifsPut(`${D}/secreto.txt`, 'confidencial\n');
    const da = await cmd(`DSPAUT OBJ('${D}/secreto.txt')`);
    check('DSPAUT: propietario el creador, *PUBLIC heredado del directorio (*RWX)', /Owner[ .]*:\s+QSECOFR/.test(JSON.stringify(da)) && /\*PUBLIC\s+\*RWX/.test(da.text || JSON.stringify(da)), da);
    check('CHGAUT *PUBLIC *EXCLUDE', ok(await cmd(`CHGAUT OBJ('${D}/secreto.txt') USER(*PUBLIC) DTAAUT(*EXCLUDE) OBJAUT(*NONE)`)));
    const g1 = await ifsGet(`${D}/secreto.txt`, U);
    check('sin autorización: 403 CPFA09C', g1.status === 403 && /CPFA09C/.test(g1.text), g1);
    await cmd(`CHGAUT OBJ('${D}/secreto.txt') USER(IFSUSR) DTAAUT(*R)`);
    const g2 = await ifsGet(`${D}/secreto.txt`, U);
    check('privada *R: puede leer', g2.status === 200 && /confidencial/.test(g2.text), g2);
    const w1 = await ifsPut(`${D}/secreto.txt`, 'cambiado', U);
    check('privada *R: no puede escribir', w1.status === 403, w1);
    await cmd(`CHGAUT OBJ('${D}') USER(*PUBLIC) DTAAUT(*RX) OBJAUT(*NONE)`);
    const c1 = await ifsPut(`${D}/nuevo.txt`, 'hola', U);
    check('crear en un directorio con *RX: no', c1.status === 403, c1);
    await cmd(`CHGAUT OBJ('${D}') USER(IFSUSR) DTAAUT(*RWX)`);
    const c2 = await ifsPut(`${D}/nuevo.txt`, 'hola', U);
    const dn = await cmd(`DSPAUT OBJ('${D}/nuevo.txt')`);
    check('con *WX en el directorio crea, y es el propietario; hereda la privada del directorio', c2.status === 201 && /Owner[ .]*:\s+IFSUSR/.test(JSON.stringify(dn)) && /\*PUBLIC\s+\*RX/.test(JSON.stringify(dn)) && /IFSUSR\s+\*RWX/.test(JSON.stringify(dn)), [c2, dn]);
    const d1 = await ifsDel(`${D}/secreto.txt`, U);
    check('borrar sin *OBJEXIST: no', d1.status === 403, d1);
    check('CHGOWN', ok(await cmd(`CHGOWN OBJ('${D}/secreto.txt') NEWOWN(IFSUSR)`)));
    const d2 = await ifsDel(`${D}/secreto.txt`, U);
    check('el nuevo propietario puede borrarlo', d2.status === 200, d2);
    // *X en la ruta
    await cmd(`MKDIR DIR('${D}/cerrado')`);
    await ifsPut(`${D}/cerrado/dentro.txt`, 'x');
    await cmd(`CHGAUT OBJ('${D}/cerrado') USER(*PUBLIC) DTAAUT(*EXCLUDE)`);
    // la privada de IFSUSR la heredó del directorio padre: se quita
    await cmd(`CHGAUT OBJ('${D}/cerrado') USER(IFSUSR) DTAAUT(*NONE) OBJAUT(*NONE)`);
    await cmd(`CHGAUT OBJ('${D}/cerrado/dentro.txt') USER(*PUBLIC) DTAAUT(*RWX)`);
    const x1 = await ifsGet(`${D}/cerrado/dentro.txt`, U);
    check('sin *X en un directorio de la ruta no se llega al objeto', x1.status === 403 && /cerrado/.test(x1.text), x1);
    // Grupo primario
    await cmd('CHGUSRPRF USRPRF(IFSUSR) GRPPRF(IFSGRP)');
    await cmd(`CHGPGP OBJ('${D}/cerrado') NEWPGP(IFSGRP)`);
    await cmd(`CHGAUT OBJ('${D}/cerrado') USER(IFSGRP) DTAAUT(*RX)`);
    const x2 = await ifsGet(`${D}/cerrado/dentro.txt`, U);
    check('grupo primario con *RX: el miembro del grupo pasa', x2.status === 200, x2);
    // Lista de autorizaciones
    await ifsPut(`${D}/lista.txt`, 'por lista');
    await cmd(`CHGAUT OBJ('${D}/lista.txt') USER(*PUBLIC) DTAAUT(*EXCLUDE)`);
    await cmd(`CHGAUT OBJ('${D}/lista.txt') USER(IFSUSR) DTAAUT(*NONE) OBJAUT(*NONE)`);
    await cmd('CRTAUTL AUTL(IFSAUTL) AUT(*EXCLUDE)');
    await cmd('ADDAUTLE AUTL(IFSAUTL) USER(IFSUSR) AUT(*USE)');
    const l0 = await ifsGet(`${D}/lista.txt`, U);
    await cmd(`CHGAUT OBJ('${D}/lista.txt') AUTL(IFSAUTL)`);
    await cmd(`CHGAUT OBJ('${D}/lista.txt') USER(*PUBLIC) DTAAUT(*AUTL)`);
    const l1 = await ifsGet(`${D}/lista.txt`, U);
    check('lista de autorizaciones (*USE) en un objeto del IFS', l0.status === 403 && l1.status === 200, [l0, l1]);
    // SQL y QSH
    const sp = await sql(`SELECT AUTHORIZATION_NAME, DATA_AUTHORITY, OBJECT_EXISTENCE, OWNER FROM TABLE(QSYS2.IFS_OBJECT_PRIVILEGES(PATH_NAME => '${D}/nuevo.txt')) X`);
    check('QSYS2.IFS_OBJECT_PRIVILEGES', JSON.stringify(sp.data || []).includes('"AUTHORIZATION_NAME":"*PUBLIC","DATA_AUTHORITY":"*RX"') && /"OWNER":"IFSUSR"/.test(JSON.stringify(sp.data)), sp);
    const ch = await cmd(`QSH CMD('chmod 700 ${D}/nuevo.txt && ls -l ${D}/nuevo.txt > ${D}/ls.out')`, U);
    const lo = await ifsGet(`${D}/ls.out`);
    const da2 = await cmd(`DSPAUT OBJ('${D}/nuevo.txt')`);
    check('QSH chmod 700 por el propietario: *PUBLIC *EXCLUDE; ls -l muestra -rwx------', ok(ch) && /-rwx------\s+1 ifsusr/.test(lo.text) && /\*PUBLIC\s+\*EXCLUDE/.test(JSON.stringify(da2)), [ch, lo, da2]);
    const ftpD = await ftp([['CWD', D], ['RETR', `${D}/lista.txt`]], { user: 'DEMO', pwd: 'DEMO' });
    check('FTP: RETR sin autorización → 550', /^550/.test(ftpD[`${D}/lista.txt`].reply), ftpD);
    check('CHGAUT por quien no es propietario: CPFA09C', errId(await cmd(`CHGAUT OBJ('${D}/lista.txt') USER(*PUBLIC) DTAAUT(*RWX)`, U)) === 'CPFA09C');
    check('RMVDIR SUBTREE(*ALL) de otro usuario sin *OBJEXIST: no', errId(await cmd(`RMVDIR DIR('${D}') SUBTREE(*ALL)`, U)) === 'CPFA09C');
    check('RMVDIR SUBTREE(*ALL) del responsable de seguridad', ok(await cmd(`RMVDIR DIR('${D}') SUBTREE(*ALL)`)));
    const gone = await sql(`SELECT COUNT(*) AS N FROM QSYS.IFSAUT WHERE PATH LIKE '${D}%'`);
    check('al borrar desaparecen sus autorizaciones', gone.data && gone.data[0].N === 0, gone);
    await cmd('DLTAUTL AUTL(IFSAUTL)');
    for (const u of ['IFSUSR', 'IFSGRP']) await cmd(`DLTUSRPRF USRPRF(${u})`);
  }

  if (want('commit')) {
    // CRTSQLRPGI y RUNSQL usan COMMIT(*CHG) por omisión: modificar una tabla sin diario da SQL7008
    await sql(`DROP TABLE ${LIB}.CMTT`);
    await sql(`CREATE TABLE ${LIB}.CMTT (N INT)`);
    await cmd(`CRTSRCPF FILE(${LIB}/QRPGLESRC)`);
    await put('QRPGLESRC', 'CMTINS', 'SQLRPGLE', `**FREE\nexec sql insert into ${LIB}.CMTT values (1);\n*inlr = *on;`);
    check('CRTSQLRPGI sin COMMIT', ok(await cmd(`CRTSQLRPGI OBJ(${LIB}/CMTINS) SRCFILE(${LIB}/QRPGLESRC)`)));
    await cmd(`CALL PGM(${LIB}/CMTINS)`);
    const n1 = await sql(`SELECT COUNT(*) AS N FROM ${LIB}.CMTT`);
    check('COMMIT(*CHG) por omisión: el INSERT en una tabla sin diario no se hace (SQL7008)', n1.data && n1.data[0].N === 0, n1);
    await cmd(`CRTSQLRPGI OBJ(${LIB}/CMTINS) SRCFILE(${LIB}/QRPGLESRC) COMMIT(*NONE)`);
    await cmd(`CALL PGM(${LIB}/CMTINS)`);
    const n2 = await sql(`SELECT COUNT(*) AS N FROM ${LIB}.CMTT`);
    check('COMMIT(*NONE): sí', n2.data && n2.data[0].N === 1, n2);
    const r1 = await cmd(`RUNSQL SQL('INSERT INTO ${LIB}.CMTT VALUES (2)')`);
    check('RUNSQL sin COMMIT en tabla sin diario: SQL7008', errId(r1) === 'SQL7008', r1);
    check('RUNSQL COMMIT(*NONE)', ok(await cmd(`RUNSQL SQL('INSERT INTO ${LIB}.CMTT VALUES (2)') COMMIT(*NONE)`)));
    await sql('DROP SCHEMA CMTSCH CASCADE').catch(() => {});
    await cmd('DLTLIB LIB(CMTSCH)');
    await sql('CREATE SCHEMA CMTSCH');
    await sql('CREATE TABLE CMTSCH.T (N INT)');
    check('RUNSQL COMMIT(*CHG) en una tabla de un esquema SQL (QSQJRN): se confirma', ok(await cmd("RUNSQL SQL('INSERT INTO CMTSCH.T VALUES (7)')")) && (await sql('SELECT N FROM CMTSCH.T')).data?.[0]?.N === 7);
    await cmd('DLTLIB LIB(CMTSCH)');
  }

  if (want('tape')) {
    // Cinta virtual: catálogo de imágenes, INZTAP, SAVLIB de varias bibliotecas, SEQNBR, ENDOPT, SAV/RST del IFS, SAVSYS
    const J = (r) => JSON.stringify(r);
    const DEVT = 'TAPVRT01';
    await cmd('LODIMGCLG IMGCLG(PRUEBACLG) OPTION(*UNLOAD)');
    await cmd('DLTIMGCLG IMGCLG(PRUEBACLG) KEEP(*NO)');
    await cmd("RMVDIR DIR('/backup/prueba') SUBTREE(*ALL)");
    await cmd("RMVDIR DIR('/tmp/tapeifs') SUBTREE(*ALL)");
    await cmd("RMVDIR DIR('/tmp/tapeifs2') SUBTREE(*ALL)");
    for (const l of ['TAPLIB1', 'TAPLIB2', 'TAPLIB3']) await cmd(`DLTLIB LIB(${l})`);
    await cmd('DLTUSRPRF USRPRF(TAPUSR)');
    check('WRKCFGSTS: TAPVRT01 activo', /TAPVRT01\s+VARIED ON/.test(J(await cmd('WRKCFGSTS CFGTYPE(*DEV)'))));
    check('CRTIMGCLG TYPE(*TAP)', ok(await cmd("CRTIMGCLG IMGCLG(PRUEBACLG) DIR('/backup/prueba') TYPE(*TAP) CRTDIR(*YES)")));
    const e1 = await cmd('ADDIMGCLGE IMGCLG(PRUEBACLG) FROMFILE(*NEW) TOFILE(VOL001) IMGSIZ(100)');
    const e2 = await cmd('ADDIMGCLGE IMGCLG(PRUEBACLG) FROMFILE(*NEW) TOFILE(VOL002) IMGSIZ(100)');
    check('ADDIMGCLGE *NEW (dos volúmenes)', ok(e1) && ok(e2), [e1, e2]);
    check('sin catálogo cargado no hay volumen', errId(await cmd(`INZTAP DEV(${DEVT}) NEWVOL(VOL001) CHECK(*NO)`)) === 'CPF9898');
    check('LODIMGCLG', ok(await cmd(`LODIMGCLG IMGCLG(PRUEBACLG) DEV(${DEVT})`)));
    check('WRKIMGCLGE: VOL001 montado', /VOL001\s+VOL001.*|Mounted\s+VOL001/.test(J(await cmd('WRKIMGCLGE IMGCLG(PRUEBACLG)'))));
    check('INZTAP', ok(await cmd(`INZTAP DEV(${DEVT}) NEWVOL(VOL001) CHECK(*NO)`)));
    for (const l of ['TAPLIB1', 'TAPLIB2']) {
      await cmd(`CRTLIB LIB(${l})`);
      await sql(`CREATE TABLE ${l}.DATOS (ID INT NOT NULL PRIMARY KEY, NOMBRE VARCHAR(20))`);
      await sql(`INSERT INTO ${l}.DATOS VALUES (1, 'uno'), (2, 'dos'), (3, '${l}')`);
      await cmd(`CRTDTAARA DTAARA(${l}/AREA) TYPE(*CHAR) LEN(10) VALUE(${l})`);
    }
    const s1 = await cmd(`SAVLIB LIB(TAPLIB1 TAPLIB2) DEV(${DEVT})`);
    check('SAVLIB de dos bibliotecas a cinta: un archivo por biblioteca', ok(s1) && s1.messages.filter((m) => m.id === 'CPC3722').length === 2, s1);
    const s2 = await cmd(`SAVSECDTA DEV(${DEVT})`);
    const t1 = J(await cmd(`DSPTAP DEV(${DEVT})`));
    check('DSPTAP: TAPLIB1 (1), TAPLIB2 (2), QFILEUPR (3)', ok(s2) && /1\s+TAPLIB1\s+SAVLIB/.test(t1) && /2\s+TAPLIB2\s+SAVLIB/.test(t1) && /3\s+QFILEUPR\s+SAVSECDTA/.test(t1), t1);
    check('INZTAP CHECK(*YES) con archivos activos: error', /Active files exist/.test(J(await cmd(`INZTAP DEV(${DEVT}) CHECK(*YES)`))));
    const t2 = J(await cmd(`DSPTAP DEV(${DEVT}) SEQNBR(2) DATA(*SAVRST)`));
    check('DSPTAP DATA(*SAVRST): objetos del archivo', /DATOS\s+\*FILE/.test(t2) && /AREA\s+\*DTAARA/.test(t2), t2);
    await cmd('DLTLIB LIB(TAPLIB2)');
    const r1 = await cmd(`RSTLIB SAVLIB(TAPLIB2) DEV(${DEVT})`);
    const q1 = await sql('SELECT NOMBRE FROM TAPLIB2.DATOS WHERE ID = 3');
    check('RSTLIB desde cinta (busca la etiqueta TAPLIB2)', ok(r1) && q1.data && q1.data[0].NOMBRE === 'TAPLIB2', [r1, q1]);
    await cmd('CRTLIB LIB(TAPLIB3)');
    const r2 = await cmd(`RSTOBJ OBJ(*ALL) SAVLIB(TAPLIB1) DEV(${DEVT}) SEQNBR(1) RSTLIB(TAPLIB3)`);
    const q2 = await sql('SELECT COUNT(*) AS N FROM TAPLIB3.DATOS');
    check('RSTOBJ SEQNBR(1) RSTLIB(otra)', ok(r2) && q2.data && q2.data[0].N === 3, [r2, q2]);
    check('RSTLIB de una biblioteca que no está en el volumen: CPF3780', errId(await cmd(`RSTLIB SAVLIB(NOEXISTE) DEV(${DEVT})`)) === 'CPF3780');
    // SEQNBR(2): se escribe en la posición 2 y lo de detrás deja de existir
    await cmd(`SAVLIB LIB(TAPLIB1) DEV(${DEVT}) SEQNBR(2)`);
    const t3 = J(await cmd(`DSPTAP DEV(${DEVT})`));
    check('SAVLIB SEQNBR(2) sobrescribe el resto de la cinta', /2\s+TAPLIB1/.test(t3) && !/QFILEUPR/.test(t3), t3);
    // SAV / RST del IFS
    await cmd("MKDIR DIR('/tmp/tapeifs')");
    await api('PUT', '/ifs/tmp/tapeifs/a.txt', 'contenido A', SECOFR, 'text/plain');
    await cmd("CHGAUT OBJ('/tmp/tapeifs/a.txt') USER(*PUBLIC) DTAAUT(*R)");
    const sv = await cmd(`SAV DEV('/QSYS.LIB/${DEVT}.DEVD') OBJ(('/tmp/tapeifs'))`);
    check('SAV a cinta', ok(sv) && /objects saved/.test(J(sv)), sv);
    await cmd("RMVDIR DIR('/tmp/tapeifs') SUBTREE(*ALL)");
    const rs = await cmd(`RST DEV('/QSYS.LIB/${DEVT}.DEVD') OBJ(('/tmp/tapeifs'))`);
    const fa = await fetch(`${BASE}/api/v1/ifs/tmp/tapeifs/a.txt`, { headers: SECOFR }).then((r) => r.text());
    check('RST: contenido y autorizaciones del IFS', ok(rs) && fa === 'contenido A' && /\*PUBLIC\s+\*R\b/.test(J(await cmd("DSPAUT OBJ('/tmp/tapeifs/a.txt')"))), [rs, fa]);
    const rn = await cmd(`RST DEV('/QSYS.LIB/${DEVT}.DEVD') OBJ(('/tmp/tapeifs' *INCLUDE '/tmp/tapeifs2'))`);
    check('RST con nombre nuevo', ok(rn) && (await fetch(`${BASE}/api/v1/ifs/tmp/tapeifs2/a.txt`, { headers: SECOFR }).then((r) => r.text())) === 'contenido A', rn);
    await cmd('CRTSAVF FILE(TAPLIB1/IFSSAVF)');
    const sf = await cmd("SAV DEV('/QSYS.LIB/TAPLIB1.LIB/IFSSAVF.FILE') OBJ(('/tmp/tapeifs'))");
    check('SAV a un *SAVF y DSPSAVF', ok(sf) && /\/tmp\/tapeifs\/a\.txt/.test(J(await cmd('DSPSAVF FILE(TAPLIB1/IFSSAVF)'))), sf);
    check('SAVLIB *ALLUSR a un SAVF: no', errId(await cmd('SAVLIB LIB(*ALLUSR) DEV(*SAVF) SAVF(TAPLIB1/IFSSAVF)')) === 'CPF3782');
    // ENDOPT(*UNLOAD): se descarga el volumen y se monta el siguiente del catálogo
    const su = await cmd(`SAVLIB LIB(TAPLIB3) DEV(${DEVT}) ENDOPT(*UNLOAD)`);
    const ce = J(await cmd('WRKIMGCLGE IMGCLG(PRUEBACLG)'));
    check('ENDOPT(*UNLOAD) monta VOL002', ok(su) && /Mounted\s+VOL002/.test(ce) && /Loaded\s+VOL001/.test(ce), [su, ce]);
    check('LODIMGCLGE *MOUNT vuelve a VOL001', ok(await cmd('LODIMGCLGE IMGCLG(PRUEBACLG) IMGCLGIDX(1) OPTION(*MOUNT)')) && /Mounted\s+VOL001/.test(J(await cmd('WRKIMGCLGE IMGCLG(PRUEBACLG)'))));
    check('VOL(…) distinto del montado: error', /VOL002 expected/.test(J(await cmd(`SAVLIB LIB(TAPLIB3) DEV(${DEVT}) VOL(VOL002)`))));
    // SAVSYS y permisos
    await cmd("CRTUSRPRF USRPRF(TAPUSR) PASSWORD(TAPUSR) USRCLS(*USER)");
    check('SAVSYS sin *SAVSYS: no', /\*SAVSYS required/.test(J(await cmd(`SAVSYS DEV(${DEVT})`, auth('TAPUSR')))));
    const ss = await cmd(`SAVSYS DEV(${DEVT})`);
    const t4 = J(await cmd(`DSPTAP DEV(${DEVT})`));
    check('SAVSYS: QFILE, QFILEUPR y QFILEIOC desde el principio del volumen', ok(ss) && /1\s+QFILE\s+SAVSYS/.test(t4) && /2\s+QFILEUPR/.test(t4) && /3\s+QFILEIOC/.test(t4) && !/TAPLIB/.test(t4), [ss, t4]);
    const ru = await cmd(`RSTUSRPRF DEV(${DEVT}) USRPRF(TAPUSR)`);
    check('RSTUSRPRF desde el SAVSYS y RSTAUT sin SAVF', ok(ru) && ok(await cmd('RSTAUT USRPRF(TAPUSR)')), ru);
    check('VRYCFG *OFF con catálogo cargado: no', /unload it first/.test(J(await cmd(`VRYCFG CFGOBJ(${DEVT}) CFGTYPE(*DEV) STATUS(*OFF)`))));
    check('LODIMGCLG *UNLOAD', ok(await cmd('LODIMGCLG IMGCLG(PRUEBACLG) OPTION(*UNLOAD)')));
    check('DLTIMGCLG KEEP(*NO)', ok(await cmd('DLTIMGCLG IMGCLG(PRUEBACLG) KEEP(*NO)')));
    for (const l of ['TAPLIB1', 'TAPLIB2', 'TAPLIB3']) await cmd(`DLTLIB LIB(${l})`);
    for (const d of ['/tmp/tapeifs', '/tmp/tapeifs2', '/backup/prueba']) await cmd(`RMVDIR DIR('${d}') SUBTREE(*ALL)`);
    await cmd('DLTUSRPRF USRPRF(TAPUSR)');
  }

  if (!failed) await cmd(`DLTLIB LIB(${LIB})`);
  console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
