/**
 * Task 28.2D5 tests: verification notifications (submit → administrators;
 * admin decision → technician) against a RUNNING backend (start it first)
 * backed by the LOCAL scratch database — never Supabase.
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *   $env:ADMIN_EMAIL='admin@umodzi.test'
 *   $env:ADMIN_PASSWORD='…'
 *   npx tsx scripts/task28-verification-notification-tests.ts
 *
 * Covers:
 *   Submit — 200 fans out exactly one notification to every
 *     active administrator (technician_verification_submitted, reference
 *     technician/profile id); resubmit-while-pending stays 409 with no
 *     second row; the test backend runs VAPID-stripped with no
 *     subscriptions, so inline D6 delivery honestly resolves rows to
 *     failed + recorded reason;
 *   Decision — approve → technician_verification_approved for the linked
 *     account; reject → technician_verification_rejected carrying the
 *     reason; repeated/invalid decisions create nothing;
 *   Safety — NULL technician.user_id skips without failing the decision;
 *     cross-technician isolation; authorization (401/403) intact;
 *     no success evidence anywhere (no push acceptance, no SMS pass).
 *   Cleanup — baseline restored (seeded admin preserved).
 *
 * Exactly 3 successful logins, zero failed logins (rate-budget discipline).
 */

import { query } from '../src/db/client.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  opts: { token?: string; body?: unknown; form?: FormData } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let payload: BodyInit | undefined;
  if (opts.form !== undefined) {
    payload = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
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
const PASSWORD = 'Task28VerifyD5!42';
const EMAIL_A = `verify-a-282d5-${RUN}@umodzi.test`;
const EMAIL_B = `verify-b-282d5-${RUN}@umodzi.test`;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function uploadForm(fields: Record<string, string>, fileName: string, bytes: Buffer, mime: string): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  form.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), fileName);
  return form;
}

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
  techA: Session;
  techB: Session;
  techAProfileId: string;
  techBProfileId: string;
}

const fixtureTechIds: string[] = [];

async function createFixtures(): Promise<Sessions> {
  console.log('\nfixtures: 2 technicians + admin session');

  for (const [email, firstName, lastName] of [
    [EMAIL_A, 'Bwalya', 'Kasonde'],
    [EMAIL_B, 'Chanda', 'Mushiba'],
  ] as const) {
    const res = await api('POST', '/auth/register', {
      body: {
        email,
        password: PASSWORD,
        firstName,
        lastName,
        role: 'technician',
        category: 'Electrical',
        serviceArea: 'Kitwe',
      },
    });
    assert(res.status === 201, `registration ${email} → 201`);
  }

  const admin = sessionFrom(await login(ADMIN_EMAIL as string, ADMIN_PASSWORD as string));
  const techA = sessionFrom(await login(EMAIL_A, PASSWORD));
  const techB = sessionFrom(await login(EMAIL_B, PASSWORD));
  assert(Boolean(admin.token && techA.token && techB.token), 'all three sessions issued');

  const meA = await api('GET', '/auth/me', { token: techA.token });
  const techAProfileId = meA.body?.data?.user?.technicianId as string;
  const meB = await api('GET', '/auth/me', { token: techB.token });
  const techBProfileId = meB.body?.data?.user?.technicianId as string;
  assert(
    typeof techAProfileId === 'string' && typeof techBProfileId === 'string',
    'technician profiles linked',
  );
  fixtureTechIds.push(techAProfileId, techBProfileId);

  const doc = await api('POST', '/technician/verification/documents', {
    token: techA.token,
    form: uploadForm({ documentType: 'national_id' }, 'id-card.png', TINY_PNG, 'image/png'),
  });
  assert(doc.status === 201, 'national_id document uploaded');

  return { admin, techA, techB, techAProfileId, techBProfileId };
}

async function notificationsForTechnician(techId: string) {
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
    [techId],
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

async function testSubmit(s: Sessions): Promise<void> {
  console.log('\nsubmit → administrators');

  const res = await api('POST', '/technician/verification/submit', { token: s.techA.token });
  assert(res.status === 200, 'submit → 200');

  const admins = await query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'administrator' AND account_status = 'active'`,
  );
  assert(admins.length >= 1, 'at least one active administrator exists');
  for (const admin of admins) {
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM notifications
       WHERE user_id = $1 AND type = 'technician_verification_submitted' AND reference_id = $2`,
      [admin.id, s.techAProfileId],
    );
    assert(Number(rows[0].n) === 1, 'each active admin gets exactly one submitted notification');
  }
  const submitted = await query<{
    title: string;
    channel: string;
    status: string;
    reference_type: string;
    failure_reason: string | null;
  }>(
    `SELECT title, channel, status, reference_type, failure_reason FROM notifications
     WHERE type = 'technician_verification_submitted' AND reference_id = $1 LIMIT 1`,
    [s.techAProfileId],
  );
  assert(
    submitted[0].title === 'New verification submission' &&
      submitted[0].channel === 'in_app' &&
      submitted[0].reference_type === 'technician',
    'submitted contract: title/channel/technician reference',
  );
  assertResolvedHonestly(submitted[0]);
  const submittedMsg = await query<{ message: string }>(
    `SELECT message FROM notifications
     WHERE type = 'technician_verification_submitted' AND reference_id = $1 LIMIT 1`,
    [s.techAProfileId],
  );
  assert(
    submittedMsg[0].message === 'Bwalya Kasonde submitted verification for review.',
    'submitted message names the technician for the admin reviewer',
  );

  // Resubmit while pending: 409, no second row for anyone.
  const again = await api('POST', '/technician/verification/submit', { token: s.techA.token });
  assert(again.status === 409, 'resubmit while pending → 409');
  const total = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM notifications WHERE type = 'technician_verification_submitted' AND reference_id = $1`,
    [s.techAProfileId],
  );
  assert(Number(total[0].n) === admins.length, 'resubmit creates no duplicate rows');
}

async function testReject(s: Sessions): Promise<void> {
  console.log('\nreject → technician');

  const REASON = 'The ID photo is too blurry to read, please re-upload it clearly';
  const res = await api('PATCH', `/admin/technicians/${s.techAProfileId}/verification`, {
    token: s.admin.token,
    body: { decision: 'rejected', reason: REASON },
  });
  assert(res.status === 200, 'reject with reason → 200');

  const rows = await notificationsForTechnician(s.techAProfileId);
  const rejected = rows.filter((r) => r.type === 'technician_verification_rejected');
  assert(rejected.length === 1, 'exactly one rejected notification');
  assert(rejected[0].user_id === s.techA.userId, 'recipient is the linked technician account');
  assert(
    rejected[0].title === 'Verification rejected' &&
      rejected[0].channel === 'in_app' &&
      rejected[0].reference_type === 'technician' &&
      rejected[0].reference_id === s.techAProfileId,
    'rejected contract matches',
  );
  assertResolvedHonestly(rejected[0]);
  assert(rejected[0].message.includes(REASON), 'rejection reason carried in the message');

  // Decision on a non-pending verification: 409, no duplicate.
  const again = await api('PATCH', `/admin/technicians/${s.techAProfileId}/verification`, {
    token: s.admin.token,
    body: { decision: 'rejected', reason: REASON },
  });
  assert(again.status === 409, 'second decision on rejected → 409');
  const after = await notificationsForTechnician(s.techAProfileId);
  assert(
    after.filter((r) => r.type === 'technician_verification_rejected').length === 1,
    'repeated decision creates no duplicate',
  );

  // Invalid decision: 400, nothing recorded.
  const bad = await api('PATCH', `/admin/technicians/${s.techAProfileId}/verification`, {
    token: s.admin.token,
    body: { decision: 'rejected' },
  });
  assert(bad.status === 400, 'reject without reason → 400');
}

async function testApprove(s: Sessions): Promise<void> {
  console.log('\napprove → technician (+ resubmit path)');

  // rejected → pending resubmission notifies admins again via dedupe
  // (same natural key → existing row, still exactly one per admin).
  const resubmit = await api('POST', '/technician/verification/submit', {
    token: s.techA.token,
  });
  assert(resubmit.status === 200, 'resubmit after rejection → 200');
  const submitted = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM notifications
     WHERE type = 'technician_verification_submitted' AND reference_id = $1`,
    [s.techAProfileId],
  );
  const admins = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'administrator' AND account_status = 'active'`,
  );
  assert(
    Number(submitted[0].n) === Number(admins[0].n),
    'resubmit dedupes to one row per admin (no duplicates)',
  );

  const res = await api('PATCH', `/admin/technicians/${s.techAProfileId}/verification`, {
    token: s.admin.token,
    body: { decision: 'verified' },
  });
  assert(res.status === 200, 'approve → 200');

  const rows = await notificationsForTechnician(s.techAProfileId);
  const approved = rows.filter((r) => r.type === 'technician_verification_approved');
  assert(approved.length === 1, 'exactly one approved notification');
  assert(approved[0].user_id === s.techA.userId, 'recipient is the linked technician account');
  assert(
    approved[0].title === 'Verification approved' &&
      approved[0].channel === 'in_app',
    'approved contract matches',
  );
  assertResolvedHonestly(approved[0]);

  // Approve on verified (non-pending): 409, no duplicate.
  const again = await api('PATCH', `/admin/technicians/${s.techAProfileId}/verification`, {
    token: s.admin.token,
    body: { decision: 'verified' },
  });
  assert(again.status === 409, 'approve on verified → 409');
  const after = await notificationsForTechnician(s.techAProfileId);
  assert(
    after.filter((r) => r.type === 'technician_verification_approved').length === 1,
    'repeated approval creates no duplicate',
  );
}

async function testIsolationAndNull(s: Sessions): Promise<void> {
  console.log('\nisolation, NULL recipient, authorization, silence');

  // Tech B never submitted and was never decided: zero verification rows.
  const bRows = await notificationsForTechnician(s.techBProfileId);
  assert(bRows.length === 0, 'unrelated technician receives nothing');

  // NULL linked account: upload + submit while linked, then unlink and
  // decide — the decision still succeeds but records no notification.
  const doc = await api('POST', '/technician/verification/documents', {
    token: s.techB.token,
    form: uploadForm({ documentType: 'national_id' }, 'id2.png', TINY_PNG, 'image/png'),
  });
  assert(doc.status === 201, 'techB doc upload → 201');
  const submit = await api('POST', '/technician/verification/submit', { token: s.techB.token });
  assert(submit.status === 200, 'techB submit → 200');
  await query(`UPDATE technicians SET user_id = NULL WHERE id = $1`, [s.techBProfileId]);
  const decide = await api('PATCH', `/admin/technicians/${s.techBProfileId}/verification`, {
    token: s.admin.token,
    body: { decision: 'verified' },
  });
  assert(decide.status === 200, 'decision on unlinked tech → 200 (not broken)');
  const nullRows = await notificationsForTechnician(s.techBProfileId);
  assert(
    nullRows.filter((r) => r.type === 'technician_verification_approved').length === 0,
    'NULL user_id produces no approval row',
  );
  await query(`UPDATE technicians SET user_id = $1 WHERE id = $2`, [s.techB.userId, s.techBProfileId]);

  // Authorization intact.
  const custReg = await api('POST', '/auth/register', {
    body: {
      email: `verify-c-282d5-${RUN}@umodzi.test`,
      password: 'VerifyCust!42d5',
      firstName: 'Verify',
      lastName: 'Cust',
      role: 'customer',
    },
  });
  assert(custReg.status === 201, 'witness customer registered');
  const custLogin = await login(`verify-c-282d5-${RUN}@umodzi.test`, 'VerifyCust!42d5');
  const custToken = (custLogin.body?.data?.accessToken as string) ?? '';
  const custSubmit = await api('POST', '/technician/verification/submit', { token: custToken });
  assert(custSubmit.status === 403, 'customer submit → 403');
  const techDecide = await api('PATCH', `/admin/technicians/${s.techAProfileId}/verification`, {
    token: s.techA.token,
    body: { decision: 'verified' },
  });
  assert(techDecide.status === 403, 'technician decision → 403');
  const anonDecide = await api('PATCH', `/admin/technicians/${s.techAProfileId}/verification`, {
    body: { decision: 'verified' },
  });
  assert(anonDecide.status === 401, 'anonymous decision → 401');

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
  // Submitted-notifications are addressed to the (preserved) admin, so they
  // need an explicit delete — user CASCADE alone would leave them behind.
  await query(`DELETE FROM notifications`);
  await query(`DELETE FROM technician_verification_documents WHERE technician_id IN
    (SELECT t.id FROM technicians t JOIN users u ON u.id = t.user_id WHERE lower(u.email) LIKE '%@umodzi.test')`);
  await query(
    `DELETE FROM technicians WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test')`,
  );
  await query(`DELETE FROM sessions`);
  await query(
    `DELETE FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );

  const notifs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  const docs = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM technician_verification_documents',
  );
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
  assert(Number(docs[0].n) === 0, 'no verification documents remain');
  assert(Number(users[0].n) === 0, 'no fixture accounts remain');
  assert(Number(techs[0].n) === 9, 'technicians back to the 9 seed prototypes');
  assert(Number(sessions[0].n) === 0, 'no sessions remain');
  assert(Number(admin[0].n) === 1, 'seeded administrator preserved');
  assert(loginCount === 4, `suite issued exactly 4 logins (saw ${loginCount})`);

  // Uploaded fixture files live outside the DB — remove this run's dirs.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uploadsRoot = path.join(here, '..', 'var', 'uploads', 'verification');
  let leftoverFiles = 0;
  for (const techId of fixtureTechIds) {
    const dir = path.join(uploadsRoot, techId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  try {
    for (const entry of fs.readdirSync(uploadsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        leftoverFiles += 1;
      }
    }
  } catch {
    /* no uploads dir is fine */
  }
  assert(leftoverFiles === 0, 'no stray files at the uploads root');
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const sessions = await createFixtures();
  await testSubmit(sessions);
  await testReject(sessions);
  await testApprove(sessions);
  await testIsolationAndNull(sessions);
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
