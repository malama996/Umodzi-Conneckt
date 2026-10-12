/**
 * Task 31 regression checks: service-request creation validation.
 *
 * Only invalid inputs are exercised — every one throws BEFORE any network
 * call, so this script has no side effects and needs no running server.
 * Bounds mirror the backend schema (description min 8 / max 2000).
 */
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:9999/api/v1';

import { createServiceRequest } from '../lib/services/requestService';

let passed = 0;
let failed = 0;

async function expectThrow(
  name: string,
  input: Parameters<typeof createServiceRequest>[0],
  fragment: string,
): Promise<void> {
  try {
    await createServiceRequest(input);
    failed += 1;
    console.log(`  FAIL ${name} (no error thrown)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(fragment)) {
      passed += 1;
      console.log(`  ok   ${name}`);
    } else {
      failed += 1;
      console.log(`  FAIL ${name} (message "${message}" lacks "${fragment}")`);
    }
  }
}

async function main(): Promise<void> {
  await expectThrow(
    'blank description rejected',
    { description: '   ', category: 'Plumbing', city: 'Kitwe' },
    'at least 8 characters',
  );
  await expectThrow(
    '7-char description rejected (server min is 8)',
    { description: 'Leaky!', category: 'Plumbing', city: 'Kitwe' },
    'at least 8 characters',
  );
  await expectThrow(
    '2001-char description rejected (server max is 2000)',
    { description: 'x'.repeat(2001), category: 'Plumbing', city: 'Kitwe' },
    'at most 2000 characters',
  );
  await expectThrow(
    'blank city rejected',
    { description: 'Kitchen sink cold tap drips constantly.', category: 'Plumbing', city: '  ' },
    'City is required',
  );
  await expectThrow(
    'unknown category rejected',
    {
      description: 'Kitchen sink cold tap drips constantly.',
      city: 'Kitwe',
      category: 'Plumbng',
    } as unknown as Parameters<typeof createServiceRequest>[0],
    'Invalid category',
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
