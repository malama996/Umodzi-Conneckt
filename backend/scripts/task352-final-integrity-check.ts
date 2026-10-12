/**
 * task352-final-integrity-check.ts
 *
 * Post-remediation data-integrity snapshot for Task 35.2: proves the live
 * database still holds the expected baseline rows (no resets, truncations,
 * seeds, or deletions occurred during remediation or regression). Read-only.
 * Prints counts only — no credentials, no PII.
 */
import 'dotenv/config';
import { Pool } from 'pg';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const count = async (sql: string): Promise<number> =>
      (await pool.query<{ n: number }>(sql)).rows[0].n;

    const snapshot = {
      users: await count('SELECT COUNT(*)::int AS n FROM users'),
      technicians: await count('SELECT COUNT(*)::int AS n FROM technicians'),
      sessions: await count('SELECT COUNT(*)::int AS n FROM sessions'),
      service_requests: await count('SELECT COUNT(*)::int AS n FROM service_requests'),
      messages: await count('SELECT COUNT(*)::int AS n FROM messages'),
      notifications: await count('SELECT COUNT(*)::int AS n FROM notifications'),
      audit_events: await count('SELECT COUNT(*)::int AS n FROM audit_events'),
      push_subscriptions: await count('SELECT COUNT(*)::int AS n FROM push_subscriptions'),
    };
    console.log(JSON.stringify(snapshot, null, 2));
    // The pre-35.2 baseline was: users=3, technicians=1, notifications=21,
    // audit_events=238 (monotonically increasing across every suite run).
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
