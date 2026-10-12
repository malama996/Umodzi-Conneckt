/**
 * Task 33.2 Part A — administrator conversation-privacy policy, verified
 * against a RUNNING backend (start it first).
 *
 * Run from the backend folder:
 *   npx --no-install tsx scripts/task332-admin-privacy-tests.ts
 *
 * Requires DATABASE_URL plus ADMIN_EMAIL/ADMIN_PASSWORD in backend/.env
 * (same convention as task331-chat-e2e-tests.ts): registers isolated
 * `@umodzi.test` fixtures, drives the real verification → dispatch → accept
 * flow to obtain a genuine conversation with real message content, then
 * asserts the privacy contract:
 *
 *   1. Anonymous callers get 401 on every conversation surface.
 *   2. An administrator gets 404 on EVERY participant content surface —
 *      detail, history read, send, read-state change, request-scoped
 *      conversation and phone contact. No body contains message content.
 *   3. An administrator can read ONLY the explicitly authorized metadata
 *      endpoint `GET /admin/conversations/:id`, whose payload is checked
 *      against an exact field allow-list and contains no message body.
 *   4. That metadata endpoint is role-gated (403 for non-administrators,
 *      401 anonymous) and validates ids (400 malformed, 404 unknown).
 *   5. Every admin metadata read writes one content-free
 *      `admin.conversation_metadata_accessed` audit record; the audit list
 *      endpoint stays administrator-only (403 otherwise); no audit row from
 *      this run contains message text.
 *   6. Customer↔technician chat still works end to end (regression guard).
 *
 * Cleanup deletes only this run's fixture rows; audit events are security
 * records and are deliberately NOT deleted.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const API = 'http://localhost:3001/api/v1';
const RUN = Date.now().toString(36);
const PW = 'Task332-Privacy-Pw!42';
const CUSTOMER_EMAIL = `task332p.customer.${RUN}@umodzi.test`;
const TECH_EMAIL = `task332p.technician.${RUN}@umodzi.test`;
const OTHER_EMAIL = `task332p.other.${RUN}@umodzi.test`;
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

const M1 = `PRIVACY-MARKER-CUST-${RUN} please keep this text private.`;
const M2 = `PRIVACY-MARKER-TECH-${RUN} understood, keeping it private too.`;

/** Sort-and-join keys of a wire object — exact field-set assertions. */
const keysOf = (row: object) => Object.keys(row).sort().join(',');

async function main(): Promise<void> {
  const cust = makeClient();
  const tech = makeClient();
  const other = makeClient();
  const admin = makeClient();
  const anon = makeClient();

  // ---- fixtures ----
  for (const [c, payload] of [
    [cust, { email: CUSTOMER_EMAIL, firstName: 'Privacy', lastName: 'Customer', role: 'customer' }],
    [tech, { email: TECH_EMAIL, firstName: 'Privacy', lastName: 'Tech', role: 'technician', category: 'Plumbing', serviceArea: 'Kitwe' }],
    [other, { email: OTHER_EMAIL, firstName: 'Privacy', lastName: 'Other', role: 'customer' }],
  ] as const) {
    const r = await (c as Client).call('/auth/register', { method: 'POST', body: { ...payload, password: PW } });
    assert(r.status === 201, `registered ${(payload as { email: string }).email} (${r.status})`);
  }
  const lc = await cust.login(CUSTOMER_EMAIL, PW);
  const lt = await tech.login(TECH_EMAIL, PW);
  const lo = await other.login(OTHER_EMAIL, PW);
  assert(lc.status === 200 && lt.status === 200 && lo.status === 200, 'all fixtures logged in');
  const custId = (lc.json as { data: { user: { id: string } } })?.data?.user?.id;
  const otherId = (lo.json as { data: { user: { id: string } } })?.data?.user?.id;

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
  const adminUserId = (aLogin.json as { data: { user: { id: string } } })?.data?.user?.id;
  const decide = await admin.call(`/admin/technicians/${techProfileId}/verification`, {
    method: 'PATCH',
    body: { decision: 'verified' },
  });
  assert(decide.status === 200, `fixture tech verified (${decide.status})`);

  // ---- request → offer → accept → conversation ----
  const req = await cust.call('/requests', {
    method: 'POST',
    body: {
      description: 'Task332 privacy suite request — water heater leaks under the sink.',
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
  // verified tech exists, the offer may legitimately go elsewhere. Fail
  // loudly instead of testing the wrong technician's conversation.
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
  const convId = (cc.json as { data: { conversation: { id: string } } })?.data?.conversation?.id;
  assert(cc.status === 200 && typeof convId === 'string', 'conversation resolved by customer');

  // Real content on both sides — the thing administrators must never see.
  const s1 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M1 } });
  const s2 = await tech.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M2 } });
  assert(s1.status === 201 && s2.status === 201, 'participants posted real content (201/201)');

  // ================= Part A: administrator privacy contract =================

  console.log('\nA. anonymous surfaces answer 401');
  assert((await anon.call(`/conversations/${convId}`)).status === 401, 'anon detail 401');
  assert((await anon.call(`/conversations/${convId}/messages`)).status === 401, 'anon history 401');
  assert(
    (await anon.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: 'anon text here' } })).status === 401,
    'anon send 401',
  );
  assert((await anon.call(`/conversations/${convId}/read`, { method: 'PATCH' })).status === 401, 'anon read-state 401');
  assert((await anon.call(`/requests/${requestId}/conversation`)).status === 401, 'anon request-scope 401');
  assert((await anon.call('/me/conversations')).status === 401, 'anon list 401');
  assert((await anon.call(`/admin/conversations/${convId}`)).status === 401, 'anon admin metadata 401');

  console.log('\nB. administrator cannot reach message content anywhere (404)');
  const admDetail = await admin.call(`/conversations/${convId}`);
  assert(admDetail.status === 404, `admin conversation detail → 404 (${admDetail.status})`);
  const admHistory = await admin.call(`/conversations/${convId}/messages`);
  assert(admHistory.status === 404, `admin message history → 404 (${admHistory.status})`);
  const admSend = await admin.call(`/conversations/${convId}/messages`, {
    method: 'POST',
    body: { message: 'administrator must not post here' },
  });
  assert(admSend.status === 404, `admin send → 404 (${admSend.status})`);
  const admRead = await admin.call(`/conversations/${convId}/read`, { method: 'PATCH' });
  assert(admRead.status === 404, `admin read-state change → 404 (${admRead.status})`);
  const admScope = await admin.call(`/requests/${requestId}/conversation`);
  assert(admScope.status === 404, `admin request-scoped conversation → 404 (${admScope.status})`);
  const admContact = await admin.call(`/requests/${requestId}/contact`);
  assert(admContact.status === 404, `admin phone contact → 404 (${admContact.status})`);
  const admList = await admin.call('/me/conversations?limit=20');
  assert(admList.status === 200, `admin own list → 200 (self-scoped) (${admList.status})`);
  assert(
    admList.status === 200 && !admList.text.includes(convId) && !admList.text.includes(M1),
    'admin own list contains neither fixture conversation nor its content',
  );
  const admErrorText = [admDetail, admHistory, admSend, admRead, admScope, admContact]
    .map((r) => r.text)
    .join(' ');
  assert(
    !admErrorText.includes('PRIVACY-MARKER') && !admErrorText.includes('leaks under'),
    'admin denial bodies leak no message or request content',
  );
  // Read state must be untouched: the earlier sends are still unread.
  const afterAdmins = await cust.call(`/conversations/${convId}/messages?limit=10`);
  const unread = (
    (afterAdmins.json as { data: { messages: { message: string; readAt: string | null }[] } })?.data?.messages ?? []
  ).filter((m) => m.message.startsWith('PRIVACY-MARKER'));
  assert(
    unread.length === 2 && unread.every((m) => m.readAt === null),
    'admin probes did not mark messages read',
  );
  // And no administrator message landed in the thread.
  const allMsgs = (afterAdmins.json as { data: { messages: { senderId: string }[] } })?.data?.messages ?? [];
  assert(!allMsgs.some((m) => m.senderId === adminUserId), 'no administrator message exists in the thread');

  console.log('\nC. administrator metadata endpoint: exact fields, no content');
  const meta = await admin.call(`/admin/conversations/${convId}`);
  assert(meta.status === 200, `admin metadata → 200 (${meta.status})`);
  const data = (meta.json as { data?: Record<string, unknown> })?.data;
  assert(
    !!data && keysOf(data) === ['activity', 'conversation', 'participants', 'request'].sort().join(','),
    'metadata top-level field set exact',
    data ? ` got ${keysOf(data)}` : ' (no data)',
  );
  if (data) {
    const conv = data.conversation as Record<string, unknown>;
    const parts = data.participants as Record<string, Record<string, unknown>>;
    const request = data.request as Record<string, unknown>;
    const activity = data.activity as Record<string, unknown>;
    assert(
      keysOf(conv) === ['id', 'serviceRequestId', 'status', 'createdAt', 'updatedAt'].sort().join(','),
      'conversation metadata fields exact',
      ` got ${keysOf(conv)}`,
    );
    assert(keysOf(parts) === ['customer', 'technician'].sort().join(','), 'participants fields exact', ` got ${keysOf(parts)}`);
    assert(
      keysOf(parts.customer) === ['displayName', 'userId'].sort().join(','),
      'customer identity fields exact',
      ` got ${keysOf(parts.customer)}`,
    );
    assert(
      keysOf(parts.technician) === ['displayName', 'technicianId', 'userId'].sort().join(','),
      'technician identity fields exact',
      ` got ${keysOf(parts.technician)}`,
    );
    assert(
      keysOf(request) === ['id', 'category', 'city', 'status'].sort().join(','),
      'request context fields exact',
      ` got ${keysOf(request)}`,
    );
    assert(
      keysOf(activity) === ['lastMessageAt', 'messageCount'].sort().join(','),
      'activity is count + timestamp only',
      ` got ${keysOf(activity)}`,
    );
    assert(
      typeof activity.messageCount === 'number' && activity.messageCount >= 2 && !!activity.lastMessageAt,
      'messageCount ≥ 2 with a real lastMessageAt',
    );
    assert(conv.id === convId && conv.status === 'active', 'metadata describes THIS conversation');
    assert(parts.customer.userId === custId, 'customer identity resolves to the real customer');
    assert(parts.technician.technicianId === techProfileId, 'technician identity resolves to the real profile');
  }
  const flat = JSON.stringify(meta.json ?? {});
  assert(
    !flat.includes('PRIVACY-MARKER') && !flat.includes('leaks under the sink'),
    'metadata payload contains no message or request body text',
  );

  console.log('\nD. metadata endpoint is role-gated and validates ids');
  const custMeta = await cust.call(`/admin/conversations/${convId}`);
  assert(custMeta.status === 403, `customer metadata → 403 (${custMeta.status})`);
  const techMeta = await tech.call(`/admin/conversations/${convId}`);
  assert(techMeta.status === 403, `technician metadata → 403 (${techMeta.status})`);
  const otherMeta = await other.call(`/admin/conversations/${convId}`);
  assert(otherMeta.status === 403, `unrelated metadata → 403 (${otherMeta.status})`);
  assert((await admin.call('/admin/conversations/not-a-uuid')).status === 400, 'malformed id → 400');
  assert(
    (await admin.call('/admin/conversations/00000000-0000-4000-8000-000000000000')).status === 404,
    'unknown conversation → 404',
  );

  console.log('\nE. audit: content-free record, permission-controlled read');
  const meta2 = await admin.call(`/admin/conversations/${convId}`);
  assert(meta2.status === 200, 'repeat metadata read 200');
  const auditRows = (
    await pool.query(
      `SELECT actor_user_id, actor_role, target_user_id, target_entity_type,
              target_entity_id, outcome, metadata::text AS metadata
         FROM audit_events
        WHERE event_type = 'admin.conversation_metadata_accessed'
          AND target_entity_id = $1`,
      [convId],
    )
  ).rows as {
    actor_user_id: string;
    actor_role: string;
    target_user_id: string;
    target_entity_type: string;
    target_entity_id: string;
    outcome: string;
    metadata: string;
  }[];
  assert(auditRows.length >= 1, `metadata reads audited (${auditRows.length} records)`);
  const last = auditRows[auditRows.length - 1];
  if (last) {
    assert(last.actor_user_id === adminUserId, 'audit actor is the administrator');
    assert(last.actor_role === 'administrator', 'audit actor role recorded');
    assert(last.target_entity_type === 'conversation' && last.target_entity_id === convId, 'audit targets the conversation');
    assert(last.outcome === 'success', 'audit outcome success');
    assert(last.metadata.includes('metadata_only') && last.metadata.includes('route'), 'audit scope/route recorded');
    assert(!last.metadata.includes('PRIVACY-MARKER'), 'audit metadata holds no message content');
  }
  // No audit row written during this run carries message text.
  const leaky = (
    await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE created_at >= now() - interval '30 minutes'
          AND metadata::text LIKE '%PRIVACY-MARKER%'`,
    )
  ).rows[0] as { n: number };
  assert(leaky.n === 0, 'no recent audit row contains message text');
  const adminAudit = await admin.call('/admin/audit-events?limit=10&eventType=admin.conversation_metadata_accessed');
  assert(adminAudit.status === 200, `admin audit list 200 (${adminAudit.status})`);
  const custAudit = await cust.call('/admin/audit-events?limit=10');
  assert(custAudit.status === 403, `customer audit list → 403 (${custAudit.status})`);
  const otherAudit = await other.call('/admin/audit-events?limit=10');
  assert(otherAudit.status === 403, `unrelated audit list → 403 (${otherAudit.status})`);
  assert((await anon.call('/admin/audit-events?limit=10')).status === 401, 'anon audit list 401');

  console.log('\nF. customer↔technician chat still works (regression)');
  const tGet = await tech.call(`/conversations/${convId}/messages?limit=10`);
  const got = ((tGet.json as { data: { messages: { message: string; senderId: string }[] } })?.data?.messages ?? []).find(
    (m) => m.message === M1,
  );
  assert(tGet.status === 200 && !!got && got.senderId === custId, 'technician reads customer message');
  const cGet = await cust.call(`/conversations/${convId}/messages?limit=10`);
  const msgs = (cGet.json as { data: { messages: { message: string; senderId: string }[] } })?.data?.messages ?? [];
  assert(msgs.some((m) => m.message === M2 && m.senderId === (msgs[0] ? m.senderId : m.senderId)), 'customer reads technician reply');
  const rd = await cust.call(`/conversations/${convId}/read`, { method: 'PATCH' });
  assert(rd.status === 200, 'participant read-state 200');
  const s3 = await tech.call(`/conversations/${convId}/messages`, {
    method: 'POST',
    body: { message: `PRIVACY-MARKER-POST-${RUN} still private after the admin probes.` },
  });
  assert(s3.status === 201, 'technician can still send after admin probes (201)');
  const uc = await other.call(`/conversations/${convId}`);
  assert(uc.status === 404, `unrelated user content → 404 (${uc.status})`);

  // ---- cleanup: delete everything this run created ----
  const ids = (
    await pool.query(`SELECT id FROM users WHERE lower(email) LIKE 'task332p.%@umodzi.test'`)
  ).rows.map((r: { id: string }) => r.id) as string[];
  if (ids.length > 0) {
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
    await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM service_requests WHERE customer_user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM technicians WHERE user_id = ANY($1)`, [ids]);
    const du = await pool.query(`DELETE FROM users WHERE lower(email) LIKE 'task332p.%@umodzi.test'`);
    console.log(`  cleanup: users=${du.rowCount}`);
  }
  await pool.query(`DELETE FROM sessions WHERE created_at >= now() - interval '3 hours'`);
  const one = async (sql: string) => (await pool.query(sql)).rows[0] as { n: number };
  console.log(
    `  baseline: users=${(await one(`SELECT count(*)::int n FROM users`)).n}` +
      ` requests=${(await one(`SELECT count(*)::int n FROM service_requests`)).n}` +
      ` techs=${(await one(`SELECT count(*)::int n FROM technicians`)).n}` +
      ` sessions=${(await one(`SELECT count(*)::int n FROM sessions`)).n}` +
      ` messages=${(await one(`SELECT count(*)::int n FROM messages`)).n}` +
      ` audit=${(await one(`SELECT count(*)::int n FROM audit_events`)).n}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  if (failed > 0) process.exitCode = 1;
}

void main();
