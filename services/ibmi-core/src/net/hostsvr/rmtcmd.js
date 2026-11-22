// as-rmtcmd (servidor de mandatos remotos y llamadas a programas, trabajos QZRCSRVS):
// jt400 CommandCall / ProgramCall / ServiceProgramCall, IBM i Access "RMTCMD", .NET iDB2Command.
import { SERVER_ID, reply, parseCPs, u16, u32, ebc, unebc, decodeText, decompressRLE, decodeParam, encodeParam, byteLength } from './ds.js';
import { runCmd, callPgm, describeProgram } from '../../svc/jobs.js';
import { tagConnection } from '../servers.js';

const TYPE_CODE = { '*COMP': 1, '*DIAG': 2, '*INFO': 4, '*INQ': 5, '*RQS': 8, '*ESCAPE': 15, '*NOTIFY': 14 };

/** Mensaje en formato 0x1106 (AS400ImplRemote.parseMessage). */
export function messageCP({ id = '', text = '', sev = 0, type = '*INFO' }) {
  const t = String(TYPE_CODE[type] ?? (sev >= 30 ? 15 : 1)).padStart(2, '0');
  const field = (b) => Buffer.concat([u32(b.length), b]);
  return [0x1106, Buffer.concat([
    u32(37), u32(37), u16(Math.min(99, sev)),
    field(ebc(t)), field(ebc(String(id).padEnd(7).slice(0, 7))), field(ebc('QCPFMSG', 10)), field(ebc('QSYS', 10)),
    field(ebc(String(text))), field(Buffer.alloc(0)), field(ebc('')),
  ])];
}

function messagesOf(r) {
  if (r.ok) return r.messages.map((m) => ({ ...m, type: '*COMP' }));
  const diags = (r.joblog || []).filter((e) => e.type === '*DIAG').map((e) => ({ id: e.id, text: e.text, sev: e.sev || 30, type: '*DIAG' }));
  return [...diags, { ...r.error, type: '*ESCAPE' }];
}

export async function handleRmtcmd(st, f, write) {
  const rr = f.readUInt16BE(18);
  if (rr === 0x1001) { // intercambio de atributos: CCSID 37, NLV 2924, versión 1, nivel de flujo 10
    write(reply(f, SERVER_ID.RMTCMD, 0x8001, Buffer.concat([u16(0), u32(37), ebc('2924'), u32(1), u16(10)])));
    return;
  }
  if (rr === 0x1002) { // ejecutar mandato
    const cps = parseCPs(f, 21);
    let cmd = '';
    if (cps.has(0x1104)) { const d = cps.get(0x1104); cmd = decodeText(d.subarray(4), d.readUInt32BE(0)); } else if (cps.has(0x1101)) cmd = unebc(cps.get(0x1101));
    tagConnection(st.conn, { detail: `RMTCMD ${cmd.trim().split(/\s|\(/)[0]}` });
    const r = await runCmd(st.ctx, cmd.trim());
    const msgs = messagesOf(r);
    write(reply(f, SERVER_ID.RMTCMD, 0x8002, Buffer.concat([u16(r.ok ? 0 : 0x0400), u16(msgs.length)]), msgs.map(messageCP)));
    return;
  }
  if (rr === 0x1003) { // llamar a un programa
    const pgm = unebc(f.subarray(20, 30)).trim().toUpperCase();
    const lib = unebc(f.subarray(30, 40)).trim().toUpperCase() || '*LIBL';
    const n = f.readUInt16BE(41);
    const parms = [];
    let o = 43;
    for (let i = 0; i < n; i++) {
      const ll = f.readUInt32BE(o);
      const maxLen = f.readUInt32BE(o + 6);
      const usage = f.readUInt16BE(o + 10);
      const raw = f.subarray(o + 12, o + ll);
      let data;
      if (usage === 21 || usage === 23) data = decompressRLE(raw, maxLen);
      else { data = Buffer.alloc(maxLen); raw.copy(data, 0, 0, Math.min(raw.length, maxLen)); }
      const base = usage % 10; // 1 entrada, 2 salida, 3 entrada/salida
      parms.push({ maxLen, usage, base, data });
      o += ll;
    }
    tagConnection(st.conn, { detail: `RMTPGM ${lib}/${pgm}` });
    let desc;
    try { desc = await describeProgram(st.ctx, pgm, lib); } catch (e) {
      const m = { id: e.msgId || 'CPF9811', text: e.message, sev: 40, type: '*ESCAPE' };
      write(reply(f, SERVER_ID.RMTCMD, 0x8003, Buffer.concat([u16(0x0500), u16(1)]), [messageCP(m)]));
      return;
    }
    // Bytes → valores según los tipos del *ENTRY / DCL-PI del programa (char EBCDIC, packed, zoned, binario…)
    const values = parms.map((p, i) => {
      const t = desc.params[i]?.type || { t: 'char', len: p.maxLen };
      try { return decodeParam(p.data, t); } catch { return unebc(p.data); }
    });
    let r;
    try { r = await callPgm(st.ctx, pgm, lib, values, desc); } catch (e) {
      const m = { id: e.msgId || 'CPF9898', text: e.message, sev: 40, type: '*ESCAPE' };
      write(reply(f, SERVER_ID.RMTCMD, 0x8003, Buffer.concat([u16(0x0501), u16(1)]), [messageCP(m)]));
      return;
    }
    const outs = [];
    parms.forEach((p, i) => {
      if (p.base !== 2 && p.base !== 3 && p.usage !== 22) return;
      const t = desc.params[i]?.type || { t: 'char', len: p.maxLen };
      const enc = encodeParam(r.values[i], t);
      const data = Buffer.alloc(p.maxLen);
      enc.copy(data, 0, 0, Math.min(enc.length, p.maxLen, byteLength(t) || p.maxLen));
      outs.push([0x1103, Buffer.concat([u32(p.maxLen), u16(12), data])]);
    });
    write(reply(f, SERVER_ID.RMTCMD, 0x8003, Buffer.concat([u16(0), u16(outs.length)]), outs));
    return;
  }
  // Petición no soportada (p. ej. llamada a programa de servicio 0x1004)
  write(reply(f, SERVER_ID.RMTCMD, rr | 0x8000, Buffer.concat([u16(0x0205), u16(0)])));
}
