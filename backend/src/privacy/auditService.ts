import { query } from '../db/client.js';

/**
 * Privacy/security audit log (Task 28.3F).
 *
 * Records are created ONLY from events the running system actually observes.
 * Nothing here seeds, back-dates or fabricates history: a fresh installation
 * starts with an empty log and that is the honest state.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT recorded
 * ---------------------------------------------------------------------------
 *   * passwords (in any form, including hashes)
 *   * access tokens, refresh tokens, token hashes
 *   * VAPID private keys, SMS/API credentials, any secret or env value
 *   * verification-document bytes, filenames-as-content, or document text
 *   * notification bodies, request descriptions, review comment text
 *   * client IP addresses — the system stores none anywhere, and broad IP
 *     collection is not introduced as a side effect of logging
 *
 * ---------------------------------------------------------------------------
 * Failure policy
 * ---------------------------------------------------------------------------
 * Auditing must never break, roll back or block the business operation it
 * describes. A write failure is logged to the application log and swallowed.
 * A failed audit write therefore degrades accountability, never availability
 * — the same log-and-continue rule the notification path already follows.
 */

/**
 * Canonical event types. Keeping this a closed set (rather than free strings)
 * lets the administrator view and the tests assert on a known vocabulary, and
 * stops typos from silently creating unreadable event types.
 */
export const AUDIT_EVENT_TYPES = [
  // Authentication
  'auth.login_failed',
  'auth.login_succeeded',
  'auth.account_locked',
  // Self-service privacy actions
  'privacy.data_exported',
  'privacy.account_deleted',
  // Administrative / privileged actions
  'admin.user_status_changed',
  'admin.verification_decision',
  // Administrator conversation-METADATA inspection (Task 33.2). Recorded on
  // every admin read of GET /admin/conversations/:id. Message CONTENT is
  // never auditable because it is never exposed to administrators, and no
  // message body is ever written to this log.
  'admin.conversation_metadata_accessed',
  // Sensitive resource access
  'security.verification_document_accessed',
  'security.verification_document_deleted',
  // NOTE: technician profile PHOTOS are deliberately NOT audited. They are
  // public by design (GET /technicians/:id/photo is unauthenticated), so
  // logging every read would add high-volume, low-value records. Only
  // verification evidence — which is private — is access-logged.
  // Account lifecycle
  'account.suspended',
  'account.reactivated',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditEventInput {
  eventType: AuditEventType;
  outcome?: AuditOutcome;
  /** Null when the actor is unauthenticated (e.g. failed login, unknown email). */
  actorUserId?: string | null;
  actorRole?: string | null;
  /** Whose data the action affected. Equals the actor for self-service. */
  targetUserId?: string | null;
  targetEntityType?: string | null;
  targetEntityId?: string | null;
  /**
   * Technical detail only. Keys are allow-listed below and values are
   * primitives. Passing a non-primitive (object/array/buffer) or an
   * over-length value is dropped rather than truncated, so a nested payload
   * can never smuggle personal data into the log.
   */
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Allow-list of metadata keys. Anything outside this set is dropped.
 * Each key is a low-cardinality technical fact with no personal content.
 */
const METADATA_KEY_ALLOW_LIST = new Set([
  'reason',
  'reason_code',
  'previous_status',
  'new_status',
  'decision',
  'document_type',
  'document_count',
  'photo_count',
  'offer_count',
  'request_count',
  'review_count',
  'notification_count',
  'session_count',
  'push_subscription_count',
  'record_count',
  'route',
  'method',
  'status_code',
  'category_count',
  'source',
  'scope',
  'provider',
  'channel',
  'retention_class',
  'export_format',
  'deletion_scope',
  'user_agent_family',
]);

const MAX_METADATA_VALUE_LENGTH = 200;

/** Reduce caller metadata to allow-listed primitive entries only. */
function sanitiseMetadata(
  input: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> {
  if (!input) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!METADATA_KEY_ALLOW_LIST.has(key)) continue;
    if (value === null) {
      out[key] = null;
      continue;
    }
    const type = typeof value;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') continue;
    if (type === 'string') {
      const trimmed = (value as string).slice(0, MAX_METADATA_VALUE_LENGTH);
      out[key] = trimmed;
    } else {
      out[key] = value as number | boolean;
    }
  }
  return out;
}

function isValidEventType(value: string): value is AuditEventType {
  return (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Append one audit event.
 *
 * Never throws and never rejects: a caller that awaits this is guaranteed to
 * continue even if the audit write fails.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    if (!isValidEventType(input.eventType)) {
      // An unknown event type is a programming error, not a runtime condition.
      // Surface it in the application log rather than inventing a row.
      console.error('[audit] refused unknown event_type:', input.eventType);
      return;
    }
    await query(
      `INSERT INTO audit_events
         (event_type, actor_user_id, actor_role, target_user_id,
          target_entity_type, target_entity_id, outcome, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        input.eventType,
        input.actorUserId ?? null,
        input.actorRole ?? null,
        input.targetUserId ?? null,
        input.targetEntityType ?? null,
        input.targetEntityId ?? null,
        input.outcome ?? 'success',
        JSON.stringify(sanitiseMetadata(input.metadata)),
      ],
    );
  } catch (error) {
    // Log-and-continue: an audit failure must never fail the business action.
    console.error('[audit] failed to record event:', {
      eventType: input.eventType,
      outcome: input.outcome ?? 'success',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface AuditEventRow {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  actor_role: string | null;
  target_user_id: string | null;
  target_entity_type: string | null;
  target_entity_id: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Administrator-only, paginated audit read.
 *
 * Deliberately separate from any data-subject route: an ordinary user must
 * not be able to read the audit log, and this function is only ever called
 * from a `requireRole('administrator')` route.
 */
export async function listAuditEvents(options: {
  limit: number;
  offset: number;
  eventType?: string;
  actorUserId?: string;
  outcome?: AuditOutcome;
}): Promise<{ events: AuditEventRow[]; total: number }> {
  const filters: string[] = [];
  const params: unknown[] = [];
  if (options.eventType) {
    params.push(options.eventType);
    filters.push(`event_type = $${params.length}`);
  }
  if (options.actorUserId) {
    params.push(options.actorUserId);
    filters.push(`actor_user_id = $${params.length}`);
  }
  if (options.outcome) {
    params.push(options.outcome);
    filters.push(`outcome = $${params.length}`);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = await query<AuditEventRow>(
    `SELECT id, event_type, actor_user_id, actor_role, target_user_id,
            target_entity_type, target_entity_id, outcome, metadata, created_at
       FROM audit_events
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, options.limit, options.offset],
  );
  const countRows = await query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM audit_events ${where}`,
    params,
  );
  return { events: rows, total: Number(countRows[0]?.total ?? 0) };
}

/**
 * Audit rows concerning one account, used by that account's own data export
 * (28.3C). Returns the subject's OWN security-relevant history only: events
 * where they are the actor or the target. It is deliberately not a general
 * audit-log reader.
 */
export async function listAuditEventsForUser(userId: string): Promise<AuditEventRow[]> {
  return query<AuditEventRow>(
    `SELECT id, event_type, actor_user_id, actor_role, target_user_id,
            target_entity_type, target_entity_id, outcome, metadata, created_at
       FROM audit_events
      WHERE actor_user_id = $1 OR target_user_id = $1
      ORDER BY created_at DESC, id DESC`,
    [userId],
  );
}
