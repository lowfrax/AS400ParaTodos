// Prueba del depurador (STRDBG) por el terminal 5250: punto de interrupción condicional, EVAL, asignación,
// paso a paso (F10), F6 en la línea del cursor, F3=Terminar programa, depuración de CL y ENDDBG.
// Ejecutar: node tests/dbg-e2e.mjs
import { Term } from './client.mjs';

const BASE = process.env.API || 'http://localhost:10010';
const AUTH = { Authorization: `Basic ${Buffer.from('QSECOFR:QSECOFR').toString('base64')}` };
const LIB = 'DBGTEST';
const show = process.env.SHOW === '1';
async function api(method, path, body) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { ...AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, text: t }; }
}
const cmd = (c) => api('POST', '/commands', { command: c });
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `\n${extra}` : ''}`); if (!cond) failed++; };

const RPG = `**FREE
dcl-s i int(10);
dcl-s total packed(9:2);
dcl-s nombre char(10) inz('ANA');
for i = 1 to 5;
  total += i * 10;
endfor;
nombre = 'FIN';
dsply %char(total);
*inlr = *on;`;
const CL = `PGM
  DCL VAR(&A) TYPE(*CHAR) LEN(10) VALUE('UNO')
  DCL VAR(&N) TYPE(*DEC) LEN(5 0) VALUE(7)
  CHGVAR VAR(&A) VALUE('DOS')
  CHGVAR VAR(&N) VALUE(&N + 1)
  SNDPGMMSG MSG(&A)
ENDPGM`;

await cmd(`DLTLIB LIB(${LIB})`);
await cmd(`CRTLIB LIB(${LIB})`);
await cmd(`CRTSRCPF FILE(${LIB}/QRPGLESRC)`);
await cmd(`CRTSRCPF FILE(${LIB}/QCLSRC)`);
await api('PUT', `/sources/${LIB}/QRPGLESRC/CALCULA?type=RPGLE`, { lines: RPG.split('\n') });
await api('PUT', `/sources/${LIB}/QCLSRC/CLDBG?type=CLP`, { lines: CL.split('\n') });
check('CRTBNDRPG DBGVIEW(*SOURCE)', (await cmd(`CRTBNDRPG PGM(${LIB}/CALCULA) SRCFILE(${LIB}/QRPGLESRC) DBGVIEW(*SOURCE)`)).status === 200);
check('CRTBNDCL DBGVIEW(*SOURCE)', (await cmd(`CRTBNDCL PGM(${LIB}/CLDBG) SRCFILE(${LIB}/QCLSRC) DBGVIEW(*SOURCE)`)).status === 200);
await cmd(`CRTBNDRPG PGM(${LIB}/NODBG) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(CALCULA) DBGVIEW(*NONE)`);

const t = new Term(process.env.WS || 'ws://localhost:5250/ws');
await t.connect();
await t.waitFor(/Sign On/, 120000);
await t.send('ENTER', { USER: 'QSECOFR', PWD: 'QSECOFR' });
await t.waitFor(/Main Menu/);
const dump = (l) => { if (show) console.log(`---- ${l}\n${t.text()}`); };
const msg = () => t.screen.msg || '';
try {
  await t.cmd(`ADDLIBLE LIB(${LIB})`);
  await t.cmd(`STRDBG PGM(${LIB}/NODBG)`);
  check('STRDBG de un programa sin datos de depuración (DBGVIEW(*NONE)) se rechaza', /no debug data|DBGVIEW/.test(msg()), msg());
  await t.cmd(`STRDBG PGM(${LIB}/CALCULA) UPDPROD(*YES)`);
  await t.waitFor(/Display Module Source/);
  dump('dspmodsrc');
  check('STRDBG muestra el fuente del programa', /CALCULA/.test(t.text()) && /total \+= i \* 10/.test(t.text()), t.text());
  await t.send('ENTER', { DBG: 'BREAK 6 WHEN i = 3' });
  check('BREAK con condición WHEN', /Breakpoint added to line 6 \(conditional/.test(msg()), msg());
  // F6 sobre la línea 9 (fila 3 + 8)
  const row9 = t.text().split('\n').findIndex((l) => /^\s+9 /.test(l.slice(1)));
  await t.send('F6', {}, { cursor: [row9 + 1, 10] });
  check('F6 añade un punto de interrupción en la línea del cursor', /Breakpoint added to line 9/.test(msg()), `${msg()} fila ${row9}`);
  await t.send('F12');
  await t.waitFor(/Main Menu|Debug mode started/);
  await t.cmd('CALL CALCULA');
  await t.waitFor(/Breakpoint at line 6/);
  dump('break');
  check('se detiene en la línea 6 solo cuando i = 3', /^>\s*6/m.test(t.text().split('\n').map((l) => l.slice(1)).join('\n')), t.text());
  await t.send('ENTER', { DBG: 'EVAL i' });
  check('EVAL i = 3', /I = 3/.test(msg()), msg());
  await t.send('ENTER', { DBG: 'EVAL total' });
  check('EVAL total = 30 (10 + 20)', /TOTAL = 30/.test(msg()), msg());
  await t.send('ENTER', { DBG: 'EVAL total * 2 + 1' });
  check('EVAL de una expresión', /= 61/.test(msg()), msg());
  await t.send('F10');
  await t.waitFor(/Step completed/);
  await t.send('ENTER', { DBG: 'EVAL i' });
  check('F10 (paso): siguiente sentencia con i = 4', /I = 4/.test(msg()), msg());
  await t.send('ENTER', { DBG: 'EVAL total = 1000' });
  check('EVAL asignación', /TOTAL = 1000/.test(msg()), msg());
  await t.send('ENTER', { DBG: 'CLEAR 6' });
  await t.send('F12');
  await t.waitFor(/Breakpoint at line 9/);
  await t.send('ENTER', { DBG: 'EVAL nombre' });
  check('el segundo punto de interrupción (F6) y EVAL de un CHAR', /NOMBRE = 'FIN/.test(msg()), msg());
  await t.send('F12');
  await t.waitFor(/Display Program Messages|1090/);
  dump('dsply');
  check('el programa sigue con el valor asignado (1000 + 40 + 50)', /1090\.00/.test(t.text()), t.text());
  await t.send('ENTER');
  await t.waitFor(/Main Menu/);
  // F3 = terminar el programa
  await t.cmd('CALL CALCULA');
  await t.waitFor(/Breakpoint at line 9/);
  await t.send('F3');
  await t.waitFor(/Main Menu/);
  check('F3 termina el programa en el punto de interrupción', !/1090|150\.00/.test(t.text()), t.text());
  await t.cmd('ENDDBG');
  check('ENDDBG', /Debug mode ended/.test(msg()), msg());
  // CL
  await t.cmd(`STRDBG PGM(${LIB}/CLDBG)`);
  await t.waitFor(/Display Module Source/);
  await t.send('ENTER', { DBG: 'BREAK 5' });
  await t.send('F12');
  await t.cmd('CALL CLDBG');
  await t.waitFor(/Breakpoint at line 5/);
  await t.send('ENTER', { DBG: 'EVAL &A' });
  check('CL: EVAL &A en el punto de interrupción', /&A = 'DOS/.test(msg()), msg());
  await t.send('ENTER', { DBG: 'EVAL &N' });
  check('CL: EVAL &N', /&N = 7/.test(msg()), msg());
  await t.send('ENTER', { DBG: "EVAL &A = 'TRES'" });
  await t.send('F12');
  await t.waitFor(/Main Menu|TRES/);
  check('CL: la asignación en el depurador cambia la ejecución', /TRES/.test(t.text()), t.text());
  await t.cmd('ENDDBG');
  await t.cmd('CALL CALCULA');
  await t.waitFor(/Display Program Messages/);
  check('sin depuración el programa no se detiene', /150\.00/.test(t.text()), t.text());
  await t.send('ENTER');

  // DBGVIEW(*STMT): sin vista de fuente, se trabaja con números de sentencia
  await api('PUT', `/sources/${LIB}/QRPGLESRC/CALCVIEW?type=RPGLE`, { lines: RPG.split('\n') });
  await cmd(`CRTBNDRPG PGM(${LIB}/CALCSTMT) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(CALCVIEW)`);
  await t.cmd(`STRDBG PGM(${LIB}/CALCSTMT)`);
  await t.waitFor(/Display Module Source/);
  check('DBGVIEW(*STMT) por omisión: no se muestra el fuente', /Source is not available/.test(t.text()) && !/total \+= i/.test(t.text()), t.text());
  await t.send('ENTER', { DBG: 'BREAK 6' });
  await t.send('F12');
  await t.cmd('CALL CALCSTMT');
  await t.waitFor(/Stopped at statement 6/);
  await t.send('ENTER', { DBG: 'EVAL i' });
  check('*STMT: BREAK por número de sentencia y EVAL', /I = 1\b/.test(msg()), msg());
  await t.send('ENTER', { DBG: 'CLEAR 6' });
  await t.send('F12');
  await t.waitFor(/Display Program Messages/);
  await t.send('ENTER');
  await t.cmd('ENDDBG');
  // *LIST guarda el listado en el programa; *SOURCE lee el miembro (y avisa si cambió después de compilar)
  await cmd(`CRTBNDRPG PGM(${LIB}/CALCLIST) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(CALCVIEW) DBGVIEW(*LIST)`);
  await cmd(`CRTBNDRPG PGM(${LIB}/CALCSRC) SRCFILE(${LIB}/QRPGLESRC) SRCMBR(CALCVIEW) DBGVIEW(*SOURCE)`);
  await new Promise((r) => setTimeout(r, 1100));
  await api('PUT', `/sources/${LIB}/QRPGLESRC/CALCVIEW?type=RPGLE`, { lines: ['**FREE', '// MIEMBRO CAMBIADO', ...RPG.split('\n').slice(1)] });
  await t.cmd(`STRDBG PGM(${LIB}/CALCLIST)`);
  await t.waitFor(/Display Module Source/);
  check('*LIST: el listado de la compilación aunque el miembro cambie', !/MIEMBRO CAMBIADO/.test(t.text()) && /dcl-s i int/.test(t.text()), t.text());
  await t.send('F12');
  await t.cmd('ENDDBG');
  await t.cmd(`STRDBG PGM(${LIB}/CALCSRC)`);
  await t.waitFor(/Display Module Source/);
  check('*SOURCE: el miembro actual, con aviso de que cambió', /MIEMBRO CAMBIADO/.test(t.text()) && /changed after the program was created/.test(t.text()), t.text());
  await t.send('F12');
  await t.cmd('ENDDBG');

  // STRSRVJOB: depurar un trabajo por lotes desde esta estación de trabajo
  await t.cmd(`SBMJOB CMD(CALL PGM(${LIB}/CALCULA)) JOB(DBGBATCH) HOLD(*YES)`);
  const jm = /(\d{6})\/(\w+)\/(DBGBATCH)/.exec(msg());
  check('SBMJOB HOLD(*YES)', !!jm, msg());
  const jobq = jm ? `${jm[1]}/${jm[2]}/${jm[3]}` : '';
  await t.cmd(`STRSRVJOB JOB(${jobq})`);
  check('STRSRVJOB de un trabajo retenido en la cola', /Service job started/.test(msg()), msg());
  await t.cmd(`STRDBG PGM(${LIB}/CALCULA)`);
  await t.waitFor(/Display Module Source/);
  await t.send('ENTER', { DBG: 'BREAK 8' });
  await t.send('F12');
  await t.cmd(`RLSJOB JOB(${jobq})`);
  await t.waitFor(/Breakpoint at line 8/, 30000);
  check('al llegar al punto de interrupción, el trabajo por lotes interrumpe esta pantalla', new RegExp(`Job ${jm && jm[1]}`).test(t.text()), t.text());
  await t.send('ENTER', { DBG: 'EVAL total' });
  check('EVAL de una variable del trabajo por lotes', /TOTAL = 150/.test(msg()), msg());
  await t.send('F12');
  await t.waitFor(/Main Menu|Selection or command/);
  await new Promise((r) => setTimeout(r, 1500));
  const jobs = await api('GET', '/jobs');
  check('el trabajo por lotes continúa y termina', !JSON.stringify(jobs).includes(`"${jm && jm[1]}`), JSON.stringify(jobs).slice(0, 300));
  await t.cmd('ENDSRVJOB');
  check('ENDSRVJOB', /Service job ended/.test(msg()), msg());
} catch (e) { failed++; console.log(`FAIL ${e.message}`); }
t.close();
if (!failed) await cmd(`DLTLIB LIB(${LIB})`);
console.log(failed ? `\n${failed} FALLOS` : '\nTodo correcto');
process.exit(failed ? 1 : 0);
