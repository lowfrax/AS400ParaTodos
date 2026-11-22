// Fuentes del core bancario (biblioteca BANCO): programas RPG IV con SQL embebido y control de compromiso,
// pantallas DDS del cajero (5250), CGI y el cierre diario en CL. Se compilan con el compilador del sistema en el IPL.

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

export const BNKSALDO = `**FREE
// BNKSALDO - Consulta de saldo de una cuenta.
// Canales: IWS REST (GET /web/services/banco/cuentas/{CUENTA}), SOAP, XMLSERVICE, 5250 y Open Banking.
ctl-opt dftactgrp(*no);

dcl-pi BNKSALDO;
  pCuenta     packed(10:0) const;
  pNombre     char(40);
  pTipo       char(3);
  pMoneda     char(3);
  pSaldo      packed(15:2);
  pDisponible packed(15:2);
  pEstado     char(1);
  pRc         char(2);
  pMensaje    char(60);
end-pi;

pRc = '00';
pMensaje = 'Consulta correcta';
exec sql select l.nombre, c.tipo, c.moneda, c.saldo, c.disponible, c.estado
           into :pNombre, :pTipo, :pMoneda, :pSaldo, :pDisponible, :pEstado
           from banco.cuentas c join banco.clientes l on l.cliente = c.cliente
          where c.cuenta = :pCuenta;
if sqlcode = 100;
  pRc = '14';
  pMensaje = 'Cuenta inexistente';
elseif sqlcode < 0;
  pRc = '96';
  pMensaje = 'Error de sistema SQL ' + %char(sqlcode);
endif;
*inlr = *on;
return;`;

export const BNKTRANSF = `**FREE
// BNKTRANSF - Transferencia entre cuentas con control de compromiso (COMMIT/ROLLBACK).
// Registra la transferencia y los movimientos, y publica el evento en la cola de datos BNKEVENTS
// (QSNDDTAQ) y en la cola MQ BANCO.NOTIFICACIONES (MQSEND).
ctl-opt dftactgrp(*no);

dcl-pr QSNDDTAQ extpgm('QSNDDTAQ');
  dtaq char(10) const;
  lib  char(10) const;
  len  packed(5:0) const;
  data char(1024) const;
end-pr;

dcl-pi BNKTRANSF;
  pOrigen   packed(10:0) const;
  pDestino  packed(10:0) const;
  pImporte  packed(15:2) const;
  pConcepto char(60) const;
  pCanal    char(4) const;
  pRefer    char(35) const;
  pFolio    packed(15:0);
  pRc       char(2);
  pMensaje  char(60);
end-pi;

dcl-s monOri   char(3);
dcl-s monDes   char(3);
dcl-s estOri   char(1);
dcl-s estDes   char(1);
dcl-s disp     packed(15:2);
dcl-s saldoOri packed(15:2);
dcl-s saldoDes packed(15:2);
dcl-s canal    char(4);
dcl-s concepto char(60);
dcl-s evento   varchar(1024);
dcl-s mqok     char(1);
dcl-s oriTxt   varchar(34);
dcl-s desTxt   varchar(34);

exec sql set option commit = *chg;

pRc = '00';
pMensaje = 'Transferencia aplicada';
pFolio = 0;
canal = pCanal;
if canal = *blanks;
  canal = 'API';
endif;
concepto = pConcepto;
if concepto = *blanks;
  concepto = 'Transferencia';
endif;
oriTxt = %char(pOrigen);
desTxt = %char(pDestino);

exsr validar;
if pRc = '00';
  exsr aplicar;
endif;

if pRc = '00';
  exec sql commit;
  evento = '{"evento":"TRANSFERENCIA","folio":' + %char(pFolio) +
           ',"origen":' + %char(pOrigen) + ',"destino":' + %char(pDestino) +
           ',"importe":' + %char(pImporte) + ',"moneda":"' + monOri +
           '","canal":"' + %trim(canal) + '","referencia":"' + %trim(pRefer) +
           '","saldoOrigen":' + %char(saldoOri) + '}';
  QSNDDTAQ('BNKEVENTS' : 'BANCO' : %len(evento) : evento);
  exec sql set :mqok = mqsend('BANCO.NOTIFICACIONES', :evento);
else;
  exec sql rollback;
endif;

*inlr = *on;
return;

begsr validar;
  if pImporte <= 0;
    pRc = '13';
    pMensaje = 'Importe no valido';
    leavesr;
  endif;
  if pOrigen = pDestino;
    pRc = '12';
    pMensaje = 'Cuenta origen y destino iguales';
    leavesr;
  endif;
  exec sql select moneda, estado, disponible into :monOri, :estOri, :disp
             from banco.cuentas where cuenta = :pOrigen;
  if sqlcode = 100;
    pRc = '14';
    pMensaje = 'Cuenta origen inexistente';
    leavesr;
  endif;
  exec sql select moneda, estado into :monDes, :estDes
             from banco.cuentas where cuenta = :pDestino;
  if sqlcode = 100;
    pRc = '14';
    pMensaje = 'Cuenta destino inexistente';
    leavesr;
  endif;
  if estOri <> 'A' or estDes <> 'A';
    pRc = '62';
    pMensaje = 'Cuenta bloqueada o cancelada';
    leavesr;
  endif;
  if monOri <> monDes;
    pRc = '57';
    pMensaje = 'Monedas distintas (' + monOri + '/' + monDes + ')';
    leavesr;
  endif;
  if disp < pImporte;
    pRc = '51';
    pMensaje = 'Fondos insuficientes';
    leavesr;
  endif;
endsr;

begsr aplicar;
  exec sql update banco.cuentas
              set saldo = saldo - :pImporte, disponible = disponible - :pImporte,
                  ultmov = current timestamp
            where cuenta = :pOrigen;
  if sqlcode <> 0;
    pRc = '96';
    pMensaje = 'Error al debitar: SQL ' + %char(sqlcode);
    leavesr;
  endif;
  exec sql update banco.cuentas
              set saldo = saldo + :pImporte, disponible = disponible + :pImporte,
                  ultmov = current timestamp
            where cuenta = :pDestino;
  if sqlcode <> 0;
    pRc = '96';
    pMensaje = 'Error al acreditar: SQL ' + %char(sqlcode);
    leavesr;
  endif;
  exec sql select saldo into :saldoOri from banco.cuentas where cuenta = :pOrigen;
  exec sql select saldo into :saldoDes from banco.cuentas where cuenta = :pDestino;
  exec sql select trfid into :pFolio from final table (
             insert into banco.transfer (origen, destino, importe, moneda, estado, canal, referencia, concepto, tipo)
             values (:pOrigen, :desTxt, :pImporte, :monOri, 'OK', :canal, :pRefer, :concepto, 'INT'));
  if sqlcode <> 0;
    pRc = '96';
    pMensaje = 'Error al registrar: SQL ' + %char(sqlcode);
    leavesr;
  endif;
  exec sql insert into banco.movimientos (cuenta, tipo, concepto, importe, saldo, referencia, canal, contraparte, folio)
           values (:pOrigen, 'DB', :concepto, :pImporte, :saldoOri, :pRefer, :canal, :desTxt, :pFolio);
  exec sql insert into banco.movimientos (cuenta, tipo, concepto, importe, saldo, referencia, canal, contraparte, folio)
           values (:pDestino, 'CR', :concepto, :pImporte, :saldoDes, :pRefer, :canal, :oriTxt, :pFolio);
  if sqlcode <> 0;
    pRc = '96';
    pMensaje = 'Error en movimientos: SQL ' + %char(sqlcode);
  endif;
endsr;`;

export const BNKAUTH = `**FREE
// BNKAUTH - Autorizacion de tarjetas (cajeros ATM y terminales POS) para el switch ISO 8583.
// Codigos de proceso: 00xxxx compra, 01xxxx retiro, 31xxxx consulta de saldo.
// Respuestas: 00 aprobada, 05 no honrar, 14 tarjeta invalida, 51 fondos insuficientes,
//             54 tarjeta vencida, 61 excede limite diario, 12 transaccion invalida.
ctl-opt dftactgrp(*no);

dcl-pi BNKAUTH;
  pPan      char(19) const;
  pProc     char(6) const;
  pImporte  packed(15:2) const;
  pMoneda   char(3) const;
  pTerminal char(8) const;
  pComercio char(15) const;
  pStan     char(6) const;
  pRrn      char(12) const;
  pResp     char(2);
  pCodAut   char(6);
  pSaldo    packed(15:2);
  pTexto    char(40);
end-pi;

dcl-s cuenta   packed(10:0);
dcl-s estado   char(1);
dcl-s vence    char(4);
dcl-s limite   packed(11:2);
dcl-s disp     packed(15:2);
dcl-s moneda   char(3);
dcl-s hoyTot   packed(15:2);
dcl-s hoy      int(10);
dcl-s canal    char(4);
dcl-s concepto char(60);
dcl-s nuevo    packed(15:2);

exec sql set option commit = *chg;

pResp = '00';
pCodAut = *blanks;
pSaldo = 0;
pTexto = 'APROBADA';

exec sql select cuenta, estado, vence, limdiario into :cuenta, :estado, :vence, :limite
           from banco.tarjetas where pan = :pPan;
if sqlcode = 100;
  pResp = '14';
  pTexto = 'TARJETA INVALIDA';
  exsr registrar;
  return;
endif;
if estado <> 'A';
  pResp = '05';
  pTexto = 'NO HONRAR - TARJETA BLOQUEADA';
  exsr registrar;
  return;
endif;
hoy = %subdt(%date():*years) * 100 + %subdt(%date():*months);
if 200000 + %int(vence) < hoy;
  pResp = '54';
  pTexto = 'TARJETA VENCIDA';
  exsr registrar;
  return;
endif;

exec sql select disponible, moneda into :disp, :moneda from banco.cuentas where cuenta = :cuenta;
pSaldo = disp;

select;
  when %subst(pProc:1:2) = '31';
    pTexto = 'CONSULTA DE SALDO';
  when %subst(pProc:1:2) = '00' or %subst(pProc:1:2) = '01';
    if pImporte <= 0;
      pResp = '13';
      pTexto = 'IMPORTE INVALIDO';
    elseif pImporte > disp;
      pResp = '51';
      pTexto = 'FONDOS INSUFICIENTES';
    else;
      exec sql select coalesce(sum(importe), 0) into :hoyTot from banco.autoriza
                where pan = :pPan and resp = '00' and date(fecha) = current date
                  and substr(proc, 1, 2) <> '31';
      if hoyTot + pImporte > limite;
        pResp = '61';
        pTexto = 'EXCEDE LIMITE DIARIO';
      else;
        canal = 'POS';
        concepto = 'Compra POS ' + %trim(pComercio);
        if %subst(pProc:1:2) = '01';
          canal = 'ATM';
          concepto = 'Retiro cajero ' + %trim(pTerminal);
        endif;
        exec sql update banco.cuentas set saldo = saldo - :pImporte, disponible = disponible - :pImporte,
                    ultmov = current timestamp where cuenta = :cuenta;
        exec sql select saldo, disponible into :nuevo, :pSaldo from banco.cuentas where cuenta = :cuenta;
        exec sql insert into banco.movimientos (cuenta, tipo, concepto, importe, saldo, referencia, canal, contraparte)
                 values (:cuenta, 'DB', :concepto, :pImporte, :nuevo, :pRrn, :canal, :pComercio);
        exec sql values right(digits(int(rand() * 999999)), 6) into :pCodAut;
      endif;
    endif;
  other;
    pResp = '12';
    pTexto = 'TRANSACCION INVALIDA';
endsl;

exsr registrar;
*inlr = *on;
return;

begsr registrar;
  exec sql insert into banco.autoriza (pan, proc, importe, moneda, resp, codaut, terminal, comercio, stan, rrn)
           values (:pPan, :pProc, :pImporte, :pMoneda, :pResp, :pCodAut, :pTerminal, :pComercio, :pStan, :pRrn);
  exec sql commit;
endsr;`;

export const BNKEOD = `**FREE
// BNKEOD - Cierre diario (end of day): devengo de intereses de cuentas de ahorro y reporte en spool.
// Lo llama el CL BNKCIERRE (programado con ADDJOBSCDE o enviado con SBMJOB).
ctl-opt dftactgrp(*no);

dcl-f QSYSPRT printer(132);

dcl-ds cta qualified;
  cuenta  packed(10:0);
  moneda  char(3);
  saldo   packed(15:2);
  tasa    packed(7:4);
end-ds;

dcl-s line    char(132);
dcl-s interes packed(15:2);
dcl-s total   packed(15:2);
dcl-s nuevo   packed(15:2);
dcl-s n       int(10);

exec sql set option commit = *chg;

line = 'BANCO - CIERRE DIARIO / DEVENGO DE INTERESES        Fecha: ' + %char(%date():*iso);
write QSYSPRT line;
line = 'Cuenta        Mon            Saldo    Tasa       Interes';
write QSYSPRT line;
line = *all'-';
write QSYSPRT line;

exec sql declare c1 cursor for
  select cuenta, moneda, saldo, tasa from banco.cuentas
   where tipo = 'AHO' and estado = 'A' and saldo > 0 and tasa > 0
   order by cuenta;
exec sql open c1;
exec sql fetch next from c1 into :cta;
dow sqlcode = 0;
  interes = cta.saldo * cta.tasa / 36500;
  if interes > 0;
    nuevo = cta.saldo + interes;
    exec sql update banco.cuentas set saldo = saldo + :interes, disponible = disponible + :interes
              where cuenta = :cta.cuenta;
    exec sql insert into banco.movimientos (cuenta, tipo, concepto, importe, saldo, referencia, canal)
             values (:cta.cuenta, 'CR', 'Intereses devengados', :interes, :nuevo, 'EOD', 'BATC');
    n += 1;
    total += interes;
    line = %editc(cta.cuenta:'X') + '    ' + cta.moneda + %editc(cta.saldo:'J') + '  ' + %editc(cta.tasa:'J') + %editc(interes:'J');
    write QSYSPRT line;
  endif;
  exec sql fetch next from c1 into :cta;
enddo;
exec sql close c1;
exec sql commit;

line = *all'-';
write QSYSPRT line;
line = 'Cuentas con interes: ' + %char(n) + '     Total devengado: ' + %char(total);
write QSYSPRT line;
*inlr = *on;`;

export const BNKCIERRE = `PGM
/* BNKCIERRE - Cierre diario del banco (lote nocturno).                      */
/* 1) Devenga intereses (BNKEOD)  2) Exporta movimientos a CSV en el IFS      */
/* 3) Envia el reporte por correo  4) Avisa a QSYSOPR                         */
/* Programar: ADDJOBSCDE JOB(CIERRE) CMD(CALL BANCO/BNKCIERRE) FRQ(*WEEKLY)   */
/*            SCDDATE(*NONE) SCDDAY(*ALL) SCDTIME('230000')                   */
             DCL        VAR(&USER) TYPE(*CHAR) LEN(10)
             RTVJOBA    USER(&USER)
             CALL       PGM(BANCO/BNKEOD)
             CPYTOIMPF  FROMFILE(BANCO/MOVIMIENTOS) +
                          TOSTMF('/banco/salida/movimientos.csv') +
                          MBROPT(*REPLACE) ADDCOLNAM(*SQL)
             SNDSMTPEMM RCP(operaciones@banco.local) +
                          SUBJECT('Cierre diario del banco') +
                          NOTE('Se adjuntan los movimientos del dia.') +
                          ATTACH('/banco/salida/movimientos.csv')
             MONMSG     MSGID(TCP5091 CPF9898) EXEC(DO)
               SNDPGMMSG  MSG('Correo de cierre no enviado (SMTP no disponible)')
             ENDDO
             SNDMSG     MSG('Cierre diario del banco terminado') TOUSR(QSYSOPR)
             SNDPGMMSG  MSG('BNKCIERRE terminado correctamente') MSGTYPE(*COMP)
ENDPGM`;

export const BNKCGI = `**FREE
// BNKCGI - Estado de cuenta en HTML por CGI (IBM HTTP Server): /cgi-bin/bnkcgi.pgm?cuenta=1001
// Usa las APIs QtmhWrStout (salida) y getenv (QUERY_STRING) como un CGI real de IBM i.
ctl-opt dftactgrp(*no);

dcl-pr QtmhWrStout extproc('QtmhWrStout');
  data   char(32767) options(*varsize) const;
  len    int(10) const;
  err    char(16) options(*varsize);
end-pr;
dcl-pr getenv pointer extproc('getenv');
  name pointer value options(*string);
end-pr;

dcl-s qs      varchar(256);
dcl-s num     varchar(64);
dcl-s amp     int(10);
dcl-s html    varchar(32000);
dcl-s cuenta  packed(10:0);
dcl-s nombre  char(40);
dcl-s moneda  char(3);
dcl-s saldo   packed(15:2);
dcl-s err     char(16);
dcl-s pos     int(10);
dcl-s fecha   char(19);
dcl-s tipo    char(2);
dcl-s concep  char(60);
dcl-s importe packed(15:2);

qs = %str(getenv('QUERY_STRING'));
pos = %scan('cuenta=' : qs);
if pos > 0 and pos + 7 <= %len(qs);
  num = %subst(qs : pos + 7);
  amp = %scan('&' : num);
  if amp > 0;
    num = %subst(num : 1 : amp - 1);
  endif;
  monitor;
    cuenta = %dec(num : 10 : 0);
  on-error;
    cuenta = 0;
  endmon;
endif;

html = 'Content-type: text/html' + x'25' + x'25';
html += '<!doctype html><html><head><meta charset="utf-8"><title>Estado de cuenta</title>';
html += '<style>body{font-family:sans-serif;margin:2em}td,th{padding:4px 10px;border-bottom:1px solid #ddd}</style></head><body>';
exec sql select l.nombre, c.moneda, c.saldo into :nombre, :moneda, :saldo
           from banco.cuentas c join banco.clientes l on l.cliente = c.cliente where c.cuenta = :cuenta;
if sqlcode <> 0;
  html += '<h1>Cuenta no encontrada</h1><p>Use ?cuenta=1001</p></body></html>';
else;
  html += '<h1>Estado de cuenta ' + %char(cuenta) + '</h1><p>' + %trim(nombre) + ' &middot; Saldo: <b>' + %char(saldo) + ' ' + moneda + '</b></p>';
  html += '<table><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Importe</th></tr>';
  exec sql declare m cursor for
    select varchar(char(fecha), 19), tipo, concepto, importe from banco.movimientos
     where cuenta = :cuenta order by movid desc fetch first 15 rows only;
  exec sql open m;
  exec sql fetch next from m into :fecha, :tipo, :concep, :importe;
  dow sqlcode = 0;
    html += '<tr><td>' + fecha + '</td><td>' + tipo + '</td><td>' + %trim(concep) + '</td><td style="text-align:right">' + %char(importe) + '</td></tr>';
    exec sql fetch next from m into :fecha, :tipo, :concep, :importe;
  enddo;
  exec sql close m;
  html += '</table><p><small>Generado por el programa RPG BANCO/BNKCGI (CGI)</small></p></body></html>';
endif;
QtmhWrStout(html : %len(html) : err);
*inlr = *on;`;

// ---------- Cajero 5250: BNKTELD (DSPF) + BNKTELLER (RPG) ----------
export const BNKTELD_DSPF = [
  A({ kw: 'DSPSIZ(24 80 *DS3)' }),
  A({ kw: "CA03(03 'Salir')" }),
  A({ type: 'R', name: 'PROMPT', kw: "TEXT('Cuenta a consultar')" }),
  A({ row: 1, col: 2, kw: "'BNKTELLER'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 1, col: 27, kw: "'Banco AS400 - Caja'" }),
  A({ kw: 'DSPATR(HI)' }),
  A({ row: 1, col: 71, kw: 'DATE' }),
  A({ kw: 'EDTCDE(Y)' }),
  A({ row: 2, col: 71, kw: 'TIME' }),
  A({ row: 3, col: 2, kw: "'Teclee la cuenta y pulse Intro.'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 5, col: 5, kw: "'Cuenta  . . . . . . . . .'" }),
  A({ name: 'CUENTA', len: 10, dt: 'Y', dec: 0, use: 'B', row: 5, col: 32, kw: 'EDTCDE(Z)' }),
  A({ cond: ' 90', kw: "ERRMSG('Cuenta inexistente.' 90)" }),
  A({ row: 7, col: 5, kw: "'Cuentas de prueba: 1001 a 1020'" }),
  A({ row: 23, col: 2, kw: "'F3=Salir'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ type: 'R', name: 'MOVSFL', kw: 'SFL' }),
  A({ name: 'MFECHA', len: 16, dt: 'A', use: 'O', row: 10, col: 2 }),
  A({ name: 'MTIPO', len: 2, dt: 'A', use: 'O', row: 10, col: 20 }),
  A({ name: 'MCONCEP', len: 30, dt: 'A', use: 'O', row: 10, col: 24 }),
  A({ name: 'MIMPORTE', len: 13, dt: 'Y', dec: 2, use: 'O', row: 10, col: 55, kw: 'EDTCDE(J)' }),
  A({ name: 'MCANAL', len: 4, dt: 'A', use: 'O', row: 10, col: 76 }),
  A({ type: 'R', name: 'MOVCTL', kw: 'SFLCTL(MOVSFL)' }),
  A({ kw: 'SFLSIZ(0050)' }),
  A({ kw: 'SFLPAG(0011)' }),
  A({ kw: "CA12(12 'Cancelar')" }),
  A({ kw: "CF06(06 'Transferir')" }),
  A({ kw: 'OVERLAY' }),
  A({ cond: ' 31', kw: 'SFLDSP' }),
  A({ kw: 'SFLDSPCTL' }),
  A({ cond: ' 33', kw: 'SFLCLR' }),
  A({ cond: ' 34', kw: 'SFLEND(*MORE)' }),
  A({ row: 1, col: 2, kw: "'BNKTELLER'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 1, col: 27, kw: "'Banco AS400 - Consulta'" }),
  A({ kw: 'DSPATR(HI)' }),
  A({ row: 1, col: 71, kw: 'DATE' }),
  A({ kw: 'EDTCDE(Y)' }),
  A({ row: 3, col: 2, kw: "'Cuenta:'" }),
  A({ name: 'CUENTA', len: 10, dt: 'Y', dec: 0, use: 'O', row: 3, col: 11, kw: 'EDTCDE(Z)' }),
  A({ name: 'NOMBRE', len: 40, dt: 'A', use: 'O', row: 3, col: 24, kw: 'COLOR(WHT)' }),
  A({ row: 4, col: 2, kw: "'Tipo:'" }),
  A({ name: 'TIPO', len: 3, dt: 'A', use: 'O', row: 4, col: 11 }),
  A({ row: 4, col: 17, kw: "'Moneda:'" }),
  A({ name: 'MONEDA', len: 3, dt: 'A', use: 'O', row: 4, col: 25 }),
  A({ row: 4, col: 31, kw: "'Estado:'" }),
  A({ name: 'ESTADO', len: 1, dt: 'A', use: 'O', row: 4, col: 39 }),
  A({ row: 5, col: 2, kw: "'Saldo . . . :'" }),
  A({ name: 'SALDO', len: 15, dt: 'Y', dec: 2, use: 'O', row: 5, col: 16, kw: 'EDTCDE(J)' }),
  A({ row: 5, col: 38, kw: "'Disponible:'" }),
  A({ name: 'DISPON', len: 15, dt: 'Y', dec: 2, use: 'O', row: 5, col: 50, kw: 'EDTCDE(J)' }),
  A({ cond: ' 51', row: 6, col: 2, kw: "'** Cuenta sin saldo disponible **'" }),
  A({ kw: 'COLOR(RED)' }),
  A({ row: 8, col: 2, kw: "'Ultimos movimientos'" }),
  A({ kw: 'DSPATR(HI)' }),
  A({ row: 9, col: 2, kw: "'Fecha             Tp  Concepto'" }),
  A({ kw: 'DSPATR(UL)' }),
  A({ row: 9, col: 59, kw: "'Importe  Canal'" }),
  A({ kw: 'DSPATR(UL)' }),
  A({ type: 'R', name: 'TECLAS' }),
  A({ row: 23, col: 2, kw: "'F3=Salir  F6=Transferir  F12=Otra'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ type: 'R', name: 'TRANSF', kw: "CA12(12 'Cancelar')" }),
  A({ row: 1, col: 2, kw: "'BNKTELLER'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 1, col: 27, kw: "'Banco AS400 - Transferencia'" }),
  A({ kw: 'DSPATR(HI)' }),
  A({ row: 3, col: 2, kw: "'Teclee los datos y pulse Intro.'" }),
  A({ kw: 'COLOR(BLU)' }),
  A({ row: 5, col: 5, kw: "'Cuenta origen . . . . . :'" }),
  A({ name: 'CUENTA', len: 10, dt: 'Y', dec: 0, use: 'O', row: 5, col: 32, kw: 'EDTCDE(Z)' }),
  A({ row: 6, col: 5, kw: "'Cuenta destino  . . . . .'" }),
  A({ name: 'DESTINO', len: 10, dt: 'Y', dec: 0, use: 'B', row: 6, col: 32, kw: 'EDTCDE(Z)' }),
  A({ row: 7, col: 5, kw: "'Importe . . . . . . . . .'" }),
  A({ name: 'IMPORTE', len: 13, dt: 'Y', dec: 2, use: 'B', row: 7, col: 32, kw: 'EDTCDE(J)' }),
  A({ row: 8, col: 5, kw: "'Concepto  . . . . . . . .'" }),
  A({ name: 'CONCEPTO', len: 40, dt: 'A', use: 'B', row: 8, col: 32, kw: 'CHECK(LC)' }),
  A({ row: 11, col: 5, kw: "'Resultado:'" }),
  A({ name: 'RESULT', len: 60, dt: 'A', use: 'O', row: 11, col: 16, kw: 'COLOR(WHT)' }),
  A({ row: 23, col: 2, kw: "'Intro=Transferir   F12=Volver'" }),
  A({ kw: 'COLOR(BLU)' }),
];

export const BNKTELLER = `**FREE
// BNKTELLER - Aplicacion de caja (cajero de sucursal) en pantalla verde 5250:
// consulta de cuenta con subarchivo de movimientos y transferencia (F6) llamando a BNKTRANSF.
ctl-opt dftactgrp(*no);

dcl-f BNKTELD workstn sfile(MOVSFL:rrn);

dcl-pr BNKTRANSF extpgm('BNKTRANSF');
  origen   packed(10:0) const;
  destino  packed(10:0) const;
  importe  packed(15:2) const;
  concepto char(60) const;
  canal    char(4) const;
  refer    char(35) const;
  folio    packed(15:0);
  rc       char(2);
  mensaje  char(60);
end-pr;

dcl-s rrn   packed(4:0);
dcl-s folio packed(15:0);
dcl-s rc    char(2);
dcl-s msg   char(60);
dcl-s conc  char(60);

dow not *in03;
  exfmt PROMPT;
  if *in03;
    leave;
  endif;
  *in90 = *off;
  exec sql select l.nombre, c.tipo, c.moneda, c.estado, c.saldo, c.disponible
             into :nombre, :tipo, :moneda, :estado, :saldo, :dispon
             from banco.cuentas c join banco.clientes l on l.cliente = c.cliente
            where c.cuenta = :cuenta;
  if sqlcode <> 0;
    *in90 = *on;
    iter;
  endif;

  dow not *in03 and not *in12;
    exsr cargar;
    write TECLAS;
    exfmt MOVCTL;
    if *in06;
      *in06 = *off;
      destino = 0;
      importe = 0;
      concepto = *blanks;
      result = *blanks;
      exfmt TRANSF;
      if not *in12;
        conc = concepto;
        BNKTRANSF(cuenta : destino : importe : conc : '5250' : 'CAJA' : folio : rc : msg);
        if rc = '00';
          result = 'Aplicada. Folio ' + %char(folio);
        else;
          result = 'Rechazada (' + rc + '): ' + msg;
        endif;
        exfmt TRANSF;
      endif;
      *in12 = *off;
      exec sql select saldo, disponible into :saldo, :dispon from banco.cuentas where cuenta = :cuenta;
    endif;
  enddo;
  *in12 = *off;
enddo;

*inlr = *on;

begsr cargar;
  *in33 = *on;
  write MOVCTL;
  *in33 = *off;
  *in51 = dispon <= 0;
  rrn = 0;
  exec sql declare cm cursor for
    select varchar(char(fecha), 16), tipo, substr(concepto, 1, 30), importe, canal
      from banco.movimientos where cuenta = :cuenta
     order by movid desc fetch first 50 rows only;
  exec sql open cm;
  exec sql fetch next from cm into :mfecha, :mtipo, :mconcep, :mimporte, :mcanal;
  dow sqlcode = 0;
    rrn += 1;
    write MOVSFL;
    exec sql fetch next from cm into :mfecha, :mtipo, :mconcep, :mimporte, :mcanal;
  enddo;
  exec sql close cm;
  *in31 = rrn > 0;
  *in34 = *on;
endsr;`;

export const BANK_SOURCES = [
  { file: 'QRPGLESRC', mbr: 'BNKSALDO', type: 'SQLRPGLE', text: 'Consulta de saldo (servicio)', src: BNKSALDO },
  { file: 'QRPGLESRC', mbr: 'BNKTRANSF', type: 'SQLRPGLE', text: 'Transferencia con COMMIT/ROLLBACK', src: BNKTRANSF },
  { file: 'QRPGLESRC', mbr: 'BNKAUTH', type: 'SQLRPGLE', text: 'Autorizacion ATM/POS (ISO 8583)', src: BNKAUTH },
  { file: 'QRPGLESRC', mbr: 'BNKEOD', type: 'SQLRPGLE', text: 'Cierre diario: intereses y reporte', src: BNKEOD },
  { file: 'QRPGLESRC', mbr: 'BNKCGI', type: 'SQLRPGLE', text: 'Estado de cuenta HTML (CGI)', src: BNKCGI },
  { file: 'QRPGLESRC', mbr: 'BNKTELLER', type: 'SQLRPGLE', text: 'Caja 5250: consulta y transferencia', src: BNKTELLER },
  { file: 'QDDSSRC', mbr: 'BNKTELD', type: 'DSPF', text: 'Pantallas de caja', lines: BNKTELD_DSPF },
  { file: 'QCLLESRC', mbr: 'BNKCIERRE', type: 'CLLE', text: 'Cierre diario del banco (lote)', src: BNKCIERRE },
];

export const BANK_COMPILE = [
  ['DSPF', 'BNKTELD', 'QDDSSRC'],
  ['SQLRPGLE', 'BNKSALDO', 'QRPGLESRC'],
  ['SQLRPGLE', 'BNKTRANSF', 'QRPGLESRC'],
  ['SQLRPGLE', 'BNKAUTH', 'QRPGLESRC'],
  ['SQLRPGLE', 'BNKEOD', 'QRPGLESRC'],
  ['SQLRPGLE', 'BNKCGI', 'QRPGLESRC'],
  ['SQLRPGLE', 'BNKTELLER', 'QRPGLESRC'],
  ['CLLE', 'BNKCIERRE', 'QCLLESRC'],
];
