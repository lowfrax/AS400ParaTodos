// Prueba de punta a punta contra un sistema en marcha (npm run dev o docker compose up).
// Uso: node tests/e2e.mjs [ws://host:5250/ws]
import { Term } from './client.mjs';

const url = process.argv[2] || 'ws://localhost:5250/ws';
const show = process.env.SHOW === '1';
let failures = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.log(`  FALLO ${name}\n${e.message}`); }
};

const t = new Term(url);
await t.connect();
await t.waitFor(/Sign On/, 120000);
const dump = (label) => { if (show) console.log(`---- ${label}\n${t.text()}`); };

await step('Sign On rechaza contraseña incorrecta', async () => {
  await t.send('ENTER', { USER: 'DEMO', PWD: 'MALA' });
  if (!/Password not correct/.test(t.text())) throw new Error(t.text());
});
await step('Sign On correcto muestra IBM i Main Menu', async () => {
  await t.send('ENTER', { USER: 'DEMO', PWD: 'DEMO' });
  await t.waitFor(/IBM i Main Menu/);
  dump('MAIN');
});
await step('Mandato inexistente → CPD0030', async () => {
  await t.cmd('XYZZY');
  if (!/Command XYZZY in library \*LIBL not found/.test(t.text())) throw new Error(t.text());
});
await step('DSPLIBL', async () => {
  await t.cmd('DSPLIBL');
  await t.waitFor(/Display Library List/);
  if (!/DEMOLIB\s+CUR/.test(t.text())) throw new Error(t.text());
  dump('DSPLIBL');
  await t.send('F3');
});
await step('WRKACTJOB muestra el trabajo interactivo', async () => {
  await t.cmd('WRKACTJOB');
  await t.waitFor(/Work with Active Jobs/);
  dump('WRKACTJOB');
  if (!/QBATCH/.test(t.text())) throw new Error(t.text());
  await t.send('F3');
});
await step('CALL HELLO con DSPLY y respuesta', async () => {
  await t.cmd('CALL HELLO');
  await t.waitFor(/Display Program Messages/);
  await t.send('ENTER', { REPLY: 'Ada' });
  await t.waitFor(/Hola, Ada!/);
  dump('HELLO');
  await t.send('ENTER');
  await t.waitFor(/Main Menu/);
});
await step('CALL CUSTINQ (EXFMT + CHAIN + ERRMSG)', async () => {
  await t.cmd('CALL CUSTINQ');
  await t.waitFor(/Customer Inquiry/);
  await t.send('ENTER', { CUSTNO: '999' });
  await t.waitFor(/Customer not found/);
  await t.send('ENTER', { CUSTNO: '5' });
  await t.waitFor(/COMERCIAL ANDINA/);
  dump('CUSTINQ detail');
  if (!/exceeds credit limit/.test(t.text())) throw new Error('falta indicador 50:\n' + t.text());
  await t.send('F12');
  await t.waitFor(/Type customer number/);
  await t.send('F3');
  await t.waitFor(/Main Menu/);
});
await step('CALL CUSTSFL (subarchivo, paginación, opción 5)', async () => {
  await t.cmd('CALL CUSTSFL');
  await t.waitFor(/Work with Customers/);
  dump('CUSTSFL');
  if (!/More\.\.\./.test(t.text())) throw new Error('esperaba More...\n' + t.text());
  await t.send('PAGEDOWN');
  await t.waitFor(/SERVICIOS ROCHESTER/);
  if (!/Bottom/.test(t.text())) throw new Error('esperaba Bottom\n' + t.text());
  const optField = t.screen.fields.find((f) => /^SFL_\d+_OPT$/.test(f.n));
  await t.send('ENTER', { [optField.n]: '5' });
  await t.waitFor(/Display Program Messages/);
  dump('CUSTSFL opt 5');
  await t.send('ENTER');
  await t.waitFor(/Work with Customers/);
  await t.send('F3');
  await t.waitFor(/Main Menu/);
});
await step('CALL CUSTLIST (SQL embebido → spool)', async () => {
  await t.cmd('CALL CUSTLIST');
  await t.waitFor(/Listado generado: 20 clientes/);
  await t.send('ENTER');
  await t.waitFor(/Main Menu/);
});
await step('WRKSPLF y visualizar QSYSPRT', async () => {
  await t.cmd('WRKSPLF');
  await t.waitFor(/Work with All Spooled Files/);
  const row = t.text().split('\n').findIndex((l) => /QSYSPRT/.test(l));
  if (row < 0) throw new Error(t.text());
  const f = t.screen.fields.find((x) => x.r === row + 1 && /^OPT/.test(x.n));
  await t.send('ENTER', { [f.n]: '5' });
  await t.waitFor(/LISTADO DE CLIENTES/);
  dump('DSPSPLF');
  await t.send('F3');
  await t.send('F3');
  await t.waitFor(/Main Menu/);
});
await step('FIXEDCALC (RPG en columnas fijas)', async () => {
  await t.cmd('CALL FIXEDCALC');
  await t.waitFor(/Suma 1\.\.10 = 55\.00/);
  await t.send('ENTER');
});
await step('STRSQL SELECT → Display Data', async () => {
  await t.cmd('STRSQL');
  await t.waitFor(/Enter SQL Statements/);
  await t.send('ENTER', { L0: 'select custno, name, balance from customer where balance > 5000 order by balance desc' });
  await t.waitFor(/Display Data/);
  dump('Display Data');
  if (!/BIG BLUE SYSTEMS/.test(t.text())) throw new Error(t.text());
  await t.send('F3');
  await t.send('ENTER', { L0: "insert into items values (200, 'Prueba E2E', 1.5, 3)" });
  await t.waitFor(/1 rows inserted in ITEMS in DEMOLIB/);
  await t.send('ENTER', { L0: 'delete from items where itemno = 200' });
  await t.send('F3');
  await t.waitFor(/Main Menu/);
});
await step('CRTLIB + CRTSRCPF + SEU + CRTBNDRPG + CALL', async () => {
  await t.cmd('DLTLIB E2ELIB');
  await t.cmd("CRTLIB LIB(E2ELIB) TEXT('Prueba e2e')");
  if (!/Library E2ELIB created/.test(t.text())) throw new Error(t.text());
  await t.cmd('CRTSRCPF FILE(E2ELIB/QRPGLESRC)');
  await t.cmd('STRSEU SRCFILE(E2ELIB/QRPGLESRC) SRCMBR(SUMA) TYPE(RPGLE)');
  await t.waitFor(/Beginning of data/);
  // Inserta 3 líneas sobre "Beginning of data" con la orden de línea I3
  await t.send('ENTER', { S0: 'I3' });
  const ins = t.screen.fields.filter((f) => /^D\d+$/.test(f.n)).slice(0, 3).map((f) => f.n);
  await t.send('ENTER', { [ins[0]]: '**FREE', [ins[1]]: "dsply ('Suma: ' + %char(%int(20) + 22));", [ins[2]]: '*inlr = *on;' });
  dump('SEU');
  await t.send('F3');
  await t.waitFor(/Change\/create member/);
  await t.send('ENTER');
  await t.waitFor(/Member SUMA file QRPGLESRC in E2ELIB changed with 3 records/);
  await t.cmd('CRTBNDRPG PGM(E2ELIB/SUMA) SRCFILE(E2ELIB/QRPGLESRC)');
  if (!/Program SUMA placed in library E2ELIB/.test(t.text())) throw new Error(t.text());
  await t.cmd('CALL E2ELIB/SUMA');
  await t.waitFor(/Suma: 42/);
  await t.send('ENTER');
  await t.waitFor(/Main Menu/);
});
await step('Error de compilación RNF7030 en el listado', async () => {
  await t.cmd('STRSEU SRCFILE(E2ELIB/QRPGLESRC) SRCMBR(MALO) TYPE(RPGLE)');
  await t.waitFor(/Beginning of data/);
  await t.send('ENTER', { S0: 'I2' });
  const ins = t.screen.fields.filter((f) => /^D\d+$/.test(f.n)).slice(0, 2).map((f) => f.n);
  await t.send('ENTER', { [ins[0]]: '**FREE', [ins[1]]: 'x = 1; *inlr = *on;' });
  await t.send('F3');
  await t.send('ENTER');
  await t.cmd('CRTBNDRPG PGM(E2ELIB/MALO) SRCFILE(E2ELIB/QRPGLESRC)');
  if (!/not created|Compilation stopped/.test(t.text())) throw new Error(t.text());
});
await step('Error no monitorizado → consulta RNQ0102 y CEE9901', async () => {
  await t.cmd('STRSEU SRCFILE(E2ELIB/QRPGLESRC) SRCMBR(DIVCERO) TYPE(RPGLE)');
  await t.waitFor(/Beginning of data/);
  await t.send('ENTER', { S0: 'I3' });
  const ins = t.screen.fields.filter((f) => /^D\d+$/.test(f.n)).slice(0, 3).map((f) => f.n);
  await t.send('ENTER', { [ins[0]]: '**FREE', [ins[1]]: 'dcl-s n int(10); dcl-s z int(10);', [ins[2]]: 'n = 10 / z; *inlr = *on;' });
  await t.send('F3');
  await t.send('ENTER');
  await t.cmd('CRTBNDRPG PGM(E2ELIB/DIVCERO) SRCFILE(E2ELIB/QRPGLESRC)');
  await t.cmd('CALL E2ELIB/DIVCERO');
  await t.waitFor(/divide by zero \(C G D F\)/);
  dump('RNQ');
  await t.send('ENTER', { REPLY: 'C' });
  await t.waitFor(/RNX0102 unmonitored by DIVCERO/);
});
await step('SBMJOB del CL NIGHTLY → mensaje en cola (MW)', async () => {
  await t.cmd('SBMJOB CMD(CALL PGM(DEMOLIB/NIGHTLY))');
  if (!/submitted to job queue QBATCH/.test(t.text())) throw new Error(t.text());
  await new Promise((r) => setTimeout(r, 9000));
  await t.cmd('DSPMSG');
  await t.waitFor(/Display Messages/);
  dump('DSPMSG');
  if (!/completed normally/.test(t.text())) throw new Error(t.text());
  await t.send('F3');
});
await step('Prompter F4 de CRTLIB', async () => {
  await t.cmd('CRTLIB', 'F4');
  await t.waitFor(/Create Library \(CRTLIB\)/);
  dump('PROMPT');
  await t.send('ENTER', { LIB: 'E2EPRM', TEXT: 'Desde prompt' });
  await t.waitFor(/Library E2EPRM created/);
  await t.cmd('DLTLIB E2EPRM');
});
await step('CRTPF de un archivo existente → CPF7302 y CPF5813 en DSPJOBLOG', async () => {
  await t.cmd('CRTPF FILE(DEMOLIB/CUSTOMER) SRCFILE(DEMOLIB/QDDSSRC)');
  await t.waitFor(/File CUSTOMER not created in library DEMOLIB/);
  await t.cmd('DSPJOBLOG');
  await t.waitFor(/Display Job Log/);
  await t.send('F10');
  await t.waitFor(/File CUSTOMER in library DEMOLIB already exists/);
  dump('DSPJOBLOG');
  await t.send('F3');
  await t.waitFor(/Main Menu/);
});
await step('SIGNOFF vuelve a Sign On', async () => {
  await t.cmd('DLTLIB E2ELIB');
  await t.cmd('SIGNOFF');
  await t.waitFor(/Sign On/);
});
t.close();
console.log(failures ? `\n${failures} prueba(s) fallaron` : '\nTodas las pruebas pasaron');
process.exit(failures ? 1 : 0);
