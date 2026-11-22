// Certificados del sistema (equivalente a Digital Certificate Manager): una CA local y un certificado de servidor
// firmado por ella, guardados en el IFS (/QIBM/UserData/ICSS/Cert/Server). Los usan TELNET-SSL (992), FTPS,
// los servidores host SSL (9470-9476), Mapepire (wss) y HTTPS. La CA se descarga en /api/v1/certs/ca.crt.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { real } from '../ifs.js';
import { SYS } from '../system.js';

const DIR = '/QIBM/UserData/ICSS/Cert/Server';
let cache = null;

export function certPaths() {
  const d = real(DIR);
  return { dir: d, caKey: path.join(d, 'ca.key'), caCrt: path.join(d, 'ca.crt'), key: path.join(d, 'server.key'), crt: path.join(d, 'server.crt') };
}

/** Devuelve {key, cert, ca} (Buffers) generándolos con openssl la primera vez. null si no hay openssl. */
export function tlsCredentials() {
  if (cache) return cache;
  const p = certPaths();
  if (process.env.TLS_CERT && process.env.TLS_KEY) {
    cache = { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT), ca: process.env.TLS_CA ? fs.readFileSync(process.env.TLS_CA) : null };
    return cache;
  }
  if (!fs.existsSync(p.crt) || !fs.existsSync(p.key)) {
    try { generate(p); } catch (e) {
      console.error(`[tls] no se pudo generar el certificado (¿falta openssl?): ${e.message}`);
      return null;
    }
  }
  cache = { key: fs.readFileSync(p.key), cert: fs.readFileSync(p.crt), ca: fs.existsSync(p.caCrt) ? fs.readFileSync(p.caCrt) : null };
  return cache;
}

function generate(p) {
  fs.mkdirSync(p.dir, { recursive: true });
  const run = (args) => execFileSync('openssl', args, { stdio: 'pipe' });
  const host = String(SYS.name).toLowerCase();
  const extra = String(process.env.TLS_HOSTNAMES || '').split(/[\s,]+/).filter(Boolean);
  const names = [...new Set(['localhost', host, 'ibmi-core', 'as400', os.hostname(), ...extra])];
  const ips = ['127.0.0.1', '::1', ...String(process.env.TLS_IPS || '').split(/[\s,]+/).filter(Boolean)];
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', p.caKey, '-out', p.caCrt, '-subj', `/O=AS400 para Todos/CN=${SYS.name} Local CA`]);
  const csr = path.join(p.dir, 'server.csr');
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', p.key, '-out', csr, '-subj', `/O=AS400 para Todos/CN=${host}`]);
  const ext = path.join(p.dir, 'server.ext');
  fs.writeFileSync(ext, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${[...names.map((n) => `DNS:${n}`), ...ips.map((i) => `IP:${i}`)].join(',')}\n`);
  run(['x509', '-req', '-in', csr, '-CA', p.caCrt, '-CAkey', p.caKey, '-CAcreateserial', '-out', p.crt, '-days', '825', '-sha256', '-extfile', ext]);
  for (const f of [csr, ext]) { try { fs.unlinkSync(f); } catch { /* ignorar */ } }
  console.log(`[tls] certificado de servidor generado para ${names.join(', ')} (CA: ${DIR}/ca.crt)`);
}

export function certInfo() {
  const c = tlsCredentials();
  if (!c) return null;
  const x = new X509Certificate(c.cert);
  return { subject: x.subject, issuer: x.issuer, validFrom: x.validFrom, validTo: x.validTo, subjectAltName: x.subjectAltName, fingerprint256: x.fingerprint256 };
}
