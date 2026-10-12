/**
 * Technician offer subscription (Task 22).
 *
 * Reads the raw backend offer rows for one technician through the
 * existing read-only endpoint:
 *
 *   GET /api/v1/offers/technician/:technicianId   (offersApi)
 *
 * and emits an `OfferUpdateEvent` when rows appear or an existing
 * row's status changes (pending → accepted / rejected / timed_out).
 * Rows are compared by their backend database id — no offers are
 * created, invented, or re-keyed locally, and technician identity is
 * always the backend UUID.
 *
 * The offer list is never terminal: new offers can arrive at any
 * time, so observation runs until `unsubscribe()` (page unmount).
 * Pages hydrate display views via the technician offer service when
 * this layer reports a change; this layer itself stays read-only.
 */
import { getTechnicianOffers, type PersistedOffer } from '@/lib/api/offersApi';
import { pollResource } from './poller';
import type {
  OfferRowChange,
  OfferUpdateEvent,
  OfferUpdateListener,
  RealtimeSubscribeOptions,
  RealtimeSubscription,
} from './types';

/** Prototype polling interval: 4 s (inside the recommended 3–5 s band). */
export const DEFAULT_OFFER_POLL_INTERVAL_MS = 4000;

function offerRowsSignature(rows: readonly PersistedOffer[]): string {
  return rows.map((row) => `${row.id}:${row.status}:${row.candidateIndex}`).join('|');
}

function hasOfferRowsChanged(previous: readonly PersistedOffer[], next: PersistedOffer[]): boolean {
  return offerRowsSignature(previous) !== offerRowsSignature(next);
}

function toRowChanges(previous: PersistedOffer[], next: PersistedOffer[]): OfferRowChange[] {
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const changes: OfferRowChange[] = [];
  for (const row of next) {
    const before = previousById.get(row.id);
    if (before !== undefined && before.status !== row.status) {
      changes.push({
        offerId: row.id,
        requestId: row.requestId,
        previous: before.status,
        next: row.status,
      });
    }
  }
  return changes;
}

/**
 * Observe backend changes to one technician's offers (by backend UUID).
 *
 * The first successful read is the `baseline` (pre-existing rows —
 * render, do not notify). Later events report `added` rows and
 * `changed` status transitions. Call `unsubscribe()` on unmount.
 */
export function subscribeToOfferUpdates(
  technicianId: string,
  listener: OfferUpdateListener,
  options?: RealtimeSubscribeOptions,
): RealtimeSubscription {
  const intervalMs = options?.intervalMs ?? DEFAULT_OFFER_POLL_INTERVAL_MS;
  let previous: PersistedOffer[] | null = null;

  const unsubscribe = pollResource<PersistedOffer[]>(
    `technician-offers:${technicianId}`,
    {
      fetchSnapshot: () => getTechnicianOffers(technicianId),
      hasChanged: hasOfferRowsChanged,
    },
    (update) => {
      const snapshot = update.data;
      const before = previous;
      const added =
        snapshot !== null && before !== null
          ? snapshot.filter((row) => !before.some((old) => old.id === row.id))
          : [];
      const statusChanges =
        snapshot !== null && before !== null ? toRowChanges(before, snapshot) : [];
      if (snapshot !== null) previous = [...snapshot];

      const event: OfferUpdateEvent = { ...update, added, statusChanges };
      listener(event);
    },
    intervalMs,
  );

  return { unsubscribe };
}
