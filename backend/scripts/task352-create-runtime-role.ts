/**
 * task352-create-runtime-role.ts — Task 35.2 Stage 2 (DB-2).
 *
 * Creates the dedicated least-privilege runtime role `umodzi_app`:
 *   LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOBYPASSRLS, NOREPLICATION.
 * Grants (least privilege, verified against the Task 35.1 permission map):
 *   - USAGE on schema public
 *   - SELECT/INSERT/UPDATE/DELETE on the 13 application tables
 *   - NO privileges on schema_migrations (migration bookkeeping is admin-only)
 *   - USAGE/SELECT on sequences (currently none exist — future-proofing)
 *   - TEMPORARY on the database (test pools create temp working sets)
 *
 * Credentials: a strong random password is generated in-process and written
 * ONLY into backend/.env (APP_DATABASE_URL). It is never printed, logged,
 * or committed. Re-running regenerates and rewrites (idempotent by design).
 *
 * Verification performed here (fail-hard, no silent success):
 *   1. Catalog checks: role attributes (no super/createrole/createdb/bypassrls)
 *      and has_table_privilege per table (DML yes, TRUNCATE no, ledger no).
 *   2. A REAL login as umodzi_app through the Supabase pooler with full TLS
 *      verification (sslmode=verify-full + sslrootcert), running SELECTs
 *      and confirming schema_migrations is denied.
 *      Falls back to the direct endpoint if the pooler rejects the custom
 *      role; stops with a clear error if neither works.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(here, '..', '.env');
const PEM_PATH = path.join(here, '..', 'certs', 'pooler-chain.pem').replace(/\\/g, '/');

const ROLE = 'umodzi_app';
const APP_TABLES = [
  'users',
  'sessions',
  'technicians',
  'service_requests',
  'dispatch_offers',
  'conversations',
  'messages',
  'notifications',
  'push_subscriptions',
  'user_phones',
  'technician_verification_documents',
  'reviews',
  'audit_events',
];

function fail(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) fail('DATABASE_URL missing from backend/.env');
if (!fs.existsSync(PEM_PATH)) {
  fail(`Trust anchor missing at certs/pooler-chain.pem — run task352-tls-probe.ts first`);
}

const adminUrlParsed = new URL(adminUrl);
const projectRef = adminUrlParsed.username.includes('.')
  ? adminUrlParsed.username.split('.').slice(1).join('.')
  : null;
if (!projectRef) fail('Cannot derive project ref from admin username');

/** Build a pooler URL for a given role, with FULL TLS verification. */
function poolerUrl(role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = `${role}.${projectRef}`;
  u.password = password;
  u.searchParams.set('sslmode', 'verify-full');
  u.searchParams.set('sslrootcert', PEM_PATH);
  return u.toString();
}

/** Direct (non-pooler) endpoint URL for the same project. */
function directUrl(role: string, password: string): string {
  const u = new URL(adminUrl);
  u.hostname = `${projectRef}.db.supabase.com`;
  u.port = '5432';
  u.username = role;
  u.password = password;
  u.searchParams.set('sslmode', 'verify-full');
  u.searchParams.set('sslrootcert', PEM_PATH);
  return u.toString();
}

async function main() {
  const admin = new Pool({ connectionString: adminUrl });
  try {
    // ---- 1. Create / update the role (password never printed). ----
    const password = crypto.randomBytes(24).toString('base64url');
    const exists = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ROLE]);
    if (exists.rows.length === 0) {
      await admin.query(
        `CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}' ` +
          `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION`,
      );
      console.log(`role ${ROLE}: CREATED (login, no super/createrole/createdb/bypassrls/replication)`);
    } else {
      await admin.query(`ALTER ROLE ${ROLE} LOGIN PASSWORD '${password}'`);
      console.log(`role ${ROLE}: already existed — password rotated in place`);
    }

    // ---- 2. Least-privilege grants. ----
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    for (const t of APP_TABLES) {
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${ROLE}`);
    }
    await admin.query(`REVOKE ALL ON schema_migrations FROM ${ROLE}`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
    await admin.query(
      `GRANT TEMPORARY ON DATABASE ${adminUrlParsed.pathname.replace('/', '')} TO ${ROLE}`,
    );
    // Task 35.2 hotfixes (Phase 4 discoveries), both reversible:
    // (a) PostGIS lives in the `extensions` schema on this project; schema
    //     visibility needs BOTH the search_path entry AND the USAGE grant
    //     (Supabase grants USAGE on extensions only to its built-in API
    //     roles, not to custom roles).
    // (b) Without these, every geography query fails and dispatch/matching
    //     flows collapse. This restores exactly the schema visibility the
    //     app had under the old single-role topology — nothing more.
    await admin.query(`ALTER ROLE ${ROLE} SET search_path = "$user", public, extensions`);
    await admin.query(`GRANT USAGE ON SCHEMA extensions TO ${ROLE}`);
    console.log(
      'grants applied: schema USAGE, DML on 13 app tables, ledger revoked, TEMPORARY on db, search_path "$user", public, extensions, extensions USAGE',
    );

    // ---- 3. Catalog verification. ----
    const attrs = await admin.query(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication FROM pg_roles WHERE rolname = $1`,
      [ROLE],
    );
    const a = attrs.rows[0];
    if (a.rolsuper || a.rolcreaterole || a.rolcreatedb || a.rolbypassrls || a.rolreplication) {
      fail(`role attributes not least-privilege: ${JSON.stringify(a)}`);
    }
    console.log('catalog: role has NO superuser/createrole/createdb/bypassrls attributes');

    for (const t of APP_TABLES) {
      const p = await admin.query(
        `SELECT has_table_privilege($1, $2, 'SELECT') AS s,
                has_table_privilege($1, $2, 'INSERT') AS i,
                has_table_privilege($1, $2, 'UPDATE') AS u,
                has_table_privilege($1, $2, 'DELETE') AS d,
                has_table_privilege($1, $2, 'TRUNCATE') AS tr`,
        [ROLE, t],
      );
      const r = p.rows[0];
      if (!r.s || !r.i || !r.u || !r.d || r.tr) {
        fail(`table ${t}: unexpected privilege map ${JSON.stringify(r)}`);
      }
    }
    const led = await admin.query(
      `SELECT has_table_privilege($1, 'schema_migrations', 'SELECT') AS s`,
      [ROLE],
    );
    if (led.rows[0].s) fail('schema_migrations must NOT be readable by the runtime role');
    console.log('catalog: DML present on all 13 tables, TRUNCATE absent, ledger denied');

    // ---- 4. REAL login test through the pooler (full TLS verification). ----
    const candidates = [
      { label: 'pooler', url: poolerUrl(ROLE, password) },
      { label: 'direct', url: directUrl(ROLE, password) },
    ];
    let loginOk = false;
    for (const c of candidates) {
      const test = new Pool({ connectionString: c.url, connectionTimeoutMillis: 15000 });
      try {
        const who = await test.query('SELECT CURRENT_USER AS u');
        if (who.rows[0].u !== ROLE) fail(`connected as ${who.rows[0].u}, expected ${ROLE}`);
        const counts: string[] = [];
        for (const t of ['users', 'technicians', 'notifications', 'audit_events']) {
          const r = await test.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
          counts.push(`${t}=${r.rows[0].n}`);
        }
        let ledgerDenied = false;
        try {
          await test.query('SELECT 1 FROM schema_migrations LIMIT 1');
        } catch (e: any) {
          ledgerDenied = /permission denied/i.test(e.message);
        }
        if (!ledgerDenied) fail('schema_migrations was readable via the runtime role — not least-privilege');
        console.log(
          `LOGIN OK via ${c.label} as ${ROLE} (verify-full TLS). reads: ${counts.join(', ')}; ledger: permission denied (as designed)`
        );
        loginOk = true;
        await test.end();
        break;
      } catch (e: any) {
        console.log(`${c.label} login failed: ${e.message.split('\n')[0]}`);
        await test.end().catch(() => {});
      }
    }
    if (!loginOk) {
      fail(
        'Could not authenticate as the runtime role through pooler OR direct endpoint. ' +
          'NOTHING was switched — app still uses the admin URL. Investigate before proceeding.',
      );
    }

    // ---- 5. Write APP_DATABASE_URL into backend/.env (value never printed). ----
    const runtimeUrl = poolerUrl(ROLE, password);
    let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    const line = `APP_DATABASE_URL=${runtimeUrl}`;
    if (/^APP_DATABASE_URL=/m.test(env)) {
      env = env.replace(/^APP_DATABASE_URL=.*$/m, line);
    } else {
      env = env.trimEnd() + `\n${line}\n`;
    }
    fs.writeFileSync(ENV_PATH, env);
    console.log('backend/.env: APP_DATABASE_URL written (value never printed; replace DATABASE_URL in Stage 4)');
  } finally {
    await admin.end();
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
