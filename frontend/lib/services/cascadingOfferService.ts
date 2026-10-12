import type {
  CascadingOfferResult,
  DispatchOffer,
  RankedTechnician,
  SmartDispatchResult,
} from '@/lib/types';

/**
 * Cascading technician offer service (V0.2).
 *
 * Models the process of offering a service request to technicians one
 * candidate at a time, in ranked order. This is a pure service-layer
 * domain model — no timers, no notifications, no backend, no UI.
 *
 * Flow:
 *   Ranked #1 → Accept (stop) | Reject/Timeout (next)
 *   Ranked #2 → Accept (stop) | Reject/Timeout (next)
 *   ...
 *   Exhausted → no candidates remaining
 *
 * The ranked order from Task 12 is authoritative. Candidates are never
 * skipped, reordered, or revisited.
 */

/**
 * Create the initial offer for a dispatch result.
 * Offers the first-ranked candidate (index 0).
 * Returns exhausted if there are no candidates or the dispatch was no_match.
 */
export function createInitialOffer(dispatchResult: SmartDispatchResult): CascadingOfferResult {
  if (dispatchResult.status === 'no_match' || dispatchResult.candidates.length === 0) {
    return { status: 'exhausted', offer: null };
  }

  const first: RankedTechnician = dispatchResult.candidates[0];
  const offer: DispatchOffer = {
    requestId: dispatchResult.requestId,
    technicianId: first.technician.name,
    candidateIndex: 0,
    status: 'pending',
  };

  return { status: 'offering', offer };
}

/**
 * Advance the cascading offer based on the current offer's outcome.
 *
 * - accepted: stop cascading, return the accepted offer
 * - rejected/timed_out: advance to the next ranked candidate
 * - no next candidate: return exhausted
 *
 * Does NOT mutate the dispatch result or candidates.
 * Does NOT change the ServiceRequest status.
 * Does NOT use real timers — 'timed_out' is a domain state only.
 */
export function advanceOffer(
  dispatchResult: SmartDispatchResult,
  currentOffer: DispatchOffer,
): CascadingOfferResult {
  // Accepted: stop cascading
  if (currentOffer.status === 'accepted') {
    return { status: 'accepted', offer: currentOffer };
  }

  // Rejected or timed out: advance to next candidate
  if (currentOffer.status === 'rejected' || currentOffer.status === 'timed_out') {
    const nextIndex = currentOffer.candidateIndex + 1;

    if (nextIndex >= dispatchResult.candidates.length) {
      return { status: 'exhausted', offer: null };
    }

    const next: RankedTechnician = dispatchResult.candidates[nextIndex];
    const nextOffer: DispatchOffer = {
      requestId: dispatchResult.requestId,
      technicianId: next.technician.name,
      candidateIndex: nextIndex,
      status: 'pending',
    };

    return { status: 'offering', offer: nextOffer };
  }

  // Pending offer cannot advance — return as-is
  return { status: 'offering', offer: currentOffer };
}
