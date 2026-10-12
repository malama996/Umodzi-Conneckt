/**
 * Task 28.3A.1 focused frontend tests: the location-privacy correction's client
 * half.
 *
 * The backend stopped returning technician coordinates on public routes, so the
 * frontend must not depend on them. This suite proves three things:
 *
 *   1. The API -> frontend mapper never reintroduces a coordinate.
 *   2. The prototype map still produces a marker for EVERY ranked technician
 *      (the real regression risk: the previous implementation skipped any
 *      technician without coordinates, so removing coordinates could have
 *      emptied the map).
 *   3. Marker positions come from the COARSE service-area city centre, never
 *      from a stored precise coordinate.
 *
 * Pure unit tests over the real modules - no server, no network.
 *
 * Run from the frontend folder:
 *   npx --no-install tsx scripts/task28-3a1-location-privacy-tests.ts
 */
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:9999/api/v1';

import { mapApiTechnicianToFrontend } from '../lib/api/technicianMapper';
import type { MapPoint } from '../lib/mapData';
import { MOCK_CITY_COORDINATES, getServiceAreaPoint, toTechnicianMapMarkers } from '../lib/mapData';
import type { ApiTechnician } from '../lib/api/techniciansApi';
import type { RankedTechnician, Technician } from '../lib/types';

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
/* Fixtures - shaped like REAL API responses (which carry no coords)    */
/* ------------------------------------------------------------------ */

/** Exactly the field set the corrected public projection returns. */
function apiTechnician(overrides: Partial<ApiTechnician> = {}): ApiTechnician {
  return {
    id: crypto.randomUUID(),
    name: 'Bwalya K.',
    category: 'Plumbing',
    skills: ['Pipe repair'],
    serviceArea: 'Ndola',
    rating: 4.7,
    jobs: 35,
    verified: true,
    availability: 'Available today',
    availabilityStatus: 'available',
    accountStatus: 'active',
    bio: null,
    hasPhoto: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function ranked(technician: Technician, matchedCategory = technician.category): RankedTechnician {
  return { technician, matchedCategory } as RankedTechnician;
}

/* ------------------------------------------------------------------ */
/* 1. The mapper does not reintroduce a coordinate                    */
/* ------------------------------------------------------------------ */

function testMapperOmitsCoordinates(): void {
  console.log('\nAPI -> frontend mapper');

  const mapped = mapApiTechnicianToFrontend(apiTechnician());

  assert(!('latitude' in mapped), 'mapper emits no latitude property');
  assert(!('longitude' in mapped), 'mapper emits no longitude property');
  assert(mapped.latitude === undefined, 'Technician.latitude is undefined');
  assert(mapped.longitude === undefined, 'Technician.longitude is undefined');

  // Even if a server ever sent one, the mapper must not carry it through as
  // display data. This is the defence-in-depth half of the boundary.
  const withCoords = mapApiTechnicianToFrontend(
    apiTechnician({ latitude: -12.9587, longitude: 28.6366 }),
  );
  assert(
    withCoords.latitude === undefined && withCoords.longitude === undefined,
    'mapper still drops coordinates if a server were to send them',
  );

  // The coarse location signal that replaced them must survive.
  assert(mapped.serviceArea === 'Ndola', 'coarse serviceArea is preserved by the mapper');
  assert(mapped.city === 'Ndola', 'city is still derived from serviceArea');
}

/* ------------------------------------------------------------------ */
/* 2. The map still renders a marker for every technician              */
/* ------------------------------------------------------------------ */

function testMapStillRendersMarkers(): void {
  console.log('\nprototype map markers');

  const customer: MapPoint = MOCK_CITY_COORDINATES.Kitwe;

  const technicians: Technician[] = [
    mapApiTechnicianToFrontend(apiTechnician({ name: 'A', serviceArea: 'Kitwe' })),
    mapApiTechnicianToFrontend(apiTechnician({ name: 'B', serviceArea: 'Ndola' })),
    mapApiTechnicianToFrontend(apiTechnician({ name: 'C', serviceArea: 'Kitwe' })),
  ];
  const markers = toTechnicianMapMarkers(
    technicians.map((t) => ranked(t)),
    customer,
  );

  assert(markers.length === 3, `every technician yields a marker (got ${markers.length}/3)`);
  assert(
    markers.every((m) => Number.isFinite(m.latitude) && Number.isFinite(m.longitude)),
    'every marker has a finite position (map is not empty)',
  );
  assert(
    markers.every((m) => Number.isFinite(m.distanceKm)),
    'every marker carries a finite distanceKm',
  );

  // Order must be preserved: this is a pass-through, not a re-rank.
  assert(
    markers.map((m) => m.name).join(',') === 'A,B,C',
    'input order is preserved (no re-ranking)',
  );
}

/* ------------------------------------------------------------------ */
/* 3. Marker positions are coarse service-area centres                 */
/* ------------------------------------------------------------------ */

function testMarkersAreCoarse(): void {
  console.log('\nmarker positions are coarse, not precise');

  const customer: MapPoint = MOCK_CITY_COORDINATES.Kitwe;
  const ndola = mapApiTechnicianToFrontend(apiTechnician({ serviceArea: 'Ndola' }));
  const [marker] = toTechnicianMapMarkers([ranked(ndola)], customer);

  const centre = MOCK_CITY_COORDINATES.Ndola;
  assert(
    marker.latitude === centre.latitude && marker.longitude === centre.longitude,
    'marker sits exactly on the declared service-area city centre',
  );
  assert(marker.serviceArea === 'Ndola', 'marker still reports the service area as its location');

  // Two technicians in the same service area must coincide, because the only
  // location signal available is the area - not an individual position.
  const a = mapApiTechnicianToFrontend(apiTechnician({ name: 'A', serviceArea: 'Ndola' }));
  const b = mapApiTechnicianToFrontend(apiTechnician({ name: 'B', serviceArea: 'Ndola' }));
  const [ma, mb] = toTechnicianMapMarkers([ranked(a), ranked(b)], customer);
  assert(
    ma.latitude === mb.latitude && ma.longitude === mb.longitude,
    'technicians sharing a service area share one coarse position (no per-technician fix)',
  );

  // Unknown service area must fall back rather than produce NaN.
  const unknown = mapApiTechnicianToFrontend(apiTechnician({ serviceArea: 'Nowhere' }));
  const [fallback] = toTechnicianMapMarkers([ranked(unknown)], customer);
  assert(
    Number.isFinite(fallback.latitude) && Number.isFinite(fallback.longitude),
    'an unrecognised service area still yields a finite fallback position',
  );
  assert(
    fallback.latitude === MOCK_CITY_COORDINATES.Kitwe.latitude,
    'unrecognised service area falls back to the default pilot city',
  );
}

/* ------------------------------------------------------------------ */
/* 4. getServiceAreaPoint is total and stable                         */
/* ------------------------------------------------------------------ */

function testServiceAreaPoint(): void {
  console.log('\ngetServiceAreaPoint');

  assert(
    getServiceAreaPoint('Kitwe') === MOCK_CITY_COORDINATES.Kitwe,
    'known service area returns the shared city-centre reference',
  );
  assert(
    getServiceAreaPoint('Kitwe') === getServiceAreaPoint('Kitwe'),
    'repeated calls return a stable reference (no render churn)',
  );
  assert(
    getServiceAreaPoint('Atlantis') === MOCK_CITY_COORDINATES.Kitwe,
    'unknown service area falls back to the default pilot city',
  );
}

/* ------------------------------------------------------------------ */
/* Runner                                                             */
/* ------------------------------------------------------------------ */

function main(): void {
  testMapperOmitsCoordinates();
  testMapStillRendersMarkers();
  testMarkersAreCoarse();
  testServiceAreaPoint();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
