/**
 * Task 23 migration tests: deterministic ordered runner, idempotency,
 * legacy-data preservation, and the safety contract of the SQL files.
 *
 * Run from the backend folder (requires the scratch PostgreSQL cluster):
 *   npx tsx scripts/task23-migration-tests.ts
 *
 * Phases:
 *   main (default) — against DATABASE_URL (the app database):
 *       * runner skips already-applied migrations,
 *       * ledger rows match the files on disk,
 *       * re-applying EVERY migration over a populated database preserves
 *         all rows (legacy requests keep customer_user_id = NULL),
 *       * SQL files contain no DROP/TRUNCATE statements,
 *       * filenames follow the NNN_description.sql contract.
 *   --phase=fresh  — against a throwaway database created by the main
 *       phase (the child inherits DATABASE_URL pointing at it):
 *       * first run applies 001–004 and produces the complete schema
 *         (tables, ownership columns, FKs, checks, unique indexes),
 *       * second run applies nothing (idempotent + ledger-based).
 */

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/* ------------------------------------------------------------------ */
/* Task 35.2 wiring note                                               */
/* ------------------------------------------------------------------ */
/* This suite is a database-ADMINISTRATION harness: it runs the migration */
/* runner, creates and drops a scratch database, and inspects the        */
/* schema_migrations ledger. Under the two-role topology introduced by   */
/* Task 35.2 the runtime role (`umodzi_app`) is deliberately unable to   */
/* do any of that, so the harness must use the ADMINISTRATIVE connection */
/* (MIGRATIONS_DATABASE_URL) — exactly the privilege level it had before */
/* the split, when DATABASE_URL *was* the admin connection.             */
const ADMIN_URL = process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_URL) {
  console.error('DATABASE_URL (or MIGRATIONS_DATABASE_URL) is required.');
  process.exit(1);
}
// client.ts and migrate.ts bind their pools at import time from
// DATABASE_URL; point it at the admin connection BEFORE those imports.
process.env.DATABASE_URL = ADMIN_URL;

const { pool, query } = await import('../src/db/client.js');
const { runMigrations } = await import('../src/db/migrate.js');

/* ------------------------------------------------------------------ */
/* Tiny assertion harness                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'src', 'db', 'migrations');
const TEST_DATABASE = 'umodzi_migrate_test';

// Task 35.2 maintenance: the expected migration set is derived from the
// migrations directory instead of being hardcoded (the suite originally
// hardcoded the first four files, which became stale as Tasks 28–35.2
// appended 005–010). Comparing the ledger against the full derived list is
// a STRONGER check: every file, by exact name, in order.
const EXPECTED_MIGRATIONS = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, 'en'));

/* ------------------------------------------------------------------ */
/* Main (app database) phase                                          */
/* ------------------------------------------------------------------ */

async function mainPhase(mainUrl: string): Promise<void> {
  console.log('\nmain database — runner behaviour over a populated schema');

  const first = await runMigrations();
  assert(
    first.applied.length + first.skipped.length === EXPECTED_MIGRATIONS.length,
    'first contact processes every migration file (applied or already recorded)',
  );

  // The invariant that matters for restarts: an immediate second run is a
  // complete no-op.
  const again = await runMigrations();
  assert(again.applied.length === 0, 'immediate re-run applies nothing');
  assert(again.skipped.length === EXPECTED_MIGRATIONS.length, 'immediate re-run skips every file via the ledger');

  const ledger = await query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  const ledgerNames = ledger.map((row) => row.name);
  assert(
    ledgerNames.join(',') === EXPECTED_MIGRATIONS.join(','),
    'ledger contains exactly the ordered migration files',
  );

  // ---- legacy data preservation: re-apply EVERY migration file over a
  // populated database and prove no row is touched.
  const legacyId = crypto.randomUUID();
  const legacyDescription = 'Legacy fixture row proving migrations preserve data';
  await query(
    `INSERT INTO service_requests (id, description, category, city, status, customer_user_id, created_at, updated_at)
     VALUES ($1, $2, 'Plumbing', 'Kitwe', 'pending', NULL, NOW(), NOW())`,
    [legacyId, legacyDescription],
  );

  const countsBefore = {
    requests: Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM service_requests'))[0].n),
    offers: Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM dispatch_offers'))[0].n),
    technicians: Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM technicians'))[0].n),
    users: Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM users'))[0].n),
  };

  // Reset ONLY the ledger (not the data) so the files genuinely re-run.
  await query('DELETE FROM schema_migrations');
  const rerun = await runMigrations();
  assert(rerun.applied.length === EXPECTED_MIGRATIONS.length, 're-running from an empty ledger applies every file again');
  assert(rerun.skipped.length === 0, 'nothing is skipped on a clean-ledger re-run');

  const legacyRow = await query<{ description: string; customer_user_id: string | null }>(
    'SELECT description, customer_user_id FROM service_requests WHERE id = $1',
    [legacyId],
  );
  assert(legacyRow.length === 1, 'legacy fixture row survives a full migration re-run');
  assert(
    legacyRow[0]?.customer_user_id === null,
    'legacy request keeps customer_user_id = NULL (never claimed)',
  );
  assert(
    legacyRow[0]?.description === legacyDescription,
    'legacy request content is unchanged',
  );

  const countsAfter = {
    requests: Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM service_requests'))[0].n),
    offers: Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM dispatch_offers'))[0].n),
    technicians: Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM technicians'))[0].n),
    users: Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM users'))[0].n),
  };
  assert(
    countsAfter.requests === countsBefore.requests &&
      countsAfter.offers === countsBefore.offers &&
      countsAfter.technicians === countsBefore.technicians &&
      countsAfter.users === countsBefore.users,
    'no rows are added, removed, or rewritten by re-running migrations',
  );

  await query('DELETE FROM service_requests WHERE id = $1', [legacyId]);

  const finalLedger = await query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  assert(
    finalLedger.map((row) => row.name).join(',') === EXPECTED_MIGRATIONS.join(','),
    'ledger is restored to the full ordered file list',
  );

  // ---- safety contract of the SQL files themselves.
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  assert(files.length >= 4, 'migrations directory holds at least the four migration files');
  assert(
    files.every((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)),
    'every migration filename follows NNN_description.sql',
  );

  const forbidden = /\bDROP\s+TABLE\b|\bDROP\s+DATABASE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b\s+\w+\s*(;|$)/i;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const withoutComments = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    assert(!forbidden.test(withoutComments), `${file} contains no DROP/TRUNCATE/data-clearing SQL`);
    assert(
      !/PASSWORD\s+'[^']+'|admin\s*password|secret\s*=\s*'/i.test(withoutComments),
      `${file} contains no embedded credentials`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Fresh database phase (runs as a child process)                     */
/* ------------------------------------------------------------------ */

async function freshPhase(): Promise<void> {
  console.log('\nfresh database — full schema on first run, no-op on second');

  const first = await runMigrations();
  assert(first.applied.length === EXPECTED_MIGRATIONS.length, 'first run applies every migration');
  assert(
    first.applied.join(',') === EXPECTED_MIGRATIONS.join(','),
    'files apply in ascending filename order',
  );

  const tables = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const tableSet = new Set(tables.map((row) => row.table_name));
  for (const name of [
    'technicians',
    'service_requests',
    'dispatch_offers',
    'users',
    'sessions',
    'schema_migrations',
    'technician_verification_documents',
    'reviews',
  ]) {
    assert(tableSet.has(name), `table ${name} exists`);
  }

  const columns = await query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'service_requests' AND column_name = 'customer_user_id')
         OR (table_name = 'technicians' AND column_name = 'user_id'))`,
  );
  assert(
    columns.length === 2,
    'ownership columns (customer_user_id, technicians.user_id) exist',
  );

  const indexes = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  );
  const indexSet = new Set(indexes.map((row) => row.indexname));
  for (const name of [
    'uq_users_email',
    'uq_sessions_token_hash',
    'uq_technicians_user_id',
    'idx_service_requests_customer_user_id',
    'uq_reviews_service_request',
    'idx_reviews_technician_id',
  ]) {
    assert(indexSet.has(name), `index ${name} exists`);
  }

  const constraints = await query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'service_requests'::regclass`,
  );
  const constraintSet = new Set(constraints.map((row) => row.conname));
  assert(
    constraintSet.has('fk_service_requests_customer_user'),
    'ownership FK (ON DELETE SET NULL) exists',
  );

  const userChecks = await query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'users'::regclass AND contype = 'c'`,
  );
  const checkNames = new Set(userChecks.map((row) => row.conname));
  assert(checkNames.has('users_role_check'), 'users.role CHECK enforces the three roles');
  assert(
    checkNames.has('users_account_status_check'),
    'users.account_status CHECK enforces active/suspended/disabled',
  );

  // Task 26 (003): verification columns, lifecycle CHECK, documents table.
  const techColumns = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'technicians'
       AND column_name IN ('bio', 'photo_key', 'verification_status',
                           'verification_rejection_reason', 'verification_submitted_at',
                           'verification_reviewed_at', 'verification_reviewed_by')`,
  );
  assert(techColumns.length === 7, 'technicians carry the 7 Task 26 columns');
  const techChecks = await query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'technicians'::regclass AND contype = 'c'`,
  );
  assert(
    techChecks.some((row) => row.conname === 'chk_technicians_verification_status'),
    'technicians.verification_status CHECK enforces the lifecycle',
  );
  const docChecks = await query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'technician_verification_documents'::regclass`,
  );
  const docCheckNames = new Set(docChecks.map((row) => row.conname));
  assert(
    docCheckNames.has('chk_verification_documents_type'),
    'documents.document_type CHECK enforces the vocabulary',
  );
  const docIndexes = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'technician_verification_documents'`,
  );
  const docIndexSet = new Set(docIndexes.map((row) => row.indexname));
  assert(
    docIndexSet.has('uq_verification_documents_storage_key') &&
      docIndexSet.has('idx_verification_documents_technician_id'),
    'document storage-key uniqueness + technician index exist',
  );

  // Task 27 (004): reviews table — rating bounds, one review per service,
  // and the three relationship foreign keys.
  const reviewChecks = await query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'reviews'::regclass AND contype = 'c'`,
  );
  assert(
    reviewChecks.some((row) => row.conname === 'chk_reviews_rating'),
    'reviews.rating CHECK enforces 1..5 stars',
  );
  const reviewFks = await query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'reviews'::regclass AND contype = 'f'`,
  );
  assert(
    reviewFks.length === 3,
    'reviews carry three foreign keys (request, customer, technician)',
  );
  const reviewIndexes = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'reviews'`,
  );
  assert(
    reviewIndexes.some((row) => row.indexname === 'uq_reviews_service_request'),
    'one-review-per-service unique index exists',
  );

  const extensions = await query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname = 'postgis'`,
  );
  assert(extensions.length === 1, 'PostGIS extension is present');

  const second = await runMigrations();
  assert(second.applied.length === 0, 'second run applies nothing');
  assert(second.skipped.length === EXPECTED_MIGRATIONS.length, 'second run skips all files via the ledger');

  const ledger = await query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  assert(
    ledger.length === EXPECTED_MIGRATIONS.length &&
      ledger.map((row) => row.name).join(',') === EXPECTED_MIGRATIONS.join(','),
    'fresh ledger lists exactly the ordered migration files',
  );

  await pool.end();
}

/* ------------------------------------------------------------------ */
/* Orchestration: main phase + scratch-database child                 */
/* ------------------------------------------------------------------ */

function withPath(url: string, pathname: string): string {
  const parsed = new URL(url);
  parsed.pathname = pathname;
  return parsed.toString();
}

async function main(): Promise<void> {
  if (process.argv.includes('--phase=fresh')) {
    await freshPhase();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  const mainUrl = process.env.DATABASE_URL;
  if (!mainUrl) {
    console.error('DATABASE_URL is required.');
    process.exitCode = 1;
    return;
  }

  try {
    await mainPhase(mainUrl);
  } finally {
    await pool.end();
  }

  // Fresh-database phase in a child process (the pg Pool URL is fixed at
  // import time, so a separate process is the honest way to point the
  // REAL runner at a different database). Task 35.2: BOTH URL variables
  // point at the scratch database so the child's runner and client use it.
  const admin = new Client({ connectionString: withPath(ADMIN_URL, '/postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    try {
      const scratchUrl = withPath(ADMIN_URL, `/${TEST_DATABASE}`);
      execSync(`npx tsx "${fileURLToPath(import.meta.url)}" --phase=fresh`, {
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: scratchUrl,
          MIGRATIONS_DATABASE_URL: scratchUrl,
        },
      });
      assert(true, 'fresh-database child phase completed successfully');
    } catch {
      assert(false, 'fresh-database child phase completed successfully');
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error('Migration test runner crashed:', error);
  process.exitCode = 1;
});
