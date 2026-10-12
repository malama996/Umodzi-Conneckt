/**
 * Task 28.2B API tests: authenticated Web Push subscription management
 * (POST + DELETE /api/v1/me/push-subscriptions) against a RUNNING backend
 * (start it first) backed by the LOCAL scratch database — never Supabase.
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *   npx tsx scripts/task28-push-subscriptions-tests.ts
 *
 * Covers:
 *   Authentication — anonymous POST/DELETE 401, forged token 401;
 *   Validation — missing/empty/malformed endpoint (http, ftp, non-URL),
 *     missing p256dh/auth, oversized endpoint/p256dh/auth/userAgent,
 *     unknown fields (incl. user_id) rejected by the strict schema,
 *     non-string endpoint rejected;
 *   Ownership — A deletes A's sub; A cannot delete B's sub (safe 404, row
 *     intact); user_id in the body can never reassign ownership;
 *   Persistence — valid subscription stored under the caller's id;
 *     duplicate (user_id, endpoint) updates instead of duplicating
 *     (200, same id, metadata refreshed); same endpoint URL coexists
 *     across users; any authenticated role may subscribe;
 *   Cleanup — baseline restored (0 subscriptions), seeded admin preserved.
 *
 * Exactly 3 successful logins, zero failed logins (rate-budget discipline).
 */

import crypto from 'node:crypto';
import { query } from '../src/db/client.js';

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

if (!process.env.DATABASE_URL || !ADMIN_EMAIL) {
  console.error('Missing required environment variables: DATABASE_URL and ADMIN_EMAIL');
  console.error('Pass the LOCAL scratch DATABASE_URL and ADMIN_EMAIL explicitly —');
  console.error('the suite deletes every @umodzi.test user except the admin.');
  process.exit(1);
}

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

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

interface ApiResponse {
  status: number;
  text: string;
  body: any;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, text, body };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
const PASSWORD = 'Task28Push2b!42';
const EMAIL_A = `push-a-282b-${RUN}@umodzi.test`;
const EMAIL_B = `push-b-282b-${RUN}@umodzi.test`;
const EMAIL_C = `push-c-282b-${RUN}@umodzi.test`;

const EP_A = `https://push.example.com/s28/${RUN}/a`;
const EP_B = `https://push.example.com/s28/${RUN}/b`;
const P256DH_A = 'A'.repeat(87);
const AUTH_A = 'B'.repeat(22);
const P256DH_B = 'C'.repeat(87);
const AUTH_B = 'D'.repeat(22);
const UA_A = 'UmodziTestBrowser/1.0';
const UA_A2 = 'UmodziTestBrowser/2.0';

interface Session {
  userId: string;
  token: string;
}

let loginCount = 0;

// Baseline captured before fixtures: the shared database's prototype
// count is environment state (the scratch-era hard-coded "9 prototypes"
// no longer matches), so cleanup asserts the count it actually started
// with rather than a frozen number.
let baselineTechnicians = -1;

async function login(email: string, password: string): Promise<ApiResponse> {
  loginCount += 1;
  return api('POST', '/auth/login', { body: { email, password } });
}

function sessionFrom(response: ApiResponse): Session {
  const user = response.body?.data?.user as { id: string };
  return { userId: user.id, token: response.body?.data?.accessToken as string };
}

interface Sessions {
  custA: Session;
  custB: Session;
  techC: Session;
}

async function createFixtures(): Promise<Sessions> {
  console.log('\nfixtures: 2 customers + 1 technician');

  for (const [email, firstName, lastName, role, extra] of [
    [EMAIL_A, 'Mutinta', 'Chanda', 'customer', {}],
    [EMAIL_B, 'Kabwe', 'Mulenga', 'customer', {}],
    [EMAIL_C, 'Temba', 'Sakala', 'technician', { category: 'Electrical', serviceArea: 'Kitwe' }],
  ] as const) {
    const res = await api('POST', '/auth/register', {
      body: { email, password: PASSWORD, firstName, lastName, role, ...extra },
    });
    assert(res.status === 201, `registration ${email} → 201`);
  }

  const custA = sessionFrom(await login(EMAIL_A, PASSWORD));
  const custB = sessionFrom(await login(EMAIL_B, PASSWORD));
  const techC = sessionFrom(await login(EMAIL_C, PASSWORD));
  assert(Boolean(custA.token && custB.token && techC.token), 'all three sessions issued');

  return { custA, custB, techC };
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function testAuthentication(s: Sessions): Promise<void> {
  console.log('\nauthentication');
  void s;

  const anonPost = await api('POST', '/me/push-subscriptions', {
    body: { endpoint: EP_A, p256dh: P256DH_A, auth: AUTH_A },
  });
  assert(anonPost.status === 401, 'unauthenticated POST → 401');

  const anonDelete = await api('DELETE', `/me/push-subscriptions/${crypto.randomUUID()}`);
  assert(anonDelete.status === 401, 'unauthenticated DELETE → 401');

  const forged = await api('POST', '/me/push-subscriptions', {
    token: 'forged-access-token',
    body: { endpoint: EP_A, p256dh: P256DH_A, auth: AUTH_A },
  });
  assert(forged.status === 401, 'forged token POST → 401');
}

async function testValidation(s: Sessions): Promise<void> {
  console.log('\nvalidation');
  const t = s.custA.token;

  const cases: Array<[string, unknown]> = [
    ['empty object', {}],
    ['missing endpoint', { p256dh: P256DH_A, auth: AUTH_A }],
    ['missing p256dh', { endpoint: EP_A, auth: AUTH_A }],
    ['missing auth', { endpoint: EP_A, p256dh: P256DH_A }],
    ['empty endpoint', { endpoint: '', p256dh: P256DH_A, auth: AUTH_A }],
    ['whitespace endpoint', { endpoint: '   ', p256dh: P256DH_A, auth: AUTH_A }],
    ['http endpoint', { endpoint: 'http://push.example.com/x', p256dh: P256DH_A, auth: AUTH_A }],
    ['non-URL endpoint', { endpoint: 'not-a-url', p256dh: P256DH_A, auth: AUTH_A }],
    ['ftp endpoint', { endpoint: 'ftp://push.example.com/x', p256dh: P256DH_A, auth: AUTH_A }],
    [
      'oversized endpoint',
      { endpoint: `https://${'e'.repeat(2048)}.example.com`, p256dh: P256DH_A, auth: AUTH_A },
    ],
    ['oversized p256dh', { endpoint: EP_A, p256dh: 'k'.repeat(201), auth: AUTH_A }],
    ['oversized auth', { endpoint: EP_A, p256dh: P256DH_A, auth: 's'.repeat(101) }],
    [
      'oversized userAgent',
      { endpoint: EP_A, p256dh: P256DH_A, auth: AUTH_A, userAgent: 'u'.repeat(501) },
    ],
    ['non-string endpoint', { endpoint: 42, p256dh: P256DH_A, auth: AUTH_A }],
  ];
  for (const [name, body] of cases) {
    const res = await api('POST', '/me/push-subscriptions', { token: t, body });
    assert(res.status === 400, `${name} → 400`);
  }

  // Strict schema: user_id (or anything else unknown) is rejected outright.
  const hijack = await api('POST', '/me/push-subscriptions', {
    token: t,
    body: { endpoint: EP_B, p256dh: P256DH_A, auth: AUTH_A, user_id: s.custB.userId },
  });
  assert(hijack.status === 400, 'user_id in body → 400 (strict schema)');
  const hijackRows = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = $1',
    [s.custB.userId],
  );
  assert(Number(hijackRows[0].n) === 0, 'rejected body created nothing for the other user');
}

async function testPersistence(s: Sessions): Promise<{
  subAId: string;
  createdAt: string;
  updatedAt: string;
  subBId: string;
}> {
  console.log('\npersistence');

  const created = await api('POST', '/me/push-subscriptions', {
    token: s.custA.token,
    body: { endpoint: EP_A, p256dh: P256DH_A, auth: AUTH_A, userAgent: UA_A },
  });
  assert(created.status === 201, 'valid POST → 201');
  const data = created.body?.data as Record<string, unknown>;
  assert(typeof data?.id === 'string' && data.endpoint === EP_A, 'response carries id + endpoint');
  assert(
    !('p256dh' in data) && !('auth' in data) && !('keys' in data) &&
      !('userId' in data) && !('user_id' in data),
    'response leaks no keys, user id, or db internals',
  );

  const rows = await query<{
    user_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    user_agent: string | null;
  }>('SELECT user_id, endpoint, p256dh, auth, user_agent FROM push_subscriptions WHERE id = $1', [
    data.id as string,
  ]);
  assert(rows.length === 1, 'subscription row stored');
  assert(
    rows[0].user_id === s.custA.userId &&
      rows[0].endpoint === EP_A &&
      rows[0].p256dh === P256DH_A &&
      rows[0].auth === AUTH_A &&
      rows[0].user_agent === UA_A,
    'row carries the caller id + exact endpoint/keys/metadata',
  );

  // Duplicate (user_id, endpoint): update, not a second row.
  const dup = await api('POST', '/me/push-subscriptions', {
    token: s.custA.token,
    body: { endpoint: EP_A, p256dh: P256DH_B, auth: AUTH_B, userAgent: UA_A2 },
  });
  assert(dup.status === 200, 'duplicate same-user POST → 200 (idempotent update)');
  assert(dup.body?.data?.id === data.id, 'duplicate returns the same subscription id');
  const after = await query<{ n: string; user_agent: string | null; p256dh: string }>(
    'SELECT COUNT(*) AS n, MAX(user_agent) AS user_agent, MAX(p256dh) AS p256dh FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [s.custA.userId, EP_A],
  );
  assert(Number(after[0].n) === 1, 'no second row for the duplicate');
  assert(
    after[0].user_agent === UA_A2 && after[0].p256dh === P256DH_B,
    'duplicate refreshes keys + metadata',
  );

  // Same endpoint URL under a DIFFERENT user is a separate subscription.
  const other = await api('POST', '/me/push-subscriptions', {
    token: s.custB.token,
    body: { endpoint: EP_A, p256dh: P256DH_A, auth: AUTH_A },
  });
  assert(other.status === 201, 'same endpoint, different user → 201');
  assert(other.body?.data?.id !== data.id, 'different user gets a different subscription id');

  // Any authenticated role may subscribe (technician here).
  const tech = await api('POST', '/me/push-subscriptions', {
    token: s.techC.token,
    body: { endpoint: EP_B, p256dh: P256DH_A, auth: AUTH_A },
  });
  assert(tech.status === 201, 'technician POST → 201 (no role gate on /me/)');

  return {
    subAId: data.id as string,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
    subBId: other.body?.data?.id as string,
  };
}

async function testOwnership(
  s: Sessions,
  ids: { subAId: string; subBId: string },
): Promise<void> {
  console.log('\nownership');

  const cross = await api('DELETE', `/me/push-subscriptions/${ids.subBId}`, {
    token: s.custA.token,
  });
  assert(cross.status === 404, "A cannot delete B's subscription → safe 404");
  const intact = await query<{ n: string }>('SELECT COUNT(*) AS n FROM push_subscriptions WHERE id = $1', [
    ids.subBId,
  ]);
  assert(Number(intact[0].n) === 1, "B's subscription survives the cross-user delete");

  const unknown = await api('DELETE', `/me/push-subscriptions/${crypto.randomUUID()}`, {
    token: s.custA.token,
  });
  assert(unknown.status === 404, 'unknown id → 404');

  const malformed = await api('DELETE', '/me/push-subscriptions/not-a-uuid', {
    token: s.custA.token,
  });
  assert(malformed.status === 400, 'malformed id → 400');

  const own = await api('DELETE', `/me/push-subscriptions/${ids.subAId}`, {
    token: s.custA.token,
  });
  assert(own.status === 200 && own.body?.data?.deleted === true, 'owner DELETE → 200 {deleted:true}');
  const gone = await query<{ n: string }>('SELECT COUNT(*) AS n FROM push_subscriptions WHERE id = $1', [
    ids.subAId,
  ]);
  assert(Number(gone[0].n) === 0, 'owner delete removes the row');

  const again = await api('DELETE', `/me/push-subscriptions/${ids.subAId}`, {
    token: s.custA.token,
  });
  assert(again.status === 404, 're-delete → 404');

  // B cleans up their own subscription through the API too.
  const bOwn = await api('DELETE', `/me/push-subscriptions/${ids.subBId}`, {
    token: s.custB.token,
  });
  assert(bOwn.status === 200, 'B deletes own subscription → 200');
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

async function cleanup(): Promise<void> {
  console.log('\ncleanup — restoring the baseline (seeded admin preserved)');
  await query(
    `DELETE FROM technicians WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test')`,
  );
  await query(`DELETE FROM sessions`);
  await query(
    `DELETE FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL],
  );

  const subs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM push_subscriptions');
  const users = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL],
  );
  const techs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM technicians');
  const sessions = await query<{ n: string }>('SELECT COUNT(*) AS n FROM sessions');
  const admin = await query<{ n: string }>('SELECT COUNT(*) AS n FROM users WHERE lower(email) = lower($1)', [
    ADMIN_EMAIL,
  ]);

  assert(Number(subs[0].n) === 0, 'no push subscriptions remain');
  assert(Number(users[0].n) === 0, 'no fixture accounts remain');
  assert(
    Number(techs[0].n) === baselineTechnicians,
    `technicians back to the baseline count (${baselineTechnicians})`,
  );
  assert(Number(sessions[0].n) === 0, 'no sessions remain');
  assert(Number(admin[0].n) === 1, 'seeded administrator preserved');
  assert(loginCount === 3, `suite issued exactly 3 logins (saw ${loginCount})`);
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const baselineTechs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM technicians');
  baselineTechnicians = Number(baselineTechs[0].n);
  const sessions = await createFixtures();
  await testAuthentication(sessions);
  await testValidation(sessions);
  const ids = await testPersistence(sessions);
  assert(
    typeof ids.createdAt === 'string' && typeof ids.updatedAt === 'string',
    'timestamps present on the created subscription',
  );
  await testOwnership(sessions, ids);
  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch(async (error: unknown) => {
  console.error('Test runner crashed:', error);
  try {
    await cleanup();
  } catch {
    /* best effort */
  }
  process.exitCode = 1;
});
