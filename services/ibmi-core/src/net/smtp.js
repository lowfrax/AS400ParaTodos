// Cliente SMTP del sistema (SNDSMTPEMM, avisos del core bancario, extractos): EHLO, STARTTLS opcional, AUTH LOGIN/PLAIN,
// MIME con adjuntos. Por omisión entrega a Mailpit (SMTP_HOST=mailpit, puerto 1025) para ver los correos en http://localhost:8025.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { SYS } from '../system.js';
import { outboundEvents } from './httpclient.js';

export const mailLog = [];
const NL = '\n';
const CR_END = /\r$/;

function smtpSession(sock) {
  let buf = '';
  let cur = [];
  const waiters = [];
  const ready = [];
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf(NL)) >= 0) {
      const line = buf.slice(0, i).replace(CR_END, '');
      buf = buf.slice(i + 1);
      cur.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        const resp = { code: Number(line.slice(0, 3)), text: cur.map((l) => l.slice(4)).join('\n') };
        cur = [];
        const w = waiters.shift();
        if (w) w(resp); else ready.push(resp);
      }
    }
  });
  const read = () => (ready.length ? Promise.resolve(ready.shift()) : new Promise((res) => waiters.push(res)));
  const cmd = async (line, expect) => {
    if (line !== null) sock.write(`${line}\r\n`);
    const r = await read();
    if (expect && !expect.includes(Math.floor(r.code / 100) * 100) && !expect.includes(r.code)) throw new Error(`SMTP ${r.code} ${r.text} (after ${String(line).split(' ')[0]})`);
    return r;
  };
  return { cmd };
}

const b64 = (s) => Buffer.from(s).toString('base64');
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildMime({ from, to, subject, text = '', html = false, attachments = [] }) {
  const boundary = `----=_AS400_${crypto.randomBytes(8).toString('hex')}`;
  const headers = [
    `From: ${from}`, `To: ${to.join(', ')}`, `Subject: ${encHeader(subject)}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${SYS.name.toLowerCase()}.local>`, 'MIME-Version: 1.0', `X-Mailer: IBM i SMTP (${SYS.name} ${SYS.release})`,
  ];
  const bodyPart = [`Content-Type: text/${html ? 'html' : 'plain'}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', wrap76(b64(text))].join('\r\n');
  if (!attachments.length) return `${headers.join('\r\n')}\r\n${bodyPart}\r\n`;
  const parts = [bodyPart, ...attachments.map((a) => [`Content-Type: ${a.type || 'application/octet-stream'}; name="${a.name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${a.name}"`, '', wrap76(Buffer.from(a.data).toString('base64'))].join('\r\n'))];
  return `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('')}--${boundary}--\r\n`;
}

/** Envía un correo. Lanza Error con el texto SMTP si falla. */
export async function sendMail({ from, to, subject, text, html, attachments, client = '' }) {
  if (!to?.length) throw new Error('No recipients.');
  const host = process.env.SMTP_HOST || 'mailpit';
  const port = Number(process.env.SMTP_PORT || 1025);
  const t0 = Date.now();
  const entry = { t: t0, method: 'SMTP', url: `smtp://${host}:${port}`, client, to: to.join(','), subject, status: 0, ms: 0, bytes: 0 };
  let sock = await new Promise((res, rej) => {
    const s = process.env.SMTP_SECURE === 'true' ? tls.connect({ host, port, rejectUnauthorized: false }, () => res(s)) : net.connect(port, host, () => res(s));
    s.setTimeout(20000, () => s.destroy(new Error('SMTP timeout')));
    s.once('error', rej);
  });
  try {
    let s = smtpSession(sock);
    await s.cmd(null, [200]);
    let ehlo = await s.cmd(`EHLO ${SYS.name.toLowerCase()}.local`, [200]);
    if (/STARTTLS/i.test(ehlo.text) && process.env.SMTP_STARTTLS !== 'false' && !(sock instanceof tls.TLSSocket)) {
      await s.cmd('STARTTLS', [200]);
      sock = tls.connect({ socket: sock, rejectUnauthorized: false, servername: host });
      await new Promise((r) => sock.once('secureConnect', r));
      s = smtpSession(sock);
      ehlo = await s.cmd(`EHLO ${SYS.name.toLowerCase()}.local`, [200]);
    }
    if (process.env.SMTP_USER) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) await s.cmd(`AUTH PLAIN ${b64(`\0${process.env.SMTP_USER}\0${process.env.SMTP_PASSWORD || ''}`)}`, [200]);
      else { await s.cmd('AUTH LOGIN', [300]); await s.cmd(b64(process.env.SMTP_USER), [300]); await s.cmd(b64(process.env.SMTP_PASSWORD || ''), [200]); }
    }
    const addr = (x) => (/<.+>/.test(x) ? x.match(/<(.+)>/)[1] : x);
    await s.cmd(`MAIL FROM:<${addr(process.env.SMTP_FROM || from)}>`, [200]);
    for (const r of to) await s.cmd(`RCPT TO:<${addr(r)}>`, [200]);
    await s.cmd('DATA', [300]);
    const mime = buildMime({ from: process.env.SMTP_FROM || from, to, subject, text, html, attachments: attachments || [] });
    const dotted = mime.replace(/\r\n\./g, '\r\n..');
    entry.bytes = dotted.length;
    const r = await s.cmd(`${dotted}\r\n.`, [200]);
    await s.cmd('QUIT', [200]).catch(() => {});
    entry.status = 250;
    mailLog.push({ t: t0, from, to, subject, attachments: (attachments || []).map((a) => a.name), result: r.text });
    if (mailLog.length > 100) mailLog.shift();
    return r;
  } catch (e) {
    entry.error = e.message;
    throw e;
  } finally {
    entry.ms = Date.now() - t0;
    outboundEvents.emit('request', entry);
    try { sock.end(); } catch { /* ignorar */ }
  }
}
