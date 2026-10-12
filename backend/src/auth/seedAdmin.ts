import { query } from '../db/client.js';
import { normalizeEmail } from './authService.js';
import { hashPassword } from './password.js';

/**
 * Controlled administrator provisioning (Task 23).
 *
 * Public registration can NEVER create an administrator — admins come
 * exclusively from this explicit environment-driven seed
 * (ADMIN_EMAIL + ADMIN_PASSWORD), which server.ts calls at startup:
 *
 *   - credentials are read from the environment, never hard-coded;
 *   - the password is hashed with argon2id and NEVER logged or echoed;
 *   - if the account already exists its password is left untouched
 *     (the environment value is only used for first-time creation);
 *   - an existing non-admin account with that email is promoted to
 *     administrator, with an explicit log line.
 *
 * Skipping the seed (variables unset) is a supported configuration —
 * it only means no administrator exists until one is provisioned.
 */
export async function seedAdminFromEnv(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.log('Admin seed skipped: ADMIN_EMAIL / ADMIN_PASSWORD not set.');
    return;
  }
  if (password.length < 8) {
    console.warn('Admin seed skipped: ADMIN_PASSWORD must be at least 8 characters.');
    return;
  }

  const normalized = normalizeEmail(email);
  const existing = await query<{ id: string; role: string }>(
    'SELECT id, role FROM users WHERE lower(email) = $1',
    [normalized],
  );

  if (existing[0]) {
    if (existing[0].role !== 'administrator') {
      await query(
        `UPDATE users SET role = 'administrator', updated_at = NOW() WHERE id = $1`,
        [existing[0].id],
      );
      console.log(`Admin seed: existing account ${normalized} promoted to administrator.`);
    } else {
      console.log('Admin seed: administrator account already present.');
    }
    return;
  }

  const digest = await hashPassword(password); // argon2id — never logged
  await query(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, account_status)
     VALUES ($1, $2, 'administrator', 'Umodzi', 'Admin', 'active')`,
    [normalized, digest],
  );
  console.log(`Admin seed: administrator account created (${normalized}).`);
}
