/**
 * task352-searchpath-debug.ts — READ-ONLY diagnosis of search_path under
 * the pooler vs the direct endpoint. Never prints credentials: the direct
 * URL is derived in-process from DATABASE_URL.
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const runtimeUrl = process.env.DATABASE_URL!;

function directVariant(u: string, plainUser: boolean): string {
  const url = new URL(u);
  const ref = url.username.split('.').slice(1).join('.');
  url.hostname = `${ref}.db.supabase.com`;
  url.port = '5432';
  url.username = plainUser ? url.username.split('.')[0] : url.username;
  return url.toString();
}

async function probe(label: string, conn: string): Promise<void> {
  const pool = new Pool({ connectionString: conn, connectionTimeoutMillis: 15000 });
  try {
    const sp = await pool.query(`SHOW search_path`);
    console.log(`  ${label}: search_path = ${sp.rows[0].search_path}`);
    const geo = await pool.query(
      `SELECT ST_Y(location) AS lat FROM technicians LIMIT 1`,
    ).then(() => 'OK').catch((e) => `FAIL: ${e.message.split('\n')[0]}`);
    console.log(`  ${label}: st_y(geography) → ${geo}`);
  } catch (e: any) {
    console.log(`  ${label}: connection failed: ${e.message.split('\n')[0]}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  console.log('A. pooler (current DATABASE_URL):');
  await probe('pooler', runtimeUrl);
  console.log('B. direct endpoint, plain username:');
  await probe('direct-plain', directVariant(runtimeUrl, true));
  console.log('C. direct endpoint, pooler-style username:');
  await probe('direct-suffixed', directVariant(runtimeUrl, false));
}

main();
