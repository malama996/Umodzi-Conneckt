/**
 * Task 28.2F tests: Africa's Talking SMS provider boundary + policy —
 * LOCAL scratch database ONLY, never Supabase. No running backend needed.
 *
 * The external provider is NEVER contacted: global fetch is stubbed for
 * every provider test (deterministic AT payloads), so no SMS credits can
 * be spent and no real delivery is claimed. Real credential-dependent
 * delivery remains explicitly unverified (no credentials exist).
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *   $env:ADMIN_EMAIL='admin@umodzi.test'
 *   npx tsx scripts/task28-sms-tests.ts
 *
 * Covers:
 *   Selection — SMS_PROVIDER=africas_talking (established spelling) and
 *     the africastalking alias both route to the Africa's Talking adapter;
 *   Validation — missing credentials fail honestly with NO network call;
 *   Adapter — success passes the real provider message id through
 *     verbatim; recipient/HTTP/network failures return honest failures
 *     (never fabricated success);
 *   Persistence — sendSmsNotification stores channel/status/provider id/
 *     failure reason correctly;
 *   Replaceability — a custom ISmsProvider plugs in behind the boundary;
 *   Policy — only action-required event types are SMS-eligible;
 *   Hygiene — no SMS/VAPID-private credentials in frontend-visible config.
 *   Cleanup — baseline restored (seeded admin preserved).
 *
 * Zero logins (no auth involved).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../src/db/client.js';
import {
  ConfigurableSmsProvider,
  NotificationService,
  isSmsEligibleEvent,
  type ISmsProvider,
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
/* Fetch stub (the provider boundary — never the real network)         */
/* ------------------------------------------------------------------ */

let fetchCalls = 0;
let lastFetchUrl = '';
let lastFetchBody = '';

function stubFetch(handler: (url: string, body: string) => { status: number; payload: unknown }): void {
  fetchCalls = 0;
  lastFetchUrl = '';
  lastFetchBody = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls += 1;
    const url = typeof input === 'string' ? input : String(input);
    lastFetchUrl = url;
    lastFetchBody = typeof init?.body === 'string' ? init.body : '';
    const { status, payload } = handler(url, lastFetchBody);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 201 ? 'Created' : 'Error',
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as typeof fetch;
}

const AT_SUCCESS = {
  SMSMessageData: {
    Message: 'Sent to 1/1 Total Cost: KES 0.8000',
    Recipients: [{ status: 'Success', messageId: 'AT-REAL-ID-123', cost: 'KES 0.8000' }],
  },
};

const SMS_ENV_KEYS = [
  'SMS_PROVIDER',
  'AFRICASTALKING_USERNAME',
  'AFRICASTALKING_API_KEY',
  'AFRICASTALKING_FROM',
  'SMS_API_KEY',
  'SMS_USERNAME',
  'SMS_SENDER_ID',
];

const savedEnv: Record<string, string | undefined> = {};
for (const key of SMS_ENV_KEYS) {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}

function setSmsEnv(values: Record<string, string>): void {
  for (const key of SMS_ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

function restoreSmsEnv(): void {
  for (const key of SMS_ENV_KEYS) {
    delete process.env[key];
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key] as string;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
const EMAIL_S = `sms-282f-${RUN}@umodzi.test`;
let userS = '';

async function createFixtures(): Promise<void> {
  console.log('\nfixtures: 1 user (direct SQL — provider takes ids, no auth involved)');
  const rows = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, account_status)
     VALUES ($1, 'test-only-unusable-hash', 'customer', 'Sms', 'Fixture', 'active')
     RETURNING id`,
    [EMAIL_S],
  );
  userS = rows[0].id;
  assert(userS.length > 0, 'fixture user created');
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function testSelectionAndValidation(): Promise<void> {
  console.log('\nprovider selection + credential validation');

  // Established spelling routes to Africa's Talking (was: silent mock).
  setSmsEnv({
    SMS_PROVIDER: 'africas_talking',
    AFRICASTALKING_USERNAME: 'umodzi-test',
    AFRICASTALKING_API_KEY: 'test-key',
  });
  stubFetch(() => ({ status: 201, payload: AT_SUCCESS }));
  const viaEstablished = await new ConfigurableSmsProvider().sendSms('+260971000001', 'hello');
  assert(
    viaEstablished.success === true && viaEstablished.providerMessageId === 'AT-REAL-ID-123',
    'SMS_PROVIDER=africas_talking reaches the AT adapter (id passed through)',
  );
  assert(
    lastFetchUrl === 'https://api.africastalking.com/version1/messaging',
    'adapter posts to the real Africa\'s Talking endpoint',
  );
  assert(
    lastFetchBody.includes('username=umodzi-test') && lastFetchBody.includes('to=%2B260971000001'),
    'adapter sends username + recipient (no credential values asserted beyond presence)',
  );

  // Alias spelling behaves identically.
  setSmsEnv({
    SMS_PROVIDER: 'africastalking',
    SMS_USERNAME: 'umodzi-test',
    SMS_API_KEY: 'test-key',
  });
  stubFetch(() => ({ status: 201, payload: AT_SUCCESS }));
  const viaAlias = await new ConfigurableSmsProvider().sendSms('+260971000002', 'hello');
  assert(
    viaAlias.success === true && viaAlias.providerMessageId === 'AT-REAL-ID-123',
    'africastalking alias routes identically (legacy SMS_* names as fallback)',
  );

  // Missing credentials: honest failure, zero network calls.
  setSmsEnv({ SMS_PROVIDER: 'africas_talking' });
  stubFetch(() => ({ status: 201, payload: AT_SUCCESS }));
  const missing = await new ConfigurableSmsProvider().sendSms('+260971000003', 'hello');
  assert(missing.success === false, 'missing credentials → success:false (never fabricated)');
  assert(
    typeof missing.error === 'string' && missing.error.includes('AFRICASTALKING_API_KEY'),
    'missing-credential error names the required variables',
  );
  assert(fetchCalls === 0, 'missing credentials → no network call attempted');

  // Empty recipient/message rejected before any network.
  setSmsEnv({
    SMS_PROVIDER: 'africas_talking',
    AFRICASTALKING_USERNAME: 'u',
    AFRICASTALKING_API_KEY: 'k',
  });
  stubFetch(() => ({ status: 201, payload: AT_SUCCESS }));
  const emptyTo = await new ConfigurableSmsProvider().sendSms('', 'hello');
  assert(emptyTo.success === false && fetchCalls === 0, 'empty recipient → failure, no call');
}

async function testAdapterHonesty(): Promise<void> {
  console.log('\nadapter honesty (mocked HTTP boundary)');

  setSmsEnv({
    SMS_PROVIDER: 'africas_talking',
    AFRICASTALKING_USERNAME: 'u',
    AFRICASTALKING_API_KEY: 'k',
  });

  // Provider-level recipient failure is surfaced, not flipped to success.
  stubFetch(() => ({
    status: 200,
    payload: {
      SMSMessageData: { Recipients: [{ status: 'Failed: Insufficient balance', messageId: 'none' }] },
    },
  }));
  const recipientFail = await new ConfigurableSmsProvider().sendSms('+260971000004', 'hi');
  assert(
    recipientFail.success === false &&
      typeof recipientFail.error === 'string' &&
      recipientFail.error.includes('Insufficient balance'),
    'provider-reported failure stays a failure with its reason',
  );

  // HTTP-level failure.
  stubFetch(() => ({ status: 400, payload: { error: 'bad request' } }));
  const httpFail = await new ConfigurableSmsProvider().sendSms('+260971000005', 'hi');
  assert(httpFail.success === false, 'HTTP 400 → success:false');

  // Network throw never escapes as success.
  globalThis.fetch = (() => Promise.reject(new Error('socket hangup'))) as typeof fetch;
  fetchCalls = 0;
  const netFail = await new ConfigurableSmsProvider().sendSms('+260971000006', 'hi');
  assert(
    netFail.success === false && netFail.error === 'socket hangup',
    'network throw → failure carrying the cause',
  );
}

async function testPersistenceAndReplaceability(): Promise<void> {
  console.log('\npersistence + provider replaceability');

  setSmsEnv({
    SMS_PROVIDER: 'africas_talking',
    AFRICASTALKING_USERNAME: 'u',
    AFRICASTALKING_API_KEY: 'k',
  });
  // The service holds one process-wide provider built from the environment
  // — rebuild it after changing env (same as a fresh boot would).
  NotificationService.setSmsProvider(new ConfigurableSmsProvider());
  stubFetch(() => ({ status: 201, payload: AT_SUCCESS }));
  const sent = await NotificationService.sendSmsNotification(
    userS,
    '+260971000007',
    'Verification update',
    'Your verification was approved.',
    'technician',
    userS,
  );
  assert(sent.success === true, 'sendSmsNotification reports real success');
  const sentRows = await query<{
    channel: string;
    status: string;
    provider_message_id: string | null;
    failure_reason: string | null;
  }>(
    `SELECT channel, status, provider_message_id, failure_reason FROM notifications WHERE id = $1`,
    [sent.id],
  );
  assert(
    sentRows[0].channel === 'sms' &&
      sentRows[0].status === 'sent' &&
      sentRows[0].provider_message_id === 'AT-REAL-ID-123' &&
      sentRows[0].failure_reason === null,
    'success row stores channel/status/real provider id',
  );

  stubFetch(() => ({ status: 500, payload: { error: 'down' } }));
  const failed = await NotificationService.sendSmsNotification(
    userS,
    '+260971000008',
    'Verification update',
    'Your verification was approved.',
  );
  assert(failed.success === false, 'provider failure propagates');
  const failedRows = await query<{ status: string; failure_reason: string | null }>(
    'SELECT status, failure_reason FROM notifications WHERE id = $1',
    [failed.id],
  );
  assert(
    failedRows[0].status === 'failed' && typeof failedRows[0].failure_reason === 'string',
    'failure row stores failed status + reason',
  );

  // A custom provider plugs in behind the same boundary (replaceability).
  const seen: Array<{ to: string; message: string }> = [];
  const custom: ISmsProvider = {
    sendSms: async (to: string, message: string) => {
      seen.push({ to, message });
      return { success: true, providerMessageId: 'custom-1' };
    },
  };
  NotificationService.setSmsProvider(custom);
  const viaCustom = await NotificationService.sendSmsNotification(userS, '+260971000009', 'T', 'M');
  assert(
    viaCustom.success === true && seen.length === 1 && seen[0].to === '+260971000009',
    'custom provider used verbatim (no hidden AT call)',
  );
  NotificationService.setSmsProvider(new ConfigurableSmsProvider());
}

async function testPolicy(): Promise<void> {
  console.log('\nSMS policy gate');

  for (const type of [
    'dispatch_offer_accepted',
    'technician_verification_approved',
    'technician_verification_rejected',
  ]) {
    assert(isSmsEligibleEvent(type) === true, `policy allows ${type}`);
  }
  for (const type of [
    'dispatch_offer_created',
    'dispatch_offer_rejected',
    'dispatch_offer_timed_out',
    'request_status_completed',
    'request_status_matched',
    'technician_verification_submitted',
    'anything_else',
    '',
  ]) {
    assert(isSmsEligibleEvent(type) === false, `policy excludes ${type || '(empty)'}`);
  }
}

async function testHygiene(): Promise<void> {
  console.log('\nsecret hygiene');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const frontendRoot = path.join(here, '..', '..', 'frontend');
  for (const relative of ['.env.example', 'lib/api/client.ts', 'lib/api/pushApi.ts']) {
    const content = fs.readFileSync(path.join(frontendRoot, relative), 'utf8');
    assert(
      !content.includes('AFRICASTALKING_API_KEY') &&
        !content.includes('AFRICASTALKING_USERNAME') &&
        !content.includes('VAPID_PRIVATE_KEY'),
      `frontend ${relative} carries no SMS/VAPID-private credential names`,
    );
  }
  assert(
    !/NEXT_PUBLIC_\w*(AFRICA|SMS_|VAPID_PRIVATE)/.test(
      fs.readFileSync(path.join(frontendRoot, '.env.example'), 'utf8'),
    ),
    'no backend SMS/VAPID secret enters NEXT_PUBLIC_*',
  );

  // Documented placeholders carry no values.
  const example = fs.readFileSync(
    path.join(here, '..', '.env.example'),
    'utf8',
  );
  for (const line of example.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    assert(
      !/^(AFRICASTALKING_API_KEY|AFRICASTALKING_USERNAME|VAPID_PRIVATE_KEY|JWT_SECRET)=.+/.test(trimmed),
      `backend .env.example assigns no real secret (${trimmed.split('=')[0]})`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

async function cleanup(): Promise<void> {
  console.log('\ncleanup — restoring the baseline (seeded admin preserved)');
  restoreSmsEnv();
  NotificationService.setSmsProvider(new ConfigurableSmsProvider());
  await query(`DELETE FROM notifications`);
  await query(`DELETE FROM users WHERE lower(email) LIKE 'sms-282f-%@umodzi.test'`);

  const notifs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  const users = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );
  const admin = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM users WHERE lower(email) = lower($1)',
    [ADMIN_EMAIL as string],
  );

  assert(Number(notifs[0].n) === 0, 'no notifications remain');
  assert(Number(users[0].n) === 0, 'no fixture accounts remain');
  assert(Number(admin[0].n) === 1, 'seeded administrator preserved');
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await createFixtures();
  await testSelectionAndValidation();
  await testAdapterHonesty();
  await testPersistenceAndReplaceability();
  await testPolicy();
  await testHygiene();
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
