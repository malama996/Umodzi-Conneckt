import 'dotenv/config';
import { pool, query } from '../src/db/client.js';
import { hashPassword } from '../src/auth/password.js';
import { assertLocalDatabase } from '../src/db/assertLocalDatabase.js';

/**
 * Creates the three demonstration accounts on a local database.
 *
 *   admin@umodzi.demo      administrator
 *   customer@umodzi.demo   customer, ready to raise a request
 *   tech@umodzi.demo       technician, verified and available in Plumbing/Kitwe
 *
 * Idempotent: existing rows are left unchanged, so the script can be re-run
 * before a demonstration without duplicating anything. It refuses any
 * non-loopback host, so it cannot run against the hosted database.
 *
 * Run: npm run seed:demo -w backend
 */
const PASSWORD = 'Demo2026!Local';

const ACCOUNTS = [
  { email: 'admin@umodzi.demo', role: 'administrator', firstName: 'Umodzi', lastName: 'Admin' },
  { email: 'customer@umodzi.demo', role: 'customer', firstName: 'Chanda', lastName: 'Mulenga' },
  { email: 'tech@umodzi.demo', role: 'technician', firstName: 'Bwalya', lastName: 'Mwansa' },
] as const;

/** Kitwe city centre; dispatch filters on this column, so it must be real. */
const KITWE = { latitude: -12.8024, longitude: 28.2132 };

async function createAccount(account: (typeof ACCOUNTS)[number]): Promise<void> {
  const existing = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    account.email,
  ]);
  if (existing.length > 0) {
    console.log(`exists   ${account.email}`);
    return;
  }

  const passwordHash = await hashPassword(PASSWORD);
  const inserted = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, account_status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING id`,
    [account.email, passwordHash, account.role, account.firstName, account.lastName],
  );

  if (account.role === 'technician') {
    await query(
      `INSERT INTO technicians
         (user_id, name, category, skills, service_area, latitude, longitude, location,
          bio, verified, verification_status, availability, availability_status,
          account_status, jobs, rating)
       VALUES ($1, $2, 'Plumbing', '[]'::jsonb, 'Kitwe', $3, $4,
               ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
               'Demonstration technician account.', true, 'verified', 'Available now',
               'available', 'active', 0, 0)`,
      [inserted[0].id, `${account.firstName} ${account.lastName}`, KITWE.latitude, KITWE.longitude],
    );
  }

  console.log(`created  ${account.email} (${account.role})`);
}

async function main(): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL, 'DATABASE_URL', 'seed:demo');

  for (const account of ACCOUNTS) {
    await createAccount(account);
  }

  console.log(`\nAll demo accounts use the password ${PASSWORD}.`);
}

main()
  .then(() => pool.end())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
