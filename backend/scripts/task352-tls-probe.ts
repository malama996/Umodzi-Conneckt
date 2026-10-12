/**
 * task352-tls-probe.ts — Task 35.2 TLS evidence (READ-ONLY, no data touched).
 *
 * The Supabase pooler (Supavisor) speaks the PostgreSQL wire protocol:
 * a client must send an SSLRequest packet and read the 'S' reply before
 * TLS begins. A raw TLS handshake gets "wrong version number". This probe:
 *   1. Performs PG SSLRequest negotiation, then attempts a VERIFIED TLS
 *      handshake against the system trust store (= verify-full semantics).
 *   2. Captures the served certificate chain (public material) to
 *      backend/certs/pooler-chain.pem as an explicit trust anchor.
 *   3. Re-verifies using ONLY the captured anchor.
 *   4. Negative control: verification with an EMPTY anchor set must fail.
 *   5. End-to-end pg connection test with sslmode=verify-full + sslrootcert
 *      (exactly what the app will do after remediation), plus a negative
 *      control with an empty anchor file.
 * Prints only public certificate metadata. Never prints credentials or the
 * full connection string.
 */
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(here, '..', 'certs');
const PEM_PATH = path.join(CERT_DIR, 'pooler-chain.pem');
const EMPTY_PEM_PATH = path.join(CERT_DIR, 'empty-anchor.pem');

function hostFromUrl(u: string): { host: string; port: number } {
  const url = new URL(u);
  return { host: url.hostname, port: Number(url.port || 5432) };
}

function certMeta(cert: any, label: string): void {
  console.log(`  ${label}:`);
  console.log(`    subject: ${JSON.stringify(cert.subject)}`);
  console.log(`    issuer:  ${JSON.stringify(cert.issuer)}`);
  console.log(`    valid:   ${cert.valid_from} → ${cert.valid_to}`);
  console.log(`    san:     ${(cert.subjectaltname || '(none)').slice(0, 120)}`);
}

/** Send the 8-byte SSLRequest and resolve with the raw socket after 'S'. */
function pgSslNegotiate(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host, () => {
      // SSLRequest: int32 len=8, int32 code=80877103
      sock.write(Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]));
    });
    sock.once('data', (byte: Buffer) => {
      if (byte[0] === 0x53 /* 'S' */) resolve(sock);
      else {
        sock.destroy();
        reject(new Error(`server refused TLS negotiation (reply byte 0x${byte[0]?.toString(16)})`));
      }
    });
    sock.once('error', reject);
  });
}

async function startTls(
  sock: net.Socket,
  host: string,
  opts: { rejectUnauthorized: boolean; ca?: Buffer },
): Promise<{ authorized: boolean; error?: string; cert?: any }> {
  return new Promise((resolve) => {
    const ts = tls.connect(
      { socket: sock, servername: host, ...opts },
      () => {
        const cert = ts.getPeerCertificate(true);
        const out = {
          authorized: ts.authorized,
          error: ts.authorizationError ? String(ts.authorizationError) : undefined,
          cert,
        };
        ts.end();
        resolve(out);
      },
    );
    ts.once('error', (err: any) => resolve({ authorized: false, error: err.message }));
  });
}

function collectChain(cert: any): any[] {
  const chain: any[] = [];
  let current = cert;
  while (current && !chain.includes(current)) {
    chain.push(current);
    current = current.issuerCertificate;
  }
  return chain;
}

function toPem(chain: any[]): string {
  return chain
    .map((c) => {
      const b64 = Buffer.from(c.raw).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n+$/, '');
      return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
    })
    .join('');
}

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.MIGRATIONS_DATABASE_URL;
  if (!dbUrl) {
    console.error('No DATABASE_URL in env — cannot locate pooler host.');
    process.exit(1);
  }
  const { host, port } = hostFromUrl(dbUrl);
  console.log(`pooler host: ${host}:${port} (hostname only — URL never printed)`);

  // 1. Verified handshake against system trust store.
  console.log('\n=== A. PG-negotiated TLS, verified against SYSTEM trust ===');
  const sockA = await pgSslNegotiate(host, port).catch((e) => {
    console.log(`  negotiation failed: ${e.message}`);
    return null;
  });
  if (sockA) {
    const a = await startTls(sockA, host, { rejectUnauthorized: true });
    if (a.authorized) {
      console.log('  VERIFIED against system trust — verify-full needs no bundle.');
      certMeta(a.cert, 'leaf');
    } else {
      console.log(`  NOT verified against system trust: ${a.error}`);
      if (a.cert?.subject) certMeta(a.cert, 'leaf (served anyway)');
    }
  }

  // 2. Capture served chain as an explicit trust anchor.
  console.log('\n=== B. Capture served chain (public material) ===');
  const sockB = await pgSslNegotiate(host, port);
  const b = await startTls(sockB, host, { rejectUnauthorized: false });
  let pem = '';
  if (b.cert?.subject) {
    const chain = collectChain(b.cert);
    console.log(`  chain length: ${chain.length}`);
    chain.forEach((c, i) => certMeta(c, `chain[${i}]`));
    fs.mkdirSync(CERT_DIR, { recursive: true });
    pem = toPem(chain);
    fs.writeFileSync(PEM_PATH, pem);
    console.log(`  wrote ${chain.length} cert(s) to certs/pooler-chain.pem`);
    // Empty-anchor file for the pg-level negative control.
    fs.writeFileSync(EMPTY_PEM_PATH, '');
  } else {
    console.log('  no certificate served.');
  }

  // 3. Verify using ONLY the captured anchor.
  console.log('\n=== C. Verified handshake with CAPTURED anchor only ===');
  if (pem) {
    const sockC = await pgSslNegotiate(host, port);
    const c = await startTls(sockC, host, {
      rejectUnauthorized: true,
      ca: fs.readFileSync(PEM_PATH),
    });
    console.log(
      c.authorized
        ? '  VERIFIED OK with captured anchor.'
        : `  FAILED with captured anchor: ${c.error}`,
    );
  }

  // 4. Negative control at TLS level: empty anchor set must be rejected.
  console.log('\n=== D. Negative control: empty anchor set must REJECT ===');
  const sockD = await pgSslNegotiate(host, port);
  const d = await startTls(sockD, host, { rejectUnauthorized: true, ca: [] });
  console.log(
    d.authorized
      ? '  UNEXPECTED: verified with no anchors!'
      : `  correctly REJECTED: ${d.error}`,
  );

  // 5. End-to-end pg test with sslmode=verify-full + sslrootcert, exactly as
  //    the app will run it after remediation. Also the negative control.
  console.log('\n=== E. pg end-to-end: verify-full + sslrootcert ===');
  const url = new URL(dbUrl);
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.set('sslrootcert', PEM_PATH);
  try {
    const pool = new Pool({ connectionString: url.toString() });
    const r = await pool.query('SELECT CURRENT_USER AS u');
    console.log(`  verify-full CONNECTED (role=${r.rows[0].u}).`);
    await pool.end();
  } catch (e: any) {
    console.log(`  verify-full FAILED: ${e.message.split('\n')[0]}`);
  }

  console.log('\n=== F. Negative control: verify-full with EMPTY anchor file ===');
  const url2 = new URL(dbUrl);
  url2.searchParams.set('sslmode', 'verify-full');
  url2.searchParams.set('sslrootcert', EMPTY_PEM_PATH);
  try {
    const pool2 = new Pool({ connectionString: url2.toString() });
    await pool2.query('SELECT 1');
    console.log('  UNEXPECTED: connected with an empty anchor file!');
    await pool2.end();
  } catch (e: any) {
    console.log(`  correctly REJECTED: ${e.message.split('\n')[0]}`);
  }
}

main();
