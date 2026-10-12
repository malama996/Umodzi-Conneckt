/**
 * task352-set-search-path.ts — Task 35.2 hotfix for the search_path gap
 * discovered in Phase 4 verification.
 *
 * PostGIS types/functions live in the `extensions` schema on this Supabase
 * project. The former single-role topology (postgres) had extensions on its
 * search_path (Supabase default); the newly created `umodzi_app` role got
 * the vanilla default ("$user", public) so every geography query failed
 * ("function st_y(extensions.geography) does not exist").
 *
 * This script (ADMIN connection only):
 *   1. Prints the postgres role's per-role settings (evidence of what the
 *      app implicitly had before — no secrets in rolconfig).
 *   2. Sets search_path on umodzi_app to "$user", public, extensions —
 *      the same schema visibility the app enjoyed previously, no more.
 *   3. Prints umodzi_app's resulting rolconfig as proof.
 * Reversible: ALTER ROLE ... RESET search_path.
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const adminUrl = process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL;

async function main() {
  const admin = new Pool({ connectionString: adminUrl });
  try {
    const before = await admin.query(
      `SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('postgres', 'umodzi_app') ORDER BY rolname`,
    );
    console.log('per-role settings BEFORE:');
    for (const r of before.rows) console.log(`  ${r.rolname}: ${r.rolconfig ?? '(none)'}`);

    await admin.query(`ALTER ROLE umodzi_app SET search_path = "$user", public, extensions`);
    console.log('applied: ALTER ROLE umodzi_app SET search_path = "$user", public, extensions');

    const after = await admin.query(
      `SELECT rolconfig FROM pg_roles WHERE rolname = 'umodzi_app'`,
    );
    console.log(`umodzi_app rolconfig AFTER: ${after.rows[0].rolconfig}`);
  } finally {
    await admin.end();
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
