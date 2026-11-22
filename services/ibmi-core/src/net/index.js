// Registro de los servidores TCP/IP del sistema. Se arrancan al final del IPL (como STRTCP + STRTCPSVR *AUTOSTART)
// y se gestionan con STRTCPSVR/ENDTCPSVR, NETSTAT, la API /api/v1/network y el panel /dashboard/.
import { defineServer, startAll } from './servers.js';
import { telnetServerDef } from './telnet.js';
import { ftpServerDef } from './ftp.js';
import { rexecServerDef } from './rexec.js';
import { httpServerDef } from './http/server.js';
import { mapepireServerDef } from './mapepire.js';
import { tlsCredentials } from './tls.js';

const extra = [];
/** Otros módulos (core bancario, servidores host, SSH…) añaden sus servidores antes del arranque. */
export function addServer(defFactory) { extra.push(defFactory); }

export async function initNetwork(api) {
  const full = { tls: tlsCredentials, upgradeHandlers: [], ...api };
  for (const f of [telnetServerDef, ftpServerDef, rexecServerDef, httpServerDef, mapepireServerDef, ...extra]) defineServer(f(full));
  await startAll();
}
