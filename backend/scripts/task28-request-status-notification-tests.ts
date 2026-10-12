/**
 * Task 28.2D4 tests: request-status notifications (PATCH
 * /api/v1/requests/:id/status → the OTHER participant) against a RUNNING
 * backend (start it first) backed by the LOCAL scratch database — never
 * Supabase.
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *   $env:ADMIN_EMAIL='admin@umodzi.test'
 *   $env:ADMIN_PASSWORD='…'
 *   npx tsx scripts/task28-request-status-notification-tests.ts
 *
 * Covers:
 *   Recipients — customer PATCH → accepted technician; technician PATCH →
 *     customer; admin PATCH → both non-actor participants; the actor is
 *     never notified;
 *   Contract — type request_status_<status>, reference
 *     service_request/request id, exact audience-specific copy; the test
 *     backend runs VAPID-stripped with no subscriptions, so inline D6
 *     delivery honestly resolves rows to failed + recorded reason;
 *   State safety — same-value PATCH still 200s (behavior preserved) with
 *     no notification; failed (404/400) updates create nothing; no
 *     accepted technician / NULL customer skip safely;
 *   Isolation — unrelated technician and unrelated customer get nothing;
 *     authorization (404/403) unchanged.
 *   Cleanup — baseline restored (seeded admin preserved).
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

if (!process.env.DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Missing required environment variables: DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD');
  console.error('Point DATABASE_URL at the LOCAL scratch database — never Supabase.');
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
const PASSWORD = 'Task28StatusD4!42';
const EMAIL_A = `status-a-282d4-${RUN}@umodzi.test`;
const EMAIL_B = `status-b-282d4-${RUN}@umodzi.test`;
const EMAIL_T = `status-t-282d4-${RUN}@umodzi.test`;
const EMAIL_U = `status-u-282d4-${RUN}@umodzi.test`;

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
  techT: Session;
  techU: Session;
  techTProfileId: string;
}

async function createFixtures(): Promise<Sessions> {
  console.log('\nfixtures: 2 customers + 2 technicians + admin session');

  for (const [email, firstName, lastName, role, extra] of [
    [EMAIL_A, 'Naledi', 'Moyo', 'customer', {}],
    [EMAIL_B, 'Tebogo', 'Zulu', 'customer', {}],
    [EMAIL_T, 'Daka', 'Mwila', 'technician', { category: 'Electrical', serviceArea: 'Kitwe' }],
    [EMAIL_U, 'Fumba', 'Chileshe', 'technician', { category: 'Plumbing', serviceArea: 'Ndola' }],
  ] as const) {
    const res = await api('POST', '/auth/register', {
      body: { email, password: PASSWORD, firstName, lastName, role, ...extra },
    });
    assert(res.status === 201, `registration ${email} → 201`);
  }

  const admin = sessionFrom(await login(ADMIN_EMAIL as string, ADMIN_PASSWORD as string));
  const custA = sessionFrom(await login(EMAIL_A, PASSWORD));
  const custB = sessionFrom(await login(EMAIL_B, PASSWORD));
  const techT = sessionFrom(await login(EMAIL_T, PASSWORD));
  const techU = sessionFrom(await login(EMAIL_U, PASSWORD));
  assert(
    Boolean(admin.token && custA.token && custB.token && techT.token && techU.token),
    'all five sessions issued',
  );

  const meT = await api('GET', '/auth/me', { token: techT.token });
  const techTProfileId = meT.body?.data?.user?.technicianId as string;
  assert(typeof techTProfileId === 'string' && techTProfileId.length > 0, 'technician T profile linked');

  await query(
    `UPDATE technicians
        SET verified = true, verification_status = 'verified',
            account_status = 'active', availability_status = 'available',
            updated_at = NOW()
      WHERE id = $1`,
    [techTProfileId],
  );

  return { admin, custA, custB, techT, techU, techTProfileId };
}

async function makeAcceptedRequest(s: Sessions): Promise<{ requestId: string; offerId: string }> {
  const created = await api('POST', '/requests', {
    token: s.custA.token,
    body: {
      description: `TASK282D4-API request ${crypto.randomUUID().slice(0, 8)} with enough detail`,
      category: 'Electrical',
      city: 'Kitwe',
    },
  });
  assert(created.status === 201, 'fixture request → 201');
  const requestId = created.body?.data?.id as string;
  const offer = await api('POST', '/offers', {
    token: s.custA.token,
    body: { requestId, technicianId: s.techTProfileId, candidateIndex: 0, status: 'pending' },
  });
  assert(offer.status === 201, 'fixture offer → 201');
  const accepted = await api('POST', `/offers/${offer.body?.data?.id as string}/accept`, {
    token: s.techT.token,
  });
  assert(accepted.status === 200, 'fixture accept → 200');
  return { requestId, offerId: offer.body?.data?.id as string };
}

async function notificationsForRequest(requestId: string) {
  return query<{
    user_id: string;
    type: string;
    title: string;
    message: string;
    channel: string;
    reference_type: string;
    reference_id: string;
    status: string;
    failure_reason: string | null;
  }>(
    `SELECT user_id, type, title, message, channel, reference_type, reference_id,
            status, failure_reason
     FROM notifications WHERE reference_id = $1 ORDER BY created_at`,
    [requestId],
  );
}

// D6: the test backend runs VAPID-stripped with no subscriptions, so
// inline delivery resolves rows honestly to failed + a recorded reason
// (no network, no fabrication).
function assertResolvedHonestly(row: { status: string; failure_reason: string | null }): void {
  assert(row.status === 'failed', 'delivery resolved honestly (failed, not sent)');
  assert(
    typeof row.failure_reason === 'string' && row.failure_reason.length > 0,
    'failure reason recorded',
  );
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function testCustomerToTechnician(s: Sessions): Promise<string> {
  console.log('\ncustomer PATCH → accepted technician');

  const { requestId } = await makeAcceptedRequest(s);
  const res = await api('PATCH', `/requests/${requestId}/status`, {
    token: s.custA.token,
    body: { status: 'completed' },
  });
  assert(res.status === 200, 'customer PATCH completed → 200 (behavior preserved)');

  const rows = await notificationsForRequest(requestId);
  const statusRows = rows.filter((r) => r.type.startsWith('request_status_'));
  assert(statusRows.length === 1, 'exactly one status notification');
  assert(statusRows[0].user_id === s.techT.userId, 'recipient is the accepted technician');
  assert(
    statusRows[0].type === 'request_status_completed' &&
      statusRows[0].reference_type === 'service_request' &&
      statusRows[0].reference_id === requestId &&
      statusRows[0].channel === 'in_app',
    'type/reference/channel match the D4 contract',
  );
  assertResolvedHonestly(statusRows[0]);
  assert(
    statusRows[0].title === 'Service completed' &&
      statusRows[0].message ===
        'A Electrical service request in Kitwe you accepted is now completed.',
    'technician-audience copy is exact',
  );

  const customerRows = rows.filter((r) => r.user_id === s.custA.userId);
  assert(customerRows.length === 0, 'the acting customer is not notified');

  // Same-value PATCH: still 200, no new row.
  const same = await api('PATCH', `/requests/${requestId}/status`, {
    token: s.custA.token,
    body: { status: 'completed' },
  });
  assert(same.status === 200, 'same-value PATCH → 200 (rewrite preserved)');
  const after = await notificationsForRequest(requestId);
  assert(
    after.filter((r) => r.type.startsWith('request_status_')).length === 1,
    'same-value PATCH creates no notification',
  );

  return requestId;
}

async function testTechnicianToCustomer(s: Sessions): Promise<void> {
  console.log('\ntechnician PATCH → customer');

  const { requestId } = await makeAcceptedRequest(s);
  const res = await api('PATCH', `/requests/${requestId}/status`, {
    token: s.techT.token,
    body: { status: 'matched' },
  });
  assert(res.status === 200, 'technician PATCH matched → 200');

  const rows = await notificationsForRequest(requestId);
  const statusRows = rows.filter((r) => r.type.startsWith('request_status_'));
  assert(statusRows.length === 1, 'exactly one status notification');
  assert(statusRows[0].user_id === s.custA.userId, 'recipient is the owning customer');
  assert(
    statusRows[0].type === 'request_status_matched' &&
      statusRows[0].reference_type === 'service_request' &&
      statusRows[0].reference_id === requestId &&
      statusRows[0].channel === 'in_app',
    'type/reference/channel match the D4 contract',
  );
  assertResolvedHonestly(statusRows[0]);
  assert(
    statusRows[0].title === 'Technician matched' &&
      statusRows[0].message === 'Your Electrical service request in Kitwe is now matched.',
    'customer-audience copy is exact',
  );

  const techRows = rows.filter(
    (r) => r.user_id === s.techT.userId && r.type.startsWith('request_status_'),
  );
  assert(techRows.length === 0, 'the acting technician is not notified');
}

async function testMissingAndUnrelated(s: Sessions): Promise<void> {
  console.log('\nmissing recipients, isolation, authorization');

  // No accepted technician: customer PATCH notifies nobody.
  const solo = await api('POST', '/requests', {
    token: s.custA.token,
    body: {
      description: `TASK282D4-API solo ${crypto.randomUUID().slice(0, 8)} with enough detail`,
      category: 'Electrical',
      city: 'Kitwe',
    },
  });
  const soloId = solo.body?.data?.id as string;
  const soloPatch = await api('PATCH', `/requests/${soloId}/status`, {
    token: s.custA.token,
    body: { status: 'in_progress' },
  });
  assert(soloPatch.status === 200, 'PATCH without accepted tech → 200');
  assert((await notificationsForRequest(soloId)).length === 0, 'no accepted tech → no notification');

  // NULL-customer legacy request, accepted by T, admin drives completion:
  // T (non-actor) is notified, nobody else can be.
  const legacyRequest = crypto.randomUUID();
  await query(
    `INSERT INTO service_requests (id, description, category, city, status, customer_user_id, created_at, updated_at)
     VALUES ($1, 'TASK282D4-API legacy with enough detail here', 'Electrical', 'Kitwe', 'pending', NULL, NOW(), NOW())`,
    [legacyRequest],
  );
  await query(
    `INSERT INTO dispatch_offers (request_id, technician_id, candidate_index, status, created_at, updated_at)
     VALUES ($1, $2, 0, 'accepted', NOW(), NOW())`,
    [legacyRequest, s.techTProfileId],
  );
  const adminPatch = await api('PATCH', `/requests/${legacyRequest}/status`, {
    token: s.admin.token,
    body: { status: 'completed' },
  });
  assert(adminPatch.status === 200, 'admin PATCH legacy request → 200');
  const legacyRows = await notificationsForRequest(legacyRequest);
  assert(
    legacyRows.length === 1 && legacyRows[0].user_id === s.techT.userId &&
      legacyRows[0].type === 'request_status_completed',
    'admin actor → accepted technician notified, NULL customer skipped',
  );

  // Failed update creates nothing.
  const before = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  const unknown = await api('PATCH', `/requests/${crypto.randomUUID()}/status`, {
    token: s.custA.token,
    body: { status: 'completed' },
  });
  assert(unknown.status === 404, 'unknown request PATCH → 404');
  const badStatus = await api('PATCH', `/requests/${soloId}/status`, {
    token: s.custA.token,
    body: { status: 'teleported' },
  });
  assert(badStatus.status === 400, 'invalid status → 400');
  const after = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  assert(Number(after[0].n) === Number(before[0].n), 'failed updates create no notifications');

  // Authorization intact: unrelated technician + unrelated customer stay 404.
  const strangerTech = await api('PATCH', `/requests/${soloId}/status`, {
    token: s.techU.token,
    body: { status: 'matched' },
  });
  assert(strangerTech.status === 404, 'unrelated technician PATCH → 404');
  const strangerCust = await api('PATCH', `/requests/${soloId}/status`, {
    token: s.custB.token,
    body: { status: 'cancelled' },
  });
  assert(strangerCust.status === 404, 'unrelated customer PATCH → 404');

  // Isolation: U and B hold zero notifications across the whole suite.
  const strangers = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id IN ($1, $2)',
    [s.techU.userId, s.custB.userId],
  );
  assert(Number(strangers[0].n) === 0, 'unrelated users receive nothing');

  // No successful-delivery evidence anywhere: every row honestly failed
  // (VAPID-stripped test backend) with NULL provider and sent_at — no push
  // acceptance and no SMS pass ever ran.
  const delivered = await query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE status NOT IN ('pending', 'failed') OR provider_message_id IS NOT NULL OR sent_at IS NOT NULL",
  );
  assert(Number(delivered[0].n) === 0, 'no success evidence on any row');
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

async function cleanup(): Promise<void> {
  console.log('\ncleanup — restoring the baseline (seeded admin preserved)');
  await query(
    `DELETE FROM dispatch_offers WHERE request_id IN
       (SELECT id FROM service_requests WHERE description LIKE 'TASK282D4-API %')`,
  );
  await query(`DELETE FROM service_requests WHERE description LIKE 'TASK282D4-API %'`);
  await query(
    `DELETE FROM technicians WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test')`,
  );
  await query(`DELETE FROM sessions`);
  await query(
    `DELETE FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );

  const notifs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
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

  assert(Number(notifs[0].n) === 0, 'no notifications remain');
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
  await testCustomerToTechnician(sessions);
  await testTechnicianToCustomer(sessions);
  await testMissingAndUnrelated(sessions);
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
