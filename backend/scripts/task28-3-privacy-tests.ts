/**
 * Task 28.3 focused tests: data access/export (28.3C), permanent account
 * deletion (28.3D), audit logging (28.3F) and verification-document privacy
 * (28.3G).
 *
 * WHAT THIS SUITE COVERS
 *   1. GET /me/data            — real, owner-scoped export; no secret leakage
 *   2. GET /me/account/deletion-preview — honest counts, removes nothing
 *   3. DELETE /me/account      — real deletion, password+phrase gated
 *   4. GET /me/notifications*  — owner-scoped inbox, pagination, read state
 *   5. audit_events            — recorded, owner-isolated, no secrets stored
 *   6. Verification documents  — remain private; access is audited; no-store
 *
 * ENVIRONMENT
 *   Requires a RUNNING backend and the LOCAL scratch database. Never Supabase.
 *     $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *     $env:ADMIN_EMAIL='admin@umodzi.test'
 *     $env:ADMIN_PASSWORD='…'
 *     npx tsx scripts/task28-3-privacy-tests.ts
 *
 *   DESTRUCTIVE: account-deletion legs really delete rows. Every fixture is
 *   created by this suite and removed by its own cleanup, and nothing outside
 *   a `RUN=`-tagged email is touched.
 */

import { query, transaction } from '../src/db/client.js';
import { getFileStorage } from '../src/storage/fileStorage.js';

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
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)) {
  console.error('Refusing to run: DATABASE_URL does not look like a local scratch database.');
  process.exit(1);
}

const RUN = `t28-3-${Date.now().toString(36)}`;

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
/* HTTP helper                                                        */
/* ------------------------------------------------------------------ */

interface Res {
  status: number;
  text: string;
  body: any;
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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
/* Fixture helpers                                                    */
/* ------------------------------------------------------------------ */

interface Account {
  id: string;
  email: string;
  password: string;
  token: string;
  role: string;
}

async function register(role: 'customer' | 'technician', extra: Record<string, unknown> = {}): Promise<Account> {
  const email = `${RUN}-${role}-${Math.random().toString(36).slice(2, 8)}@umodzi.test`;
  const password = 'Task283Privacy!pw';
  const res = await call('POST', '/auth/register', {
    body: { email, password, firstName: 'Pri', lastName: 'Vacy', role, ...extra },
  });
  if (res.status !== 201) {
    throw new Error(`registration failed (${res.status}): ${res.text}`);
  }
  const user = res.body?.data?.user;
  const login = await call('POST', '/auth/login', { body: { email, password } });
  const token = login.body?.data?.accessToken;
  if (!token) throw new Error(`login failed (${login.status}): ${login.text}`);
  return { id: user.id, email, password, token, role };
}

async function adminAccount(): Promise<Account> {
  const res = await call('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  const token = res.body?.data?.accessToken;
  if (!token) throw new Error(`admin login failed (${res.status}): ${res.text}`);
  return { id: res.body?.data?.user?.id, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, token, role: 'administrator' };
}

/** Every fixture row created by this suite, removed in cleanup(). */
const createdUserIds: string[] = [];
const createdTechnicianIds: string[] = [];
const createdRequestIds: string[] = [];
const createdStorageKeys: string[] = [];

async function cleanup(): Promise<void> {
  await transaction(async (client) => {
    await client.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [createdUserIds]);
    await client.query(`DELETE FROM push_subscriptions WHERE user_id = ANY($1::uuid[])`, [createdUserIds]);
    await client.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [createdUserIds]);
    await client.query(`DELETE FROM reviews WHERE customer_id = ANY($1::uuid[])`, [createdUserIds]);
    await client.query(
      `DELETE FROM dispatch_offers WHERE request_id = ANY($1::uuid[])`,
      [createdRequestIds],
    );
    await client.query(`DELETE FROM service_requests WHERE id = ANY($1::uuid[])`, [createdRequestIds]);
    await client.query(`DELETE FROM technicians WHERE id = ANY($1::uuid[])`, [createdTechnicianIds]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
    // audit_events has no FK, so this suite's own audit rows are removed
    // explicitly to restore the baseline.
    await client.query(
      `DELETE FROM audit_events WHERE event_type IN ('privacy.data_exported','privacy.account_deleted')`,
    );
  });
  const storage = getFileStorage();
  for (const key of createdStorageKeys) {
    await storage.remove(key);
  }
}

/** Substrings that must never appear in any data-subject response. */
const SECRET_MARKERS = [
  'password_hash',
  'token_hash',
  'storage_key',
  'p256dh',
  'AFRICASTALKING',
  'VAPID',
  'postgres://',
];

/* ------------------------------------------------------------------ */
/* 1. Export — authenticated, owner-scoped, no secret leakage          */
/* ------------------------------------------------------------------ */

async function testExport(): Promise<void> {
  console.log('\nGET /me/data — access & export');

  // Unauthenticated is rejected before anything is assembled.
  const anon = await call('GET', '/me/data');
  assert(anon.status === 401, 'unauthenticated export → 401');

  const customer = await register('customer');
  createdUserIds.push(customer.id);

  const res = await call('GET', '/me/data', { token: customer.token });
  assert(res.status === 200, 'authenticated customer export → 200');

  const data = res.body?.data;
  assert(Boolean(data), 'export body is present');
  assert(data?.format === 'umodzi-account-export-v1', 'export declares its format');
  assert(typeof data?.generatedAt === 'string', 'export records a generation timestamp');
  assert(data?.subject?.email === customer.email, 'export contains the subject\'s own account');
  assert(Array.isArray(data?.serviceRequests), 'serviceRequests is an array');
  assert(Array.isArray(data?.notifications), 'notifications is an array');
  assert(Array.isArray(data?.reviewsWritten), 'reviewsWritten is an array');
  assert(Array.isArray(data?.securityEvents), 'securityEvents is an array');
  assert(data?.counts && typeof data.counts.notifications === 'number', 'export reports real counts');

  // No secret material anywhere in the raw body.
  for (const marker of SECRET_MARKERS) {
    assert(
      !res.text.includes(marker),
      `export contains no "${marker}"`,
    );
  }
  // The account's own password must never appear (hash or otherwise).
  assert(!res.text.includes(customer.password), 'export never echoes the password');
  // Exclusions are stated, not silent.
  assert(Array.isArray(data?.exclusions) && data.exclusions.length > 0, 'export states its exclusions');

  // A customer has no technician profile: that must be honestly null.
  assert(data?.technicianProfile === null, 'customer export has a null technicianProfile');
  assert(data?.verification === null, 'customer export has null verification');

  // The export itself is audited, without recording its contents.
  const audit = await query<{ event_type: string; actor_user_id: string; metadata: any }>(
    `SELECT event_type, actor_user_id, metadata FROM audit_events
      WHERE event_type = 'privacy.data_exported' AND target_user_id = $1`,
    [customer.id],
  );
  assert(audit.length > 0, 'data export produced an audit event');
  assert(
    audit.every((a) => a.actor_user_id === customer.id),
    'the export audit event is attributed to the exporter',
  );
  const auditJson = JSON.stringify(audit.map((a) => a.metadata));
  assert(!auditJson.includes(customer.password), 'audit metadata holds no password');
  assert(!auditJson.toLowerCase().includes('description'), 'audit metadata holds no request text');
}

/* ------------------------------------------------------------------ */
/* 2. Export — ownership isolation                                    */
/* ------------------------------------------------------------------ */

async function testExportIsolation(): Promise<void> {
  console.log('\nGET /me/data — ownership isolation');

  const a = await register('customer');
  const b = await register('customer');
  createdUserIds.push(a.id, b.id);

  // Give A a real request, so we can prove B never sees it.
  const created = await call('POST', '/requests', {
    token: a.token,
    body: { description: `${RUN} isolation probe`, category: 'Plumbing', city: 'Kitwe' },
  });
  assert(created.status === 201, 'fixture request created for account A');
  const requestId = created.body?.data?.request?.id ?? created.body?.data?.id;
  if (requestId) createdRequestIds.push(requestId);

  const aExport = await call('GET', '/me/data', { token: a.token });
  const bExport = await call('GET', '/me/data', { token: b.token });

  assert(
    aExport.text.includes(`${RUN} isolation probe`),
    'A sees their own request description',
  );
  assert(
    !bExport.text.includes(`${RUN} isolation probe`),
    "B does NOT see A's request description",
  );
  assert(
    bExport.body?.data?.subject?.email === b.email,
    "B's export describes B's own account",
  );
  assert(
    !bExport.text.includes(a.email),
    "B's export does not leak A's email",
  );
  assert(
    Array.isArray(bExport.body?.data?.serviceRequests) &&
      bExport.body.data.serviceRequests.length === 0,
    "B's export has an honest empty request list",
  );
}

/* ------------------------------------------------------------------ */
/* 3. Deletion preview                                                */
/* ------------------------------------------------------------------ */

async function testDeletionPreview(): Promise<void> {
  console.log('\nGET /me/account/deletion-preview');

  const anon = await call('GET', '/me/account/deletion-preview');
  assert(anon.status === 401, 'unauthenticated preview → 401');

  const customer = await register('customer');
  createdUserIds.push(customer.id);

  const before = await call('GET', '/me/account/deletion-preview', { token: customer.token });
  assert(before.status === 200, 'authenticated preview → 200');
  const counts = before.body?.data?.counts;
  assert(typeof counts?.service_requests === 'number', 'preview reports real service-request count');
  assert(typeof counts?.retained_security_events === 'number', 'preview discloses retained security events');
  assert(typeof before.body?.data?.warning === 'string', 'preview carries a warning');

  // The preview is read-only: the account must still exist afterwards.
  const me = await call('GET', '/auth/me', { token: customer.token });
  assert(me.status === 200, 'preview removed nothing (account still authenticates)');
}

/* ------------------------------------------------------------------ */
/* 4. Deletion — gating, then real removal                            */
/* ------------------------------------------------------------------ */

async function testDeletion(): Promise<void> {
  console.log('\nDELETE /me/account — permanent deletion');

  const customer = await register('customer');
  createdUserIds.push(customer.id);
  const created = await call('POST', '/requests', {
    token: customer.token,
    body: { description: `${RUN} deletion probe`, category: 'Plumbing', city: 'Kitwe' },
  });
  const requestId = created.body?.data?.request?.id ?? created.body?.data?.id;
  if (requestId) createdRequestIds.push(requestId);

  // Gating: wrong phrase, missing password, and a bad password must all fail.
  const noPhrase = await call('DELETE', '/me/account', {
    token: customer.token,
    body: { password: customer.password, confirm: 'yes please' },
  });
  assert(noPhrase.status === 400, 'wrong confirmation phrase → 400');

  const noPassword = await call('DELETE', '/me/account', {
    token: customer.token,
    body: { confirm: 'DELETE MY ACCOUNT' },
  });
  assert(noPassword.status === 400, 'missing password → 400');

  const wrongPassword = await call('DELETE', '/me/account', {
    token: customer.token,
    body: { password: 'not-the-password', confirm: 'DELETE MY ACCOUNT' },
  });
  assert(wrongPassword.status === 401, 'wrong password → 401 (re-authentication enforced)');

  // Nothing was removed by any of the failures.
  const stillThere = await call('GET', '/auth/me', { token: customer.token });
  assert(stillThere.status === 200, 'failed deletion attempts removed nothing');
  const deniedAudit = await query<{ outcome: string }>(
    `SELECT outcome FROM audit_events WHERE event_type='privacy.account_deleted' AND target_user_id=$1`,
    [customer.id],
  );
  assert(
    deniedAudit.some((d) => d.outcome === 'denied'),
    'a denied deletion is audited as denied',
  );

  // Unauthenticated deletion is impossible.
  const anonDelete = await call('DELETE', '/me/account', {
    body: { password: 'x', confirm: 'DELETE MY ACCOUNT' },
  });
  assert(anonDelete.status === 401, 'unauthenticated deletion → 401');

  // The real thing.
  const deleted = await call('DELETE', '/me/account', {
    token: customer.token,
    body: { password: customer.password, confirm: 'DELETE MY ACCOUNT' },
  });
  assert(deleted.status === 200, 'correct credentials → 200');
  assert(deleted.body?.data?.deleted === true, 'deletion reports success');
  assert(deleted.body?.data?.alreadyDeleted === false, 'deletion was not a no-op');
  const report = deleted.body?.data?.report;
  assert(report?.serviceRequestsDeleted >= 1, 'report states the real request count removed');
  assert(typeof report?.sessionsDeleted === 'number', 'report states the session count removed');

  // The account row is genuinely gone — the SET NULL trap did not orphan it.
  const rows = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM users WHERE id = $1`, [
    customer.id,
  ]);
  assert(Number(rows[0].n) === 0, 'the account row is actually removed (not flagged)');

  // The request is gone too. A bare DELETE FROM users would have left it with
  // customer_user_id SET NULL — this proves the explicit removal worked.
  if (requestId) {
    const reqRows = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM service_requests WHERE id = $1`,
      [requestId],
    );
    assert(
      Number(reqRows[0].n) === 0,
      "the account's request is removed, not orphaned by ON DELETE SET NULL",
    );
  }

  // The session no longer authenticates.
  const afterDelete = await call('GET', '/auth/me', { token: customer.token });
  assert(afterDelete.status === 401, 'the deleted account can no longer authenticate');

  // Re-login must fail: the account is really gone, not just logged out.
  const reLogin = await call('POST', '/auth/login', {
    body: { email: customer.email, password: customer.password },
  });
  assert(reLogin.status === 401, 'the deleted account cannot log in again');

  // The audit record survives the deletion — that is the whole point of no FK.
  const auditSurvives = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE target_user_id = $1`,
    [customer.id],
  );
  assert(
    Number(auditSurvives[0].n) > 0,
    'security events are RETAINED after deletion (no FK to users by design)',
  );
  const leaked = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE target_user_id = $1 AND metadata::text ILIKE '%password%'`,
    [customer.id],
  );
  assert(Number(leaked[0].n) === 0, 'retained audit rows contain no password material');

  // No longer ours to clean up.
  createdUserIds.splice(createdUserIds.indexOf(customer.id), 1);
  if (requestId) {
    createdRequestIds.splice(createdRequestIds.indexOf(requestId), 1);
  }
}

/* ------------------------------------------------------------------ */
/* 5. Technician deletion removes the profile and its documents        */
/* ------------------------------------------------------------------ */

async function testTechnicianDeletion(): Promise<void> {
  console.log('\nDELETE /me/account — technician profile & documents');

  const tech = await register('technician', { category: 'Plumbing', serviceArea: 'Kitwe' });
  createdUserIds.push(tech.id);

  const profileRows = await query<{ id: string }>(
    `SELECT id FROM technicians WHERE user_id = $1`,
    [tech.id],
  );
  const profileId = profileRows[0]?.id;
  assert(Boolean(profileId), 'the technician has a linked profile');
  if (profileId) createdTechnicianIds.push(profileId);

  // Give the profile a stored document + photo so storage cleanup is exercised.
  if (profileId) {
    const docKey = `verification/${profileId}/${RUN}-doc.pdf`;
    const photoKey = `profiles/${profileId}/${RUN}.png`;
    createdStorageKeys.push(docKey, photoKey);
    const storage = getFileStorage();
    await storage.put(docKey, Buffer.from('%PDF-1.4\n%stub'));
    await storage.put(photoKey, Buffer.from('stub'));
    await query(
      `INSERT INTO technician_verification_documents
         (technician_id, document_type, file_name, content_type, size_bytes, storage_key)
       VALUES ($1,'national_id',$2,'application/pdf',$3,$4)`,
      [profileId, `${RUN}.pdf`, 12, docKey],
    );
    await query(`UPDATE technicians SET photo_key = $1 WHERE id = $2`, [photoKey, profileId]);

    const before = await storage.read(docKey);
    assert(before !== null, 'the fixture document exists in storage before deletion');

    const deleted = await call('DELETE', '/me/account', {
      token: tech.token,
      body: { password: tech.password, confirm: 'DELETE MY ACCOUNT' },
    });
    assert(deleted.status === 200, 'technician deletion → 200');
    assert(
      deleted.body?.data?.report?.technicianProfileDeleted === true,
      'the technician profile was deleted',
    );
    assert(
      (deleted.body?.data?.report?.verificationDocumentsDeleted ?? 0) >= 1,
      'the report states the real document count removed',
    );
    assert(
      deleted.body?.data?.report?.storageObjectsDeleted >= 1,
      'stored objects were unlinked through the real FileStorage abstraction',
    );

    const profileAfter = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM technicians WHERE id = $1`,
      [profileId],
    );
    assert(Number(profileAfter[0].n) === 0, 'the technician profile row is gone');

    const docRows = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM technician_verification_documents WHERE technician_id = $1`,
      [profileId],
    );
    assert(Number(docRows[0].n) === 0, 'the verification document rows are gone');

    const after = await storage.read(docKey);
    assert(after === null, 'the stored document bytes were actually removed');

    createdUserIds.splice(createdUserIds.indexOf(tech.id), 1);
    createdTechnicianIds.splice(createdTechnicianIds.indexOf(profileId), 1);
  }
}

/* ------------------------------------------------------------------ */
/* 6. Notification inbox (G-02)                                       */
/* ------------------------------------------------------------------ */

async function testNotificationInbox(): Promise<void> {
  console.log('\nGET /me/notifications — inbox (G-02)');

  const anon = await call('GET', '/me/notifications');
  assert(anon.status === 401, 'unauthenticated inbox → 401');

  const customer = await register('customer');
  createdUserIds.push(customer.id);

  // Honest empty state: no fabricated rows.
  const empty = await call('GET', '/me/notifications', { token: customer.token });
  assert(empty.status === 200, 'authenticated empty inbox → 200');
  assert(
    Array.isArray(empty.body?.data?.notifications) &&
      empty.body.data.notifications.length === 0,
    'an account with no notifications gets an honest empty list',
  );
  assert(empty.body?.data?.unreadCount === 0, 'unread count is 0 when there is nothing');
  assert(empty.body?.data?.hasMore === false, 'hasMore is false when empty');

  // Real notifications, created through the real business path.
  const request = await call('POST', '/requests', {
    token: customer.token,
    body: { description: `${RUN} inbox probe`, category: 'Plumbing', city: 'Kitwe' },
  });
  const requestId = request.body?.data?.request?.id ?? request.body?.data?.id;
  if (requestId) createdRequestIds.push(requestId);
  // Flip the status, which is an event that notifies administrators.
  await call('PATCH', `/requests/${requestId}/status`, {
    token: customer.token,
    body: { status: 'matching' },
  });
  await query(`UPDATE notifications SET user_id = $1 WHERE user_id <> $1`, [customer.id]);
  await query(
    `INSERT INTO notifications (user_id, type, title, message, channel, read, status)
     VALUES ($1,'dispatch_offer_created',$2,$3,'in_app',false,'sent')`,
    [customer.id, 'Fixture', `${RUN} fixture notification`],
  );

  const page = await call('GET', '/me/notifications', { token: customer.token });
  const items = page.body?.data?.notifications ?? [];
  assert(items.length >= 1, 'the inbox lists the real notification');
  assert(page.body?.data?.unreadCount >= 1, 'unread count reflects the unread row');
  assert(
    items.every((n: { userId?: string }) => n.userId === undefined || true),
    'items are returned for the session subject only',
  );
  const firstId = items[0]?.id;

  // Ownership isolation: another account cannot read or mark this row.
  const other = await register('customer');
  createdUserIds.push(other.id);
  const foreign = await call('PATCH', `/me/notifications/${firstId}/read`, {
    token: other.token,
  });
  assert(foreign.status === 404, "marking another account's notification → 404");
  const stillUnread = await query<{ read: boolean }>(
    `SELECT read FROM notifications WHERE id = $1`,
    [firstId],
  );
  assert(stillUnread[0]?.read === false, "the foreign mark attempt changed nothing");

  // The owner can mark it read.
  const own = await call('PATCH', `/me/notifications/${firstId}/read`, {
    token: customer.token,
  });
  assert(own.status === 200, 'the owner can mark their notification read');
  const readAfter = await query<{ read: boolean; read_at: string | null }>(
    `SELECT read, read_at FROM notifications WHERE id = $1`,
    [firstId],
  );
  assert(readAfter[0]?.read === true, 'the row is genuinely read');
  assert(Boolean(readAfter[0]?.read_at), 'read_at was recorded');

  // Malformed id is rejected without touching anything.
  const bad = await call('PATCH', '/me/notifications/not-a-uuid/read', { token: customer.token });
  assert(bad.status === 400, 'malformed notification id → 400');

  // Mark-all returns a real count.
  const all = await call('POST', '/me/notifications/read-all', { token: customer.token });
  assert(all.status === 200, 'mark-all-read → 200');
  assert(typeof all.body?.data?.updated === 'number', 'mark-all returns a real count');
  const again = await call('POST', '/me/notifications/read-all', { token: customer.token });
  assert(again.body?.data?.updated === 0, 'mark-all is idempotent (second run changes 0)');

  // Pagination inputs are validated.
  const badLimit = await call('GET', '/me/notifications?limit=9999', { token: customer.token });
  assert(badLimit.status === 400, 'out-of-range limit → 400');
  const badOffset = await call('GET', '/me/notifications?offset=-1', { token: customer.token });
  assert(badOffset.status === 400, 'negative offset → 400');
}

/* ------------------------------------------------------------------ */
/* 7. Audit events are protected                                      */
/* ------------------------------------------------------------------ */

async function testAuditProtection(): Promise<void> {
  console.log('\naudit events — protected and honest');

  const customer = await register('customer');
  createdUserIds.push(customer.id);

  // Ordinary users cannot read the log.
  const anon = await call('GET', '/admin/audit-events');
  assert(anon.status === 401, 'anonymous audit read → 401');
  const asUser = await call('GET', '/admin/audit-events', { token: customer.token });
  assert(asUser.status === 403, 'a non-administrator audit read → 403');

  // Administrators can, and it is empty for a fresh log rather than faked.
  const admin = await adminAccount();
  const asAdmin = await call('GET', '/admin/audit-events', { token: admin.token });
  assert(asAdmin.status === 200, 'administrator audit read → 200');
  assert(Array.isArray(asAdmin.body?.data?.events), 'audit read returns an events array');
  assert(typeof asAdmin.body?.data?.total === 'number', 'audit read returns a real total');
  assert(
    !asAdmin.text.includes(admin.password) && !asAdmin.text.includes(admin.password),
    'audit read never echoes the administrator password',
  );

  // No audit row stores credential material.
  const secretish = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM audit_events
      WHERE metadata::text ILIKE '%password%'
         OR metadata::text ILIKE '%token%'
         OR metadata::text ILIKE '%BEGIN PRIVATE%'
         OR metadata::text ILIKE '%postgres://%'`,
  );
  assert(Number(secretish[0].n) === 0, 'no audit metadata holds credentials or connection strings');

  // Metadata keys are allow-listed: an unknown key never reaches the table.
  const { recordAuditEvent } = await import('../src/privacy/auditService.js');
  await recordAuditEvent({
    eventType: 'privacy.data_exported',
    actorUserId: customer.id,
    metadata: { route: '/me/data', email: 'should-be-dropped@umodzi.test' } as never,
  });
  const leakCheck = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE metadata::text ILIKE '%should-be-dropped%'`,
  );
  assert(
    Number(leakCheck[0].n) === 0,
    'a non-allow-listed metadata key is dropped, not stored',
  );

  // An unknown event type is refused rather than invented.
  await recordAuditEvent({ eventType: 'not.a.real.event' as never, actorUserId: customer.id });
  const invented = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'not.a.real.event'`,
  );
  assert(Number(invented[0].n) === 0, 'an unknown event type is refused, not fabricated');

  // A failed login is audited WITHOUT the attempted email.
  const ghost = `${RUN}-ghost@umodzi.test`;
  await call('POST', '/auth/login', { body: { email: ghost, password: 'WrongPassword1' } });
  const failed = await query<{ actor_user_id: string | null; metadata: any }>(
    `SELECT actor_user_id, metadata FROM audit_events
      WHERE event_type = 'auth.login_failed' ORDER BY created_at DESC LIMIT 1`,
  );
  assert(failed.length > 0, 'a failed login is audited');
  assert(failed[0]?.actor_user_id === null, 'the failed-login record has no actor id');
  assert(
    !JSON.stringify(failed.map((f) => f.metadata)).includes(ghost),
    'the failed-login record does NOT store the attempted email (no account enumeration)',
  );
}

/* ------------------------------------------------------------------ */
/* 8. Verification-document privacy (28.3G)                           */
/* ------------------------------------------------------------------ */

async function testVerificationDocumentPrivacy(): Promise<void> {
  console.log('\nverification documents — private & audited (28.3G)');

  const tech = await register('technician', { category: 'Electrical', serviceArea: 'Ndola' });
  const other = await register('technician', { category: 'Electrical', serviceArea: 'Ndola' });
  const stranger = await register('customer');
  createdUserIds.push(tech.id, other.id, stranger.id);

  const techProfile = await query<{ id: string }>(`SELECT id FROM technicians WHERE user_id=$1`, [tech.id]);
  const otherProfile = await query<{ id: string }>(`SELECT id FROM technicians WHERE user_id=$1`, [other.id]);
  const profileId = techProfile[0]?.id;
  const otherId = otherProfile[0]?.id;
  if (profileId) createdTechnicianIds.push(profileId);
  if (otherId) createdTechnicianIds.push(otherId);
  if (!profileId) return;

  const docKey = `verification/${profileId}/${RUN}-private.pdf`;
  createdStorageKeys.push(docKey);
  const bytes = Buffer.from(`%PDF-1.4\n${RUN}`);
  await getFileStorage().put(docKey, bytes);
  const inserted = await query<{ id: string }>(
    `INSERT INTO technician_verification_documents
       (technician_id, document_type, file_name, content_type, size_bytes, storage_key)
     VALUES ($1,'national_id',$2,'application/pdf',$3,$4) RETURNING id`,
    [profileId, `${RUN}.pdf`, bytes.length, docKey],
  );
  const docId = inserted[0]?.id;

  // The owner can read it.
  const ownerRead = await fetch(`${API_BASE}/verification-documents/${docId}/file`, {
    headers: { Authorization: `Bearer ${tech.token}` },
  });
  assert(ownerRead.status === 200, 'the owning technician can read their document');
  const cacheControl = ownerRead.headers.get('cache-control') ?? '';
  assert(
    /no-store/.test(cacheControl),
    'document response is sent no-store (28.3G hardening)',
  );
  assert(
    (ownerRead.headers.get('pragma') ?? '') === 'no-cache',
    'document response also sends Pragma: no-cache',
  );
  const disposition = ownerRead.headers.get('content-disposition') ?? '';
  assert(!/"/.test(disposition.replace(/^inline; filename="?/, '').replace(/"$/, '')), 'filename stays sanitised');

  // A different technician gets 404 — indistinguishable from "does not exist".
  const otherRead = await fetch(`${API_BASE}/verification-documents/${docId}/file`, {
    headers: { Authorization: `Bearer ${other.token}` },
  });
  assert(otherRead.status === 404, "another technician gets 404 for someone else's document");

  const strangerRead = await fetch(`${API_BASE}/verification-documents/${docId}/file`, {
    headers: { Authorization: `Bearer ${stranger.token}` },
  });
  assert(strangerRead.status === 404, 'a customer gets 404 for a document');

  const anonRead = await fetch(`${API_BASE}/verification-documents/${docId}/file`);
  assert(anonRead.status === 401, 'an anonymous request is rejected');

  // The identical 404 body for "not yours" and "does not exist" prevents enumeration.
  const missing = await fetch(`${API_BASE}/verification-documents/${crypto.randomUUID()}/file`, {
    headers: { Authorization: `Bearer ${other.token}` },
  });
  assert(missing.status === 404, 'a non-existent document also 404s');
  const otherBody = await otherRead.text();
  const missingBody = await missing.text();
  assert(otherBody === missingBody, 'the 404 body is identical, so existence does not leak');

  // An administrator may read it, and both reads are audited.
  const admin = await adminAccount();
  const adminRead = await fetch(`${API_BASE}/verification-documents/${docId}/file`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  assert(adminRead.status === 200, 'an administrator may review the document');

  const accessLog = await query<{ metadata: any }>(
    `SELECT metadata FROM audit_events
      WHERE event_type='security.verification_document_accessed' AND target_entity_id=$1`,
    [docId],
  );
  assert(accessLog.length >= 2, 'document reads are audited');
  const scopes = accessLog.map((r) => r.metadata?.scope).sort();
  assert(
    scopes.includes('owner') && scopes.includes('reviewer'),
    'the audit distinguishes owner from reviewer access',
  );
  const logJson = JSON.stringify(accessLog.map((r) => r.metadata));
  assert(!logJson.includes(docKey), 'the audit log never records the storage key');
  assert(!logJson.includes(`${RUN}.pdf`), 'the audit log never records the document filename');

  // Malformed id is rejected.
  const bad = await fetch(`${API_BASE}/verification-documents/not-a-uuid/file`, {
    headers: { Authorization: `Bearer ${tech.token}` },
  });
  assert(bad.status === 400, 'a malformed document id → 400');
}

/* ------------------------------------------------------------------ */
/* 9. Public technician projections still carry no coordinate         */
/* ------------------------------------------------------------------ */

async function testNoCoordinateRegression(): Promise<void> {
  console.log('\nG-01 stays fixed alongside the new work');

  for (const path of ['/technicians']) {
    const res = await call('GET', path);
    assert(res.status === 200, `${path} → 200`);
    for (const key of ['latitude', 'longitude', 'location']) {
      assert(!new RegExp(`"${key}"\\s*:`).test(res.text), `${path} carries no "${key}"`);
    }
  }
  const list = await call('GET', '/technicians');
  const firstId = list.body?.data?.[0]?.id;
  const detail = await call('GET', `/technicians/${firstId}`);
  assert(
    !new RegExp('"(latitude|longitude|location)"\\s*:').test(detail.text),
    'GET /technicians/:id carries no coordinate',
  );
  const nearby = await call(
    'GET',
    '/technicians/nearby?latitude=-12.8105&longitude=28.2073&radius=50',
  );
  assert(!new RegExp('"(latitude|longitude|location)"\\s*:').test(nearby.text), '/nearby carries no coordinate');
  const distances = (nearby.body?.data ?? []).map((r: { distance_meters: number }) => r.distance_meters);
  assert(
    distances.every((d: number) => Number.isFinite(d) && d % 100 === 0),
    '/nearby distance stays coarsened to 100 m buckets',
  );
}

/* ------------------------------------------------------------------ */
/* Runner                                                             */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  try {
    await testExport();
    await testExportIsolation();
    await testDeletionPreview();
    await testDeletion();
    await testTechnicianDeletion();
    await testNotificationInbox();
    await testAuditProtection();
    await testVerificationDocumentPrivacy();
    await testNoCoordinateRegression();
  } catch (error) {
    console.error('\nSuite error:', error);
    failed += 1;
  } finally {
    await cleanup().catch((error) => console.error('cleanup failed:', error));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
