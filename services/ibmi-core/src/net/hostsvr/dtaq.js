// as-dtaq (servidor de colas de datos, QZHQSSRV): jt400 DataQueue / KeyedDataQueue, IBM i Access .NET.
// Las entradas se convierten EBCDIC (CCSID 37) ⇄ texto, como DataQueue.write(String) / read().getString().
import { SERVER_ID, reply, parseCPs, u16, u32, ebc, unebc } from './ds.js';
import { resolveDtaq, sendDtaq, receiveDtaq, clearDtaq, createDtaq, deleteDtaq } from '../../dtaq.js';

const OK = 0xf000;
const common = (f, rc, msg) => reply(f, SERVER_ID.DTAQ, 0x8002, u16(rc), msg ? [[0x5003, ebc(msg)]] : []);
const errMsg = (e) => `${(e.msgId || 'CPF9898').padEnd(7)}  ${e.message}`;

export async function handleDtaq(st, f, write) {
  const rr = f.readUInt16BE(18);
  if (rr === 0x0000) { write(reply(f, SERVER_ID.DTAQ, 0x8000, u32(1))); return; }
  const name = unebc(f.subarray(20, 30)).trim().toUpperCase();
  const lib = unebc(f.subarray(30, 40)).trim().toUpperCase() || '*LIBL';
  try {
    if (rr === 0x0003) { // crear
      const type = f[46] & 0x0f;
      await createDtaq(lib === '*LIBL' || lib === '*CURLIB' ? st.ctx.curlib : lib, name, { maxlen: f.readUInt32BE(40), seq: type === 2 ? '*KEYED' : type === 1 ? '*LIFO' : '*FIFO', keylen: f.readUInt16BE(47), senderInfo: f[45] === 0xf1, text: unebc(f.subarray(50, 100)).trim(), owner: st.prf.NAME });
      write(common(f, OK));
      return;
    }
    const q = await resolveDtaq(name, lib, st.ctx.libl);
    if (rr === 0x0001) { // atributos
      const t = Buffer.alloc(61, 0x40);
      t.writeUInt16BE(0, 0);
      t.writeUInt32BE(q.maxlen || 64512, 2);
      t[6] = q.senderInfo ? 0xf1 : 0xf0;
      t[7] = q.seq === '*KEYED' ? 0xf2 : q.seq === '*LIFO' ? 0xf1 : 0xf0;
      t.writeUInt16BE(q.keylen || 0, 8);
      t[10] = 0xf0;
      ebc(q.text || '', 50).copy(t, 11);
      write(reply(f, SERVER_ID.DTAQ, 0x8001, t));
      return;
    }
    if (rr === 0x0004) { await deleteDtaq(q.lib, q.name); write(common(f, OK)); return; }
    const cps = parseCPs(f, rr === 0x0005 ? 42 : rr === 0x0006 ? 41 : 48);
    const key = cps.get(0x5002) ? unebc(cps.get(0x5002)) : undefined;
    if (rr === 0x0005) { // escribir
      await sendDtaq(q, unebc(cps.get(0x5001) || Buffer.alloc(0)).replace(/\s+$/, ''), { key: key || '', sender: q.senderInfo ? st.ctx.client : '' });
      write(common(f, OK));
      return;
    }
    if (rr === 0x0006) { await clearDtaq(q, { key }); write(common(f, OK)); return; }
    if (rr === 0x0002) { // leer / mirar
      const order = unebc(f.subarray(41, 43)).trim() || 'EQ';
      const wait = f.readInt32BE(43);
      const e = await receiveDtaq(q, { wait: wait < 0 ? -1 : wait, order, key, peek: f[47] === 0xf1 });
      if (!e) { write(common(f, 0xf006)); return; }
      const sender = ebc(String(e.sender || ''), 36);
      const params = [[0x5001, ebc(e.data)]];
      if (q.seq === '*KEYED') params.push([0x5002, ebc(e.key || '', q.keylen)]);
      write(reply(f, SERVER_ID.DTAQ, 0x8003, Buffer.concat([u16(0), sender]), params));
      return;
    }
    write(common(f, 0xf002));
  } catch (e) {
    write(common(f, 0xf001, errMsg(e)));
  }
}
