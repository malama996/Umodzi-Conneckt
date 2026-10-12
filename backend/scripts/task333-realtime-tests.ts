/**
 * Task 33.3 realtime delivery suite: the WebSocket transport contract
 * against a RUNNING backend (start it first — this suite does NOT spawn
 * the server).
 *
 * Run from the backend folder:
 *   npx --no-install tsx scripts/task333-realtime-tests.ts
 *
 * Requires DATABASE_URL plus ADMIN_EMAIL/ADMIN_PASSWORD in backend/.env
 * (same convention as task331/task332 suites): registers isolated
 * `task333.*@umodzi.test` fixtures, verifies the fixture technician through
 * the real admin decision endpoint, drives the dispatch flow to a real
 * conversation, then DELETES every row it created (users cascade sessions;
 * requests cascade offers/conversations/messages; technician profile,
 * verification document row + file and fixture sessions removed
 * explicitly). Audit events are security records and are NOT deleted.
 *
 * Coverage (mapping to the task's 10 required tests):
 *   1. authenticated connection succeeds (`connected` ack)
 *   2. unauthenticated / garbage-token handshakes rejected (close 4001)
 *   3. participant subscribes to an authorized conversation (ack)
 *   4. unrelated user cannot subscribe and receives no events
 *   5. administrator cannot subscribe or receive content events (role is
 *      never an access grant — Task 33.2 policy carried onto the socket)
 *   6. a persisted message generates exactly one recipient event carrying
 *      the REST message id (and no message content)
 *   7. failed persistence (validation 400s) generates no event
 *   8. reconnect recovers missed messages via REST without duplicates;
 *      connection churn does not break new connections (internal counts
 *      are not exposed by design, so cleanup is asserted behaviourally);
 *      the heartbeat ping proves stale-socket detection is running
 *   9. duplicate rendered messages: the server emits EXACTLY ONE event per
 *      persisted message (UI-side merge-by-id is verified separately in the
 *      browser phase)
 *  10. REST history/send/read behavior still works (the full Task 33.1
 *      suite is also re-run as a Phase 5 regression gate)
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import WebSocket from 'ws';

const API = 'http://localhost:3001/api/v1';
const WS_URL = 'ws://localhost:3001/api/v1/realtime';
const RUN = Date.now().toString(36);
const PW = 'Task333-RT-Pw!42';
const CUSTOMER_EMAIL = `task333.customer.${RUN}@umodzi.test`;
const TECH_EMAIL = `task333.technician.${RUN}@umodzi.test`;
const OTHER_EMAIL = `task333.other.${RUN}@umodzi.test`;
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
/** Wall-clock start — used to clean up ONLY sessions this run created. */
const SUITE_START = new Date(Date.now() - 60_000).toISOString();

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeClient() {
  const jar: string[] = [];
  let bearer: string | null = null;
  return {
    setBearer(t: string | null) {
      bearer = t;
    },
    getBearer() {
      return bearer;
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

/* ------------------------------ WebSocket harness ------------------------------ */

interface WsClient {
  socket: WebSocket;
  events: { type?: string; error?: string; conversationId?: string; messageId?: string; senderId?: string }[];
  raw: string[];
  closeEvents: { code: number; reason: string }[];
  pinged: boolean;
  closed: boolean;
}
const openSockets: WsClient[] = [];

function openWs(token: string | null, immediateSubscribe?: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const socket = token ? new WebSocket(WS_URL, [`bearer-${token}`]) : new WebSocket(WS_URL);
    const client: WsClient = { socket, events: [], raw: [], closeEvents: [], pinged: false, closed: false };
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error('websocket did not open in time'));
    }, 5000);
    socket.on('open', () => {
      // Optional race-guard mode: subscribe from the `open` handler itself,
      // BEFORE any server ack — exactly what the browser hook does. Frames
      // sent this early must be buffered server-side, never dropped.
      if (immediateSubscribe)
        socket.send(JSON.stringify({ subscribe: { conversationId: immediateSubscribe } }));
      clearTimeout(timer);
      openSockets.push(client);
      resolve(client);
    });
    socket.on('message', (data) => {
      const text = data.toString();
      client.raw.push(text);
      try {
        client.events.push(JSON.parse(text));
      } catch {
        /* non-json frame */
      }
    });
    socket.on('ping', () => {
      client.pinged = true;
    });
    socket.on('close', (code: number, reason: Buffer) => {
      client.closed = true;
      client.closeEvents.push({ code, reason: reason.toString() });
      clearTimeout(timer);
    });
    socket.on('error', () => {
      /* close event carries the outcome */
    });
  });
}

/** Connect expecting rejection: resolves with the close code (or -1 for an HTTP-level refusal). */
function connectExpectClose(token: string | null): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const socket = token ? new WebSocket(WS_URL, [`bearer-${token}`]) : new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error('connection was neither closed nor open in time'));
    }, 5000);
    socket.on('open', () => {
      /* server completes the upgrade first, then closes with 4001 */
    });
    socket.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
      clearTimeout(timer);
      resolve({ code: -1, reason: `http ${res.statusCode}` });
      socket.terminate();
    });
    socket.on('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    socket.on('error', () => {
      /* close follows */
    });
  });
}

function waitFor(
  client: WsClient,
  pred: (e: WsClient['events'][number]) => boolean,
  timeoutMs = 3000,
): Promise<WsClient['events'][number] | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: WsClient['events'][number] | null) => {
      if (done) return;
      done = true;
      clearInterval(iv);
      clearTimeout(t);
      resolve(value);
    };
    const scan = () => {
      for (const e of client.events) if (pred(e)) return finish(e);
    };
    const iv = setInterval(scan, 40);
    const t = setTimeout(() => finish(null), timeoutMs);
    scan();
  });
}

const countSince = (
  client: WsClient,
  mark: number,
  pred: (e: WsClient['events'][number]) => boolean,
): number => client.events.slice(mark).filter(pred).length;

async function closeWs(client: WsClient): Promise<void> {
  if (client.closed) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 2500);
    client.socket.once('close', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      client.socket.close();
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

// Minimal valid 1x1 PNG (magic bytes carry, no personal content).
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

const M1 = `RT-CUST-M1-${RUN} customer marker before technician connects`;
const M2 = `RT-TECH-M2-${RUN} technician reply marker`;
const M3 = `RT-CUST-M3-${RUN} sent while technician socket is down`;
const M4 = `RT-CUST-M4-${RUN} first marker after reconnect`;
const M5 = `RT-TECH-M5-${RUN} after customer unsubscribed`;
const M6 = `RT-CUST-M6-${RUN} after connection churn`;
const ALL_MARKERS = [M1, M2, M3, M4, M5, M6];

async function main(): Promise<void> {
  const cust = makeClient();
  const tech = makeClient();
  const other = makeClient();
  const admin = makeClient();

  /* ---------------- fixtures: same real workflow as the 33.1 suite ---------------- */
  for (const [c, payload] of [
    [cust, { email: CUSTOMER_EMAIL, firstName: 'RT', lastName: 'Customer', role: 'customer' }],
    [tech, { email: TECH_EMAIL, firstName: 'RT', lastName: 'Tech', role: 'technician', category: 'Plumbing', serviceArea: 'Kitwe' }],
    [other, { email: OTHER_EMAIL, firstName: 'RT', lastName: 'Other', role: 'customer' }],
  ] as const) {
    const r = await (c as Client).call('/auth/register', { method: 'POST', body: { ...payload, password: PW } });
    assert(r.status === 201, `registered ${(payload as { email: string }).email} (${r.status})`);
  }
  const lc = await cust.login(CUSTOMER_EMAIL, PW);
  const lt = await tech.login(TECH_EMAIL, PW);
  const lo = await other.login(OTHER_EMAIL, PW);
  assert(lc.status === 200 && lt.status === 200 && lo.status === 200, 'all fixtures logged in');
  const custId = (lc.json as { data: { user: { id: string } } })?.data?.user?.id;

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

  const req = await cust.call('/requests', {
    method: 'POST',
    body: {
      description: 'Task333 suite request — water heater pilot will not stay lit.',
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
  // Dispatch offers to the least-used ELIGIBLE technician: fail loudly if a
  // leftover verified tech exists instead of testing the wrong conversation.
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
  assert(cc.status === 200 && typeof convId === 'string', 'conversation resolved');

  /* ---------------- 1–2. connection authentication ---------------- */
  const custWs = await openWs(cust.getBearer());
  const connectedAck = await waitFor(custWs, (e) => e.type === 'connected');
  assert(!!connectedAck, 'authenticated WS connection receives `connected` ack');

  // Race guard: a client that subscribes from its `open` handler (before
  // the `connected` ack) must NOT lose the frame — the server buffers
  // frames that arrive while authentication is still in flight.
  const early = await openWs(cust.getBearer(), convId);
  const earlyAck = await waitFor(early, (e) => e.type === 'subscribed' && e.conversationId === convId);
  assert(!!earlyAck, 'immediate subscribe-from-open is buffered, not dropped');
  await closeWs(early);

  const noToken = await connectExpectClose(null);
  assert(noToken.code === 4001, `unauthenticated handshake closed 4001 (${noToken.code} ${noToken.reason})`);
  const badToken = await connectExpectClose('bearer-not-a-real-jwt');
  assert(badToken.code === 4001, `garbage token closed 4001 (${badToken.code} ${badToken.reason})`);

  /* ---------------- 3. participant subscribes ---------------- */
  custWs.socket.send(JSON.stringify({ subscribe: { conversationId: convId } }));
  const subAck = await waitFor(custWs, (e) => e.type === 'subscribed' && e.conversationId === convId);
  assert(!!subAck, 'participant subscription acknowledged');

  // Input validation (server must answer, never throw).
  custWs.socket.send('not json at all');
  const invJson = await waitFor(custWs, (e) => e.error === 'Invalid message');
  assert(!!invJson, 'malformed JSON → `Invalid message`');
  custWs.socket.send(JSON.stringify({ subscribe: { conversationId: 'nope' } }));
  const invFmt = await waitFor(custWs, (e) => e.error === 'Invalid conversation id format');
  assert(!!invFmt, 'bad uuid format → `Invalid conversation id format`');
  custWs.socket.send(
    JSON.stringify({ subscribe: { conversationId: '00000000-0000-0000-0000-000000000000' } }),
  );
  const invMissing = await waitFor(custWs, (e) => e.error === 'Conversation not found');
  assert(!!invMissing, 'unknown conversation → `Conversation not found`');
  custWs.socket.send(JSON.stringify({ hello: true }));
  const invType = await waitFor(custWs, (e) => e.error === 'Unknown message type');
  assert(!!invType, 'unknown command shape → `Unknown message type`');

  /* ---------------- 4–5. unrelated user and administrator cannot subscribe ---------------- */
  const otherWs = await openWs(other.getBearer());
  await waitFor(otherWs, (e) => e.type === 'connected');
  otherWs.socket.send(JSON.stringify({ subscribe: { conversationId: convId } }));
  const otherDenied = await waitFor(otherWs, (e) => !!e.error);
  assert(
    otherDenied?.error === 'Not authorized for this conversation',
    'unrelated user subscription denied by DB policy',
    ` (${otherDenied?.error ?? 'no answer'})`,
  );

  const adminWs = await openWs(admin.getBearer());
  await waitFor(adminWs, (e) => e.type === 'connected');
  adminWs.socket.send(JSON.stringify({ subscribe: { conversationId: convId } }));
  const adminDenied = await waitFor(adminWs, (e) => !!e.error);
  assert(
    adminDenied?.error === 'Not authorized for this conversation',
    'administrator subscription denied (role is not an access grant)',
    ` (${adminDenied?.error ?? 'no answer'})`,
  );

  /* ---------------- 6. persisted message → exactly one recipient event, id-only ---------------- */
  const techWs = await openWs(tech.getBearer());
  await waitFor(techWs, (e) => e.type === 'connected');
  techWs.socket.send(JSON.stringify({ subscribe: { conversationId: convId } }));
  const techSub = await waitFor(techWs, (e) => e.type === 'subscribed');
  assert(!!techSub, 'technician (participant) subscription acknowledged');

  let mark = techWs.events.length;
  let custMark = custWs.events.length;
  let adminMark = adminWs.events.length;
  let otherMark = otherWs.events.length;
  const s1 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M1 } });
  assert(s1.status === 201, `customer send persisted 201 (${s1.status})`);
  const m1Id = (s1.json as { data: { id: string } })?.data?.id;
  assert(typeof m1Id === 'string', 'REST response carries the message id');
  const ev1 = await waitFor(techWs, (e) => e.type === 'message' && e.messageId === m1Id);
  assert(!!ev1, 'technician received message event');
  assert(ev1?.senderId === custId && ev1?.conversationId === convId, 'event carries senderId + conversationId');
  await sleep(700);
  assert(
    countSince(techWs, mark, (e) => e.type === 'message') === 1,
    'exactly ONE event per persisted message (no duplicates)',
    ` (${countSince(techWs, mark, (e) => e.type === 'message')})`,
  );
  const custEcho = countSince(custWs, custMark, (e) => e.type === 'message' && e.messageId === m1Id);
  assert(custEcho === 1, 'sender’s own socket receives exactly one echo event', ` (${custEcho})`);
  assert(
    countSince(adminWs, adminMark, (e) => e.type === 'message') === 0 &&
      countSince(otherWs, otherMark, (e) => e.type === 'message') === 0,
    'administrator and unrelated user receive no events',
  );
  const techEventJson = JSON.stringify(techWs.events.slice(mark));
  assert(!techEventJson.includes('RT-CUST-M1'), 'event payload contains no message content (ids only)');

  /* ---------------- 7. failed persistence → no event ---------------- */
  mark = techWs.events.length;
  const bad1 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: 'x'.repeat(2001) } });
  const bad2 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: '   ' } });
  const bad3 = await cust.call(`/conversations/${convId}/messages`, {
    method: 'POST',
    body: { message: 'sneaky text here', senderId: 'forged' },
  });
  assert(bad1.status === 400 && bad2.status === 400 && bad3.status === 400, 'invalid sends → 400 (oversized/whitespace/strict)');
  await sleep(1200);
  assert(
    countSince(techWs, mark, (e) => e.type === 'message') === 0,
    'no event generated for failed persistence',
  );

  /* ---------------- 9. technician reply: one event, REST regression ---------------- */
  mark = techWs.events.length;
  custMark = custWs.events.length;
  const s2 = await tech.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M2 } });
  assert(s2.status === 201, 'technician reply persisted 201');
  const m2Id = (s2.json as { data: { id: string } })?.data?.id;
  await waitFor(custWs, (e) => e.type === 'message' && e.messageId === m2Id);
  await sleep(700);
  assert(
    countSince(custWs, custMark, (e) => e.type === 'message' && e.messageId === m2Id) === 1,
    'recipient received exactly one event for the reply',
  );
  const hist = await tech.call(`/conversations/${convId}/messages?limit=10`);
  const histMsgs = ((hist.json as { data: { messages: { id: string; message: string; senderId: string }[] } })?.data?.messages ?? []);
  assert(hist.status === 200, 'REST history still works (200)');
  assert(
    histMsgs.filter((m) => m.id === m1Id).length === 1 && histMsgs.filter((m) => m.id === m2Id).length === 1,
    'REST history holds each message exactly once (stable ids)',
  );
  assert(new Set(histMsgs.map((m) => m.id)).size === histMsgs.length, 'no duplicate ids in REST history');
  assert(
    histMsgs[0]?.message === M1 && histMsgs[histMsgs.length - 1]?.message === M2,
    'chronological order preserved',
  );

  /* ---------------- 8a. reconnect: missed messages recovered via REST, no dupes ---------------- */
  await closeWs(techWs);
  await sleep(200);
  const s3 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M3 } });
  assert(s3.status === 201, 'message sent while technician socket is down → 201');
  const m3Id = (s3.json as { data: { id: string } })?.data?.id;

  const techWs2 = await openWs(tech.getBearer());
  await waitFor(techWs2, (e) => e.type === 'connected');
  techWs2.socket.send(JSON.stringify({ subscribe: { conversationId: convId } }));
  await waitFor(techWs2, (e) => e.type === 'subscribed');
  const liveMark = techWs2.events.length;
  await sleep(1000);
  assert(
    countSince(techWs2, liveMark, (e) => e.messageId === m3Id) === 0,
    'no replay of missed messages on reconnect (events are live-only)',
  );
  const recover1 = await tech.call(`/conversations/${convId}/messages?limit=10`);
  const recover2 = await tech.call(`/conversations/${convId}/messages?limit=10`);
  const r1 = ((recover1.json as { data: { messages: { id: string }[] } })?.data?.messages ?? []).filter((m) => m.id === m3Id);
  const r2 = ((recover2.json as { data: { messages: { id: string }[] } })?.data?.messages ?? []).filter((m) => m.id === m3Id);
  assert(r1.length === 1 && r2.length === 1, 'REST recovers the missed message exactly once on every read');

  mark = techWs2.events.length;
  const s4 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M4 } });
  assert(s4.status === 201, 'post-reconnect send → 201');
  const m4Id = (s4.json as { data: { id: string } })?.data?.id;
  const ev4 = await waitFor(techWs2, (e) => e.type === 'message' && e.messageId === m4Id);
  assert(!!ev4, 'live delivery works again after reconnect');

  /* ---------------- 8b. unsubscribe stops delivery ---------------- */
  custWs.socket.send(JSON.stringify({ unsubscribe: { conversationId: convId } }));
  const unAck = await waitFor(custWs, (e) => e.type === 'unsubscribed' && e.conversationId === convId);
  assert(!!unAck, 'unsubscribe acknowledged');
  custMark = custWs.events.length;
  adminMark = adminWs.events.length;
  otherMark = otherWs.events.length;
  mark = techWs2.events.length;
  const s5 = await tech.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M5 } });
  assert(s5.status === 201, 'send after customer unsubscribe → 201');
  const m5Id = (s5.json as { data: { id: string } })?.data?.id;
  await waitFor(techWs2, (e) => e.type === 'message' && e.messageId === m5Id);
  await sleep(800);
  assert(countSince(custWs, custMark, (e) => e.type === 'message') === 0, 'unsubscribed participant receives no events');
  assert(countSince(adminWs, adminMark, (e) => e.type === 'message') === 0, 'administrator still receives no events');
  assert(countSince(otherWs, otherMark, (e) => e.type === 'message') === 0, 'unrelated user still receives no events');

  /* ---------------- 8c. connection churn does not break new connections ---------------- */
  const churn: WsClient[] = [];
  for (let i = 0; i < 3; i += 1) churn.push(await openWs(cust.getBearer()));
  await Promise.all(churn.map(closeWs));
  const afterChurn = await openWs(cust.getBearer());
  const churnAck = await waitFor(afterChurn, (e) => e.type === 'connected');
  assert(!!churnAck, 'new connection works after rapid open/close churn');
  mark = techWs2.events.length;
  const s6 = await cust.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: M6 } });
  assert(s6.status === 201, 'send after churn → 201 (server healthy)');
  const m6Id = (s6.json as { data: { id: string } })?.data?.id;
  const ev6 = await waitFor(techWs2, (e) => e.type === 'message' && e.messageId === m6Id);
  assert(!!ev6, 'delivery continues after churn');

  /* ---------------- 8d. heartbeat: liveness machinery is running ---------------- */
  // The server pings every 30s; a connected client must see a ping within
  // one interval. This proves stale-socket detection has a live ticker
  // without waiting for a genuine zombie (which cannot be simulated
  // reliably from a well-behaved client).
  console.log('  … waiting up to 34s for the server heartbeat ping');
  const pingDeadline = Date.now() + 34000;
  while (!afterChurn.pinged && Date.now() < pingDeadline) await sleep(500);
  assert(afterChurn.pinged, 'server heartbeat ping observed within one interval');

  /* ---------------- 10 + Task 33.2 posture: REST and admin content still closed ---------------- */
  const adminConv = await admin.call(`/conversations/${convId}`);
  const adminMsgs = await admin.call(`/conversations/${convId}/messages`);
  assert(adminConv.status === 404 && adminMsgs.status === 404, 'administrator HTTP content access still 404/404');
  const otherSend = await other.call(`/conversations/${convId}/messages`, { method: 'POST', body: { message: 'intruder text here' } });
  assert(otherSend.status === 404, 'unrelated REST send still 404');
  const anon = makeClient();
  assert((await anon.call(`/conversations/${convId}/messages`)).status === 401, 'anonymous REST read still 401');
  const readReceipt = await tech.call(`/conversations/${convId}/read`, { method: 'PATCH' });
  assert(readReceipt.status === 200, 'read receipt PATCH still 200');
  const afterRead = await cust.call(`/conversations/${convId}/messages?limit=10`);
  const mine = ((afterRead.json as { data: { messages: { message: string; readAt: string | null }[] } })?.data?.messages ?? []).filter(
    (m) => m.message === M1,
  );
  assert(mine.length > 0 && mine.every((m) => m.readAt !== null), 'readAt set after recipient read (REST regression)');

  // Final sweep: content never crossed the socket to anyone, and the
  // never-authorized sockets never saw a single message event.
  const allRaw = [...techWs.raw, ...techWs2.raw, ...custWs.raw, ...adminWs.raw, ...otherWs.raw].join('\n');
  assert(
    ALL_MARKERS.every((m) => !allRaw.includes(m)),
    'no message content ever crossed the WebSocket (all six markers absent)',
  );
  assert(
    adminWs.events.every((e) => e.type !== 'message') && otherWs.events.every((e) => e.type !== 'message'),
    'administrator/unrelated sockets saw zero message events end-to-end',
  );

  /* ---------------- cleanup: log out, close sockets, delete only this run's rows ---------------- */
  await admin.call('/auth/logout', { method: 'POST' });
  // Logout REVOKES the admin session but the row remains; remove the
  // revoked row this run created (created during the run + already revoked —
  // a concurrently active admin session is never touched).
  const adminRow = (
    await pool.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [adminEmail as string])
  ).rows[0] as { id: string } | undefined;
  if (adminRow) {
    const ds = await pool.query(
      `DELETE FROM sessions WHERE user_id = $1 AND created_at >= $2 AND revoked_at IS NOT NULL`,
      [adminRow.id, SUITE_START],
    );
    console.log(`  cleanup: admin session rows removed=${ds.rowCount}`);
  }
  for (const c of [...openSockets]) await closeWs(c);

  const ids = (
    await pool.query(`SELECT id FROM users WHERE lower(email) LIKE 'task333.%@umodzi.test'`)
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
    // Fixture sessions only — other people's sessions are never touched.
    await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [ids]);
    const du = await pool.query(`DELETE FROM users WHERE lower(email) LIKE 'task333.%@umodzi.test'`);
    console.log(`  cleanup: users=${du.rowCount}`);
  }
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

void main().catch(async (err) => {
  console.error('suite crashed:', err);
  for (const c of [...openSockets]) {
    try {
      c.socket.terminate();
    } catch {
      /* ignore */
    }
  }
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
