import 'dotenv/config';
import { pool, query, seedInitialTechnicians } from './client.js';
import { seedAdminFromEnv } from '../auth/seedAdmin.js';
import { assertLocalDatabase } from './assertLocalDatabase.js';

/**
 * Seeds the baseline every test suite asserts against: the nine technician
 * prototypes plus the administrator from ADMIN_EMAIL/ADMIN_PASSWORD.
 *
 * The inserts live in seedInitialTechnicians (already called at server startup
 * when SEED_DEMO_DATA=true); this script is the way to seed a database without
 * booting the API. Both paths therefore create identical rows — one INSERT, not
 * two copies that can drift.
 *
 * Idempotent: seedInitialTechnicians and seedAdminFromEnv both no-op when their
 * rows already exist. Non-destructive: no UPDATE, DELETE or TRUNCATE. Refuses
 * any non-loopback host, and never prints the administrator password.
 */
async function main(): Promise<void> {
  // Only DATABASE_URL is checked: a hosted MIGRATIONS_DATABASE_URL may sit in
  // .env for tooling and must not block a local seed.
  assertLocalDatabase(process.env.DATABASE_URL, 'DATABASE_URL', 'seed');

  await seedInitialTechnicians();
  await seedAdminFromEnv();

  const counts = await query<{ technicians: string; admins: string }>(
    `SELECT
       (SELECT COUNT(*) FROM technicians) AS technicians,
       (SELECT COUNT(*) FROM users WHERE role = 'administrator') AS admins`,
  );
  console.log(
    `Baseline: ${counts[0].technicians} technicians, ${counts[0].admins} administrator(s).`,
  );
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
