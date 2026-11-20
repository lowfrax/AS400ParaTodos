// Datos iniciales: perfiles de usuario y biblioteca DEMOLIB con fuentes de ejemplo que se compilan al arrancar.

// Genera una línea DDS respetando las columnas exactas (A-spec).
function A({ cond = '', type = '', name = '', len = '', dt = '', dec = '', use = '', row = '', col = '', kw = '' } = {}) {
  const s = Array(80).fill(' ');
  const put = (from, str, right = false, width = 0) => {
    let v = String(str);
    if (right && width) v = v.padStart(width);
    for (let i = 0; i < v.length; i++) s[from - 1 + i] = v[i];
  };
  put(6, 'A');
  if (cond) put(8, cond);
  if (type) put(17, type);
  if (name) put(19, name);
  if (len !== '') put(30, len, true, 5);
  if (dt) put(35, dt);
  if (dec !== '') put(36, dec, true, 2);
  if (use) put(38, use);
  if (row !== '') put(39, row, true, 3);
  if (col !== '') put(42, col, true, 3);
  if (kw) { if (kw.length > 36) throw new Error(`DDS keyword area overflow (col 80): ${kw}`); put(45, kw); }
  return s.join('').replace(/\s+$/, '');
}

export const CUSTOMER_PF = [
  A({ kw: 'UNIQUE' }),
  A({ type: 'R', name: 'CUSTREC', kw: "TEXT('Customer master')" }),
  A({ name: 'CUSTNO', len: 5, dt: 'P', dec: 0, kw: "TEXT('Customer number')" }),
  A({ kw: "COLHDG('Cust' 'No')" }),
  A({ name: 'NAME', len: 30, dt: 'A', kw: "TEXT('Customer name')" }),
  A({ name: 'CITY', len: 20, dt: 'A', kw: "TEXT('City')" }),
  A({ name: 'COUNTRY', len: 2, dt: 'A', kw: "TEXT('Country code')" }),
  A({ name: 'BALANCE', len: 9, dt: 'P', dec: 2, kw: "TEXT('Balance')" }),
  A({ name: 'CRLIMIT', len: 9, dt: 'P', dec: 2, kw: "TEXT('Credit limit')" }),
  A({ type: 'K', name: 'CUSTNO' }),
];

export const CUSTINQD_DSPF = [
  A({ kw: 'DSPSIZ(24 80 *DS3)' }),
  A({ kw: "CA03(03 'Exit')" }),
  A({ type: 'R', name: 'PROMPT', kw: "TEXT('Customer number prompt')" }),
  A({ row: 1, col: 2, kw: "'CUSTINQ'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 1, col: 30, kw: "'Customer Inquiry'" }),
  A({ kw: 'DSPATR(HI)' }),
  A({ row: 1, col: 71, kw: 'DATE' }),
  A({ kw: 'EDTCDE(Y)' }),
  A({ row: 2, col: 71, kw: 'TIME' }),
  A({ row: 3, col: 2, kw: "'Type customer number, press Enter.'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 5, col: 5, kw: "'Customer number . . . . . .'" }),
  A({ name: 'CUSTNO', len: 5, dt: 'Y', dec: 0, use: 'B', row: 5, col: 34, kw: 'EDTCDE(Z)' }),
  A({ cond: ' 90', kw: "ERRMSG('Customer not found.' 90)" }),
  A({ row: 7, col: 5, kw: "'Valid customers: 1 to 20.'" }),
  A({ row: 23, col: 2, kw: "'F3=Exit'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ type: 'R', name: 'DETAIL', kw: "CA12(12 'Cancel')" }),
  A({ row: 1, col: 2, kw: "'CUSTINQ'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 1, col: 30, kw: "'Customer Inquiry'" }),
  A({ kw: 'DSPATR(HI)' }),
  A({ row: 1, col: 71, kw: 'DATE' }),
  A({ kw: 'EDTCDE(Y)' }),
  A({ row: 3, col: 5, kw: "'Customer number . . . :'" }),
  A({ name: 'CUSTNO', len: 5, dt: 'Y', dec: 0, use: 'O', row: 3, col: 30, kw: 'DSPATR(HI)' }),
  A({ row: 4, col: 5, kw: "'Name  . . . . . . . . :'" }),
  A({ name: 'NAME', len: 30, dt: 'A', use: 'O', row: 4, col: 30, kw: 'COLOR(WHT)' }),
  A({ row: 5, col: 5, kw: "'City  . . . . . . . . :'" }),
  A({ name: 'CITY', len: 20, dt: 'A', use: 'O', row: 5, col: 30, kw: 'COLOR(WHT)' }),
  A({ row: 6, col: 5, kw: "'Country . . . . . . . :'" }),
  A({ name: 'COUNTRY', len: 2, dt: 'A', use: 'O', row: 6, col: 30, kw: 'COLOR(WHT)' }),
  A({ row: 7, col: 5, kw: "'Balance . . . . . . . :'" }),
  A({ name: 'BALANCE', len: 9, dt: 'Y', dec: 2, use: 'O', row: 7, col: 30, kw: 'EDTCDE(J)' }),
  A({ row: 8, col: 5, kw: "'Credit limit  . . . . :'" }),
  A({ name: 'CRLIMIT', len: 9, dt: 'Y', dec: 2, use: 'O', row: 8, col: 30, kw: 'EDTCDE(J)' }),
  A({ cond: ' 50', row: 10, col: 5, kw: "'** Balance exceeds credit limit **'" }),
  A({ kw: 'COLOR(RED)' }),
  A({ kw: 'DSPATR(RI)' }),
  A({ row: 23, col: 2, kw: "'F3=Exit   F12=Cancel'" }),
  A({ kw: 'COLOR(BLU)' }),
];

export const CUSTSFLD_DSPF = [
  A({ kw: 'DSPSIZ(24 80 *DS3)' }),
  A({ kw: "CA03(03 'Exit')" }),
  A({ type: 'R', name: 'CUSTSFL', kw: 'SFL' }),
  A({ name: 'OPT', len: 1, dt: 'A', use: 'B', row: 7, col: 3 }),
  A({ name: 'CUSTNO', len: 5, dt: 'Y', dec: 0, use: 'O', row: 7, col: 7, kw: 'EDTCDE(Z)' }),
  A({ name: 'NAME', len: 30, dt: 'A', use: 'O', row: 7, col: 14 }),
  A({ name: 'CITY', len: 20, dt: 'A', use: 'O', row: 7, col: 46 }),
  A({ name: 'BALANCE', len: 9, dt: 'Y', dec: 2, use: 'O', row: 7, col: 67, kw: 'EDTCDE(1)' }),
  A({ type: 'R', name: 'CUSTCTL', kw: 'SFLCTL(CUSTSFL)' }),
  A({ kw: 'SFLSIZ(0050)' }),
  A({ kw: 'SFLPAG(0012)' }),
  A({ kw: 'OVERLAY' }),
  A({ cond: ' 31', kw: 'SFLDSP' }),
  A({ kw: 'SFLDSPCTL' }),
  A({ cond: ' 33', kw: 'SFLCLR' }),
  A({ cond: ' 34', kw: 'SFLEND(*MORE)' }),
  A({ row: 1, col: 2, kw: "'CUSTSFL'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 1, col: 28, kw: "'Work with Customers'" }),
  A({ kw: 'DSPATR(HI)' }),
  A({ row: 1, col: 71, kw: 'DATE' }),
  A({ kw: 'EDTCDE(Y)' }),
  A({ row: 3, col: 2, kw: "'Type options, press Enter.'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 4, col: 4, kw: "'5=Display'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 6, col: 2, kw: "'Opt  Cust#  Name'" }),
  A({ kw: 'DSPATR(HI)' }),
  A({ row: 6, col: 46, kw: "'City'" }),
  A({ kw: 'DSPATR(HI)' }),
  A({ row: 6, col: 69, kw: "'Balance'" }),
  A({ kw: 'DSPATR(HI)' }),
  A({ type: 'R', name: 'FKEYS' }),
  A({ row: 23, col: 2, kw: "'F3=Exit   Enter=Process options'" }),
  A({ kw: 'COLOR(BLU)' }),
];

export const HELLO_RPG = `**FREE
// HELLO - Primer programa RPG IV en formato libre.
// Compilar: CRTBNDRPG PGM(DEMOLIB/HELLO)   Ejecutar: CALL HELLO
ctl-opt dftactgrp(*no);

dcl-s nombre char(20);
dcl-s saludo varchar(52);

dsply 'Como te llamas?' '' nombre;
if nombre = *blanks;
  nombre = 'mundo';
endif;

saludo = 'Hola, ' + %trim(nombre) + '! Bienvenido a IBM i.';
dsply saludo;

*inlr = *on;
return;`;

export const CUSTINQ_RPG = `**FREE
// CUSTINQ - Consulta de clientes: pantalla DDS (CUSTINQD) + CHAIN al archivo CUSTOMER.
ctl-opt dftactgrp(*no);

dcl-f CUSTINQD workstn;
dcl-f CUSTOMER disk keyed usage(*input);

dow not *in03;
  exfmt PROMPT;
  if *in03;
    leave;
  endif;

  *in90 = *off;
  chain custno CUSTOMER;
  if not %found(CUSTOMER);
    *in90 = *on;
    iter;
  endif;

  // Indicador 50: saldo por encima del límite de crédito
  *in50 = balance > crlimit;
  exfmt DETAIL;
  *in12 = *off;
enddo;

*inlr = *on;`;

export const CUSTLIST_RPG = `**FREE
// CUSTLIST - Listado de clientes con SQL embebido. Genera el spool QSYSPRT (WRKSPLF).
ctl-opt dftactgrp(*no);

dcl-f QSYSPRT printer(132);

dcl-ds cust qualified;
  custno  packed(5:0);
  name    char(30);
  city    char(20);
  country char(2);
  balance packed(9:2);
  crlimit packed(9:2);
end-ds;

dcl-s line  char(132);
dcl-s total packed(11:2);
dcl-s count int(10);

line = 'LISTADO DE CLIENTES' + '                               Fecha: ' + %char(%date():*eur);
write QSYSPRT line;
line = 'Num.   Nombre                          Ciudad                         Saldo';
write QSYSPRT line;
line = *all'-';
write QSYSPRT line;

exec sql declare c1 cursor for
  select custno, name, city, country, balance, crlimit
    from customer
   order by custno;
exec sql open c1;
exec sql fetch next from c1 into :cust;

dow sqlcode = 0;
  count += 1;
  total += cust.balance;
  line = %editc(cust.custno:'X') + '  ' + cust.name + '  ' + cust.city + %editc(cust.balance:'J');
  write QSYSPRT line;
  exec sql fetch next from c1 into :cust;
enddo;
exec sql close c1;

line = *all'-';
write QSYSPRT line;
line = 'Total clientes: ' + %char(count) + '     Saldo total: ' + %char(total);
write QSYSPRT line;

dsply ('Listado generado: ' + %char(count) + ' clientes. Ver WRKSPLF.');
*inlr = *on;`;

export const CUSTSFL_RPG = `**FREE
// CUSTSFL - Lista de clientes con subarchivo (opcion 5=Display).
ctl-opt dftactgrp(*no);

dcl-f CUSTSFLD workstn sfile(CUSTSFL:rrn);
dcl-f CUSTOMER disk keyed;

dcl-s rrn packed(4:0);

dow not *in03;
  exsr cargar;
  write FKEYS;
  exfmt CUSTCTL;
  if *in03;
    leave;
  endif;

  readc CUSTSFL;
  dow not %eof(CUSTSFLD);
    if opt = '5';
      chain custno CUSTOMER;
      dsply ('Cliente ' + %char(custno) + ': ' + %trim(name) + ' (' + %trim(city) + ')');
    endif;
    readc CUSTSFL;
  enddo;
enddo;

*inlr = *on;

begsr cargar;
  *in33 = *on;
  write CUSTCTL;
  *in33 = *off;
  rrn = 0;
  setll *loval CUSTOMER;
  read CUSTOMER;
  dow not %eof(CUSTOMER);
    rrn += 1;
    opt = ' ';
    write CUSTSFL;
    read CUSTOMER;
  enddo;
  *in31 = rrn > 0;
  *in34 = *on;
endsr;`;

export const FIXED_RPG = [
  '     H DFTACTGRP(*NO)',
  '      * FIXEDCALC - Ejemplo clasico RPG IV en columnas fijas (C-specs)',
  '     D TOTAL           S              9  2 INZ(0)',
  '     D I               S              3  0',
  '     D MSG             S             50A',
  '     C                   Z-ADD     1             I',
  '     C     I             DOWLE     10',
  '     C                   ADD       I             TOTAL',
  '     C                   ADD       1             I',
  '     C                   ENDDO',
  "     C                   EVAL      MSG = 'Suma 1..10 = ' + %CHAR(TOTAL)",
  '     C     MSG           DSPLY',
  '     C                   SETON                                        LR',
];

export const NIGHTLY_CL = `PGM
/* NIGHTLY - Proceso por lotes de ejemplo en CL.                   */
/* Ejecutar en batch: SBMJOB CMD(CALL PGM(DEMOLIB/NIGHTLY))        */
             DCL        VAR(&USER) TYPE(*CHAR) LEN(10)
             DCL        VAR(&MSG) TYPE(*CHAR) LEN(80)
             DCL        VAR(&I) TYPE(*DEC) LEN(3 0)

             RTVJOBA    USER(&USER)
             CHKOBJ     OBJ(DEMOLIB/CUSTOMER) OBJTYPE(*FILE)
             MONMSG     MSGID(CPF9801) EXEC(DO)
               SNDPGMMSG  MSG('Archivo CUSTOMER no encontrado') MSGTYPE(*ESCAPE)
             ENDDO

             DOFOR      VAR(&I) FROM(1) TO(3)
               CHGVAR     VAR(&MSG) VALUE('Paso' *BCAT %CHAR(&I) *BCAT +
                            'completado por' *BCAT &USER)
               SNDPGMMSG  MSG(&MSG)
               DLYJOB     DLY(2)
             ENDDO

             CALL       PGM(DEMOLIB/CUSTLIST)
             SNDMSG     MSG('Proceso nocturno NIGHTLY terminado') TOUSR(&USER)
             SNDPGMMSG  MSG('NIGHTLY terminado correctamente') MSGTYPE(*COMP)
ENDPGM`;

export const CUSTOMERS = [
  [1, 'ACME CORPORATION', 'MADRID', 'ES', 1250.5, 5000],
  [2, 'TALLERES GARCIA SL', 'SEVILLA', 'ES', 320, 2000],
  [3, 'DISTRIBUCIONES LOPEZ', 'VALENCIA', 'ES', 8900.75, 10000],
  [4, 'FERRETERIA EL SOL', 'MEXICO DF', 'MX', 45, 1000],
  [5, 'COMERCIAL ANDINA', 'BOGOTA', 'CO', 15230.1, 12000],
  [6, 'ALIMENTOS DEL SUR', 'SANTIAGO', 'CL', 0, 3000],
  [7, 'TEXTILES RIO PLATA', 'BUENOS AIRES', 'AR', 2310, 4000],
  [8, 'CAFE DE ALTURA', 'MEDELLIN', 'CO', 760.4, 1500],
  [9, 'IMPORTADORA PACIFICO', 'LIMA', 'PE', 5400, 6000],
  [10, 'MUEBLES ARTESANOS', 'GUADALAJARA', 'MX', 120, 800],
  [11, 'LIBRERIA CERVANTES', 'BARCELONA', 'ES', 980, 2500],
  [12, 'BIG BLUE SYSTEMS', 'ARMONK', 'US', 99000, 150000],
  [13, 'PANADERIA LA ESPIGA', 'MONTEVIDEO', 'UY', 15.75, 500],
  [14, 'AUTOPARTES DEL NORTE', 'MONTERREY', 'MX', 4200, 4000],
  [15, 'FARMACIA CENTRAL', 'QUITO', 'EC', 670, 2000],
  [16, 'VINOS DEL VALLE', 'MENDOZA', 'AR', 3100, 3500],
  [17, 'CONSTRUCTORA ANDES', 'LA PAZ', 'BO', 12000, 20000],
  [18, 'PESCADOS ATLANTICO', 'VIGO', 'ES', 845.2, 1200],
  [19, 'ELECTRONICA CARIBE', 'SAN JUAN', 'PR', 2999.99, 3000],
  [20, 'SERVICIOS ROCHESTER', 'ROCHESTER', 'US', 450, 5000],
];

export const SOURCES = [
  { file: 'QDDSSRC', mbr: 'CUSTOMER', type: 'PF', text: 'Customer master file', lines: CUSTOMER_PF },
  { file: 'QDDSSRC', mbr: 'CUSTINQD', type: 'DSPF', text: 'Customer inquiry display', lines: CUSTINQD_DSPF },
  { file: 'QDDSSRC', mbr: 'CUSTSFLD', type: 'DSPF', text: 'Customer subfile display', lines: CUSTSFLD_DSPF },
  { file: 'QRPGLESRC', mbr: 'HELLO', type: 'RPGLE', text: 'Hola mundo en RPG IV', lines: HELLO_RPG.split('\n') },
  { file: 'QRPGLESRC', mbr: 'CUSTINQ', type: 'RPGLE', text: 'Consulta de clientes (DSPF + CHAIN)', lines: CUSTINQ_RPG.split('\n') },
  { file: 'QRPGLESRC', mbr: 'CUSTLIST', type: 'SQLRPGLE', text: 'Listado de clientes con SQL embebido', lines: CUSTLIST_RPG.split('\n') },
  { file: 'QRPGLESRC', mbr: 'CUSTSFL', type: 'RPGLE', text: 'Lista de clientes con subarchivo', lines: CUSTSFL_RPG.split('\n') },
  { file: 'QRPGLESRC', mbr: 'FIXEDCALC', type: 'RPGLE', text: 'RPG IV en columnas fijas', lines: FIXED_RPG },
  { file: 'QCLLESRC', mbr: 'NIGHTLY', type: 'CLLE', text: 'Proceso nocturno de ejemplo', lines: NIGHTLY_CL.split('\n') },
];

export const COMPILE_ORDER = [
  ['CRTPF', 'FILE', 'CUSTOMER', 'QDDSSRC'],
  ['CRTDSPF', 'FILE', 'CUSTINQD', 'QDDSSRC'],
  ['CRTDSPF', 'FILE', 'CUSTSFLD', 'QDDSSRC'],
  ['CRTBNDRPG', 'PGM', 'HELLO', 'QRPGLESRC'],
  ['CRTBNDRPG', 'PGM', 'CUSTINQ', 'QRPGLESRC'],
  ['CRTSQLRPGI', 'OBJ', 'CUSTLIST', 'QRPGLESRC'],
  ['CRTBNDRPG', 'PGM', 'CUSTSFL', 'QRPGLESRC'],
  ['CRTBNDRPG', 'PGM', 'FIXEDCALC', 'QRPGLESRC'],
  ['CRTBNDCL', 'PGM', 'NIGHTLY', 'QCLLESRC'],
];
