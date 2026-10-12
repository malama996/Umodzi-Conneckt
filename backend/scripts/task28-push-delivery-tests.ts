/**
 * Task 28.2D6 tests: real Web Push delivery wiring
 * (NotificationService.deliverPendingNotification over the existing
 * PushService + web-push) — LOCAL scratch database ONLY, never Supabase.
 *
 * No running backend is required. Delivery targets a LOCAL stub HTTP
 * server standing in for a push service (Google/Mozilla are never
 * contacted): the payloads are REALLY encrypted with per-subscription
 * keys and REAL generated VAPID credentials, and the stub answers with
 * real HTTP statuses (201 accepted / 404 / 410 / 500). Nothing about
 * delivery is simulated — only the far-end push service is stubbed.
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *   $env:ADMIN_EMAIL='admin@umodzi.test'
 *   npx tsx scripts/task28-push-delivery-tests.ts
 *
 * Covers:
 *   Lifecycle — pending → sent on genuine provider acceptance (sent_at
 *     set, provider_message_id stays NULL: the protocol returns none);
 *     pending → failed with an honest failure_reason otherwise;
 *   Pruning — 404 and 410 subscriptions are deleted, survivors kept;
 *   Multi-device — every subscription attempted, one failure never
 *     blocks the others, sent counts only real acceptances;
 *   Honesty — missing VAPID fails without claiming delivery; unknown
 *     ids and non-pending rows are safe no-ops (no re-push); failure
 *     reasons leak no endpoints or keys.
 *   Cleanup — baseline restored (seeded admin preserved).
 *
 * Zero logins (no auth involved).
 */

import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { query } from '../src/db/client.js';
import { NotificationService } from '../src/notifications/notificationService.js';

// Test-only TLS trust: the stub push service below uses a throwaway
// self-signed certificate (OS temp dir, generated with openssl, never the
// repo). web-push only speaks HTTPS (like all real push services), so the
// local stub must too. This weakens certificate verification for THIS test
// process only — never production code.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function stubCredentials(): { key: Buffer; cert: Buffer } {
  const dir = os.tmpdir();
  try {
    return {
      key: fs.readFileSync(path.join(dir, 'd6-push-test-key.pem')),
      cert: fs.readFileSync(path.join(dir, 'd6-push-test-cert.pem')),
    };
  } catch {
    throw new Error(
      'Missing stub push-service TLS credentials. Regenerate with: ' +
        "openssl req -x509 -newkey rsa:2048 -keyout %TEMP%\\d6-push-test-key.pem " +
        "-out %TEMP%\\d6-push-test-cert.pem -days 3650 -nodes -subj /CN=127.0.0.1 " +
        "-addext subjectAltName=IP:127.0.0.1",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

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
/* Stub push service (local HTTP stand-in, real statuses)              */
/* ------------------------------------------------------------------ */

const hits: Record<string, number> = {};
let sawEncryptedBody = false;

const stub = https.createServer(stubCredentials(), (req, res) => {
  const url = req.url ?? '/';
  hits[url] = (hits[url] ?? 0) + 1;
  let bytes = 0;
  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  req.on('end', () => {
    const encoding = req.headers['content-encoding'];
    if (bytes > 0 && (encoding === 'aes128gcm' || encoding === 'aesgcm')) {
      sawEncryptedBody = true;
    }
    if (url.startsWith('/gone')) {
      res.writeHead(410);
      res.end();
    } else if (url.startsWith('/missing')) {
      res.writeHead(404);
      res.end();
    } else if (url.startsWith('/broken')) {
      res.writeHead(500);
      res.end('push service error');
    } else {
      res.writeHead(201);
      res.end();
    }
  });
});

async function stubPort(): Promise<number> {
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address();
  if (!address || typeof address === 'string') throw new Error('stub server did not bind');
  return address.port;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
const EMAIL_A = `pushdel-a-282d6-${RUN}@umodzi.test`;
const EMAIL_B = `pushdel-b-282d6-${RUN}@umodzi.test`;

let userA = '';
let userB = '';
let port = 0;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function makeSubscriberKeys(): Promise<{ p256dh: string; auth: string }> {
  const keyPair = await crypto.webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const raw = new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  return { p256dh: base64url(raw), auth: base64url(crypto.randomBytes(16)) };
}

async function addSubscription(userId: string, path: string): Promise<void> {
  const keys = await makeSubscriberKeys();
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'D6TestAgent/1.0', NOW(), NOW())`,
    [userId, `https://127.0.0.1:${port}${path}`, keys.p256dh, keys.auth],
  );
}

async function makePendingNotification(userId: string, type: string): Promise<string> {
  const result = await NotificationService.recordEventNotification({
    userId,
    type,
    title: `D6 probe ${type}`,
    message: 'D6 delivery probe message.',
    referenceType: 'dispatch_offer',
    referenceId: crypto.randomUUID(),
    channel: 'in_app',
  });
  if (result.skipped || !result.created) throw new Error('fixture notification not created');
  return result.notification.id;
}

async function notificationRow(id: string) {
  const rows = await query<{
    status: string;
    sent_at: string | null;
    provider_message_id: string | null;
    failure_reason: string | null;
  }>(
    'SELECT status, sent_at, provider_message_id, failure_reason FROM notifications WHERE id = $1',
    [id],
  );
  return rows[0];
}

async function createFixtures(): Promise<void> {
  console.log('\nfixtures: stub push service + 2 users');
  port = await stubPort();
  for (const email of [EMAIL_A, EMAIL_B]) {
    const rows = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, account_status)
       VALUES ($1, 'test-only-unusable-hash', 'customer', 'Push', 'Delivery', 'active')
       RETURNING id`,
      [email],
    );
    if (email === EMAIL_A) userA = rows[0].id;
    else userB = rows[0].id;
  }
  assert(userA.length > 0 && userB.length > 0, 'fixture users created');
}

async function clearSubscriptions(userId: string): Promise<void> {
  await query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
}

/* ------------------------------------------------------------------ */
/* Phases (missing-VAPID first: the provider caches a positive config) */
/* ------------------------------------------------------------------ */

async function testMissingVapid(): Promise<void> {
  console.log('\nmissing VAPID configuration');

  delete process.env.VAPID_SUBJECT;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;

  await clearSubscriptions(userA);

  await addSubscription(userA, '/ok-vapid-missing');
  const id = await makePendingNotification(userA, 'vapid_probe');
  const result = await NotificationService.deliverPendingNotification(id);
  assert(result.delivered === false && result.sent === 0, 'nothing delivered without VAPID');
  const row = await notificationRow(id);
  assert(row.status === 'failed', 'status failed (honest, not sent)');
  assert(
    typeof row.failure_reason === 'string' && row.failure_reason.includes('VAPID'),
    'failure reason names the missing VAPID configuration',
  );
  assert(row.sent_at === null, 'sent_at stays NULL on failure');
  assert(
    !String(row.failure_reason).includes('http') && !String(row.failure_reason).includes(userA),
    'failure reason leaks no endpoints or ids',
  );
}

async function configureTestVapid(): Promise<void> {
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_SUBJECT = 'mailto:d6-test@umodzi.test';
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
}

async function testAcceptance(): Promise<void> {
  console.log('\ngenuine provider acceptance');

  await clearSubscriptions(userA);
  await addSubscription(userA, '/ok-accept');
  const id = await makePendingNotification(userA, 'accept_probe');
  const before = hits['/ok-accept'] ?? 0;
  const result = await NotificationService.deliverPendingNotification(id);
  assert(result.delivered === true && result.sent === 1 && result.failed === 0, 'acceptance counted honestly');
  assert((hits['/ok-accept'] ?? 0) === before + 1, 'exactly one provider attempt');
  assert(sawEncryptedBody, 'payload was really encrypted (aes128gcm)');
  const row = await notificationRow(id);
  assert(row.status === 'sent', 'status sent only on real acceptance');
  assert(row.sent_at !== null, 'sent_at recorded');
  assert(row.provider_message_id === null, 'no provider id fabricated');
}

async function testFailureAndPrune(): Promise<void> {
  console.log('\nfailure, 404/410 pruning');

  await clearSubscriptions(userA);
  await addSubscription(userA, '/broken-fail');
  const failId = await makePendingNotification(userA, 'fail_probe');
  const failResult = await NotificationService.deliverPendingNotification(failId);
  assert(failResult.delivered === false && failResult.sent === 0, '500 → not delivered');
  const failRow = await notificationRow(failId);
  assert(failRow.status === 'failed', 'status failed on total rejection');
  assert(
    typeof failRow.failure_reason === 'string' && failRow.failure_reason.length > 0,
    'failure reason recorded',
  );
  assert(failRow.sent_at === null, 'sent_at stays NULL on failure');

  await addSubscription(userA, '/missing-prune');
  const goneId = await makePendingNotification(userA, 'gone_probe');
  await NotificationService.deliverPendingNotification(goneId);
  const missingLeft = await query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%/missing-prune'",
  );
  assert(Number(missingLeft[0].n) === 0, '404 subscription pruned');

  await addSubscription(userA, '/gone-prune');
  const gone410Id = await makePendingNotification(userA, 'gone410_probe');
  await NotificationService.deliverPendingNotification(gone410Id);
  const goneLeft = await query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%/gone-prune'",
  );
  assert(Number(goneLeft[0].n) === 0, '410 subscription pruned');
}

async function testMultiDevice(): Promise<void> {
  console.log('\nmulti-device isolation');

  await clearSubscriptions(userB);
  await addSubscription(userB, '/ok-multi');
  await addSubscription(userB, '/broken-multi');
  await addSubscription(userB, '/gone-multi');
  const okBefore = hits['/ok-multi'] ?? 0;
  const brokenBefore = hits['/broken-multi'] ?? 0;
  const goneBefore = hits['/gone-multi'] ?? 0;

  const id = await makePendingNotification(userB, 'multi_probe');
  const result = await NotificationService.deliverPendingNotification(id);
  assert(result.sent === 1 && result.failed === 2, 'sent counts only the real acceptance');
  assert(
    (hits['/ok-multi'] ?? 0) === okBefore + 1 &&
      (hits['/broken-multi'] ?? 0) === brokenBefore + 1 &&
      (hits['/gone-multi'] ?? 0) === goneBefore + 1,
    'every subscription attempted (one failure blocks nothing)',
  );
  const row = await notificationRow(id);
  assert(row.status === 'sent', 'one acceptance marks the row sent');
  const goneLeft = await query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%/gone-multi'",
  );
  const okLeft = await query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%/ok-multi'",
  );
  assert(Number(goneLeft[0].n) === 0 && Number(okLeft[0].n) === 1, 'dead pruned, live kept');
}

async function testIdlePaths(): Promise<void> {
  console.log('\nidle paths (no re-push, unknown id)');

  await clearSubscriptions(userA);
  const id = await makePendingNotification(userA, 'idle_probe');
  await addSubscription(userA, '/ok-idle');
  const first = await NotificationService.deliverPendingNotification(id);
  assert(first.delivered === true, 'first delivery sends');
  const hitsAfterFirst = hits['/ok-idle'] ?? 0;
  const second = await NotificationService.deliverPendingNotification(id);
  assert(second.delivered === false && second.sent === 0, 'sent row is never re-pushed');
  assert((hits['/ok-idle'] ?? 0) === hitsAfterFirst, 'no second provider attempt');

  const unknown = await NotificationService.deliverPendingNotification(crypto.randomUUID());
  assert(unknown.delivered === false, 'unknown id is a safe no-op');
}

async function testNoSubscriptions(): Promise<void> {
  console.log('\nrecipient without subscriptions');

  await clearSubscriptions(userB);
  const id = await makePendingNotification(userB, 'nosub_probe');
  const result = await NotificationService.deliverPendingNotification(id);
  assert(result.delivered === false, 'nothing delivered without subscriptions');
  const row = await notificationRow(id);
  assert(
    row.status === 'failed' &&
      typeof row.failure_reason === 'string' &&
      row.failure_reason.includes('No push subscriptions'),
    'failed with the no-subscriptions reason',
  );
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

// Baseline captured before fixtures: the shared database may hold
// notifications from other flows (the scratch-era empty-table assertion
// drifted), so cleanup proves its own rows are gone by restoring the
// exact starting count.
let baselineNotifications = -1;

async function cleanup(): Promise<void> {
  console.log('\ncleanup — restoring the baseline (seeded admin preserved)');
  stub.close();
  await query(
    `DELETE FROM users WHERE lower(email) LIKE 'pushdel-%-282d6-%@umodzi.test'`,
  );

  const notifs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  const subs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM push_subscriptions');
  const users = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );
  const admin = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM users WHERE lower(email) = lower($1)',
    [ADMIN_EMAIL as string],
  );

  assert(
    Number(notifs[0].n) === baselineNotifications,
    `notifications back to the baseline count (${baselineNotifications})`,
  );
  assert(Number(subs[0].n) === 0, 'no push subscriptions remain');
  assert(Number(users[0].n) === 0, 'no fixture accounts remain');
  assert(Number(admin[0].n) === 1, 'seeded administrator preserved');
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const baseline = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  baselineNotifications = Number(baseline[0].n);
  await createFixtures();
  await testMissingVapid();
  await configureTestVapid();
  await testAcceptance();
  await testFailureAndPrune();
  await testMultiDevice();
  await testIdlePaths();
  await testNoSubscriptions();
  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch(async (error: unknown) => {
  console.error('Test runner crashed:', error);
  try {
    stub.close();
    await cleanup();
  } catch {
    /* best effort */
  }
  process.exitCode = 1;
});
