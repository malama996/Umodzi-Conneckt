import crypto from 'node:crypto';
import { query } from '../db/client.js';
import type { AccountStatus, UserRole } from '../types/api.js';

/**
 * Server-managed refresh-token sessions (Task 23).
 *
 * Flow: login → opaque 256-bit random token is created, its SHA-256 hash
 * is stored in `sessions`, and only the RAW token leaves the server —
 * inside an HttpOnly cookie. The raw token exists nowhere on the server.
 *
 * Refresh rotates the token: the presented session is revoked
 * (reason 'rotated') and a fresh one is issued. Rotation is replay-safe:
 *   - presenting a token revoked as 'logout' or 'reuse' → 401 immediately;
 *   - presenting a 'rotated' token more than ROTATION_GRACE_MS old →
 *     treated as theft: EVERY session for that user is revoked ('reuse')
 *     and the request fails;
 *   - presenting a 'rotated' token inside the grace window is allowed —
 *     two browser tabs restoring their sessions at the same instant share
 *     one cookie, so strict single-use would log the second tab out.
 * The grace window only ever re-issues new tokens; it never extends the
 * original session's lifetime.
 */

export const REFRESH_COOKIE_NAME = 'umodzi_refresh';
/** Cookie path covers exactly the auth endpoints that read it. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
/** Concurrent-tab grace for already-rotated refresh tokens. */
export const ROTATION_GRACE_MS = 60_000;
export const DEFAULT_REFRESH_TTL = '7d';

export type RevokeReason = 'rotated' | 'logout' | 'reuse';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  first_name: string;
  last_name: string;
  account_status: AccountStatus;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: RevokeReason | null;
  created_at: Date;
  last_used_at: Date | null;
}

/** Parse '7d' / '15m' / '3600s' / bare seconds into a number of seconds. */
export function parseTtlSeconds(value: string | undefined, fallback: string): number {
  const raw = (value ?? fallback).trim();
  const match = /^(\d+)\s*([smhd]?)$/i.exec(raw);
  if (!match) {
    throw new Error(`Invalid token TTL "${raw}" — expected e.g. 15m, 7d, 3600s.`);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit === 'h' ? 3600 : unit === 'd' ? 86400 : unit === 'm' ? 60 : 1;
  const seconds = amount * factor;
  if (seconds <= 0) {
    throw new Error(`Invalid token TTL "${raw}" — must be positive.`);
  }
  return seconds;
}

/** SHA-256 hex of the raw refresh token — the only form ever persisted. */
export function hashRefreshToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** Create a session for the user; returns the RAW token (cookie only). */
export async function createSession(userId: string): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const ttlSeconds = parseTtlSeconds(process.env.REFRESH_TOKEN_TTL, DEFAULT_REFRESH_TTL);
  await query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), NOW())`,
    [crypto.randomUUID(), userId, hashRefreshToken(rawToken), ttlSeconds],
  );
  return rawToken;
}

export interface SessionLookup {
  kind: 'valid' | 'rotated-grace' | 'reuse' | 'expired' | 'inactive' | 'unknown';
  session?: SessionRow;
  user?: UserRow;
}

/**
 * Resolve a presented raw refresh token into an actionable state.
 * Side effects: marks last_used_at on valid use; 'reuse' and 'inactive'
 * outcomes are reported so the caller can revoke the family.
 */
export async function lookupRefreshToken(rawToken: string): Promise<SessionLookup> {
  const rows = await query<
    SessionRow & {
      u_id: string;
      u_email: string;
      u_password_hash: string;
      u_role: UserRole;
      u_first_name: string;
      u_last_name: string;
      u_account_status: AccountStatus;
    }
  >(
    `SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.revoked_at, s.revoked_reason,
            s.created_at, s.last_used_at,
            u.id AS u_id, u.email AS u_email, u.password_hash AS u_password_hash,
            u.role AS u_role, u.first_name AS u_first_name, u.last_name AS u_last_name,
            u.account_status AS u_account_status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashRefreshToken(rawToken)],
  );

  if (rows.length === 0) {
    return { kind: 'unknown' };
  }
  const row = rows[0];
  const session: SessionRow = {
    id: row.id,
    user_id: row.user_id,
    token_hash: row.token_hash,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revoked_reason: row.revoked_reason,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
  const user: UserRow = {
    id: row.u_id,
    email: row.u_email,
    password_hash: row.u_password_hash,
    role: row.u_role,
    first_name: row.u_first_name,
    last_name: row.u_last_name,
    account_status: row.u_account_status,
  };

  if (row.revoked_at !== null) {
    const rotatedRecently =
      row.revoked_reason === 'rotated' &&
      Date.now() - new Date(row.revoked_at).getTime() <= ROTATION_GRACE_MS;
    if (rotatedRecently) {
      return { kind: 'rotated-grace', session, user };
    }
    // Logout, reuse detection, or a stale rotated token: replay attempt.
    return { kind: 'reuse', session, user };
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { kind: 'expired', session, user };
  }

  if (user.account_status !== 'active') {
    return { kind: 'inactive', session, user };
  }

  await query('UPDATE sessions SET last_used_at = NOW() WHERE id = $1', [row.id]);
  return { kind: 'valid', session, user };
}

/**
 * Rotate a session: revoke the presented row (reason 'rotated') and issue
 * a brand-new session + raw token for the same user.
 */
export async function rotateSession(sessionId: string, userId: string): Promise<string> {
  // Only revoke if still active: re-presenting a token inside the grace
  // window must not push its original revocation time forward (otherwise
  // a replayed token could keep its grace alive indefinitely).
  await query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'rotated'
     WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
  return createSession(userId);
}

/** Revoke one session by id with an explicit reason (logout / reuse). */
export async function revokeSession(sessionId: string, reason: RevokeReason): Promise<void> {
  await query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = $2
     WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

/** Revoke every session belonging to a user (reuse/inactive defence). */
export async function revokeAllSessions(userId: string, reason: RevokeReason): Promise<void> {
  await query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
}

/** Revoke by raw token — used by logout when only the cookie is available. */
export async function revokeSessionByToken(
  rawToken: string,
  reason: RevokeReason,
): Promise<void> {
  await query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = $2
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashRefreshToken(rawToken), reason],
  );
}

/** Opportunistic housekeeping: drop sessions long past expiry. */
export async function purgeExpiredSessions(): Promise<void> {
  await query(`DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '7 days'`);
}
