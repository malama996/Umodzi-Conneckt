/**
 * Task 26 focused frontend tests: the dispatch eligibility verification
 * gate (§10/§23) and the profile-completeness + display helpers.
 *
 * Run from the frontend folder:
 *   npx --no-install tsx scripts/task26-tests.ts
 *
 * The eligibility service is exercised through the same code path the UI
 * uses (getEligibleTechnicians → technicians API → single mapper
 * boundary) with a stubbed global fetch — scoring, ranking, cascading,
 * and the lifecycle are untouched by Task 26 and remain covered by the
 * Task 22 suite.
 */
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:9999/api/v1';

import { getEligibleTechnicians } from '../lib/services/dispatchService';
import type { ApiTechnician } from '../lib/api/techniciansApi';
import type { ServiceRequest } from '../lib/types';
import {
  formatBytes,
  profileCompleteness,
  verificationDisplay,
  verificationLabel,
  verificationTone,
} from '../lib/services/technicianProfileService';
import type { OwnTechnicianProfile } from '../lib/api/technicianProfileApi';

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
/* Eligibility fixtures                                                */
/* ------------------------------------------------------------------ */

function apiTech(overrides: Partial<ApiTechnician>): ApiTechnician {
  return {
    id: crypto.randomUUID(),
    name: 'Fixture Tech',
    category: 'Electrical',
    skills: ['Wiring'],
    serviceArea: 'Kitwe',
    rating: 4,
    jobs: 10,
    verified: true,
    availability: 'Available now',
    availabilityStatus: 'available',
    accountStatus: 'active',
    latitude: -12.81,
    longitude: 28.21,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const REQUEST: ServiceRequest = {
  id: 'req-1',
  description: 'Fixture request',
  category: 'Electrical',
  city: 'Kitwe',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function stubFetch(rows: ApiTechnician[]): void {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ data: rows }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

async function testEligibilityGate(): Promise<void> {
  console.log('\ndispatch eligibility — verification is a hard gate (Task 26 §10)');

  stubFetch([
    apiTech({ name: 'Eligible', verified: true }),
    apiTech({ name: 'Unverified', verified: false }),
  ]);
  const eligible = await getEligibleTechnicians(REQUEST);
  assert(eligible.length === 1, 'only the verified technician is eligible');
  assert(
    eligible[0]?.technician.name === 'Eligible',
    'unverified technician excluded even though active + available + matching',
  );

  stubFetch([apiTech({ name: 'UnverifiedAvailable', verified: false })]);
  const none = await getEligibleTechnicians(REQUEST);
  assert(
    none.length === 0,
    'unverified + available is NOT eligible (availability never substitutes for verification)',
  );

  stubFetch([
    apiTech({ name: 'VerifiedUnavailable', verified: true, availabilityStatus: 'unavailable' }),
  ]);
  assert(
    (await getEligibleTechnicians(REQUEST)).length === 0,
    'verified + unavailable remains excluded (availability is a separate gate)',
  );

  stubFetch([apiTech({ name: 'VerifiedSuspended', verified: true, accountStatus: 'suspended' })]);
  assert(
    (await getEligibleTechnicians(REQUEST)).length === 0,
    'verified + suspended remains excluded (account gate intact)',
  );

  stubFetch([apiTech({ name: 'VerifiedInactive', verified: true, accountStatus: 'inactive' })]);
  assert(
    (await getEligibleTechnicians(REQUEST)).length === 0,
    'verified + inactive remains excluded',
  );

  stubFetch([apiTech({ name: 'WrongCategory', verified: true, category: 'Plumbing' })]);
  assert((await getEligibleTechnicians(REQUEST)).length === 0, 'category rule intact');

  stubFetch([apiTech({ name: 'WrongCity', verified: true, serviceArea: 'Ndola' })]);
  assert((await getEligibleTechnicians(REQUEST)).length === 0, 'service-area/city rule intact');

  stubFetch([
    apiTech({ name: 'First', verified: true }),
    apiTech({ name: 'Excluded', verified: false }),
    apiTech({ name: 'Second', verified: true }),
  ]);
  const order = await getEligibleTechnicians(REQUEST);
  assert(
    order.length === 2 &&
      order[0].technician.name === 'First' &&
      order[1].technician.name === 'Second',
    'input order preserved for the eligible survivors (stable filter)',
  );
}

/* ------------------------------------------------------------------ */
/* Completeness + display helpers                                      */
/* ------------------------------------------------------------------ */

function ownProfile(overrides: Partial<OwnTechnicianProfile>): OwnTechnicianProfile {
  return {
    id: 't1',
    name: 'Fixture Tech',
    category: 'Electrical',
    skills: [],
    serviceArea: '',
    bio: null,
    hasPhoto: false,
    rating: 0,
    jobs: 0,
    availability: '',
    availabilityStatus: 'unavailable',
    accountStatus: 'active',
    verified: false,
    verificationStatus: 'unverified',
    verificationRejectionReason: null,
    verificationSubmittedAt: null,
    verificationReviewedAt: null,
    documents: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function testCompleteness(): void {
  console.log('\nprofile completeness — computed from real fields only');

  assert(profileCompleteness(ownProfile({})).percent === 0, 'empty profile → 0%');
  assert(
    profileCompleteness(
      ownProfile({
        bio: 'Real bio',
        skills: ['Wiring'],
        hasPhoto: true,
        serviceArea: 'Kitwe',
        availability: 'Available now',
      }),
    ).percent === 100,
    'complete profile → 100%',
  );
  assert(profileCompleteness(ownProfile({ bio: 'Real bio' })).percent === 20, 'one field → 20%');
  assert(
    profileCompleteness(
      ownProfile({ bio: 'b', skills: ['s'], hasPhoto: true, serviceArea: 'Kitwe' }),
    ).percent === 80,
    'four of five fields → 80%',
  );
  assert(
    profileCompleteness(ownProfile({ bio: '   ' })).percent === 0,
    'whitespace-only bio does not count',
  );
  const checks = profileCompleteness(ownProfile({ hasPhoto: true })).checks;
  assert(
    checks.find((c) => c.key === 'photo')?.done === true &&
      checks.filter((c) => c.done).length === 1,
    'each check is independent (photo only)',
  );
}

function testDisplayHelpers(): void {
  console.log('\nverification display helpers');

  assert(verificationDisplay('unverified').heading === 'Not submitted', 'unverified heading');
  assert(verificationDisplay('pending').heading === 'Pending review', 'pending heading');
  assert(verificationDisplay('verified').heading === 'Verified', 'verified heading');
  assert(verificationDisplay('rejected').heading === 'Action required', 'rejected heading');
  assert(verificationTone('verified') === 'success', 'verified tone = success');
  assert(verificationTone('rejected') === 'coral', 'rejected tone = coral (visible failure)');
  assert(verificationTone('pending') === 'warning', 'pending tone = warning');
  assert(verificationLabel('pending') === 'Pending review', 'label matches panel copy');
  assert(formatBytes(512) === '512 B', 'bytes');
  assert(formatBytes(2048) === '2.0 KB', 'kilobytes');
  assert(formatBytes(3 * 1024 * 1024) === '3.00 MB', 'megabytes');
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testEligibilityGate();
  testCompleteness();
  testDisplayHelpers();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
