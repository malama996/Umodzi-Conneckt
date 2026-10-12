/**
 * In-app notification store (Task 22).
 *
 * A deliberately small, in-memory, session-scoped store:
 *
 * - No localStorage/event ledger: nothing here survives a reload, so
 *   notification state can never become an uncontrolled source of truth.
 * - Duplicate suppression uses a deterministic entity+state key
 *   (see `entityStateKey`); the dedup ledger is in-memory and bounded
 *   only by the number of distinct keys observed this session.
 * - `notify*` never throws: a notification failure can never break the
 *   request/offer flow that raised it.
 *
 * Consumers: realtime subscribers and confirmed mutation handlers call
 * `notifySuccess/Info/Warning/Error`; UI reads via `subscribeNotifications`
 * / `getNotifications` (or the `useNotifications` React hook).
 */
import type { AppNotification, NotificationInput } from './types';

/** At most this many notifications are kept visible at once. */
const MAX_VISIBLE = 4;

let notifications: AppNotification[] = [];
let nextId = 1;

/**
 * Dedup ledger: entity+state keys already delivered this session.
 * In-memory by design (see module doc).
 */
const observedKeys = new Set<string>();

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Build the deterministic dedup key for an observed entity state.
 * `entity` scopes the key ('request' on the customer side, 'offer' on
 * the technician side) so the same id/state pair on different views of
 * the same request never silently collides across pages.
 */
export function entityStateKey(entity: 'request' | 'offer', id: string, state: string): string {
  return `${entity}:${id}:${state}`;
}

/**
 * Raise a notification. Returns true when it was delivered, false when
 * it was suppressed by an already-observed `dedupeKey`. Never throws.
 */
export function notify(input: NotificationInput): boolean {
  try {
    if (input.dedupeKey !== undefined) {
      if (observedKeys.has(input.dedupeKey)) return false;
      observedKeys.add(input.dedupeKey);
    }
    const notification: AppNotification = {
      ...input,
      id: `notification-${nextId}`,
      createdAt: Date.now(),
    };
    nextId += 1;
    notifications = [...notifications, notification];
    if (notifications.length > MAX_VISIBLE) {
      notifications = notifications.slice(notifications.length - MAX_VISIBLE);
    }
    emit();
    return true;
  } catch {
    // A notification failure must never propagate into domain flows.
    return false;
  }
}

/** Raise a success notification. Returns false when deduped. */
export function notifySuccess(input: Omit<NotificationInput, 'tone'>): boolean {
  return notify({ ...input, tone: 'success' });
}

/** Raise an informational notification. Returns false when deduped. */
export function notifyInfo(input: Omit<NotificationInput, 'tone'>): boolean {
  return notify({ ...input, tone: 'info' });
}

/** Raise a warning notification. Returns false when deduped. */
export function notifyWarning(input: Omit<NotificationInput, 'tone'>): boolean {
  return notify({ ...input, tone: 'warning' });
}

/** Raise an error notification. Returns false when deduped. */
export function notifyError(input: Omit<NotificationInput, 'tone'>): boolean {
  return notify({ ...input, tone: 'error' });
}

/** Current notifications (stable reference until the store changes). */
export function getNotifications(): AppNotification[] {
  return notifications;
}

/** Subscribe to store changes; returns an unsubscribe function. */
export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Remove one notification by id. */
export function dismissNotification(id: string): void {
  const remaining = notifications.filter((notification) => notification.id !== id);
  if (remaining.length === notifications.length) return;
  notifications = remaining;
  emit();
}

/** Remove all visible notifications (the dedup ledger is unaffected). */
export function clearNotifications(): void {
  if (notifications.length === 0) return;
  notifications = [];
  emit();
}

/** Whether an entity+state key has already been delivered this session. */
export function wasNotificationObserved(key: string): boolean {
  return observedKeys.has(key);
}

/**
 * Reset all in-memory notification state (visible list + dedup
 * ledger). Test-only helper — not called by the application.
 */
export function resetNotificationStore(): void {
  notifications = [];
  observedKeys.clear();
  nextId = 1;
  emit();
}
