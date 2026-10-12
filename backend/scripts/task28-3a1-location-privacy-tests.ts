/**
 * Task 28.3A.1 tests: location privacy correction (G-01).
 *
 * Verifies that precise technician coordinates are NOT reachable through any
 * public technician endpoint, that the coarse service-area information and the
 * rest of the public projection are unchanged, and that the internal PostGIS
 * dispatch capability is fully preserved.
 *
 * Runs against a RUNNING backend (start it first) and the LOCAL scratch
 * database — never Supabase. Read-only: this suite creates no fixtures and
 * mutates nothing, so it cannot disturb any other suite's baseline.
 *
 * Run from the backend folder:
 *   $env:DATABASE_URL='postgresql://…/umodzi (local scratch)'
 *   $env:ADMIN_EMAIL='admin@umodzi.test'
 *   npx tsx scripts/task28-3a1-location-privacy-tests.ts
 */

import { query } from '../src/db/client.js';

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

if (!process.env.DATABASE_URL || !ADMIN_EMAIL) {
  console.error('Missing required environment variables: DATABASE_URL, ADMIN_EMAIL');
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
/* HTTP helper                                                        */
/* ------------------------------------------------------------------ */

interface Res {
  status: number;
  text: string;
  body: any;
}

async function api(method: string, path: string): Promise<Res> {
  const res = await fetch(`${API_BASE}${path}`, { method });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, text, body };
}

/**
 * Keys that would indicate a precise coordinate leaked into a response body.
 * `location` is included because a raw PostGIS geometry would be worse than a
 * lat/long pair.
 */
const COORD_KEYS = ['latitude', 'longitude', 'location', 'lat', 'lng', 'lon', 'geometry'];

function leakedCoordinateKeys(text: string): string[] {
  const found: string[] = [];
  for (const key of COORD_KEYS) {
    // Match the key as a JSON member name, not as a substring of prose.
    if (new RegExp(`"${key}"\\s*:`).test(text)) found.push(key);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function testListEndpoint(): Promise<void> {
  console.log('\nGET /technicians — no precise coordinates');

  const res = await api('GET', '/technicians');
  assert(res.status === 200, 'list → 200 (behavior preserved, still public)');
  const leaked = leakedCoordinateKeys(res.text);
  assert(
    leaked.length === 0,
    `list response carries no coordinate keys${leaked.length ? ` (leaked: ${leaked.join(', ')})` : ''}`,
  );

  const rows = (res.body?.data ?? []) as Record<string, unknown>[];
  assert(Array.isArray(rows) && rows.length > 0, 'list still returns technicians');
  const first = rows[0] ?? {};
  for (const key of [
    'id',
    'name',
    'category',
    'skills',
    'serviceArea',
    'rating',
    'jobs',
    'verified',
    'availability',
    'bio',
    'hasPhoto',
    'createdAt',
    'updatedAt',
  ]) {
    assert(key in first, `coarse/public field retained: ${key}`);
  }
  assert(
    typeof first.serviceArea === 'string' && first.serviceArea.length > 0,
    'coarse location is conveyed by serviceArea',
  );
}

async function testDetailEndpoint(): Promise<void> {
  console.log('\nGET /technicians/:id — no precise coordinates');

  const list = await api('GET', '/technicians');
  const first = (list.body?.data ?? [])[0] as { id: string } | undefined;
  assert(Boolean(first?.id), 'a technician id was resolved for the detail check');

  const res = await api('GET', `/technicians/${first!.id}`);
  assert(res.status === 200, 'detail → 200');
  const leaked = leakedCoordinateKeys(res.text);
  assert(
    leaked.length === 0,
    `detail response carries no coordinate keys${leaked.length ? ` (leaked: ${leaked.join(', ')})` : ''}`,
  );
  assert(
    (res.body?.data?.id ?? null) === first!.id,
    'detail still returns the requested technician',
  );
  assert('serviceArea' in (res.body?.data ?? {}), 'detail still returns coarse serviceArea');

  const missing = await api('GET', `/technicians/${crypto.randomUUID()}`);
  assert(missing.status === 404, 'unknown technician → 404 (behavior preserved)');

  // Pre-existing quirk, NOT introduced by 28.3A.1: this route does not call
  // assertUuid, so a malformed UUID reaches Postgres and surfaces as 500
  // (the sibling /photo route does validate and returns 400). Fixing it would
  // change an existing API contract, so this stage records it rather than
  // changing it. What matters here is that the failure stays SAFE: a generic
  // message with no coordinates, internals or stack.
  const bad = await api('GET', '/technicians/not-a-uuid');
  assert(
    bad.status === 400 || bad.status === 500,
    'malformed technician id → a safe error status (400/500, pre-existing 500 noted)',
  );
  assert(
    leakedCoordinateKeys(bad.text).length === 0,
    'malformed-id error leaks no coordinate keys',
  );
  assert(
    !/postgres|stack|at \w+ \(|node_modules|SELECT /i.test(bad.text),
    'malformed-id error exposes no internals or stack',
  );
}

async function testNearbyEndpoint(): Promise<void> {
  console.log('\nGET /technicians/nearby — PostGIS preserved, coordinates not');

  // Kitwe city centre (the pilot seed coordinate) as the probe point.
  const point = await query<{ lat: number; lon: number }>(
    `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon
       FROM technicians WHERE service_area = 'Kitwe' LIMIT 1`,
  );
  assert(point.length > 0, 'a Kitwe technician location exists in the database');
  const { lat, lon } = point[0];
  assert(
    Number.isFinite(lat) && Number.isFinite(lon),
    'the stored PostGIS point is still readable internally',
  );

  const near = await api(
    'GET',
    `/technicians/nearby?latitude=${lat}&longitude=${lon}&radius=50`,
  );
  assert(near.status === 200, 'nearby → 200 (radius search still functions)');
  const leaked = leakedCoordinateKeys(near.text);
  assert(
    leaked.length === 0,
    `nearby response carries no coordinate keys${leaked.length ? ` (leaked: ${leaked.join(', ')})` : ''}`,
  );

  const rows = (near.body?.data ?? []) as Record<string, unknown>[];
  assert(rows.length > 0, 'radius search still returns the Kitwe technicians');

  // Coarsened distance: every value must sit in a 100 m bucket.
  const distances = rows.map((r) => r.distance_meters as number);
  assert(
    distances.every((d) => Number.isFinite(d) && d % 100 === 0),
    'distance_meters is coarsened to 100 m buckets (no metre-precision leak)',
  );
  const ordered = [...distances].sort((a, b) => a - b);
  assert(
    distances.every((d, i) => d === ordered[i]),
    'results remain ordered by distance ascending (internal ranking preserved)',
  );

  // A radius too small to contain anything proves the PostGIS predicate still
  // filters (rather than returning every technician regardless of distance).
  const tiny = await api(
    'GET',
    `/technicians/nearby?latitude=${lat}&longitude=${lon}&radius=0.001`,
  );
  assert(tiny.status === 200, 'tiny-radius query → 200');
  assert(
    ((tiny.body?.data ?? []) as unknown[]).length < rows.length,
    'PostGIS radius filter still excludes out-of-range technicians',
  );

  // Input validation preserved.
  for (const [query, label] of [
    ['latitude=999&longitude=28', 'out-of-range latitude'],
    ['latitude=-12.8&longitude=999', 'out-of-range longitude'],
    ['latitude=abc&longitude=28', 'non-numeric latitude'],
    [`latitude=${lat}&longitude=${lon}&radius=0`, 'zero radius'],
    [`latitude=${lat}&longitude=${lon}&radius=9999`, 'oversized radius'],
    [`latitude=${lat}&longitude=${lon}&category=Nope`, 'unknown category'],
  ] as const) {
    const bad = await api('GET', `/technicians/nearby?${query}`);
    assert(bad.status === 400, `${label} → 400 (validation preserved)`);
  }
}

async function testInternalDispatchPreserved(): Promise<void> {
  console.log('\ninternal dispatch capability preserved');

  const withCoords = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM technicians
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        AND location IS NOT NULL`,
  );
  assert(
    Number(withCoords[0].n) > 0,
    'stored coordinates remain in the database for internal dispatch use',
  );

  // The eligibility helper still reads coordinates straight from the DB.
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/auth/authorization.ts', import.meta.url), 'utf8'),
  );
  assert(
    source.includes('SELECT latitude, longitude FROM service_requests'),
    'internal ST_Distance eligibility path still reads coordinates directly',
  );
  assert(
    source.includes('ST_Distance'),
    'internal PostGIS distance calculation is untouched',
  );
}

async function testNoOtherPublicExposure(): Promise<void> {
  console.log('\nno other public route leaks coordinates');

  // The public technician reviews bundle and photo route are adjacent public
  // surfaces; assert they stay coordinate-free too.
  const list = await api('GET', '/technicians');
  const first = (list.body?.data ?? [])[0] as { id: string } | undefined;
  for (const path of [`/technicians/${first!.id}/reviews`, '/categories']) {
    const res = await api('GET', path);
    assert(res.status === 200, `${path} → 200`);
    const leaked = leakedCoordinateKeys(res.text);
    assert(leaked.length === 0, `${path} carries no coordinate keys`);
  }
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testListEndpoint();
  await testDetailEndpoint();
  await testNearbyEndpoint();
  await testInternalDispatchPreserved();
  await testNoOtherPublicExposure();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error('Test runner crashed:', error);
  process.exitCode = 1;
});