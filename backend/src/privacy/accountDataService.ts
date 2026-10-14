import { getFileStorage } from '../storage/fileStorage.js';
import { query, transaction } from '../db/client.js';
import { listAuditEventsForUser } from './auditService.js';

/**
 * Data-subject access / export and permanent account deletion (28.3C, 28.3D).
 *
 * Everything here is derived from AUTHORITATIVE database relationships. No
 * recipient, owner or user id ever comes from the client: callers pass the
 * authenticated principal's id, which the route layer obtains from
 * `requireAuth` (and the role/ownership guards re-read from the database).
 *
 * ---------------------------------------------------------------------------
 * What an export NEVER contains
 * ---------------------------------------------------------------------------
 *   * `users.password_hash` and any password material
 *   * `sessions.token_hash` (SHA-256 of the refresh token) or the raw token
 *   * `technician_verification_documents.storage_key` or document BYTES — the
 *     export lists document metadata only and points at the existing
 *     owner-scoped download route, so access still goes through the
 *     authorization boundary rather than around it
 *   * push subscription device keys (`p256dh`, `auth`) and the full endpoint
 *     URL, which is itself a delivery capability
 *   * any other account's data, and any administrator-only material
 */

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

export interface TechnicianProfileRow {
  id: string;
  name: string;
  category: string;
  skills: string[];
  service_area: string;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  jobs: number | null;
  verified: boolean;
  availability: string | null;
  availability_status: string | null;
  bio: string | null;
  photo_key: string | null;
  verification_status: string;
  verification_rejection_reason: string | null;
  verification_submitted_at: string | null;
  verification_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Normalise an injected client's query result into a plain rows array.
 *
 * The `client` parameter below may be EITHER a `pg` client (whose `query`
 * resolves `{ rows, rowCount, … }`) OR the pool helper from `db/client.ts`
 * (whose `query` resolves the rows array DIRECTLY — see its
 * `Promise<T[]>` return type). Both are legitimate injections: a transaction
 * hands in the `pg` client, while the export path hands in the helper.
 * Assuming the `pg` shape while being handed the helper is precisely what
 * broke the data export — `rows` was `undefined`, `rows[0]` threw a
 * TypeError, and the route reported it as the generic "Failed to build your
 * data export". Normalising here keeps ONE implementation usable from both
 * call sites instead of duplicating the query.
 */
function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

async function findTechnicianProfile(
  client: { query: Function },
  userId: string,
): Promise<TechnicianProfileRow | null> {
  const result = await client.query(
    `SELECT id, name, category, skills, service_area, latitude, longitude,
            rating, jobs, verified, availability, availability_status, bio,
            photo_key, verification_status, verification_rejection_reason,
            verification_submitted_at, verification_reviewed_at,
            created_at, updated_at
       FROM technicians WHERE user_id = $1`,
    [userId],
  );
  return queryRows<TechnicianProfileRow>(result)[0] ?? null;
}

/** Host of a push endpoint only — never the path, which is a send capability. */
function endpointHost(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 28.3C — data access / export                                        */
/* ------------------------------------------------------------------ */

export interface AccountExport {
  format: 'umodzi-account-export-v1';
  generatedAt: string;
  subject: Record<string, unknown>;
  technicianProfile: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  sessions: Record<string, unknown>[];
  serviceRequests: Record<string, unknown>[];
  offersMade: Record<string, unknown>[];
  offersReceived: Record<string, unknown>[];
  reviewsWritten: Record<string, unknown>[];
  reviewsReceived: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  pushSubscriptions: Record<string, unknown>[];
  securityEvents: Record<string, unknown>[];
  counts: Record<string, number>;
  /** Human-readable statement of what is deliberately excluded and why. */
  exclusions: string[];
}

/**
 * Build a complete, real export of everything the given account owns.
 *
 * Every array is honestly empty when the account has no such rows — nothing
 * is invented to make an export look populated.
 */
export async function buildAccountExport(userId: string): Promise<AccountExport> {
  const accountRows = await query<{
    id: string;
    email: string;
    role: string;
    first_name: string;
    last_name: string;
    account_status: string;
    created_at: string;
    updated_at: string;
  }>(
    // password_hash is deliberately absent from the projection.
    `SELECT id, email, role, first_name, last_name, account_status, created_at, updated_at
       FROM users WHERE id = $1`,
    [userId],
  );
  const account = accountRows[0];
  if (!account) {
    throw new Error('Account not found');
  }

  const profile = await findTechnicianProfile({ query }, userId);

  const sessionRows = await query<{
    id: string;
    created_at: string;
    expires_at: string;
    revoked_at: string | null;
    revoked_reason: string | null;
    last_used_at: string | null;
  }>(
    // token_hash is deliberately absent from the projection.
    `SELECT id, created_at, expires_at, revoked_at, revoked_reason, last_used_at
       FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );

  const requestRows = await query<{
    id: string;
    description: string;
    category: string;
    city: string;
    status: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, description, category, city, status, created_at, updated_at
       FROM service_requests WHERE customer_user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );

  // Offers the subject's technician profile received (technician view).
  const offersReceived = profile
    ? await query<{
        id: string;
        request_id: string;
        candidate_index: number;
        status: string;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT id, request_id, candidate_index, status, created_at, updated_at
           FROM dispatch_offers WHERE technician_id = $1 ORDER BY created_at DESC`,
        [profile.id],
      )
    : [];

  // Offers made on the subject's own requests (customer view).
  const offersMade = await query<{
    id: string;
    request_id: string;
    technician_id: string;
    status: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT o.id, o.request_id, o.technician_id, o.status, o.created_at, o.updated_at
       FROM dispatch_offers o
       JOIN service_requests r ON r.id = o.request_id
      WHERE r.customer_user_id = $1
      ORDER BY o.created_at DESC`,
    [userId],
  );

  const reviewsWritten = await query<{
    id: string;
    service_request_id: string;
    technician_id: string;
    rating: number;
    comment: string | null;
    created_at: string;
  }>(
    `SELECT id, service_request_id, technician_id, rating, comment, created_at
       FROM reviews WHERE customer_id = $1 ORDER BY created_at DESC`,
    [userId],
  );

  const reviewsReceived = profile
    ? await query<{
        id: string;
        service_request_id: string;
        customer_id: string;
        rating: number;
        comment: string | null;
        created_at: string;
      }>(
        `SELECT id, service_request_id, customer_id, rating, comment, created_at
           FROM reviews WHERE technician_id = $1 ORDER BY created_at DESC`,
        [profile.id],
      )
    : [];

  const notifications = await query<{
    id: string;
    type: string;
    title: string;
    message: string;
    channel: string;
    reference_type: string | null;
    reference_id: string | null;
    read: boolean;
    status: string;
    created_at: string;
    sent_at: string | null;
    read_at: string | null;
  }>(
    `SELECT id, type, title, message, channel, reference_type, reference_id,
            read, status, created_at, sent_at, read_at
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );

  const pushSubscriptions = await query<{
    id: string;
    endpoint: string;
    user_agent: string | null;
    created_at: string;
    updated_at: string;
  }>(
    // p256dh/auth (device keys) are deliberately absent from the projection.
    `SELECT id, endpoint, user_agent, created_at, updated_at
       FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );

  const auditEvents = await listAuditEventsForUser(userId);

  // Verification documents: metadata only. storage_key and bytes excluded.
  const documents = profile
    ? await query<{
        id: string;
        document_type: string;
        file_name: string;
        content_type: string;
        size_bytes: number;
        created_at: string;
      }>(
        `SELECT id, document_type, file_name, content_type, size_bytes, created_at
           FROM technician_verification_documents
          WHERE technician_id = $1 ORDER BY created_at DESC`,
        [profile.id],
      )
    : [];

  const exportPayload: AccountExport = {
    format: 'umodzi-account-export-v1',
    generatedAt: new Date().toISOString(),
    subject: {
      id: account.id,
      email: account.email,
      role: account.role,
      firstName: account.first_name,
      lastName: account.last_name,
      accountStatus: account.account_status,
      createdAt: account.created_at,
      updatedAt: account.updated_at,
    },
    technicianProfile: profile
      ? {
          id: profile.id,
          name: profile.name,
          category: profile.category,
          skills: profile.skills,
          serviceArea: profile.service_area,
          // The subject's OWN stored coordinates. These are deliberately
          // withheld from every public route (G-01) but are the subject's
          // personal data, so they belong in the subject's own export.
          latitude: profile.latitude,
          longitude: profile.longitude,
          rating: profile.rating,
          jobs: profile.jobs,
          verified: profile.verified,
          availability: profile.availability,
          availabilityStatus: profile.availability_status,
          bio: profile.bio,
          hasPhoto: profile.photo_key !== null,
          createdAt: profile.created_at,
          updatedAt: profile.updated_at,
        }
      : null,
    verification: profile
      ? {
          status: profile.verification_status,
          rejectionReason: profile.verification_rejection_reason,
          submittedAt: profile.verification_submitted_at,
          reviewedAt: profile.verification_reviewed_at,
          documents: documents.map((d) => ({
            id: d.id,
            documentType: d.document_type,
            fileName: d.file_name,
            contentType: d.content_type,
            sizeBytes: d.size_bytes,
            createdAt: d.created_at,
            // Points at the existing owner-scoped route. Bytes are fetched
            // through the normal authorization boundary, not inlined here.
            downloadPath: `/api/v1/verification-documents/${d.id}/file`,
          })),
        }
      : null,
    sessions: sessionRows.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      revokedAt: s.revoked_at,
      revokedReason: s.revoked_reason,
      lastUsedAt: s.last_used_at,
    })),
    serviceRequests: requestRows.map((r) => ({
      id: r.id,
      description: r.description,
      category: r.category,
      city: r.city,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    offersMade: offersMade.map((o) => ({
      id: o.id,
      requestId: o.request_id,
      technicianId: o.technician_id,
      status: o.status,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    })),
    offersReceived: offersReceived.map((o) => ({
      id: o.id,
      requestId: o.request_id,
      candidateIndex: o.candidate_index,
      status: o.status,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    })),
    reviewsWritten: reviewsWritten.map((r) => ({
      id: r.id,
      serviceRequestId: r.service_request_id,
      technicianId: r.technician_id,
      rating: r.rating,
      comment: r.comment,
      createdAt: r.created_at,
    })),
    reviewsReceived: reviewsReceived.map((r) => ({
      id: r.id,
      serviceRequestId: r.service_request_id,
      rating: r.rating,
      comment: r.comment,
      createdAt: r.created_at,
      // The reviewer identity is deliberately reduced to the same
      // pseudonym the public reviews bundle uses, rather than exposing the
      // other customer's email or full name.
      reviewer: 'Withheld — see the public review for the published pseudonym',
    })),
    notifications: notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      channel: n.channel,
      referenceType: n.reference_type,
      referenceId: n.reference_id,
      read: n.read,
      status: n.status,
      createdAt: n.created_at,
      sentAt: n.sent_at,
      readAt: n.read_at,
    })),
    pushSubscriptions: pushSubscriptions.map((p) => ({
      id: p.id,
      endpointHost: endpointHost(p.endpoint),
      userAgent: p.user_agent,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    })),
    securityEvents: auditEvents.map((a) => ({
      id: a.id,
      eventType: a.event_type,
      actorRole: a.actor_role,
      outcome: a.outcome,
      targetEntityType: a.target_entity_type,
      targetEntityId: a.target_entity_id,
      metadata: a.metadata,
      createdAt: a.created_at,
    })),
    counts: {
      sessions: sessionRows.length,
      serviceRequests: requestRows.length,
      offersMade: offersMade.length,
      offersReceived: offersReceived.length,
      reviewsWritten: reviewsWritten.length,
      reviewsReceived: reviewsReceived.length,
      notifications: notifications.length,
      pushSubscriptions: pushSubscriptions.length,
      verificationDocuments: documents.length,
      securityEvents: auditEvents.length,
    },
    exclusions: [
      'password_hash and all password material — never disclosed in any form',
      'session token hashes and refresh tokens — security credentials',
      'verification document storage keys and file bytes — retrieved through the owner-scoped download route after authorization',
      'push subscription device keys (p256dh, auth) and full endpoint URLs — the endpoint is a delivery capability',
      "other users' personal data, and administrator-only records",
      'reviewer identities for reviews received — published only as the pseudonym shown on the public review',
    ],
  };

  return exportPayload;
}

/* ------------------------------------------------------------------ */
/* 28.3D — permanent account deletion                                  */
/* ------------------------------------------------------------------ */

export interface DeletionReport {
  technicianProfileDeleted: boolean;
  serviceRequestsDeleted: number;
  /** Offers removed, whether received by the profile or made on own requests. */
  offersDeleted: number;
  /** Total reviews removed (authored by the subject, plus about their profile). */
  reviewsDeleted: number;
  reviewsAuthoredDeleted: number;
  reviewsAboutProfileDeleted: number;
  notificationsDeleted: number;
  pushSubscriptionsDeleted: number;
  sessionsDeleted: number;
  verificationDocumentsDeleted: number;
  storageObjectsDeleted: number;
  storageObjectsFailed: number;
}

/**
 * Permanently delete an account and everything it owns.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a plain `DELETE FROM users`
 * ---------------------------------------------------------------------------
 * The real foreign keys do NOT cascade the way deletion intuition suggests:
 *
 *   sessions.user_id                     -> users  ON DELETE CASCADE
 *   notifications.user_id                -> users  ON DELETE CASCADE
 *   push_subscriptions.user_id           -> users  ON DELETE CASCADE
 *   reviews.customer_id                  -> users  ON DELETE CASCADE
 *   service_requests.customer_user_id    -> users  ON DELETE SET NULL   <-- orphan!
 *   technicians.user_id                  -> users  ON DELETE SET NULL   <-- orphan!
 *   technicians.verification_reviewed_by -> users  ON DELETE SET NULL
 *
 * A bare user delete would therefore leave the account's service requests
 * (with their free-text descriptions) and its technician profile (name, bio,
 * verification state, photo reference) behind, detached from any owner. That
 * is not permanent deletion, so this function removes them explicitly FIRST,
 * letting the existing ON DELETE CASCADE rules clean up their dependants.
 *
 * DOCUMENTED CONSEQUENCES (deliberate, and the honest alternative was worse):
 *   * Reviews written by OTHER customers about a deleted technician profile
 *     are removed with it, because `reviews.technician_id` is NOT NULL and
 *     cascades. They cannot exist without a subject. The technician's rating
 *     and job-count aggregates therefore also disappear.
 *   * The user CANNOT choose to keep an anonymised profile: retaining the
 *     profile would retain the name, bio and verification state that make it
 *     personal data, which is exactly what permanent deletion removes.
 *
 * Storage ordering: relational rows are removed and COMMITTED first, then
 * stored objects are unlinked. If an unlink fails we log it and continue —
 * an orphaned file is unreachable (bytes are only ever served after a
 * database lookup of the storage key, and that row is now gone) whereas the
 * reverse order could leave live rows pointing at deleted files.
 *
 * @param userId the authenticated principal. Never a client-supplied value.
 */
export async function permanentlyDeleteAccount(userId: string): Promise<DeletionReport> {
  const storage = getFileStorage();
  const storageKeysToRemove: string[] = [];

  const deleted = await transaction(async (client) => {
    // 1. Collect owned storage keys AND the dependent-row counts BEFORE any
    //    removal — once a parent row is gone, its cascades can no longer be
    //    counted, so counting afterwards would silently report zero.
    const profile = await findTechnicianProfile(client, userId);

    let documentKeys: string[] = [];
    let offersReceivedCount = 0;
    let reviewsReceivedCount = 0;
    if (profile) {
      const docs = await client.query(
        `SELECT storage_key FROM technician_verification_documents WHERE technician_id = $1`,
        [profile.id],
      );
      documentKeys = docs.rows.map((d: { storage_key: string }) => d.storage_key);
      storageKeysToRemove.push(...documentKeys);
      if (profile.photo_key) storageKeysToRemove.push(profile.photo_key);

      const offers = await client.query(
        `SELECT COUNT(*)::int AS n FROM dispatch_offers WHERE technician_id = $1`,
        [profile.id],
      );
      offersReceivedCount = Number(offers.rows[0]?.n ?? 0);
      const reviews = await client.query(
        `SELECT COUNT(*)::int AS n FROM reviews WHERE technician_id = $1`,
        [profile.id],
      );
      reviewsReceivedCount = Number(reviews.rows[0]?.n ?? 0);
    }

    // Offers attached to the account's own requests also cascade.
    const offersOnOwnRequests = await client.query(
      `SELECT COUNT(*)::int AS n FROM dispatch_offers o
         JOIN service_requests r ON r.id = o.request_id
        WHERE r.customer_user_id = $1`,
      [userId],
    );
    const offersOnOwnRequestsCount = Number(offersOnOwnRequests.rows[0]?.n ?? 0);

    // 2. Reviews the account authored (own personal data).
    const reviewsWritten = await client.query(
      `DELETE FROM reviews WHERE customer_id = $1 RETURNING id`,
      [userId],
    );

    // 3. Requests the account raised. Cascades: dispatch_offers, reviews.
    const requests = await client.query(
      `DELETE FROM service_requests WHERE customer_user_id = $1 RETURNING id`,
      [userId],
    );

    // 4. Technician profile (if any). Cascades: dispatch_offers received,
    //    technician_verification_documents, reviews about the profile.
    let profileDeleted = false;
    if (profile) {
      const profileResult = await client.query(
        `DELETE FROM technicians WHERE id = $1 RETURNING id`,
        [profile.id],
      );
      profileDeleted = (profileResult.rowCount ?? 0) > 0;
    }

    // 5. Cascading user-owned rows, counted for the report.
    const notifications = await client.query(
      `DELETE FROM notifications WHERE user_id = $1 RETURNING id`,
      [userId],
    );
    const push = await client.query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 RETURNING id`,
      [userId],
    );
    const sessions = await client.query(
      `DELETE FROM sessions WHERE user_id = $1 RETURNING id`,
      [userId],
    );

    // 6. The account itself.
    const user = await client.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [userId]);
    if ((user.rowCount ?? 0) === 0) {
      throw new Error('Account not found');
    }

    return {
      technicianProfileDeleted: profileDeleted,
      verificationDocumentsDeleted: documentKeys.length,
      serviceRequestsDeleted: requests.rowCount ?? 0,
      reviewsDeleted: (reviewsWritten.rowCount ?? 0) + reviewsReceivedCount,
      reviewsAuthoredDeleted: reviewsWritten.rowCount ?? 0,
      reviewsAboutProfileDeleted: reviewsReceivedCount,
      notificationsDeleted: notifications.rowCount ?? 0,
      pushSubscriptionsDeleted: push.rowCount ?? 0,
      sessionsDeleted: sessions.rowCount ?? 0,
      offersDeleted: offersReceivedCount + offersOnOwnRequestsCount,
    };
  });

  // 7. Post-commit storage cleanup — best effort, never fails the deletion.
  let storageDeleted = 0;
  let storageFailed = 0;
  for (const key of storageKeysToRemove) {
    try {
      await storage.remove(key);
      storageDeleted += 1;
    } catch (error) {
      storageFailed += 1;
      console.error('[deletion] failed to remove storage object:', {
        // The key itself is NOT logged: it is a storage reference for a
        // possibly higher-risk document.
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ...deleted,
    storageObjectsDeleted: storageDeleted,
    storageObjectsFailed: storageFailed,
  };
}

/**
 * Preview what permanent deletion would remove, without removing anything.
 * Powers the UI's "this cannot be undone" disclosure so the confirmation
 * screen describes real counts rather than a generic warning.
 */
export async function previewAccountDeletion(userId: string): Promise<Record<string, number>> {
  const counts = await query<Record<string, string>>(
    `SELECT
       (SELECT COUNT(*) FROM service_requests WHERE customer_user_id = $1)::int AS service_requests,
       (SELECT COUNT(*) FROM reviews WHERE customer_id = $1)::int AS reviews_written,
       (SELECT COUNT(*) FROM notifications WHERE user_id = $1)::int AS notifications,
       (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = $1)::int AS push_subscriptions,
       (SELECT COUNT(*) FROM sessions WHERE user_id = $1)::int AS sessions,
       (SELECT COUNT(*) FROM technicians WHERE user_id = $1)::int AS technician_profiles,
       (SELECT COUNT(*) FROM technician_verification_documents d
          JOIN technicians t ON t.id = d.technician_id
         WHERE t.user_id = $1)::int AS verification_documents,
       (SELECT COUNT(*) FROM audit_events
         WHERE actor_user_id = $1 OR target_user_id = $1)::int AS retained_security_events`,
    [userId],
  );
  const row = counts[0] ?? {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) out[key] = Number(value ?? 0);
  return out;
}
