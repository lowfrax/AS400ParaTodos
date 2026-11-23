// Módulos opcionales que registran servidores TCP/IP, rutas HTTP y datos durante el IPL:
// core bancario (ISO 8583, Open Banking, SWIFT…), servidores host de IBM i Access (jt400/ODBC/ACS), SSH, SNMP, NTP y LPD.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODULES = ['./bank/index.js', './net/hostsvr/index.js', './net/ssh.js', './net/extras.js'];

export async function loadExtensions() {
  for (const m of MODULES) {
    const url = new URL(m, import.meta.url);
    if (!fs.existsSync(fileURLToPath(url))) continue;
    try {
      const mod = await import(url.href);
      if (mod.register) await mod.register();
    } catch (e) {
      console.error(`[ipl] extensión ${m}: ${e.stack || e.message}`);
    }
  }
}
