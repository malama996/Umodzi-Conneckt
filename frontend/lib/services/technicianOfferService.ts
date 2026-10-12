import {
  executeSmartDispatch,
  type SmartDispatchPipelineResult,
} from '@/lib/services/matchingService';
import { getServiceRequest, updateServiceRequestStatus } from '@/lib/services/requestService';
import {
  acceptOffer,
  createOffer,
  getRequestOffers,
  getTechnicianOffers as fetchTechnicianOffers,
  rejectOffer,
  timeoutOffer,
  type PersistedOffer,
} from '@/lib/api/offersApi';
import type { DispatchOffer, DispatchOfferStatus, ServiceRequest } from '@/lib/types';

/**
 * Technician offer service (Task 21B).
 *
 * Application-level boundary for the technician-side offer experience.
 * Persistence is backend-authoritative (PostgreSQL via the offers API) —
 * there is no localStorage ledger. ALL dispatch, cascading, ranking,
 * and lifecycle behaviour is still derived by re-running the existing
 * Smart Dispatch pipeline via executeSmartDispatch() — this service
 * implements no eligibility, scoring, ranking, candidate selection,
 * offer advancement, or lifecycle rules of its own.
 *
 * Architecture:
 *   Customer dispatch → recordDispatchedOffer()   (POST /api/v1/offers)
 *   Technician view  → getTechnicianOffers()      (GET offers + requests)
 *   Technician response → accept/reject/timeout  (POST outcome, then
 *     advance: POST next offer or PATCH request matched/no_match)
 *
 * No real-time communication, no notifications, no timers —
 * 'timed_out' is an explicit domain outcome only.
 */

/**
 * A pending technician offer, as presented to a technician.
 * Contains only existing domain fields — no invented data.
 */
export interface TechnicianOfferView {
  /** The full service request being offered (hydrated from the backend). */
  request: ServiceRequest;
  /** The current pending dispatch offer. */
  offer: DispatchOffer;
  /** Total ranked candidates in the dispatch result. */
  totalCandidates: number;
}

/**
 * Outcome history for a request, derived from its persisted offer rows
 * (oldest candidate first). The trailing 'pending' row represents the
 * unresolved current offer — it is NOT an outcome, so it is excluded:
 * the pipeline derives the current offer from the resolved history.
 */
function toOutcomeHistory(rows: PersistedOffer[]): DispatchOfferStatus[] {
  return rows.filter((row) => row.status !== 'pending').map((row) => row.status);
}

/**
 * Record a dispatched service request so the ranked technician can
 * see the pending offer. Runs the existing Smart Dispatch pipeline to
 * determine the first candidate — no offer is constructed here.
 * Idempotent per request (an existing candidate-0 row is returned).
 * Returns null when no technician was matched.
 *
 * Throws when the candidate has no backend id or when persistence fails
 * — a failed mutation is never presented as successfully persisted.
 */
export async function recordDispatchedOffer(
  request: ServiceRequest,
): Promise<PersistedOffer | null> {
  const result = await executeSmartDispatch(request, []);
  if (result.offer === null) {
    return null; // no eligible technician — nothing to offer
  }

  const existing = await getRequestOffers(request.id);
  const first = existing.find((row) => row.candidateIndex === 0);
  if (first) {
    return first;
  }

  const candidate = result.dispatch.candidates[result.offer.candidateIndex];
  const technicianId = candidate?.technician.id;
  if (!technicianId) {
    throw new Error(
      `Cannot persist offer: technician ${result.offer.technicianId} has no backend id.`,
    );
  }

  return createOffer({
    requestId: request.id,
    technicianId,
    candidateIndex: result.offer.candidateIndex,
    status: 'pending',
  });
}

/**
 * List the pending offers addressed to a technician (by backend id).
 * Each offer's request is hydrated from the backend — no request
 * fields are invented. Throws when the backend is unreachable or
 * when an offer references a request that no longer exists.
 */
export async function getTechnicianOffers(technicianId: string): Promise<TechnicianOfferView[]> {
  const rows = await fetchTechnicianOffers(technicianId);
  const pending = rows.filter((row) => row.status === 'pending');

  const views: TechnicianOfferView[] = [];
  for (const row of pending) {
    const request = await getServiceRequest(row.requestId);
    if (!request) {
      throw new Error(`Offer ${row.id} references a service request that no longer exists.`);
    }
    const siblings = await getRequestOffers(row.requestId);
    views.push({
      request,
      offer: {
        requestId: row.requestId,
        technicianId: row.technicianId,
        candidateIndex: row.candidateIndex,
        status: row.status,
      },
      totalCandidates: siblings.length,
    });
  }
  return views;
}

/**
 * Apply an explicit technician response to a pending offer.
 * Delegates the cascade/lifecycle decision entirely to the existing
 * Smart Dispatch pipeline (re-run over the persisted outcome history),
 * then persists the consequence: the outcome on the pending row plus
 * either the next candidate's offer row or the terminal request status.
 *
 * Throws Error when the request does not exist, has no pending offer,
 * is no longer awaiting a response, or the current offer does not
 * target the given technician. On persistence failure the error
 * propagates and the UI must keep its previous valid state.
 */
export async function respondToTechnicianOffer(
  technicianName: string,
  requestId: string,
  outcome: DispatchOfferStatus,
): Promise<SmartDispatchPipelineResult> {
  if (outcome === 'pending') {
    throw new Error("Invalid technician response: 'pending' is not an offer outcome.");
  }

  const request = await getServiceRequest(requestId);
  if (!request) {
    throw new Error(`Service request ${requestId} not found.`);
  }

  const rows = await getRequestOffers(requestId);
  const current = await executeSmartDispatch(request, toOutcomeHistory(rows));

  if (current.request.status !== 'matching') {
    throw new Error(`Request ${requestId} is no longer awaiting a technician response.`);
  }
  if (current.offer === null || current.offer.technicianId !== technicianName) {
    throw new Error(`No pending offer for ${technicianName} on request ${requestId}.`);
  }

  const pendingRow = rows.find((row) => row.status === 'pending');
  if (!pendingRow || pendingRow.candidateIndex !== current.offer.candidateIndex) {
    throw new Error(`No pending offer row for request ${requestId}.`);
  }

  // Persist the outcome on the pending row first.
  if (outcome === 'accepted') {
    await acceptOffer(pendingRow.id);
  } else if (outcome === 'rejected') {
    await rejectOffer(pendingRow.id);
  } else {
    await timeoutOffer(pendingRow.id);
  }

  // Delegate to the existing Smart Dispatch pipeline —
  // no ranking, cascading, or lifecycle logic is duplicated.
  const nextOutcomes = [...toOutcomeHistory(rows), outcome];
  const result = await executeSmartDispatch(request, nextOutcomes);

  if (result.request.status !== 'matching') {
    // Terminal: persist matched / no_match on the request.
    await updateServiceRequestStatus(requestId, result.request.status);
  } else if (result.offer !== null) {
    // Cascade advanced: persist the next candidate's pending offer.
    const nextCandidate = result.dispatch.candidates[result.offer.candidateIndex];
    const nextTechnicianId = nextCandidate?.technician.id;
    if (!nextTechnicianId) {
      throw new Error(
        `Cannot persist offer: technician ${result.offer.technicianId} has no backend id.`,
      );
    }
    await createOffer({
      requestId,
      technicianId: nextTechnicianId,
      candidateIndex: result.offer.candidateIndex,
      status: 'pending',
    });
  }

  return result;
}

/** Technician accepts the pending offer (request → matched). */
export async function acceptTechnicianOffer(
  technicianName: string,
  requestId: string,
): Promise<SmartDispatchPipelineResult> {
  return respondToTechnicianOffer(technicianName, requestId, 'accepted');
}

/** Technician rejects the pending offer (cascade advances). */
export async function rejectTechnicianOffer(
  technicianName: string,
  requestId: string,
): Promise<SmartDispatchPipelineResult> {
  return respondToTechnicianOffer(technicianName, requestId, 'rejected');
}

/**
 * Explicit prototype-only simulation of a response timeout.
 * Uses the existing 'timed_out' domain outcome — no timers.
 */
export async function simulateTechnicianTimeout(
  technicianName: string,
  requestId: string,
): Promise<SmartDispatchPipelineResult> {
  return respondToTechnicianOffer(technicianName, requestId, 'timed_out');
}
