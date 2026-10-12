/**
 * Task 25 API integration tests: the administrator / platform-management
 * contract against a RUNNING backend (start it first, see STATE.md).
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi'
 *   $env:ADMIN_EMAIL='…'  $env:ADMIN_PASSWORD='…'   # the server's seed values
 *   npx tsx scripts/task25-api-tests.ts
 *
 * Covers (Task 25 A–F):
 *   A. authorization matrix — every admin endpoint rejects anonymous (401)
 *      and non-administrator roles (403): customer, technician;
 *   B. non-admin denial holds for reads AND the status mutation;
 *   C. user management data — real rows, exact safe field set, no
 *      password/session/token material anywhere in the payload;
 *   D. technician management data — linked accounts vs seed prototype
 *      profiles (LEFT JOIN nulls), Task 11 fields intact;
 *   E. request monitoring + no-match — statuses, customer identity,
 *      grouped dispatch offers with technician names, legacy NULL-owner
 *      row, newest-first ordering, and the no_match status exposed as-is
 *      (there is no separate no-match log to invent);
 *   F. server-authorized status changes — self-change 403, unknown 404,
 *      invalid uuid/body 400, technician profile sync (disabled →
 *      inactive), DB-authoritative rejection of a suspended account;
 *   G. overview aggregates verified against independently-computed SQL
 *      counts, merged recent activity newest-first;
 *   H. light Task 20–24 regression from the admin session.
 *
 * Only 3 successful logins are issued (admin/customer/technician) and no
 * failed login is ever attempted, so the shared auth rate budget is never
 * consumed — keep it that way.
 *
 * FIXTURES: rows created here carry 'TASK25-API ' descriptions or
 * @umodzi.test emails. The cleanup phase restores the baseline and —
 * unlike task23-api-tests.ts — explicitly EXCLUDES the seeded admin
 * (ADMIN_EMAIL) when deleting @umodzi.test users, then asserts the admin
 * still exists (known issue 15 improvement).
 */

import crypto from 'node:crypto';
import { query } from '../src/db/client.js';

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001/api/v1';
const API_ORIGIN = new URL(API_BASE).origin;
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
    /* non-JSON body */
  }
  return { status: res.status, text, body };
}

/** GET on the root-mounted /health endpoint (not under /api/v1). */
async function health(): Promise<ApiResponse> {
  const res = await fetch(`${API_ORIGIN}/health`);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, text, body };
}

/** Key set of a wire object — the "safe fields only" claim, made exact. */
function keysOf(row: object): string {
  return Object.keys(row)
    .sort()
    .join(',');
}

const USER_KEYS = ['id', 'email', 'role', 'firstName', 'lastName', 'accountStatus', 'createdAt']
  .sort()
  .join(',');
const TECHNICIAN_KEYS = [
  'id',
  'name',
  'category',
  'skills',
  'serviceArea',
  'rating',
  'jobs',
  'verified',
  'availability',
  'availabilityStatus',
  'accountStatus',
  'userId',
  'userEmail',
  'createdAt',
  'updatedAt',
]
  .sort()
  .join(',');
const REQUEST_KEYS = [
  'id',
  'description',
  'category',
  'city',
  'status',
  'createdAt',
  'updatedAt',
  'customerUserId',
  'customerEmail',
  'customerName',
  'offers',
]
  .sort()
  .join(',');

/** No secret material may appear in an admin payload (any casing). */
function hasNoSecrets(res: ApiResponse): boolean {
  const haystack = res.text.toLowerCase();
  return (
    !haystack.includes('password') &&
    !haystack.includes('password_hash') &&
    !haystack.includes('token_hash') &&
    !res.text.includes(ADMIN_PASSWORD as string)
  );
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
const PASSWORD = 'Task25Integration!42';
const EMAIL_C = `customer-t25-${RUN}@umodzi.test`;
const EMAIL_T = `technician-t25-${RUN}@umodzi.test`;
const CUSTOMER_FIRST = 'Tessa';
const CUSTOMER_LAST = 'Mwale';
const REQUEST_DESC = `TASK25-API burst kitchen tap for monitoring ${RUN}`;
const LEGACY_DESC = 'TASK25-API legacy pre-auth request row';

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

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

let customerId = '';
let technicianUserId = '';
let requestId = '';
let offerId = '';
let seededTechnicianId = '';

async function createFixtures(): Promise<{
  admin: Session;
  customer: Session;
  technician: Session;
}> {
  console.log('\nfixtures: two accounts, one request, one offer, one legacy row');

  const registerCustomer = await api('POST', '/auth/register', {
    body: {
      email: EMAIL_C,
      password: PASSWORD,
      firstName: CUSTOMER_FIRST,
      lastName: CUSTOMER_LAST,
      role: 'customer',
    },
  });
  assert(registerCustomer.status === 201, 'fixture customer registration → 201');

  const registerTechnician = await api('POST', '/auth/register', {
    body: {
      email: EMAIL_T,
      password: PASSWORD,
      firstName: 'Theo',
      lastName: 'Tembo',
      role: 'technician',
      category: 'Plumbing',
      serviceArea: 'Kitwe',
    },
  });
  assert(registerTechnician.status === 201, 'fixture technician registration → 201');

  const adminSession = sessionFrom(await login(ADMIN_EMAIL as string, ADMIN_PASSWORD as string));
  const customerSession = sessionFrom(await login(EMAIL_C, PASSWORD));
  const technicianSession = sessionFrom(await login(EMAIL_T, PASSWORD));
  assert(adminSession.token.length > 0, 'administrator login → access token');
  assert(customerSession.token.length > 0, 'customer login → access token');
  assert(technicianSession.token.length > 0, 'technician login → access token');
  customerId = customerSession.userId;
  technicianUserId = technicianSession.userId;

  // The customer's own request, an offer against it, then no_match.
  const created = await api('POST', '/requests', {
    token: customerSession.token,
    body: { description: REQUEST_DESC, category: 'Electrical', city: 'Kitwe' },
  });
  assert(created.status === 201, 'customer creates the monitored request → 201');
  requestId = created.body?.data?.id as string;

  // Task 28: POST /offers enforces server-side eligibility, so target a
  // SEEDED technician that is genuinely eligible for this Electrical/Kitwe
  // request (verified + active + available + matching category/area).
  const seeded = await query<{ id: string }>(
    `SELECT id FROM technicians
      WHERE user_id IS NULL AND category = 'Electrical' AND service_area = 'Kitwe'
        AND verification_status = 'verified' AND account_status = 'active'
        AND availability_status = 'available'
      ORDER BY name LIMIT 1`,
  );
  seededTechnicianId = seeded[0].id;
  const offer = await api('POST', '/offers', {
    token: customerSession.token,
    body: { requestId, technicianId: seededTechnicianId, candidateIndex: 0, status: 'pending' },
  });
  assert(offer.status === 201, 'dispatch offer created on the request → 201');
  offerId = offer.body?.data?.id as string;

  const noMatch = await api('PATCH', `/requests/${requestId}/status`, {
    token: customerSession.token,
    body: { status: 'no_match' },
  });
  assert(noMatch.status === 200 && noMatch.body?.data?.status === 'no_match', 'owner records no_match → 200');

  await query(
    `INSERT INTO service_requests (id, description, category, city, status, customer_user_id, created_at, updated_at)
     VALUES ($1, $2, 'Electrical', 'Ndola', 'pending', NULL, NOW(), NOW())`,
    [crypto.randomUUID(), LEGACY_DESC],
  );
  const legacy = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM service_requests WHERE description = $1',
    [LEGACY_DESC],
  );
  assert(Number(legacy[0].n) === 1, 'legacy NULL-owner fixture row exists');

  return { admin: adminSession, customer: customerSession, technician: technicianSession };
}

async function testAuthorizationMatrix(
  sessions: { admin: Session; customer: Session; technician: Session },
): Promise<void> {
  console.log('\nauthorization matrix — every admin endpoint, every role');

  const { admin, customer, technician } = sessions;
  const reads = ['/admin/users', '/admin/overview', '/admin/technicians', '/admin/requests'];
  const patchBody = { accountStatus: 'active' };

  for (const path of reads) {
    assert((await api('GET', path)).status === 401, `anonymous GET ${path} → 401`);
    assert(
      (await api('GET', path, { token: customer.token })).status === 403,
      `customer GET ${path} → 403`,
    );
    assert(
      (await api('GET', path, { token: technician.token })).status === 403,
      `technician GET ${path} → 403`,
    );
  }

  const patchPath = `/admin/users/${customerId}/status`;
  const anonymousPatch = await api('PATCH', patchPath, { body: patchBody });
  assert(anonymousPatch.status === 401, 'anonymous PATCH admin status → 401');
  assert(
    (await api('PATCH', patchPath, { token: customer.token, body: patchBody })).status === 403,
    'customer PATCH admin status → 403',
  );
  assert(
    (await api('PATCH', patchPath, { token: technician.token, body: patchBody })).status === 403,
    'technician PATCH admin status → 403',
  );

  // The denials are auth denials, not validation accidents.
  const denial = await api('GET', '/admin/overview', { token: customer.token });
  assert(
    typeof denial.body?.error === 'string' && denial.body.error.length > 0,
    '403 carries a safe error message (no stack, no internals)',
  );

  // Positive control: the administrator passes every gate.
  let adminOk = 0;
  for (const path of reads) {
    if ((await api('GET', path, { token: admin.token })).status === 200) adminOk += 1;
  }
  assert(adminOk === reads.length, 'administrator can GET all four admin endpoints → 200');
}

async function testUserManagement(admin: Session): Promise<void> {
  console.log('\nuser management data (GET /admin/users)');

  const res = await api('GET', '/admin/users', { token: admin.token });
  assert(res.status === 200, 'admin user list → 200');
  const rows = res.body?.data as any[];
  assert(Array.isArray(rows), 'payload is an array');

  const dbCount = await query<{ n: string }>('SELECT COUNT(*) AS n FROM users');
  assert(rows.length === Number(dbCount[0].n), 'row count equals the real users table count');
  assert(
    rows.every((row) => keysOf(row) === USER_KEYS),
    'every row carries exactly the documented safe field set',
  );
  assert(hasNoSecrets(res), 'no password/token/session material anywhere in the payload');

  const fixture = rows.find((row) => row.email === EMAIL_C);
  assert(
    fixture !== undefined &&
      fixture.role === 'customer' &&
      fixture.firstName === CUSTOMER_FIRST &&
      fixture.lastName === CUSTOMER_LAST &&
      fixture.accountStatus === 'active',
    'fixture customer appears with real identity, role, and active status',
  );
  const adminRow = rows.find((row) => row.email === ADMIN_EMAIL);
  assert(
    adminRow !== undefined && adminRow.role === 'administrator' && adminRow.accountStatus === 'active',
    'seeded administrator appears as an active administrator',
  );
}

async function testTechnicianManagement(admin: Session): Promise<void> {
  console.log('\ntechnician management data (GET /admin/technicians)');

  const res = await api('GET', '/admin/technicians', { token: admin.token });
  assert(res.status === 200, 'admin technician list → 200');
  const rows = res.body?.data as any[];
  assert(Array.isArray(rows), 'payload is an array');

  const dbCount = await query<{ n: string }>('SELECT COUNT(*) AS n FROM technicians');
  assert(rows.length === Number(dbCount[0].n), 'row count equals the real technicians table count');
  assert(
    rows.every((row) => keysOf(row) === TECHNICIAN_KEYS),
    'every row carries the documented Task 11 + Task 25 field set',
  );
  assert(hasNoSecrets(res), 'no secret material in the technician payload');

  const linked = rows.find((row) => row.userEmail === EMAIL_T);
  assert(
    linked !== undefined &&
      typeof linked.userId === 'string' &&
      linked.category === 'Plumbing' &&
      linked.serviceArea === 'Kitwe' &&
      linked.accountStatus === 'active',
    'registered technician shows linked account + Task 11 profile fields',
  );
  assert(
    linked !== undefined &&
      Array.isArray(linked.skills) &&
      typeof linked.verified === 'boolean' &&
      typeof linked.availabilityStatus === 'string',
    'skills, verification flag, and availability status are present',
  );

  const seedProfile = rows.find((row) => row.userId === null && row.userEmail === null);
  assert(
    rows.some((row) => row.userId === null),
    'seed prototype profiles surface with null userId/userEmail (LEFT JOIN, no fabrication)',
  );
  assert(seedProfile !== undefined && typeof seedProfile.name === 'string', 'seed profile keeps its name');
}

async function testRequestMonitoring(admin: Session, customer: Session): Promise<void> {
  console.log('\nrequest monitoring + no-match exposure (GET /admin/requests)');

  const res = await api('GET', '/admin/requests', { token: admin.token });
  assert(res.status === 200, 'admin request list → 200');
  const rows = res.body?.data as any[];
  assert(Array.isArray(rows), 'payload is an array');

  const dbCount = await query<{ n: string }>('SELECT COUNT(*) AS n FROM service_requests');
  assert(rows.length === Number(dbCount[0].n), 'row count equals the real service_requests count');
  assert(
    rows.every((row) => keysOf(row) === REQUEST_KEYS),
    'every row carries exactly the documented safe field set',
  );
  assert(hasNoSecrets(res), 'no secret material in the request payload');

  const fixture = rows.find((row) => row.id === requestId);
  assert(
    fixture !== undefined && fixture.status === 'no_match',
    'no-match state is exposed through the existing request status (no separate log)',
  );
  assert(
    fixture !== undefined &&
      fixture.customerEmail === EMAIL_C &&
      fixture.customerName === `${CUSTOMER_FIRST} ${CUSTOMER_LAST}` &&
      fixture.customerUserId === customerId,
    'customer identity is joined and correct',
  );
  assert(
    fixture !== undefined &&
      Array.isArray(fixture.offers) &&
      fixture.offers.length === 1 &&
      fixture.offers[0].id === offerId,
    'dispatch offers are grouped under their request',
  );
  assert(
    fixture !== undefined &&
      typeof fixture.offers[0].technicianName === 'string' &&
      fixture.offers[0].technicianName.length > 0 &&
      fixture.offers[0].status === 'pending' &&
      typeof fixture.offers[0].createdAt === 'string',
    'offer carries technician name, status, and timestamp',
  );

  const legacy = rows.find((row) => row.description === LEGACY_DESC);
  assert(
    legacy !== undefined && legacy.customerUserId === null && legacy.customerEmail === null,
    'legacy NULL-owner row is reported with null customer (never invented)',
  );

  const timestamps = rows.map((row) => new Date(row.createdAt).getTime());
  const desc = timestamps.every((value, index) => index === 0 || timestamps[index - 1] >= value);
  assert(desc, 'requests are ordered newest-first');
}

async function testOverview(admin: Session): Promise<void> {
  console.log('\nplatform overview aggregates (GET /admin/overview)');

  const res = await api('GET', '/admin/overview', { token: admin.token });
  assert(res.status === 200, 'overview → 200');
  assert(hasNoSecrets(res), 'no secret material in the overview payload');
  const ov = res.body?.data;

  const [users, byRole, techs, requests, offers] = await Promise.all([
    query<{ n: string }>('SELECT COUNT(*) AS n FROM users'),
    query<{ role: string; n: string }>('SELECT role, COUNT(*) AS n FROM users GROUP BY role'),
    query<{ total: string; available: string; verified: string }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE availability_status = 'available')::int AS available,
              COUNT(*) FILTER (WHERE verified)::int AS verified
       FROM technicians`,
    ),
    query<{ status: string; n: string }>(
      'SELECT status, COUNT(*) AS n FROM service_requests GROUP BY status',
    ),
    query<{ status: string; n: string }>(
      'SELECT status, COUNT(*) AS n FROM dispatch_offers GROUP BY status',
    ),
  ]);

  assert(ov.users.total === Number(users[0].n), 'users.total equals the real row count');
  const roleSum = Object.values(ov.users.byRole as Record<string, number>).reduce(
    (sum: number, n: number) => sum + n,
    0,
  );
  assert(roleSum === ov.users.total, 'byRole parts sum to users.total');
  const dbTechnicianRoles = Number(byRole.find((r) => r.role === 'technician')?.n ?? 0);
  assert(
    ov.users.byRole.technician === dbTechnicianRoles && dbTechnicianRoles >= 1,
    'byRole.technician matches GROUP BY reality',
  );

  assert(ov.technicians.total === Number(techs[0].total), 'technicians.total equals reality');
  assert(ov.technicians.available === Number(techs[0].available), 'available technicians counted exactly');
  assert(ov.technicians.verified === Number(techs[0].verified), 'verified technicians counted exactly');
  assert(
    ov.technicians.unverified === ov.technicians.total - ov.technicians.verified,
    'unverified = total − verified',
  );

  const statusMap = new Map(requests.map((row) => [row.status, Number(row.n)]));
  const dbRequestTotal = requests.reduce((sum, row) => sum + Number(row.n), 0);
  assert(ov.requests.total === dbRequestTotal, 'requests.total equals reality');
  assert(
    ov.requests.byStatus.no_match === (statusMap.get('no_match') ?? 0) &&
      ov.requests.noMatch === ov.requests.byStatus.no_match,
    'no-match count exposed and consistent with the status breakdown',
  );
  const expectedOpen =
    (statusMap.get('pending') ?? 0) +
    (statusMap.get('matching') ?? 0) +
    (statusMap.get('matched') ?? 0) +
    (statusMap.get('in_progress') ?? 0);
  assert(ov.requests.open === expectedOpen, 'open = pending + matching + matched + in_progress');
  assert(
    ov.requests.completed === (statusMap.get('completed') ?? 0) &&
      ov.requests.cancelled === (statusMap.get('cancelled') ?? 0),
    'completed/cancelled counted from real rows',
  );

  const dbOfferTotal = offers.reduce((sum, row) => sum + Number(row.n), 0);
  assert(ov.offers.total === dbOfferTotal, 'offers.total equals reality');
  assert(
    ov.offers.pending === (new Map(offers.map((r) => [r.status, Number(r.n)])).get('pending') ?? 0),
    'offer statuses broken down from real rows',
  );

  const recent = ov.recent as any[];
  assert(Array.isArray(recent) && recent.length > 0 && recent.length <= 10, 'recent activity is 1–10 events');
  const atDescending = recent.every(
    (event, index) =>
      index === 0 || new Date(recent[index - 1].at).getTime() >= new Date(event.at).getTime(),
  );
  assert(atDescending, 'recent activity is newest-first');
  assert(
    recent.every((event) => ['request', 'user', 'offer'].includes(event.kind)),
    'recent activity only uses the three real event kinds',
  );
  assert(
    recent.some((event) => event.kind === 'request' && event.id === requestId),
    'the monitored request appears in recent activity',
  );
  assert(
    recent.some((event) => event.kind === 'user' && event.email === EMAIL_C),
    'the newest account appears in recent activity',
  );
  assert(
    recent.some((event) => event.kind === 'offer' && event.id === offerId),
    'the dispatch offer appears in recent activity',
  );
}

async function testStatusMutations(
  admin: Session,
  customer: Session,
  technician: Session,
): Promise<void> {
  console.log('\nserver-authorized account status changes (PATCH /admin/users/:id/status)');

  const selfPatch = await api('PATCH', `/admin/users/${admin.userId}/status`, {
    token: admin.token,
    body: { accountStatus: 'suspended' },
  });
  assert(selfPatch.status === 403, 'administrator changing their OWN status → 403 (lockout guard)');

  const ghost = await api('PATCH', `/admin/users/${crypto.randomUUID()}/status`, {
    token: admin.token,
    body: { accountStatus: 'active' },
  });
  assert(ghost.status === 404, 'unknown user id → 404');

  const badUuid = await api('PATCH', '/admin/users/not-a-uuid/status', {
    token: admin.token,
    body: { accountStatus: 'active' },
  });
  assert(badUuid.status === 400, 'invalid uuid → 400 (never 500)');

  const badKey = await api('PATCH', `/admin/users/${customerId}/status`, {
    token: admin.token,
    body: { status: 'active' },
  });
  assert(badKey.status === 400 && badKey.body?.error === 'Validation failed', 'wrong body shape → 400');

  const badValue = await api('PATCH', `/admin/users/${customerId}/status`, {
    token: admin.token,
    body: { accountStatus: 'archived' },
  });
  assert(badValue.status === 400, 'status outside the vocabulary → 400');

  // Suspend the fixture customer → enforced immediately (DB-authoritative).
  const suspend = await api('PATCH', `/admin/users/${customerId}/status`, {
    token: admin.token,
    body: { accountStatus: 'suspended' },
  });
  assert(suspend.status === 200 && suspend.body?.data?.accountStatus === 'suspended', 'suspend → 200 with the fresh status');
  assert(hasNoSecrets(suspend), 'mutation response carries only safe fields');
  const suspendedDb = await query<{ account_status: string }>(
    'SELECT account_status FROM users WHERE id = $1',
    [customerId],
  );
  assert(suspendedDb[0].account_status === 'suspended', 'database row is suspended');
  assert(
    (await api('GET', '/auth/me', { token: customer.token })).status === 401,
    'existing customer token is rejected immediately after suspension',
  );

  const reactivate = await api('PATCH', `/admin/users/${customerId}/status`, {
    token: admin.token,
    body: { accountStatus: 'active' },
  });
  assert(reactivate.status === 200 && reactivate.body?.data?.accountStatus === 'active', 'reactivate → 200');
  assert(
    (await api('GET', '/auth/me', { token: customer.token })).status === 200,
    'the same token works again once the account is active',
  );

  // Technician accounts keep the profile row in sync (Task 11 vocabulary).
  const techSuspend = await api('PATCH', `/admin/users/${technicianUserId}/status`, {
    token: admin.token,
    body: { accountStatus: 'suspended' },
  });
  assert(techSuspend.status === 200, 'technician account suspended → 200');
  const profileSuspended = await query<{ account_status: string }>(
    'SELECT account_status FROM technicians WHERE user_id = $1',
    [technicianUserId],
  );
  assert(
    profileSuspended[0]?.account_status === 'suspended',
    'linked technician profile follows the account (suspended)',
  );

  await api('PATCH', `/admin/users/${technicianUserId}/status`, {
    token: admin.token,
    body: { accountStatus: 'disabled' },
  });
  const profileDisabled = await query<{ account_status: string }>(
    'SELECT account_status FROM technicians WHERE user_id = $1',
    [technicianUserId],
  );
  assert(
    profileDisabled[0]?.account_status === 'inactive',
    "'disabled' maps to the profile vocabulary's 'inactive'",
  );

  await api('PATCH', `/admin/users/${technicianUserId}/status`, {
    token: admin.token,
    body: { accountStatus: 'active' },
  });
  const profileActive = await query<{ account_status: string }>(
    'SELECT account_status FROM technicians WHERE user_id = $1',
    [technicianUserId],
  );
  assert(profileActive[0]?.account_status === 'active', 'reactivation restores profile active');

  const adminStill = await query<{ account_status: string }>(
    'SELECT account_status FROM users WHERE lower(email) = lower($1)',
    [ADMIN_EMAIL as string],
  );
  assert(adminStill[0]?.account_status === 'active', 'administrator account untouched by every mutation');
  assert(
    (await api('GET', '/auth/me', { token: technician.token })).status === 200,
    'technician session healthy again after restore',
  );
}

async function testRegression(sessions: {
  admin: Session;
  customer: Session;
  technician: Session;
}): Promise<void> {
  console.log('\nTask 20–24 regression (admin session + public surface)');

  const { admin, customer, technician } = sessions;

  const healthRes = await health();
  assert(healthRes.status === 200 && healthRes.body?.data?.status === 'ok', 'GET /health stays public and ok');

  const categories = await api('GET', '/categories');
  assert(categories.status === 200 && categories.body?.data?.length === 9, 'GET /categories still returns 9');

  const publicTechnicians = await api('GET', '/technicians');
  assert(
    publicTechnicians.status === 200 && Array.isArray(publicTechnicians.body?.data),
    'public technician catalogue unaffected',
  );

  const meAdmin = await api('GET', '/auth/me', { token: admin.token });
  assert(meAdmin.status === 200 && meAdmin.body?.data?.user?.role === 'administrator', 'admin /auth/me → administrator');
  const meCustomer = await api('GET', '/auth/me', { token: customer.token });
  assert(meCustomer.status === 200 && meCustomer.body?.data?.user?.role === 'customer', 'customer /auth/me → customer');
  const meTechnician = await api('GET', '/auth/me', { token: technician.token });
  assert(
    meTechnician.status === 200 &&
      meTechnician.body?.data?.user?.role === 'technician' &&
      typeof meTechnician.body?.data?.user?.technicianName === 'string',
    'technician /auth/me keeps the linked profile fields (Task 23 contract)',
  );

  assert(
    (await api('GET', `/requests/${requestId}`, { token: admin.token })).status === 200,
    'administrator still reads any request (Task 23 ownership matrix intact)',
  );

  assert(loginCount === 3, `suite issued exactly 3 logins (rate-budget discipline; saw ${loginCount})`);
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
    `DELETE FROM dispatch_offers WHERE request_id IN
       (SELECT id FROM service_requests WHERE description LIKE 'TASK25-API %')`,
  );
  await query(`DELETE FROM service_requests WHERE description LIKE 'TASK25-API %'`);
  await query(
    `DELETE FROM technicians WHERE user_id IN
       (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test')`,
  );
  // Known issue 15 improvement: NEVER delete the seeded administrator.
  await query(
    `DELETE FROM users WHERE lower(email) LIKE '%@umodzi.test'
       AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );
  // The suite's own admin login leaves a refresh session behind; the
  // documented baseline is "1 admin user / 0 sessions", so the runtime
  // session rows are removed (the account itself stays, ready to log in).
  await query(
    `DELETE FROM sessions WHERE user_id =
       (SELECT id FROM users WHERE lower(email) = lower($1))`,
    [ADMIN_EMAIL as string],
  );

  const requests = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM service_requests WHERE description LIKE 'TASK25-API %'`,
  );
  const offers = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM dispatch_offers WHERE technician_id IN
       (SELECT id FROM technicians WHERE user_id IS NOT NULL)`,
  );
  const users = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE lower(email) LIKE '%@umodzi.test'
       AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );
  const admin = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM users WHERE lower(email) = lower($1)',
    [ADMIN_EMAIL as string],
  );
  const linkedOrphans = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM technicians WHERE user_id IS NOT NULL',
  );
  const adminSession = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM sessions WHERE user_id =
       (SELECT id FROM users WHERE lower(email) = lower($1))`,
    [ADMIN_EMAIL as string],
  );

  assert(Number(requests[0].n) === 0, 'no TASK25 request rows remain');
  assert(Number(offers[0].n) === 0, 'no fixture offers remain');
  assert(Number(users[0].n) === 0, 'no fixture accounts remain');
  assert(Number(linkedOrphans[0].n) === 0, 'no linked technician profiles remain (seed profiles untouched)');
  assert(Number(admin[0].n) === 1, 'seeded administrator still exists (excluded from cleanup)');
  assert(Number(adminSession[0].n) === 0, 'administrator session rows cleaned');
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const sessions = await createFixtures();
  await testAuthorizationMatrix(sessions);
  await testUserManagement(sessions.admin);
  await testTechnicianManagement(sessions.admin);
  await testRequestMonitoring(sessions.admin, sessions.customer);
  await testOverview(sessions.admin);
  await testStatusMutations(sessions.admin, sessions.customer, sessions.technician);
  await testRegression(sessions);
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
