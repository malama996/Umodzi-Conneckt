/**
 * Browser Web Push helper (Task 28.2C) — small, reusable, no dependencies.
 *
 * Wraps only native browser APIs (navigator.serviceWorker, Notification,
 * PushManager). Server communication lives in lib/api/pushApi.ts; auth
 * comes from the existing token holder via that same API client.
 *
 * Only the VAPID PUBLIC key ever reaches this module (via the
 * NEXT_PUBLIC_VAPID_PUBLIC_KEY build variable). The private key is
 * backend-only and is never referenced here.
 *
 * Every function is safe to call in unsupported environments: feature
 * detection returns a status instead of throwing, except where noted.
 * Nothing here polls — callers decide when to check state.
 */

import type { PushSubscriptionPayload } from '@/lib/api/pushApi';

export type PushCapability = 'supported' | 'unsupported' | 'not-configured';

export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushError';
  }
}

/** Build-time VAPID public key (frontend-safe). Null when not configured. */
export function vapidPublicKey(): string | null {
  const value = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether this browser can do Web Push AND the app is configured for it.
 * Safe to call anywhere (SSR, tests, old browsers) — never throws.
 */
export function pushCapability(): PushCapability {
  if (typeof navigator === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  if (typeof window === 'undefined' || !('PushManager' in window)) return 'unsupported';
  if (typeof Notification === 'undefined') return 'unsupported';
  if (vapidPublicKey() === null) return 'not-configured';
  return 'supported';
}

/** Current notification permission, or 'unavailable' without Notification. */
export function pushPermission(): 'granted' | 'denied' | 'prompt' | 'unavailable' {
  if (typeof Notification === 'undefined') return 'unavailable';
  const permission = Notification.permission;
  if (permission === 'granted' || permission === 'denied') return permission;
  return 'prompt';
}

/** Convert a base64url VAPID key to the Uint8Array PushManager expects. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new PushError('The push configuration is invalid.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  // Throws PushError (not a raw DOM error) so callers show safe messages.
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    throw new PushError('The service worker is not ready yet.');
  }
}

/** The browser's current push subscription for this origin, if any. */
export async function getBrowserSubscription(): Promise<PushSubscription | null> {
  if (pushCapability() === 'unsupported') return null;
  const registration = await serviceWorkerRegistration();
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    throw new PushError('Could not read the browser subscription.');
  }
}

function toPayload(subscription: PushSubscription): PushSubscriptionPayload {
  const raw = subscription.toJSON();
  const endpoint = typeof raw?.endpoint === 'string' ? raw.endpoint : '';
  const p256dh = raw?.keys?.p256dh;
  const auth = raw?.keys?.auth;
  if (!endpoint || typeof p256dh !== 'string' || !p256dh || typeof auth !== 'string' || !auth) {
    throw new PushError('The browser subscription is incomplete.');
  }
  const payload: PushSubscriptionPayload = {
    endpoint,
    p256dh,
    auth,
  };
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    payload.userAgent = navigator.userAgent.slice(0, 500);
  }
  return payload;
}

/**
 * Request permission (if needed) and subscribe via PushManager.
 * Returns the payload for POST /me/push-subscriptions. Reuses an existing
 * browser subscription instead of creating a duplicate.
 */
export async function subscribeBrowserPush(): Promise<PushSubscriptionPayload> {
  if (pushCapability() === 'unsupported') {
    throw new PushError('Push notifications are not supported in this browser.');
  }
  const vapidKey = vapidPublicKey();
  if (vapidKey === null) {
    throw new PushError('Push notifications are not configured.');
  }
  if (typeof Notification === 'undefined') {
    throw new PushError('Push notifications are not supported in this browser.');
  }
  if (Notification.permission === 'denied') {
    throw new PushError('Notifications are blocked for this site.');
  }
  if (Notification.permission === 'default') {
    let result: NotificationPermission;
    try {
      result = await Notification.requestPermission();
    } catch {
      throw new PushError('The permission request failed.');
    }
    if (result !== 'granted') {
      throw new PushError('Notifications are blocked for this site.');
    }
  }
  const registration = await serviceWorkerRegistration();
  try {
    const existing = await registration.pushManager.getSubscription();
    if (existing) return toPayload(existing);
    const created = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    return toPayload(created);
  } catch (error) {
    if (error instanceof PushError) throw error;
    throw new PushError('The browser subscription failed.');
  }
}

/** Remove the browser-side subscription. False when there is none. */
export async function unsubscribeBrowserPush(): Promise<boolean> {
  const existing = await getBrowserSubscription();
  if (!existing) return false;
  try {
    return await existing.unsubscribe();
  } catch {
    throw new PushError('The browser unsubscribe failed.');
  }
}

/* ------------------------------------------------------------------ */
/* Backend-id linkage (per-device, per-endpoint)                       */
/* ------------------------------------------------------------------ */

// The backend id is only known from the POST response, while the browser
// subscription carries no id — so this device remembers its own mapping.
// One entry per endpoint: other devices' subscriptions are never touched.
// UI state only (same sanctioned localStorage use as matching filters).
const LINK_KEY = 'umodzi:push-subscriptions';

function readLinks(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LINK_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const links: Record<string, string> = {};
    for (const [endpoint, id] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === 'string' && id.length > 0) links[endpoint] = id;
    }
    return links;
  } catch {
    return {};
  }
}

export function rememberSubscriptionId(endpoint: string, id: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LINK_KEY, JSON.stringify({ ...readLinks(), [endpoint]: id }));
  } catch {
    /* storage unavailable — the link is a convenience, not a requirement */
  }
}

export function linkedSubscriptionId(endpoint: string): string | null {
  return readLinks()[endpoint] ?? null;
}

export function forgetSubscriptionId(endpoint: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const links = readLinks();
    delete links[endpoint];
    localStorage.setItem(LINK_KEY, JSON.stringify(links));
  } catch {
    /* best effort */
  }
}
