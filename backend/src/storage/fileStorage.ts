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

let instance: FileStorage | null = null;

/**
 * Process-wide storage instance. `STORAGE_DIR` points at the server-local
 * root (default `<backend cwd>/var/uploads`) — an operational setting,
 * never recorded in the database or exposed to clients.
 */
export function getFileStorage(): FileStorage {
  if (!instance) {
    instance = new LocalFileStorage(process.env.STORAGE_DIR ?? 'var/uploads');
  }
  return instance;
}
