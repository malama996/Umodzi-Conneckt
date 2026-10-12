import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { pool as runtimePool } from './client.js';

/**
 * Lightweight deterministic migration runner (Task 23).
 *
 * - Files live in `src/db/migrations/` and are named `NNN_description.sql`
 *   (zero-padded, applied in ascending filename order).
 * - Applied migrations are recorded in `schema_migrations (name, applied_at)`
 *   inside the SAME transaction that runs the migration, so a crashed
 *   migration cannot be half-recorded.
 * - Every migration file must be idempotent (IF NOT EXISTS / guarded DO
 *   blocks) so that an existing Task 21B database (created before this
 *   ledger existed) can be upgraded safely and re-starts are no-ops.
 * - Never drops tables, never truncates, never rewrites existing rows.
 *
 * Task 35.2 (DB-2): migrations perform DDL and therefore must run with the
 * ADMINISTRATIVE connection. Runtime traffic uses the restricted
 * `umodzi_app` role that now lives in DATABASE_URL, so the runner uses the
 * dedicated MIGRATIONS_DATABASE_URL when present and falls back to the
 * shared pool otherwise (pre-Task-35.2 behaviour).
 *
 * Path resolution: at development time this module sits next to
 * `migrations/` (src/db). In the compiled build (dist/db) the .sql files
 * are not emitted by tsc, so the runner falls back to the source tree
 * relative to the compiled file. Both locations are probed in order.
 */

const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'migrations'), // src/db/migrations (dev / tsx)
    path.join(here, '../../src/db/migrations'), // dist/db → ../../src/db/migrations (build)
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(
    `Migrations directory not found. Tried: ${candidates.join(', ')}`,
  );
}

export async function runMigrations(): Promise<MigrationResult> {
  const dir = migrationsDir();
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  for (const file of files) {
    if (!MIGRATION_FILE_PATTERN.test(file)) {
      throw new Error(
        `Invalid migration filename "${file}" — expected NNN_description.sql (e.g. 002_authentication.sql)`,
      );
    }
  }

  // Task 35.2: use the administrative connection for DDL when configured;
  // fall back to the shared pool for pre-Task-35.2 setups.
  const adminPool = process.env.MIGRATIONS_DATABASE_URL
    ? new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL })
    : runtimePool;
  const client = await adminPool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
       )`,
    );

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [file],
      );
      if (rows.length > 0) {
        skipped.push(file);
        continue;
      }

      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    client.release();
    if (adminPool !== runtimePool) await adminPool.end();
  }

  if (applied.length === 0) {
    console.log(`Migrations up to date (${skipped.length} already applied).`);
  } else {
    console.log(`Applied migrations: ${applied.join(', ')}`);
    if (skipped.length > 0) {
      console.log(`Already applied: ${skipped.join(', ')}`);
    }
  }

  return { applied, skipped };
}
