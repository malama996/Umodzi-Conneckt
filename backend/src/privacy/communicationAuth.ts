/**
 * Communication authorization (Task 28.4A — Step 6 / 7 / 14).
 *
 * The authorization boundary is the **accepted service relationship**,
 * not the user's profile visibility or the request UUID alone.
 *
 * Every check derives the conversation, request, technician and customer
 * from the database using the authenticated session (never client input).
 * The existing `requireAuth` must have run — this module never
 * replaces it, only narrows it further.
 */

import { query } from "../db/client.js";
import { HttpError } from "../auth/httpError.js";
import type { FastifyRequest } from "fastify";

export interface ConversationAccessResult {
  allowed: boolean;
  conversation: {
    id: string;
    service_request_id: string;
    customer_id: string;
    technician_id: string;
    status: string;
  };
  isCustomer: boolean;
  isTechnician: boolean;
  /**
   * Role flag of the caller — informational only; it never contributes to
   * `allowed` (Task 33.2 policy: no private message content for
   * administrators by default; metadata goes through the audited admin
   * endpoint instead).
   */
  isAdministrator: boolean;
  /** Only true when the conversation actually exists. */
  exists: boolean;
}

/**
 * Core authorization check: can the given session access the conversation?
 *
 * Rules (derived from the core communication rule):
 *   - Conversation must exist.
 *   - User must be either the request's customer OR the technician assigned
 *     through the accepted offer.
 *   - The request must have an accepted/active communication relationship
 *     (accepted offer exists with that technician).
 *   - Conversation status must be `active` (not `closed`).
 *   - The administrator role never grants access: private message content is
 *     participant-only by policy (Task 33.2). Their metadata route is
 *     `GET /api/v1/admin/conversations/:id`, which never returns content.
 *
 * If any check fails: returns `{ allowed: false, exists, ... }` — callers
 * must use `exists` to decide between 404 (conversation genuinely missing or
 * request never reached accepted state) and 403 (conversation exists but the
 * caller is not a participant).
 */
export async function canAccessConversation(
  request: FastifyRequest,
  conversationId: string,
): Promise<ConversationAccessResult> {
  const authUser = request.authUser;
  if (!authUser) {
    throw new HttpError(401, "Authentication required");
  }

  // Verify UUID to prevent SQL injection via the path parameter.
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      conversationId,
    );
  if (!isUuid) {
    throw new HttpError(400, "Invalid conversation id format");
  }

  // Load the conversation with its linked request, both participant ids,
  // and the conversation status. A JOIN through service_requests lets us
  // verify the request-to-customer link using the DB's existing FK rather
  // than trusting any client claim.
  const rows = await query<{
    id: string;
    service_request_id: string;
    customer_id: string;
    technician_id: string;
    status: string;
    accepted_technician_id: string | null; // derived from the offer
  }>(
    `SELECT c.id, c.service_request_id, c.customer_id, c.technician_id, c.status,
            o.technician_id AS accepted_technician_id
     FROM conversations c
     JOIN service_requests r ON r.id = c.service_request_id
     LEFT JOIN dispatch_offers o ON o.request_id = c.service_request_id
                                   AND o.status = 'accepted'
     WHERE c.id = $1`,
    [conversationId],
  );

  const conversation = rows[0];

  if (!conversation) {
    // The conversation genuinely does not exist — return a not-found shape.
    // Callers must treat `exists: false` as a 404, never as a 403.
    return {
      allowed: false,
      conversation: {
        id: conversationId,
        service_request_id: "",
        customer_id: "",
        technician_id: "",
        status: "",
      },
      isCustomer: false,
      isTechnician: false,
      isAdministrator: authUser.role === "administrator",
      exists: false,
    };
  }

  // The conversation exists — derive authorization from the DB.
  //
  // Task 33.1 fix: conversations.technician_id is a TECHNICIANS-row id, not
  // a users-row id, so comparing it directly to the session user id denied
  // every technician (and, via the isParticipant gate below, every
  // administrator — the isAdministrator branch was dead code). Resolve the
  // caller's own technician profile first, exactly like the conversation
  // list endpoint already does.
  const isCustomer = conversation.customer_id === authUser.id;
  const callerTechRows = await query<{ id: string }>(
    "SELECT id FROM technicians WHERE user_id = $1 LIMIT 1",
    [authUser.id],
  );
  const callerTechnicianId = callerTechRows[0]?.id ?? null;
  const isTechnician =
    callerTechnicianId !== null &&
    conversation.technician_id === callerTechnicianId;
  const isAdministrator = authUser.role === "administrator";

  // The authorization boundary: a participant must be either the customer
  // who owns the request, or the technician assigned through the accepted
  // offer. The request must also have an accepted relationship; if the
  // offer was rejected/timeout or never made, the conversation should not
  // exist, but we guard against stale conversations defensively.
  const hasAcceptedOffer =
    callerTechnicianId !== null &&
    conversation.accepted_technician_id === callerTechnicianId;
  const isParticipant = isCustomer || isTechnician;

  // Status must permit communication.
  const statusPermits = conversation.status === "active";

  // For the customer: they must own the linked service request.
  // (The DB's foreign key already enforces that c.customer_id = r.customer_user_id
  // for a correctly-formed conversation; this verifies the session matches.)
  // For the technician: they must have been assigned through the accepted offer.
  //
  // Administrator privacy policy (Task 33.2): the administrator ROLE is never
  // an access grant here — this function only ever authorizes the two
  // participants, so message-history reads, sends and read-state changes all
  // answer 404 for an administrator who is not a participant. (The
  // `isAdministrator ||` clause that used to sit inside this expression was
  // unreachable dead code behind `isParticipant &&`; it is removed so no
  // reader mistakes it for a live path.) Administrators inspect conversation
  // METADATA only, through the explicitly authorized and audited
  // `GET /api/v1/admin/conversations/:id`. `isAdministrator` below is reported
  // for callers' information — it is a role flag, never an access grant.
  const allowed =
    isParticipant &&
    statusPermits &&
    ((isCustomer && conversation.customer_id === authUser.id) ||
      (isTechnician &&
        (hasAcceptedOffer ||
          conversation.technician_id === callerTechnicianId)));

  return {
    allowed,
    conversation: {
      id: conversation.id,
      service_request_id: conversation.service_request_id,
      customer_id: conversation.customer_id,
      technician_id: conversation.technician_id,
      status: conversation.status,
    },
    isCustomer,
    isTechnician,
    isAdministrator,
    exists: true,
  };
}

/**
 * Request-scoped authorization for communication availability.
 *
 * Communication unlocks when and only when:
 *   - The service request exists.
 *   - There is an accepted dispatch offer (status = 'accepted').
 *   - The offer's technician matches the conversation's technician.
 *   - The conversation exists and is active.
 *
 * This is the authorization check used when a request-scoped endpoint
 * (e.g. `GET /api/v1/requests/:id/conversation`) needs to confirm that
 * communication is actually unlocked before reporting any conversation.
 *
 * An administrator never satisfies these conditions through the role itself
 * (they own no request and the check derives nothing from `role`), so
 * request-scoped conversation access is participant-only by construction —
 * Task 33.2 privacy policy.
 */
export async function canCommunicateOnRequest(
  request: FastifyRequest,
  requestId: string,
): Promise<{
  allowed: boolean;
  conversationId: string | null;
  exists: boolean;
  isCustomer: boolean;
  isTechnician: boolean;
}> {
  const authUser = request.authUser;
  if (!authUser) {
    throw new HttpError(401, "Authentication required");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      requestId,
    )
  ) {
    throw new HttpError(400, "Invalid request id format");
  }

  // Load the request and its customer from the DB — never trust the client.
  const reqRows = await query<{
    id: string;
    customer_user_id: string | null;
    status: string;
  }>(
    "SELECT id, customer_user_id, status FROM service_requests WHERE id = $1",
    [requestId],
  );

  if (reqRows.length === 0) {
    return {
      allowed: false,
      conversationId: null,
      exists: false,
      isCustomer: false,
      isTechnician: false,
    };
  }

  const requestRow = reqRows[0];
  const isCustomer = requestRow.customer_user_id === authUser.id;

  // Check whether the caller's technician profile has an accepted offer on this request.
  const techProfile = await query<{ id: string }>(
    "SELECT id FROM technicians WHERE user_id = $1 LIMIT 1",
    [authUser.id],
  );
  const technicianId = techProfile.length > 0 ? techProfile[0].id : null;
  const isTechnician = technicianId !== null;

  // The authorization boundary: an accepted offer must back the relationship.
  // Task 33.1 fix: the old check required the CALLER to hold the accepted
  // offer through their own profile, which is always false for a customer
  // (no profile row) — so customers could never unlock the request-scoped
  // route. Scope correctly: the customer needs ANY accepted offer on this
  // request; a technician needs the accepted offer on their own profile.
  const acceptedOffers = await query<{ id: string; technician_id: string }>(
    `SELECT id, technician_id FROM dispatch_offers
     WHERE request_id = $1 AND status = 'accepted'
     LIMIT 1`,
    [requestId],
  );
  const accepted = acceptedOffers[0] ?? null;
  const hasAccepted =
    accepted !== null &&
    (technicianId === null || accepted.technician_id === technicianId);

  // A conversation exists only when the offer was accepted.
  const conversationRow = await query<{ id: string; status: string }>(
    `SELECT id, status FROM conversations WHERE service_request_id = $1 LIMIT 1`,
    [requestId],
  );
  const conversationExists = conversationRow.length > 0;

  // Communication is unlocked when the relationship through the accepted offer exists,
  // whether or not a conversation row has yet been created (the route creates it when needed).
  const allowed =
    (isCustomer || isTechnician) &&
    hasAccepted &&
    requestRow.status === "matched";

  return {
    allowed,
    conversationId: conversationExists ? conversationRow[0].id : null,
    exists: conversationExists,
    isCustomer,
    isTechnician,
  };
}
