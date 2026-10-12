/**
 * task352-switch-connection.ts — Task 35.2 Stage 4 (DB-2/DB-3 switch).
 *
 * Rewrites backend/.env (programmatically, values NEVER printed):
 *   - MIGRATIONS_DATABASE_URL := previous admin URL, upgraded to
 *     sslmode=verify-full + sslrootcert (full TLS verification for DDL).
 *   - DATABASE_URL            := the restricted runtime URL
 *     (APP_DATABASE_URL written by task352-create-runtime-role.ts), which
 *     already carries verify-full + sslrootcert.
 *   - APP_DATABASE_URL line is removed (its value becomes DATABASE_URL).
 *
 * Preconditions (fail-hard if unmet):
 *   - APP_DATABASE_URL exists in .env (role created and login-tested).
 *   - Trust anchor file exists.
 * Rollback: swap the two values back (documented in STATE.md §29).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(here, '..', '.env');
const PEM_PATH = path.join(here, '..', 'certs', 'pooler-chain.pem').replace(/\\/g, '/');

function fail(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

// Load ONLY to detect preconditions; the rewrite works on raw text.
dotenv.config({ path: ENV_PATH });

if (!fs.existsSync(PEM_PATH)) fail('Trust anchor certs/pooler-chain.pem missing');
if (!process.env.APP_DATABASE_URL) fail('APP_DATABASE_URL missing — run task352-create-runtime-role.ts first');
if (!process.env.DATABASE_URL) fail('DATABASE_URL missing from backend/.env');

const pemPathAbs = path.join(here, '..', 'certs', 'pooler-chain.pem');

function withVerifiedTls(raw: string): string {
  const u = new URL(raw);
  u.searchParams.set('sslmode', 'verify-full');
  u.searchParams.set('sslrootcert', pemPathAbs);
  return u.toString();
}

const adminUrl = withVerifiedTls(process.env.DATABASE_URL); // previous admin URL
const runtimeUrl = process.env.APP_DATABASE_URL; // already verify-full

let env = fs.readFileSync(ENV_PATH, 'utf8');
env = env.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${runtimeUrl}`);
env = env.replace(/^MIGRATIONS_DATABASE_URL=.*$/m, `MIGRATIONS_DATABASE_URL=${adminUrl}`);
if (!/^MIGRATIONS_DATABASE_URL=/m.test(env)) {
  env = env.trimEnd() + `\nMIGRATIONS_DATABASE_URL=${adminUrl}\n`;
}
env = env.replace(/^APP_DATABASE_URL=.*\n?/m, '');
fs.writeFileSync(ENV_PATH, env);

console.log('backend/.env rewritten:');
console.log('  DATABASE_URL            → restricted runtime role (verify-full + sslrootcert)');
console.log('  MIGRATIONS_DATABASE_URL → admin role, upgraded to verify-full + sslrootcert');
console.log('  APP_DATABASE_URL        → removed (value moved to DATABASE_URL)');
console.log('(no values printed)');
