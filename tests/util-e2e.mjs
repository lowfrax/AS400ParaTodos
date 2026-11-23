// Prueba de extremo a extremo de los mandatos de uso diario:
//   OVRDBF/OVRPRTF/DLTOVR/DSPOVR (ámbito de nivel de llamada), archivos en spool (CPYSPLF, HLDSPLF, RLSSPLF,
//   CHGSPLFA, DLTSPLF), RUNSQLSTM (miembro fuente y archivo continuo), objetos (CRTDUPOBJ, RNMOBJ, MOVOBJ,
//   CHGOBJD, CPYSRCF, RNMM) y planificador de trabajos (ADDJOBSCDE, WRKJOBSCDE, HLDJOBSCDE, RLSJOBSCDE, RMVJOBSCDE).
// Ejecutar: node tests/util-e2e.mjs   (SCD=0 omite la espera a que el planificador lance el trabajo)
const BASE = process.env.API || 'http://localhost:10010';
const AUTH = { Authorization: `Basic ${Buffer.from(`${process.env.AS400_USER || 'QSECOFR'}:${process.env.AS400_PWD || 'QSECOFR'}`).toString('base64')}` };
const LIB = 'UTILTEST';
const LIB2 = 'UTILTST2';

async function api(method, path, body, raw, type = 'application/json') {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': type } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const t = await r.text();
  if (raw) return t;
  try { const j = JSON.parse(t); return Array.isArray(j) ? { status: r.status, list: j } : { status: r.status, ...j }; } catch { return { status: r.status, text: t }; }
}
const cmd = async (c, ok = true) => {
  const r = await api('POST', '/commands', { command: c });
  if (ok && r.status !== 200) throw new Error(`${c}\n${JSON.stringify(r, null, 1)}`);
  return r;
};
const sql = async (s) => api('POST', '/sql', { sql: s });
const rows = async (s) => { const r = await sql(s); return r.data || r.rows || []; };
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `  ${extra}` : ''}`); if (!cond) failed++; };
const put = (file, mbr, type, text) => api('PUT', `/sources/${LIB}/${file}/${mbr}?type=${type}`, { lines: text.split('\n') });
const dta = async (n, lib = LIB) => JSON.stringify(await cmd(`DSPDTAARA DTAARA(${lib}/${n})`, false));
const S = (x) => JSON.stringify(x).slice(0, 500);
async function spools(name) {
  const r = await api('GET', '/spool');
  const arr = r.list || Object.values(r).filter((x) => x && x.ID);
  return arr.filter((x) => x.NAME === name).sort((a, b) => Number(a.ID) - Number(b.ID));
}
const spoolText = async (id) => api('GET', `/spool/${id}`, undefined, true);

// Programa RPG que lista el archivo CLIENTES (descrito externamente) en QSYSPRT
const LISTAR = `**FREE
dcl-f CLIENTES disk usage(*input);
dcl-f QSYSPRT printer(132);
dcl-s linea char(132);
read CLIENTES;
dow not %eof(CLIENTES);
  linea = 'CLIENTE ' + NOMBRE;
  write QSYSPRT linea;
  read CLIENTES;
enddo;
*inlr = *on;`;

// CL que altera CLIENTES → CLIENTES2 y QSYSPRT → archivo en spool LISTA retenido, llama a LISTAR y luego
// borra las alteraciones; la segunda llamada debe leer el archivo original.
const PRINCIPAL = `PGM
  OVRDBF FILE(CLIENTES) TOFILE(${LIB}/CLIENTES2)
  OVRPRTF FILE(QSYSPRT) SPLFNAME(LISTA) USRDTA(OVERRIDE) HOLD(*YES)
  CALL PGM(${LIB}/LISTAR)
  DLTOVR FILE(*ALL)
  CALL PGM(${LIB}/LISTAR)
  CALL PGM(${LIB}/HIJO)
  CALL PGM(${LIB}/LISTAR)
ENDPGM`;
// Una alteración emitida en un programa llamado termina con él (OVRSCOPE(*CALLLVL))
const HIJO = `PGM
  OVRDBF FILE(CLIENTES) TOFILE(${LIB}/CLIENTES2)
ENDPGM`;

// CL que trabaja con su propio archivo en spool (JOB(*))
const SPOOLCL = `PGM
  OVRPRTF FILE(QSYSPRT) SPLFNAME(INFORME)
  CALL PGM(${LIB}/LISTAR)
  HLDSPLF FILE(INFORME) SPLNBR(*LAST)
  CHGSPLFA FILE(INFORME) SPLNBR(*LAST) USRDTA(CAMBIADO)
  CPYSPLF FILE(INFORME) TOFILE(${LIB}/SALIDA) SPLNBR(*LAST)
  CPYSPLF FILE(INFORME) TOFILE(*TOSTMF) SPLNBR(*LAST) TOSTMF('/tmp/utiltest_informe.txt') STMFOPT(*REPLACE)
  RLSSPLF FILE(INFORME) SPLNBR(*LAST)
  CALL PGM(${LIB}/LISTAR)
  DLTSPLF FILE(INFORME) SPLNBR(*LAST)
ENDPGM`;

const SQLSCRIPT = `-- Guion de RUNSQLSTM
CREATE TABLE ${LIB}.PRODUCTOS (ID INT NOT NULL PRIMARY KEY, NOMBRE VARCHAR(30), PRECIO DECIMAL(9, 2));
INSERT INTO ${LIB}.PRODUCTOS VALUES (1, 'Teclado; inalambrico', 25.50), (2, 'Raton', 9.99);
/* comentario de bloque; con punto y coma */
INSERT INTO ${LIB}.PRODUCTOS VALUES (3, 'Monitor', 150.00);
CREATE OR REPLACE PROCEDURE ${LIB}.SUBIR (IN PCT DECIMAL(5, 2))
LANGUAGE SQL
BEGIN
  UPDATE ${LIB}.PRODUCTOS SET PRECIO = PRECIO * (100 + PCT) / 100;
  IF PCT > 50 THEN
    SIGNAL SQLSTATE '75001' SET MESSAGE_TEXT = 'Demasiado';
  END IF;
END;
CALL ${LIB}.SUBIR(10);`;

(async () => {
  for (const l of [LIB, LIB2]) { await cmd(`RMVLIBLE LIB(${l})`, false); await cmd(`DLTLIB LIB(${l})`, false); await cmd(`CRTLIB LIB(${l})`); }
  await cmd(`DLTOVR FILE(*ALL)`, false);
  await cmd(`CRTSRCPF FILE(${LIB}/QCLSRC)`);
  await cmd(`CRTSRCPF FILE(${LIB}/QRPGLESRC)`);
  await cmd(`CRTSRCPF FILE(${LIB}/QSQLSRC)`);
  for (const t of ['CLIENTES', 'CLIENTES2']) {
    await sql(`CREATE TABLE ${LIB}.${t} (ID DECIMAL(5, 0) NOT NULL, NOMBRE CHAR(20) NOT NULL DEFAULT '')`);
  }
  await sql(`INSERT INTO ${LIB}.CLIENTES VALUES (1, 'ORIGINAL-A'), (2, 'ORIGINAL-B')`);
  await sql(`INSERT INTO ${LIB}.CLIENTES2 VALUES (1, 'ALTERADO-X')`);
  await sql(`CREATE TABLE ${LIB}.SALIDA (LINEA CHAR(132))`);
  await cmd(`CHGCURLIB CURLIB(${LIB})`, false);
  await cmd(`ADDLIBLE LIB(${LIB})`, false);

  await put('QRPGLESRC', 'LISTAR', 'RPGLE', LISTAR);
  await put('QCLSRC', 'PRINCIPAL', 'CLP', PRINCIPAL);
  await put('QCLSRC', 'HIJO', 'CLP', HIJO);
  await put('QCLSRC', 'SPOOLCL', 'CLP', SPOOLCL);
  const c1 = await cmd(`CRTBNDRPG PGM(${LIB}/LISTAR) SRCFILE(${LIB}/QRPGLESRC)`, false);
  check('CRTBNDRPG LISTAR', c1.status === 200, S(c1));
  for (const m of ['PRINCIPAL', 'HIJO', 'SPOOLCL']) {
    const r = await cmd(`CRTBNDCL PGM(${LIB}/${m}) SRCFILE(${LIB}/QCLSRC)`, false);
    check(`CRTBNDCL ${m}`, r.status === 200, S(r));
  }

  // ---------- Alteraciones ----------
  const before = (await spools('QSYSPRT')).length;
  const call = await cmd(`CALL PGM(${LIB}/PRINCIPAL)`, false);
  check('CALL PRINCIPAL', call.status === 200, S(call));
  const lista = (await spools('LISTA')).pop();
  check('OVRPRTF SPLFNAME: archivo en spool LISTA', !!lista, S(await spools('LISTA')));
  if (lista) {
    check('OVRPRTF HOLD(*YES) y USRDTA', lista.STATUS === 'HLD' && String(lista.USRDTA).trim() === 'OVERRIDE', S(lista));
    const t = await spoolText(lista.ID);
    check('OVRDBF TOFILE: el programa lee el archivo alterado', /ALTERADO-X/.test(t) && !/ORIGINAL/.test(t), t);
  }
  const prt = (await spools('QSYSPRT')).slice(before);
  check('DLTOVR + alteración de un programa llamado: dos listados QSYSPRT', prt.length === 2, S(prt));
  for (const [i, s] of prt.entries()) {
    const t = await spoolText(s.ID);
    check(`listado ${i + 1} sin alteración lee el archivo original`, /ORIGINAL-A/.test(t) && /ORIGINAL-B/.test(t) && !/ALTERADO/.test(t), t);
  }
  await cmd(`OVRDBF FILE(CLIENTES) TOFILE(${LIB}/CLIENTES2) OVRSCOPE(*JOB)`);
  const dov = await cmd(`DSPOVR`, false);
  check('DSPOVR muestra la alteración', /CLIENTES/.test(S(dov)) && /CLIENTES2/.test(S(dov)), S(dov));
  const job = await cmd(`CALL PGM(${LIB}/LISTAR)`, false);
  const lastPrt = (await spools('QSYSPRT')).pop();
  check('OVRSCOPE(*JOB) afecta a un programa llamado después', job.status === 200 && lastPrt && /ALTERADO-X/.test(await spoolText(lastPrt.ID)), S(job));
  await cmd(`DLTOVR FILE(CLIENTES)`);
  const none = await cmd(`DLTOVR FILE(CLIENTES)`, false);
  check('DLTOVR sin alteración: CPF9841', none.error && none.error.id === 'CPF9841', S(none));

  // ---------- Archivos en spool ----------
  const sp = await cmd(`CALL PGM(${LIB}/SPOOLCL)`, false);
  check('CALL SPOOLCL (HLDSPLF/CHGSPLFA/CPYSPLF/RLSSPLF/DLTSPLF)', sp.status === 200, S(sp));
  const sal = await rows(`SELECT LINEA FROM ${LIB}.SALIDA`);
  check('CPYSPLF a un archivo físico', sal.length === 2 && /CLIENTE ORIGINAL-A/.test(S(sal)), S(sal));
  const stmf = await api('GET', '/ifs/tmp/utiltest_informe.txt', undefined, true);
  check('CPYSPLF TOFILE(*TOSTMF)', /CLIENTE ORIGINAL-B/.test(stmf), stmf.slice(0, 200));
  const inf = await spools('INFORME');
  check('DLTSPLF borra solo el último INFORME; el primero queda liberado con USRDTA cambiado',
    inf.length >= 1 && inf[inf.length - 1].STATUS === 'RDY' && String(inf[inf.length - 1].USRDTA).trim() === 'CAMBIADO', S(inf));
  const bad = await cmd(`HLDSPLF FILE(NOEXISTE)`, false);
  check('HLDSPLF de un archivo inexistente: CPF3309', bad.error && bad.error.id === 'CPF3309', S(bad));

  // ---------- RUNSQLSTM ----------
  await put('QSQLSRC', 'CREAR', 'SQL', SQLSCRIPT);
  const rs = await cmd(`RUNSQLSTM SRCFILE(${LIB}/QSQLSRC) SRCMBR(CREAR) COMMIT(*NONE)`, false);
  check('RUNSQLSTM desde un miembro fuente', rs.status === 200, S(rs));
  const pr = await rows(`SELECT ID, NOMBRE, PRECIO FROM ${LIB}.PRODUCTOS ORDER BY ID`);
  check('RUNSQLSTM: literales y comentarios con ";" y procedimiento BEGIN…END', pr.length === 3 && /Teclado; inalambrico/.test(S(pr)) && Math.abs(Number(pr[1].PRECIO) - 10.98) < 0.011, S(pr));
  await api('PUT', '/ifs/tmp/utiltest.sql', `INSERT INTO ${LIB}.PRODUCTOS VALUES (4, 'Cable', 3.00);\nINSERT INTO ${LIB}.NOEXISTE VALUES (1);\n`, false, 'text/plain');
  const re = await cmd(`RUNSQLSTM SRCSTMF('/tmp/utiltest.sql') COMMIT(*CHG) ERRLVL(20)`, false);
  check('RUNSQLSTM con error de gravedad 30 > ERRLVL: SQL9010', re.error && re.error.id === 'SQL9010', S(re));
  const after = await rows(`SELECT COUNT(*) AS N FROM ${LIB}.PRODUCTOS`);
  check('RUNSQLSTM COMMIT(*CHG) deshace las sentencias si falla', Number(after[0] && after[0].N) === 3, S(after));

  // ---------- Objetos ----------
  const dup = await cmd(`CRTDUPOBJ OBJ(CLIENTES) FROMLIB(${LIB}) OBJTYPE(*FILE) TOLIB(${LIB2}) DATA(*YES)`, false);
  check('CRTDUPOBJ de un archivo físico con datos', dup.status === 200 && (await rows(`SELECT * FROM ${LIB2}.CLIENTES`)).length === 2, S(dup));
  const dup2 = await cmd(`CRTDUPOBJ OBJ(CLIENTES) FROMLIB(${LIB}) OBJTYPE(*FILE) TOLIB(${LIB2})`, false);
  check('CRTDUPOBJ sobre un objeto existente: CPF2130', dup2.error && dup2.error.id === 'CPF2130', S(dup2));
  const dsrc = await cmd(`CRTDUPOBJ OBJ(QRPGLESRC) FROMLIB(${LIB}) OBJTYPE(*FILE) TOLIB(${LIB2})`, false);
  const copied = await api('GET', `/sources/${LIB2}/QRPGLESRC/LISTAR`);
  check('CRTDUPOBJ de un archivo fuente copia los miembros', dsrc.status === 200 && /CLIENTE/.test(S(copied)), S(dsrc));
  const dpgm = await cmd(`CRTDUPOBJ OBJ(LISTAR) FROMLIB(${LIB}) OBJTYPE(*PGM) TOLIB(${LIB2}) NEWOBJ(LISTAR2)`, false);
  check('CRTDUPOBJ de un programa con nombre nuevo', dpgm.status === 200, S(dpgm));
  const cpgm = await cmd(`CALL PGM(${LIB2}/LISTAR2)`, false);
  check('el programa duplicado se ejecuta', cpgm.status === 200, S(cpgm));
  const rn = await cmd(`RNMOBJ OBJ(${LIB2}/CLIENTES) OBJTYPE(*FILE) NEWOBJ(CLIVIEJO)`, false);
  check('RNMOBJ de un archivo físico', rn.status === 200 && (await rows(`SELECT * FROM ${LIB2}.CLIVIEJO`)).length === 2, S(rn));
  const mv = await cmd(`MOVOBJ OBJ(${LIB2}/CLIVIEJO) OBJTYPE(*FILE) TOLIB(${LIB})`, false);
  check('MOVOBJ de un archivo físico', mv.status === 200 && (await rows(`SELECT * FROM ${LIB}.CLIVIEJO`)).length === 2, S(mv));
  const gone = await cmd(`CHKOBJ OBJ(${LIB2}/CLIVIEJO) OBJTYPE(*FILE)`, false);
  check('MOVOBJ: ya no está en la biblioteca de origen', gone.error && gone.error.id === 'CPF9801', S(gone));
  await cmd(`CHGOBJD OBJ(${LIB}/CLIVIEJO) OBJTYPE(*FILE) TEXT('Clientes historicos')`);
  const od = await cmd(`DSPOBJD OBJ(${LIB}/CLIVIEJO) OBJTYPE(*FILE)`, false);
  const odr = await rows(`SELECT TEXT FROM QSYS.OBJECTS WHERE LIB = '${LIB}' AND NAME = 'CLIVIEJO'`);
  check('CHGOBJD cambia el texto', /Clientes historicos/.test(S(odr)) || /Clientes historicos/.test(S(od)), S(odr));
  const cs = await cmd(`CPYSRCF FROMFILE(${LIB}/QCLSRC) TOFILE(${LIB2}/QRPGLESRC) FROMMBR(PRINC*)`, false);
  const csm = await api('GET', `/sources/${LIB2}/QRPGLESRC/PRINCIPAL`);
  check('CPYSRCF con nombre genérico', cs.status === 200 && /OVRDBF/.test(S(csm)), S(cs));
  const rm = await cmd(`RNMM FILE(${LIB2}/QRPGLESRC) MBR(PRINCIPAL) NEWMBR(PRINCOPIA)`, false);
  const rmm = await api('GET', `/sources/${LIB2}/QRPGLESRC/PRINCOPIA`);
  check('RNMM', rm.status === 200 && /OVRDBF/.test(S(rmm)), S(rm));

  // ---------- Planificador de trabajos ----------
  await cmd(`CRTDTAARA DTAARA(${LIB}/SCD) TYPE(*CHAR) LEN(20)`);
  await cmd(`RMVJOBSCDE JOB(UTILSCD*) ENTRYNBR(*ALL)`, false);
  const ad = await cmd(`ADDJOBSCDE JOB(UTILSCD) CMD(CHGDTAARA DTAARA(${LIB}/SCD) VALUE(EJECUTADO)) FRQ(*ONCE) SCDDATE(*CURRENT) SCDTIME(*CURRENT)`, false);
  check('ADDJOBSCDE', ad.status === 200, S(ad));
  const ad2 = await cmd(`ADDJOBSCDE JOB(UTILSCD2) CMD(DSPLIBL) FRQ(*WEEKLY) SCDDAY(*MON *FRI) SCDTIME('23:30:00')`, false);
  check('ADDJOBSCDE semanal', ad2.status === 200, S(ad2));
  const wk = await cmd(`WRKJOBSCDE`, false);
  check('WRKJOBSCDE lista las entradas', /UTILSCD /.test(S(wk)) && /UTILSCD2/.test(S(wk)) && /\*WEEKLY/.test(S(wk)), S(wk));
  await cmd(`HLDJOBSCDE JOB(UTILSCD2)`);
  const scdText = async (j) => ((await cmd(`WRKJOBSCDE JOB(${j})`, false)).messages || []).map((m) => m.text).join('\n');
  const h = await scdText('UTILSCD2');
  check('HLDJOBSCDE', /UTILSCD2\s+\d{6}\s+HLD/.test(h), h);
  await cmd(`RLSJOBSCDE JOB(UTILSCD2)`);
  const rl = await scdText('UTILSCD2');
  check('RLSJOBSCDE', /UTILSCD2\s+\d{6}\s+SCD/.test(rl), rl);
  await cmd(`RMVJOBSCDE JOB(UTILSCD2)`);
  const rmv = await cmd(`RMVJOBSCDE JOB(UTILSCD2)`, false);
  check('RMVJOBSCDE; segunda vez CPF1628', rmv.error && rmv.error.id === 'CPF1628', S(rmv));
  if (process.env.SCD !== '0') {
    let ran = false;
    for (let i = 0; i < 40 && !ran; i++) { await new Promise((r) => setTimeout(r, 5000)); ran = /EJECUTADO/.test(await dta('SCD')); }
    check('el planificador (QSYSSCD) lanza el trabajo a su hora', ran, await dta('SCD'));
    const left = await cmd(`WRKJOBSCDE JOB(UTILSCD)`, false);
    check('una entrada *ONCE desaparece tras ejecutarse', ran && !/UTILSCD /.test(S(left)), S(left));
  }

  await cmd(`RMVJOBSCDE JOB(UTILSCD*) ENTRYNBR(*ALL)`, false);
  await cmd(`CHGCURLIB CURLIB(*CRTDFT)`, false);
  if (!failed) for (const l of [LIB, LIB2]) { await cmd(`RMVLIBLE LIB(${l})`, false); await cmd(`DLTLIB LIB(${l})`, false); }
  console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
