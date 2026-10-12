import { z } from 'zod';
import { query, transaction } from '../db/client.js';
import { HttpError } from './httpError.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { createSession, purgeExpiredSessions, type UserRow } from './sessionService.js';
import { CANONICAL_CATEGORIES, type AuthUserApi } from '../types/api.js';

/**
 * Authentication service (Task 23) — pure application logic for
 * registration, login, and identity lookups. HTTP concerns (cookies,
 * replies) stay in routes.ts; token signing stays in jwt.ts.
 *
 * Security rules enforced here:
 *   - emails are normalized (trim + lowercase) before every lookup and
 *     insert; uniqueness is enforced by a UNIQUE index on lower(email);
 *   - passwords: argon2id digests only — plaintext never stored, never
 *     returned, never logged;
 *   - login answers with ONE generic error whether the email is unknown
 *     or the password is wrong (plus dummy-hash timing equalisation);
 *   - public registration can never create an administrator (403);
 *   - only `active` accounts authenticate — suspended/disabled accounts
 *     are rejected at login AND at every authorization (requireAuth).
 */

/** Deterministic placeholder coordinates for brand-new technician profiles. */
export const CITY_CENTRES: Record<string, { latitude: number; longitude: number }> = {
  Kitwe: { latitude: -12.8105, longitude: 28.2073 },
  Ndola: { latitude: -12.9587, longitude: 28.6366 },
};

export const GENERIC_LOGIN_ERROR = 'Invalid email or password';

const SERVICE_AREAS = ['Kitwe', 'Ndola'] as const;

const registerSchema = z
  .object({
    email: z.string().trim().min(3).max(254).email('Enter a valid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    firstName: z.string().trim().min(1, 'First name is required').max(80),
    lastName: z.string().trim().max(80),
    role: z.enum(['customer', 'technician']),
    category: z.enum(CANONICAL_CATEGORIES as unknown as [string, ...string[]]).optional(),
    serviceArea: z.enum(SERVICE_AREAS).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.role === 'technician') {
      if (!value.category) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['category'],
          message: 'A service category is required for technician accounts',
        });
      }
      if (!value.serviceArea) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['serviceArea'],
          message: 'A service area is required for technician accounts',
        });
      }
    }
  });

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').max(254),
  password: z.string().min(1, 'Password is required').max(128),
});

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Map an internal user row (+ linked technician profile) to the public shape. */
export async function toAuthUserApi(row: UserRow): Promise<AuthUserApi> {
  const user: AuthUserApi = {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    accountStatus: row.account_status,
  };
  if (row.role === 'technician') {
    const profiles = await query<{ id: string; name: string }>(
      'SELECT id, name FROM technicians WHERE user_id = $1',
      [row.id],
    );
    if (profiles[0]) {
      user.technicianId = profiles[0].id;
      user.technicianName = profiles[0].name;
    }
  }
  return user;
}

/** Fetch a user row by id (authoritative identity lookup for requireAuth). */
export async function getUserRow(userId: string): Promise<UserRow | null> {
  const rows = await query<UserRow>(
    `SELECT id, email, password_hash, role, first_name, last_name, account_status
     FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: string;
  category?: string;
  serviceArea?: string;
}

/**
 * Create a customer or technician account. Administrator is rejected
 * before validation with an explicit 403 — public registration can never
 * mint an admin (admins come only from the controlled ADMIN_* seed).
 * Technician accounts get exactly ONE linked technician profile row
 * (unique index on technicians.user_id), created in the same transaction.
 */
export async function registerAccount(input: unknown): Promise<AuthUserApi> {
  if (
    typeof input === 'object' &&
    input !== null &&
    'role' in input &&
    (input as { role?: unknown }).role === 'administrator'
  ) {
    throw new HttpError(403, 'Administrator accounts cannot be created through public registration.');
  }

  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, 'Validation failed', parsed.error.flatten());
  }
  const data = parsed.data;
  const email = normalizeEmail(data.email);
  const passwordDigest = await hashPassword(data.password); // argon2id — never logged

  try {
    return await transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, account_status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
         RETURNING id, email, password_hash, role, first_name, last_name, account_status`,
        [email, passwordDigest, data.role, data.firstName, data.lastName],
      );
      const row = inserted.rows[0] as UserRow;

      if (data.role === 'technician') {
        const area = data.serviceArea;
        const centre = area ? CITY_CENTRES[area] : undefined;
        if (!area || !centre) {
          // superRefine already enforces this; belt-and-braces for types.
          throw new HttpError(400, 'A valid service area is required for technician accounts');
        }
        const fullName = `${data.firstName} ${data.lastName}`.trim();
        await client.query(
          `INSERT INTO technicians
             (name, category, skills, service_area, latitude, longitude, rating, jobs,
              verified, availability, availability_status, account_status, location, user_id,
              created_at, updated_at)
           VALUES ($1, $2, '[]'::jsonb, $3, $4, $5, 0, 0, false,
                   'Available now', 'available', 'active',
                   ST_GeomFromText($6, 4326), $7, NOW(), NOW())`,
          [
            fullName,
            data.category,
            area,
            centre.latitude,
            centre.longitude,
            `POINT(${centre.longitude} ${centre.latitude})`,
            row.id,
          ],
        );
      }

      return toAuthUserApi(row);
    });
  } catch (error) {
    // Unique violation on lower(email) → duplicate registration.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new HttpError(409, 'An account with this email already exists.');
    }
    throw error;
  }
}

export interface LoginResult {
  user: AuthUserApi;
  rawRefreshToken: string;
}

/**
 * Verify credentials and open a session.
 * Returns the safe user plus the RAW refresh token (routes.ts puts the
 * token in the HttpOnly cookie — it is never included in the JSON body).
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const parsed = loginSchema.safeParse({ email, password });
  if (!parsed.success) {
    throw new HttpError(401, GENERIC_LOGIN_ERROR);
  }

  const rows = await query<UserRow>(
    `SELECT id, email, password_hash, role, first_name, last_name, account_status
     FROM users WHERE lower(email) = $1`,
    [normalizeEmail(parsed.data.email)],
  );
  const user = rows[0];

  if (!user) {
    // Equalised timing: spend the same work as a real verification.
    await verifyAgainstDummy(parsed.data.password);
    throw new HttpError(401, GENERIC_LOGIN_ERROR);
  }

  const passwordOk = await verifyPassword(user.password_hash, parsed.data.password);
  if (!passwordOk) {
    throw new HttpError(401, GENERIC_LOGIN_ERROR); // identical to unknown email
  }

  if (user.account_status !== 'active') {
    // The caller proved the password, so an honest status error is safe.
    throw new HttpError(403, 'This account is not active.');
  }

  const rawRefreshToken = await createSession(user.id);
  void purgeExpiredSessions().catch(() => {
    /* housekeeping only — never fails a login */
  });

  return { user: await toAuthUserApi(user), rawRefreshToken };
}

/** Safe identity for GET /auth/me (re-read from the database every time). */
export async function getCurrentUser(userId: string): Promise<AuthUserApi | null> {
  const row = await getUserRow(userId);
  if (!row) return null;
  return toAuthUserApi(row);
}

/** UUID shape guard shared by route parameter validation. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Convenience for error-safe id checks (invalid id → 400, not a 500). */
export function assertUuid(value: string): void {
  if (!isUuid(value)) {
    throw new HttpError(400, 'Invalid id format');
  }
}
