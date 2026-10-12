import { query, transaction } from '../db/client.js';
import { isUuid } from '../auth/authService.js';
import { HttpError } from '../auth/httpError.js';
import { PushService } from './pushService.js';
import crypto from 'node:crypto';

export type NotificationChannel = 'in_app' | 'sms' | 'push' | 'email';
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed';

export interface CreateNotificationParams {
  userId: string;
  type: string;
  title: string;
  message: string;
  channel?: NotificationChannel;
  referenceType?: string;
  referenceId?: string;
}

export interface SmsProviderConfig {
  provider: 'mock' | 'africastalking' | 'twilio' | 'custom';
  apiKey?: string;
  username?: string;
  senderId?: string;
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
}

export interface SmsSendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

/**
 * Pluggable SMS provider interface
 */
export interface ISmsProvider {
  sendSms(to: string, message: string): Promise<SmsSendResult>;
}

export class ConfigurableSmsProvider implements ISmsProvider {
  private config: SmsProviderConfig;

  constructor() {
    // Task 28.2F — Africa's Talking is the first production provider. The
    // established environment value is SMS_PROVIDER=africas_talking (see
    // backend .env); the un-underscored alias is accepted so neither
    // spelling silently falls through to the mock provider. Credentials
    // use the documented AFRICASTALKING_* names first, with the older
    // SMS_* names as fallback — missing credentials fail honestly at send
    // time, never with fabricated success.
    const providerName = (process.env.SMS_PROVIDER as string) || 'mock';
    const normalizedProvider =
      providerName === 'africas_talking' || providerName === 'africastalking'
        ? 'africastalking'
        : providerName;
    this.config = {
      provider: normalizedProvider as SmsProviderConfig['provider'],
      apiKey: process.env.AFRICASTALKING_API_KEY || process.env.SMS_API_KEY,
      username: process.env.AFRICASTALKING_USERNAME || process.env.SMS_USERNAME,
      senderId:
        process.env.AFRICASTALKING_FROM || process.env.SMS_SENDER_ID || 'Umodzi',
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      fromNumber: process.env.TWILIO_FROM_NUMBER,
    };
  }

  async sendSms(to: string, message: string): Promise<SmsSendResult> {
    if (!to || !message) {
      return { success: false, error: 'Recipient phone number and message are required' };
    }

    if (this.config.provider === 'africastalking') {
      if (!this.config.apiKey || !this.config.username) {
        return {
          success: false,
          error:
            "Africa's Talking credentials missing (AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME)",
        };
      }
      // Production Africa's Talking API call implementation
      try {
        const response = await fetch('https://api.africastalking.com/version1/messaging', {
          method: 'POST',
          headers: {
            apiKey: this.config.apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            username: this.config.username,
            to,
            message,
            from: this.config.senderId || 'Umodzi',
          }).toString(),
        });
        const resData = (await response.json()) as any;
        if (response.ok) {
          const recipientInfo = resData?.SMSMessageData?.Recipients?.[0];
          return {
            success: recipientInfo?.status === 'Success' || response.status === 201,
            providerMessageId: recipientInfo?.messageId,
            error: recipientInfo?.status !== 'Success' ? recipientInfo?.status : undefined,
          };
        }
        return { success: false, error: `Africa's Talking error: ${response.statusText}` };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    if (this.config.provider === 'twilio') {
      if (!this.config.accountSid || !this.config.authToken || !this.config.fromNumber) {
        return {
          success: false,
          error: 'Twilio credentials missing (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)',
        };
      }
      try {
        const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');
        const response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              To: to,
              From: this.config.fromNumber,
              Body: message,
            }).toString(),
          }
        );
        const resData = (await response.json()) as any;
        if (response.ok && resData?.sid) {
          return {
            success: true,
            providerMessageId: resData.sid,
          };
        }
        return { success: false, error: resData?.message || 'Twilio SMS failed' };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    // Default mock / dev provider (logs safely without secrets)
    console.log(`[SMS-PROVIDER] Mock SMS dispatched to ${to.replace(/\d(?=\d{4})/g, '*')}: ${message}`);
    return {
      success: true,
      providerMessageId: `mock-sms-${crypto.randomUUID()}`,
    };
  }
}

/**
 * SMS policy (Task 28.2F) — conservative by design.
 *
 * Web Push + in-app remain the primary notification mechanisms. SMS is
 * reserved for outcomes the recipient must act on or that decide account
 * access: an accepted offer (service is about to happen), and verification
 * decisions (account trust outcome, incl. corrections). Everything else —
 * offer creation, rejections, timeouts, routine status moves — stays off
 * SMS so a busy day can never become an SMS storm, and repeated events for
 * the same entity still collapse through the D1 natural key.
 *
 * NOT wired into routes yet: the users table carries no phone numbers, so
 * there is no authoritative recipient number to send to (phone collection
 * + storage is a later stage). This gate exists so that stage plugs in one
 * check instead of re-deciding policy per call site.
 */
const SMS_ELIGIBLE_EVENT_TYPES: readonly string[] = [
  'dispatch_offer_accepted',
  'technician_verification_approved',
  'technician_verification_rejected',
];

export function isSmsEligibleEvent(type: string): boolean {
  return SMS_ELIGIBLE_EVENT_TYPES.includes(type);
}

/**
 * Service to manage and dispatch notifications
 */
export class NotificationService {
  private static smsProvider: ISmsProvider = new ConfigurableSmsProvider();

  static setSmsProvider(provider: ISmsProvider) {
    this.smsProvider = provider;
  }

  /**
   * Create and record a notification in the database
   */
  static async createNotification(params: CreateNotificationParams): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    const channel = params.channel ?? 'in_app';
    const status: NotificationStatus = 'sent';

    await query(
      `INSERT INTO notifications (
        id, user_id, type, title, message, channel, reference_type, reference_id, status, created_at, sent_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
      [
        id,
        params.userId,
        params.type,
        params.title,
        params.message,
        channel,
        params.referenceType ?? null,
        params.referenceId ?? null,
        status,
      ]
    );

    return { id };
  }

  /**
   * Dispatch an SMS notification and record it in database
   */
  static async sendSmsNotification(
    userId: string,
    phoneNumber: string,
    title: string,
    message: string,
    referenceType?: string,
    referenceId?: string
  ): Promise<{ id: string; success: boolean; error?: string }> {
    const id = crypto.randomUUID();
    const smsResult = await this.smsProvider.sendSms(phoneNumber, message);
    const status: NotificationStatus = smsResult.success ? 'sent' : 'failed';

    await query(
      `INSERT INTO notifications (
        id, user_id, type, title, message, channel, reference_type, reference_id, status,
        provider_message_id, failure_reason, created_at, sent_at
      ) VALUES ($1, $2, $3, $4, $5, 'sms', $6, $7, $8, $9, $10, NOW(), NOW())`,
      [
        id,
        userId,
        'sms_notification',
        title,
        message,
        referenceType ?? null,
        referenceId ?? null,
        status,
        smsResult.providerMessageId ?? null,
        smsResult.error ?? null,
      ]
    );

    return { id, success: smsResult.success, error: smsResult.error };
  }

  /**
   * Retrieve notification list for a user
   */
  static async getUserNotifications(userId: string, limit = 50, offset = 0) {
    const [notifRows, countRows] = await Promise.all([
      query<any>(
        `SELECT id, user_id, type, title, message, channel, reference_type, reference_id,
                read, status, created_at, sent_at, read_at
         FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      query<{ total: string; unread: string }>(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE read = false) AS unread
         FROM notifications
         WHERE user_id = $1`,
        [userId]
      ),
    ]);

    const notifications = notifRows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      type: r.type,
      title: r.title,
      message: r.message,
      channel: r.channel,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      read: r.read,
      status: r.status,
      createdAt: r.created_at,
      sentAt: r.sent_at,
      readAt: r.read_at,
    }));

    return {
      notifications,
      unreadCount: Number(countRows[0]?.unread ?? 0),
      totalCount: Number(countRows[0]?.total ?? 0),
    };
  }

  /**
   * Mark a single notification as read
   */
  static async markAsRead(id: string, userId: string): Promise<boolean> {
    const result = await query(
      `UPDATE notifications
       SET read = true, read_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId]
    );
    return result.length > 0;
  }

  /**
   * Mark all notifications as read for a user
   */
  static async markAllAsRead(userId: string): Promise<number> {
    const result = await query(
      `UPDATE notifications
       SET read = true, read_at = NOW()
       WHERE user_id = $1 AND read = false
       RETURNING id`,
      [userId]
    );
    return result.length;
  }

  /**
   * Attempt real Web Push delivery for one pending notification
   * (Task 28.2D6) — the post-commit delivery boundary.
   *
   * Reads the row fresh (never trusts a stale copy), sends through the
   * existing PushService to every subscription of the recipient, then
   * records the honest outcome on the SAME row — never a second row:
   *   - at least one provider acceptance → status 'sent', sent_at set;
   *   - otherwise → status 'failed' with a useful failure_reason
   *     (no subscriptions, unconfigured VAPID, or all rejections).
   * provider_message_id stays NULL: the Web Push protocol returns no
   * per-message identifier, and none is ever fabricated.
   * Unknown ids and non-pending rows are safe no-ops (no re-push of
   * already-handled notifications). The business operation that created
   * the row is already committed and is never rolled back here.
   * No database transaction is held while the provider is contacted.
   */
  static async deliverPendingNotification(
    notificationId: string,
  ): Promise<{ delivered: boolean; sent: number; failed: number }> {
    const idle = { delivered: false, sent: 0, failed: 0 };
    const rows = await query<{
      id: string;
      user_id: string;
      title: string;
      message: string;
      status: string;
    }>(
      `SELECT id, user_id, title, message, status FROM notifications WHERE id = $1`,
      [notificationId],
    );
    const row = rows[0];
    if (!row || row.status !== 'pending') {
      return idle;
    }

    const { sent, failed } = await PushService.sendPushToUser(row.user_id, {
      title: row.title,
      body: row.message,
      data: { notificationId: row.id },
    });
    if (sent > 0) {
      await query(
        `UPDATE notifications
         SET status = 'sent', sent_at = NOW(), failure_reason = NULL
         WHERE id = $1`,
        [row.id],
      );
      return { delivered: true, sent, failed };
    }

    const subscriptions = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = $1',
      [row.user_id],
    );
    const hasSubscriptions = Number(subscriptions[0]?.n ?? '0') > 0;
    const hasVapid = Boolean(
      process.env.VAPID_SUBJECT && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY,
    );
    const failureReason = !hasSubscriptions
      ? 'No push subscriptions registered for this user.'
      : !hasVapid
        ? 'Push delivery is not configured (VAPID).'
        : `Push delivery failed for all ${failed} subscription(s).`;
    await query(`UPDATE notifications SET status = 'failed', failure_reason = $2 WHERE id = $1`, [
      row.id,
      failureReason,
    ]);
    return { delivered: false, sent, failed };
  }

  /**
   * Record a business-event notification (Task 28.2D1) — the single entry
   * point future event hooks (offers, status changes, verification) call.
   *
   * Contract:
   *   - `userId == null` is a safe no-op: some recipient relationships
   *     (e.g. technicians.user_id on seed rows) are legitimately NULL, and
   *     a notification for nobody must never be created.
   *   - Dedupe on the natural key
   *     (user_id, type, reference_type, reference_id): a repeated event
   *     returns the EXISTING row instead of inserting a second one. The
   *     lookup+insert runs inside one transaction behind a per-key
   *     advisory lock, so concurrent handlers for the SAME key serialize
   *     instead of double-inserting. Limitation (no schema change in D1):
   *     the lock key is a 32-bit hashtext — a hash collision would only
   *     over-serialize two unrelated events (harmless wait, never a wrong
   *     row); it cannot create a duplicate or mix up recipients.
   *     Callers that fire a REPEATING event stream over one reference
   *     (chat messages over a conversation) pass `dedupe: false` so every
   *     firing produces its own row — see the param docs.
   *   - New rows are `pending` with sent_at/provider_message_id/
   *     failure_reason NULL (the schema defaults status to 'sent', so it
   *     is overridden explicitly). Marking `sent`/`failed` is Task 28.2D6's
   *     job, after real delivery is attempted.
   *   - This method performs NO delivery: no Web Push, no SMS, no second
   *     row. One event + one recipient = exactly one row.
   */
  static async recordEventNotification(
    params: RecordEventNotificationParams
  ): Promise<RecordEventNotificationResult> {
    if (params.userId === null || params.userId === undefined) {
      return { created: false, skipped: true, reason: 'missing-recipient' };
    }
    const input = validateEventNotificationParams(params);
    const lockKey = `${input.userId}|${input.type}|${input.referenceType}|${input.referenceId}`;

    return transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);

      // Dedupe on the natural key — unless the caller declared this event
      // a repeating stream (dedupe: false), where each firing IS a new
      // logical event that must produce its own row and its own delivery.
      const existing = input.dedupe
        ? ((
            await client.query(
              `SELECT id, user_id, type, title, message, channel, reference_type, reference_id,
                status, created_at, sent_at
         FROM notifications
         WHERE user_id = $1 AND type = $2 AND reference_type = $3 AND reference_id = $4
         ORDER BY created_at DESC
         LIMIT 1`,
              [input.userId, input.type, input.referenceType, input.referenceId]
            )
          ).rows as NotificationEventRow[])
        : [];

      if (existing.length > 0) {
        return {
          created: false as const,
          skipped: false as const,
          notification: toEventNotification(existing[0]),
        };
      }

      const inserted = (await client.query(
        `INSERT INTO notifications (
           id, user_id, type, title, message, channel, reference_type, reference_id,
           status, created_at, sent_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW(), NULL)
         RETURNING id, user_id, type, title, message, channel, reference_type, reference_id,
                   status, created_at, sent_at`,
        [
          crypto.randomUUID(),
          input.userId,
          input.type,
          input.title,
          input.message,
          input.channel,
          input.referenceType,
          input.referenceId,
        ]
      )) as { rows: NotificationEventRow[] };

      return {
        created: true as const,
        skipped: false as const,
        notification: toEventNotification(inserted.rows[0]),
      };
    });
  }
}

/* ------------------------------------------------------------------ */
/* Task 28.2D1 — shared event-notification contract                    */
/* ------------------------------------------------------------------ */

/** Reference vocabulary for event notifications (audit §reference convention). */
export type EventReferenceType = 'service_request' | 'dispatch_offer' | 'technician' | 'conversation';

const EVENT_REFERENCE_TYPES: readonly EventReferenceType[] = [
  'conversation',
  'service_request',
  'dispatch_offer',
  'technician',
];

const EVENT_CHANNELS: readonly NotificationChannel[] = ['in_app', 'sms', 'push', 'email'];

export interface RecordEventNotificationParams {
  userId: string | null | undefined;
  type: string;
  title: string;
  message: string;
  referenceType: EventReferenceType;
  referenceId: string;
  channel?: NotificationChannel;
  /**
   * Natural-key dedupe (Task 33.4). Default true: re-firing the SAME
   * logical event returns the existing row instead of inserting a second
   * one. Pass false for event STREAMS that legitimately repeat over one
   * reference — chat messages fire once per message over a single
   * conversation id, and with dedupe on, every message after the first
   * would be silently suppressed (no row, no push, no inbox update).
   */
  dedupe?: boolean;
}

export interface EventNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  channel: NotificationChannel;
  referenceType: EventReferenceType;
  referenceId: string;
  status: NotificationStatus;
  createdAt: string;
  sentAt: string | null;
}

export type RecordEventNotificationResult =
  | { created: true; skipped: false; notification: EventNotification }
  | { created: false; skipped: false; notification: EventNotification }
  | { created: false; skipped: true; reason: 'missing-recipient' };

interface ValidatedEventNotification {
  userId: string;
  type: string;
  title: string;
  message: string;
  channel: NotificationChannel;
  referenceType: EventReferenceType;
  referenceId: string;
  dedupe: boolean;
}

interface NotificationEventRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  channel: string;
  reference_type: string;
  reference_id: string;
  status: string;
  created_at: string;
  sent_at: string | null;
}

function toEventNotification(row: NotificationEventRow): EventNotification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    message: row.message,
    channel: row.channel as NotificationChannel,
    referenceType: row.reference_type as EventReferenceType,
    referenceId: row.reference_id,
    status: row.status as NotificationStatus,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

/**
 * Validate + normalize event inputs (throws HttpError 400, following the
 * auth-service convention, so future route handlers need no mapping).
 * referenceType/referenceId are REQUIRED: the natural-key dedupe only
 * works on present values (SQL NULL never equals NULL).
 */
function validateEventNotificationParams(
  params: RecordEventNotificationParams
): ValidatedEventNotification {
  const fail = (message: string): never => {
    throw new HttpError(400, message);
  };
  const { userId } = params;
  if (typeof userId !== 'string' || !isUuid(userId)) {
    fail('A valid recipient user id is required');
  }
  const text = (value: unknown, name: string, max: number): string => {
    if (typeof value !== 'string') fail(`${name} must be a string`);
    const trimmed = (value as string).trim();
    if (trimmed.length === 0) fail(`${name} must not be empty`);
    if (trimmed.length > max) fail(`${name} must be at most ${max} characters`);
    return trimmed;
  };
  const type = text(params.type, 'type', 100);
  const title = text(params.title, 'title', 200);
  const message = text(params.message, 'message', 2000);
  if (!EVENT_REFERENCE_TYPES.includes(params.referenceType)) {
    fail('referenceType must be service_request, dispatch_offer, or technician');
  }
  if (typeof params.referenceId !== 'string' || !isUuid(params.referenceId)) {
    fail('A valid reference id is required');
  }
  const channel = params.channel ?? 'in_app';
  if (!EVENT_CHANNELS.includes(channel)) {
    fail('channel must be in_app, sms, push, or email');
  }
  return {
    userId: userId as string,
    type,
    title,
    message,
    channel,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    dedupe: params.dedupe !== false,
  };
}
