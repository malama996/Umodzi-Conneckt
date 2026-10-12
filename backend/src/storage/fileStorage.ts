import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * File storage abstraction (Task 26).
 *
 * The domain model and database records only ever carry an OPAQUE
 * `storage_key` (e.g. `verification/<technicianId>/<docId>.pdf`). How a
 * key maps to bytes is entirely a deployment concern behind this
 * interface — the default implementation stores under a server-local
 * directory configured by `STORAGE_DIR`, and a future object store
 * (Task 28) implements the same interface without touching routes,
 * services, or records.
 *
 * Rules enforced here:
 *   - keys are validated strictly (no traversal, no absolute paths), so a
 *     hostile key can never escape the storage root;
 *   - the root directory is created on demand and is never part of any
 *     API payload or database value;
 *   - reads return null for missing keys (routes map that to 404).
 */
export interface FileStorage {
  put(key: string, buffer: Buffer): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/._-]{0,255}$/i;

/** Validate an opaque storage key. Throws on anything unsafe. */
export function assertStorageKey(key: string): void {
  if (
    !KEY_PATTERN.test(key) ||
    key.includes('..') ||
    key.startsWith('/') ||
    key.endsWith('/')
  ) {
    throw new Error('Invalid storage key');
  }
}

export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolve(key: string): string {
    assertStorageKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep) && full !== this.root) {
      throw new Error('Invalid storage key');
    }
    return full;
  }

  async put(key: string, buffer: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch {
      /* already gone */
    }
  }
}

/**
 * Supabase Storage (S3-style object store over its REST API) — the
 * production provider for hosted platforms whose local disk is EPHEMERAL
 * (e.g. Render: every redeploy/restart wipes `var/uploads`, losing profile
 * photos and verification documents).
 *
 * Bucket routing is derived from the key, never passed by callers (routes
 * stay provider-agnostic):
 *   - `verification/...` keys hold identity documents → PRIVATE bucket;
 *   - everything else (`profiles/...`) is public presentation data →
 *     PUBLIC bucket.
 * All reads still stream through the backend routes, so bucket visibility
 * is defence-in-depth, not the access control (keys are never exposed).
 *
 * Auth: a single server-side bearer token (`SUPABASE_STORAGE_KEY` — a
 * service-role key minted/rotated for THIS app only; never shipped to the
 * browser, never logged).
 */
export class SupabaseFileStorage implements FileStorage {
  private readonly origin: string;
  private readonly storageKey: string;
  private readonly publicBucket: string;
  private readonly privateBucket: string;

  constructor(
    origin: string,
    storageKey: string,
    publicBucket: string,
    privateBucket: string,
  ) {
    this.origin = origin.replace(/\/+$/, '');
    this.storageKey = storageKey;
    this.publicBucket = publicBucket;
    this.privateBucket = privateBucket;
  }

  private bucketFor(key: string): string {
    return key.startsWith('verification/')
      ? this.privateBucket
      : this.publicBucket;
  }

  private objectUrl(key: string): string {
    const bucket = encodeURIComponent(this.bucketFor(key));
    // Keys keep their `/` separators (they ARE the object path) but each
    // segment is encoded so no key can escape the bucket prefix.
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    return `${this.origin}/storage/v1/object/${bucket}/${encodedKey}`;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.storageKey}`, ...extra };
  }

  async put(key: string, buffer: Buffer): Promise<void> {
    assertStorageKey(key);
    const response = await fetch(this.objectUrl(key), {
      method: 'POST',
      headers: this.authHeaders({
        'Content-Type': 'application/octet-stream',
        // Photo replacement reuses the same key (`profiles/<id>.<ext>`),
        // so the object must be overwritten instead of rejected.
        'x-upsert': 'true',
      }),
      body: new Uint8Array(buffer),
    });
    if (!response.ok) {
      throw new Error(`Storage upload failed (HTTP ${response.status})`);
    }
  }

  async read(key: string): Promise<Buffer | null> {
    assertStorageKey(key);
    const response = await fetch(this.objectUrl(key), {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Storage read failed (HTTP ${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    assertStorageKey(key);
    const response = await fetch(this.objectUrl(key), {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    // Deleting an already-gone object is success (matches LocalFileStorage).
    if (!response.ok && response.status !== 404) {
      throw new Error(`Storage delete failed (HTTP ${response.status})`);
    }
  }
}

/** Environment variables required when STORAGE_PROVIDER=supabase. */
export const SUPABASE_STORAGE_ENV = [
  'SUPABASE_URL',
  'SUPABASE_STORAGE_KEY',
  'SUPABASE_PUBLIC_BUCKET',
  'SUPABASE_PRIVATE_BUCKET',
] as const;

/**
 * Build a storage provider from an environment (pure — used directly by
 * tests). Throws with a precise message on a missing/unknown configuration
 * so a misconfigured deployment fails at boot, not on the first upload.
 */
export function createFileStorage(
  env: NodeJS.ProcessEnv = process.env,
): FileStorage {
  // An explicitly-empty value (e.g. a blank dashboard field) means "not
  // configured" and falls back to the local default.
  const provider = (env.STORAGE_PROVIDER ?? '').trim().toLowerCase() || 'local';
  if (provider === 'local') {
    return new LocalFileStorage(env.STORAGE_DIR ?? 'var/uploads');
  }
  if (provider === 'supabase') {
    const missing = SUPABASE_STORAGE_ENV.filter(
      (name) => !env[name] || env[name]!.trim() === '',
    );
    if (missing.length > 0) {
      throw new Error(
        `STORAGE_PROVIDER=supabase requires: ${missing.join(', ')}`,
      );
    }
    return new SupabaseFileStorage(
      env.SUPABASE_URL!.trim(),
      env.SUPABASE_STORAGE_KEY!.trim(),
      env.SUPABASE_PUBLIC_BUCKET!.trim(),
      env.SUPABASE_PRIVATE_BUCKET!.trim(),
    );
  }
  throw new Error(
    `Unknown STORAGE_PROVIDER "${provider}" — expected "local" or "supabase".`,
  );
}

let instance: FileStorage | null = null;

/**
 * Process-wide storage instance. Defaults to the server-local root
 * (`STORAGE_DIR`, default `<backend cwd>/var/uploads`); set
 * `STORAGE_PROVIDER=supabase` for durable object storage on platforms with
 * ephemeral disks. The provider and its config are operational settings,
 * never recorded in the database or exposed to clients.
 */
export function getFileStorage(): FileStorage {
  if (!instance) {
    instance = createFileStorage();
  }
  return instance;
}
