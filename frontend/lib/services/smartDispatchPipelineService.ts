import { dispatchServiceRequest } from '@/lib/services/smartDispatchService';
import { advanceOffer, createInitialOffer } from '@/lib/services/cascadingOfferService';
import {
  applyCascadingOutcome,
  beginDispatching,
} from '@/lib/services/serviceRequestLifecycleService';
import type {
  DispatchOffer,
  DispatchOfferStatus,
  ServiceRequest,
  SmartDispatchResult,
} from '@/lib/types';

/**
 * Smart Dispatch Pipeline Service (V0.2).
 *
 * Orchestrates the existing service-layer components into one coherent
 * domain workflow. Does NOT reimplement eligibility, ranking, cascading,
 * or lifecycle logic — it delegates entirely to the existing services.
 *
 * Architecture:
 *   ServiceRequest
 *     → dispatchServiceRequest()         [eligibility + ranking]
 *     → beginDispatching()               [lifecycle: pending → matching]
 *     → createInitialOffer()            [cascading: first offer]
 *     → advanceOffer()                   [cascading: reject/timeout → next]
 *     → applyCascadingOutcome()         [lifecycle: matched/no_match]
 *
 * No UI, no backend, no notifications, no timers, no real communication.
 * The pipeline models domain state only.
 */

/**
 * Result of a smart dispatch pipeline run.
 */
export interface SmartDispatchPipelineResult {
  request: ServiceRequest;
  dispatch: SmartDispatchResult;
  offer: DispatchOffer | null;
  status: 'matched' | 'no_match';
}

/**
 * Run the smart dispatch pipeline for a service request.
 *
 * Coordinates: eligibility → ranking → lifecycle → initial offer → cascading → final lifecycle.
 *
 * Async only because technician retrieval hits the backend API —
 * every domain step (eligibility, scoring, ranking, cascading,
 * lifecycle) remains synchronous and deterministic.
 *
 * @param request - The service request to dispatch (must be in 'pending' status)
 * @param outcomes - Optional sequence of offer outcomes to simulate. Each entry is
 *   'accepted', 'rejected', or 'timed_out'. If omitted, the pipeline stops after
 *   creating the initial offer (status remains 'matching', offer remains 'pending').
 *
 * @returns The final pipeline result with updated request, dispatch result, and current offer.
 *
 * Does NOT mutate the original request or technician data.
 * Does NOT send real notifications or contact technicians.
 * Does NOT use timers.
 */
export async function runSmartDispatchPipeline(
  request: ServiceRequest,
  outcomes: DispatchOfferStatus[] = [],
): Promise<SmartDispatchPipelineResult> {
  // Step 1: Smart Dispatch Orchestration (eligibility + ranking)
  const dispatch: SmartDispatchResult = await dispatchServiceRequest(request);

  // Step 2: No eligible technicians → no_match
  if (dispatch.status === 'no_match' || dispatch.candidates.length === 0) {
    const noMatchRequest = applyCascadingOutcome(beginDispatching(request), {
      status: 'exhausted',
      offer: null,
    });
    return {
      request: noMatchRequest,
      dispatch,
      offer: null,
      status: 'no_match',
    };
  }

  // Step 3: Begin dispatching (lifecycle: pending → matching)
  const dispatchingRequest = beginDispatching(request);

  // Step 4: Create initial offer (candidate #0)
  let cascadingResult = createInitialOffer(dispatch);

  // Step 5: Process outcome sequence through cascading
  for (const outcome of outcomes) {
    if (cascadingResult.status === 'accepted' || cascadingResult.status === 'exhausted') {
      break; // cascade already resolved
    }

    const currentOffer = cascadingResult.offer;
    if (!currentOffer) break;

    // Apply the outcome to the current offer
    const updatedOffer: DispatchOffer = { ...currentOffer, status: outcome };

    // Advance the cascade
    cascadingResult = advanceOffer(dispatch, updatedOffer);
  }

  // Step 6: Apply final lifecycle transition
  const finalRequest = applyCascadingOutcome(dispatchingRequest, cascadingResult);

  return {
    request: finalRequest,
    dispatch,
    offer: cascadingResult.offer,
    status:
      cascadingResult.status === 'accepted'
        ? 'matched'
        : cascadingResult.status === 'exhausted'
          ? 'no_match'
          : 'matched', // offering with candidates = still dispatching, but dispatch result is 'matched'
  };
}
