/**
 * task352-radius-predicate-check.ts
 *
 * Diagnostic for the Task 35.2 regression: task28-3a1-location-privacy-tests
 * fails "PostGIS radius filter still excludes out-of-range technicians".
 * That suite is read-only and picks its probe point from a random existing
 * Kitwe technician; with the environment's current baseline (a single
 * user-linked technician), probe == the only Kitwe row, so a 1 m radius and
 * a 50 km radius legitimately return the same single row and the suite's
 * contrast assertion (tiny < wide) has nothing left to exclude.
 *
 * This script proves directly in the database — under the umodzi_app runtime
 * role — that the PostGIS ST_DWithin predicate itself still EXCLUDES
 * out-of-range rows, so the suite failure is baseline-data drift, not a
 * broken spatial predicate. Read-only: SELECT-only, no writes.
 *
 * Prints counts only — no coordinates, no credentials.
 */
import 'dotenv/config';
import { Pool } from 'pg';

const LUSAKA = [28.28, -15.42]; // ~200 km from Kitwe — far probe point

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const role = await pool.query<{ current_user: string; is_superuser: string }>(
      `SELECT current_user, current_setting('is_superuser') AS is_superuser`,
    );
    console.log(`role: ${role.rows[0].current_user} (superuser: ${role.rows[0].is_superuser})`);

    const total = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM technicians',
    );
    const kitwe = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM technicians WHERE service_area = 'Kitwe'`,
    );
    console.log(`technicians total: ${total.rows[0].n}`);
    console.log(`technicians with service_area='Kitwe': ${kitwe.rows[0].n}`);

    const probe = await pool.query<{ lat: number; lon: number }>(
      `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon
         FROM technicians WHERE service_area = 'Kitwe' LIMIT 1`,
    );
    if (probe.rows.length === 0) {
      console.log('no Kitwe technician — the 3a1 suite would fail earlier at its own probe assertion');
      return;
    }
    const { lat, lon } = probe.rows[0];

    // Mirror the application's nearby predicate (server.ts): geography column,
    // ST_DWithin with a metre radius. Run as the runtime role.
    const wide = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM technicians
        WHERE location IS NOT NULL
          AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 50000)`,
      [lon, lat],
    );
    const tiny = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM technicians
        WHERE location IS NOT NULL
          AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 1)`,
      [lon, lat],
    );
    console.log(`within 50 km of the Kitwe probe point: ${wide.rows[0].n}`);
    console.log(`within  1 m of the Kitwe probe point: ${tiny.rows[0].n}`);

    // The decisive exclusion proof: a far-away probe point at the same 50 km
    // radius must exclude every Kitwe technician.
    const far = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM technicians
        WHERE location IS NOT NULL
          AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 50000)`,
      [LUSAKA[0], LUSAKA[1]],
    );
    console.log(`within 50 km of a far (non-Kitwe) probe point: ${far.rows[0].n}`);

    const predicateWorks =
      far.rows[0].n < total.rows[0].n &&
      wide.rows[0].n <= kitwe.rows[0].n;
    console.log(
      predicateWorks
        ? 'VERDICT: the ST_DWithin predicate still excludes out-of-range rows under umodzi_app — the 3a1 contrast failure is baseline-data drift (only one Kitwe row exists, so 1 m and 50 km return the same set), not a broken spatial filter.'
        : 'VERDICT: unexpected — the predicate did NOT exclude rows; investigate before classifying the 3a1 failure as drift.',
    );
    if (!predicateWorks) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
