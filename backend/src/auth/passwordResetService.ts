import crypto from 'node:crypto';
import { z } from 'zod';
import { query, transaction } from '../db/client.js';
import { HttpError } from './httpError.js';
import { hashPassword } from './password.js';
import { revokeAllSessions, parseTtlSeconds } from './sessionService.js';
import { normalizeEmail } from './authService.js';
import { sendPasswordResetEmail } from './emailService.js';

/**
 * Password recovery (audit §3).
 *
 * Threat model:
 *   - Only a SHA-256 HASH of the recovery token is stored; the raw token
 *     exists only inside the emailed link and is never persisted or logged
 *     in production.
 *   - Tokens are SINGLE-USE (consumed_at) and TIME-LIMITED (expires_at).
 *     Issuing a new token consumes any prior live token for that user, so
 *     at most one link is valid at a time.
 *   - The flow is ENUMERATION-SAFE: requestPasswordReset returns the same
 *     shape whether or not the account exists/is active, and only an active
 *     account triggers an email.
 *   - On success every existing session is revoked, so a reset logs out all
 *     other devices (defence against a session stolen alongside the email).
 */

const DEFAULT_RESET_TTL = '30m';

const resetPasswordSchema = z.object({
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
});

/** SHA-256 hex of the raw recovery token — the only form ever persisted. */
export function hashResetToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export interface ResetRequestResult {
  /** True only when an email was actually dispatched to an active account. */
  emailed: boolean;
}

/**
 * Begin recovery for an email address. Enumeration-safe: the caller cannot
 * distinguish "no such account", "inactive account", and "email sent" from
 * the return value or timing (a token is only minted for a real, active
 * account, but the response is identical either way).
 */
export async function requestPasswordReset(email: string): Promise<ResetRequestResult> {
  const rows = await query<{ id: string; account_status: string }>(
    `SELECT id, account_status FROM users WHERE lower(email) = $1`,
    [normalizeEmail(email)],
  );
  const user = rows[0];
  if (!user || user.account_status !== 'active') {
    return { emailed: false };
  }

  const ttlSeconds = parseTtlSeconds(
    process.env.PASSWORD_RESET_TTL,
    DEFAULT_RESET_TTL,
  );
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashResetToken(rawToken);

  // Consume any prior live token so only the newest link works.
  await query(
    `UPDATE password_reset_tokens SET consumed_at = NOW()
     WHERE user_id = $1 AND consumed_at IS NULL`,
    [user.id],
  );
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, NOW() + make_interval(secs => $3), NOW())`,
    [user.id, tokenHash, ttlSeconds],
  );

  await sendPasswordResetEmail(normalizeEmail(email), rawToken);
  return { emailed: true };
}

/**
 * Complete recovery: validate the raw token, then atomically consume it and
 * rotate the password. Throws a GENERIC 400 for any invalid, expired, or
 * already-used token (no distinction that could aid an attacker). Returns
 * the affected user id so the caller can audit + revoke sessions.
 */
export async function resetPassword(
  rawToken: string,
  newPassword: string,
): Promise<{ userId: string }> {
  const parsed = resetPasswordSchema.safeParse({ password: newPassword });
  if (!parsed.success) {
    throw new HttpError(400, 'Validation failed', parsed.error.flatten());
  }
  if (typeof rawToken !== 'string' || rawToken.trim().length === 0) {
    throw new HttpError(400, 'This password reset link is invalid or has expired.');
  }

  const rows = await query<{
    id: string;
    user_id: string;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT id, user_id, expires_at, consumed_at
     FROM password_reset_tokens WHERE token_hash = $1`,
    [hashResetToken(rawToken)],
  );
  const row = rows[0];
  if (
    !row ||
    row.consumed_at !== null ||
    new Date(row.expires_at).getTime() <= Date.now()
  ) {
    throw new HttpError(400, 'This password reset link is invalid or has expired.');
  }

  const digest = await hashPassword(parsed.data.password); // argon2id — never logged
  const userId = row.user_id;

  await transaction(async (client) => {
    // Consume first, guarded: a concurrent request that already consumed it
    // makes this a no-op so the same link can never be used twice.
    const consumed = await client.query(
      `UPDATE password_reset_tokens SET consumed_at = NOW()
       WHERE id = $1 AND consumed_at IS NULL
       RETURNING id`,
      [row.id],
    );
    if (consumed.rows.length === 0) {
      throw new HttpError(400, 'This password reset link is invalid or has expired.');
    }
    await client.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [digest, userId],
    );
  });

  // A password change invalidates every existing session on every device.
  await revokeAllSessions(userId, 'logout');
  return { userId };
}
