import { del, post } from './client';

/**
 * Push subscription API (Task 28.2B/2C) — wire shapes mirror the backend
 * exactly. The user id is always derived server-side; the client only ever
 * sends the browser subscription fields.
 */

export interface PushSubscriptionPayload {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

export interface PushSubscription {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Envelope<T> {
  data: T;
}

/** POST /me/push-subscriptions — register (or refresh) this device. */
export async function postPushSubscription(
  payload: PushSubscriptionPayload,
): Promise<PushSubscription> {
  const body = await post<Envelope<PushSubscription>>('/me/push-subscriptions', payload);
  return body.data;
}

/** DELETE /me/push-subscriptions/:id — remove one of my subscriptions. */
export async function deletePushSubscription(id: string): Promise<{ deleted: boolean }> {
  const body = await del<Envelope<{ deleted: boolean }>>(
    `/me/push-subscriptions/${encodeURIComponent(id)}`,
  );
  return body.data;
}
