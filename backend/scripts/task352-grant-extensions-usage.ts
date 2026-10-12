/**
 * task352-grant-extensions-usage.ts — Task 35.2 hotfix #2.
 *
 * Even with `extensions` on the search_path, type/function resolution
 * requires USAGE on the schema itself. Supabase grants that to its built-in
 * API roles but not to custom roles. This grants the runtime role read-only
 * schema access (USAGE — allows name resolution; NOT CREATE).
 *
 * Evidence-driven, ADMIN connection only, fully reversible:
 *   REVOKE USAGE ON SCHEMA extensions FROM umodzi_app;
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const admin = new Pool({
    connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL,
  });
  try {
    const before = await admin.query(
      `SELECT has_schema_privilege('umodzi_app', 'extensions', 'USAGE') AS usage,
              has_schema_privilege('umodzi_app', 'extensions', 'CREATE') AS create_`,
    );
    console.log(`extensions schema BEFORE: USAGE=${before.rows[0].usage} CREATE=${before.rows[0].create_}`);
    await admin.query(`GRANT USAGE ON SCHEMA extensions TO umodzi_app`);
    const after = await admin.query(
      `SELECT has_schema_privilege('umodzi_app', 'extensions', 'USAGE') AS usage,
              has_schema_privilege('umodzi_app', 'extensions', 'CREATE') AS create_`,
    );
    console.log(`extensions schema AFTER:  USAGE=${after.rows[0].usage} CREATE=${after.rows[0].create_} (CREATE must stay false)`);
  } finally {
    await admin.end();
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
