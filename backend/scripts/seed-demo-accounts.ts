import 'dotenv/config';
import { pool, query } from '../src/db/client.js';
import { hashPassword } from '../src/auth/password.js';
import { assertLocalDatabase } from '../src/db/assertLocalDatabase.js';

/**
 * Creates the three demonstration accounts on a LOCAL database.
 *
 *   admin@umodzi.demo      administrator (also seeded from ADMIN_EMAIL at startup)
 *   customer@umodzi.demo   customer, ready to raise a request
 *   tech@umodzi.demo       technician, verified + available in Plumbing/Kitwe
 *
 * Idempotent: existing rows are left untouched, so it can be re-run before a
 * demo without duplicating anything. It refuses any non-loopback host — this
 * must never run against the hosted database.
 *
 * Run: npm run seed:demo -w backend
 */
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo2026!Local';

const ACCOUNTS = [
  {
    email: 'admin@umodzi.demo',
    role: 'administrator',
    firstName: 'Admin',
    lastName: 'Demo',
  },
  {
    email: 'customer@umodzi.demo',
    role: 'customer',
    firstName: 'Chanda',
    lastName: 'Mulenga',
  },
  {
    email: 'tech@umodzi.demo',
    role: 'technician',
    firstName: 'Bwalya',
    lastName: 'Mwansa',
  },
] as const;

async function main(): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL, 'DATABASE_URL', 'seed:demo');

  const digest = await hashPassword(PASSWORD);

  for (const account of ACCOUNTS) {
    const existing = await query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1',
      [account.email],
    );
    if (existing.length > 0) {
      console.log(`exists  ${account.email} (${account.role}) — left unchanged`);
      continue;
    }

    const inserted = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, account_status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING id`,
      [account.email, digest, account.role, account.firstName, account.lastName],
    );
    console.log(`created ${account.email} (${account.role})`);

    if (account.role === 'technician') {
      // A technician profile is what dispatch matches on: category + service
      // area + verified + available + an owning user account.
      // `location` is NOT NULL and dispatch filters on it, so the profile gets
      // real Kitwe coordinates rather than a placeholder row.
      await query(
        `INSERT INTO technicians
           (user_id, name, category, skills, service_area, latitude, longitude, location,
            bio, verified, verification_status, availability, availability_status,
            account_status, jobs, rating)
         VALUES ($1, $2, 'Plumbing', '[]'::jsonb, 'Kitwe', -12.8024, 28.2132,
                 ST_SetSRID(ST_MakePoint(28.2132, -12.8024), 4326)::geography,
                 'Demonstration technician account.', true, 'verified', 'Available now',
                 'available', 'active', 0, 0)`,
        [inserted[0].id, `${account.firstName} ${account.lastName}`],
      );
      console.log('        technician profile created: Plumbing / Kitwe, verified, available');
    }

    if (account.role === 'customer') {
      console.log('        customer ready to create requests');
    }
  }

  console.log(
    '\nDemo password is DEMO_PASSWORD from the env file (default Demo2026!Local).',
  );
}

main()
  .then(() => pool.end())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
