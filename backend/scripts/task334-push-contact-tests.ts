/**
 * Task 33.4 suite: Web Push integration + contact/call authorization,
 * against a RUNNING backend (start it first).
 *
 * Run from the backend folder:
 *   npx --no-install tsx scripts/task334-push-contact-tests.ts
 *
 * Requires DATABASE_URL plus ADMIN_EMAIL/ADMIN_PASSWORD in backend/.env
 * (same convention as task331-chat-e2e-tests.ts). The suite registers
 * isolated `task334.*@umodzi.test` fixtures, drives the real HTTP surface,
 * then DELETES every row it created (phone rows, push subscriptions,
 * notifications, requests cascade offers/conversations/messages, technician
 * profile + verification document + file, fixture sessions, and its own
 * revoked admin session). Audit events are security records and are
 * deliberately NEVER deleted.
 *
 * Covers (Phase 3 of Task 33.4):
 *   Push registration/removal — POST /me/push-subscriptions stores against
 *     the AUTHENTICATED user (never the body), re-post rotates keys on the
 *     same row (no duplicate), new endpoint = new row, strict schema 400s,
 *     anonymous 401; DELETE is owner-scoped (other user → identical 404,
 *     row retained; double delete → 404; malformed id → 400).
 *   Chat push pipeline — every persisted message creates exactly ONE
 *     notification row for the RECIPIENT ONLY (sender: none, unrelated:
 *     none); generic minimal payload (no message text ever enters the
 *     notification); reference stays conversation-scoped for the inbox
 *     deep link; failed sends (400/401/404) create NOTHING (no
 *     notification before persistence succeeds); delivery attempted
 *     post-persistence with honest sent/failed outcomes — zero
 *     subscriptions → honest "No push subscriptions" reason; an
 *     unreachable endpoint → honest failure, message delivery unaffected,
 *     subscription retained (network failure is not expiry).
 *   Contact/call authorization — participant-to-participant reads return
 *     the OTHER participant's REAL stored number (exact match both ways),
 *     `tel:` is a safe encoded form; unrelated user → 404, anonymous →
 *     401, administrator → 404 (role is never an access grant); missing
 *     number → honest 404; invalid numbers are rejected at write time and
 *     never stored; /me/phone is strictly self-scoped; admin user payloads
 *     carry no phone field and never contain the fixture numbers.
 *
 * G-4 regression (found in Phase 1): chat_message deduped on the
 * CONVERSATION natural key, so only the first message of a conversation
 * ever produced a notification — messages 2..N were silently suppressed.
 * The `second message also notifies` assertions below FAIL against the
 * pre-fix build and pass after the fix.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const API = 'http://localhost:3001/api/v1';
const RUN = Date.now().toString(36);
const PW = 'Task334-Push-Pw!42';
const CUSTOMER_EMAIL = `task334.customer.${RUN}@umodzi.test`;
const TECH_EMAIL = `task334.technician.${RUN}@umodzi.test`;
const OTHER_EMAIL = `task334.other.${RUN}@umodzi.test`;
const adminEmail = process.env.ADMIN_EMAIL?.trim();
const adminPassword = process.env.ADMIN_PASSWORD;
if (!process.env.DATABASE_URL || !adminEmail || !adminPassword) {
  console.error('Need DATABASE_URL + ADMIN_EMAIL/ADMIN_PASSWORD in backend/.env');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, extra = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}${extra}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra}`);
  }
}

function makeClient() {
  const jar: string[] = [];
  let bearer: string | null = null;
  return {
    setBearer(t: string | null) {
      bearer = t;
    },
    async call(path: string, init: RequestInit = {}) {
      const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
      if (jar.length > 0) headers.cookie = jar.join('; ');
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      let body = init.body;
      if (body && typeof body === 'object' && !(body instanceof FormData)) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(body);
      }
      const res = await fetch(API + path, { ...init, headers, body: body as BodyInit });
      const setCookies = res.headers.getSetCookie?.() ?? [];
      for (const sc of setCookies) {
        const pair = sc.split(';')[0];
        const name = pair.split('=')[0];
        const idx = jar.findIndex((c) => c.split('=')[0] === name);
        if (idx >= 0) jar[idx] = pair;
        else jar.push(pair);
      }
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-json */
      }
      return { status: res.status, text, json: json as never };
    },
    async login(email: string, password: string) {
      const r = await this.call('/auth/login', { method: 'POST', body: { email, password } });
      if (r.status === 200)
        this.setBearer((r.json as { data: { accessToken: string } })?.data?.accessToken ?? null);
      return r;
    },
  };
}
type Client = ReturnType<typeof makeClient>;

// Minimal valid 1x1 PNG (magic bytes carry, no personal content).
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

const M1 = `TASK334-M1-${RUN} the kitchen tap is leaking again.`;
const M2 = `TASK334-M2-${RUN} I can come by this afternoon.`;
const M3 = `TASK334-M3-${RUN} sounds good, see you then.`;

const CUST_PHONE_RAW = '0971 234 567';
const CUST_PHONE = '+260971234567';
const TECH_PHONE_RAW = '+260977 654321';
const TECH_PHONE = '+260977654321';

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Real P-256 subscription keys, exactly like a browser would produce. */
async function makeSubscriberKeys(): Promise<{ p256dh: string; auth: string }> {
  const keyPair = await crypto.webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const raw = new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  return { p256dh: base64url(raw), auth: base64url(crypto.randomBytes(16)) };
}

/** A port that is guaranteed closed at call time (bind, read, close). */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function chatRows(userId: string, convId: string) {
  const r = await pool.query(
    `SELECT id, type, title, message, channel, reference_type, reference_id, status,
            failure_reason, sent_at
       FROM notifications
      WHERE user_id = $1 AND type = 'chat_message' AND reference_id = $2`,
    [userId, convId],
  );
  return r.rows as {
    id: string;
    type: string;
    title: string;
    message: string;
    channel: string;
    reference_type: string;
    reference_id: string;
    status: string;
    failure_reason: string | null;
    sent_at: string | null;
  }[];
}

/** Recursively collect every object key of a JSON payload. */
function collectKeys(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

/**
 * Remove every task334 fixture row (safe to run at start AND end: the
 * prefix only ever matches this suite's own fixtures — other users,
 * sessions and audit history are never touched). Called at startup so a
 * previously crashed run cannot strand fixtures or skew dispatch.
 */
async function sweepTaskFixtures(): Promise<number> {
  const ids = (
    await pool.query(`SELECT id FROM users WHERE lower(email) LIKE 'task334.%@umodzi.test'`)
  ).rows.map((r: { id: string }) => r.id) as string[];
  if (ids.length === 0) return 0;
  await pool.query(`DELETE FROM push_subscriptions WHERE user_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM user_phones WHERE user_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM service_requests WHERE customer_user_id = ANY($1)`, [ids]);
  const techIds = (
    await pool.query(`SELECT id FROM technicians WHERE user_id = ANY($1)`, [ids])
  ).rows.map((r: { id: string }) => r.id) as string[];
  await pool.query(`DELETE FROM technician_verification_documents WHERE technician_id = ANY($1)`, [
    techIds.length > 0 ? techIds : ['00000000-0000-0000-0000-000000000000'],
  ]);
  for (const techId of techIds) {
    const dir = join(process.cwd(), 'var', 'uploads', 'verification', techId);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  }
  await pool.query(`DELETE FROM technicians WHERE user_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [ids]);
  const du = await pool.query(`DELETE FROM users WHERE lower(email) LIKE 'task334.%@umodzi.test'`);
  return du.rowCount ?? 0;
}

async function main(): Promise<void> {
  const runStart = new Date();
  const swept = await sweepTaskFixtures();
  if (swept > 0) console.log(`  swept ${swept} leftover fixture user(s) from an earlier run`);
  const auditBefore = Number(
    (await pool.query(`SELECT count(*)::int n FROM audit_events`)).rows[0].n as number,
  );

  const cust = makeClient();
  const tech = makeClient();
  const other = makeClient();
  const admin = makeClient();
  const anon = makeClient();

  // ---- fixtures: register + login ----
  console.log('\nfixtures: 3 users + verified-technician relationship');
  for (const [c, payload] of [
    [cust, { email: CUSTOMER_EMAIL, firstName: 'Push', lastName: 'Customer', role: 'customer' }],
    [tech, { email: TECH_EMAIL, firstName: 'Push', lastName: 'Technician', role: 'technician', category: 'Plumbing', serviceArea: 'Kitwe' }],
    [other, { email: OTHER_EMAIL, firstName: 'Push', lastName: 'Bystander', role: 'customer' }],
  ] as const) {
    const r = await (c as Client).call('/auth/register', { method: 'POST', body: { ...payload, password: PW } });
    assert(r.status === 201, `registered ${(payload as { email: string }).email} (${r.status})`);
  }
  const lc = await cust.login(CUSTOMER_EMAIL, PW);
  const lt = await tech.login(TECH_EMAIL, PW);
  const lo = await other.login(OTHER_EMAIL, PW);
  assert(lc.status === 200 && lt.status === 200 && lo.status === 200, 'all fixtures logged in');
  const custId = (lc.json as { data: { user: { id: string } } })?.data?.user?.id as string;
  const techUserId = (lt.json as { data: { user: { id: string } } })?.data?.user?.id as string;
  const otherId = (lo.json as { data: { user: { id: string } } })?.data?.user?.id as string;
  const fixtureIds = [custId, techUserId, otherId];

  // ---- verification chain (real workflow, admin-scoped) ----
  const form = new FormData();
  form.append('documentType', 'national_id');
  form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'national-id.png');
  const up = await tech.call('/technician/verification/documents', { method: 'POST', body: form });
  assert(up.status === 201 || up.status === 200, `ID document uploaded (${up.status})`);
  const sub = await tech.call('/technician/verification/submit', { method: 'POST' });
  assert(sub.status === 200 || sub.status === 201, `verification submitted (${sub.status})`);
  const prof = await tech.call('/technician/profile');
  const techProfileId = (prof.json as { data: { id: string } })?.data?.id as string;
  const aLogin = await admin.login(adminEmail as string, adminPassword as string);
  assert(aLogin.status === 200, `admin login (${aLogin.status})`);
  const adminId = (aLogin.json as { data: { user: { id: string } } })?.data?.user?.id as string;
  const decide = await admin.call(`/admin/technicians/${techProfileId}/verification`, {
    method: 'PATCH',
    body: { decision: 'verified' },
  });
  assert(decide.status === 200, `fixture tech verified (${decide.status})`);
  // Administrator metadata surfaces must never carry phone fields.
  const aUsers = await admin.call('/admin/users');
  const aKeys = collectKeys(aUsers.json);
  assert(
    aUsers.status === 200 && ![...aKeys].some((k) => /phone|msisdn|telephone/i.test(k)),
    'admin user list carries no phone field',
  );
  await admin.call('/auth/logout', { method: 'POST' });
  admin.setBearer(null);

  // ---- request → dispatch offer → accept (conversation created) ----
  const req = await cust.call('/requests', {
    method: 'POST',
    body: {
      description: 'Task334 suite request — geyser pressure drops at night.',
      category: 'Plumbing',
      city: 'Kitwe',
    },
  });
  assert(req.status === 201, `request created (${req.status})`);
  const requestId = (req.json as { data: { id: string } })?.data?.id as string;
  const offers = await cust.call(`/requests/${requestId}/offers`);
  const list = ((offers.json as {
    data?: { offers?: { id: string; status: string; technicianId: string }[] };
  })?.data?.offers ??
    (offers.json as { data?: { id: string; status: string; technicianId: string }[] })?.data ??
    []) as { id: string; status: string; technicianId: string }[];
  const offerId = (Array.isArray(list) ? list : []).find(
    (o) => o.status === 'pending' && o.technicianId === techProfileId,
  )?.id;
  assert(
    typeof offerId === 'string',
    'dispatch offered to THIS run’s verified tech',
    typeof offerId === 'string' ? '' : ' (another eligible tech won — clear leftovers and rerun)',
  );
  const accept = await cust.call(`/offers/${offerId}/accept`, { method: 'POST' });
  assert(accept.status === 200, `offer accepted (${accept.status})`);
  const cc = await cust.call(`/requests/${requestId}/conversation`);
  const convId = (cc.json as { data: { conversation: { id: string } } })?.data?.conversation?.id as string;
  assert(cc.status === 200 && typeof convId === 'string', 'conversation resolved');

  /* ================================================================== */
  /* Part A — push subscription registration & removal                  */
  /* ================================================================== */
  console.log('\nA. push subscription registration/removal');

  const keysA = await makeSubscriberKeys();
  const endpointA = `https://push.example.test/task334-device-a-${RUN}`;
  const anonPost = await anon.call('/me/push-subscriptions', {
    method: 'POST',
    body: { endpoint: endpointA, p256dh: keysA.p256dh, auth: keysA.auth },
  });
  assert(anonPost.status === 401, `anonymous register → 401 (${anonPost.status})`);

  const badProto = await cust.call('/me/push-subscriptions', {
    method: 'POST',
    body: { endpoint: `http://insecure.test/${RUN}`, p256dh: keysA.p256dh, auth: keysA.auth },
  });
  assert(badProto.status === 400, `non-HTTPS endpoint → 400 (${badProto.status})`);

  const forged = await cust.call('/me/push-subscriptions', {
    method: 'POST',
    body: { endpoint: endpointA, p256dh: keysA.p256dh, auth: keysA.auth, userId: otherId },
  });
  assert(forged.status === 400, `user_id in body rejected by strict schema (${forged.status})`);

  const reg1 = await cust.call('/me/push-subscriptions', {
    method: 'POST',
    body: { endpoint: endpointA, p256dh: keysA.p256dh, auth: keysA.auth, userAgent: 'Task334Test/1.0' },
  });
  assert(reg1.status === 201 || reg1.status === 200, `register device A → ${reg1.status}`);
  const subAId = (reg1.json as { data?: { id?: string } })?.data?.id as string | undefined;
  const regKeys = Object.keys(((reg1.json as { data?: object })?.data ?? {}) as object);
  assert(
    typeof subAId === 'string' && !regKeys.includes('p256dh') && !regKeys.includes('auth'),
    'response exposes id/endpoint only — never the key material',
    ` [${regKeys.join(',')}]`,
  );
  const rowA = (
    await pool.query(`SELECT user_id, p256dh, auth FROM push_subscriptions WHERE endpoint = $1`, [endpointA])
  ).rows as { user_id: string; p256dh: string; auth: string }[];
  assert(
    rowA.length === 1 && rowA[0].user_id === custId && rowA[0].p256dh === keysA.p256dh,
    'stored against the AUTHENTICATED user with the exact keys',
  );

  // Re-post the same endpoint: rotate keys on the same row, no duplicate.
  const rotatedAuth = base64url(crypto.randomBytes(16));
  const reg2 = await cust.call('/me/push-subscriptions', {
    method: 'POST',
    body: { endpoint: endpointA, p256dh: keysA.p256dh, auth: rotatedAuth },
  });
  const rowA2 = (
    await pool.query(`SELECT id, auth FROM push_subscriptions WHERE endpoint = $1`, [endpointA])
  ).rows as { id: string; auth: string }[];
  assert(reg2.status === 200, `re-register same endpoint → 200 update (${reg2.status})`);
  assert(
    rowA2.length === 1 && rowA2[0].auth === rotatedAuth,
    're-register rotates keys on ONE row (no duplicate)',
  );

  // A second endpoint creates a second row (multi-device).
  const keysB = await makeSubscriberKeys();
  const endpointB = `https://push.example.test/task334-device-b-${RUN}`;
  const reg3 = await cust.call('/me/push-subscriptions', {
    method: 'POST',
    body: { endpoint: endpointB, p256dh: keysB.p256dh, auth: keysB.auth },
  });
  const custSubs = (
    await pool.query(`SELECT id, endpoint FROM push_subscriptions WHERE user_id = $1`, [custId])
  ).rows as { id: string; endpoint: string }[];
  assert(reg3.status === 201 && custSubs.length === 2, 'second endpoint → second row (multi-device)');

  const subBId = custSubs.find((s) => s.endpoint === endpointB)?.id as string;
  const otherDelete = await other.call(`/me/push-subscriptions/${subBId}`, { method: 'DELETE' });
  const subBStill = (
    await pool.query(`SELECT id FROM push_subscriptions WHERE id = $1`, [subBId])
  ).rows.length;
  assert(otherDelete.status === 404 && subBStill === 1, 'other user’s DELETE → 404, row retained');
  const anonDelete = await anon.call(`/me/push-subscriptions/${subBId}`, { method: 'DELETE' });
  assert(anonDelete.status === 401, `anonymous DELETE → 401 (${anonDelete.status})`);
  const malformedDelete = await cust.call('/me/push-subscriptions/not-a-uuid', { method: 'DELETE' });
  assert(malformedDelete.status === 400, `malformed DELETE id → 400 (${malformedDelete.status})`);
  const delA = await cust.call(`/me/push-subscriptions/${subAId}`, { method: 'DELETE' });
  const subAGone = (
    await pool.query(`SELECT id FROM push_subscriptions WHERE id = $1`, [subAId])
  ).rows.length;
  assert(delA.status === 200 && subAGone === 0, 'owner DELETE → 200, row removed');
  const delA2 = await cust.call(`/me/push-subscriptions/${subAId}`, { method: 'DELETE' });
  assert(delA2.status === 404, `double DELETE → 404 (${delA2.status})`);
  const delB = await cust.call(`/me/push-subscriptions/${subBId}`, { method: 'DELETE' });
  assert(delB.status === 200, 'owner DELETE device B → 200');

  /* ================================================================== */
  /* Part A — chat messages → notification rows → push attempt          */
  /* ================================================================== */
  console.log('\nB. chat → notification pipeline (recipient, payload, ordering)');

  const rows0t = await chatRows(techUserId, convId);
  const rows0c = await chatRows(custId, convId);
  const rows0o = await chatRows(otherId, convId);
  assert(
    rows0t.length === 0 && rows0c.length === 0 && rows0o.length === 0,
    'no chat notifications exist before any message',
  );

  // M1: customer → technician (recipient has ZERO subscriptions).
  const s1 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M1 } });
  assert(s1.status === 201, `M1 persisted (${s1.status})`);
  const t1 = await chatRows(techUserId, convId);
  const c1 = await chatRows(custId, convId);
  const o1 = await chatRows(otherId, convId);
  assert(t1.length === 1, 'M1 → exactly one row for the RECIPIENT', ` (${t1.length})`);
  assert(c1.length === 0, 'M1 → zero rows for the SENDER');
  assert(o1.length === 0, 'M1 → zero rows for an UNRELATED user');
  if (t1.length > 0) {
    const r = t1[0];
    assert(
      r.title === 'New message' && r.message === 'You have received a new message.',
      'payload is generic (no message text)',
      ` [${r.title} / ${r.message}]`,
    );
    assert(
      !r.message.includes('TASK334-M1') && !r.title.includes('TASK334-M1'),
      'notification never contains the message body',
    );
    assert(
      r.reference_type === 'conversation' && r.reference_id === convId && r.channel === 'in_app',
      'reference stays conversation-scoped (inbox deep link intact)',
    );
    assert(
      r.status === 'failed' && r.failure_reason === 'No push subscriptions registered for this user.',
      'zero subscriptions → honest failed status + reason',
      ` [${r.status} / ${r.failure_reason}]`,
    );
    assert(r.sent_at === null, 'sent_at stays NULL on failure');
  }

  // M2: the SECOND message of the conversation must ALSO notify (G-4).
  const s2 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M2 } });
  assert(s2.status === 201, `M2 persisted (${s2.status})`);
  const t2 = await chatRows(techUserId, convId);
  const c2 = await chatRows(custId, convId);
  assert(t2.length === 2, 'M2 → recipient gets a SECOND row (not suppressed)', ` (${t2.length})`);
  assert(c2.length === 0, 'M2 → sender still has zero rows');
  assert(
    new Set([...t1, ...t2].map((r) => r.id)).size === t2.length,
    'rows are distinct (one row per message)',
  );

  // M3: technician → customer, recipient has an UNREACHABLE subscription.
  const deadPort = await closedPort();
  const keysDead = await makeSubscriberKeys();
  const deadEndpoint = `https://127.0.0.1:${deadPort}/task334-dead-${RUN}`;
  const regDead = await cust.call('/me/push-subscriptions', {
    method: 'POST',
    body: { endpoint: deadEndpoint, p256dh: keysDead.p256dh, auth: keysDead.auth },
  });
  assert(regDead.status === 201 || regDead.status === 200, 'recipient registers unreachable subscription');

  const tBefore = (await chatRows(techUserId, convId)).length;
  const s3 = await tech.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M3 } });
  assert(s3.status === 201, `M3 persisted despite failing push delivery (${s3.status})`);
  const c3 = await chatRows(custId, convId);
  const t3 = await chatRows(techUserId, convId);
  assert(c3.length === 1, 'M3 → one row for customer (the recipient)', ` (${c3.length})`);
  assert(t3.length === tBefore, 'M3 → sender (technician) gains nothing');
  const m3read = await cust.call(`/conversations/${convId}/messages?limit=20`);
  const m3msgs =
    ((m3read.json as { data?: { messages?: { message: string }[] } })?.data?.messages ?? []);
  assert(m3msgs.some((m) => m.message === M3), 'M3 message persisted and retrievable');
  if (c3.length > 0) {
    const r = c3[0];
    assert(
      r.status === 'failed' &&
        typeof r.failure_reason === 'string' &&
        r.failure_reason.includes('failed') &&
        !r.failure_reason.includes('No push subscriptions'),
      'unreachable endpoint → honest delivery failure (attempted, not "no subscriptions")',
      ` [${r.status} / ${r.failure_reason}]`,
    );
    assert(
      !String(r.failure_reason).includes('http') &&
        !String(r.failure_reason).includes('127.0.0.1') &&
        !String(r.failure_reason).includes(deadEndpoint),
      'failure reason leaks no endpoint',
    );
  }
  const deadRetained = (
    await pool.query(`SELECT id FROM push_subscriptions WHERE endpoint = $1`, [deadEndpoint])
  ).rows.length;
  assert(deadRetained === 1, 'network failure does NOT prune the subscription (only 404/410 do)');

  // Failed sends create NO notification for anyone (nothing before success).
  const beforeAll = fixtureIds.reduce(
    async (p, id) => (await p) + (await chatRows(id, convId)).length,
    Promise.resolve(0),
  );
  const f1 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: '   ' } });
  const f2 = await cust.call(`/conversations/${convId}/messages`, {
    method: 'POST',
    body: { message: 'x'.repeat(2001) },
  });
  const f3 = await other.call(`/conversations/${convId}/messages`, {
    method: 'POST',
    body: { message: 'TASK334-INTRUDER attempt here' },
  });
  const f4 = await anon.call(`/conversations/${convId}/messages`, {
    method: 'POST',
    body: { message: 'TASK334-ANON attempt here' },
  });
  assert(f1.status === 400 && f2.status === 400 && f3.status === 404 && f4.status === 401,
    `failed sends rejected (${f1.status}/${f2.status}/${f3.status}/${f4.status})`);
  const afterAll = fixtureIds.reduce(
    async (p, id) => (await p) + (await chatRows(id, convId)).length,
    Promise.resolve(0),
  );
  const beforeN = await beforeAll;
  const afterN = await afterAll;
  assert(beforeN === afterN, 'failed sends created NO notifications (3 messages → 3 rows)', ` (${beforeN} → ${afterN})`);
  assert(afterN === 3, 'exactly one notification row per persisted message', ` (${afterN})`);

  /* ================================================================== */
  /* Part B — contact/call authorization                                 */
  /* ================================================================== */
  console.log('\nC. contact/call authorization & phone correctness');

  const pPut = await cust.call('/me/phone', { method: 'PUT', body: { phone: CUST_PHONE_RAW } });
  assert(
    pPut.status === 200 && (pPut.json as { data?: { phone?: string } })?.data?.phone === CUST_PHONE,
    `customer stores own number → normalized ${CUST_PHONE} (${pPut.status})`,
  );
  const pBad = await cust.call('/me/phone', { method: 'PUT', body: { phone: 'abc123' } });
  assert(pBad.status === 400, `invalid number → 400, never stored (${pBad.status})`);
  const pGetAfterBad = await cust.call('/me/phone');
  assert(
    (pGetAfterBad.json as { data?: { phone?: string | null } })?.data?.phone === CUST_PHONE,
    'invalid write left the stored number untouched',
  );
  const tPut = await tech.call('/me/phone', { method: 'PUT', body: { phone: TECH_PHONE_RAW } });
  assert(
    tPut.status === 200 && (tPut.json as { data?: { phone?: string } })?.data?.phone === TECH_PHONE,
    `technician stores own number → normalized ${TECH_PHONE} (${tPut.status})`,
  );
  const cMe = await cust.call('/me/phone');
  const tMe = await tech.call('/me/phone');
  const oMe = await other.call('/me/phone');
  assert((cMe.json as { data?: { phone?: string } })?.data?.phone === CUST_PHONE, 'GET /me/phone → own number (customer)');
  assert((tMe.json as { data?: { phone?: string } })?.data?.phone === TECH_PHONE, 'GET /me/phone → own number (technician)');
  assert((oMe.json as { data?: { phone?: string | null } })?.data?.phone === null, 'GET /me/phone → null when none (never someone else’s)');

  const contactCust = await cust.call(`/requests/${requestId}/contact`);
  const cdC = (contactCust.json as { data?: { phone?: string; tel?: string; requestId?: string } })?.data;
  assert(contactCust.status === 200 && cdC?.phone === TECH_PHONE,
    'customer contact → the TECHNICIAN’s exact stored number', ` [${cdC?.phone}]`);
  assert(cdC?.tel === `tel:${TECH_PHONE}` && /^\+\d{9,15}$/.test(cdC?.phone ?? ''),
    'tel: is the properly encoded form of the normalized number', ` [${cdC?.tel}]`);
  assert(cdC?.requestId === requestId, 'contact echoes the requested request id');

  const contactTech = await tech.call(`/requests/${requestId}/contact`);
  const cdT = (contactTech.json as { data?: { phone?: string; tel?: string } })?.data;
  assert(contactTech.status === 200 && cdT?.phone === CUST_PHONE,
    'technician contact → the CUSTOMER’s exact stored number', ` [${cdT?.phone}]`);
  assert(cdT?.phone !== TECH_PHONE, 'a participant never receives their OWN number as "the contact"');
  assert(cdT?.tel === `tel:${CUST_PHONE}`, 'technician side tel: encoded correctly');

  const contactOther = await other.call(`/requests/${requestId}/contact`);
  assert(contactOther.status === 404, `unrelated participant → 404 (${contactOther.status})`);
  const contactAnon = await anon.call(`/requests/${requestId}/contact`);
  assert(contactAnon.status === 401, `anonymous contact → 401 (${contactAnon.status})`);
  const aLogin2 = await admin.login(adminEmail as string, adminPassword as string);
  assert(aLogin2.status === 200, `admin re-login for contact check (${aLogin2.status})`);
  const contactAdmin = await admin.call(`/requests/${requestId}/contact`);
  assert(contactAdmin.status === 404, `administrator → 404 (role is never a grant) (${contactAdmin.status})`);
  const bodyAdmin = contactAdmin.text;
  assert(
    !bodyAdmin.includes(CUST_PHONE) && !bodyAdmin.includes(TECH_PHONE),
    'denied contact response leaks no number',
  );
  await admin.call('/auth/logout', { method: 'POST' });
  admin.setBearer(null);

  // Missing contact information: remove the customer's number (own fixture),
  // then the technician's contact lookup must fail honestly.
  await pool.query(`DELETE FROM user_phones WHERE user_id = $1`, [custId]);
  const contactMissing = await tech.call(`/requests/${requestId}/contact`);
  assert(contactMissing.status === 404, `missing number → 404 (${contactMissing.status})`);
  assert(
    contactMissing.text.includes('No contact number is available'),
    'missing number → honest, human-readable reason',
  );
  const contactStillTech = await cust.call(`/requests/${requestId}/contact`);
  assert(
    contactStillTech.status === 200 &&
      (contactStillTech.json as { data?: { phone?: string } })?.data?.phone === TECH_PHONE,
    'the other direction still resolves (only the missing side fails)',
  );

  /* ================================================================== */
  /* Cleanup — only this run’s fixtures                                  */
  /* ================================================================== */
  console.log('\ncleanup');
  // The suite's own admin sessions: revoked by logout, removed by
  // run-window + revoked filter (pre-existing admin sessions untouched).
  const adminGone = await pool.query(
    `DELETE FROM sessions WHERE user_id = $1 AND revoked_at IS NOT NULL AND created_at >= $2`,
    [adminId, runStart.toISOString()],
  );
  const cleaned = await sweepTaskFixtures();
  console.log(`  cleanup: users=${cleaned}, admin sessions revoked+removed=${adminGone.rowCount}`);

  const one = async (sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows[0] as { n: number };
  const remain = {
    users: (await one(`SELECT count(*)::int n FROM users WHERE lower(email) LIKE 'task334.%'`)).n,
    subs: (await one(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id = ANY($1)`, [fixtureIds])).n,
    phones: (await one(`SELECT count(*)::int n FROM user_phones WHERE user_id = ANY($1)`, [fixtureIds])).n,
    notifs: (await one(`SELECT count(*)::int n FROM notifications WHERE user_id = ANY($1)`, [fixtureIds])).n,
    convMsgs: (await one(`SELECT count(*)::int n FROM messages WHERE conversation_id = $1`, [convId])).n,
  };
  assert(
    remain.users === 0 && remain.subs === 0 && remain.phones === 0 && remain.notifs === 0 && remain.convMsgs === 0,
    'all task fixtures removed',
    ` [${JSON.stringify(remain)}]`,
  );
  const adminStill = (await one(`SELECT count(*)::int n FROM users WHERE lower(email) = lower($1)`, [adminEmail])).n;
  assert(adminStill === 1, 'seeded admin preserved');
  const auditAfter = Number((await one(`SELECT count(*)::int n FROM audit_events`)).n);
  assert(auditAfter >= auditBefore, `audit history intact (never deleted: ${auditBefore} → ${auditAfter})`);
  console.log(
    `  baseline: users=${(await one(`SELECT count(*)::int n FROM users`)).n}` +
      ` requests=${(await one(`SELECT count(*)::int n FROM service_requests`)).n}` +
      ` conversations=${(await one(`SELECT count(*)::int n FROM conversations`)).n}` +
      ` messages=${(await one(`SELECT count(*)::int n FROM messages`)).n}` +
      ` subs=${(await one(`SELECT count(*)::int n FROM push_subscriptions`)).n}` +
      ` phones=${(await one(`SELECT count(*)::int n FROM user_phones`)).n}` +
      ` sessions=${(await one(`SELECT count(*)::int n FROM sessions`)).n}` +
      ` audit=${auditAfter}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  if (failed > 0) process.exitCode = 1;
}

void main();
