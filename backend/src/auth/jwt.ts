import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import type { UserRole } from '../types/api.js';

/**
 * JWT access tokens (Task 23).
 *
 * Design:
 *   - HS256 signed with JWT_SECRET, which MUST come from the environment
 *     (no default, no hard-coded fallback — startup fails fast without it).
 *   - Issuer/audience are configurable and verified on every protected
 *     request, so a token minted for another service is rejected.
 *   - Payload is the minimum identity set: `sub` (user UUID), `role`,
 *     `jti` (unique token id) plus the standard `iat`/`exp`/`iss`/`aud`.
 *     No email, no names, no profile data, no password material — the
 *     database is re-read on every authorization, so mutable state is
 *     never trusted from the token.
 *   - Default lifetime 15 minutes (ACCESS_TOKEN_TTL).
 *
 * Verification rejects: bad signature, expiry, wrong issuer/audience, and
 * structurally missing/typed-wrong claims (sub/role/jti) — see
 * verifyAccessToken().
 */

export interface JwtConfig {
  secret: string;
  issuer: string;
  audience: string;
  accessTtl: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_PATTERN = /^(customer|technician|administrator)$/;
const MIN_SECRET_LENGTH = 32;

/**
 * Load and validate token configuration from the environment.
 * Throws (before any route serves traffic) when JWT_SECRET is missing,
 * too short, or malformed — there is intentionally no insecure default.
 */
export function loadJwtConfig(env: NodeJS.ProcessEnv = process.env): JwtConfig {
  const secret = env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error(
      'JWT_SECRET environment variable is required (generate e.g. `openssl rand -hex 32`).',
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters long.`);
  }
  return {
    secret,
    issuer: env.JWT_ISSUER?.trim() || 'umodzi-connect-api',
    audience: env.JWT_AUDIENCE?.trim() || 'umodzi-connect-web',
    accessTtl: env.ACCESS_TOKEN_TTL?.trim() || '15m',
  };
}

/** Register @fastify/jwt on an instance with the configured claims policy. */
export async function registerJwt(app: FastifyInstance, config: JwtConfig): Promise<void> {
  // fast-jwt option names: sign uses `iss`/`aud`; verification enforces the
  // claims via `allowedIss`/`allowedAud` (rejected tokens from a foreign
  // issuer/audience fail verification like a bad signature).
  await app.register(fastifyJwt, {
    secret: config.secret,
    sign: {
      iss: config.issuer,
      aud: config.audience,
      expiresIn: config.accessTtl,
    },
    verify: {
      allowedIss: config.issuer,
      allowedAud: config.audience,
    },
  });
}

export interface AccessTokenSubject {
  id: string;
  role: UserRole;
}

/** Sign a minimal access token for an authenticated user. */
export function signAccessToken(app: FastifyInstance, subject: AccessTokenSubject): string {
  return app.jwt.sign({
    sub: subject.id,
    role: subject.role,
    jti: crypto.randomUUID(),
  });
}

export interface VerifiedToken {
  sub: string;
  role: UserRole;
  jti: string;
}

/**
 * Verify signature, expiry, issuer, audience AND the required claims.
 * Throws on anything invalid — callers translate that to 401 without
 * echoing verification details to the client.
 */
export function verifyAccessToken(app: FastifyInstance, token: string): VerifiedToken {
  const claims = app.jwt.verify(token) as Record<string, unknown>;

  const sub = claims.sub;
  const role = claims.role;
  const jti = claims.jti;

  if (typeof sub !== 'string' || !UUID_PATTERN.test(sub)) {
    throw new Error('Token is missing a valid subject claim');
  }
  if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) {
    throw new Error('Token is missing a valid role claim');
  }
  if (typeof jti !== 'string' || jti.length === 0) {
    throw new Error('Token is missing a token id claim');
  }

  return { sub, role: role as UserRole, jti };
}
