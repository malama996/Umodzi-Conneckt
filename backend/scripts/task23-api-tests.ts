/**
 * Task 23 API integration tests: the full auth + authorization contract
 * against a RUNNING backend (start it first, see STATE.md).
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi'
 *   $env:JWT_SECRET='<same 32+ char secret as the server>'
 *   $env:ADMIN_EMAIL='…'  $env:ADMIN_PASSWORD='…'   # the server's seed values
 *   npx tsx scripts/task23-api-tests.ts
 *
 * Covers: registration rules, generic login errors, cookie policy, JWT
 * claim/verification negatives, DB-authoritative status checks, the full
 * role + ownership matrix (404 hides existence, 403 endpoint misuse),
 * refresh rotation/grace/logout/reuse/expiry, CORS credentials, legacy
 * NULL-owner rows, and auth-only rate limiting (run last).
 *
 * All test accounts use @umodzi.test emails and every row created here is
 * removed again in the cleanup phase, restoring the baseline dataset.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { query } from '../src/db/client.js';

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001/api/v1';
const API_ORIGIN = new URL(API_BASE).origin;
const API_PORT = Number(new URL(API_BASE).port || 80);
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ISSUER = process.env.JWT_ISSUER?.trim() || 'umodzi-connect-api';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE?.trim() || 'umodzi-connect-web';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

for (const [name, value] of Object.entries({
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET,
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
  headers: Headers;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; cookie?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.cookie) headers['Cookie'] = opts.cookie;
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
  return { status: res.status, text, body, headers: res.headers };
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
  return { status: res.status, text, body, headers: res.headers };
}

/** The full Set-Cookie line that carries the refresh token, if present. */
function refreshSetCookie(headers: Headers): string | null {
  const list =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : headers.get('set-cookie')
        ? [headers.get('set-cookie') as string]
        : [];
  return list.find((entry) => entry.startsWith('umodzi_refresh=')) ?? null;
}

/** 'umodzi_refresh=<value>' for the Cookie request header. */
function refreshPair(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = /^umodzi_refresh=([^;]*)/.exec(setCookie);
  if (!match) return null;
  return match[1] ? `umodzi_refresh=${match[1]}` : null;
}

/** Raw HTTP request (lets us send an Origin header explicitly for CORS). */
function rawRequest(
  method: string,
  path: string,
  origin?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const headers: Record<string, string> = {};
  if (origin) headers['Origin'] = origin;
  if (method === 'OPTIONS') {
    headers['Access-Control-Request-Method'] = 'POST';
    headers['Access-Control-Request-Headers'] = 'content-type';
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port: API_PORT, path: `/api/v1${path}`, method, headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* JWT crafting (negative controls)                                    */
/* ------------------------------------------------------------------ */

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function craftJwt(
  payload: Record<string, unknown>,
  secret: string = JWT_SECRET as string,
): string {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const claims = b64url(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${claims}`)
    .digest('base64url');
  return `${header}.${claims}.${signature}`;
}

interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function decodeJwt(token: string): DecodedJwt {
  const [header, payload] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
  };
}

function baseClaims(userId: string, role: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: userId,
    role,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 900,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
  };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
const PASSWORD = 'Task23Integration!42';
const EMAIL_A = `customer-a-${RUN}@umodzi.test`;
const EMAIL_B = `customer-b-${RUN}@umodzi.test`;
const EMAIL_TECH = `technician-${RUN}@umodzi.test`;

interface Session {
  userId: string;
  token: string;
  cookie: string | null;
}

let loginCount = 0;

async function login(email: string, password: string): Promise<ApiResponse> {
  loginCount += 1;
  return api('POST', '/auth/login', { body: { email, password } });
}

function sessionFrom(response: ApiResponse): Session {
  const user = response.body?.data?.user as { id: string };
  return {
    userId: user.id,
    token: response.body?.data?.accessToken as string,
    cookie: refreshPair(refreshSetCookie(response.headers)),
  };
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function testPublicAndUnauthenticated(): Promise<void> {
  console.log('\npublic endpoints + unauthenticated rejections');

  assert((await health()).status === 200, 'GET /health is public');
  const categories = await api('GET', '/categories');
  assert(categories.status === 200 && categories.body?.data?.length === 9, 'GET /categories returns 9');
  assert((await api('GET', '/technicians')).status === 200, 'GET /technicians is public');
  assert((await api('GET', '/auth/me')).status === 401, 'GET /auth/me requires authentication');
  assert((await api('POST', '/auth/refresh')).status === 401, 'POST /auth/refresh without cookie → 401');
  assert((await api('POST', '/requests', { body: {} })).status === 401, 'POST /requests unauthenticated → 401');

  const ghostId = '00000000-0000-4000-8000-000000000000';
  assert((await api('GET', `/requests/${ghostId}`)).status === 401, 'GET /requests/:id unauthenticated → 401');
}

async function testRegistration(): Promise<void> {
  console.log('\nregistration rules');

  const customerA = await api('POST', '/auth/register', {
    body: {
      email: EMAIL_A,
      password: PASSWORD,
      firstName: 'Alice',
      lastName: 'Banda',
      role: 'customer',
    },
  });
  assert(customerA.status === 201, 'customer registration → 201');
  assert(customerA.body?.data?.user?.role === 'customer', 'registered role is customer');
  assert(customerA.body?.data?.user?.accountStatus === 'active', 'new accounts are active');
  assert(
    !customerA.text.includes(PASSWORD) && !customerA.text.includes('password_hash'),
    'registration response contains no password material',
  );

  const duplicate = await api('POST', '/auth/register', {
    body: {
      email: EMAIL_A.toUpperCase(),
      password: PASSWORD,
      firstName: 'Alice',
      lastName: 'Banda',
      role: 'customer',
    },
  });
  assert(duplicate.status === 409, 'duplicate email (case-insensitive) → 409');

  const admin = await api('POST', '/auth/register', {
    body: {
      email: `sneaky-${RUN}@umodzi.test`,
      password: PASSWORD,
      firstName: 'Sneaky',
      lastName: 'Admin',
      role: 'administrator',
    },
  });
  assert(admin.status === 403, 'public registration of administrator → 403');

  const shortPassword = await api('POST', '/auth/register', {
    body: {
      email: `short-${RUN}@umodzi.test`,
      password: 'short',
      firstName: 'Sam',
      lastName: 'Short',
      role: 'customer',
    },
  });
  assert(shortPassword.status === 400, 'password below 8 characters → 400');

  const tech = await api('POST', '/auth/register', {
    body: {
      email: EMAIL_TECH,
      password: PASSWORD,
      firstName: 'Theo',
      lastName: 'Phiri',
      role: 'technician',
      category: 'Plumbing',
      serviceArea: 'Kitwe',
    },
  });
  assert(tech.status === 201, 'technician registration → 201');

  const techNoCategory = await api('POST', '/auth/register', {
    body: {
      email: `tech-incomplete-${RUN}@umodzi.test`,
      password: PASSWORD,
      firstName: 'Incomplete',
      lastName: 'Tech',
      role: 'technician',
      serviceArea: 'Kitwe',
    },
  });
  assert(techNoCategory.status === 400, 'technician without category → 400');

  const admins = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'administrator' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );
  assert(Number(admins[0].n) === 0, 'no administrator exists outside the controlled seed');

  const profiles = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM technicians t JOIN users u ON u.id = t.user_id WHERE u.email = $1`,
    [EMAIL_TECH],
  );
  assert(Number(profiles[0].n) === 1, 'technician account has exactly one linked profile');
}

async function testLoginNegatives(): Promise<{ badLoginBody: string }> {
  console.log('\nlogin negatives — generic errors');

  const unknown = await login(`nobody-${RUN}@umodzi.test`, PASSWORD);
  assert(unknown.status === 401, 'unknown email → 401');

  const wrongPassword = await login(EMAIL_A, 'DefinitelyWrong999');
  assert(wrongPassword.status === 401, 'wrong password → 401');
  assert(
    unknown.text === wrongPassword.text,
    'unknown email and wrong password are byte-identical responses',
  );
  assert(
    unknown.body?.error === 'Invalid email or password',
    'generic message matches the specified wording',
  );

  const empty = await login('', '');
  assert(empty.status === 401 && empty.text === unknown.text, 'empty credentials use the same generic 401');

  return { badLoginBody: unknown.text };
}

async function testLoginAndCookies(): Promise<{
  customerA: Session;
  customerB: Session;
  technician: Session;
  admin: Session;
}> {
  console.log('\nlogin positives + refresh cookie policy');

  const responseA = await login(EMAIL_A, PASSWORD);
  assert(responseA.status === 200, 'customer login → 200');
  const sessionA = sessionFrom(responseA);
  assert(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(sessionA.token), 'access token is a 3-part JWT');
  assert(!responseA.text.includes(PASSWORD), 'login response never echoes the password');

  const setCookie = refreshSetCookie(responseA.headers);
  assert(setCookie !== null, 'login sets the refresh cookie');
  assert(/HttpOnly/i.test(setCookie ?? ''), 'refresh cookie is HttpOnly');
  assert(/Path=\/api\/v1\/auth/i.test(setCookie ?? ''), 'refresh cookie is scoped to /api/v1/auth');
  assert(/SameSite=Lax/i.test(setCookie ?? ''), 'refresh cookie is SameSite=Lax');
  assert(/Secure/i.test(setCookie ?? '') === false, 'no Secure attribute over plain HTTP (set automatically for https)');
  assert(/Max-Age=604800/i.test(setCookie ?? ''), 'refresh cookie lifetime is 7 days');

  const responseB = await api('POST', '/auth/register', {
    body: {
      email: EMAIL_B,
      password: PASSWORD,
      firstName: 'Brian',
      lastName: 'Mwewa',
      role: 'customer',
    },
  });
  assert(responseB.status === 201, 'second customer registration → 201');
  const sessionB = sessionFrom(await login(EMAIL_B, PASSWORD));

  const responseTech = await login(EMAIL_TECH, PASSWORD);
  const sessionTech = sessionFrom(responseTech);
  assert(responseTech.status === 200, 'technician login → 200');

  const meTech = await api('GET', '/auth/me', { token: sessionTech.token });
  assert(meTech.status === 200, 'technician /auth/me → 200');
  assert(
    typeof meTech.body?.data?.user?.technicianId === 'string' &&
      typeof meTech.body?.data?.user?.technicianName === 'string',
    'technician /auth/me exposes the linked profile id and name',
  );

  const responseAdmin = await login(ADMIN_EMAIL as string, ADMIN_PASSWORD as string);
  assert(responseAdmin.status === 200, 'seeded administrator login → 200');
  const sessionAdmin = sessionFrom(responseAdmin);
  assert(sessionAdmin.token.length > 0, 'admin access token issued');

  return { customerA: sessionA, customerB: sessionB, technician: sessionTech, admin: sessionAdmin };
}

async function testTokenClaimsAndVerification(customerA: Session): Promise<void> {
  console.log('\naccess token claims + verification negatives');

  const decoded = decodeJwt(customerA.token);
  const claimKeys = Object.keys(decoded.payload).sort().join(',');
  assert(
    claimKeys === 'aud,exp,iat,iss,jti,role,sub',
    `token carries only minimal claims (${claimKeys})`,
  );
  assert(decoded.payload.sub === customerA.userId, 'sub is the user id');
  assert(decoded.payload.role === 'customer', 'role claim matches the account');
  assert(decoded.header.alg === 'HS256', 'token algorithm is HS256');
  assert(
    !customerA.token.includes('@') && !JSON.stringify(decoded.payload).includes('firstName'),
    'token contains no PII beyond the role/id claims',
  );

  assert((await api('GET', '/auth/me', { token: 'garbage' })).status === 401, 'malformed token → 401');
  assert(
    (await api('GET', '/auth/me', { token: `${customerA.token}x` })).status === 401,
    'tampered signature → 401',
  );
  assert(
    (await api('GET', '/auth/me', { token: craftJwt(baseClaims(customerA.userId, 'customer'), 'f'.repeat(32)) })).status === 401,
    'token signed with a foreign secret → 401',
  );
  assert(
    (await api('GET', '/auth/me', { token: craftJwt({ ...baseClaims(customerA.userId, 'customer'), iss: 'evil-issuer' }) })).status === 401,
    'wrong issuer → 401',
  );
  assert(
    (await api('GET', '/auth/me', { token: craftJwt({ ...baseClaims(customerA.userId, 'customer'), aud: 'evil-audience' }) })).status === 401,
    'wrong audience → 401',
  );
  assert(
    (await api('GET', '/auth/me', { token: craftJwt({ ...baseClaims(customerA.userId, 'customer'), exp: Math.floor(Date.now() / 1000) - 60 }) })).status === 401,
    'expired token → 401',
  );
  const noRole = baseClaims(customerA.userId, 'customer');
  delete (noRole as Record<string, unknown>).role;
  assert(
    (await api('GET', '/auth/me', { token: craftJwt(noRole) })).status === 401,
    'token without role claim → 401',
  );
  assert(
    (await api('GET', '/auth/me', { token: craftJwt({ ...baseClaims('not-a-uuid', 'customer') }) })).status === 401,
    'non-UUID sub → 401',
  );
  assert(
    (await api('GET', '/auth/me', { token: craftJwt(baseClaims(customerA.userId, 'customer')) })).status === 200,
    'correctly crafted token with valid claims → 200 (positive control)',
  );
}

async function testOwnershipMatrix(sessions: {
  customerA: Session;
  customerB: Session;
  technician: Session;
  admin: Session;
}): Promise<{ requestId: string; offerId: string; techProfileId: string }> {
  console.log('\nrole + ownership matrix');

  const { customerA, customerB, technician, admin } = sessions;

  const created = await api('POST', '/requests', {
    token: customerA.token,
    body: { description: 'TASK23-API kitchen sink is leaking badly', category: 'Electrical', city: 'Kitwe' },
  });
  assert(created.status === 201, 'customer creates a request → 201');
  const requestId = created.body?.data?.id as string;

  const ownerRow = await query<{ customer_user_id: string }>(
    'SELECT customer_user_id FROM service_requests WHERE id = $1',
    [requestId],
  );
  assert(
    ownerRow[0]?.customer_user_id === customerA.userId,
    'backend derived ownership from the JWT identity, not the client',
  );

  const techCreate = await api('POST', '/requests', {
    token: technician.token,
    body: { description: 'TASK23-API technician should not create', category: 'Plumbing', city: 'Kitwe' },
  });
  assert(techCreate.status === 403, 'technician creating a request → 403 (role gate)');

  const adminCreate = await api('POST', '/requests', {
    token: admin.token,
    body: { description: 'TASK23-API admin should not create', category: 'Plumbing', city: 'Kitwe' },
  });
  assert(adminCreate.status === 403, 'administrator creating a request → 403 (customer-only endpoint)');

  assert((await api('GET', `/requests/${requestId}`, { token: customerA.token })).status === 200, 'owner reads own request → 200');
  assert((await api('GET', `/requests/${requestId}`, { token: customerB.token })).status === 404, 'other customer reads it → 404 (existence hidden)');
  assert((await api('GET', `/requests/${requestId}`, { token: technician.token })).status === 404, 'uninvolved technician reads it → 404');
  assert((await api('GET', `/requests/${requestId}`, { token: admin.token })).status === 200, 'administrator reads it → 200');

  assert(
    (await api('PATCH', `/requests/${requestId}/status`, { token: customerB.token, body: { status: 'cancelled' } })).status === 404,
    'other customer PATCHes it → 404',
  );
  assert(
    (await api('GET', `/requests/${requestId}/offers`, { token: customerB.token })).status === 404,
    'other customer lists its offers → 404',
  );
  assert(
    (await api('GET', '/requests/not-a-uuid', { token: customerA.token })).status === 400,
    'invalid request id → 400 (not 500)',
  );

  const techProfileId = (await api('GET', '/auth/me', { token: technician.token })).body?.data?.user
    ?.technicianId as string;
  assert(typeof techProfileId === 'string', 'technician profile id known to the session');

  // Task 28: POST /offers now enforces server-side eligibility. Make this
  // registered technician a genuinely eligible candidate for the
  // Electrical/Kitwe request created above (verified + active + available +
  // matching category/service area) — mirroring what the real admin
  // verification + dispatch flow would have produced before an offer exists.
  await query(
    `UPDATE technicians
        SET category = 'Electrical', service_area = 'Kitwe', verified = true,
            verification_status = 'verified', account_status = 'active',
            availability_status = 'available', updated_at = NOW()
      WHERE id = $1`,
    [techProfileId],
  );

  const ownOffers = await api('GET', `/offers/technician/${techProfileId}`, { token: technician.token });
  assert(ownOffers.status === 200 && Array.isArray(ownOffers.body?.data), 'technician reads own offers → 200');

  // Task 28: deterministically pick a SEEDED technician that is eligible for
  // the Electrical/Kitwe request (verified + active + available + matching
  // category/area) so the second offer exercises the customer-side create +
  // reject flow against a genuinely eligible candidate.
  const seededTech = await query<{ id: string }>(
    `SELECT id FROM technicians
      WHERE user_id IS NULL AND category = 'Electrical' AND service_area = 'Kitwe'
        AND verification_status = 'verified' AND account_status = 'active'
        AND availability_status = 'available'
      ORDER BY name LIMIT 1`,
  );
  assert(
    (await api('GET', `/offers/technician/${seededTech[0].id}`, { token: technician.token })).status === 403,
    "another technician's collection → 403 (endpoint misuse)",
  );
  assert(
    (await api('GET', `/offers/technician/${techProfileId}`, { token: customerA.token })).status === 403,
    'customer reading a technician collection → 403',
  );
  assert(
    (await api('GET', '/offers/technician/not-a-uuid', { token: technician.token })).status === 400,
    'invalid technician id → 400',
  );
  assert(
    (await api('GET', `/offers/technician/${techProfileId}`, { token: admin.token })).status === 200,
    'administrator reads any technician collection → 200',
  );

  // ---- offers: creation + response authorization
  const offer = await api('POST', '/offers', {
    token: customerA.token,
    body: { requestId, technicianId: techProfileId, candidateIndex: 0, status: 'pending' },
  });
  assert(offer.status === 201, 'owner customer creates a dispatched offer → 201');
  const offerId = offer.body?.data?.id as string;

  const foreignOffer = await api('POST', '/offers', {
    token: customerB.token,
    body: { requestId, technicianId: techProfileId, candidateIndex: 1, status: 'pending' },
  });
  assert(foreignOffer.status === 404, 'other customer creating an offer → 404');

  const ghostTechnician = await api('POST', '/offers', {
    token: customerA.token,
    body: {
      requestId,
      technicianId: '11111111-2222-4333-8444-555555555555',
      candidateIndex: 1,
      status: 'pending',
    },
  });
  assert(ghostTechnician.status === 404, 'offer targeting a non-existent technician → 404');

  // Participant technician can now read the request it must respond to.
  assert(
    (await api('GET', `/requests/${requestId}`, { token: technician.token })).status === 200,
    'technician holding an offer reads the request → 200',
  );
  assert(
    (await api('GET', `/requests/${requestId}/offers`, { token: technician.token })).status === 200,
    'technician participant lists the offers → 200',
  );
  assert(
    (await api('GET', `/requests/${requestId}/offers`, { token: customerA.token })).status === 200,
    'owner customer lists the offers → 200',
  );

  const badScope = await api('PATCH', `/requests/${requestId}/status`, {
    token: technician.token,
    body: { status: 'in_progress' },
  });
  assert(badScope.status === 403, 'technician writing an out-of-scope status → 403');

  const goodScope = await api('PATCH', `/requests/${requestId}/status`, {
    token: technician.token,
    body: { status: 'matched' },
  });
  assert(goodScope.status === 200, 'technician participant records matched → 200');

  const ownerPatch = await api('PATCH', `/requests/${requestId}/status`, {
    token: customerA.token,
    body: { status: 'matching' },
  });
  assert(ownerPatch.status === 200, 'owner customer keeps the full status vocabulary → 200');

  assert(
    (await api('POST', `/offers/${offerId}/accept`, { token: customerB.token })).status === 404,
    'unrelated customer responding to an offer → 404',
  );
  assert(
    (await api('POST', `/offers/${offerId}/accept`, { token: technician.token })).status === 200,
    'owning technician accepts its offer → 200',
  );

  // Customer-side accept flow (the /matching behaviour) on a second offer.
  const offer2 = await api('POST', '/offers', {
    token: customerA.token,
    body: { requestId, technicianId: seededTech[0].id, candidateIndex: 1, status: 'pending' },
  });
  assert(offer2.status === 201, 'second offer (seeded technician) created → 201');
  const offer2Id = offer2.body?.data?.id as string;
  assert(
    (await api('POST', `/offers/${offer2Id}/reject`, { token: customerA.token })).status === 200,
    'owner customer rejects an offer on their own request → 200',
  );
  assert(
    (await api('POST', '/offers/not-a-uuid/accept', { token: technician.token })).status === 400,
    'invalid offer id → 400 (not 500)',
  );

  // ---- administrator surface
  const adminUsers = await api('GET', '/admin/users', { token: admin.token });
  assert(adminUsers.status === 200 && Array.isArray(adminUsers.body?.data), 'admin lists users → 200');
  assert(
    !adminUsers.text.includes('password_hash') && !adminUsers.text.includes(PASSWORD),
    'admin listing contains no password material',
  );
  assert(
    (await api('GET', '/admin/users', { token: customerA.token })).status === 403,
    'customer hitting the admin endpoint → 403',
  );
  assert((await api('GET', '/admin/users')).status === 401, 'anonymous admin endpoint → 401');

  return { requestId, offerId, techProfileId };
}

async function testLegacyNullOwnership(admin: Session, customerA: Session): Promise<void> {
  console.log('\nlegacy NULL-owner rows (never claimed)');

  await query(
    `INSERT INTO service_requests (id, description, category, city, status, customer_user_id, created_at, updated_at)
     VALUES ($1, 'TASK23-API legacy request from before auth', 'Electrical', 'Ndola', 'pending', NULL, NOW(), NOW())`,
    [crypto.randomUUID()],
  );
  const legacy = await query<{ id: string }>(
    `SELECT id FROM service_requests WHERE description = 'TASK23-API legacy request from before auth'`,
  );
  assert(legacy.length === 1, 'legacy fixture row exists with NULL ownership');
  assert(
    (await api('GET', `/requests/${legacy[0].id}`, { token: customerA.token })).status === 404,
    'a customer cannot read a legacy NULL-owner request → 404',
  );
  assert(
    (await api('GET', `/requests/${legacy[0].id}`, { token: admin.token })).status === 200,
    'administrator can read a legacy NULL-owner request → 200',
  );
}

async function testStatusDatabaseAuthoritative(customerA: Session): Promise<void> {
  console.log('\naccount status is authoritative from the database');

  await query(`UPDATE users SET account_status = 'suspended' WHERE id = $1`, [customerA.userId]);

  assert(
    (await api('GET', '/auth/me', { token: customerA.token })).status === 401,
    'existing access token is rejected immediately after suspension (401, not 200)',
  );
  const loginSuspended = await login(EMAIL_A, PASSWORD);
  assert(loginSuspended.status === 403, 'login with valid password but suspended account → 403');
  assert(
    loginSuspended.body?.error === 'This account is not active.',
    'suspension message is explicit only after password proof',
  );
  assert(
    (await api('POST', '/requests', { token: customerA.token, body: { description: 'TASK23-API should fail', category: 'Plumbing', city: 'Kitwe' } })).status === 401,
    'every protected endpoint rejects the suspended account → 401',
  );

  await query(`UPDATE users SET account_status = 'active' WHERE id = $1`, [customerA.userId]);
  assert(
    (await api('GET', '/auth/me', { token: customerA.token })).status === 200,
    'restoring status re-enables the same token (live DB read)',
  );
}

async function testRefreshRotation(sessions: {
  customerA: Session;
  customerB: Session;
  admin: Session;
}): Promise<void> {
  console.log('\nrefresh rotation, reuse handling, logout');

  const { customerB, admin } = sessions;

  // Rotation: each refresh issues a NEW cookie and a NEW access token.
  const refresh1 = await api('POST', '/auth/refresh', { cookie: admin.cookie as string });
  assert(refresh1.status === 200, 'refresh with valid cookie → 200');
  const cookie1 = refreshPair(refreshSetCookie(refresh1.headers));
  assert(cookie1 !== null && cookie1 !== admin.cookie, 'refresh rotates the cookie value');
  assert(refresh1.body?.data?.accessToken !== admin.token, 'refresh issues a fresh access token');
  assert(refreshSetCookie(refresh1.headers)?.includes('HttpOnly') === true, 'rotated cookie stays HttpOnly');

  // Concurrent-tab grace: the previous (just-rotated) cookie still works
  // inside the 60s window.
  const grace = await api('POST', '/auth/refresh', { cookie: admin.cookie as string });
  assert(grace.status === 200, 'rotated-out cookie inside the grace window → 200 (concurrent tabs)');

  // Unknown cookie → 401.
  const unknown = await api('POST', '/auth/refresh', {
    cookie: `umodzi_refresh=${crypto.randomBytes(32).toString('base64url')}`,
  });
  assert(unknown.status === 401, 'unknown refresh token → 401');

  // Logout: revoke + clear cookie; the logged-out cookie can never return.
  const logout = await api('POST', '/auth/logout', { cookie: cookie1 as string });
  assert(logout.status === 200, 'logout → 200');
  const cleared = refreshSetCookie(logout.headers);
  assert(
    cleared !== null && /Max-Age=0/i.test(cleared) && /umodzi_refresh=;/.test(cleared),
    'logout clears the refresh cookie',
  );
  assert(
    (await api('POST', '/auth/refresh', { cookie: cookie1 as string })).status === 401,
    'logged-out cookie cannot refresh (logout is never grace-bypassable)',
  );

  // Reuse beyond the grace window = theft: revoke the whole family.
  const bCookie = customerB.cookie as string;
  const rawB = bCookie.replace('umodzi_refresh=', '');
  const hashB = crypto.createHash('sha256').update(rawB, 'utf8').digest('hex');
  const before = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [customerB.userId],
  );
  assert(Number(before[0].n) >= 1, 'customer B has an active session');

  await query(
    `UPDATE sessions SET revoked_at = NOW() - INTERVAL '10 minutes', revoked_reason = 'rotated'
     WHERE token_hash = $1`,
    [hashB],
  );
  const reuse = await api('POST', '/auth/refresh', { cookie: bCookie });
  assert(reuse.status === 401, 'replay beyond the grace window → 401');
  const after = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [customerB.userId],
  );
  assert(Number(after[0].n) === 0, 'reuse detection revokes EVERY session for that user');

  // Expiry: a session past expires_at can never be used.
  const rawExpired = crypto.randomBytes(32).toString('base64url');
  const expiredHash = crypto.createHash('sha256').update(rawExpired, 'utf8').digest('hex');
  await query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '8 days')`,
    [crypto.randomUUID(), customerB.userId, expiredHash],
  );
  assert(
    (await api('POST', '/auth/refresh', { cookie: `umodzi_refresh=${rawExpired}` })).status === 401,
    'expired session → 401',
  );

  // Raw tokens never appear in the database — only their hashes.
  const leaked = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM sessions WHERE token_hash = $1 OR token_hash = $2',
    [rawB, rawExpired],
  );
  assert(Number(leaked[0].n) === 0, 'database stores only SHA-256 hashes, never raw tokens');
}

async function testCors(): Promise<void> {
  console.log('\nCORS: credentialed, origin allow-list only');

  const configuredOrigin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000';

  const preflight = await rawRequest('OPTIONS', '/auth/login', configuredOrigin);
  assert(preflight.status < 300, 'preflight for /auth/login succeeds');
  assert(
    preflight.headers['access-control-allow-origin'] === configuredOrigin,
    'preflight echoes exactly the configured origin',
  );
  assert(
    preflight.headers['access-control-allow-credentials'] === 'true',
    'preflight allows credentials',
  );
  assert(
    preflight.headers['access-control-allow-origin'] !== '*',
    'origin is never "*"',
  );

  const foreign = await rawRequest('OPTIONS', '/auth/login', 'http://evil.example');
  assert(
    foreign.headers['access-control-allow-origin'] !== 'http://evil.example',
    'a foreign origin is never reflected back (browsers reject the mismatch)',
  );

  const simple = await rawRequest('GET', '/technicians', configuredOrigin);
  assert(
    simple.headers['access-control-allow-origin'] === configuredOrigin &&
      simple.headers['access-control-allow-credentials'] === 'true',
    'actual (non-preflight) responses carry the credentialed CORS headers',
  );
}

async function testRateLimitingLast(): Promise<void> {
  console.log('\nauth rate limiting (in-memory, auth routes only) — runs LAST');

  let saw429 = false;
  for (let attempt = 0; attempt < 25 && !saw429; attempt += 1) {
    const response = await api('POST', '/auth/login', {
      body: { email: `brute-${RUN}@umodzi.test`, password: 'Guessing12345' },
    });
    if (response.status === 429) {
      saw429 = true;
      assert(/too many|rate/i.test(response.text), '429 body is a safe rate-limit message');
    } else {
      assert(response.status === 401, `pre-limit failed login stays a generic 401 (attempt ${attempt + 1})`);
    }
  }
  assert(saw429, 'repeated credential guessing trips the per-IP rate limit with 429');

  assert((await api('GET', '/technicians')).status === 200, 'public endpoints are unaffected by the auth limiter');
  assert((await health()).status === 200, '/health is unaffected by the auth limiter');
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

async function cleanup(): Promise<void> {
  console.log('\ncleanup — restoring the baseline dataset');
  // Task 28.2D: offer/status hooks record in_app notifications for fixture
  // flows — remove them alongside the fixture rows they reference.
  await query(`DELETE FROM notifications`);
  await query(
    `DELETE FROM dispatch_offers WHERE request_id IN
       (SELECT id FROM service_requests WHERE description LIKE 'TASK23-API %')`,
  );
  await query(`DELETE FROM service_requests WHERE description LIKE 'TASK23-API %'`);
  await query(
    `DELETE FROM technicians WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test')`,
  );
  await query(`DELETE FROM users WHERE lower(email) LIKE '%@umodzi.test'`);

  const requests = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM service_requests WHERE description LIKE 'TASK23-API %'`,
  );
  const users = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE lower(email) LIKE '%@umodzi.test'`,
  );
  const offers = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM dispatch_offers WHERE request_id IN
       (SELECT id FROM service_requests WHERE description LIKE 'TASK23-API %')`,
  );
  assert(
    Number(requests[0].n) === 0 && Number(users[0].n) === 0 && Number(offers[0].n) === 0,
    'no test rows remain',
  );
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testPublicAndUnauthenticated();
  await testRegistration();
  await testLoginNegatives();
  const sessions = await testLoginAndCookies();
  await testTokenClaimsAndVerification(sessions.customerA);
  await testOwnershipMatrix(sessions);
  await testLegacyNullOwnership(sessions.admin, sessions.customerA);
  await testStatusDatabaseAuthoritative(sessions.customerA);
  await testRefreshRotation(sessions);
  await testCors();
  await testRateLimitingLast(); // consumes the login rate budget — keep last
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
