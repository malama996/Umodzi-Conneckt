import { getServiceRequest } from '@/lib/services/requestService';
import {
  acceptOffer,
  getRequestOffers,
  getTechnicianOffers as fetchTechnicianOffers,
  rejectOffer,
  timeoutOffer,
} from '@/lib/api/offersApi';
import type { DispatchOffer, DispatchOfferStatus, ServiceRequest } from '@/lib/types';

/**
 * Technician offer service (Task 21B; rewritten in Task 36, Stage 4).
 *
 * Application-level boundary for the technician-side offer experience.
 * Persistence is backend-authoritative (PostgreSQL via the offers API) —
 * there is no localStorage ledger.
 *
 * Task 36 (Stage 4): dispatch is SERVER-authoritative. The retired browser
 * cascade (re-running the Smart Dispatch pipeline client-side, creating the
 * next candidate's offer row, PATCHing matched/no_match onto the request) is
 * GONE: a response is now ONE outcome endpoint call, and the backend
 * transaction resolves the offer, advances dispatch to the next ranked
 * candidate, falls back to `no_match` honestly, or completes the assignment.
 * Closing this tab can no longer strand a request in `matching`, and a
 * browser can no longer fabricate dispatch decisions.
 *
 * Architecture:
 *   Technician view    → getTechnicianOffers()   (GET offers + requests)
 *   Technician response → accept/reject/timeout  (POST outcome, then re-fetch
 *     the owner-scoped request for the honest post-outcome state)
 */

/** A pending technician offer, as presented to a technician. */
export interface TechnicianOfferView {
  /** The full service request being offered (hydrated from the backend). */
  request: ServiceRequest;
  /** The current pending dispatch offer. */
  offer: DispatchOffer;
  /**
   * Backend offer row id — the target of the outcome endpoints. The old
   * client pipeline identified offers by technician name; under a
   * server-authoritative dispatch the row id is the only unambiguous key.
   */
  offerId: string;
  /** Total offer rows recorded for this request's dispatch history. */
  totalCandidates: number;
}

/**
 * What actually happened after a response, as the backend reports it —
 * no client-side lifecycle simulation.
 */
export interface TechnicianOfferResponse {
  requestId: string;
  /**
   * The request's status AFTER the backend processed the outcome:
   * 'matched' (offer accepted), 'no_match' (all candidates exhausted),
   * or 'matching' (dispatch advanced to the next ranked candidate).
   */
  requestStatus: ServiceRequest['status'];
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
      offerId: row.id,
      totalCandidates: siblings.length,
    });
  }
  return views;
}

/**
 * Apply an explicit technician response to a pending offer.
 * ONE backend call resolves the offer inside a server transaction; the
 * backend alone advances dispatch. The request is then re-fetched so the
 * caller sees the REAL post-outcome state — a failed re-fetch is an error,
 * never a fabricated status.
 */
export async function respondToTechnicianOffer(
  offerId: string,
  outcome: Exclude<DispatchOfferStatus, 'pending'>,
): Promise<TechnicianOfferResponse> {
  const resolved =
    outcome === 'accepted'
      ? await acceptOffer(offerId)
      : outcome === 'rejected'
        ? await rejectOffer(offerId)
        : await timeoutOffer(offerId);

  const request = await getServiceRequest(resolved.requestId);
  if (!request) {
    throw new Error(
      `Service request ${resolved.requestId} could not be loaded after the offer response.`,
    );
  }
  return { requestId: request.id, requestStatus: request.status };
}

/** Technician accepts the pending offer — the server completes the assignment. */
export function acceptTechnicianOffer(offerId: string): Promise<TechnicianOfferResponse> {
  return respondToTechnicianOffer(offerId, 'accepted');
}

/** Technician declines — the server offers the next ranked candidate. */
export function rejectTechnicianOffer(offerId: string): Promise<TechnicianOfferResponse> {
  return respondToTechnicianOffer(offerId, 'rejected');
}

/**
 * Explicit prototype-only simulation of a response timeout.
 * Uses the existing 'timed_out' domain outcome — no timers.
 */
export function simulateTechnicianTimeout(offerId: string): Promise<TechnicianOfferResponse> {
  return respondToTechnicianOffer(offerId, 'timed_out');
}
