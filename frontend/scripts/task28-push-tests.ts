/**
 * Task 28.2C focused frontend tests: browser Web Push subscription helper,
 * the push API boundary, backend-id linkage, and frontend secret hygiene.
 *
 * Run from the frontend folder:
 *   npx --no-install tsx scripts/task28-push-tests.ts
 *
 * Component rendering (PushSubscriptionControl) is verified in the browser;
 * this suite covers every branch the component depends on, with stubbed
 * browser globals and a stubbed fetch. No network, no private keys — the
 * VAPID key below is a synthetic fixture, never a real credential.
 */
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:9999/api/v1';
process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'A'.repeat(87);

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../lib/api/client';
import { deletePushSubscription, postPushSubscription } from '../lib/api/pushApi';
import {
  forgetSubscriptionId,
  linkedSubscriptionId,
  pushCapability,
  pushPermission,
  PushError,
  rememberSubscriptionId,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
  urlBase64ToUint8Array,
  vapidPublicKey,
} from '../lib/push/webPush';

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
/* Browser global stubs                                               */
/* ------------------------------------------------------------------ */

interface FakeSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string } | null;
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } | null };
  unsubscribeCalls: number;
  unsubscribe: () => Promise<boolean>;
}

function fakeSubscription(endpoint: string, withKeys = true): FakeSubscription {
  const keys = withKeys ? { p256dh: 'cDEyMzQ1Njc4', auth: 'YXV0aHNlY3JldA' } : null;
  const sub: FakeSubscription = {
    endpoint,
    keys,
    toJSON: () => ({ endpoint, keys }),
    unsubscribeCalls: 0,
    unsubscribe: async () => {
      sub.unsubscribeCalls += 1;
      return true;
    },
  };
  return sub;
}

interface BrowserStubOptions {
  serviceWorker?: boolean;
  pushManager?: boolean;
  notification?: boolean;
  permission?: 'granted' | 'denied' | 'default';
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
  existingSubscription?: FakeSubscription | null;
  subscribeResult?: FakeSubscription | null;
  subscribeError?: boolean;
  userAgent?: string;
}

let subscribeCalls = 0;
let lastSubscribeOptions: { userVisibleOnly?: boolean; applicationServerKey?: unknown } = {};

function installBrowserStubs(opts: BrowserStubOptions = {}): void {
  const {
    serviceWorker = true,
    pushManager = true,
    notification = true,
    permission = 'granted',
    requestPermission,
    existingSubscription = null,
    subscribeResult = null,
    subscribeError = false,
    userAgent = 'UmodziTestBrowser/1.0',
  } = opts;
  subscribeCalls = 0;
  lastSubscribeOptions = {};

  const nav: Record<string, unknown> = { userAgent };
  if (serviceWorker) {
    nav.serviceWorker = {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => existingSubscription,
          subscribe: async (subOptions: {
            userVisibleOnly?: boolean;
            applicationServerKey?: unknown;
          }) => {
            subscribeCalls += 1;
            lastSubscribeOptions = subOptions;
            if (subscribeError) throw new Error('push service unreachable');
            if (!subscribeResult) throw new Error('no subscription');
            return subscribeResult;
          },
        },
      }),
    };
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: nav,
    configurable: true,
    writable: true,
  });

  if (pushManager) {
    Object.defineProperty(globalThis, 'window', {
      value: { PushManager: class {} },
      configurable: true,
      writable: true,
    });
  } else {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
  }

  if (notification) {
    Object.defineProperty(globalThis, 'Notification', {
      value: {
        permission,
        requestPermission: requestPermission ?? (async () => permission),
      },
      configurable: true,
      writable: true,
    });
  } else {
    delete (globalThis as Record<string, unknown>).Notification;
  }
}

function removeBrowserStubs(): void {
  delete (globalThis as Record<string, unknown>).navigator;
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).Notification;
}

function installLocalStorageStub(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
    configurable: true,
    writable: true,
  });
}

function removeLocalStorageStub(): void {
  delete (globalThis as Record<string, unknown>).localStorage;
}

/* ------------------------------------------------------------------ */
/* Fetch stub (same shape as the Task 27 suite)                       */
/* ------------------------------------------------------------------ */

interface StubCall {
  url: string;
  method: string;
  body: string | null;
}

let lastCall: StubCall | null = null;
let nextStatus = 200;
let nextPayload: unknown = null;

function stubFetch(status: number, payload: unknown): void {
  nextStatus = status;
  nextPayload = payload;
  lastCall = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyText =
      typeof init?.body === 'string' ? (init.body as string) : init?.body ? '[non-string]' : null;
    lastCall = { url, method, body: bodyText };
    return {
      ok: nextStatus >= 200 && nextStatus < 300,
      status: nextStatus,
      statusText: nextStatus === 200 || nextStatus === 201 ? 'OK' : 'Error',
      text: async () => JSON.stringify(nextPayload),
      json: async () => nextPayload,
    } as Response;
  }) as typeof fetch;
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

const FAKE_KEY = 'A'.repeat(87);
const SAVED_VAPID_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

async function testFeatureDetection(): Promise<void> {
  console.log('\nfeature detection');

  removeBrowserStubs();
  assert(pushCapability() === 'unsupported', 'no navigator → unsupported');

  installBrowserStubs({ serviceWorker: false });
  assert(pushCapability() === 'unsupported', 'missing serviceWorker → unsupported');

  installBrowserStubs({ pushManager: false });
  assert(pushCapability() === 'unsupported', 'missing PushManager → unsupported');

  installBrowserStubs({ notification: false });
  assert(pushCapability() === 'unsupported', 'missing Notification → unsupported');

  installBrowserStubs();
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  assert(pushCapability() === 'not-configured', 'missing VAPID key → not-configured');
  assert(vapidPublicKey() === null, 'vapidPublicKey() is null without configuration');
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = SAVED_VAPID_KEY;

  installBrowserStubs();
  assert(pushCapability() === 'supported', 'full browser + key → supported');
  assert(vapidPublicKey() === FAKE_KEY, 'vapidPublicKey() returns the configured key');
}

async function testPermission(): Promise<void> {
  console.log('\npermission');

  installBrowserStubs({ permission: 'granted' });
  assert(pushPermission() === 'granted', 'granted permission reported');

  installBrowserStubs({ permission: 'denied' });
  assert(pushPermission() === 'denied', 'denied permission reported');

  installBrowserStubs({ permission: 'default' });
  assert(pushPermission() === 'prompt', 'default permission maps to prompt');

  installBrowserStubs({ notification: false });
  assert(pushPermission() === 'unavailable', 'no Notification → unavailable');

  // Denied permission never reaches PushManager.
  installBrowserStubs({ permission: 'denied' });
  subscribeCalls = 0;
  try {
    await subscribeBrowserPush();
    assert(false, 'denied permission → throws');
  } catch (error) {
    assert(
      error instanceof PushError && subscribeCalls === 0,
      'denied permission → PushError before subscribing',
    );
  }

  // Prompt → granted continues to PushManager.
  const fresh = fakeSubscription('https://push.example.com/prompt-ok');
  installBrowserStubs({
    permission: 'default',
    requestPermission: async () => 'granted',
    subscribeResult: fresh,
  });
  const payload = await subscribeBrowserPush();
  assert(payload.endpoint === fresh.endpoint, 'granted prompt → subscription payload');
  assert(
    lastSubscribeOptions.userVisibleOnly === true &&
      lastSubscribeOptions.applicationServerKey instanceof Uint8Array,
    'subscribe uses userVisibleOnly + converted VAPID key',
  );

  // Prompt → denied stops with a safe message.
  installBrowserStubs({ permission: 'default', requestPermission: async () => 'denied' });
  try {
    await subscribeBrowserPush();
    assert(false, 'denied prompt → throws');
  } catch (error) {
    assert(error instanceof PushError, 'denied prompt → PushError');
  }

  // A failing permission request surfaces safely.
  installBrowserStubs({
    permission: 'default',
    requestPermission: () => Promise.reject(new Error('boom')),
  });
  try {
    await subscribeBrowserPush();
    assert(false, 'failing request → throws');
  } catch (error) {
    assert(error instanceof PushError, 'failing request → PushError');
  }
}

async function testSubscription(): Promise<void> {
  console.log('\nsubscription');

  // An existing browser subscription is reused, never duplicated.
  const existing = fakeSubscription('https://push.example.com/existing');
  installBrowserStubs({ existingSubscription: existing, subscribeResult: existing });
  const reused = await subscribeBrowserPush();
  assert(subscribeCalls === 0, 'existing subscription → PushManager.subscribe not called');
  assert(
    reused.endpoint === existing.endpoint &&
      reused.p256dh === 'cDEyMzQ1Njc4' &&
      reused.auth === 'YXV0aHNlY3JldA' &&
      reused.userAgent === 'UmodziTestBrowser/1.0',
    'payload maps endpoint/keys/userAgent exactly',
  );

  // Incomplete browser keys are rejected, not posted.
  installBrowserStubs({
    existingSubscription: fakeSubscription('https://push.example.com/broken', false),
  });
  try {
    await subscribeBrowserPush();
    assert(false, 'keyless subscription → throws');
  } catch (error) {
    assert(error instanceof PushError, 'keyless subscription → PushError');
  }

  // A failing PushManager.subscribe surfaces safely.
  installBrowserStubs({ subscribeError: true });
  try {
    await subscribeBrowserPush();
    assert(false, 'failing subscribe → throws');
  } catch (error) {
    assert(
      error instanceof PushError && error.message === 'The browser subscription failed.',
      'failing subscribe → safe PushError',
    );
  }

  // API registration posts the exact Backend shape — and nothing else.
  stubFetch(201, {
    data: {
      id: 'sub-1',
      endpoint: existing.endpoint,
      userAgent: 'UmodziTestBrowser/1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const saved = await postPushSubscription({
    endpoint: existing.endpoint,
    p256dh: 'cDEyMzQ1Njc4',
    auth: 'YXV0aHNlY3JldA',
    userAgent: 'UmodziTestBrowser/1.0',
  });
  assert(saved.id === 'sub-1', 'POST returns the saved subscription');
  assert(
    lastCall?.url === 'http://localhost:9999/api/v1/me/push-subscriptions' &&
      lastCall?.method === 'POST',
    'POST targets /me/push-subscriptions',
  );
  const sentBody = JSON.parse(lastCall?.body ?? '{}') as Record<string, unknown>;
  assert(
    sentBody.endpoint === existing.endpoint &&
      sentBody.p256dh === 'cDEyMzQ1Njc4' &&
      sentBody.auth === 'YXV0aHNlY3JldA' &&
      sentBody.userAgent === 'UmodziTestBrowser/1.0' &&
      !('user_id' in sentBody) &&
      !('userId' in sentBody) &&
      !('keys' in sentBody) &&
      JSON.stringify(sentBody).indexOf('PRIVATE') === -1,
    'POST body carries exactly endpoint/p256dh/auth/userAgent',
  );

  // API failures surface with their status for safe UI mapping.
  stubFetch(401, { error: 'Authentication required' });
  try {
    await postPushSubscription({ endpoint: existing.endpoint, p256dh: 'k', auth: 'a' });
    assert(false, 'API 401 → throws');
  } catch (error) {
    assert(error instanceof ApiError && error.status === 401, 'API 401 → ApiError(401)');
  }

  // VAPID key conversion.
  const bytes = urlBase64ToUint8Array(FAKE_KEY);
  assert(bytes instanceof Uint8Array && bytes.length === 65, 'valid key converts to 65 bytes');
  try {
    urlBase64ToUint8Array('!!!not-base64!!!');
    assert(false, 'invalid key → throws');
  } catch (error) {
    assert(error instanceof PushError, 'invalid key → PushError');
  }
}

async function testLinkageAndUnsubscribe(): Promise<void> {
  console.log('\nlinkage + unsubscribe');
  installLocalStorageStub();

  assert(linkedSubscriptionId('https://x') === null, 'unknown endpoint has no link');
  rememberSubscriptionId('https://push.example.com/a', 'id-a');
  assert(linkedSubscriptionId('https://push.example.com/a') === 'id-a', 'link remembered');
  forgetSubscriptionId('https://push.example.com/a');
  assert(linkedSubscriptionId('https://push.example.com/a') === null, 'link forgotten');

  // Unsubscribe removes the browser subscription.
  const sub = fakeSubscription('https://push.example.com/gone');
  installBrowserStubs({ existingSubscription: sub });
  installLocalStorageStub();
  rememberSubscriptionId(sub.endpoint, 'id-gone');
  assert((await unsubscribeBrowserPush()) === true, 'existing sub → unsubscribed');
  assert(sub.unsubscribeCalls === 1, 'browser unsubscribe() called once');

  // DELETE targets the linked backend id and nothing else.
  stubFetch(200, { data: { deleted: true } });
  const deleted = await deletePushSubscription('id-gone');
  assert(deleted.deleted === true, 'DELETE returns the deleted flag');
  assert(
    lastCall?.url === 'http://localhost:9999/api/v1/me/push-subscriptions/id-gone' &&
      lastCall?.method === 'DELETE',
    'DELETE targets the linked subscription id',
  );

  // No browser subscription → false, no throw, no backend call.
  installBrowserStubs({ existingSubscription: null });
  lastCall = null;
  assert((await unsubscribeBrowserPush()) === false, 'no sub → false');
  assert(lastCall === null, 'no sub → no backend call');

  removeLocalStorageStub();
}

async function testSecretHygiene(): Promise<void> {
  console.log('\nsecret hygiene');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const frontendRoot = path.join(here, '..');
  const scanned = [
    'lib/push/webPush.ts',
    'lib/api/pushApi.ts',
    'components/PushSubscriptionControl.tsx',
    'public/sw.js',
    'app/dashboard/DashboardHome.tsx',
    'app/dashboard/ConsumerDashboard.tsx',
    'app/dashboard/AdminOverview.tsx',
    '.env.example',
  ];
  for (const relative of scanned) {
    const content = fs.readFileSync(path.join(frontendRoot, relative), 'utf8');
    assert(
      !content.includes('VAPID_PRIVATE'),
      `${relative} never references the VAPID private key`,
    );
    assert(
      !content.includes('SUPABASE_SERVICE_ROLE') && !content.includes('JWT_SECRET'),
      `${relative} exposes no backend secret`,
    );
  }
  const envExample = fs.readFileSync(path.join(frontendRoot, '.env.example'), 'utf8');
  assert(
    envExample.includes('NEXT_PUBLIC_VAPID_PUBLIC_KEY'),
    'frontend .env.example documents the public key',
  );
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testFeatureDetection();
  await testPermission();
  await testSubscription();
  await testLinkageAndUnsubscribe();
  await testSecretHygiene();
  removeBrowserStubs();
  removeLocalStorageStub();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error('Test runner crashed:', error);
  process.exitCode = 1;
});
