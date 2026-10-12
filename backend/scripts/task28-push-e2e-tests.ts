/**
 * Task 28.2E tests: end-to-end push chain over REAL infrastructure —
 * running backend (real VAPID from its environment), real web-push
 * encryption, and a LOCAL stub push service answering with real HTTP
 * statuses. Google/Mozilla are never contacted; only the far-end push
 * service is stubbed.
 *
 * Chain verified: register/login → POST /me/push-subscriptions (real API)
 * → push_subscriptions row → business event (offer accept) → notification
 * row → inline D6 delivery → encrypted POST observed at the stub →
 * notification marked sent. Then: second device, unsubscribe, and
 * 404-prune legs.
 *
 * Browser permission/display hops are NOT covered here (automation
 * browsers deny Notification.permission — recorded as a limitation and
 * covered separately via live browser checks, not fabricated).
 *
 * Run from the backend folder with a RUNNING backend whose process has
 * REAL VAPID configuration (do NOT strip VAPID for this suite):
 *   $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *   $env:ADMIN_EMAIL='admin@umodzi.test'
 *   $env:ADMIN_PASSWORD='…'
 *   npx tsx scripts/task28-push-e2e-tests.ts
 */

import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { query } from '../src/db/client.js';

// Same test-only TLS trust as the D6 suite: throwaway self-signed cert in
// the OS temp dir, test process only — never production code.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

/* ------------------------------------------------------------------ */
/* Stub push service                                                   */
/* ------------------------------------------------------------------ */

const hits: Record<string, number> = {};
let encryptedPosts = 0;

function stubCredentials(): { key: Buffer; cert: Buffer } {
  const dir = os.tmpdir();
  try {
    return {
      key: fs.readFileSync(path.join(dir, 'd6-push-test-key.pem')),
      cert: fs.readFileSync(path.join(dir, 'd6-push-test-cert.pem')),
    };
  } catch {
    throw new Error('Missing stub push-service TLS credentials in the OS temp dir.');
  }
}

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
      encryptedPosts += 1;
    }
    if (url.startsWith('/gone')) {
      res.writeHead(410);
      res.end();
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
const PASSWORD = 'Task28PushE2e!42';
const EMAIL_C = `pushe2e-c-282e-${RUN}@umodzi.test`;
const EMAIL_T = `pushe2e-t-282e-${RUN}@umodzi.test`;

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

interface Session {
  userId: string;
  token: string;
}

async function registerAndLogin(
  email: string,
  firstName: string,
  role: 'customer' | 'technician',
): Promise<Session> {
  const extra =
    role === 'technician' ? { category: 'Electrical', serviceArea: 'Kitwe' } : {};
  const reg = await api('POST', '/auth/register', {
    body: { email, password: PASSWORD, firstName, lastName: 'E2e', role, ...extra },
  });
  assert(reg.status === 201, `registration ${email} → 201`);
  const login = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  assert(login.status === 200, `login ${email} → 200`);
  const user = login.body?.data?.user as { id: string };
  return { userId: user.id, token: login.body?.data?.accessToken as string };
}

async function subscribeBrowser(
  session: Session,
  devicePath: string,
): Promise<{ id: string; endpoint: string }> {
  const keys = await makeSubscriberKeys();
  const endpoint = `https://127.0.0.1:${port}${devicePath}`;
  const res = await api('POST', '/me/push-subscriptions', {
    token: session.token,
    body: { endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: 'E2eDevice/1.0' },
  });
  assert(res.status === 201 || res.status === 200, `subscribe ${devicePath} → ${res.status}`);
  return { id: res.body?.data?.id as string, endpoint };
}

/* ------------------------------------------------------------------ */
/* Chain                                                               */
/* ------------------------------------------------------------------ */

/**
 * Offers are created inside POST /requests by the server-side dispatch
 * cascade — Task 28's manual `POST /offers` endpoint no longer exists
 * (server-side dispatch replaced it). Poll briefly for the pending offer
 * the cascade created for OUR technician and return its id.
 */
async function waitForDispatchOffer(
  customerToken: string,
  requestId: string,
  technicianId: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const res = await api('GET', `/requests/${requestId}/offers`, {
      token: customerToken,
    });
    const list = (Array.isArray(res.body?.data) ? res.body.data : []) as Array<{
      id: string;
      status: string;
      technicianId: string;
    }>;
    const offer = list.find((o) => o.technicianId === technicianId && o.status === 'pending');
    if (offer) return offer.id;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

// Baseline captured before fixtures: the shared database carries state
// from other flows (scratch-era hard-coded counts drifted), so cleanup
// proves its own rows are gone by restoring the exact starting counts.
let baselineNotifications = -1;
let baselineTechnicians = -1;

async function main(): Promise<void> {
  const baseNotifs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  const baseTechs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM technicians');
  baselineNotifications = Number(baseNotifs[0].n);
  baselineTechnicians = Number(baseTechs[0].n);
  port = await stubPort();
  console.log('\nchain: register → subscribe → offer → accept → encrypted push observed');

  const customer = await registerAndLogin(EMAIL_C, 'E2eCust', 'customer');
  const tech = await registerAndLogin(EMAIL_T, 'E2eTech', 'technician');
  await query(
    `UPDATE technicians SET verified = true, verification_status = 'verified',
       account_status = 'active', availability_status = 'available', updated_at = NOW()
     WHERE user_id = $1`,
    [tech.userId],
  );
  const meTech = await api('GET', '/auth/me', { token: tech.token });
  const techProfileId = meTech.body?.data?.user?.technicianId as string;

  // Two devices for the customer.
  const laptop = await subscribeBrowser(customer, `/e2e-laptop-${RUN}`);
  const phone = await subscribeBrowser(customer, `/e2e-phone-${RUN}`);
  const subRows = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = $1',
    [customer.userId],
  );
  assert(Number(subRows[0].n) === 2, 'both device subscriptions persisted');

  // Business event: request → offer → accept (notifies the customer).
  const created = await api('POST', '/requests', {
    token: customer.token,
    body: {
      description: `TASK282E-API e2e request ${RUN} with enough detail`,
      category: 'Electrical',
      city: 'Kitwe',
    },
  });
  assert(created.status === 201, 'request → 201');
  const requestId = created.body?.data?.id as string;
  const offerId = await waitForDispatchOffer(customer.token, requestId, techProfileId);
  assert(offerId !== null, 'dispatch created the offer for our technician');
  const accepted = await api('POST', `/offers/${offerId}/accept`, { token: tech.token });
  assert(accepted.status === 200, 'accept → 200');

  // The accept hook recorded + delivered: row sent, BOTH devices hit.
  const rows = await query<{
    id: string;
    type: string;
    status: string;
    sent_at: string | null;
    provider_message_id: string | null;
  }>(
    `SELECT id, type, status, sent_at, provider_message_id FROM notifications
     WHERE user_id = $1 AND type = 'dispatch_offer_accepted' AND reference_id = $2`,
    [customer.userId, offerId],
  );
  assert(rows.length === 1, 'accept notification recorded for the customer');
  assert(rows[0].status === 'sent', 'notification marked sent on real acceptance');
  assert(rows[0].sent_at !== null, 'sent_at recorded');
  assert(rows[0].provider_message_id === null, 'no provider id fabricated');
  assert(
    (hits[`/e2e-laptop-${RUN}`] ?? 0) === 1 && (hits[`/e2e-phone-${RUN}`] ?? 0) === 1,
    'both devices received exactly one encrypted push',
  );
  assert(encryptedPosts >= 2, 'push payloads were really encrypted');

  // Unsubscribe one device → next event reaches only the survivor.
  const del = await api('DELETE', `/me/push-subscriptions/${laptop.id}`, {
    token: customer.token,
  });
  assert(del.status === 200, 'unsubscribe laptop → 200');
  const created2 = await api('POST', '/requests', {
    token: customer.token,
    body: {
      description: `TASK282E-API second ${RUN} with enough detail here`,
      category: 'Electrical',
      city: 'Kitwe',
    },
  });
  const requestId2 = created2.body?.data?.id as string;
  const offerId2 = await waitForDispatchOffer(customer.token, requestId2, techProfileId);
  assert(offerId2 !== null, 'second dispatch offer created');
  const laptopBefore = hits[`/e2e-laptop-${RUN}`] ?? 0;
  const phoneBefore = hits[`/e2e-phone-${RUN}`] ?? 0;
  await api('POST', `/offers/${offerId2}/accept`, { token: tech.token });
  const rows2 = await query<{ status: string }>(
    `SELECT status FROM notifications WHERE user_id = $1 AND type = 'dispatch_offer_accepted' AND reference_id = $2`,
    [customer.userId, offerId2],
  );
  assert(rows2[0]?.status === 'sent', 'second accept still marked sent');
  assert(
    (hits[`/e2e-laptop-${RUN}`] ?? 0) === laptopBefore &&
      (hits[`/e2e-phone-${RUN}`] ?? 0) === phoneBefore + 1,
    'removed device gets nothing, survivor gets the push',
  );

  // Expired subscription is pruned on a 410 during a live event.
  const doomed = await subscribeBrowser(customer, '/gone-e2e');
  const created3 = await api('POST', '/requests', {
    token: customer.token,
    body: {
      description: `TASK282E-API third ${RUN} with enough detail here!`,
      category: 'Electrical',
      city: 'Kitwe',
    },
  });
  const requestId3 = created3.body?.data?.id as string;
  const offerId3 = await waitForDispatchOffer(customer.token, requestId3, techProfileId);
  assert(offerId3 !== null, 'third dispatch offer created');
  await api('POST', `/offers/${offerId3}/accept`, { token: tech.token });
  const doomedLeft = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM push_subscriptions WHERE id = $1',
    [doomed.id],
  );
  assert(Number(doomedLeft[0].n) === 0, '410 subscription pruned during a live event');

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function cleanup(): Promise<void> {
  console.log('\ncleanup — restoring the baseline (seeded admin preserved)');
  stub.close();
  await query(
    `DELETE FROM dispatch_offers WHERE request_id IN
       (SELECT id FROM service_requests WHERE description LIKE 'TASK282E-API %')`,
  );
  await query(`DELETE FROM service_requests WHERE description LIKE 'TASK282E-API %'`);
  await query(
    `DELETE FROM technicians WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE '%@umodzi.test')`,
  );
  await query(`DELETE FROM sessions`);
  await query(
    `DELETE FROM users WHERE lower(email) LIKE '%@umodzi.test' AND lower(email) <> lower($1)`,
    [ADMIN_EMAIL as string],
  );

  const notifs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM notifications');
  const subs = await query<{ n: string }>('SELECT COUNT(*) AS n FROM push_subscriptions');
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

  assert(
    Number(notifs[0].n) === baselineNotifications,
    `notifications back to the baseline count (${baselineNotifications})`,
  );
  assert(Number(subs[0].n) === 0, 'no push subscriptions remain');
  assert(Number(users[0].n) === 0, 'no fixture accounts remain');
  assert(
    Number(techs[0].n) === baselineTechnicians,
    `technicians back to the baseline count (${baselineTechnicians})`,
  );
  assert(Number(sessions[0].n) === 0, 'no sessions remain');
  assert(Number(admin[0].n) === 1, 'seeded administrator preserved');
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
