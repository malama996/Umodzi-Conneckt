/**
 * Task 33.1 chat E2E regression suite: the full consumer↔technician
 * conversation contract against a RUNNING backend (start it first).
 *
 * Run from the backend folder:
 *   npx --no-install tsx scripts/task331-chat-e2e-tests.ts
 *
 * Requires DATABASE_URL plus ADMIN_EMAIL/ADMIN_PASSWORD in backend/.env
 * (same convention as task23-api-tests.ts): the suite registers isolated
 * `@umodzi.test` fixtures, verifies the fixture technician through the
 * real admin decision endpoint, runs the matrix, then DELETES every row it
 * created (users cascade sessions; requests cascade offers/conversations/
 * messages; the technician profile, verification document row + file, and
 * run-created sessions are removed explicitly). Audit events are security
 * records and are deliberately NOT deleted.
 *
 * Covers: verification submit → admin decision → dispatch offer → customer
 * accept (request becomes matched, conversation created) → both sides
 * resolve the SAME conversation → bidirectional send/retrieve with exact
 * markers, sender identities, chronological order, no duplicates →
 * validation negatives (empty/oversized/strict-mode) → read receipts →
 * persistence across fresh reads → unrelated-user denial → anonymous 401s →
 * malformed ids 400 → in-app chat notification for the recipient.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const API = 'http://localhost:3001/api/v1';
const RUN = Date.now().toString(36);
const PW = 'Task331-E2E-Pw!42';
const CUSTOMER_EMAIL = `task331e.customer.${RUN}@umodzi.test`;
const TECH_EMAIL = `task331e.technician.${RUN}@umodzi.test`;
const OTHER_EMAIL = `task331e.other.${RUN}@umodzi.test`;
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

const M1 = `CHAT-E2E-CONSUMER-${RUN} tap still drips, can you come Thursday?`;
const M2 = `CHAT-E2E-TECHNICIAN-${RUN} Thursday morning works, see you at nine.`;

async function main(): Promise<void> {
  const cust = makeClient();
  const tech = makeClient();
  const other = makeClient();
  const admin = makeClient();

  // ---- fixtures ----
  for (const [c, payload] of [
    [cust, { email: CUSTOMER_EMAIL, firstName: 'E2E', lastName: 'Customer', role: 'customer' }],
    [tech, { email: TECH_EMAIL, firstName: 'E2E', lastName: 'Tech', role: 'technician', category: 'Plumbing', serviceArea: 'Kitwe' }],
    [other, { email: OTHER_EMAIL, firstName: 'E2E', lastName: 'Other', role: 'customer' }],
  ] as const) {
    const r = await (c as Client).call('/auth/register', { method: 'POST', body: { ...payload, password: PW } });
    assert(r.status === 201, `registered ${(payload as { email: string }).email} (${r.status})`);
  }
  const lc = await cust.login(CUSTOMER_EMAIL, PW);
  const lt = await tech.login(TECH_EMAIL, PW);
  const lo = await other.login(OTHER_EMAIL, PW);
  assert(lc.status === 200 && lt.status === 200 && lo.status === 200, 'all fixtures logged in');
  const custId = (lc.json as { data: { user: { id: string } } })?.data?.user?.id;
  const techUserId = (lt.json as { data: { user: { id: string } } })?.data?.user?.id;

  // ---- verification chain (real workflow) ----
  const form = new FormData();
  form.append('documentType', 'national_id');
  form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'national-id.png');
  const up = await tech.call('/technician/verification/documents', { method: 'POST', body: form });
  assert(up.status === 201 || up.status === 200, `ID document uploaded (${up.status})`);
  const sub = await tech.call('/technician/verification/submit', { method: 'POST' });
  assert(sub.status === 200 || sub.status === 201, `verification submitted (${sub.status})`);
  const prof = await tech.call('/technician/profile');
  const techProfileId = (prof.json as { data: { id: string } })?.data?.id;
  const aLogin = await admin.login(adminEmail as string, adminPassword as string);
  assert(aLogin.status === 200, `admin login (${aLogin.status})`);
  const decide = await admin.call(`/admin/technicians/${techProfileId}/verification`, {
    method: 'PATCH',
    body: { decision: 'verified' },
  });
  assert(decide.status === 200, `fixture tech verified (${decide.status})`);
  await admin.call('/auth/logout', { method: 'POST' });

  // ---- request → offer → accept (request must become matched) ----
  const req = await cust.call('/requests', {
    method: 'POST',
    body: {
      description: 'Task331 suite request — geyser trips breaker on cold mornings.',
      category: 'Plumbing',
      city: 'Kitwe',
    },
  });
  assert(req.status === 201, `request created (${req.status})`);
  const requestId = (req.json as { data: { id: string } })?.data?.id;
  const offers = await cust.call(`/requests/${requestId}/offers`);
  const list = ((offers.json as {
    data?: { offers?: { id: string; status: string; technicianId: string }[] };
  })?.data?.offers ??
    (offers.json as { data?: { id: string; status: string; technicianId: string }[] })?.data ??
    []) as { id: string; status: string; technicianId: string }[];
  // Dispatch offers to the least-used ELIGIBLE technician: if another
  // verified tech exists (e.g. leftovers from an earlier run), the offer may
  // legitimately go elsewhere. Fail loudly instead of testing the wrong
  // technician's conversation.
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

  // ---- A. conversation access, both sides, same conversation ----
  const cc = await cust.call(`/requests/${requestId}/conversation`);
  const tc = await tech.call(`/requests/${requestId}/conversation`);
  assert(cc.status === 200 && tc.status === 200, 'both resolve via request scope (200/200)');
  const convId = (cc.json as { data: { conversation: { id: string } } })?.data?.conversation?.id;
  assert(
    typeof convId === 'string' &&
      convId === (tc.json as { data: { conversation: { id: string } } })?.data?.conversation?.id,
    'same conversation id both sides',
  );
  const td = await tech.call(`/conversations/${convId}`);
  assert(td.status === 200, 'technician direct access 200 (was 404 pre-fix)');

  // ---- B. bidirectional send/retrieve ----
  const s1 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M1 } });
  assert(s1.status === 201, 'consumer send 201');
  assert(
    (s1.json as { data: { message: string; senderId: string } })?.data?.message === M1 &&
      (s1.json as { data: { message: string; senderId: string } })?.data?.senderId === custId,
    'echo verbatim, sender = customer',
  );
  const tGet = await tech.call(`/conversations/${convId}/messages?limit=10`);
  const got1 = (
    (tGet.json as { data: { messages: { message: string; senderId: string }[] } })?.data?.messages ?? []
  ).find((m) => m.message === M1);
  assert(tGet.status === 200 && !!got1 && got1.senderId === custId, 'tech retrieves exact message');
  const s2 = await tech.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M2 } });
  assert(s2.status === 201, 'technician reply 201');
  const cGet = await cust.call(`/conversations/${convId}/messages?limit=10`);
  const msgs = ((cGet.json as { data: { messages: { id: string; message: string }[] } })?.data?.messages ?? []);
  assert(msgs.some((m) => m.message === M2), 'consumer retrieves exact reply');
  assert(
    msgs.length >= 2 && msgs[0].message === M1 && msgs[msgs.length - 1].message === M2,
    'chronological order, no interleaving',
  );
  assert(new Set(msgs.map((m) => m.id)).size === msgs.length, 'no duplicate ids');

  // ---- validation negatives ----
  const v = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: '   ' } });
  assert(v.status === 400, `whitespace → 400 (${v.status})`);
  const big = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: 'x'.repeat(2001) } });
  assert(big.status === 400, `oversized → 400 (${big.status})`);
  const strict = await cust.call(`/conversations/${convId}/messages`, {
    method: 'POST',
    body: { message: 'legit text here', senderId: 'forged' },
  });
  assert(strict.status === 400, 'strict mode rejects senderId (400)');

  // ---- read receipts + persistence ----
  const rd = await tech.call(`/conversations/${convId}/read`, { method: 'PATCH' });
  assert(rd.status === 200, 'mark-read 200');
  const after = await cust.call(`/conversations/${convId}/messages?limit=10`);
  const mine = (
    (after.json as { data: { messages: { message: string; readAt: string | null }[] } })?.data?.messages ?? []
  ).filter((m) => m.message === M1);
  assert(mine.length > 0 && mine.every((m) => m.readAt !== null), 'readAt set after recipient read');

  // ---- unrelated user + anonymous ----
  const anon = makeClient();
  assert((await anon.call(`/conversations/${convId}/messages`)).status === 401, 'anon read 401');
  assert(
    (await anon.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: 'hi there now' } })).status === 401,
    'anon send 401',
  );
  const oc = await other.call(`/conversations/${convId}`);
  assert(oc.status === 404, `unrelated detail 404 (${oc.status})`);
  const om = await other.call(`/conversations/${convId}/messages`);
  assert(om.status === 404, `unrelated messages 404 (${om.status})`);
  const os = await other.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: 'intruder text here' } });
  assert(os.status === 404, `unrelated send 404 (${os.status})`);
  const or = await other.call(`/conversations/${convId}/read`, { method: 'PATCH' });
  assert(or.status === 404, `unrelated read 404 (${or.status})`);

  // ---- in-app notification for the recipient ----
  const notifs = await tech.call('/me/notifications?limit=20&offset=0');
  const chatNotif = (
    (notifs.json as { data: { notifications: { type: string; referenceId: string }[] } })?.data?.notifications ?? []
  ).find((n) => n.type === 'chat_message' && n.referenceId === convId);
  assert(notifs.status === 200 && !!chatNotif, 'recipient has chat_message notification');
  const otherNotifs = await other.call('/me/notifications?limit=50&offset=0');
  const leak = ((otherNotifs.json as { data: { notifications: { referenceId: string }[] } })?.data?.notifications ?? []).some(
    (n) => n.referenceId === convId,
  );
  assert(otherNotifs.status === 200 && !leak, 'unrelated user sees no conversation notifications');

  // ---- cleanup: delete everything this run created ----
  const ids = (
    await pool.query(`SELECT id FROM users WHERE lower(email) LIKE 'task331e.%@umodzi.test'`)
  ).rows.map((r: { id: string }) => r.id) as string[];
  if (ids.length > 0) {
    // Verification document rows + stored files. Files are removed by
    // technician directory (not by trusting the stored key path), so a
    // key-format change can never strand files behind.
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
    // Notifications referencing fixture entities (admin fan-out copies stay:
    // they record a genuine verification decision).
    await pool.query(
      `DELETE FROM notifications WHERE user_id = ANY($1)`,
      [ids],
    );
    await pool.query(`DELETE FROM service_requests WHERE customer_user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM technicians WHERE user_id = ANY($1)`, [ids]);
    const du = await pool.query(`DELETE FROM users WHERE lower(email) LIKE 'task331e.%@umodzi.test'`);
    console.log(`  cleanup: users=${du.rowCount}`);
  }
  await pool.query(`DELETE FROM sessions WHERE created_at >= now() - interval '3 hours'`);
  const one = async (sql: string) => (await pool.query(sql)).rows[0] as { n: number };
  console.log(
    `  baseline: users=${(await one(`SELECT count(*)::int n FROM users`)).n}` +
      ` requests=${(await one(`SELECT count(*)::int n FROM service_requests`)).n}` +
      ` techs=${(await one(`SELECT count(*)::int n FROM technicians`)).n}` +
      ` sessions=${(await one(`SELECT count(*)::int n FROM sessions`)).n}` +
      ` audit=${(await one(`SELECT count(*)::int n FROM audit_events`)).n}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  if (failed > 0) process.exitCode = 1;
}

void main();
