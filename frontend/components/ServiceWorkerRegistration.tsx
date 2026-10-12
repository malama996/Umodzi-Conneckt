'use client';
import { useEffect } from 'react';

/**
 * Registers the Umodzi Connect service worker in production builds only.
 *
 * In development (`next dev`) registration is skipped so the service worker can
 * never create stale development builds. Failures (offline, unsupported) are
 * non-fatal for this prototype.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Non-fatal: the app works fully without the service worker.
    });
  }, []);
  return null;
}
