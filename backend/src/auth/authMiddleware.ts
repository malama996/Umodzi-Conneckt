import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { getUserRow } from './authService.js';
import { HttpError } from './httpError.js';
import { verifyAccessToken } from './jwt.js';
import type { AccountStatus, UserRole } from '../types/api.js';

/**
 * Authentication/authorization guards (Task 23).
 *
 * requireAuth   — extracts `Authorization: Bearer <jwt>`, verifies
 *                 signature/expiry/issuer/audience/claims, then RE-READS
 *                 the user from PostgreSQL. The database is authoritative:
 *                 a suspended/disabled account is rejected here even while
 *                 its access token is still cryptographically valid, and
 *                 the role used for authorization is the stored role, not
 *                 the token's claim.
 * requireRole   — factory returning a preHandler that runs requireAuth and
 *                 then enforces one or more allowed roles (403 otherwise).
 *
 * Client-supplied userId/role/technicianId fields are never consulted.
 */

export interface AuthenticatedUser {
  id: string;
  /** Role re-read from the database on every request (never the JWT claim). */
  role: UserRole;
  email: string;
  firstName: string;
  lastName: string;
  accountStatus: AccountStatus;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAuth on every protected request. */
    authUser?: AuthenticatedUser;
  }
}

const BEARER_PREFIX = 'Bearer ';

/** Resolve and verify the access token; throws 401 on any problem. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (request.authUser) return; // already authenticated by an earlier hook

  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
    throw new HttpError(401, 'Authentication required');
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    throw new HttpError(401, 'Authentication required');
  }

  let claims;
  try {
    claims = verifyAccessToken(request.server, token);
  } catch {
    // Expired, forged, wrong-secret, wrong issuer/audience, malformed,
    // or missing required claims — one indistinguishable 401.
    throw new HttpError(401, 'Invalid or expired access token');
  }

  const row = await getUserRow(claims.sub);
  if (!row) {
    throw new HttpError(401, 'Invalid or expired access token');
  }
  if (row.account_status !== 'active') {
    // Existing sessions for suspended/disabled accounts are rejected at
    // every protected endpoint — JWT expiry alone is never relied upon.
    throw new HttpError(401, 'Account is not active');
  }

  request.authUser = {
    id: row.id,
    role: row.role, // DB-authoritative, NOT claims.role
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    accountStatus: row.account_status,
  };
}

/**
 * Build a preHandler that requires authentication AND at least one of
 * the given roles. Authorization logic lives only here — routes compose
 * it instead of re-implementing it.
 */
export function requireRole(
  ...roles: UserRole[]
): preHandlerHookHandler {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(request, reply);
    const user = request.authUser;
    if (!user) {
      throw new HttpError(401, 'Authentication required');
    }
    if (!roles.includes(user.role)) {
      throw new HttpError(403, 'Forbidden: your account does not have access to this resource');
    }
  };
}
