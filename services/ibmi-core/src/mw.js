// Indicador "Message Waiting" (MW) del área de información del operador.
import { sessions } from './session.js';
import { newMessageCount } from './objects.js';

export async function refreshMW(user) {
  for (const s of sessions) {
    if (!s.job || (user && s.job.user !== user)) continue;
    try {
      const n = await newMessageCount(s.job.user);
      s.setMessageWaiting(n > 0);
    } catch { /* gateway no disponible */ }
  }
}
