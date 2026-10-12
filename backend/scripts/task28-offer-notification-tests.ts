/**
 * Task 28.2D2 tests: offer-created notification (POST /api/v1/offers →
 * NotificationService.recordEventNotification) against a RUNNING backend
 * (start it first) backed by the LOCAL scratch database — never Supabase.
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *   $env:ADMIN_EMAIL='admin@umodzi.test'
 *   npx tsx scripts/task28-offer-notification-tests.ts
 *
 * Covers:
 *   Hook — eligible offer creation still 201s AND records exactly one
 *     in_app notification for the target technician's linked user
 *     (type dispatch_offer_created, reference dispatch_offer/offer id);
 *     the test backend runs VAPID-stripped with no subscriptions, so
 *     inline D6 delivery honestly resolves rows to failed + recorded reason;
 *   Silence — nothing for the customer, no success evidence anywhere
 *     (every row failed with NULL provider id), no push subscriptions touched;
 *   NULL recipient — seed technician (user_id NULL) offer still 201s with
 *     no notification row and no failure;
 *   Idempotency — duplicate offer POST stays 409 with still exactly one
 *     notification row;
 *   Eligibility intact — ineligible target stays rejected with no row.
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
const PASSWORD = 'Task28OfferD2!42';
const EMAIL_A = `offer-n282d2-${RUN}@umodzi.test`;
const EMAIL_T = `offer-t282d2-${RUN}@umodzi.test`;

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
  chandaId: string;
  bwalyaId: string;
}

async function createFixtures(): Promise<Sessions> {
  console.log('\nfixtures: 1 customer + 1 linked technician');

  for (const [email, firstName, lastName, role, extra] of [
    [EMAIL_A, 'Namono', 'Phiri', 'customer', {}],
    [EMAIL_T, 'Chanda', 'Mwelwa', 'technician', { category: 'Electrical', serviceArea: 'Kitwe' }],
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

  // Make T a genuinely eligible candidate (verified + active + available).
  await query(
    `UPDATE technicians
        SET verified = true, verification_status = 'verified',
            account_status = 'active', availability_status = 'available',
            updated_at = NOW()
      WHERE id = $1`,
    [techTProfileId],
  );

  // Seed technicians: Chanda M. (user_id NULL by design) and Bwalya K.
  // (wrong category/city — ineligible for Electrical/Kitwe requests).
  const seeds = await query<{ id: string; name: string; user_id: string | null }>(
    `SELECT id, name, user_id FROM technicians WHERE name IN ('Chanda M.', 'Bwalya K.')`,
  );
  const chandaId = seeds.find((r) => r.name === 'Chanda M.')?.id ?? '';
  const bwalyaId = seeds.find((r) => r.name === 'Bwalya K.')?.id ?? '';
  assert(chandaId.length > 0 && bwalyaId.length > 0, 'seed technicians present');
  assert(
    seeds.find((r) => r.name === 'Chanda M.')?.user_id === null,
    'Chanda M. has user_id NULL (NULL-recipient precondition)',
  );

  return { custA, techT, techTProfileId, chandaId, bwalyaId };
}

async function createRequest(token: string): Promise<string> {
  const created = await api('POST', '/requests', {
    token,
    body: {
      description: `TASK282D2-API request ${crypto.randomUUID().slice(0, 8)} with enough detail`,
      category: 'Electrical',
      city: 'Kitwe',
    },
  });
  assert(created.status === 201, 'fixture request → 201');
  return created.body?.data?.id as string;
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function testOfferCreatedNotification(s: Sessions): Promise<string> {
  console.log('\noffer-created notification');

  const requestId = await createRequest(s.custA.token);
  const offer = await api('POST', '/offers', {
    token: s.custA.token,
    body: { requestId, technicianId: s.techTProfileId, candidateIndex: 0, status: 'pending' },
  });
  assert(offer.status === 201, 'eligible offer creation → 201 (hook does not break the route)');
  const offerId = offer.body?.data?.id as string;
  assert(typeof offerId === 'string' && offerId.length > 0, 'created offer id returned');

  const rows = await query<{
    user_id: string;
    type: string;
    title: string;
    message: string;
    channel: string;
    reference_type: string;
    reference_id: string;
    status: string;
    provider_message_id: string | null;
    failure_reason: string | null;
  }>(
    `SELECT user_id, type, title, message, channel, reference_type, reference_id,
            status, provider_message_id, failure_reason
     FROM notifications WHERE reference_id = $1`,
    [offerId],
  );
  assert(rows.length === 1, 'exactly one notification for the created offer');
  assert(rows[0].user_id === s.techT.userId, 'recipient is exactly the target technician');
  assert(
    rows[0].type === 'dispatch_offer_created' &&
      rows[0].reference_type === 'dispatch_offer' &&
      rows[0].reference_id === offerId &&
      rows[0].channel === 'in_app',
    'type/reference/channel match the D2 contract',
  );
  assert(
    rows[0].title === 'New service offer' &&
      rows[0].message === 'You have a new Electrical service offer in Kitwe.',
    'title/message are the technician-facing D2 copy',
  );
  // D6: the test backend runs VAPID-stripped with no subscriptions, so
  // inline delivery honestly resolves to failed + a recorded reason
  // (no network, no fabrication).
  assert(rows[0].status === 'failed', 'delivery resolved honestly (failed, not sent)');
  assert(
    typeof rows[0].failure_reason === 'string' && rows[0].failure_reason.length > 0,
    'failure reason recorded',
  );
  assert(rows[0].provider_message_id === null, 'no delivery evidence (no provider id)');

  const customerRows = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1',
    [s.custA.userId],
  );
  assert(Number(customerRows[0].n) === 0, 'no notification sent to the customer');

  return offerId;
}

async function testSilenceAndGuards(s: Sessions, offerId: string): Promise<void> {
  console.log('\nsilence, duplicates, eligibility');

  // Duplicate offer POST: still 409, still exactly one notification row.
  const requestOfOffer = await query<{ request_id: string }>(
    'SELECT request_id FROM dispatch_offers WHERE id = $1',
    [offerId],
  );
  const dup = await api('POST', '/offers', {
    token: s.custA.token,
    body: {
      requestId: requestOfOffer[0].request_id,
      technicianId: s.techTProfileId,
      candidateIndex: 0,
      status: 'pending',
    },
  });
  assert(dup.status === 409, 'duplicate offer POST → 409 (protection intact)');
  const dupCount = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM notifications WHERE reference_id = $1',
    [offerId],
  );
  assert(Number(dupCount[0].n) === 1, 'rejected duplicate creates no second notification');

  // Ineligible target: rejected, and nothing recorded.
  const before = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  const badRequestId = await createRequest(s.custA.token);
  const ineligible = await api('POST', '/offers', {
    token: s.custA.token,
    body: { requestId: badRequestId, technicianId: s.bwalyaId, candidateIndex: 0, status: 'pending' },
  });
  assert(ineligible.status === 422, 'ineligible target → 422 (eligibility intact)');
  const after = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  assert(Number(after[0].n) === Number(before[0].n), 'rejected offer records no notification');

  // No successful-delivery side effects anywhere: every row honestly
  // failed (VAPID-stripped test backend) with NULL provider ids — no push
  // acceptance and no SMS pass ever ran.
  const delivered = await query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE status NOT IN ('pending', 'failed') OR provider_message_id IS NOT NULL OR sent_at IS NOT NULL",
  );
  assert(Number(delivered[0].n) === 0, 'no success evidence on any row');
}

async function testNullRecipient(s: Sessions): Promise<void> {
  console.log('\nNULL technician.user_id');

  const requestId = await createRequest(s.custA.token);
  const offer = await api('POST', '/offers', {
    token: s.custA.token,
    body: { requestId, technicianId: s.chandaId, candidateIndex: 0, status: 'pending' },
  });
  assert(offer.status === 201, 'offer to NULL-user technician → 201 (offer never fails)');
  const rows = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM notifications WHERE reference_id = $1',
    [offer.body?.data?.id as string],
  );
  assert(Number(rows[0].n) === 0, 'NULL recipient produces no notification row');
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

async function cleanup(): Promise<void> {
  console.log('\ncleanup — restoring the baseline (seeded admin preserved)');
  await query(
    `DELETE FROM dispatch_offers WHERE request_id IN
       (SELECT id FROM service_requests WHERE description LIKE 'TASK282D2-API %')`,
  );
  await query(`DELETE FROM service_requests WHERE description LIKE 'TASK282D2-API %'`);
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
  const offerId = await testOfferCreatedNotification(sessions);
  await testSilenceAndGuards(sessions, offerId);
  await testNullRecipient(sessions);
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
