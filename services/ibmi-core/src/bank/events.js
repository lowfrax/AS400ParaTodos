// Monitor de la cola de datos BANCO/BNKEVENTS (como un "data queue listener" en Java): cada evento que publican los
// programas RPG se reenvía a webhooks externos (BANK_WEBHOOKS, firmados con HMAC-SHA256), se avisa por correo de las
// operaciones grandes (BANK_ALERT_AMOUNT) y queda disponible en /api/banco/eventos (JSON y SSE).
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolveDtaq, receiveDtaq } from '../dtaq.js';
import { httpRequest } from '../net/httpclient.js';

export const bankEvents = new EventEmitter();
const recent = [];
export const recentEvents = () => recent.slice(-100);

async function deliver(ev) {
  const hooks = String(process.env.BANK_WEBHOOKS || '').split(/[\s,]+/).filter(Boolean);
  const body = JSON.stringify(ev);
  const sig = crypto.createHmac('sha256', process.env.BANK_WEBHOOK_SECRET || 'banco-webhook').update(body).digest('hex');
  for (const url of hooks) {
    httpRequest({ method: 'POST', url, headers: { 'Content-Type': 'application/json', 'X-Banco-Event': ev.evento || 'EVENTO', 'X-Banco-Signature': `sha256=${sig}` }, body, timeout: 5000, client: 'BNKEVENTS' })
      .catch((e) => { ev.webhookError = e.message; });
  }
}

async function alertMail(ctx, ev) {
  const limit = Number(process.env.BANK_ALERT_AMOUNT || 100000);
  if (!(Number(ev.importe) >= limit)) return;
  const r = await ctx.sql('SELECT L.EMAIL, L.NOMBRE FROM BANCO.CUENTAS C JOIN BANCO.CLIENTES L ON L.CLIENTE = C.CLIENTE WHERE C.CUENTA = ?', [Number(ev.origen)]);
  const [email, nombre] = r.rows?.[0] || [];
  if (!email) return;
  const { sendMail } = await import('../net/smtp.js');
  await sendMail({
    from: 'alertas@banco.local', to: [email], subject: `Alerta: transferencia de ${ev.importe} ${ev.moneda}`,
    text: `Estimado(a) ${nombre}:\n\nSe aplicó una transferencia desde su cuenta ${ev.origen} a la cuenta ${ev.destino} por ${ev.importe} ${ev.moneda} (folio ${ev.folio}, canal ${ev.canal}).\n\nSi usted no la reconoce, llame a su sucursal.\n\nBanco AS400 para Todos`,
    client: 'BNKEVENTS',
  }).catch(() => {});
}

/** Bucle consumidor de BNKEVENTS (recepción destructiva con espera, como QRCVDTAQ con WAIT -1). */
export function startEventMonitor(getCtx) {
  let stop = false;
  (async () => {
    let q = null;
    while (!stop) {
      try {
        const ctx = await getCtx();
        q = q || (await resolveDtaq('BNKEVENTS', 'BANCO', []));
        const e = await receiveDtaq(q, { wait: 30 });
        if (!e) continue;
        let ev;
        try { ev = JSON.parse(e.data); } catch { ev = { evento: 'TEXTO', data: e.data }; }
        ev.recibido = new Date().toISOString();
        recent.push(ev);
        if (recent.length > 500) recent.shift();
        bankEvents.emit('event', ev);
        deliver(ev);
        alertMail(ctx, ev).catch(() => {});
      } catch (err) {
        await new Promise((r) => setTimeout(r, 5000));
        q = null;
        if (!String(err.message).includes('not found')) console.error('[banco] monitor BNKEVENTS:', err.message);
      }
    }
  })();
  return () => { stop = true; };
}
