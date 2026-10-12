/**
 * Task 26 API integration tests: technician profile, profile photo,
 * verification documents, and the full verification lifecycle
 * (unverified → pending → verified, pending → rejected → pending) against
 * a RUNNING backend (start it first, see STATE.md).
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi'
 *   $env:ADMIN_EMAIL='…'  $env:ADMIN_PASSWORD='…'   # the server's seed values
 *   npx tsx scripts/task26-api-tests.ts
 *
 * Covers (§23):
 *   Authentication — anonymous 401s, customer 403s on technician-private
 *     endpoints, cross-technician document IDOR (404, existence hidden),
 *     administrator review access;
 *   Profile — bio/skills/serviceArea/availability persistence + every
 *     validation failure, public projection (bio/hasPhoto);
 *   Photo — valid upload, wrong type 415, missing file 400, oversize 413,
 *     replacement removes the previous stored file, public photo bytes;
 *   Documents — valid upload, invalid type 400, unsupported mime 415,
 *     owner-only visibility, admin visibility, no storage-key leakage;
 *   Verification — submit requires a national_id document, 409 on invalid
 *     transitions (pending/verified), reject requires a reason, reject →
 *     resubmit → approve lifecycle, review metadata (reviewer + timestamp),
 *     admin decision only from 'pending';
 *   Activation — verification approval does NOT touch availability or
 *     account status; a suspended account loses API access (requireAuth)
 *     while keeping verified=true; availability stays separately editable;
 *   Dispatch eligibility data — public /technicians rows carry the exact
 *     flags the eligibility filter consumes (verified flag flips only via
 *     the admin decision; unverified seeds stay unverified).
 *
 * Only 4 successful logins (admin, 2 technicians, 1 customer), zero failed
 * logins — the shared auth rate budget is never consumed.
 *
 * FIXTURES: @umodzi.test accounts + documents/photos under STORAGE_DIR for
 * those technicians. Cleanup restores the baseline (9 technicians /
 * 0 requests / 0 offers / 1 admin / 0 sessions / 0 documents / no leftover
 * uploaded files) and NEVER deletes the seeded admin (known issue 15).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '../src/db/client.js';

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR ?? 'var/uploads');

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
  bytes: Buffer;
  contentType: string;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; form?: FormData } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let payload: BodyInit | undefined;
  if (opts.form !== undefined) {
    payload = opts.form; // browser/undici sets the multipart boundary itself
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* binary or non-JSON body */
  }
  return {
    status: res.status,
    text,
    body,
    bytes,
    contentType: res.headers.get('content-type') ?? '',
  };
}

/** Classic 1×1 transparent PNG (real image bytes). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESDg8ODxDTz8+/9oACAEBAAE/APoCiiigD//Z',
  'base64',
);
const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF', 'utf8');

function uploadForm(fields: Record<string, string>, fileName: string, bytes: Buffer, mime: string): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value); // fields BEFORE the file (busboy emits in order)
  }
  form.append('file', new Blob([bytes], { type: mime }), fileName);
  return form;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
const PASSWORD = 'Task26Integration!42';
const EMAIL_A = `tech-a-t26-${RUN}@umodzi.test`;
const EMAIL_B = `tech-b-t26-${RUN}@umodzi.test`;
const EMAIL_C = `customer-t26-${RUN}@umodzi.test`;
const BIO =
  'Experienced electrical technician specializing in residential wiring, fault diagnosis and electrical appliance installation.';

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

let techAProfileId = '';
let docA1Id = '';
let docA2Id = '';
let seedTechnicianId = '';

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function createFixtures(): Promise<{
  admin: Session;
  techA: Session;
  techB: Session;
  customer: Session;
}> {
  console.log('\nfixtures: two technicians + one customer + one seed profile');

  const regA = await api('POST', '/auth/register', {
    body: {
      email: EMAIL_A,
      password: PASSWORD,
      firstName: 'Aaron',
      lastName: 'Sakala',
      role: 'technician',
      category: 'Electrical',
      serviceArea: 'Kitwe',
    },
  });
  assert(regA.status === 201, 'technician A registration → 201');
  const regB = await api('POST', '/auth/register', {
    body: {
      email: EMAIL_B,
      password: PASSWORD,
      firstName: 'Beatrice',
      lastName: 'Ndlovu',
      role: 'technician',
      category: 'Plumbing',
      serviceArea: 'Ndola',
    },
  });
  assert(regB.status === 201, 'technician B registration → 201');
  const regC = await api('POST', '/auth/register', {
    body: {
      email: EMAIL_C,
      password: PASSWORD,
      firstName: 'Chile',
      lastName: 'Mbewe',
      role: 'customer',
    },
  });
  assert(regC.status === 201, 'customer registration → 201');

  const admin = sessionFrom(await login(ADMIN_EMAIL as string, ADMIN_PASSWORD as string));
  const techA = sessionFrom(await login(EMAIL_A, PASSWORD));
  const techB = sessionFrom(await login(EMAIL_B, PASSWORD));
  const customer = sessionFrom(await login(EMAIL_C, PASSWORD));
  assert(admin.token.length > 0, 'admin login → token');
  assert(techA.token.length > 0 && techB.token.length > 0 && customer.token.length > 0, 'role logins → tokens');

  const meA = await api('GET', '/auth/me', { token: techA.token });
  techAProfileId = meA.body?.data?.user?.technicianId as string;
  assert(typeof techAProfileId === 'string' && techAProfileId.length > 0, 'technician A profile id linked');

  const seed = await query<{ id: string; verified: boolean }>(
    'SELECT id, verified FROM technicians WHERE user_id IS NULL AND verified = true LIMIT 1',
  );
  seedTechnicianId = seed[0].id;

  return { admin, techA, techB, customer };
}

async function testAuthenticationMatrix(sessions: {
  admin: Session;
  techA: Session;
  techB: Session;
  customer: Session;
}): Promise<void> {
  console.log('\nauthentication + authorization matrix');

  const { admin, techA, techB, customer } = sessions;
  const techOnly = [
    ['GET', '/technician/profile'],
    ['PATCH', '/technician/profile'],
    ['POST', '/technician/photo'],
    ['POST', '/technician/verification/documents'],
    ['POST', '/technician/verification/submit'],
    ['DELETE', `/technician/verification/documents/${crypto.randomUUID()}`],
  ] as const;
  for (const [method, path] of techOnly) {
    const anon = await api(method, path, method === 'PATCH' ? { body: { bio: 'x' } } : {});
    assert(anon.status === 401, `anonymous ${method} ${path} → 401`);
    const cust = await api(method, path, { token: customer.token, ...(method === 'PATCH' ? { body: { bio: 'x' } } : {}) });
    assert(cust.status === 403, `customer ${method} ${path} → 403`);
  }

  const adminOnly = [
    ['GET', `/admin/technicians/${techAProfileId}/verification`],
    ['PATCH', `/admin/technicians/${techAProfileId}/verification`],
  ] as const;
  for (const [method, path] of adminOnly) {
    const anon = await api(method, path, method === 'PATCH' ? { body: { decision: 'verified' } } : {});
    assert(anon.status === 401, `anonymous ${method} admin verification → 401`);
    const cust = await api(method, path, { token: customer.token, ...(method === 'PATCH' ? { body: { decision: 'verified' } } : {}) });
    assert(cust.status === 403, `customer ${method} admin verification → 403`);
    const other = await api(method, path, { token: techB.token, ...(method === 'PATCH' ? { body: { decision: 'verified' } } : {}) });
    assert(other.status === 403, `technician ${method} admin verification → 403 (cannot approve anyone, incl. self)`);
  }
  assert(
    (await api('GET', `/admin/technicians/${techAProfileId}/verification`, { token: admin.token })).status === 200,
    'administrator GET verification bundle → 200',
  );
}

async function testProfile(techA: Session): Promise<void> {
  console.log('\nown profile: read + patch + validation');

  const initial = await api('GET', '/technician/profile', { token: techA.token });
  assert(initial.status === 200, 'GET own profile → 200');
  assert(
    initial.body?.data?.bio === null &&
      initial.body?.data?.hasPhoto === false &&
      initial.body?.data?.verificationStatus === 'unverified' &&
      Array.isArray(initial.body?.data?.documents) &&
      initial.body.data.documents.length === 0,
    'fresh profile: no bio, no photo, unverified, no documents',
  );
  assert(
    !initial.text.includes('storage_key') && !initial.text.includes('photo_key'),
    'own profile never exposes storage keys',
  );

  const patched = await api('PATCH', '/technician/profile', {
    token: techA.token,
    body: { bio: BIO, skills: ['Home wiring', 'Fault diagnosis'], availabilityStatus: 'available' },
  });
  assert(patched.status === 200, 'PATCH bio + skills → 200');
  assert(
    patched.body?.data?.bio === BIO &&
      JSON.stringify(patched.body?.data?.skills) === JSON.stringify(['Home wiring', 'Fault diagnosis']) &&
      patched.body?.data?.availabilityStatus === 'available',
    'bio + skills persisted in the response',
  );

  const reread = await api('GET', '/technician/profile', { token: techA.token });
  assert(reread.body?.data?.bio === BIO, 'bio persists across reads (database, not echo)');

  const areaPatch = await api('PATCH', '/technician/profile', {
    token: techA.token,
    body: { serviceArea: 'Ndola', availability: 'Weekdays 8am–5pm' },
  });
  assert(
    areaPatch.status === 200 && areaPatch.body?.data?.serviceArea === 'Ndola',
    'service area change → 200',
  );
  const coords = await query<{ latitude: number; longitude: number }>(
    'SELECT latitude, longitude FROM technicians WHERE id = $1',
    [techAProfileId],
  );
  const centre = { latitude: -12.9587, longitude: 28.6366 };
  assert(
    Math.abs(coords[0].latitude - centre.latitude) < 0.0001 &&
      Math.abs(coords[0].longitude - centre.longitude) < 0.0001,
    'service-area change re-derives the deterministic centre coordinates',
  );

  const badEmpty = await api('PATCH', '/technician/profile', { token: techA.token, body: {} });
  assert(badEmpty.status === 400, 'PATCH with no fields → 400');
  const badBio = await api('PATCH', '/technician/profile', { token: techA.token, body: { bio: '' } });
  assert(badBio.status === 400, 'empty bio → 400');
  const longBio = await api('PATCH', '/technician/profile', { token: techA.token, body: { bio: 'x'.repeat(501) } });
  assert(longBio.status === 400, 'bio over 500 chars → 400');
  const badCategory = await api('PATCH', '/technician/profile', { token: techA.token, body: { category: 'Mechanics' } });
  assert(badCategory.status === 400, 'legacy/unknown category → 400');
  const badArea = await api('PATCH', '/technician/profile', { token: techA.token, body: { serviceArea: 'Other' } });
  assert(badArea.status === 400, 'service area outside the pilot cities → 400');
  const strict = await api('PATCH', '/technician/profile', { token: techA.token, body: { verified: true } });
  assert(
    strict.status === 400 && strict.body?.data?.verified !== true,
    'client cannot PATCH privileged fields (strict schema) → 400',
  );
  const stillUnverified = await api('GET', '/technician/profile', { token: techA.token });
  assert(
    stillUnverified.body?.data?.verified === false && stillUnverified.body?.data?.verificationStatus === 'unverified',
    'verification flags unchanged after the rejected patch attempt',
  );

  const publicRow = await api('GET', `/technicians/${techAProfileId}`);
  assert(
    publicRow.status === 200 && publicRow.body?.data?.bio === BIO && publicRow.body?.data?.hasPhoto === false,
    'public technician projection carries bio + hasPhoto (no verification internals)',
  );
  assert(
    !publicRow.text.includes('verification_status') && !publicRow.text.includes('photo_key'),
    'public projection hides lifecycle + storage internals',
  );
}

async function testPhoto(techA: Session, customer: Session): Promise<void> {
  console.log('\nprofile photo upload + serving');

  const upload = await api('POST', '/technician/photo', {
    token: techA.token,
    form: uploadForm({}, 'profile.png', TINY_PNG, 'image/png'),
  });
  assert(upload.status === 201 && upload.body?.data?.hasPhoto === true, 'valid photo upload → 201');

  const own = await api('GET', '/technician/profile', { token: techA.token });
  assert(own.body?.data?.hasPhoto === true, 'own profile reports hasPhoto');

  const photo = await api('GET', `/technicians/${techAProfileId}/photo`);
  assert(
    photo.status === 200 && photo.contentType.includes('image/png') && photo.bytes.equals(TINY_PNG),
    'public photo endpoint serves the exact bytes anonymously',
  );

  const wrongType = await api('POST', '/technician/photo', {
    token: techA.token,
    form: uploadForm({}, 'notes.txt', Buffer.from('plain text'), 'text/plain'),
  });
  assert(wrongType.status === 415, 'text upload → 415 unsupported type');

  const noFile = await api('POST', '/technician/photo', {
    token: techA.token,
    form: new FormData(),
  });
  assert(noFile.status === 400, 'empty multipart → 400');

  const oversized = await api('POST', '/technician/photo', {
    token: techA.token,
    form: uploadForm({}, 'big.png', Buffer.alloc(6 * 1024 * 1024, 7), 'image/png'),
  });
  assert(oversized.status === 413, 'photo over 5 MB → 413');

  // Replacement: different extension → previous stored file must be removed.
  const replace = await api('POST', '/technician/photo', {
    token: techA.token,
    form: uploadForm({}, 'profile.jpg', TINY_JPEG, 'image/jpeg'),
  });
  assert(replace.status === 201, 'photo replacement → 201');
  const photo2 = await api('GET', `/technicians/${techAProfileId}/photo`);
  assert(photo2.contentType.includes('image/jpeg'), 'replacement is served (jpeg)');
  const profileDir = path.join(STORAGE_ROOT, 'profiles');
  const leftovers = fs.existsSync(profileDir)
    ? fs.readdirSync(profileDir).filter((name) => name.startsWith(techAProfileId))
    : [];
  assert(leftovers.length === 1 && leftovers[0].endsWith('.jpg'), 'replaced photo leaves exactly one stored file');

  const noPhoto = await api('GET', `/technicians/${seedTechnicianId}/photo`);
  assert(noPhoto.status === 404, 'technician without a photo → 404 (not an error page)');

  const customerUpload = await api('POST', '/technician/photo', {
    token: customer.token,
    form: uploadForm({}, 'profile.png', TINY_PNG, 'image/png'),
  });
  assert(customerUpload.status === 403, 'customer cannot upload a technician photo → 403');
}

async function testDocuments(sessions: {
  admin: Session;
  techA: Session;
  techB: Session;
  customer: Session;
}): Promise<void> {
  console.log('\nverification documents: upload, visibility, withdrawal');

  const { admin, techA, techB, customer } = sessions;

  const upload = await api('POST', '/technician/verification/documents', {
    token: techA.token,
    form: uploadForm({ documentType: 'national_id' }, 'id-card.png', TINY_PNG, 'image/png'),
  });
  assert(upload.status === 201, 'national_id document upload → 201');
  docA1Id = upload.body?.data?.id as string;
  assert(
    upload.body?.data?.documentType === 'national_id' &&
      upload.body?.data?.contentType === 'image/png' &&
      upload.body?.data?.sizeBytes === TINY_PNG.length &&
      typeof upload.body?.data?.fileName === 'string',
    'document metadata persisted (type, mime, size, sanitized name)',
  );
  assert(
    !upload.text.includes('storage_key') && !upload.text.includes('var') && !upload.text.includes('uploads'),
    'document payload never leaks storage internals',
  );

  const cert = await api('POST', '/technician/verification/documents', {
    token: techA.token,
    form: uploadForm({ documentType: 'certificate' }, 'trade-cert.pdf', TINY_PDF, 'application/pdf'),
  });
  assert(cert.status === 201 && cert.body?.data?.documentType === 'certificate', 'certificate PDF upload → 201');
  docA2Id = cert.body?.data?.id as string;

  const badType = await api('POST', '/technician/verification/documents', {
    token: techA.token,
    form: uploadForm({ documentType: 'passport_scan' }, 'p.png', TINY_PNG, 'image/png'),
  });
  assert(badType.status === 400, 'unknown documentType → 400');

  const wrongMime = await api('POST', '/technician/verification/documents', {
    token: techA.token,
    form: uploadForm({ documentType: 'national_id' }, 'evil.txt', Buffer.from('nope'), 'text/plain'),
  });
  assert(wrongMime.status === 415, 'text upload as a document → 415');

  const own = await api('GET', '/technician/profile', { token: techA.token });
  assert(own.body?.data?.documents?.length === 2, 'own profile lists both documents');

  const ownerFile = await api('GET', `/verification-documents/${docA1Id}/file`, { token: techA.token });
  assert(ownerFile.status === 200 && ownerFile.bytes.equals(TINY_PNG), 'owner downloads own document');
  const adminFile = await api('GET', `/verification-documents/${docA1Id}/file`, { token: admin.token });
  assert(adminFile.status === 200 && adminFile.bytes.equals(TINY_PNG), 'administrator downloads for review');
  const otherFile = await api('GET', `/verification-documents/${docA1Id}/file`, { token: techB.token });
  assert(otherFile.status === 404, 'another technician → 404 (existence hidden, no IDOR)');
  const customerFile = await api('GET', `/verification-documents/${docA1Id}/file`, { token: customer.token });
  assert(customerFile.status === 404, 'customer → 404 (documents are never public)');
  const anonFile = await api('GET', `/verification-documents/${docA1Id}/file`);
  assert(anonFile.status === 401, 'anonymous → 401');

  const otherDelete = await api('DELETE', `/technician/verification/documents/${docA1Id}`, { token: techB.token });
  assert(otherDelete.status === 404, "another technician cannot withdraw the document (404)");

  const withdrawn = await api('DELETE', `/technician/verification/documents/${docA2Id}`, { token: techA.token });
  assert(withdrawn.status === 200 && withdrawn.body?.data?.deleted === true, 'owner withdraws a document pre-submission');
  const afterWithdraw = await api('GET', '/technician/profile', { token: techA.token });
  assert(afterWithdraw.body?.data?.documents?.length === 1, 'withdrawn document disappears from the list');
}

async function testVerificationLifecycle(sessions: {
  admin: Session;
  techA: Session;
}): Promise<void> {
  console.log('\nverification lifecycle: unverified → pending → rejected → pending → verified');

  const { admin, techA } = sessions;

  // Make the technician unavailable BEFORE approval to prove approval never forces availability (§9).
  await api('PATCH', '/technician/profile', { token: techA.token, body: { availabilityStatus: 'unavailable' } });

  const earlyDecision = await api('PATCH', `/admin/technicians/${techAProfileId}/verification`, {
    token: admin.token,
    body: { decision: 'verified' },
  });
  assert(earlyDecision.status === 409, 'admin cannot approve an unverified (never-submitted) technician → 409');

  const submit = await api('POST', '/technician/verification/submit', { token: techA.token });
  assert(submit.status === 200 && submit.body?.data?.verificationStatus === 'pending', 'submit → pending');

  const pendingProfile = await api('GET', '/technician/profile', { token: techA.token });
  assert(
    pendingProfile.body?.data?.verificationStatus === 'pending' &&
      typeof pendingProfile.body?.data?.verificationSubmittedAt === 'string',
    'pending state + submission timestamp persisted',
  );

  const resubmit = await api('POST', '/technician/verification/submit', { token: techA.token });
  assert(resubmit.status === 409, 'submit while pending → 409 (no arbitrary transitions)');
  const uploadWhilePending = await api('POST', '/technician/verification/documents', {
    token: techA.token,
    form: uploadForm({ documentType: 'certificate' }, 'c.pdf', TINY_PDF, 'application/pdf'),
  });
  assert(uploadWhilePending.status === 409, 'upload while pending → 409');
  const deleteWhilePending = await api('DELETE', `/technician/verification/documents/${docA1Id}`, { token: techA.token });
  assert(deleteWhilePending.status === 409, 'withdraw while pending → 409');

  const bundle = await api('GET', `/admin/technicians/${techAProfileId}/verification`, { token: admin.token });
  assert(
    bundle.status === 200 &&
      bundle.body?.data?.verificationStatus === 'pending' &&
      bundle.body?.data?.documents?.length === 1 &&
      bundle.body?.data?.userEmail === EMAIL_A &&
      !bundle.text.includes('storage_key'),
    'admin review bundle: pending state, one document, linked account, no storage keys',
  );

  const reasonless = await api('PATCH', `/admin/technicians/${techAProfileId}/verification`, {
    token: admin.token,
    body: { decision: 'rejected' },
  });
  assert(reasonless.status === 400, 'rejection without a reason → 400');

  const rejected = await api('PATCH', `/admin/technicians/${techAProfileId}/verification`, {
    token: admin.token,
    body: { decision: 'rejected', reason: 'National ID photo is unreadable — please upload a clearer scan.' },
  });
  assert(
    rejected.status === 200 &&
      rejected.body?.data?.verificationStatus === 'rejected' &&
      rejected.body?.data?.verified === false &&
      rejected.body?.data?.verificationRejectionReason.includes('unreadable') &&
      rejected.body?.data?.verificationReviewerEmail === ADMIN_EMAIL &&
      typeof rejected.body?.data?.verificationReviewedAt === 'string',
    'admin rejects with reason → rejected + reviewer metadata',
  );

  const techSees = await api('GET', '/technician/profile', { token: techA.token });
  assert(
    techSees.body?.data?.verificationStatus === 'rejected' &&
      techSees.body?.data?.verificationRejectionReason.includes('unreadable'),
    'technician sees the correction feedback',
  );

  // Correction + resubmission: rejected → pending.
  const reupload = await api('POST', '/technician/verification/documents', {
    token: techA.token,
    form: uploadForm({ documentType: 'certificate' }, 'clearer-scan.png', TINY_PNG, 'image/png'),
  });
  assert(reupload.status === 201, 'rejected technician may upload corrections');
  const resubmit2 = await api('POST', '/technician/verification/submit', { token: techA.token });
  assert(resubmit2.status === 200 && resubmit2.body?.data?.verificationStatus === 'pending', 'rejected → pending (resubmit)');

  const approved = await api('PATCH', `/admin/technicians/${techAProfileId}/verification`, {
    token: admin.token,
    body: { decision: 'verified' },
  });
  assert(
    approved.status === 200 &&
      approved.body?.data?.verificationStatus === 'verified' &&
      approved.body?.data?.verified === true &&
      approved.body?.data?.verificationRejectionReason === null,
    'admin approves → verified (boolean + lifecycle consistent, reason cleared)',
  );

  const afterApprove = await api('GET', '/technician/profile', { token: techA.token });
  assert(
    afterApprove.body?.data?.availabilityStatus === 'unavailable' &&
      afterApprove.body?.data?.accountStatus === 'active' &&
      afterApprove.body?.data?.verificationStatus === 'verified',
    'approval does NOT force availability or touch account status (verified + unavailable is valid)',
  );

  const submitVerified = await api('POST', '/technician/verification/submit', { token: techA.token });
  assert(submitVerified.status === 409, 'submit after verified → 409 (terminal state)');
  const redecide = await api('PATCH', `/admin/technicians/${techAProfileId}/verification`, {
    token: admin.token,
    body: { decision: 'rejected', reason: 'Trying to reverse a decision should fail.' },
  });
  assert(redecide.status === 409, 'admin cannot re-review a non-pending verification → 409');

  const publicRow = await api('GET', `/technicians/${techAProfileId}`);
  assert(
    publicRow.body?.data?.verified === true && publicRow.body?.data?.availabilityStatus === 'unavailable',
    'public dispatch input: verified=true while availability stays unavailable',
  );
}

async function testActivationIndependence(sessions: {
  admin: Session;
  techA: Session;
}): Promise<void> {
  console.log('\nactivation separation: account status × verification × availability');

  const { admin, techA } = sessions;

  const suspended = await api('PATCH', `/admin/users/${sessions.techA.userId}/status`, {
    token: admin.token,
    body: { accountStatus: 'suspended' },
  });
  assert(suspended.status === 200, 'Task 25 account suspension → 200');

  const gatedProfile = await api('GET', '/technician/profile', { token: techA.token });
  assert(gatedProfile.status === 401, 'suspended account loses API access immediately (requireAuth is DB-authoritative)');

  const flags = await query<{ verified: boolean; verification_status: string; account_status: string; availability_status: string }>(
    'SELECT verified, verification_status, account_status, availability_status FROM technicians WHERE id = $1',
    [techAProfileId],
  );
  assert(
    flags[0].verified === true && flags[0].verification_status === 'verified',
    'suspension does not un-verify the technician',
  );
  assert(
    flags[0].account_status === 'suspended' && flags[0].availability_status === 'unavailable',
    'Task 25 profile sync still applies (suspended); availability untouched by everything',
  );

  await api('PATCH', `/admin/users/${sessions.techA.userId}/status`, {
    token: admin.token,
    body: { accountStatus: 'active' },
  });
  const restored = await api('GET', '/technician/profile', { token: techA.token });
  assert(restored.status === 200, 'reactivation restores access');

  const availability = await api('PATCH', '/technician/profile', { token: techA.token, body: { availabilityStatus: 'available' } });
  assert(
    availability.status === 200 && availability.body?.data?.availabilityStatus === 'available',
    'availability remains separately editable after verification (verified + available now dispatch-eligible)',
  );
}

async function testDispatchEligibilityData(customer: Session): Promise<void> {
  console.log('\ndispatch eligibility inputs (public data the filter consumes)');

  const list = await api('GET', '/technicians', { token: customer.token });
  assert(list.status === 200 && Array.isArray(list.body?.data), 'public technician list → 200');
  const rows = list.body?.data as any[];

  const fixture = rows.find((row) => row.id === techAProfileId);
  assert(
    fixture !== undefined &&
      fixture.verified === true &&
      fixture.accountStatus === 'active' &&
      fixture.availabilityStatus === 'available' &&
      fixture.category === 'Electrical' &&
      fixture.serviceArea === 'Ndola',
    'verified + active + available technician exposes eligible flags (category/city rules intact)',
  );

  assert(
    rows.every((row) => typeof row.verified === 'boolean'),
    'every row carries the verified flag the eligibility filter requires',
  );
  assert(rows.length === 11, 'list = 9 seed prototypes + 2 fixture technicians');
  const unverifiedFlags = rows.filter((row) => row.verified === false).map((row) => row.name);
  assert(
    JSON.stringify([...unverifiedFlags].sort()) ===
      JSON.stringify(['Beatrice Ndlovu', 'Mulenga P.', 'Mumba J.', 'Nkonde R.']),
    'unverified = the 3 documented seeds + never-submitted technician B (verification is the only new gate)',
  );
}

async function testSeedBundle(admin: Session): Promise<void> {
  console.log('\nbackfill + seed prototype verification view');

  const bundle = await api('GET', `/admin/technicians/${seedTechnicianId}/verification`, { token: admin.token });
  assert(
    bundle.status === 200 &&
      bundle.body?.data?.verificationStatus === 'verified' &&
      bundle.body?.data?.userEmail === null &&
      Array.isArray(bundle.body?.data?.documents) &&
      bundle.body.data.documents.length === 0,
    'backfilled seed prototype shows verified + no account + no documents',
  );
  const decision = await api('PATCH', `/admin/technicians/${seedTechnicianId}/verification`, {
    token: admin.token,
    body: { decision: 'verified' },
  });
  assert(decision.status === 409, 'seed prototype is not pending → admin decision 409 (lifecycle applies to submissions)');

  const unverifiedSeed = await query<{ id: string }>(
    'SELECT id FROM technicians WHERE user_id IS NULL AND verified = false LIMIT 1',
  );
  const unverifiedBundle = await api('GET', `/admin/technicians/${unverifiedSeed[0].id}/verification`, {
    token: admin.token,
  });
  assert(
    unverifiedBundle.status === 200 &&
      unverifiedBundle.body?.data?.verificationStatus === 'unverified' &&
      unverifiedBundle.body?.data?.verified === false,
    'non-backfilled seed prototype shows unverified (boolean + lifecycle consistent)',
  );
}

async function testMissingRecords(admin: Session, techA: Session, techB: Session): Promise<void> {
  console.log('\nmissing records + malformed ids');

  const ghost = crypto.randomUUID();
  assert(
    (await api('GET', `/admin/technicians/${ghost}/verification`, { token: admin.token })).status === 404,
    'admin bundle for unknown technician → 404',
  );
  assert(
    (await api('GET', '/admin/technicians/not-a-uuid/verification', { token: admin.token })).status === 400,
    'malformed technician id → 400 (not 500)',
  );
  assert(
    (await api('PATCH', `/admin/technicians/${ghost}/verification`, { token: admin.token, body: { decision: 'verified' } })).status === 404,
    'decision for unknown technician → 404',
  );
  assert(
    (await api('GET', `/verification-documents/${ghost}/file`, { token: techA.token })).status === 404,
    'unknown document → 404',
  );
  assert(
    (await api('DELETE', `/technician/verification/documents/${ghost}`, { token: techB.token })).status === 404,
    'withdraw unknown document → 404 (unverified technician, editable state)',
  );
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

async function cleanup(): Promise<void> {
  console.log('\ncleanup — restoring the baseline (seeded admin preserved)');
  // Task 28.2D: verification submit/decision hooks record in_app
  // notifications — remove them alongside the fixture rows they reference.
  await query(`DELETE FROM notifications`);
  const keys = await query<{ storage_key: string }>(
    `SELECT storage_key FROM technician_verification_documents WHERE technician_id IN
       (SELECT id FROM technicians WHERE user_id IN
         (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test'))`,
  );
  const photoKeys = await query<{ photo_key: string }>(
    `SELECT photo_key FROM technicians WHERE user_id IN
       (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test') AND photo_key IS NOT NULL`,
  );
  await query(
    `DELETE FROM technician_verification_documents WHERE technician_id IN
       (SELECT id FROM technicians WHERE user_id IN
         (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test'))`,
  );
  await query(
    `DELETE FROM technicians WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test')`,
  );
  await query(`DELETE FROM sessions`);
  await query(
    `DELETE FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const allKeys = [...keys.map((row) => row.storage_key), ...photoKeys.map((row) => row.photo_key)];
  let removedFiles = 0;
  for (const storageKey of allKeys) {
    // Windows AV/indexers can hold a brand-new file briefly — retry a few
    // times before giving up (the assertion below keeps this honest).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(path.join(STORAGE_ROOT, storageKey), { force: true });
        removedFiles += 1;
        break;
      } catch {
        await sleep(200);
      }
    }
  }
  // Remove now-empty per-technician directories and the root subdirs.
  for (const sub of ['verification', 'profiles']) {
    const root = path.join(STORAGE_ROOT, sub);
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        const full = path.join(root, entry);
        try {
          if (fs.statSync(full).isDirectory() && fs.readdirSync(full).length === 0) {
            fs.rmdirSync(full);
          }
        } catch {
          /* best effort */
        }
      }
      try {
        if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
      } catch {
        /* best effort */
      }
    }
  }

  const users = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );
  const techs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM technicians');
  const docs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM technician_verification_documents');
  const sessions = await query<{ n: string }>('SELECT COUNT(*) AS n FROM sessions');
  const admin = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM users WHERE lower(email) = lower($1)',
    [ADMIN_EMAIL as string],
  );
  const requests = await query<{ n: string }>('SELECT COUNT(*) AS n FROM service_requests');
  const offers = await query<{ n: string }>('SELECT COUNT(*) AS n FROM dispatch_offers');

  assert(Number(users[0].n) === 0, 'no fixture accounts remain');
  assert(Number(techs[0].n) === 9, 'technicians back to the 9 seed prototypes');
  assert(Number(docs[0].n) === 0, 'no verification documents remain');
  assert(Number(sessions[0].n) === 0, 'no sessions remain');
  assert(Number(admin[0].n) === 1, 'seeded administrator preserved');
  assert(Number(requests[0].n) === 0 && Number(offers[0].n) === 0, 'no requests/offers touched');
  assert(removedFiles === allKeys.length, 'every uploaded fixture file removed from storage');
  assert(loginCount === 4, `suite issued exactly 4 logins (saw ${loginCount})`);
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const sessions = await createFixtures();
  await testAuthenticationMatrix(sessions);
  await testProfile(sessions.techA);
  await testPhoto(sessions.techA, sessions.customer);
  await testDocuments(sessions);
  await testVerificationLifecycle(sessions);
  await testActivationIndependence(sessions);
  await testDispatchEligibilityData(sessions.customer);
  await testSeedBundle(sessions.admin);
  await testMissingRecords(sessions.admin, sessions.techA, sessions.techB);
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
