/**
 * Task 23 focused unit tests: password hashing (argon2id), JWT config,
 * refresh-session primitives, registration/login validation rules, and
 * shared id/email helpers.
 *
 * Run from the backend folder:
 *   npx tsx scripts/task23-tests.ts
 *
 * No server and no database are required: every path exercised here runs
 * BEFORE any SQL (validation and config rules) or touches only pure
 * helpers. The database-backed flows live in task23-api-tests.ts and the
 * schema runner in task23-migration-tests.ts.
 */

import { HttpError } from '../src/auth/httpError.js';
import {
  GENERIC_LOGIN_ERROR,
  assertUuid,
  isUuid,
  login,
  normalizeEmail,
  registerAccount,
} from '../src/auth/authService.js';
import { loadJwtConfig } from '../src/auth/jwt.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../src/auth/password.js';
import {
  DEFAULT_REFRESH_TTL,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  ROTATION_GRACE_MS,
  hashRefreshToken,
  parseTtlSeconds,
} from '../src/auth/sessionService.js';
import { CANONICAL_CATEGORIES } from '../src/types/api.js';

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

/** Run fn and return the HttpError it threw (fails the test if none). */
async function expectHttpError(
  fn: () => Promise<unknown>,
  name: string,
): Promise<HttpError | null> {
  try {
    await fn();
    failed += 1;
    console.log(`  FAIL ${name} (no error thrown)`);
    return null;
  } catch (error) {
    if (error instanceof HttpError) {
      passed += 1;
      console.log(`  ok   ${name}`);
      return error;
    }
    failed += 1;
    console.log(`  FAIL ${name} (wrong error type: ${String(error)})`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Password hashing                                                    */
/* ------------------------------------------------------------------ */

async function testPasswords(): Promise<void> {
  console.log('\npassword.ts — argon2id hashing');

  const digest = await hashPassword('correct horse battery staple');
  assert(digest.startsWith('$argon2id$'), 'hashPassword produces argon2id digests');
  assert(!digest.includes('correct horse'), 'digest never contains the plaintext');

  assert(
    await verifyPassword(digest, 'correct horse battery staple'),
    'verifyPassword accepts the correct password',
  );
  assert(
    !(await verifyPassword(digest, 'Correct horse battery staple')),
    'verifyPassword rejects a different password (case-sensitive)',
  );
  assert(
    !(await verifyPassword(digest, '')),
    'verifyPassword rejects an empty password',
  );

  const digest2 = await hashPassword('correct horse battery staple');
  assert(digest !== digest2, 'hashing the same password twice yields distinct salts');

  assert(
    !(await verifyPassword('not-a-hash', 'anything')),
    'verifyPassword returns false for malformed digests (never throws)',
  );
  assert(
    !(await verifyPassword('$2b$10$abcdefghijklmnopqrstuv', 'anything')),
    'verifyPassword returns false for foreign (bcrypt-shaped) digests',
  );

  assert(
    !(await verifyAgainstDummy('anything')),
    'verifyAgainstDummy always answers false (timing equalisation only)',
  );
}

/* ------------------------------------------------------------------ */
/* JWT configuration                                                   */
/* ------------------------------------------------------------------ */

function testJwtConfig(): void {
  console.log('\njwt.ts — configuration rules');

  try {
    loadJwtConfig({} as NodeJS.ProcessEnv);
    assert(false, 'loadJwtConfig throws when JWT_SECRET is missing');
  } catch {
    assert(true, 'loadJwtConfig throws when JWT_SECRET is missing');
  }

  try {
    loadJwtConfig({ JWT_SECRET: 'short-secret' } as NodeJS.ProcessEnv);
    assert(false, 'loadJwtConfig rejects secrets below 32 characters');
  } catch {
    assert(true, 'loadJwtConfig rejects secrets below 32 characters');
  }

  const secret32 = 'a'.repeat(32);
  const config = loadJwtConfig({ JWT_SECRET: secret32 } as NodeJS.ProcessEnv);
  assert(config.secret === secret32, 'accepts a 32-character secret');
  assert(config.issuer === 'umodzi-connect-api', 'default issuer is configured');
  assert(config.audience === 'umodzi-connect-web', 'default audience is configured');
  assert(config.accessTtl === '15m', 'default access token TTL is 15 minutes');

  const custom = loadJwtConfig({
    JWT_SECRET: secret32,
    JWT_ISSUER: 'my-issuer',
    JWT_AUDIENCE: 'my-audience',
    ACCESS_TOKEN_TTL: '5m',
  } as NodeJS.ProcessEnv);
  assert(custom.issuer === 'my-issuer', 'issuer is read from the environment');
  assert(custom.audience === 'my-audience', 'audience is read from the environment');
  assert(custom.accessTtl === '5m', 'access TTL is read from the environment');
}

/* ------------------------------------------------------------------ */
/* Refresh-session primitives                                          */
/* ------------------------------------------------------------------ */

function testSessionPrimitives(): void {
  console.log('\nsessionService.ts — session primitives');

  const raw1 = 'raw-refresh-token-one';
  const raw2 = 'raw-refresh-token-two';
  const hash1 = hashRefreshToken(raw1);

  assert(/^[0-9a-f]{64}$/.test(hash1), 'hashRefreshToken is a 64-char SHA-256 hex digest');
  assert(hashRefreshToken(raw1) === hash1, 'hashRefreshToken is deterministic');
  assert(hashRefreshToken(raw2) !== hash1, 'distinct tokens hash differently');
  assert(hash1 !== raw1, 'the stored form is never the raw token');
  assert(!hash1.includes('raw-refresh'), 'the hash does not contain the raw token');

  assert(REFRESH_COOKIE_NAME === 'umodzi_refresh', 'refresh cookie name is fixed');
  assert(REFRESH_COOKIE_PATH === '/api/v1/auth', 'cookie is scoped to the auth endpoints');
  assert(ROTATION_GRACE_MS === 60_000, 'rotation grace window is 60 seconds');
  assert(DEFAULT_REFRESH_TTL === '7d', 'default refresh session TTL is 7 days');

  assert(parseTtlSeconds('7d', '1m') === 604800, "TTL '7d' = 604800s");
  assert(parseTtlSeconds('15m', '1d') === 900, "TTL '15m' = 900s");
  assert(parseTtlSeconds('2h', '1d') === 7200, "TTL '2h' = 7200s");
  assert(parseTtlSeconds('30s', '1d') === 30, "TTL '30s' = 30s");
  assert(parseTtlSeconds('3600', '1d') === 3600, 'bare seconds are accepted');
  assert(parseTtlSeconds(undefined, '7d') === 604800, 'undefined falls back to the default');

  let threw = false;
  try {
    parseTtlSeconds('banana', '7d');
  } catch {
    threw = true;
  }
  assert(threw, 'a malformed TTL throws instead of silently mis-configuring expiry');

  threw = false;
  try {
    parseTtlSeconds('0m', '7d');
  } catch {
    threw = true;
  }
  assert(threw, 'a zero TTL throws (sessions must expire)');
}

/* ------------------------------------------------------------------ */
/* Registration / login validation (pre-database rules)                */
/* ------------------------------------------------------------------ */

async function testRegisterValidation(): Promise<void> {
  console.log('\nauthService.ts — registration rules');

  const adminError = await expectHttpError(
    () =>
      registerAccount({
        email: 'sneaky@example.com',
        password: 'password123',
        firstName: 'Sneaky',
        lastName: 'Admin',
        role: 'administrator',
      }),
    'public registration rejects role administrator with an error',
  );
  assert(adminError?.statusCode === 403, 'administrator registration is rejected with 403');

  const shortPassword = await expectHttpError(
    () =>
      registerAccount({
        email: 'short@example.com',
        password: 'short',
        firstName: 'Ann',
        lastName: 'Lee',
        role: 'customer',
      }),
    'registration rejects passwords below 8 characters',
  );
  assert(shortPassword?.statusCode === 400, 'short password is a 400 validation failure');

  const badEmail = await expectHttpError(
    () =>
      registerAccount({
        email: 'not-an-email',
        password: 'password123',
        firstName: 'Ann',
        lastName: 'Lee',
        role: 'customer',
      }),
    'registration rejects malformed emails',
  );
  assert(badEmail?.statusCode === 400, 'malformed email is a 400 validation failure');

  const techNoCategory = await expectHttpError(
    () =>
      registerAccount({
        email: 'tech@example.com',
        password: 'password123',
        firstName: 'Tam',
        lastName: 'Nyo',
        role: 'technician',
        serviceArea: 'Kitwe',
      }),
    'technician registration requires a service category',
  );
  assert(techNoCategory?.statusCode === 400, 'missing technician category is a 400');

  const techNoArea = await expectHttpError(
    () =>
      registerAccount({
        email: 'tech2@example.com',
        password: 'password123',
        firstName: 'Tam',
        lastName: 'Nyo',
        role: 'technician',
        category: 'Plumbing',
      }),
    'technician registration requires a service area',
  );
  assert(techNoArea?.statusCode === 400, 'missing technician service area is a 400');

  const badCategory = await expectHttpError(
    () =>
      registerAccount({
        email: 'tech3@example.com',
        password: 'password123',
        firstName: 'Tam',
        lastName: 'Nyo',
        role: 'technician',
        category: 'Underwater Basket Weaving',
        serviceArea: 'Kitwe',
      }),
    'technician registration rejects non-canonical categories',
  );
  assert(badCategory?.statusCode === 400, 'non-canonical category is a 400');
}

async function testLoginValidation(): Promise<void> {
  console.log('\nauthService.ts — login pre-database rules');

  const empty = await expectHttpError(
    () => login('', ''),
    'login with empty credentials is rejected',
  );
  assert(empty?.statusCode === 401, 'empty credentials answer 401 (no schema probing)');
  assert(
    empty?.message === GENERIC_LOGIN_ERROR,
    'empty credentials use the same generic message',
  );

  assert(
    GENERIC_LOGIN_ERROR === 'Invalid email or password',
    'generic login message is the specified wording',
  );
}

/* ------------------------------------------------------------------ */
/* Shared helpers and type contracts                                   */
/* ------------------------------------------------------------------ */

function testHelpers(): void {
  console.log('\nhelpers + type contracts');

  assert(normalizeEmail('  User@Example.COM ') === 'user@example.com', 'emails are trimmed/lowered');
  assert(normalizeEmail('a@b.c') === 'a@b.c', 'already-normalized emails are unchanged');

  const uuid = 'a3f1c2d4-0b9e-4f7a-8c1d-2e5b6a7c8d9e';
  assert(isUuid(uuid), 'isUuid accepts a canonical UUID');
  assert(!isUuid('not-a-uuid'), 'isUuid rejects arbitrary strings');
  assert(!isUuid('a3f1c2d4-0b9e-4f7a-8c1d'), 'isUuid rejects truncated UUIDs');

  let threw = false;
  try {
    assertUuid('nope');
  } catch (error) {
    threw = error instanceof HttpError && error.statusCode === 400;
  }
  assert(threw, 'assertUuid raises HttpError 400 (not a 500) for invalid ids');

  threw = false;
  try {
    assertUuid(uuid);
  } catch {
    threw = true;
  }
  assert(!threw, 'assertUuid passes canonical UUIDs');

  assert(CANONICAL_CATEGORIES.length === 9, 'exactly 9 canonical categories');
  assert(
    [...CANONICAL_CATEGORIES].join('|') ===
      'Plumbing|Electrical|Automotive|HVAC|Appliance Repair|Refrigeration|Electronics|ICT|Handyman',
    'canonical category list matches the frontend source of truth',
  );
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testPasswords();
  testJwtConfig();
  testSessionPrimitives();
  await testRegisterValidation();
  await testLoginValidation();
  testHelpers();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error('Test runner crashed:', error);
  process.exitCode = 1;
});
