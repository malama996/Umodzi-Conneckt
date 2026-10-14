import { query } from '../db/client.js';

/**
 * Number of rows a DELETE affected, for EITHER injectable client shape.
 *
 * The `client` parameter on the functions below defaults to the pool helper
 * from `db/client.ts`, whose `query` resolves the rows array DIRECTLY, while
 * an injected transaction client resolves the `pg` result object. Reading
 * `result.rowCount` alone silently reported 0 when the helper was used — the
 * DELETE still ran, but the operator-facing count (the whole point of these
 * functions) was wrong. Same root cause as the data-export defect: one
 * implementation handed to two different client contracts.
 */
function affectedCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rowCount = (result as { rowCount?: unknown } | null | undefined)?.rowCount;
  return typeof rowCount === 'number' ? rowCount : 0;
}

/**
 * Retention / data-lifecycle operations (Task 28.3E).
 *
 * ---------------------------------------------------------------------------
 * Deliberate design decision: explicit, operator-invoked cleanup, NOT a
 * background scheduler
 * ---------------------------------------------------------------------------
 * The retention RULES are documented in docs/DATA_RETENTION_POLICY.md. This
 * module implements only the parts that are unambiguously safe, and it does so
 * as an explicitly invoked operation rather than an unattended timer:
 *
 *   * No `setInterval`, no cron entry, no scheduler is registered anywhere.
 *     An autonomous job that deletes rows is a production hazard: a bad
 *     configuration would delete data on its own, with nobody watching. Here,
 *     deletion happens only when an operator or a test invokes it, the result
 *     is returned and logged, and the operation is idempotent.
 *   * Each function is scoped to ONE category and returns the number of rows
 *     it removed, so an operator can see exactly what happened.
 *   * Every function is safe to run repeatedly: running it twice removes zero
 *     rows the second time.
 *   * Nothing here invents a retention PERIOD. Each period is read from
 *     configuration with a documented default, and the defaults are recorded
 *     in docs/DATA_RETENTION_POLICY.md as proposals requiring
 *     deployment-time/legal confirmation.
 */

/** Days after which a revoked or expired session row may be removed. */
export function sessionRetentionDays(): number {
  const configured = Number(process.env.RETENTION_SESSIONS_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
}

/** Days after which a delivered read notification row may be removed. */
export function notificationRetentionDays(): number {
  const configured = Number(process.env.RETENTION_NOTIFICATIONS_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : 180;
}

/**
 * Remove session rows that are both past `expires_at` and older than the
 * retention window.
 *
 * Session rows are the strongest deletion candidate in the system: the
 * refresh-token hash they hold is a credential, and once the row is gone the
 * token can never be replayed. Active, unexpired sessions are never touched.
 */
export async function purgeExpiredSessions(
  client: { query: Function } = { query },
): Promise<number> {
  const days = sessionRetentionDays();
  const result = await client.query(
    `DELETE FROM sessions
      WHERE expires_at < NOW() - ($1 || ' days')::interval
        AND (revoked_at IS NOT NULL OR expires_at < NOW())`,
    [String(days)],
  );
  return affectedCount(result);
}

/**
 * Remove delivered notification rows older than the retention window.
 *
 * Narrowly scoped on purpose: only rows that are already `read` AND whose
 * delivery state is terminal (`sent`/`delivered`) are eligible. An unread
 * notification is still live personal data the subject has not consumed, and
 * a `pending`/`failed` row is the record of a delivery attempt that an
 * operator may still need to inspect. Nothing deletes unread or unresolved
 * notifications.
 */
export async function purgeOldNotifications(
  client: { query: Function } = { query },
): Promise<number> {
  const days = notificationRetentionDays();
  const result = await client.query(
    `DELETE FROM notifications
      WHERE read = true
        AND status IN ('sent', 'delivered')
        AND created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return affectedCount(result);
}

/**
 * Remove push subscriptions whose endpoint a push provider has rejected as
 * permanently gone (HTTP 404/410).
 *
 * NOTE ON SCOPE: this function does NOT run on a timer and does NOT invent
 * failures. It only removes subscriptions that the delivery path has ALREADY
 * observed as permanently invalid and recorded as such. A stale-but-unknown
 * subscription is left alone, because silently dropping a working device
 * notification would be worse than keeping a dead row.
 */
export async function purgeDeadPushSubscriptions(): Promise<number> {
  // There is currently no persisted "this endpoint is dead" marker, so there
  // is nothing safe to delete here. This is reported honestly rather than
  // guessed at: pruning already happens inline in the delivery path
  // (PushService removes a subscription on a real 404/410).
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM push_subscriptions WHERE created_at < NOW() - INTERVAL '365 days'`,
  );
  return Number(rows[0]?.n ?? 0);
}

export interface RetentionSweepResult {
  sessionsRemoved: number;
  notificationsRemoved: number;
  /** Rows merely inspected (nothing is deleted) — reported, not removed. */
  oldPushSubscriptionsObserved: number;
  configured: { sessionDays: number; notificationDays: number };
}

/**
 * Run every safe retention action and return exactly what was removed.
 *
 * Idempotent: a second immediate run removes 0 rows and returns the same
 * shape. Intended to be called by an operator (or a test), never from a
 * request handler.
 */
export async function runRetentionSweep(): Promise<RetentionSweepResult> {
  const sessionsRemoved = await purgeExpiredSessions();
  const notificationsRemoved = await purgeOldNotifications();
  const oldPushSubscriptionsObserved = await purgeDeadPushSubscriptions();
  return {
    sessionsRemoved,
    notificationsRemoved,
    oldPushSubscriptionsObserved,
    configured: {
      sessionDays: sessionRetentionDays(),
      notificationDays: notificationRetentionDays(),
    },
  };
}
