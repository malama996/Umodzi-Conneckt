import { useEffect, useState } from 'react';

/**
 * Typed mock persistence layer (V0.2).
 *
 * - Backed by localStorage so profile edits survive page refresh and work offline.
 * - Hydration-safe: reads happen after mount, never during render.
 * - Handles localStorage failures gracefully, including QuotaExceededError.
 * - Falls back to an in-memory store (per browser tab session) instead of
 *   crashing whenever localStorage is unavailable or a write is rejected.
 */

const memoryFallback = new Map<string, string>();
const memoryOnlyKeys = new Set<string>();

export type PersistenceFailure = 'unavailable' | 'quota' | 'corrupt';

export type PersistenceResult = { ok: true } | { ok: false; reason: PersistenceFailure };

export function isPersistentStorageAvailable(): boolean {
  try {
    if (typeof window === 'undefined' || !('localStorage' in window)) return false;
    const probeKey = '__umodzi_storage_probe__';
    window.localStorage.setItem(probeKey, 'probe');
    window.localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

export function readPersisted<T>(key: string, fallback: T): T {
  try {
    if (typeof window === 'undefined' || !('localStorage' in window)) {
      return deserialize(memoryFallback.get(key), fallback);
    }
    if (memoryOnlyKeys.has(key)) {
      return deserialize(memoryFallback.get(key), fallback);
    }
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePersisted(key: string, value: unknown): PersistenceResult {
  if (typeof window === 'undefined' || !('localStorage' in window)) {
    persistInMemory(key, value);
    return { ok: false, reason: 'unavailable' };
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    memoryOnlyKeys.delete(key);
    memoryFallback.delete(key);
    return { ok: true };
  } catch (error) {
    // Quota or serialization failure: keep the value in memory for this
    // session rather than losing it or crashing.
    persistInMemory(key, value);
    if (isQuotaExceededError(error)) return { ok: false, reason: 'quota' };
    return { ok: false, reason: 'corrupt' };
  }
}

export function clearPersisted(key: string): void {
  memoryOnlyKeys.delete(key);
  memoryFallback.delete(key);
  try {
    window.localStorage?.removeItem(key);
  } catch {
    // Best-effort: clearing stored data must never throw.
  }
}

function persistInMemory(key: string, value: unknown): void {
  memoryOnlyKeys.add(key);
  memoryFallback.set(key, JSON.stringify(value));
}

function deserialize<T>(raw: string | undefined, fallback: T): T {
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22
    );
  }
  return false;
}

/**
 * Hydration-safe persistent state. The first render (server and client
 * hydration) uses `initialState`; the stored value is applied after mount.
 * If storage is unavailable or the quota is exceeded, the value still lives
 * in React state (in-memory fallback) and the failure is reported through
 * the returned result.
 */
export function usePersistentState<T>(
  key: string,
  initialState: T,
): readonly [T, (next: T | ((previous: T) => T)) => void, PersistenceResult] {
  const [value, setValue] = useState<T>(initialState);
  const [result, setResult] = useState<PersistenceResult>({ ok: true });

  useEffect(() => {
    setValue(readPersisted(key, initialState));
    // `key` identifies the persisted slice; `initialState` is only the
    // pre-hydration fallback and must not re-trigger the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    setResult(writePersisted(key, value));
  }, [key, value]);

  const setValuePersistent = (next: T | ((previous: T) => T)) => {
    setValue((previous) =>
      typeof next === 'function' ? (next as (previous: T) => T)(previous) : next,
    );
  };

  return [value, setValuePersistent, result] as const;
}
