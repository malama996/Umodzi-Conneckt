/**
 * Task 28.2D3 tests: offer-outcome notifications (accept/reject/timeout →
 * the request customer) against a RUNNING backend (start it first) backed
 * by the LOCAL scratch database — never Supabase.
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *   $env:ADMIN_EMAIL='admin@umodzi.test'
 *   npx tsx scripts/task28-offer-outcome-tests.ts
 *
 * Covers:
 *   Outcome hooks — accept/reject/timeout each 200 AND record exactly one
 *     in_app notification for the owning customer
 *     (dispatch_offer_accepted/rejected/timed_out, reference
 *     dispatch_offer/offer id); the test backend runs VAPID-stripped with
 *     no subscriptions, so inline D6 delivery honestly resolves rows to
 *     failed + recorded reason;
 *   State guard — repeating a terminal transition still 200s (behavior
 *     preserved) but creates no second row;
 *   Recipients — customer only (no outcome rows for the technician),
 *     NULL customer_user_id safely skips with the offer transition intact;
 *   Silence — no success evidence anywhere (every row failed with NULL
 *     provider id; no push acceptance, no SMS pass);
 *   Protection — unknown offer stays 404 with no rows.
 *   Cleanup — baseline restored (seeded admin preserved).
 *
 * Exactly 2 successful logins, zero failed logins (rate-budget discipline).
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
const PASSWORD = 'Task28OutcomeD3!42';
const EMAIL_A = `outcome-a-282d3-${RUN}@umodzi.test`;
const EMAIL_T = `outcome-t-282d3-${RUN}@umodzi.test`;

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
  custA: Session;
  techT: Session;
  techTProfileId: string;
}

async function createFixtures(): Promise<Sessions> {
  console.log('\nfixtures: 1 customer + 1 linked technician');

  for (const [email, firstName, lastName, role, extra] of [
    [EMAIL_A, 'Nchimunya', 'Banda', 'customer', {}],
    [EMAIL_T, 'Chishala', 'Mwanza', 'technician', { category: 'Electrical', serviceArea: 'Kitwe' }],
  ] as const) {
    const res = await api('POST', '/auth/register', {
      body: { email, password: PASSWORD, firstName, lastName, role, ...extra },
    });
    assert(res.status === 201, `registration ${email} → 201`);
  }

  const custA = sessionFrom(await login(EMAIL_A, PASSWORD));
  const techT = sessionFrom(await login(EMAIL_T, PASSWORD));
  assert(Boolean(custA.token && techT.token), 'both sessions issued');

  const meT = await api('GET', '/auth/me', { token: techT.token });
  const techTProfileId = meT.body?.data?.user?.technicianId as string;
  assert(typeof techTProfileId === 'string' && techTProfileId.length > 0, 'technician profile linked');

  await query(
    `UPDATE technicians
        SET verified = true, verification_status = 'verified',
            account_status = 'active', availability_status = 'available',
            updated_at = NOW()
      WHERE id = $1`,
    [techTProfileId],
  );

  return { custA, techT, techTProfileId };
}

async function makeOffer(s: Sessions): Promise<{ requestId: string; offerId: string }> {
  const created = await api('POST', '/requests', {
    token: s.custA.token,
    body: {
      description: `TASK282D3-API request ${crypto.randomUUID().slice(0, 8)} with enough detail`,
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
  return { requestId, offerId: offer.body?.data?.id as string };
}

async function notificationFor(offerId: string) {
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
     FROM notifications WHERE reference_id = $1`,
    [offerId],
  );
}

// D6: the test backend runs VAPID-stripped with no subscriptions, so
// inline delivery resolves rows honestly to failed + a recorded reason
// (no network, no fabrication).
function assertResolvedHonestly(row: {
  status: string;
  failure_reason: string | null;
  provider_message_id?: string | null;
}): void {
  assert(row.status === 'failed', 'delivery resolved honestly (failed, not sent)');
  assert(
    typeof row.failure_reason === 'string' && row.failure_reason.length > 0,
    'failure reason recorded',
  );
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function testAccept(s: Sessions): Promise<void> {
  console.log('\naccept → customer');

  const { offerId } = await makeOffer(s);
  const res = await api('POST', `/offers/${offerId}/accept`, { token: s.techT.token });
  assert(res.status === 200, 'accept → 200 (route behavior preserved)');

  const rows = await notificationFor(offerId);
  const outcome = rows.filter((r) => r.type !== 'dispatch_offer_created');
  assert(outcome.length === 1, 'exactly one accept notification');
  assert(outcome[0].user_id === s.custA.userId, 'recipient is the request customer');
  assert(
    outcome[0].type === 'dispatch_offer_accepted' &&
      outcome[0].reference_type === 'dispatch_offer' &&
      outcome[0].reference_id === offerId &&
      outcome[0].channel === 'in_app',
    'accept type/reference/channel match the D3 contract',
  );
  assertResolvedHonestly(outcome[0]);
  assert(
    outcome[0].title === 'Offer accepted' &&
      outcome[0].message === 'Your Electrical service request in Kitwe was accepted.',
    'accept title/message are the customer-facing D3 copy',
  );

  // Repeat: still 200, still exactly one row.
  const again = await api('POST', `/offers/${offerId}/accept`, { token: s.techT.token });
  assert(again.status === 200, 're-accept → 200 (rewrite preserved, not rejected)');
  const after = await notificationFor(offerId);
  assert(
    after.filter((r) => r.type !== 'dispatch_offer_created').length === 1,
    're-accept creates no second notification',
  );
}

async function testReject(s: Sessions): Promise<void> {
  console.log('\nreject → customer');

  const { offerId } = await makeOffer(s);
  const res = await api('POST', `/offers/${offerId}/reject`, { token: s.custA.token });
  assert(res.status === 200, 'customer-side reject → 200');

  const rows = await notificationFor(offerId);
  const outcome = rows.filter((r) => r.type !== 'dispatch_offer_created');
  assert(outcome.length === 1, 'exactly one reject notification');
  assert(outcome[0].user_id === s.custA.userId, 'recipient is the request customer');
  assert(
    outcome[0].type === 'dispatch_offer_rejected' &&
      outcome[0].reference_type === 'dispatch_offer' &&
      outcome[0].reference_id === offerId &&
      outcome[0].channel === 'in_app',
    'reject type/reference/channel match the D3 contract',
  );
  assertResolvedHonestly(outcome[0]);
  assert(
    outcome[0].title === 'Offer rejected' &&
      outcome[0].message ===
        'An offer for your Electrical service request in Kitwe was rejected.',
    'reject title/message are the customer-facing D3 copy',
  );

  const again = await api('POST', `/offers/${offerId}/reject`, { token: s.custA.token });
  assert(again.status === 200, 're-reject → 200 (rewrite preserved)');
  const after = await notificationFor(offerId);
  assert(
    after.filter((r) => r.type !== 'dispatch_offer_created').length === 1,
    're-reject creates no second notification',
  );
}

async function testTimeout(s: Sessions): Promise<void> {
  console.log('\ntimeout → customer');

  const { offerId } = await makeOffer(s);
  const res = await api('POST', `/offers/${offerId}/timeout`, { token: s.techT.token });
  assert(res.status === 200, 'timeout → 200');

  const rows = await notificationFor(offerId);
  const outcome = rows.filter((r) => r.type !== 'dispatch_offer_created');
  assert(outcome.length === 1, 'exactly one timeout notification');
  assert(outcome[0].user_id === s.custA.userId, 'recipient is the request customer');
  assert(
    outcome[0].type === 'dispatch_offer_timed_out' &&
      outcome[0].reference_type === 'dispatch_offer' &&
      outcome[0].reference_id === offerId &&
      outcome[0].channel === 'in_app',
    'timeout type/reference/channel match the D3 contract',
  );
  assertResolvedHonestly(outcome[0]);
  assert(
    outcome[0].title === 'Offer expired' &&
      outcome[0].message ===
        'An offer for your Electrical service request in Kitwe expired without a response.',
    'timeout title/message are the customer-facing D3 copy',
  );
}

async function testProtectionAndSilence(s: Sessions): Promise<void> {
  console.log('\nprotection, NULL recipient, silence');

  const before = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  const unknown = await api('POST', `/offers/${crypto.randomUUID()}/accept`, {
    token: s.techT.token,
  });
  assert(unknown.status === 404, 'unknown offer accept → 404 (existing behavior)');
  const after = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  assert(Number(after[0].n) === Number(before[0].n), 'failed outcome creates no notification');

  // NULL customer_user_id: transition succeeds, notification safely skipped.
  const legacyRequest = crypto.randomUUID();
  await query(
    `INSERT INTO service_requests (id, description, category, city, status, customer_user_id, created_at, updated_at)
     VALUES ($1, 'TASK282D3-API legacy request with enough detail', 'Electrical', 'Kitwe', 'pending', NULL, NOW(), NOW())`,
    [legacyRequest],
  );
  const legacyOffer = await query<{ id: string }>(
    `INSERT INTO dispatch_offers (request_id, technician_id, candidate_index, status, created_at, updated_at)
     VALUES ($1, $2, 0, 'pending', NOW(), NOW()) RETURNING id`,
    [legacyRequest, s.techTProfileId],
  );
  const legacyId = legacyOffer[0].id;
  const accepted = await api('POST', `/offers/${legacyId}/accept`, { token: s.techT.token });
  assert(accepted.status === 200, 'accept on NULL-customer offer → 200 (transition intact)');
  const legacyRows = await notificationFor(legacyId);
  assert(legacyRows.length === 0, 'NULL recipient produces no notification row');
  // (Legacy fixture rows are removed by the TASK282D3-API cleanup below.)

  // No recipient mix-up: the technician holds only dispatch_offer_created
  // rows (from D2 offer creation), never outcome rows.
  const techOutcome = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM notifications
     WHERE user_id = $1 AND type IN
       ('dispatch_offer_accepted', 'dispatch_offer_rejected', 'dispatch_offer_timed_out')`,
    [s.techT.userId],
  );
  assert(Number(techOutcome[0].n) === 0, 'technician receives no outcome notifications');

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
       (SELECT id FROM service_requests WHERE description LIKE 'TASK282D3-API %')`,
  );
  await query(`DELETE FROM service_requests WHERE description LIKE 'TASK282D3-API %'`);
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
  assert(loginCount === 2, `suite issued exactly 2 logins (saw ${loginCount})`);
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const sessions = await createFixtures();
  await testAccept(sessions);
  await testReject(sessions);
  await testTimeout(sessions);
  await testProtectionAndSilence(sessions);
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
