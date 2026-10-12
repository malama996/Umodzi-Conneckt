/**
 * File storage tests (production upload persistence):
 *   - LocalFileStorage roundtrip on a temp directory (default provider);
 *   - createFileStorage validation (missing Supabase config, unknown
 *     provider) — the same errors that fail the deploy at boot;
 *   - SupabaseFileStorage REST behaviour against a stubbed global fetch:
 *     correct bucket routing, auth header, upsert on replace, 404→null
 *     reads, idempotent deletes, and error propagation.
 *
 * Run from the backend folder:
 *   npx tsx scripts/storage-tests.ts
 *
 * No server, no database and no network are required.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createFileStorage,
  LocalFileStorage,
  SupabaseFileStorage,
} from '../src/storage/fileStorage.js';

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

async function expectThrow(
  fn: () => Promise<unknown> | unknown,
  name: string,
  messageIncludes?: string,
): Promise<void> {
  try {
    await fn();
    failed += 1;
    console.log(`  FAIL ${name} (no error thrown)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const matches = messageIncludes
      ? message.includes(messageIncludes)
      : true;
    if (matches) {
      passed += 1;
      console.log(`  ok   ${name}`);
    } else {
      failed += 1;
      console.log(
        `  FAIL ${name} (message ${JSON.stringify(message)} lacks ${JSON.stringify(messageIncludes)})`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Stubbed fetch harness                                              */
/* ------------------------------------------------------------------ */

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

type FetchStub = (url: string, init: RequestInit) => Promise<Response>;

const realFetch = globalThis.fetch;

function stubFetch(handler: FetchStub): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    const body =
      init?.body instanceof Uint8Array
        ? init.body
        : init?.body == null
          ? null
          : new TextEncoder().encode(String(init.body));
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    return handler(url, { ...init, method: init?.method ?? 'GET' });
  }) as typeof fetch;
  return calls;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

const SUPA_URL = 'https://example.supabase.co';
const SUPABASE_ENV: NodeJS.ProcessEnv = {
  STORAGE_PROVIDER: 'supabase',
  SUPABASE_URL: SUPA_URL,
  SUPABASE_STORAGE_KEY: 'test-service-key',
  SUPABASE_PUBLIC_BUCKET: 'profile-photos',
  SUPABASE_PRIVATE_BUCKET: 'verification-docs',
} as NodeJS.ProcessEnv;

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

async function testLocalProvider(): Promise<void> {
  console.log('\nLocal provider (default):');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'umodzi-store-'));
  try {
    const env = { STORAGE_DIR: tempRoot } as NodeJS.ProcessEnv;
    const storage = createFileStorage(env);
    assert(
      storage instanceof LocalFileStorage,
      'defaults to LocalFileStorage when STORAGE_PROVIDER is unset',
    );

    const key = 'profiles/11111111-2222-3333-4444-555555555555.jpg';
    const payload = Buffer.from('not-really-a-jpeg-but-test-bytes');
    await storage.put(key, payload);
    const readBack = await storage.read(key);
    assert(
      readBack !== null && readBack.equals(payload),
      'put → read roundtrip returns identical bytes',
    );
    assert(
      (await storage.read('profiles/does-not-exist.jpg')) === null,
      'read of a missing key returns null',
    );
    await storage.remove(key);
    assert(
      (await storage.read(key)) === null,
      'remove deletes the object',
    );
    await storage.remove(key); // idempotent
    assert(true, 'removing an already-gone object does not throw');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function testProviderValidation(): Promise<void> {
  console.log('\nProvider selection validation:');
  await expectThrow(
    () => createFileStorage({ STORAGE_PROVIDER: 's3' } as NodeJS.ProcessEnv),
    'unknown provider throws',
    'Unknown STORAGE_PROVIDER',
  );
  await expectThrow(
    () =>
      createFileStorage({
        STORAGE_PROVIDER: 'supabase',
        SUPABASE_URL: SUPA_URL,
      } as NodeJS.ProcessEnv),
    'supabase provider with missing config throws',
    'SUPABASE_STORAGE_KEY',
  );
  const complete = createFileStorage(SUPABASE_ENV);
  assert(
    complete instanceof SupabaseFileStorage,
    'supabase provider builds when all env vars are present',
  );
}

async function testSupabasePut(): Promise<void> {
  console.log('\nSupabase provider — put:');
  const storage = createFileStorage(SUPABASE_ENV) as SupabaseFileStorage;
  const calls = stubFetch(async () => new Response('{}', { status: 200 }));
  try {
    const payload = Buffer.from('photo-bytes');
    await storage.put('profiles/abc.jpg', payload);
    const call = calls[0];
    assert(
      call?.method === 'POST' &&
        call.url ===
          `${SUPA_URL}/storage/v1/object/profile-photos/profiles/abc.jpg`,
      'photo put → POST to public bucket object URL',
    );
    assert(
      call?.headers['authorization'] === 'Bearer test-service-key',
      'put sends the server-side bearer token',
    );
    assert(
      call?.headers['x-upsert'] === 'true',
      'put upserts so photo replacement overwrites the same key',
    );
    assert(
      call?.body !== null &&
        Buffer.from(call!.body!).equals(payload),
      'put uploads the exact bytes',
    );

    await storage.put('verification/tech1/doc.pdf', Buffer.from('pdf'));
    assert(
      calls[1]?.url ===
        `${SUPA_URL}/storage/v1/object/verification-docs/verification/tech1/doc.pdf`,
      'verification keys route to the private bucket',
    );
  } finally {
    restoreFetch();
  }

  const failing = stubFetch(async () => new Response('boom', { status: 500 }));
  try {
    await expectThrow(
      () => storage.put('profiles/x.jpg', Buffer.from('x')),
      'put propagates a storage-service failure',
      'HTTP 500',
    );
    assert(failing.length === 1, 'failed put still issued one request');
  } finally {
    restoreFetch();
  }
}

async function testSupabaseRead(): Promise<void> {
  console.log('\nSupabase provider — read:');
  const storage = createFileStorage(SUPABASE_ENV) as SupabaseFileStorage;
  const payload = Buffer.from('stored-bytes');
  const calls = stubFetch(
    async () =>
      new Response(new Uint8Array(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
  );
  try {
    const read = await storage.read('profiles/abc.jpg');
    assert(
      read !== null && read.equals(payload),
      'read returns the stored bytes',
    );
    assert(
      calls[0]?.method === 'GET' &&
        calls[0].headers['authorization'] === 'Bearer test-service-key',
      'read authenticates with the bearer token',
    );
  } finally {
    restoreFetch();
  }

  stubFetch(async () => new Response('not found', { status: 404 }));
  try {
    assert(
      (await storage.read('profiles/missing.jpg')) === null,
      'read maps 404 to null (routes answer 404, not 500)',
    );
  } finally {
    restoreFetch();
  }

  stubFetch(async () => new Response('boom', { status: 500 }));
  try {
    await expectThrow(
      () => storage.read('profiles/abc.jpg'),
      'read propagates a storage-service failure',
      'HTTP 500',
    );
  } finally {
    restoreFetch();
  }
}

async function testSupabaseRemove(): Promise<void> {
  console.log('\nSupabase provider — remove:');
  const storage = createFileStorage(SUPABASE_ENV) as SupabaseFileStorage;
  const calls = stubFetch(async () => new Response(null, { status: 204 }));
  try {
    await storage.remove('profiles/old.jpg');
    assert(
      calls[0]?.method === 'DELETE' &&
        calls[0].url ===
          `${SUPA_URL}/storage/v1/object/profile-photos/profiles/old.jpg`,
      'remove issues DELETE on the object URL',
    );
  } finally {
    restoreFetch();
  }

  stubFetch(async () => new Response('gone', { status: 404 }));
  try {
    await storage.remove('profiles/gone.jpg');
    assert(true, 'remove of an already-gone object does not throw (404)');
  } finally {
    restoreFetch();
  }

  stubFetch(async () => new Response('boom', { status: 500 }));
  try {
    await expectThrow(
      () => storage.remove('profiles/abc.jpg'),
      'remove propagates a storage-service failure',
      'HTTP 500',
    );
  } finally {
    restoreFetch();
  }
}

async function testKeySafety(): Promise<void> {
  console.log('\nKey safety (shared by both providers):');
  const storage = createFileStorage(SUPABASE_ENV) as SupabaseFileStorage;
  const calls = stubFetch(async () => new Response('{}', { status: 200 }));
  try {
    await expectThrow(
      () => storage.put('../../etc/passwd', Buffer.from('x')),
      'traversal keys are rejected before any request',
      'Invalid storage key',
    );
    await expectThrow(
      () => storage.read('/absolute/path'),
      'absolute keys are rejected',
      'Invalid storage key',
    );
    assert(calls.length === 0, 'no request is issued for a rejected key');
  } finally {
    restoreFetch();
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testLocalProvider();
  await testProviderValidation();
  await testSupabasePut();
  await testSupabaseRead();
  await testSupabaseRemove();
  await testKeySafety();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  restoreFetch();
  console.error('Unexpected test failure:', error);
  process.exit(1);
});
