/**
 * Task 28.2D1 tests: the shared event-notification helper
 * (NotificationService.recordEventNotification) — direct service calls,
 * NO running backend required, LOCAL scratch database ONLY (never Supabase:
 * this suite inserts and deletes rows).
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *   $env:ADMIN_EMAIL='admin@umodzi.test'
 *   npx tsx scripts/task28-event-notification-tests.ts
 *
 * Covers:
 *   Persistence — valid event creates a pending row with exact fields;
 *     sent_at / provider_message_id / failure_reason stay NULL;
 *   Idempotency — same natural key returns the existing row, never a
 *     second row; different referenceIds / different recipients diverge;
 *   Recipients — null/undefined userId safely skips; invalid UUID rejects;
 *   Validation — empty type/title/message/reference and bad referenceId
 *     reject; unknown referenceType/channel reject;
 *   Silence — no Web Push and no SMS is attempted (network stub throws).
 *
 * Zero logins (no auth involved). Cleanup restores the baseline with the
 * seeded admin preserved.
 */

import crypto from 'node:crypto';
import { query } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  NotificationService,
  type EventNotification,
  type RecordEventNotificationResult,
} from '../src/notifications/notificationService.js';

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
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
const EMAIL_A = `event-a-282d1-${RUN}@umodzi.test`;
const EMAIL_B = `event-b-282d1-${RUN}@umodzi.test`;

let userA = '';
let userB = '';

// Baseline captured before fixtures: the shared database may legitimately
// hold notifications from other flows (scratch-era empty-table assertions
// drifted). The suite proves "our run changed nothing outside its own
// rows" by restoring this exact count instead of expecting zero.
let baselineNotifications = -1;

async function createFixtures(): Promise<void> {
  console.log('\nfixtures: 2 users (direct SQL — helper takes ids, no auth involved)');
  await runMigrations();
  for (const email of [EMAIL_A, EMAIL_B]) {
    const rows = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, account_status)
       VALUES ($1, 'test-only-unusable-hash', 'customer', 'Event', 'Fixture', 'active')
       RETURNING id`,
      [email],
    );
    if (email === EMAIL_A) userA = rows[0].id;
    else userB = rows[0].id;
  }
  assert(userA.length > 0 && userB.length > 0, 'fixture users created');
}

const REF_A = crypto.randomUUID();
const REF_B = crypto.randomUUID();

function eventInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: userA,
    type: 'offer_created',
    title: 'New service offer',
    message: 'A technician was offered your service request.',
    referenceType: 'dispatch_offer' as const,
    referenceId: REF_A,
    ...overrides,
  };
}

function isCreated(
  result: RecordEventNotificationResult,
): result is { created: boolean; skipped: false; notification: EventNotification } {
  return result.skipped === false;
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function testPersistence(): Promise<EventNotification> {
  console.log('\npersistence');

  const result = await NotificationService.recordEventNotification(eventInput());
  assert(result.skipped === false && result.created === true, 'valid event → created:true');
  const n = isCreated(result) ? result.notification : null;
  assert(n !== null, 'created result carries the notification');
  assert(
    n !== null &&
      n.userId === userA &&
      n.type === 'offer_created' &&
      n.title === 'New service offer' &&
      n.message === 'A technician was offered your service request.' &&
      n.channel === 'in_app' &&
      n.referenceType === 'dispatch_offer' &&
      n.referenceId === REF_A &&
      n.status === 'pending',
    'returned fields match the event exactly (status pending)',
  );

  const rows = await query<{
    status: string;
    sent_at: string | null;
    provider_message_id: string | null;
    failure_reason: string | null;
    read: boolean;
    channel: string;
  }>(
    'SELECT status, sent_at, provider_message_id, failure_reason, read, channel FROM notifications WHERE id = $1',
    [(n as EventNotification).id],
  );
  assert(rows.length === 1, 'exactly one row persisted');
  assert(rows[0].status === 'pending', 'stored status is pending (not sent)');
  assert(rows[0].sent_at === null, 'sent_at stays NULL');
  assert(rows[0].provider_message_id === null, 'provider_message_id stays NULL');
  assert(rows[0].failure_reason === null, 'failure_reason stays NULL');

  return n as EventNotification;
}

async function testIdempotency(first: EventNotification): Promise<void> {
  console.log('\nidempotency');

  const again = await NotificationService.recordEventNotification(eventInput());
  assert(again.skipped === false && again.created === false, 'duplicate key → created:false');
  assert(
    isCreated(again) && again.notification.id === first.id,
    'duplicate returns the EXISTING notification id',
  );
  const count = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND type = $2 AND reference_type = $3 AND reference_id = $4',
    [userA, 'offer_created', 'dispatch_offer', REF_A],
  );
  assert(Number(count[0].n) === 1, 'duplicate event creates no second row');

  // Concurrent duplicates serialize on the advisory lock — still one row.
  const concurrent = await Promise.all(
    Array.from({ length: 5 }, () => NotificationService.recordEventNotification(eventInput())),
  );
  assert(
    concurrent.every((r) => r.skipped === false && r.created === false),
    '5 concurrent duplicates all return created:false',
  );
  assert(
    concurrent.every((r) => isCreated(r) && r.notification.id === first.id),
    'concurrent duplicates all return the same existing id',
  );
  const after = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND reference_id = $2',
    [userA, REF_A],
  );
  assert(Number(after[0].n) === 1, 'still exactly one row after concurrent duplicates');

  // Different reference → different row.
  const otherRef = await NotificationService.recordEventNotification(eventInput({ referenceId: REF_B }));
  assert(
    otherRef.skipped === false && otherRef.created === true,
    'different referenceId → separate notification',
  );

  // Different recipient → different row.
  const otherUser = await NotificationService.recordEventNotification(
    eventInput({ userId: userB }),
  );
  assert(
    otherUser.skipped === false && otherUser.created === true,
    'different recipient → separate notification',
  );
}

async function testRecipients(): Promise<void> {
  console.log('\nrecipients');

  const nullRes = await NotificationService.recordEventNotification(eventInput({ userId: null }));
  assert(
    nullRes.created === false && nullRes.skipped === true &&
      (nullRes as { reason?: string }).reason === 'missing-recipient',
    'null userId → safe skip (missing-recipient)',
  );
  const undefRes = await NotificationService.recordEventNotification(
    eventInput({ userId: undefined }),
  );
  assert(undefRes.created === false && undefRes.skipped === true, 'undefined userId → safe skip');

  // Scoped to this suite's recipients: pre-existing rows for other users
  // must not mask (or fake) the invariant that skips created nothing.
  const total = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id IN ($1, $2)',
    [userA, userB],
  );
  assert(Number(total[0].n) === 3, 'skips create no rows (3 suite rows total)');

  try {
    await NotificationService.recordEventNotification(eventInput({ userId: 'not-a-uuid' }));
    assert(false, 'invalid userId UUID → throws');
  } catch (error) {
    assert(
      error instanceof Error && (error as { statusCode?: number }).statusCode === 400,
      'invalid userId UUID → 400',
    );
  }
}

async function testValidation(): Promise<void> {
  console.log('\nvalidation');

  const bad: Array<[string, Record<string, unknown>]> = [
    ['empty type', { type: '   ' }],
    ['empty title', { title: '' }],
    ['empty message', { message: '  ' }],
    ['bad referenceId', { referenceId: 'nope' }],
    ['unknown referenceType', { referenceType: 'spaceship' }],
    ['unknown channel', { channel: 'smoke-signal' }],
    ['oversized title', { title: 't'.repeat(201) }],
    ['oversized message', { message: 'm'.repeat(2001) }],
  ];
  for (const [name, override] of bad) {
    try {
      await NotificationService.recordEventNotification(eventInput(override));
      assert(false, `${name} → throws`);
    } catch (error) {
      assert(
        error instanceof Error && (error as { statusCode?: number }).statusCode === 400,
        `${name} → 400`,
      );
    }
  }
}

async function testSilence(): Promise<void> {
  console.log('\nsilence (no push, no SMS)');

  // Any network attempt (web-push delivery, SMS provider) throws here.
  const realFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = () => {
    throw new Error('network forbidden in D1 helper tests');
  };
  try {
    const res = await NotificationService.recordEventNotification(
      eventInput({ referenceId: crypto.randomUUID(), type: 'silence_probe' }),
    );
    assert(res.skipped === false && res.created === true, 'helper completes with network forbidden');
    await query('DELETE FROM notifications WHERE type = $1', ['silence_probe']);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

async function cleanup(): Promise<void> {
  console.log('\ncleanup — restoring the baseline (seeded admin preserved)');
  await query(`DELETE FROM users WHERE lower(email) LIKE 'event-%-282d1-%@umodzi.test'`);

  const subs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  const users = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );
  const admin = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM users WHERE lower(email) = lower($1)',
    [ADMIN_EMAIL as string],
  );

  assert(
    Number(subs[0].n) === baselineNotifications,
    `notifications back to the baseline count (${baselineNotifications})`,
  );
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
  const first = await testPersistence();
  await testIdempotency(first);
  await testRecipients();
  await testValidation();
  await testSilence();
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
