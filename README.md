# AS400 para Todos

Clon educativo de **IBM i (AS/400)** que funciona en el navegador:

- **Terminal 5250 web** al estilo de *IBM i Access Client Solutions* (pantalla verde de 24×80, OIA, teclas AID, *X SYSTEM*/*X II*, sonidos de teclado y alarma, modo monitor CRT IBM 3477).
- **Compilador e intérprete de RPG IV** (formato libre `**FREE` y columnas fijas H/F/D/C/P), **CL** (CLLE) y **DDS** (archivos físicos y de pantalla con subarchivos).
- **IBM Db2 en Docker** como base de datos: bibliotecas = esquemas, archivos físicos = tablas, SQL embebido y acceso por registro (READ/CHAIN/SETLL…).
- **Un panel web en tiempo real por servicio** (Server-Sent Events).

> IBM, IBM i, AS/400, Db2 y 5250 son marcas de IBM Corp. Este proyecto no está afiliado a IBM ni contiene código de IBM. Db2 Community Edition se descarga desde el registro oficial de IBM y se rige por su propia licencia.

---

## Arquitectura

```
 Navegador ── WebSocket /ws ──► ibmi-core :5250 ──HTTP──► rpg-compiler :5251
 (emulador 5250)                 │  sesiones, trabajos,       │  CRTBNDRPG, CRTBNDCL,
                                 │  mandatos CL, intérprete   │  CRTPF, CRTDSPF
                                 │  RPG/CL, spool, mensajes   │
                                 └──────HTTP──────► db2-gateway :5252 ◄──┘
                                                    │  SQL, catálogo, log en vivo
                                                    └──ibm_db──► IBM Db2 :50000
```

| Servicio | Puerto | Qué hace | Panel en tiempo real |
|---|---|---|---|
| `ibmi-core` | 5250 | IPL, Sign On, menús, ~70 mandatos CL, trabajos (WRKACTJOB), spool, colas de mensajes, ejecución de programas RPG/CL, archivos de pantalla | `http://localhost:5250/dashboard/` (sesiones, trabajos, CPU, actividad) |
| `rpg-compiler` | 5251 | Compila RPG IV / CL / DDS a un IR, valida nombres contra el catálogo (RNF7030, SQL0312), genera el listado de compilación | `http://localhost:5251/` (compilaciones en vivo, listados, área de pruebas) |
| `db2-gateway` | 5252 | Único punto de acceso SQL (como los trabajos QSQSRVR): pool `ibm_db`, catálogo, métricas | `http://localhost:5252/` (sentencias/seg, latencia, log de SQL, consola, catálogo) |
| `db2` | 50000 | IBM Db2 Community Edition 11.5.9 (base de datos `AS400`) | — (se monitoriza desde el gateway) |

Todo el código es **Node.js 22** sin *frameworks*: la única dependencia externa del núcleo es `ws` (WebSocket), y la del gateway `ibm_db` (driver oficial de IBM).

### Por qué un compilador propio

No existe un compilador de RPG de código abierto que genere programas ejecutables fuera de IBM i (el intérprete en JVM [smeup/jariko](https://github.com/smeup/jariko) es la referencia más cercana, pero arrastra Kotlin/Gradle y no cubre pantallas 5250). Este proyecto implementa su propio *front-end* (lexer, parser, conversión de columnas fijas, análisis semántico) y un intérprete con la semántica de RPG: decimales empaquetados con truncamiento y desbordamiento (RNX0103), indicadores, ciclo RPG, MONITOR/ON-ERROR, `*PSSR`, activaciones que persisten sin `*INLR`, etc.

---

## Arranque con Docker (recomendado)

Requisitos: Docker Desktop (Windows/macOS con WSL2 o Linux), **≥ 6 GB de RAM** asignados y ~4 GB de disco para la imagen de Db2.

```bash
docker compose up -d --build
docker compose logs -f ibmi-core      # ver el IPL
```

1. Db2 tarda **3–8 minutos** en crear la base de datos la primera vez. Mientras tanto la terminal muestra la pantalla **IPL Step in Progress** (de verdad: el sistema espera a Db2).
2. Al terminar el IPL se crea el catálogo `QSYS`, los perfiles de usuario y la biblioteca **DEMOLIB**, y se compilan los programas de ejemplo.
3. Abra **http://localhost:5250** e inicie sesión.

Para detener: `docker compose down` (los datos persisten en el volumen `db2data`; `docker compose down -v` lo borra todo).

Atajos equivalentes: `npm start` (construir y arrancar), `npm run logs` (seguir el IPL) y `npm stop` (detener).

---

## Usuarios

| Usuario | Contraseña | Clase | Biblioteca actual |
|---|---|---|---|
| `DEMO` | `DEMO` | \*PGMR | DEMOLIB |
| `QSECOFR` | `QSECOFR` | \*SECOFR | DEMOLIB |
| `QPGMR` | `QPGMR` | \*PGMR | QGPL |

Las contraseñas no distinguen mayúsculas (QPWDLVL 0). Tras 3 intentos fallidos (QMAXSIGN) el perfil se inhabilita (excepto QSECOFR); reactívelo con `CHGUSRPRF USRPRF(DEMO) STATUS(*ENABLED)`.

---

## Recorrido guiado

| Pruebe | Qué verá |
|---|---|
| `CALL HELLO` | DSPLY con respuesta en *Display Program Messages* |
| `CALL CUSTINQ` | Programa interactivo RPG + DSPF: EXFMT, CHAIN, ERRMSG con indicador 90, F3/F12 |
| `CALL CUSTSFL` | Subarchivo de 20 clientes con paginación (*More…*/*Bottom*) y opción 5 |
| `CALL CUSTLIST` | SQL embebido con cursor → informe en spool QSYSPRT |
| `WRKSPLF` → opción 5 | El listado generado y los listados de compilación |
| `CALL FIXEDCALC` | RPG clásico en columnas fijas (Z-ADD, DOWLE, ADD, SETON LR) |
| `SBMJOB CMD(CALL PGM(NIGHTLY))` | Trabajo por lotes en QBATCH (visible en `WRKACTJOB`), al terminar se enciende **MW** en el OIA → `DSPMSG` |
| `STRPDM` → 3 → `QRPGLESRC` | PDM: 2=Editar (SEU), 14=Compilar (se envía a QBATCH), 5=Ver |
| `STRSEU SRCFILE(QRPGLESRC) SRCMBR(NUEVO) TYPE(RPGLE)` | SEU con órdenes de línea (`I`, `I5`, `D`, `DD…DD`, `C`/`M` + `A`/`B`, `R`), `FIND`, `TOP`, `BOTTOM`, pantalla *Exit* |
| `STRSDA` (o PDM opción 17) | SDA: diseñar pantallas sobre una imagen 24×80 (constantes, `+I(10)`, `+B(30)`, `+9(7,2)`, F10 campos de base de datos con `&1`, F4 campos), menús (MNUDDS + mandatos) y probar archivos de pantalla |
| `GO MIBIB/MIMENU` | Menú de usuario creado con SDA o `CRTMNU`; la opción *n* ejecuta el mandato USR00*nn* del archivo de mensajes *menú*QQ |
| `OVRDBF` / `OVRPRTF` + `CALL` | Alteraciones con ámbito de nivel de llamada; `DSPOVR`, `DLTOVR` |
| `ADDJOBSCDE … FRQ(*WEEKLY)` | Planificador de trabajos (QSYSSCD); `WRKJOBSCDE` con opciones 2/3/4/5/6 |
| `RUNSQLSTM SRCSTMF('/tmp/x.sql')` | Guiones SQL con control de compromiso y listado |
| `ssh -p 2222 qsecofr@localhost` | OpenSSH/QSH: `system "DSPLIBL"`, `db2 "SELECT …"`; `sftp` sobre el IFS y `/QSYS.LIB` |
| `CRTBNDRPG PGM(NUEVO)` | Compilación: mensaje RNS9304 o errores RNF con listado en spool |
| `STRSQL` | *Enter SQL Statements* y *Display Data* (`select * from customer`) |
| `WRKACTJOB`, `WRKSYSSTS` | Trabajos y métricas reales del sistema (los trabajos QSQSRVR reflejan la actividad del gateway) |
| Cualquier mandato + **F4** | Prompter genérico (también se abre solo si falta un parámetro obligatorio) |
| **Shift+Esc** con un programa en bucle | *System Request*, opción 2 = terminar petición |
| Escribir en un área protegida | Error de operador `X II 0005` con sonido; **Esc** para restablecer |

### Mandatos disponibles

`SIGNOFF GO WRKACTJOB WRKSYSSTS WRKSBS WRKSPLF WRKOUTQ DSPMSG SNDMSG DSPJOBLOG DSPJOB WRKJOB DSPLIBL CHGCURLIB ADDLIBLE RMVLIBLE CHGLIBL CRTLIB DLTLIB CLRLIB DSPLIB WRKLIB WRKOBJ DSPOBJD DLTOBJ DLTPGM DLTF CHKOBJ CRTSRCPF ADDPFM RMVM STRSEU STRPDM WRKLIBPDM WRKOBJPDM WRKMBRPDM CRTBNDRPG CRTRPGPGM CRTSQLRPGI CRTBNDCL CRTCLPGM CRTPF CRTDSPF CALL SBMJOB DLYJOB ENDJOB STRSQL RUNSQL DSPPFM DSPFFD CLRPFM CPYF CRTDTAARA DSPDTAARA CHGDTAARA CRTUSRPRF CHGUSRPRF CHGPRF CHGPWD DLTUSRPRF WRKUSRPRF DSPUSRPRF WRKSYSVAL DSPSYSVAL CHGSYSVAL SNDPGMMSG PWRDWNSYS` y `CALL QCMD` (*Command Entry*). En programas CL además: `PGM DCL CHGVAR IF/ELSE DO DOWHILE DOUNTIL DOFOR SELECT/WHEN GOTO LEAVE ITERATE RETURN MONMSG (EXEC(DO)) RTVJOBA RTVSYSVAL RTVDTAARA`.

Además: `STRSDA CRTMNU CHGMNU DLTMNU OVRDBF OVRPRTF DLTOVR DSPOVR CPYSPLF DLTSPLF HLDSPLF RLSSPLF CHGSPLFA RUNSQLSTM CRTDUPOBJ RNMOBJ MOVOBJ CHGOBJD CPYSRCF RNMM GRTOBJAUT RVKOBJAUT EDTOBJAUT DSPOBJAUT CHGOBJOWN WRKOBJOWN CHGLIB CRTAUTL DLTAUTL ADDAUTLE CHGAUTLE RMVAUTLE DSPAUTL EDTAUTL DSPAUTLOBJ CRTJRNRCV DLTJRNRCV DSPJRNRCVA CRTJRN DLTJRN CHGJRN WRKJRNA STRJRNPF ENDJRNPF DSPJRN APYJRNCHG RMVJRNCHG SNDJRNE CRTSAVF CLRSAVF DSPSAVF SAVOBJ SAVLIB SAVCHGOBJ SAVSECDTA SAVSYS SAVCFG SAV RSTOBJ RSTLIB RSTUSRPRF RSTAUT RSTCFG RST CRTDEVTAP DLTDEVD DSPDEVD WRKDEVD VRYCFG WRKCFGSTS CRTIMGCLG DLTIMGCLG ADDIMGCLGE RMVIMGCLGE CHGIMGCLGE LODIMGCLG LODIMGCLGE WRKIMGCLG WRKIMGCLGE INZTAP DSPTAP CHKTAP CHGAUT DSPAUT WRKAUT CHGOWN CHGPGP CPYAUT CRTCMD CHGCMD DLTCMD DSPCMD STRDBG ENDDBG DSPMODSRC ADDPGM RMVPGM ADDBKP RMVBKP DSPDBG STRSRVJOB ENDSRVJOB DSPSRVSTS HLDJOB RLSJOB STRQRY WRKQRY RUNQRY DLTQRY STRRLU ADDJOBSCDE CHGJOBSCDE RMVJOBSCDE HLDJOBSCDE RLSJOBSCDE WRKJOBSCDE CRTLF CRTPRTF CRTRPGMOD CRTSRVPGM CRTPGM UPDPGM UPDSRVPGM CRTBNDDIR ADDBNDDIRE CRTMSGF ADDMSGD CHGMSGD RMVMSGD DSPMSGD WRKMSGF RTVMSG RCVMSG SNDUSRMSG CVTRPGSRC` (y `STRQSH`/`QSH`, FTP, SSH, REXEC).

### RPG IV soportado

- Declaraciones: `CTL-OPT`, `DCL-S/C/DS/F/PR/PI/PROC`, `LIKE`, `LIKEDS`, `LIKEREC`, `EXTNAME`, `DIM`, `INZ`, `QUALIFIED`, `TEMPLATE`, `VALUE`/`CONST`, `EXTPGM`, `CTL-OPT MAIN`.
- Tipos: `CHAR VARCHAR PACKED ZONED BINDEC INT UNS FLOAT IND DATE TIME TIMESTAMP`.
- Operaciones: `IF/ELSEIF/ELSE`, `DOW`, `DOU`, `FOR … TO/DOWNTO BY`, `SELECT/WHEN/OTHER`, `ITER`, `LEAVE`, `RETURN`, `BEGSR/EXSR/LEAVESR` (incl. `*INZSR`, `*PSSR`), `MONITOR/ON-ERROR`, `DSPLY`, `CLEAR`, `RESET`, `SORTA`, `EVAL(H)`, `EVALR`, `EVAL-CORR`, `CALLP(E)`.
- Archivos: `READ READP READE READPE CHAIN SETLL SETGT WRITE UPDATE DELETE EXFMT READC OPEN CLOSE`, `%EOF %FOUND %EQUAL %ERROR %STATUS`, `%KDS`, listas de clave `(k1:k2)`, `PREFIX`, `RENAME`, `SFILE`, impresoras `PRINTER` → spool.
- SQL embebido: `SELECT INTO`, `DECLARE/OPEN/FETCH/CLOSE` de cursores, `PREPARE/EXECUTE`, `EXECUTE IMMEDIATE`, `VALUES INTO`, `SET :x =`, `SQLCODE`/`SQLSTATE`; las tablas sin calificar se resuelven por **\*LIBL**.
- ~60 BIF: `%TRIM %CHAR %DEC %INT %SUBST %SCAN %SCANRPL %REPLACE %XLATE %UPPER %LOWER %LEN %SIZE %ELEM %LOOKUP %XFOOT %EDITC %EDITW %CHECK %DATE %TIME %TIMESTAMP %DAYS %MONTHS %YEARS %DIFF %SUBDT %ABS %DIV %REM %SQRT %MAX %MIN %PARMS`…
- Columnas fijas: H, F, D, C (factor 2 ampliado, `IFxx/DOWxx/ANDxx/ORxx`, `Z-ADD`, `ADD`, `SUB`, `MULT`, `DIV`, `MOVE/MOVEL`, `CAT`, `SETON/SETOFF`, `CALL/PARM`, `*ENTRY PLIST`, indicadores de condición y resultado) y P.

### Teclado del emulador

| Función 5250 | Tecla |
|---|---|
| Enter | `Enter` o `Ctrl` derecho |
| F13–F24 | `Shift`+`F1…F12` |
| Roll Up / Roll Down | `AvPág` / `RePág` |
| Reset | `Esc` o `Ctrl` izquierdo |
| System Request / Attention | `Shift+Esc` / `Ctrl+Esc` |
| Field Exit / Field+ / Field− | `Ctrl+Enter` / `+` / `−` del teclado numérico |
| Erase EOF | `Shift+Fin` |
| Insert | `Insert` |
| Imprimir pantalla (spool) | `Ctrl+P` |

El menú *View* permite cambiar entre el mapa de colores de ACS y un **monitor monocromo IBM 3477** (fósforo verde, fuente 3270, líneas de barrido) y activar la regla en cruz. En móviles hay un teclado de funciones en pantalla (*Keypad*).

### Sonidos

Los sonidos se sintetizan con Web Audio (clic de teclado tipo *buckling spring*, alarma 5250, error de operador, encendido del CRT). Si quiere usar grabaciones reales, coloque `keyclick.wav`, `alarm.wav` y/o `error.wav` en `services/ibmi-core/public/sounds/`: el emulador las usa automáticamente.

---

## Pruebas

```bash
npm test                 # unitarias: RPG (todos los dialectos, ciclo, DS, OCCURS, SQL de varias filas), CL, DDS y SDA
npm run test:e2e         # recorrido completo por el terminal 5250 contra un sistema en marcha
npm run test:rpg         # dialectos RPG, LF, PRTF y SQL incrustado sobre Db2
npm run test:ile         # módulos, programas de servicio, directorios de enlace y activación
npm run test:msg         # archivos de mensajes, SNDPGMMSG/RCVMSG/MONMSG
npm run test:util        # OVRDBF/OVRPRTF, spool, RUNSQLSTM, objetos y planificador
npm run test:ssh         # OpenSSH/SFTP con el cliente ssh del sistema
npm run test:sda         # SDA por el terminal 5250: pantallas, prueba de pantallas, menús y GO
npm run test:connections # TN5250, FTP, servidores host (jt400), REST/IWS, Mapepire, DRDA…
npm run test:sys         # QTEMP por trabajo, seguridad de objetos y del IFS, diarios, salvar/restaurar (SAVF y cinta), CRTCMD, COMMIT
npm run test:dbg         # depurador STRDBG por el terminal 5250 (vistas *STMT/*LIST/*SOURCE, STRSRVJOB)
npm run test:qry         # Query/400 (WRKQRY, RUNQRY)
npm run test:rlu         # RLU (STRRLU) y uso del archivo de impresora desde RPG
```

La prueba e2e y la de archivos por clave necesitan el sistema en marcha (`npm start`); sin él, la de archivos por clave se omite. La prueba e2e inicia sesión, ejecuta los programas de ejemplo, edita un miembro en SEU con órdenes de línea, compila, provoca un error RNQ0102, envía un trabajo por lotes y comprueba el MW/DSPMSG.

---

## Estructura

```
shared/                 Código común
  rpg/                  lexer, parser (IR), columnas fijas, intérprete, tipos, archivos por clave
  cl.js  dds.js         CL (mandatos, programas, expresiones) y DDS (PF/DSPF)
  http.js gateway.js catalog.js public/ (estilos de los paneles)
services/
  ibmi-core/            Núcleo: sesiones, pantallas, mandatos, runtime, emulador web (public/)
  rpg-compiler/         Servicio de compilación + panel
  db2-gateway/          Pasarela SQL hacia IBM Db2 (ibm_db) + panel
tests/                  Pruebas unitarias y e2e
docker-compose.yml      Db2 + los tres servicios
```

## Diferencias con un IBM i real

Implementado y comprobado contra Db2 real: TN5250 (ACS, tn5250j), FTP/FTPS (también SAVF en binario), servidores
host de jt400/ODBC, DRDA, REST/IWS, Mapepire, SSH/SFTP, SMTP; RPG II/III/IV/libre con el ciclo, ILE, archivos
lógicos, de impresora y de pantalla, DS sobre bytes EBCDIC y de múltiples apariciones, SQL incrustado, control de
compromiso con diarios (SQL7008 sin diario; `CRTSQLRPGI` y `RUNSQL` con `COMMIT(*CHG)` por omisión), colas de datos,
archivos de mensajes, alteraciones, planificador, QTEMP por trabajo, seguridad de objetos (QSECURITY 40) también en
el IFS (`CHGAUT`, `WRKAUT`, `DSPAUT`, `CHGOWN`, `CHGPGP`, `CPYAUT`, `chmod`/`chown` de QSH,
`QSYS2.IFS_OBJECT_PRIVILEGES`), salvar/restaurar en SAVF y en cinta virtual (`TAPVRT01`, catálogos de imágenes,
`INZTAP`, `DSPTAP`, `SAVSYS`, `SAV`/`RST`, `GO SAVE`/`GO RESTORE`), mandatos de usuario, depurador (vistas `*STMT`,
`*SOURCE`, `*LIST`, `*ALL` y `STRSRVJOB` para trabajos por lotes), Query/400, PDM, SEU, SDA y RLU. Diferencias que
quedan, por la naturaleza del emulador:

- La cinta es solo virtual (`CRTDEVTAP RSRCNAME(*VRT)` con catálogos de imágenes en el IFS); no hay unidades físicas
  ni óptico. `SAVSYS` y las opciones 21/22/23 de `GO SAVE` no llevan el sistema al estado restringido (los
  subsistemas siguen activos), y la opción 21 de `GO RESTORE` (restaurar el sistema entero) no existe: requiere un
  IPL manual desde el soporte de instalación.
- `HLDJOB`/`RLSJOB` actúan sobre trabajos en la cola (`SBMJOB HOLD(*YES)`); un trabajo ya activo no se puede retener.
- Las bibliotecas cuyo nombre empieza por `SYS` no se pueden crear (Db2 reserva esos esquemas).
- Las pantallas reproducen el aspecto y la navegación de IBM i 7.x a partir de documentación pública; algunos textos de ayuda (F1) son genéricos.
