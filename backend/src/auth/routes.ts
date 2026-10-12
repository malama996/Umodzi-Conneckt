import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { requireAuth } from './authMiddleware.js';
import { getCurrentUser, login, registerAccount, toAuthUserApi } from './authService.js';
import { HttpError } from './httpError.js';
import { signAccessToken } from './jwt.js';
import {
  DEFAULT_REFRESH_TTL,
  lookupRefreshToken,
  parseTtlSeconds,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  revokeAllSessions,
  revokeSessionByToken,
  rotateSession,
} from './sessionService.js';
import { recordAuditEvent } from '../privacy/auditService.js';

/**
 * Auth API routes (Task 23): POST /register, /login, /refresh, /logout
 * and GET /me — mounted under /api/v1/auth by server.ts.
 *
 * Cookie policy for the refresh token:
 *   HttpOnly  — JavaScript (and therefore any XSS) can never read it
 *   Path      — /api/v1/auth (only the endpoints that need it receive it)
 *   SameSite  — Lax (localhost:3000 → localhost:3001 is same-site, so the
 *               cookie rides along on credentialed fetches in development
 *               and on any same-domain production deployment)
 *   Secure    — enabled exactly when the request itself arrived over
 *               HTTPS, so production deployments are strict without
 *               breaking plain-HTTP local development
 *   Raw token — never placed in the JSON response body, never logged;
 *               the server only ever stored its SHA-256 hash.
 *
 * Rate limiting: the official @fastify/rate-limit plugin, registered in
 * THIS encapsulated scope only (auth endpoints), in-memory per process —
 * no Redis, no new infrastructure. Login/register are stricter than
 * refresh because credential guessing is the primary abuse vector.
 */

function setRefreshCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  rawToken: string,
  maxAgeSeconds: number,
): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const configuredSameSite = process.env.COOKIE_SAME_SITE;
  const sameSite =
    configuredSameSite === 'none' || configuredSameSite === 'strict' || configuredSameSite === 'lax'
      ? configuredSameSite
      : 'lax';
  reply.setCookie(REFRESH_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: isProduction ? process.env.COOKIE_SECURE === 'true' : request.protocol === 'https',
    sameSite,
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  });
}

function clearRefreshCookie(reply: FastifyReply, request: FastifyRequest): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const configuredSameSite = process.env.COOKIE_SAME_SITE;
  const sameSite =
    configuredSameSite === 'none' || configuredSameSite === 'strict' || configuredSameSite === 'lax'
      ? configuredSameSite
      : 'lax';
  reply.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction ? process.env.COOKIE_SECURE === 'true' : request.protocol === 'https',
    sameSite,
    path: REFRESH_COOKIE_PATH,
  });
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'true') {
    throw new Error('COOKIE_SECURE=true is required in production.');
  }
  // Scoped rate limiter: hook applies only to routes in this plugin.
  await app.register(fastifyRateLimit, {
    max: 60,
    timeWindow: '1 minute',
  });

  const refreshTtlSeconds = parseTtlSeconds(
    process.env.REFRESH_TOKEN_TTL,
    DEFAULT_REFRESH_TTL,
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/register — customer or technician only.
  // Administrator is rejected with an explicit 403 inside registerAccount().
  // -------------------------------------------------------------------------
  app.post(
    '/register',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = await registerAccount(request.body);
      reply.status(201);
      return reply.send({ data: { user } });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/login — generic 401 for unknown email AND wrong
  // password (identical body, equalised timing); 403 only once the password
  // has been proven for a suspended/disabled account.
  //
  // Task 28.3F: both outcomes are audited. The failure record deliberately
  // stores NO email address and NO user id — an attacker probing this endpoint
  // would otherwise be able to mine the log to enumerate which accounts exist.
  // A failed attempt is recorded with a null actor and a reason code only.
  // -------------------------------------------------------------------------
  app.post(
    '/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
      try {
        const { user, rawRefreshToken } = await login(
          typeof body.email === 'string' ? body.email : '',
          typeof body.password === 'string' ? body.password : '',
        );
        await recordAuditEvent({
          eventType: 'auth.login_succeeded',
          actorUserId: user.id,
          actorRole: user.role,
          targetUserId: user.id,
          targetEntityType: 'user',
          targetEntityId: user.id,
          metadata: { route: '/api/v1/auth/login' },
        });
        setRefreshCookie(reply, request, rawRefreshToken, refreshTtlSeconds);
        const accessToken = signAccessToken(request.server, {
          id: user.id,
          role: user.role,
        });
        return reply.send({ data: { user, accessToken } });
      } catch (error) {
        // The status/message the client sees is unchanged: auditing must not
        // become a side channel that distinguishes failure causes.
        const statusCode =
          typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          typeof error.statusCode === 'number'
            ? error.statusCode
            : 500;
        await recordAuditEvent({
          eventType: statusCode === 403 ? 'auth.account_locked' : 'auth.login_failed',
          outcome: 'failure',
          actorUserId: null,
          actorRole: null,
          metadata: {
            reason_code: statusCode === 403 ? 'account_not_active' : 'invalid_credentials',
            route: '/api/v1/auth/login',
            status_code: statusCode,
          },
        });
        throw error;
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/refresh — cookie → hash → session lookup → rotate.
  // Outcomes: unknown/expired → 401; revoked-as-logout → 401; reuse beyond
  // the rotation grace window → revoke EVERY session for that user → 401;
  // suspended/disabled user → revoke sessions → 401; otherwise a new
  // session (fresh cookie) + a new access token.
  // -------------------------------------------------------------------------
  app.post('/refresh', async (request, reply) => {
    const raw = request.cookies[REFRESH_COOKIE_NAME];
    if (!raw) {
      throw new HttpError(401, 'No active session');
    }

    const lookup = await lookupRefreshToken(raw);

    if (lookup.kind === 'unknown' || lookup.kind === 'expired') {
      throw new HttpError(401, 'Session is invalid or expired');
    }
    if (lookup.kind === 'reuse') {
      // Replay of a logged-out or long-rotated token → family invalidation.
      if (lookup.user) await revokeAllSessions(lookup.user.id, 'reuse');
      throw new HttpError(401, 'Session has been revoked');
    }
    if (lookup.kind === 'inactive') {
      if (lookup.user) await revokeAllSessions(lookup.user.id, 'logout');
      throw new HttpError(401, 'Session is no longer active');
    }
    if (!lookup.session || !lookup.user) {
      throw new HttpError(401, 'Session is invalid or expired');
    }

    const newRawToken = await rotateSession(lookup.session.id, lookup.user.id);
    setRefreshCookie(reply, request, newRawToken, refreshTtlSeconds);

    const user = await toAuthUserApi(lookup.user);
    const accessToken = signAccessToken(request.server, {
      id: lookup.user.id,
      role: lookup.user.role,
    });
    return reply.send({ data: { user, accessToken } });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/logout — revoke the presented session ('logout'
  // reason, no grace window) and clear the cookie. Idempotent: answering
  // 200 without a cookie keeps clients simple and leaks nothing.
  // -------------------------------------------------------------------------
  app.post('/logout', async (request, reply) => {
    const raw = request.cookies[REFRESH_COOKIE_NAME];
    if (raw) {
      await revokeSessionByToken(raw, 'logout');
    }
    clearRefreshCookie(reply, request);
    return reply.send({ data: { ok: true } });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/auth/me — identity re-read from the database (requireAuth
  // has already verified token + active account status).
  // -------------------------------------------------------------------------
  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      throw new HttpError(401, 'Authentication required');
    }
    const user = await getCurrentUser(authUser.id);
    if (!user) {
      throw new HttpError(401, 'Invalid or expired access token');
    }
    return reply.send({ data: { user } });
  });
}
