/**
 * Request status subscription (Task 22).
 *
 * Reads the customer's service request and its persisted offer ledger
 * through existing read-only endpoints:
 *
 *   GET /api/v1/requests/:id            (requestService → serviceRequestsApi)
 *   GET /api/v1/requests/:id/offers     (offersApi)
 *
 * and emits a `RequestUpdateEvent` when the request lifecycle status
 * or the offer ledger changes. Terminal request states end the
 * observation loop (matched / no_match / completed / cancelled).
 *
 * This layer only observes — it never mutates backend state, never
 * runs dispatch/scoring, and never renders notifications itself
 * (pages decide what is worth surfacing, deduplicated by the
 * notification store's entity+state keys).
 */
import { getRequestOffers, type PersistedOffer } from '@/lib/api/offersApi';
import { getServiceRequest } from '@/lib/services/requestService';
import type { ServiceRequestStatus } from '@/lib/types';
import { pollResource } from './poller';
import type {
  RealtimeSubscribeOptions,
  RealtimeSubscription,
  RequestSnapshot,
  RequestUpdateEvent,
  RequestUpdateListener,
} from './types';

/** Prototype polling interval: 4 s (inside the recommended 3–5 s band). */
export const DEFAULT_REQUEST_POLL_INTERVAL_MS = 4000;

/** Request states where customer-side observation is complete. */
const TERMINAL_REQUEST_STATUSES: readonly ServiceRequestStatus[] = [
  'matched',
  'no_match',
  'completed',
  'cancelled',
];

function offerSignature(offers: readonly PersistedOffer[]): string {
  return offers
    .map((offer) => `${offer.id}:${offer.status}:${offer.candidateIndex}:${offer.technicianId}`)
    .join('|');
}

function hasRequestSnapshotChanged(previous: RequestSnapshot, next: RequestSnapshot): boolean {
  return (
    previous.request.status !== next.request.status ||
    offerSignature(previous.offers) !== offerSignature(next.offers)
  );
}

function isRequestTerminal(snapshot: RequestSnapshot): boolean {
  return TERMINAL_REQUEST_STATUSES.includes(snapshot.request.status);
}

async function fetchRequestSnapshot(requestId: string): Promise<RequestSnapshot> {
  const request = await getServiceRequest(requestId);
  if (!request) {
    throw new Error(`Service request ${requestId} no longer exists.`);
  }
  const offers = await getRequestOffers(requestId);
  return { request, offers };
}

/**
 * Observe backend changes to one service request (by backend UUID).
 *
 * The first successful read is delivered as `baseline: true`
 * (pre-existing state — render it, do not notify). Every subsequent
 * event reports `statusChanged` / `offersChanged` relative to the
 * previous snapshot. Polling stops automatically at a terminal
 * request status; call `unsubscribe()` on unmount.
 */
export function subscribeToRequestUpdates(
  requestId: string,
  listener: RequestUpdateListener,
  options?: RealtimeSubscribeOptions,
): RealtimeSubscription {
  const intervalMs = options?.intervalMs ?? DEFAULT_REQUEST_POLL_INTERVAL_MS;
  let previous: RequestSnapshot | null = null;

  const unsubscribe = pollResource<RequestSnapshot>(
    `service-request:${requestId}`,
    {
      fetchSnapshot: () => fetchRequestSnapshot(requestId),
      hasChanged: hasRequestSnapshotChanged,
      isTerminal: isRequestTerminal,
    },
    (update) => {
      const snapshot = update.data;
      const statusChanged =
        snapshot !== null &&
        previous !== null &&
        previous.request.status !== snapshot.request.status;
      const offersChanged =
        snapshot !== null &&
        previous !== null &&
        offerSignature(previous.offers) !== offerSignature(snapshot.offers);
      if (snapshot !== null) previous = snapshot;

      const event: RequestUpdateEvent = {
        ...update,
        statusChanged,
        offersChanged,
      };
      listener(event);
    },
    intervalMs,
  );

  return { unsubscribe };
}
