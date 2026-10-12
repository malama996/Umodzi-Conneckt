/**
 * Task 29 focused frontend tests: concurrent 401 → refresh behaviour.
 *
 * The concern (raised by a live backend log) was that several protected
 * requests failing together could each fire their own POST /auth/refresh.
 * Because that endpoint ROTATES the cookie (backend/src/auth/sessionService.ts),
 * redundant refreshes are more than wasteful: replaying a rotated cookie
 * outside the backend's 60s grace window revokes every session for the user.
 *
 * Run from the frontend folder:
 *   npx --no-install tsx scripts/task29-refresh-tests.ts
 *
 * These are white-box tests against the REAL lib/api/client.ts and
 * lib/auth/auth* modules with a stubbed global fetch. Concurrency is not
 * asserted by sleeping and hoping — each case records the exact order of
 * outbound calls, so "all three requests were already in flight before the
 * refresh started" is checked from evidence rather than assumed.
 *
 * Server-side rotation/grace/logout/reuse semantics are covered by
 * backend/scripts/task23-api-tests.ts against a running backend.
 */
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:9999/api/v1';

import { ApiError, get, post } from '../lib/api/client';
import {
  ensureAuthInitialized,
  getAuthSnapshot,
  login,
  logout,
  resetAuthStoreForTests,
} from '../lib/auth/authStore';
import {
  getAccessToken,
  isSessionDead,
  setAccessToken,
  tryRefreshOnce,
} from '../lib/auth/tokenHolder';
import type { AuthUser } from '../lib/auth/authTypes';

/* ------------------------------------------------------------------ */
/* Tiny assertion harness                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/* Fetch stub                                                          */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  url: string;
  method: string;
}

let calls: RecordedCall[] = [];
type StubHandler = (url: string, init: RequestInit) => Promise<Response>;
let stub: StubHandler | null = null;

function installStub(handler: StubHandler): void {
  calls = [];
  stub = handler;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (!stub) throw new Error('no fetch stub installed');
    return stub(url, init ?? {});
  }) as typeof fetch;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function count(fragment: string): number {
  return calls.filter((c) => c.url.includes(fragment)).length;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const USER: AuthUser = {
  id: 'u-task29',
  email: 'case@umodzi.test',
  firstName: 'Task29',
  lastName: 'Case',
  role: 'customer',
  accountStatus: 'active',
};

function payload(token: string): unknown {
  return { data: { accessToken: token, user: USER } };
}

const NO_SESSION = { error: 'Session is invalid or expired' };
const EXPIRED_ACCESS = { error: 'Invalid or expired access token' };

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

/**
 * Boot restore used to call the refresh endpoint DIRECTLY, outside the
 * single flight. A protected request firing while that refresh was still
 * in flight (accessToken is still null, so it 401s) therefore started a
 * second refresh with the same rotating cookie. Both must now coalesce.
 */
async function caseBootSharesSingleFlight(): Promise<void> {
  section('boot restore and 401 recovery share one refresh');
  resetAuthStoreForTests();
  let refreshes = 0;

  installStub(async (url) => {
    if (url.includes('/auth/refresh')) {
      refreshes += 1;
      await delay(40);
      return json(200, payload('boot-token'));
    }
    if (getAccessToken() !== 'boot-token') return json(401, EXPIRED_ACCESS);
    return json(200, { data: { ok: true } });
  });

  const boot = ensureAuthInitialized();
  const early = get<{ data: { ok: boolean } }>('/me/requests');
  await Promise.allSettled([boot, early]);

  assert(refreshes === 1, `boot + 401 recovery issued ONE refresh (got ${refreshes})`);
  assert(
    count('/me/requests') === 2,
    `early request retried exactly once (got ${count('/me/requests')})`,
  );
  assert(getAuthSnapshot().status === 'authenticated', 'session restored to authenticated');
}

/**
 * The core concurrency case: three protected requests are issued
 * together, all fail, and must share a single refresh.
 */
async function caseSimultaneous401ShareOneRefresh(): Promise<void> {
  section('three simultaneous 401s share one refresh');
  resetAuthStoreForTests();
  setAccessToken('stale-token');
  let refreshes = 0;

  installStub(async (url) => {
    if (url.includes('/auth/refresh')) {
      refreshes += 1;
      await delay(40);
      return json(200, payload('fresh-token'));
    }
    if (getAccessToken() !== 'fresh-token') return json(401, EXPIRED_ACCESS);
    return json(200, { data: { ok: true } });
  });

  const paths = ['/me/a', '/me/b', '/me/c'];
  const results = await Promise.allSettled(paths.map((p) => get(p)));

  // Evidence of real concurrency: the three protected calls were already
  // recorded before the refresh began, so they genuinely overlapped.
  assert(
    calls.length >= 4 && calls[0].url.includes('/me/a') && calls[3].url.includes('/auth/refresh'),
    'all three requests were in flight before the refresh started',
  );
  assert(refreshes === 1, `exactly ONE refresh for the burst (got ${refreshes})`);
  assert(
    results.every((r) => r.status === 'fulfilled'),
    'all three requests succeeded after the shared refresh',
  );
  for (const p of paths) {
    assert(count(p) === 2, `${p} retried exactly once (got ${count(p)})`);
  }
}

/**
 * The observed production pattern: refresh rejected, and every later 401
 * in the same burst must NOT re-present the dead cookie.
 */
async function caseFailedRefreshShortCircuitsBurst(): Promise<void> {
  section('failed refresh: one attempt, no retries, burst short-circuited');
  resetAuthStoreForTests();
  setAccessToken('stale-token');
  let refreshes = 0;

  installStub(async (url) => {
    if (url.includes('/auth/refresh')) {
      refreshes += 1;
      await delay(30);
      return json(401, NO_SESSION);
    }
    return json(401, EXPIRED_ACCESS);
  });

  const paths = ['/me/a', '/me/b', '/me/c'];
  const results = await Promise.allSettled(paths.map((p) => get(p)));

  assert(refreshes === 1, `only ONE refresh attempt for the burst (got ${refreshes})`);
  assert(
    results.every(
      (r) => r.status === 'rejected' && r.reason instanceof ApiError && r.reason.status === 401,
    ),
    'each request rejected with ApiError 401',
  );
  for (const p of paths) {
    assert(count(p) === 1, `${p} NOT retried after a failed refresh (got ${count(p)})`);
  }
  assert(getAuthSnapshot().status === 'anonymous', 'client auth state cleared to anonymous');
  assert(isSessionDead(), 'session marked dead after a server rejection');

  // A later 401 must be refused without any network traffic at all.
  await get('/me/d').catch(() => undefined);
  assert(refreshes === 1, `later 401 did not fire another refresh (still ${refreshes})`);
  assert(count('/me/d') === 1, 'later request was not retried');
}

/** A request that keeps returning 401 must be retried once and then fail. */
async function caseRetryHappensAtMostOnce(): Promise<void> {
  section('retry limit: one retry per request, no refresh loop');
  resetAuthStoreForTests();
  setAccessToken('stale-token');
  let refreshes = 0;

  installStub(async (url) => {
    if (url.includes('/auth/refresh')) {
      refreshes += 1;
      await delay(10);
      return json(200, payload('fresh-token'));
    }
    return json(401, { error: 'still unauthorized' });
  });

  let caught: unknown;
  try {
    await get('/me/always-401');
  } catch (error) {
    caught = error;
  }

  assert(
    caught instanceof ApiError && caught.status === 401,
    'the final 401 is surfaced to the caller',
  );
  assert(refreshes === 1, `exactly ONE refresh despite repeated 401s (got ${refreshes})`);
  assert(
    count('/me/always-401') === 2,
    `original + exactly one retry (got ${count('/me/always-401')})`,
  );
}

/** /auth/* must never trigger a refresh of itself (no recursion). */
async function caseAuthEndpointsNeverRefresh(): Promise<void> {
  section('authentication endpoints never invoke refresh');
  resetAuthStoreForTests();
  setAccessToken('stale-token');
  let refreshes = 0;

  installStub(async (url) => {
    if (url.includes('/auth/refresh')) {
      refreshes += 1;
      return json(401, NO_SESSION);
    }
    if (url.includes('/auth/login')) return json(401, { error: 'Invalid credentials' });
    return json(401, { error: 'nope' });
  });

  const loginFailure = await post('/auth/login', { email: 'x', password: 'y' }).catch((e) => e);
  assert(
    loginFailure instanceof ApiError && loginFailure.status === 401,
    'login failure surfaces 401',
  );
  assert(refreshes === 0, `login 401 did NOT invoke refresh (refresh calls: ${refreshes})`);

  const refreshFailure = await post('/auth/refresh').catch((e) => e);
  assert(
    refreshFailure instanceof ApiError && refreshFailure.status === 401,
    'direct refresh failure surfaces 401',
  );
  assert(refreshes === 1, `direct refresh was not re-entrant (calls: ${refreshes})`);
}

/** A network outage must not be mistaken for a dead session. */
async function caseNetworkFailureStaysRetryable(): Promise<void> {
  section('network failure stays retryable (does not kill the session)');
  resetAuthStoreForTests();
  setAccessToken('stale-token');

  installStub(async () => {
    throw new TypeError('Failed to fetch');
  });
  const first = await tryRefreshOnce();
  assert(first === false, 'refresh reports failure');
  assert(isSessionDead() === false, 'network failure did NOT mark the session dead');

  installStub(async (url) => {
    if (url.includes('/auth/refresh')) return json(200, payload('fresh-token'));
    return json(200, { data: { ok: true } });
  });
  const second = await tryRefreshOnce();
  assert(second === true, 'refresh is retryable once the network is back');
}

/** Logout revokes server-side, clears state, and blocks further refresh. */
async function caseLogoutRevokesAndBlocksRefresh(): Promise<void> {
  section('logout: server revocation, cleared state, no later refresh');
  resetAuthStoreForTests();
  setAccessToken('live-token');
  let logouts = 0;
  let refreshes = 0;

  installStub(async (url) => {
    if (url.includes('/auth/logout')) {
      logouts += 1;
      return json(200, { data: { ok: true } });
    }
    if (url.includes('/auth/refresh')) {
      refreshes += 1;
      return json(200, payload('fresh-token'));
    }
    return json(200, { data: { ok: true } });
  });

  await logout();

  assert(logouts === 1, `POST /auth/logout sent exactly once (got ${logouts})`);
  assert(getAccessToken() === null, 'access token cleared');
  assert(getAuthSnapshot().status === 'anonymous', 'auth state cleared to anonymous');
  assert(isSessionDead(), 'revoked session is not refreshable afterwards');

  const ok = await tryRefreshOnce();
  assert(ok === false, 'post-logout refresh attempt is refused');
  assert(refreshes === 0, `refused without a network call (refresh calls: ${refreshes})`);
}

/** Signing in again must re-arm refresh after a dead session. */
async function caseLoginRearmsRefresh(): Promise<void> {
  section('login re-arms refresh after a dead session');
  resetAuthStoreForTests();
  setAccessToken('stale-token');

  installStub(async (url) => {
    if (url.includes('/auth/refresh')) return json(401, NO_SESSION);
    return json(401, EXPIRED_ACCESS);
  });
  await tryRefreshOnce();
  assert(isSessionDead(), 'session is dead after the rejection');

  installStub(async (url) => {
    if (url.includes('/auth/login')) return json(200, payload('new-token'));
    if (url.includes('/auth/refresh')) return json(200, payload('new-token'));
    return json(200, { data: { ok: true } });
  });
  await login('case@umodzi.test', 'pw-not-a-real-secret');

  assert(isSessionDead() === false, 'login re-armed refresh');
  assert(getAccessToken() === 'new-token', 'access token stored after login');
  const ok = await tryRefreshOnce();
  assert(ok === true, 'refresh works again after a successful login');
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await caseBootSharesSingleFlight();
  await caseSimultaneous401ShareOneRefresh();
  await caseFailedRefreshShortCircuitsBurst();
  await caseRetryHappensAtMostOnce();
  await caseAuthEndpointsNeverRefresh();
  await caseNetworkFailureStaysRetryable();
  await caseLogoutRevokesAndBlocksRefresh();
  await caseLoginRearmsRefresh();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main();
