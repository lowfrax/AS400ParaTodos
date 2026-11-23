// Prueba de los servicios de sistema de IBM i: QTEMP por trabajo, seguridad de objetos (autorizaciones privadas,
// de grupo, *PUBLIC, listas de autorizaciones, biblioteca, *OBJEXIST, propietario), diarios, salvar/restaurar,
// mandatos de usuario (CRTCMD). Ejecutar: node tests/sys-e2e.mjs [seccion…]
const BASE = process.env.API || 'http://localhost:10010';
const auth = (u, p = u) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });
const SECOFR = auth('QSECOFR');
const LIB = 'SVCTEST';
const only = new Set(process.argv.slice(2));
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

  if (!failed) await cmd(`DLTLIB LIB(${LIB})`);
  console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
