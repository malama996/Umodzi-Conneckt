import type { CascadingOfferResult, ServiceRequest, ServiceRequestStatus } from '@/lib/types';

/**
 * Service Request lifecycle transition service (V0.2).
 *
 * Applies explicit lifecycle transitions based on dispatch/offer outcomes.
 * Pure service-layer — no UI, no backend, no notifications, no timers.
 *
 * Valid transitions:
 *   pending → matching        (dispatching begins)
 *   matching → matched        (technician accepts)
 *   matching → no_match       (cascading exhausted)
 *
 * Terminal states: matched, no_match, completed, cancelled.
 * Invalid transitions throw an Error with a clear message.
 *
 * Architecture:
 *   SmartDispatchResult → CascadingOfferResult → LifecycleService → Updated ServiceRequest
 */

/**
 * Error thrown when an invalid lifecycle transition is attempted.
 */
export class InvalidLifecycleTransitionError extends Error {
  constructor(
    public readonly from: ServiceRequestStatus,
    public readonly to: ServiceRequestStatus,
  ) {
    super(`Invalid lifecycle transition: '${from}' → '${to}'`);
    this.name = 'InvalidLifecycleTransitionError';
  }
}

/**
 * Check whether a status is terminal (no outgoing transitions allowed).
 */
function isTerminalStatus(status: ServiceRequestStatus): boolean {
  return (
    status === 'matched' ||
    status === 'no_match' ||
    status === 'completed' ||
    status === 'cancelled'
  );
}

/**
 * Validate that a transition from one status to another is allowed.
 * Throws InvalidLifecycleTransitionError for invalid transitions.
 */
function validateTransition(from: ServiceRequestStatus, to: ServiceRequestStatus): void {
  if (from === to) {
    return; // no-op transitions are allowed
  }

  if (isTerminalStatus(from)) {
    throw new InvalidLifecycleTransitionError(from, to);
  }

  const validTransitions: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
    pending: ['matching'],
    matching: ['matched', 'no_match'],
    matched: [],
    no_match: [],
    in_progress: [],
    completed: [],
    cancelled: [],
  };

  if (!validTransitions[from].includes(to)) {
    throw new InvalidLifecycleTransitionError(from, to);
  }
}

/**
 * Transition a service request to a new status.
 * Returns a new request object; never mutates the original.
 * Throws InvalidLifecycleTransitionError for invalid transitions.
 */
export function transitionServiceRequest(
  request: ServiceRequest,
  newStatus: ServiceRequestStatus,
): ServiceRequest {
  validateTransition(request.status, newStatus);

  return {
    ...request,
    status: newStatus,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Begin dispatching: transition from pending to matching.
 * Throws if the request is not in pending status.
 */
export function beginDispatching(request: ServiceRequest): ServiceRequest {
  return transitionServiceRequest(request, 'matching');
}

/**
 * Mark as matched: transition from matching to matched.
 * Throws if the request is not in matching status.
 */
export function markMatched(request: ServiceRequest): ServiceRequest {
  return transitionServiceRequest(request, 'matched');
}

/**
 * Mark as no-match: transition from matching to no_match.
 * Throws if the request is not in matching status.
 */
export function markNoMatch(request: ServiceRequest): ServiceRequest {
  return transitionServiceRequest(request, 'no_match');
}

/**
 * Apply a cascading offer outcome to the request lifecycle.
 *
 * - accepted: transition matching → matched
 * - exhausted: transition matching → no_match
 * - offering (rejection/timeout with more candidates): no transition (stays matching)
 *
 * Returns the updated request (or original if no transition needed).
 * Never mutates the original request.
 */
export function applyCascadingOutcome(
  request: ServiceRequest,
  outcome: CascadingOfferResult,
): ServiceRequest {
  if (outcome.status === 'accepted') {
    return markMatched(request);
  }

  if (outcome.status === 'exhausted') {
    return markNoMatch(request);
  }

  // 'offering' means rejection/timeout with more candidates remaining —
  // the request stays in matching (dispatching) state.
  return request;
}
