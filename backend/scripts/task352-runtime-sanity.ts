/**
 * task352-runtime-sanity.ts — Task 35.2 quick READ-ONLY sanity probes as the
 * restricted runtime role (current DATABASE_URL). Each probe is a pure
 * SELECT; failures are printed with their SQLSTATE/routine for diagnosis.
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function probe(label: string, sql: string): Promise<void> {
  try {
    const r = await pool.query(sql);
    console.log(`  ok   ${label} (${r.rowCount} row(s))`);
  } catch (e: any) {
    console.log(
      `  FAIL ${label}: ${e.message.split('\n')[0]} [routine=${e.routine ?? '?'} code=${e.code ?? '?'}]`,
    );
  }
}

async function main() {
  const who = await pool.query('SELECT CURRENT_USER AS u, current_schema AS s');
  console.log(`connected as ${who.rows[0].u}, current_schema=${who.rows[0].s}`);
  await probe('plain users count', 'SELECT COUNT(*)::int AS n FROM users');
  await probe(
    'postgis cast (task28-3a1 pattern)',
    'SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon FROM technicians LIMIT 1',
  );
  await probe('postgis direct geography fn', 'SELECT ST_Y(location) AS lat FROM technicians LIMIT 1');
  await probe('type of location column', `SELECT postgis_typmod_type(NULL::int) AS t`);
  await probe('search_path', 'SHOW search_path');
  await probe('geometry type visible', `SELECT 1 FROM pg_type WHERE typname = 'geometry'`);
  await pool.end();
}

main();
