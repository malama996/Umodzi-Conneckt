/**
 * Task 27 API integration tests: customer ratings & reviews tied to
 * completed services, against a RUNNING backend (start it first).
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi'
 *   $env:ADMIN_EMAIL='…'  $env:ADMIN_PASSWORD='…'
 *   npx tsx scripts/task27-api-tests.ts
 *
 * Covers (§26):
 *   Authentication — anonymous 401, technician 403, admin 403 on create;
 *     unrelated customer 404 on the request review state;
 *   Rating validation — 1 and 5 accepted; 0 / 6 / negative / decimal /
 *     non-integer rejected;
 *   Review validation — valid comment accepted; whitespace-only rejected;
 *     >1000 chars rejected; comment genuinely optional;
 *   Eligibility — pending / matching / matched / in_progress / cancelled
 *     all 409; completed allowed; completed WITHOUT an accepted offer 409;
 *   Ownership — other customer's request 404; technician role cannot
 *     create (incl. the reviewed technician); arbitrary ids in the body
 *     rejected by the strict schema; customer/technician ids are always
 *     derived server-side;
 *   Duplicate protection — second review 409; the unique index rejects a
 *     direct duplicate insert (23505);
 *   Aggregates — average/count/distribution verified against independent
 *     SQL; technicians.rating refreshed to the real average;
 *   Public API — newest-first list, public-safe names, no emails/ids;
 *   Cleanup — baseline restored (0 reviews), seeded admin preserved.
 *
 * Exactly 5 successful logins, zero failed logins (rate-budget discipline).
 */

import crypto from 'node:crypto';
import { query } from '../src/db/client.js';

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

for (const [name, value] of Object.entries({
  DATABASE_URL: process.env.DATABASE_URL,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
})) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
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
const PASSWORD = 'Task27Integration!42';
const EMAIL_A = `customer-a-t27-${RUN}@umodzi.test`;
const EMAIL_B = `customer-b-t27-${RUN}@umodzi.test`;
const EMAIL_TA = `tech-a-t27-${RUN}@umodzi.test`;
const EMAIL_TB = `tech-b-t27-${RUN}@umodzi.test`;
const COMMENT =
  'The technician arrived on time and fixed the electrical fault quickly. Very professional service.';

interface Session {
  userId: string;
  token: string;
}

let loginCount = 0;

async function login(email: string, password: string): Promise<ApiResponse> {
  loginCount += 1;
  return api('POST', '/auth/login', { body: { email, password } });
}

function sessionFrom(response: ApiResponse): Session {
  const user = response.body?.data?.user as { id: string };
  return { userId: user.id, token: response.body?.data?.accessToken as string };
}

interface Sessions {
  admin: Session;
  custA: Session;
  custB: Session;
  techA: Session;
  techB: Session;
}

let techAProfileId = '';
let techBProfileId = '';

/** Create a request as customer A, offer it to a technician, accept it
 *  as that technician, then drive it to a target status as the owner. */
async function requestAt(
  sessions: Sessions,
  technicianProfileId: string,
  technicianSession: Session | null,
  status: string,
): Promise<string> {
  const created = await api('POST', '/requests', {
    token: sessions.custA.token,
    body: {
      description: `TASK27-API ${status} request ${crypto.randomUUID().slice(0, 8)}`,
      category: 'Electrical',
      city: 'Kitwe',
    },
  });
  const requestId = created.body?.data?.id as string;
  if (technicianSession) {
    const offer = await api('POST', '/offers', {
      token: sessions.custA.token,
      body: { requestId, technicianId: technicianProfileId, candidateIndex: 0, status: 'pending' },
    });
    const offerId = offer.body?.data?.id as string;
    await api('POST', `/offers/${offerId}/accept`, { token: technicianSession.token });
  }
  if (status !== 'pending') {
    await api('PATCH', `/requests/${requestId}/status`, {
      token: sessions.custA.token,
      body: { status },
    });
  }
  return requestId;
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function createFixtures(): Promise<Sessions> {
  console.log('\nfixtures: 2 customers + 2 technicians');

  for (const [email, firstName, lastName, role, extra] of [
    [EMAIL_A, 'Chipo', 'Tembo', 'customer', {}],
    [EMAIL_B, 'Mwansa', 'Kasonde', 'customer', {}],
    [EMAIL_TA, 'Aaron', 'Sakala', 'technician', { category: 'Electrical', serviceArea: 'Kitwe' }],
    [EMAIL_TB, 'Beatrice', 'Ndlovu', 'technician', { category: 'Plumbing', serviceArea: 'Ndola' }],
  ] as const) {
    const res = await api('POST', '/auth/register', {
      body: { email, password: PASSWORD, firstName, lastName, role, ...extra },
    });
    assert(res.status === 201, `registration ${email} → 201`);
  }

  const admin = sessionFrom(await login(ADMIN_EMAIL as string, ADMIN_PASSWORD as string));
  const custA = sessionFrom(await login(EMAIL_A, PASSWORD));
  const custB = sessionFrom(await login(EMAIL_B, PASSWORD));
  const techA = sessionFrom(await login(EMAIL_TA, PASSWORD));
  const techB = sessionFrom(await login(EMAIL_TB, PASSWORD));
  assert(
    admin.token && custA.token && custB.token && techA.token && techB.token,
    'all five sessions issued',
  );

  const meA = await api('GET', '/auth/me', { token: techA.token });
  techAProfileId = meA.body?.data?.user?.technicianId as string;
  const meB = await api('GET', '/auth/me', { token: techB.token });
  techBProfileId = meB.body?.data?.user?.technicianId as string;
  assert(techAProfileId.length > 0 && techBProfileId.length > 0, 'technician profiles linked');

  // Task 28: POST /offers enforces server-side eligibility. techA is the
  // offer target for the Electrical/Kitwe review fixtures below, so mark it a
  // genuinely eligible candidate (verified + active + available; its
  // registered category/service area already match those requests).
  await query(
    `UPDATE technicians
        SET verified = true, verification_status = 'verified',
            account_status = 'active', availability_status = 'available',
            updated_at = NOW()
      WHERE id = $1`,
    [techAProfileId],
  );

  return { admin, custA, custB, techA, techB };
}

async function testAuthenticationMatrix(sessions: Sessions): Promise<string> {
  console.log('\nauthentication + authorization matrix');

  const completed = await requestAt(sessions, techAProfileId, sessions.techA, 'completed');

  assert(
    (await api('POST', `/requests/${completed}/review`, { body: { rating: 5 } })).status === 401,
    'anonymous review submission → 401',
  );
  assert(
    (
      await api('POST', `/requests/${completed}/review`, {
        token: sessions.techA.token,
        body: { rating: 5 },
      })
    ).status === 403,
    'technician role cannot create a review (incl. the reviewed technician) → 403',
  );
  assert(
    (
      await api('POST', `/requests/${completed}/review`, {
        token: sessions.techB.token,
        body: { rating: 5 },
      })
    ).status === 403,
    'any other technician role → 403',
  );
  assert(
    (
      await api('POST', `/requests/${completed}/review`, {
        token: sessions.admin.token,
        body: { rating: 5 },
      })
    ).status === 403,
    'administrator cannot create reviews → 403 (no impersonation)',
  );
  assert(
    (
      await api('POST', `/requests/${completed}/review`, {
        token: sessions.custB.token,
        body: { rating: 5 },
      })
    ).status === 404,
    "unrelated customer reviews someone else's request → 404 (existence hidden)",
  );
  assert(
    (await api('GET', `/requests/${completed}/review`, { token: sessions.custB.token })).status === 404,
    "unrelated customer reads the review state → 404",
  );
  assert(
    (await api('GET', `/requests/${completed}/review`, { token: sessions.admin.token })).status === 200,
    'administrator may read the review state → 200',
  );
  assert(
    (await api('GET', `/requests/${completed}/review`, { token: sessions.techA.token })).status === 200,
    'participating technician may read the review state → 200',
  );

  const arbitrary = await api('POST', `/requests/${completed}/review`, {
    token: sessions.custA.token,
    body: { rating: 5, customerId: sessions.custB.userId, technicianId: techBProfileId },
  });
  assert(
    arbitrary.status === 400,
    'client-supplied customer/technician ids rejected (strict schema) → 400',
  );

  return completed;
}

async function testEligibility(sessions: Sessions): Promise<void> {
  console.log('\nreview eligibility by request status');

  const cases: [string, number][] = [
    ['pending', 409],
    ['matching', 409],
    ['matched', 409],
    ['in_progress', 409],
    ['cancelled', 409],
  ];
  for (const [status, expected] of cases) {
    const needsOffer = status === 'matched' || status === 'in_progress';
    const requestId = await requestAt(
      sessions,
      techAProfileId,
      needsOffer ? sessions.techA : null,
      status,
    );
    const res = await api('POST', `/requests/${requestId}/review`, {
      token: sessions.custA.token,
      body: { rating: 4 },
    });
    assert(res.status === expected, `${status} request cannot be reviewed → ${expected}`);
  }

  const noOffer = await requestAt(sessions, techAProfileId, null, 'completed');
  const noTech = await api('POST', `/requests/${noOffer}/review`, {
    token: sessions.custA.token,
    body: { rating: 4 },
  });
  assert(noTech.status === 409, 'completed WITHOUT an accepted offer cannot be reviewed → 409');

  const state = await api('GET', `/requests/${noOffer}/review`, { token: sessions.custA.token });
  assert(
    state.body?.data?.eligible === false && state.body?.data?.technicianName === null,
    'eligibility endpoint reports the missing technician relationship',
  );
}

async function testValidation(sessions: Sessions): Promise<string> {
  console.log('\nrating + comment validation');

  const requestId = await requestAt(sessions, techAProfileId, sessions.techA, 'completed');

  for (const rating of [0, 6, -2, 4.5, 'five']) {
    const res = await api('POST', `/requests/${requestId}/review`, {
      token: sessions.custA.token,
      body: { rating },
    });
    assert(res.status === 400, `rating ${JSON.stringify(rating)} → 400`);
  }

  const whitespace = await api('POST', `/requests/${requestId}/review`, {
    token: sessions.custA.token,
    body: { rating: 5, comment: '        ' },
  });
  assert(whitespace.status === 400, 'whitespace-only comment → 400');

  const tooLong = await api('POST', `/requests/${requestId}/review`, {
    token: sessions.custA.token,
    body: { rating: 5, comment: 'x'.repeat(1001) },
  });
  assert(tooLong.status === 400, 'comment over 1000 chars → 400');

  const ratingOnly = await api('POST', `/requests/${requestId}/review`, {
    token: sessions.custA.token,
    body: { rating: 1 },
  });
  assert(ratingOnly.status === 201, 'rating-only review (comment optional) → 201');
  assert(
    ratingOnly.body?.data?.rating === 1 && ratingOnly.body?.data?.comment === null,
    'boundary rating 1 persisted with null comment',
  );

  return requestId;
}

async function testMainFlow(sessions: Sessions): Promise<void> {
  console.log('\nmain flow: completed → review → duplicate protection');

  const r2 = await requestAt(sessions, techAProfileId, sessions.techA, 'completed');
  const r3 = await requestAt(sessions, techAProfileId, sessions.techA, 'completed');

  const pre = await api('GET', `/requests/${r2}/review`, { token: sessions.custA.token });
  assert(
    pre.body?.data?.eligible === true && pre.body?.data?.review === null &&
      pre.body?.data?.technicianName === 'Aaron Sakala',
    'pre-submit: eligible with the matched technician named',
  );

  const first = await api('POST', `/requests/${r2}/review`, {
    token: sessions.custA.token,
    body: { rating: 5, comment: COMMENT },
  });
  assert(first.status === 201, 'first review on a completed service → 201');
  assert(
    first.body?.data?.rating === 5 &&
      first.body?.data?.comment === COMMENT &&
      first.body?.data?.customerName === 'Chipo T.',
    'review persisted with public-safe customer name',
  );

  const db = await query<{ customer_id: string; technician_id: string }>(
    'SELECT customer_id, technician_id FROM reviews WHERE service_request_id = $1',
    [r2],
  );
  assert(
    db[0].customer_id === sessions.custA.userId && db[0].technician_id === techAProfileId,
    'customer/technician ids derived server-side, never from the client',
  );

  const post = await api('GET', `/requests/${r2}/review`, { token: sessions.custA.token });
  assert(
    post.body?.data?.eligible === false && post.body?.data?.review?.rating === 5,
    'post-submit: no longer eligible, review returned',
  );

  const duplicate = await api('POST', `/requests/${r2}/review`, {
    token: sessions.custA.token,
    body: { rating: 4 },
  });
  assert(duplicate.status === 409, 'second review on the same service → 409');

  let constraintFired = false;
  try {
    await query(
      `INSERT INTO reviews (id, service_request_id, customer_id, technician_id, rating, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 4, NOW(), NOW())`,
      [crypto.randomUUID(), r2, sessions.custA.userId, techAProfileId],
    );
  } catch (error) {
    constraintFired =
      typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }
  assert(constraintFired, 'database unique index rejects a duplicate review (23505)');

  const third = await api('POST', `/requests/${r3}/review`, {
    token: sessions.custA.token,
    body: { rating: 3, comment: 'Work was fine, arrived a bit late though.' },
  });
  assert(third.status === 201 && third.body?.data?.rating === 3, 'second completed service → 201');
}

async function testAggregates(sessions: Sessions): Promise<void> {
  console.log('\naggregates + public reputation');

  void sessions;
  const res = await api('GET', `/technicians/${techAProfileId}/reviews`);
  assert(res.status === 200, 'public reviews endpoint → 200');
  const summary = res.body?.data?.summary;
  const reviews = res.body?.data?.reviews;

  const expected = await query<{ average: string; count: string }>(
    'SELECT ROUND(AVG(rating)::numeric, 1) AS average, COUNT(*) AS count FROM reviews WHERE technician_id = $1',
    [techAProfileId],
  );
  assert(
    summary?.average === Number(expected[0].average) && summary?.count === Number(expected[0].count),
    'average + count match independently computed SQL',
  );
  const expectedDist = await query<{ rating: number; count: string }>(
    'SELECT rating, COUNT(*) AS count FROM reviews WHERE technician_id = $1 GROUP BY rating',
    [techAProfileId],
  );
  const distOk = expectedDist.every(
    (row) => summary?.distribution?.[String(row.rating)] === Number(row.count),
  );
  assert(
    distOk && summary?.distribution?.['2'] === 0 && summary?.distribution?.['4'] === 0,
    'distribution matches SQL with zero-filled missing stars',
  );

  assert(Array.isArray(reviews) && reviews.length === Number(expected[0].count), 'review list complete');
  const ordered = reviews.every(
    (row: { createdAt: string }, index: number) =>
      index === 0 || new Date(reviews[index - 1].createdAt) >= new Date(row.createdAt),
  );
  assert(ordered, 'reviews are newest-first');
  assert(
    !res.text.includes('@') && !res.text.includes('customer_id') && !res.text.includes('user_id'),
    'public payload carries no emails or account ids',
  );

  const rating = await query<{ rating: number }>(
    'SELECT rating FROM technicians WHERE id = $1',
    [techAProfileId],
  );
  assert(
    Math.abs(rating[0].rating - Number(expected[0].average)) < 0.0001,
    'technicians.rating refreshed to the real review average (trust-score input)',
  );

  const ghost = await api('GET', `/technicians/${crypto.randomUUID()}/reviews`);
  assert(ghost.status === 404, 'unknown technician reviews → 404');

  const noReviews = await api('GET', `/technicians/${techBProfileId}/reviews`);
  assert(
    noReviews.status === 200 &&
      noReviews.body?.data?.summary?.average === null &&
      noReviews.body?.data?.summary?.count === 0 &&
      noReviews.body?.data?.reviews?.length === 0,
    'technician with zero reviews: average null, count 0, empty list (never fabricated)',
  );
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

async function cleanup(): Promise<void> {
  console.log('\ncleanup — restoring the baseline (seeded admin preserved)');
  // Task 28.2D: offer/status hooks record in_app notifications for fixture
  // flows — remove them alongside the fixture rows they reference.
  await query(`DELETE FROM notifications`);
  await query(
    `DELETE FROM reviews WHERE customer_id IN (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test')`,
  );
  await query(
    `DELETE FROM dispatch_offers WHERE request_id IN
       (SELECT id FROM service_requests WHERE description LIKE 'TASK27-API %')`,
  );
  await query(`DELETE FROM service_requests WHERE description LIKE 'TASK27-API %'`);
  await query(
    `DELETE FROM technicians WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test')`,
  );
  await query(`DELETE FROM sessions`);
  await query(
    `DELETE FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );

  const reviews = await query<{ n: string }>('SELECT COUNT(*) AS n FROM reviews');
  const requests = await query<{ n: string }>('SELECT COUNT(*) AS n FROM service_requests');
  const offers = await query<{ n: string }>('SELECT COUNT(*) AS n FROM dispatch_offers');
  const users = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );
  const techs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM technicians');
  const sessions = await query<{ n: string }>('SELECT COUNT(*) AS n FROM sessions');
  const admin = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM users WHERE lower(email) = lower($1)',
    [ADMIN_EMAIL as string],
  );

  assert(Number(reviews[0].n) === 0, 'no reviews remain (0 production/test reviews)');
  assert(Number(requests[0].n) === 0 && Number(offers[0].n) === 0, 'no requests/offers remain');
  assert(Number(users[0].n) === 0, 'no fixture accounts remain');
  assert(Number(techs[0].n) === 9, 'technicians back to the 9 seed prototypes');
  assert(Number(sessions[0].n) === 0, 'no sessions remain');
  assert(Number(admin[0].n) === 1, 'seeded administrator preserved');
  assert(loginCount === 5, `suite issued exactly 5 logins (saw ${loginCount})`);
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const sessions = await createFixtures();
  await testAuthenticationMatrix(sessions);
  await testEligibility(sessions);
  await testValidation(sessions);
  await testMainFlow(sessions);
  await testAggregates(sessions);
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
