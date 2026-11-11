/**
 * Dispatch engine (Task 36 — directive Phases 5 / 9 / 10 / 11 / 12).
 *
 * ONE server-authoritative home for the decisions that used to live partly
 * in browser code (`cascadingOfferService`, `smartDispatchPipelineService`):
 *
 *   - candidate selection (category + area + verified + active + available,
 *     workload-capped, deterministic order, never re-offering a technician);
 *   - cascade after a pending offer is rejected or expires;
 *   - the waiting behaviour for `no_match` requests when availability returns;
 *   - the technician active-assignment cap, enforced in SQL transactions.
 *
 * Everything here runs inside a `transaction()` and uses conditional updates
 * + `FOR UPDATE` row locks, so two concurrent workers can never both win.
 * Notifications are deliberately NOT sent here: callers get the facts back
 * and notify after their own transaction has committed, so a notification
 * failure can never roll back (or double-report) a business change.
 */

import { query, transaction } from "../db/client.js";
import { HttpError } from "../auth/httpError.js";

export interface RequestCore {
  id: string;
  category: string;
  city: string;
  status: string;
  customerUserId: string | null;
}

export interface CandidateSelection {
  technicianId: string;
  technicianUserId: string | null;
}

export interface CreatedOffer extends CandidateSelection {
  offerId: string;
  requestId: string;
  candidateIndex: number;
}

export type OfferOutcome = "rejected" | "timed_out";

/** Configurable technician active-assignment cap (Phase 9 requirement 1–2). */
export function maxActiveAssignmentsPerTechnician(): number {
  const configured = Number(process.env.MAX_ACTIVE_ASSIGNMENTS_PER_TECHNICIAN);
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : 3;
}

/** How long a pending offer may sit unanswered before dispatch moves on. */
export function offerTimeoutMinutes(): number {
  const configured = Number(process.env.DISPATCH_OFFER_TIMEOUT_MINUTES);
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : 15;
}

/** How often the in-process sweeper runs. */
export function sweepIntervalMs(): number {
  const configured = Number(process.env.DISPATCH_SWEEP_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 15_000
    ? Math.floor(configured)
    : 60_000;
}

/** How long a no_match request waits before dispatch retries it. */
export function waitingRetryMinutes(): number {
  const configured = Number(process.env.DISPATCH_WAITING_RETRY_MINUTES);
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : 30;
}

/** Waiting requests older than this are never auto-retried. */
export function waitingMaxAgeHours(): number {
  const configured = Number(process.env.DISPATCH_WAITING_MAX_AGE_HOURS);
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : 72;
}

/**
 * Active assignments = accepted offers on requests still being served.
 * Completed/cancelled/rejected history never counts toward the cap.
 */
async function activeAssignmentCount(
  client: { query: Function },
  technicianId: string,
): Promise<number> {
  const rows = (await client.query(
    `SELECT COUNT(*)::int AS n
       FROM dispatch_offers a
       JOIN service_requests r ON r.id = a.request_id
      WHERE a.technician_id = $1
        AND a.status = 'accepted'
        AND r.status IN ('matched', 'in_progress')`,
    [technicianId],
  )) as { rows: Array<{ n: number }> };
  return rows.rows[0]?.n ?? 0;
}

/**
 * Eligibility of ONE technician to take this request's work, checked inside
 * the caller's transaction (Phase 10 requirements 6–8, Phase 12.8).
 *
 * Mirrors `assertOfferEligibility` in authorization.ts (same 409/422 copy) so
 * create-time and accept-time gates can never drift apart. The duplicate-offer
 * check is intentionally NOT part of this function: the accept path operates
 * on an existing offer, and the cascade candidate query already excludes
 * technicians holding an offer.
 */
export async function assertTechnicianCanTakeWork(
  client: { query: Function },
  request: RequestCore,
  technicianId: string,
): Promise<void> {
  const result = (await client.query(
    `SELECT id, category, service_area, account_status, availability_status,
            verification_status, verified, latitude, longitude
       FROM technicians
      WHERE id = $1`,
    [technicianId],
  )) as { rows: Array<{
    id: string;
    category: string;
    service_area: string;
    account_status: string;
    availability_status: string;
    verification_status: string;
    verified: boolean;
    latitude: number | null;
    longitude: number | null;
  }> };

  const tech = result.rows[0];
  if (!tech) {
    throw new HttpError(404, "Technician not found");
  }
  if (tech.account_status !== "active") {
    throw new HttpError(422, "Technician is not active");
  }
  if (tech.verification_status !== "verified" && tech.verified !== true) {
    throw new HttpError(422, "Technician is not verified");
  }
  if (tech.availability_status !== "available") {
    throw new HttpError(422, "Technician is not available");
  }
  if (tech.category !== request.category) {
    throw new HttpError(
      422,
      "Technician does not cover the requested service category",
    );
  }
  if (tech.service_area.trim().toLowerCase() !== request.city.trim().toLowerCase()) {
    throw new HttpError(422, "Technician is outside the requested service area");
  }

  const active = await activeAssignmentCount(client, technicianId);
  if (active >= maxActiveAssignmentsPerTechnician()) {
    throw new HttpError(
      409,
      "Technician has reached the configured active-assignment limit",
    );
  }

  // Optional distance cap, best effort — identical to the create-time gate.
  const maxRadiusKm = Number(process.env.MAX_SERVICE_RADIUS_KM);
  if (
    Number.isFinite(maxRadiusKm) &&
    maxRadiusKm > 0 &&
    tech.latitude !== null &&
    tech.longitude !== null
  ) {
    const reqRows = (await client.query(
      "SELECT latitude, longitude FROM service_requests WHERE id = $1",
      [request.id],
    )) as { rows: Array<{ latitude: number | null; longitude: number | null }> };
    const req = reqRows.rows[0];
    if (req && req.latitude !== null && req.longitude !== null) {
      const dist = (await client.query(
        `SELECT ST_Distance(
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
         ) AS meters`,
        [req.longitude, req.latitude, tech.longitude, tech.latitude],
      )) as { rows: Array<{ meters: number }> };
      if (dist.rows[0] && dist.rows[0].meters > maxRadiusKm * 1000) {
        throw new HttpError(
          422,
          "Technician is outside the permitted service radius",
        );
      }
    }
  }
}

/**
 * Select the next candidate for a request. Excludes every technician that
 * already holds an offer (pending or resolved) on it — candidates are never
 * revisited — and only returns technicians below the workload cap.
 * `FOR UPDATE SKIP LOCKED` keeps two concurrent dispatches from picking the
 * same technician row.
 */
export async function findNextCandidate(
  client: { query: Function },
  request: RequestCore,
): Promise<CandidateSelection | null> {
  const result = (await client.query(
    `SELECT t.id, t.user_id
       FROM technicians t
      WHERE t.category = $1
        AND t.service_area = $2
        AND (t.verification_status = 'verified' OR t.verified = true)
        AND t.account_status = 'active'
        AND t.availability_status = 'available'
        AND t.user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_offers o
           WHERE o.request_id = $3 AND o.technician_id = t.id
        )
        AND (
          SELECT COUNT(*)::int
            FROM dispatch_offers a
            JOIN service_requests r ON r.id = a.request_id
           WHERE a.technician_id = t.id
             AND a.status = 'accepted'
             AND r.status IN ('matched', 'in_progress')
        ) < $4
      ORDER BY (
          SELECT COUNT(*)::int
            FROM dispatch_offers a
            JOIN service_requests r ON r.id = a.request_id
           WHERE a.technician_id = t.id
             AND a.status = 'accepted'
             AND r.status IN ('matched', 'in_progress')
        ) ASC,
        t.jobs ASC,
        t.rating DESC,
        t.id ASC
      LIMIT 1
      FOR UPDATE OF t SKIP LOCKED`,
    [request.category, request.city, request.id, maxActiveAssignmentsPerTechnician()],
  )) as { rows: Array<{ id: string; user_id: string | null }> };

  const row = result.rows[0];
  if (!row) return null;
  return { technicianId: row.id, technicianUserId: row.user_id };
}

/**
 * Persist the next pending offer for a request. candidate_index is assigned
 * as MAX(existing)+1 so a browser can never dictate cascade order again
 * (finding #13).
 */
export async function createOfferForCandidate(
  client: { query: Function },
  requestId: string,
  candidate: CandidateSelection,
): Promise<CreatedOffer> {
  const indexRows = (await client.query(
    `SELECT COALESCE(MAX(candidate_index) + 1, 0)::int AS next_index
       FROM dispatch_offers WHERE request_id = $1`,
    [requestId],
  )) as { rows: Array<{ next_index: number }> };
  const candidateIndex = indexRows.rows[0]?.next_index ?? 0;

  const inserted = (await client.query(
    `INSERT INTO dispatch_offers
       (request_id, technician_id, candidate_index, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', NOW(), NOW())
     RETURNING id, request_id, technician_id, candidate_index`,
    [requestId, candidate.technicianId, candidateIndex],
  )) as { rows: Array<{
    id: string;
    request_id: string;
    technician_id: string;
    candidate_index: number;
  }> };

  const row = inserted.rows[0];
  return {
    offerId: row.id,
    requestId: row.request_id,
    technicianId: row.technician_id,
    candidateIndex: row.candidate_index,
    technicianUserId: candidate.technicianUserId,
  };
}

/** Lifecycle audit row (Phase 7 requirement 10). Never a silent transition. */
export async function recordRequestEvent(
  client: { query: Function },
  args: {
    requestId: string;
    fromStatus: string | null;
    toStatus: string;
    actorUserId: string | null;
    actorRole: string | null;
    reason: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO service_request_events
       (request_id, from_status, to_status, actor_user_id, actor_role, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      args.requestId,
      args.fromStatus,
      args.toStatus,
      args.actorUserId,
      args.actorRole,
      args.reason,
    ],
  );
}

/**
 * Dispatch a request to its next candidate, or fall back to `no_match`.
 * Caller must hold the request row lock; returns what happened so the
 * caller can notify after commit.
 */
export async function cascadeRequest(
  client: { query: Function },
  request: RequestCore,
  reason: string,
): Promise<{ nextOffer: CreatedOffer | null; fellBack: boolean }> {
  const candidate = await findNextCandidate(client, request);
  if (candidate) {
    const offer = await createOfferForCandidate(client, request.id, candidate);
    return { nextOffer: offer, fellBack: false };
  }
  await client.query(
    `UPDATE service_requests SET status = 'no_match', updated_at = NOW(), last_dispatch_at = NOW()
      WHERE id = $1 AND status IN ('pending', 'matching')`,
    [request.id],
  );
  // A request already sitting in no_match (a retry that found nobody) does
  // not need another identical audit row for every sweep cycle.
  if (request.status !== "no_match") {
    await recordRequestEvent(client, {
      requestId: request.id,
      fromStatus: request.status,
      toStatus: "no_match",
      actorUserId: null,
      actorRole: "system",
      reason,
    });
  }
  return { nextOffer: null, fellBack: true };
}

export interface OfferOutcomeResult {
  /** false when the offer was already resolved (idempotent replay). */
  offerUpdated: boolean;
  requestId: string;
  requestStatusBefore: string;
  requestStatusAfter: string | null;
  customerUserId: string | null;
  requestCategory: string;
  requestCity: string;
  nextOffer: CreatedOffer | null;
  /** The resolved offer row, for the API response (OfferApi construction). */
  offer: {
    id: string;
    requestId: string;
    technicianId: string;
    candidateIndex: number;
    status: string;
    createdAt: string;
    updatedAt: string;
  } | null;
}

/**
 * Apply `rejected` / `timed_out` to a pending offer and cascade server-side.
 * Idempotent: a resolved offer returns without changing anything. If the
 * request has already moved past `matching` (another technician accepted, or
 * the customer cancelled), the stale pending offer is closed WITHOUT a
 * cascade — the request's own state wins.
 */
export async function processOfferOutcome(
  offerId: string,
  outcome: OfferOutcome,
): Promise<OfferOutcomeResult | null> {
  return transaction(async (client) => {
    const locked = (await client.query(
      `SELECT o.id, o.request_id, o.technician_id, o.candidate_index,
              o.created_at, o.updated_at, o.status AS offer_status,
              r.id AS r_id, r.category, r.city, r.status AS r_status, r.customer_user_id
         FROM dispatch_offers o
         JOIN service_requests r ON r.id = o.request_id
        WHERE o.id = $1
        FOR UPDATE OF o, r`,
      [offerId],
    )) as { rows: Array<{
      id: string;
      request_id: string;
      technician_id: string;
      candidate_index: number;
      created_at: string;
      updated_at: string;
      offer_status: string;
      r_id: string;
      category: string;
      city: string;
      r_status: string;
      customer_user_id: string | null;
    }> };

    const row = locked.rows[0];
    if (!row) return null;

    const request: RequestCore = {
      id: row.r_id,
      category: row.category,
      city: row.city,
      status: row.r_status,
      customerUserId: row.customer_user_id,
    };

    const offerRow = {
      id: row.id,
      requestId: row.request_id,
      technicianId: row.technician_id,
      candidateIndex: row.candidate_index,
      status: row.offer_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    if (row.offer_status !== "pending") {
      return {
        offerUpdated: false,
        requestId: request.id,
        requestStatusBefore: request.status,
        requestStatusAfter: null,
        customerUserId: request.customerUserId,
        requestCategory: request.category,
        requestCity: request.city,
        nextOffer: null,
        offer: offerRow,
      };
    }

    await client.query(
      `UPDATE dispatch_offers SET status = $1, updated_at = NOW() WHERE id = $2`,
      [outcome, offerId],
    );
    offerRow.status = outcome;

    if (request.status === "pending" || request.status === "matching") {
      const { nextOffer, fellBack } = await cascadeRequest(
        client,
        { ...request, status: "matching" },
        outcome === "timed_out"
          ? "offer_timeout"
          : "technician_rejected",
      );
      return {
        offerUpdated: true,
        requestId: request.id,
        requestStatusBefore: request.status,
        requestStatusAfter: fellBack ? "no_match" : null,
        customerUserId: request.customerUserId,
        requestCategory: request.category,
        requestCity: request.city,
        nextOffer,
        offer: offerRow,
      };
    }

    // Request already resolved elsewhere: just close this stale offer.
    return {
      offerUpdated: true,
      requestId: request.id,
      requestStatusBefore: request.status,
      requestStatusAfter: null,
      customerUserId: request.customerUserId,
      requestCategory: request.category,
      requestCity: request.city,
      nextOffer: null,
      offer: offerRow,
    };
  });
}

export interface AcceptGuardFailure extends Error {
  status: number;
}

export interface AssignmentResult {
  offer: {
    id: string;
    requestId: string;
    technicianId: string;
    candidateIndex: number;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  conversationCreated: boolean;
  /** Notifications to send AFTER commit (recipient user ids). */
  recipients: Array<{ userId: string; audience: "customer" | "technician" }>;
  closedCompetingOffers: number;
  alreadyAssigned: boolean;
}

/**
 * Atomic assignment (Phase 10 / 12). ONE transaction:
 *   lock offer + request → re-validate offer pending, request open,
 *   technician eligible and below the workload cap → conditional offer update
 *   → conditional request update → close competing pending offers → create
 *   the conversation → audit row → availability when the cap is reached.
 *
 * Any guard failure throws HttpError, which rolls the whole transaction back:
 * the database remains the source of truth, not the frontend.
 */
export async function assignOfferAtomically(
  offerId: string,
  actor: { id: string; role: string },
): Promise<AssignmentResult> {
  return transaction(async (client) => {
    const locked = (await client.query(
      `SELECT o.id, o.request_id, o.technician_id, o.candidate_index,
              o.status AS offer_status, o.created_at, o.updated_at,
              r.id AS r_id, r.category, r.city, r.status AS r_status,
              r.customer_user_id
         FROM dispatch_offers o
         JOIN service_requests r ON r.id = o.request_id
        WHERE o.id = $1
        FOR UPDATE OF o, r`,
      [offerId],
    )) as { rows: Array<{
      id: string;
      request_id: string;
      technician_id: string;
      candidate_index: number;
      offer_status: string;
      created_at: string;
      updated_at: string;
      r_id: string;
      category: string;
      city: string;
      r_status: string;
      customer_user_id: string | null;
    }> };

    const row = locked.rows[0];
    if (!row) {
      throw new HttpError(404, "Offer not found");
    }

    const request: RequestCore = {
      id: row.r_id,
      category: row.category,
      city: row.city,
      status: row.r_status,
      customerUserId: row.customer_user_id,
    };

    // Idempotent replay: this very offer already won the assignment.
    if (row.offer_status === "accepted") {
      return {
        offer: {
          id: row.id,
          requestId: row.request_id,
          technicianId: row.technician_id,
          candidateIndex: row.candidate_index,
          status: "accepted",
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        conversationCreated: false,
        recipients: [],
        closedCompetingOffers: 0,
        alreadyAssigned: true,
      };
    }
    if (row.offer_status !== "pending") {
      throw new HttpError(
        409,
        `This offer was already ${row.offer_status.replace("_", " ")}`,
      );
    }
    if (request.status !== "pending" && request.status !== "matching") {
      throw new HttpError(409, "This request is no longer open for acceptance");
    }

    // Re-check eligibility AT ACCEPT TIME (finding #3): the technician may
    // have been suspended, deactivated, become unavailable, or reached the
    // workload cap since the offer was created.
    await assertTechnicianCanTakeWork(client, request, row.technician_id);

    const updated = (await client.query(
      `UPDATE dispatch_offers SET status = 'accepted', updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, request_id, technician_id, candidate_index, created_at, updated_at`,
      [offerId],
    )) as { rows: Array<{
      id: string;
      request_id: string;
      technician_id: string;
      candidate_index: number;
      created_at: string;
      updated_at: string;
    }> };
    if (updated.rows.length === 0) {
      throw new HttpError(409, "Offer was taken by another response");
    }

    const moved = (await client.query(
      `UPDATE service_requests SET status = 'matched', updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'matching')
        RETURNING id`,
      [request.id],
    )) as { rows: Array<{ id: string }> };
    if (moved.rows.length === 0) {
      throw new HttpError(409, "This request was already assigned or closed");
    }

    await recordRequestEvent(client, {
      requestId: request.id,
      fromStatus: request.status,
      toStatus: "matched",
      actorUserId: actor.id,
      actorRole: actor.role,
      reason: "offer_accepted",
    });

    // A request has ONE assignment: every other pending offer is closed so
    // no technician can still accept it afterwards (Phase 12.4).
    const closed = (await client.query(
      `UPDATE dispatch_offers SET status = 'rejected', updated_at = NOW()
        WHERE request_id = $1 AND id <> $2 AND status = 'pending'
        RETURNING id`,
      [request.id, offerId],
    )) as { rows: Array<{ id: string }> };

    // Conversation is created inside the same transaction: either both the
    // assignment AND chat exist, or neither does (Phase 3 requirement 1–2).
    let conversationCreated = false;
    const customerId = request.customerUserId;
    if (customerId) {
      const existing = (await client.query(
        "SELECT id FROM conversations WHERE service_request_id = $1 LIMIT 1",
        [request.id],
      )) as { rows: Array<{ id: string }> };
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO conversations
             (id, service_request_id, customer_id, technician_id, status)
           VALUES ($1, $2, $3, $4, 'active')`,
          [crypto.randomUUID(), request.id, customerId, row.technician_id],
        );
        conversationCreated = true;
      }
    }

    // Availability reflects the workload cap (Phase 9 requirement 7). Only a
    // technician who just REACHED the cap is flipped to unavailable, and the
    // `availability_auto` flag marks it as system-set so it is restored
    // automatically when capacity frees up. A technician below the cap keeps
    // their own availability toggle untouched.
    const activeNow = await activeAssignmentCount(client, row.technician_id);
    if (activeNow >= maxActiveAssignmentsPerTechnician()) {
      await client.query(
        `UPDATE technicians
            SET availability_status = 'unavailable', availability_auto = true, updated_at = NOW()
          WHERE id = $1`,
        [row.technician_id],
      );
    }

    const recipients: AssignmentResult["recipients"] = [];
    if (customerId && customerId !== actor.id) {
      recipients.push({ userId: customerId, audience: "customer" });
    }
    const techUserRows = (await client.query(
      "SELECT user_id FROM technicians WHERE id = $1",
      [row.technician_id],
    )) as { rows: Array<{ user_id: string | null }> };
    const techUserId = techUserRows.rows[0]?.user_id ?? null;
    if (techUserId && techUserId !== actor.id) {
      recipients.push({ userId: techUserId, audience: "technician" });
    }

    return {
      offer: {
        id: updated.rows[0].id,
        requestId: updated.rows[0].request_id,
        technicianId: updated.rows[0].technician_id,
        candidateIndex: updated.rows[0].candidate_index,
        status: "accepted",
        createdAt: updated.rows[0].created_at,
        updatedAt: updated.rows[0].updated_at,
      },
      conversationCreated,
      recipients,
      closedCompetingOffers: closed.rows.length,
      alreadyAssigned: false,
    };
  });
}

/**
 * Customer/admin retry of a `no_match` request (Phase 5 requirement 9).
 * Returns null when the request cannot currently be retried.
 */
export async function retryDispatchForRequest(
  requestId: string,
  actor: { id: string | null; role: string },
): Promise<{ status: string; nextOffer: CreatedOffer | null } | null> {
  return transaction(async (client) => {
    const locked = (await client.query(
      `SELECT id, category, city, status, customer_user_id
         FROM service_requests
        WHERE id = $1
        FOR UPDATE`,
      [requestId],
    )) as { rows: Array<{
      id: string;
      category: string;
      city: string;
      status: string;
      customer_user_id: string | null;
    }> };

    const row = locked.rows[0];
    if (!row) return null;
    if (row.status !== "no_match" && row.status !== "pending") return null;

    const accepted = (await client.query(
      `SELECT 1 FROM dispatch_offers
        WHERE request_id = $1 AND status = 'accepted' LIMIT 1`,
      [requestId],
    )) as { rows: Array<{ id: string }> };
    if (accepted.rows.length > 0) return null;

    const request: RequestCore = {
      id: row.id,
      category: row.category,
      city: row.city,
      status: row.status,
      customerUserId: row.customer_user_id,
    };

    await client.query(
      `UPDATE service_requests
          SET last_dispatch_at = NOW(), dispatch_attempts = dispatch_attempts + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [requestId],
    );

    const { nextOffer, fellBack } = await cascadeRequest(
      client,
      request,
      "customer_retry",
    );
    // cascadeRequest already fell back to no_match; when it found a candidate
    // the request moves back into matching.
    if (!fellBack) {
      await client.query(
        `UPDATE service_requests SET status = 'matching', updated_at = NOW()
          WHERE id = $1 AND status IN ('pending', 'no_match')`,
        [requestId],
      );
      await recordRequestEvent(client, {
        requestId,
        fromStatus: row.status,
        toStatus: "matching",
        actorUserId: actor.id,
        actorRole: actor.role,
        reason: "retry_dispatch",
      });
    }
    const statusRows = (await client.query(
      "SELECT status FROM service_requests WHERE id = $1",
      [requestId],
    )) as { rows: Array<{ status: string }> };

    return { status: statusRows.rows[0]?.status ?? row.status, nextOffer };
  });
}

/**
 * Sweep pending offers whose response window elapsed (Phase 5.4–6). Each
 * offer is processed in its own transaction via processOfferOutcome, so a
 * failure on one never blocks the others and a concurrent manual response
 * wins cleanly by lock order.
 */
export async function sweepExpiredOffers(): Promise<{
  expired: number;
  matched: number;
  fellBack: number;
}> {
  const minutes = offerTimeoutMinutes();
  const stale = await query<{ id: string }>(
    `SELECT o.id
       FROM dispatch_offers o
       JOIN service_requests r ON r.id = o.request_id
      WHERE o.status = 'pending'
        AND r.status = 'matching'
        AND o.updated_at < NOW() - ($1::int * interval '1 minute')
      ORDER BY o.updated_at ASC
      LIMIT 25`,
    [minutes],
  );
  const result = { expired: 0, matched: 0, fellBack: 0 };
  for (const { id } of stale) {
    const outcome = await processOfferOutcome(id, "timed_out");
    if (outcome?.offerUpdated) {
      result.expired += 1;
      if (outcome.nextOffer) result.matched += 1;
      else if (outcome.requestStatusAfter === "no_match") result.fellBack += 1;
    }
  }
  return result;
}

/**
 * Recover requests stuck in `matching` with NO pending offer — the state an
 * interrupted operation leaves behind (Phase 12.10). Each is cascaded or
 * falls back to no_match inside its own transaction.
 */
export async function sweepStuckMatchingRequests(): Promise<number> {
  const stale = await query<{ id: string }>(
    `SELECT r.id
       FROM service_requests r
      WHERE r.status = 'matching'
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_offers o
           WHERE o.request_id = r.id AND o.status = 'pending'
        )
        AND r.updated_at < NOW() - interval '5 minutes'
      ORDER BY r.updated_at ASC
      LIMIT 10`,
  );
  let recovered = 0;
  for (const { id } of stale) {
    await transaction(async (client) => {
      const locked = (await client.query(
        `SELECT id, category, city, status, customer_user_id
           FROM service_requests WHERE id = $1 FOR UPDATE`,
        [id],
      )) as { rows: Array<{
        id: string;
        category: string;
        city: string;
        status: string;
        customer_user_id: string | null;
      }> };
      const row = locked.rows[0];
      if (!row || row.status !== "matching") return;
      const hasPending = (await client.query(
        `SELECT 1 FROM dispatch_offers WHERE request_id = $1 AND status = 'pending' LIMIT 1`,
        [id],
      )) as { rows: Array<{ id: string }> };
      if (hasPending.rows.length > 0) return;
      const { fellBack } = await cascadeRequest(
        client,
        {
          id: row.id,
          category: row.category,
          city: row.city,
          status: row.status,
          customerUserId: row.customer_user_id,
        },
        "stuck_dispatch_recovery",
      );
      if (!fellBack) recovered += 1;
    });
  }
  return recovered;
}

/**
 * Waiting queue: re-offer `no_match` requests when availability returns
 * (Phase 5 requirement 9, Phase 11 queue behaviour). Bounded, throttled by
 * `last_dispatch_at`, and never touches cancelled/completed history.
 */
export async function sweepWaitingRequests(): Promise<{
  retried: number;
  matched: number;
}> {
  const retryMinutes = waitingRetryMinutes();
  const maxAgeHours = waitingMaxAgeHours();
  // COALESCE keeps legacy rows (created before migration 012, with a NULL
  // last_dispatch_at) sweepable without rewriting any existing data: their
  // creation time is the honest "last dispatch attempt" they had.
  const waiting = await query<{ id: string }>(
    `SELECT r.id
       FROM service_requests r
      WHERE r.status = 'no_match'
        AND COALESCE(r.last_dispatch_at, r.created_at) < NOW() - ($1::int * interval '1 minute')
        AND r.created_at > NOW() - ($2::int * interval '1 hour')
      ORDER BY r.updated_at ASC
      LIMIT 10`,
    [retryMinutes, maxAgeHours],
  );
  const result = { retried: 0, matched: 0 };
  for (const { id } of waiting) {
    const outcome = await retryDispatchForRequest(id, { id: null, role: "system" });
    if (outcome) {
      result.retried += 1;
      if (outcome.nextOffer) result.matched += 1;
    }
  }
  return result;
}

/**
 * Restore availability for a technician whose workload dropped below the
 * cap — but ONLY when the unavailability was set automatically. A
 * technician's own manual "unavailable" toggle is never overridden.
 */
export async function releaseTechnicianCapacity(
  client: { query: Function },
  technicianId: string,
): Promise<void> {
  await client.query(
    `UPDATE technicians
        SET availability_status = 'available', availability_auto = false, updated_at = NOW()
      WHERE id = $1
        AND availability_auto = true
        AND (
          SELECT COUNT(*)::int
            FROM dispatch_offers a
            JOIN service_requests r ON r.id = a.request_id
           WHERE a.technician_id = $1
             AND a.status = 'accepted'
             AND r.status IN ('matched', 'in_progress')
        ) < $2`,
    [technicianId, maxActiveAssignmentsPerTechnician()],
  );
}

/** The technician (if any) whose offer was accepted on a request. */
export async function acceptedTechnicianId(
  requestId: string,
): Promise<string | null> {
  const rows = await query<{ technician_id: string }>(
    `SELECT technician_id FROM dispatch_offers
      WHERE request_id = $1 AND status = 'accepted'
      ORDER BY updated_at DESC LIMIT 1`,
    [requestId],
  );
  return rows[0]?.technician_id ?? null;
}
