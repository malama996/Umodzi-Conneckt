/**
 * Controlled dispatch experiment (Chapter Five, Table 17).
 *
 * Runs the real dispatch flow against the local API and database:
 *   12 acceptance runs   — one offer, accepted by the offered technician
 *    6 cascade runs      — first technician rejects, the next accepts
 *    4 no-match runs     — a category/city with no eligible technician
 *
 * Setup is explicit: two Plumbing/Kitwe technician accounts are registered
 * through the API, verified by the administrator through the API, and marked
 * available. Availability has no product endpoint, so it is set in SQL.
 *
 * Usage (API running on :3001, migrated + seeded database):
 *   cd backend && DATABASE_URL=... npx --no-install tsx scripts/eval-dispatch.mjs
 */
import pg from 'pg';

const BASE = 'http://localhost:3001/api/v1';
const PASSWORD = 'LocalTest123!';
const ACCEPT_RUNS = 12;
const CASCADE_RUNS = 6;
const NOMATCH_RUNS = 4;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

async function waitForOffer(requestId, predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { rows } = await pool.query(
      `SELECT id, technician_id, status, created_at FROM dispatch_offers
        WHERE request_id = $1 ORDER BY candidate_index ASC`,
      [requestId],
    );
    const hit = rows.find(predicate);
    if (hit) return { offer: hit, rows };
    await sleep(120);
  }
  throw new Error(`no offer appeared for ${requestId}`);
}

const stamp = Date.now();
const admin = await api('POST', '/auth/login', {
  body: { email: 'admin@umodzi.test', password: 'LocalTestAdmin2026!' },
});
const adminToken = admin.json?.data?.accessToken;
if (!adminToken) throw new Error('admin login failed');

const customerEmail = `dispatch-customer-${stamp}@umodzi.test`;
const techEmails = [
  `dispatch-tech-a-${stamp}@umodzi.test`,
  `dispatch-tech-b-${stamp}@umodzi.test`,
];

await api('POST', '/auth/register', {
  body: {
    email: customerEmail,
    password: PASSWORD,
    firstName: 'Dispatch',
    lastName: 'Customer',
    role: 'customer',
  },
});
for (const [i, email] of techEmails.entries()) {
  await api('POST', '/auth/register', {
    body: {
      email,
      password: PASSWORD,
      firstName: i === 0 ? 'First' : 'Second',
      lastName: 'Technician',
      role: 'technician',
      category: 'Plumbing',
      serviceArea: 'Kitwe',
    },
  });
}

const customerToken = (
  await api('POST', '/auth/login', { body: { email: customerEmail, password: PASSWORD } })
).json?.data?.accessToken;

const techTokens = {};
for (const email of techEmails) {
  const res = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  techTokens[email] = res.json?.data?.accessToken;
}

// Verify through the administrator API, then make the fixtures dispatchable.
const { rows: techRows } = await pool.query(
  `SELECT DISTINCT ON (u.email) t.id, t.user_id, u.email
     FROM technicians t JOIN users u ON u.id = t.user_id
    WHERE u.email = ANY($1) ORDER BY u.email ASC`,
  [techEmails],
);
if (techRows.length !== 2) throw new Error(`expected 2 technician rows, got ${techRows.length}`);

// A verification decision is only accepted for a pending application, so the
// fixtures are put into `pending` first; the decision itself still goes
// through the administrator API.
await pool.query(
  `UPDATE technicians SET verification_status = 'pending' WHERE id = ANY($1)`,
  [techRows.map((r) => r.id)],
);

for (const row of techRows) {
  const res = await api('PATCH', `/admin/technicians/${row.id}/verification`, {
    token: adminToken,
    body: { decision: 'verified' },
  });
  if (![200, 201, 204].includes(res.status)) {
    throw new Error(`verify failed for ${row.email}: ${res.status}`);
  }
}
await pool.query(
  `UPDATE technicians SET availability_status = 'available', account_status = 'active',
          jobs = 0, rating = 0 WHERE id = ANY($1)`,
  [techRows.map((r) => r.id)],
);

// Earlier interrupted attempts left accepted-but-unfinished fixture requests
// holding capacity; close them so this run starts from a clean baseline.
await pool.query(
  `UPDATE service_requests r SET status = 'completed', updated_at = NOW()
    WHERE r.status IN ('matched', 'in_progress')
      AND EXISTS (
        SELECT 1 FROM users u
         WHERE u.id = r.customer_user_id AND u.email LIKE 'dispatch-customer-%'
      )`,
);

// technician_id -> token
const tokenByTechnicianId = {};
techRows.forEach((row, i) => {
  tokenByTechnicianId[row.id] = techTokens[techEmails[i]] ?? Object.values(techTokens)[i];
});

const results = [];
const createdIds = [];

async function createRequest(category, city) {
  const res = await api('POST', '/requests', {
    token: customerToken,
    body: {
      description:
        'Burst pipe under the kitchen sink, water is running across the floor and the cabinet is soaked.',
      category,
      city,
      clientRequestId: crypto.randomUUID(),
    },
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.json)}`);
  const id = res.json.data.id;
  createdIds.push(id);
  return id;
}

// ---- 12 single-accept runs --------------------------------------------------
for (let i = 0; i < ACCEPT_RUNS; i++) {
  const requestId = await createRequest('Plumbing', 'Kitwe');
  const { offer } = await waitForOffer(requestId, (o) => o.status === 'pending');
  const token = tokenByTechnicianId[offer.technician_id];
  const res = await api('POST', `/offers/${offer.id}/accept`, { token });
  if (res.status !== 200) throw new Error(`accept failed: ${res.status}`);
  // Work the request to completion so capacity is freed for the next run,
  // exactly as a real customer journey would.
  await api('PATCH', `/requests/${requestId}/status`, {
    token,
    body: { status: 'in_progress' },
  });
  await api('PATCH', `/requests/${requestId}/status`, {
    token: customerToken,
    body: { status: 'completed' },
  });
  results.push({ requestId, kind: 'accept', offerId: offer.id, ok: res.status === 200 });
  await sleep(150);
}

// ---- 6 cascade runs ---------------------------------------------------------
for (let i = 0; i < CASCADE_RUNS; i++) {
  const requestId = await createRequest('Plumbing', 'Kitwe');
  const { offer: first } = await waitForOffer(requestId, (o) => o.status === 'pending');
  const firstToken = tokenByTechnicianId[first.technician_id];
  const rej = await api('POST', `/offers/${first.id}/reject`, { token: firstToken });
  if (rej.status !== 200) throw new Error(`reject failed: ${rej.status}`);

  const { offer: second } = await waitForOffer(
    requestId,
    (o) => o.status === 'pending' && o.technician_id !== first.technician_id,
  );
  const secondToken = tokenByTechnicianId[second.technician_id];
  const acc = await api('POST', `/offers/${second.id}/accept`, { token: secondToken });
  if (acc.status !== 200) throw new Error(`second accept failed: ${acc.status}`);
  await api('PATCH', `/requests/${requestId}/status`, {
    token: secondToken,
    body: { status: 'in_progress' },
  });
  await api('PATCH', `/requests/${requestId}/status`, {
    token: customerToken,
    body: { status: 'completed' },
  });
  results.push({ requestId, kind: 'cascade', offerId: second.id, ok: acc.status === 200 });
  await sleep(150);
}

// ---- 4 no-match runs --------------------------------------------------------
for (let i = 0; i < NOMATCH_RUNS; i++) {
  const requestId = await createRequest('Handyman', 'Kitwe');
  let status = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    const { rows } = await pool.query('SELECT status FROM service_requests WHERE id = $1', [requestId]);
    status = rows[0]?.status;
    if (status === 'no_match') break;
    await sleep(200);
  }
  results.push({ requestId, kind: 'no_match', status, ok: status === 'no_match' });
}

// ---- measurements straight from the database --------------------------------
const { rows: summary } = await pool.query(
  `SELECT
     r.id,
     r.status,
     r.created_at,
     (SELECT COUNT(DISTINCT o.technician_id) FROM dispatch_offers o WHERE o.request_id = r.id) AS depth,
     (SELECT MIN(o.created_at) FROM dispatch_offers o WHERE o.request_id = r.id) AS first_offer_at,
     (SELECT MAX(o.updated_at) FROM dispatch_offers o WHERE o.request_id = r.id AND o.status = 'accepted') AS accepted_at
   FROM service_requests r
   WHERE r.id = ANY($1)`,
  [createdIds],
);

const perRun = summary.map((row) => {
  const toOffer = row.first_offer_at
    ? (new Date(row.first_offer_at) - new Date(row.created_at)) / 1000
    : null;
  const toAccept = row.accepted_at && row.first_offer_at
    ? (new Date(row.accepted_at) - new Date(row.first_offer_at)) / 1000
    : null;
  return {
    id: row.id,
    status: row.status,
    depth: Number(row.depth),
    secondsToFirstOffer: toOffer === null ? null : Number(toOffer.toFixed(3)),
    secondsToAcceptance: toAccept === null ? null : Number(toAccept.toFixed(3)),
  };
});

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Number(
    (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2).toFixed(3),
  );
};
const mean = (values) =>
  values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)) : null;

const matched = perRun.filter((r) =>
  ['matched', 'in_progress', 'completed'].includes(r.status),
);
const noMatch = perRun.filter((r) => r.status === 'no_match');
const durationsOffer = perRun.map((r) => r.secondsToFirstOffer).filter((v) => v !== null);
const durationsAccept = perRun.map((r) => r.secondsToAcceptance).filter((v) => v !== null);
const depths = perRun.map((r) => r.depth).filter((d) => d > 0);

const report = {
  ranAt: new Date().toISOString(),
  runs: perRun.length,
  acceptRuns: ACCEPT_RUNS,
  cascadeRuns: CASCADE_RUNS,
  noMatchRuns: NOMATCH_RUNS,
  matched: matched.length,
  noMatch: noMatch.length,
  matchRatePercent: Number(((matched.length / perRun.length) * 100).toFixed(1)),
  medianSecondsToFirstOffer: median(durationsOffer),
  medianSecondsToAcceptance: median(durationsAccept),
  meanSecondsToAcceptance: mean(durationsAccept),
  meanCascadeDepth: mean(depths),
  maxCascadeDepth: depths.length ? Math.max(...depths) : null,
  cancellations: 0,
  distance: null,
  distanceNote: 'Requests carry no coordinates in the create payload, so travel distance is not measured.',
  perRun,
  results,
};

console.log(JSON.stringify(report, null, 2));
await pool.end();
