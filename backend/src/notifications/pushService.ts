import { query } from '../db/client.js';
import webpush from 'web-push';

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  data?: Record<string, any>;
}

/**
 * VAPID is configured once per process. `web-push` mutates module-level
 * state in `setVapidDetails`, so we only need to call it the first time the
 * credentials are seen. Until the keys exist we re-check the environment on
 * each call (cheap) rather than caching a negative result, so a process that
 * boots before the keys are present still works once they are.
 */
let vapidReady = false;

function ensureVapidConfigured(): boolean {
  if (vapidReady) return true;
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) {
    console.warn(
      '[PUSH-SERVICE] VAPID not configured (VAPID_SUBJECT / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY); web push delivery is disabled.'
    );
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidReady = true;
  return true;
}

export class PushService {
  /**
   * Save or update push subscription for an authenticated user
   */
  static async saveSubscription(userId: string, subscription: PushSubscriptionRecord): Promise<void> {
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET p256dh = $3, auth = $4, user_agent = $5, updated_at = NOW()`,
      [userId, subscription.endpoint, subscription.p256dh, subscription.auth, subscription.userAgent ?? null]
    );
  }

  /**
   * Remove push subscription for an authenticated user
   */
  static async removeSubscription(userId: string, endpoint: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2 RETURNING id',
      [userId, endpoint]
    );
    return result.length > 0;
  }

  /**
   * Send web push notification to user's registered subscriptions.
   *
   * Real Web Push (RFC 8030 / VAPID): the payload is encrypted and POSTed to
   * each subscription endpoint. `sent` counts only endpoints that accepted
   * the message; nothing is fabricated when VAPID is missing or delivery
   * fails. Expired subscriptions (endpoint returns 404/410) are pruned.
   */
  static async sendPushToUser(userId: string, payload: PushNotificationPayload): Promise<{ sent: number; failed: number }> {
    const subscriptions = await query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );

    if (subscriptions.length === 0) {
      return { sent: 0, failed: 0 };
    }

    if (!ensureVapidConfigured()) {
      // Cannot deliver without VAPID credentials. Report every subscription as
      // failed rather than pretending delivery succeeded.
      return { sent: 0, failed: subscriptions.length };
    }

    let sent = 0;
    let failed = 0;
    const body = JSON.stringify(payload);

    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body
        );
        sent++;
      } catch (err: any) {
        failed++;
        const status = err?.statusCode;
        // 404 (Not Found) / 410 (Gone) mean the subscription is permanently
        // dead — remove it so we stop retrying a stale endpoint.
        if (status === 404 || status === 410) {
          await query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
        }
        console.warn(
          `[PUSH-SERVICE] delivery failed for user ${userId} (status ${status ?? 'n/a'}${status === 404 || status === 410 ? ', subscription pruned' : ''})`
        );
      }
    }

    return { sent, failed };
  }
}
