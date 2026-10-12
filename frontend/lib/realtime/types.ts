/**
 * Realtime update abstraction types (Task 22).
 *
 * The UI observes backend state through these events only; the
 * transport (short-interval polling of the existing read-only GET
 * endpoints) lives inside lib/realtime and can later be swapped for
 * SSE/WebSockets without touching any UI component.
 *
 * The backend database remains the sole source of truth: an event
 * merely reports what a fresh backend read returned — it never
 * carries a locally invented or mutated state.
 */
import type { DispatchOfferStatus, ServiceRequest } from '@/lib/types';
import type { PersistedOffer } from '@/lib/api/offersApi';

/** Connection/update state surfaced to the UI as a non-destructive note. */
export type ConnectionStatus = 'connecting' | 'live' | 'error' | 'stopped';

/** Handle returned by every subscription. Always call on unmount. */
export interface RealtimeSubscription {
  unsubscribe(): void;
}

/** Common shape of every realtime event. */
export interface RealtimeUpdate<T> {
  /**
   * Latest known-good data. On a failed refresh this is the last
   * successful snapshot (or null when none exists yet) — a failure
   * NEVER fabricates or advances state.
   */
  data: T | null;
  /** True when the snapshot differs from the previous successful one. */
  changed: boolean;
  /**
   * True only for the first successful snapshot of a subscription.
   * Baseline reflects pre-existing backend state: it renders, but it
   * is not a new event and must not raise notifications.
   */
  baseline: boolean;
  /** Non-destructive connection indicator for the UI. */
  connection: ConnectionStatus;
  /** Failure detail when connection === 'error'; empty otherwise. */
  error: string;
}

/** Options accepted by every subscribe function. */
export interface RealtimeSubscribeOptions {
  /**
   * Polling interval in milliseconds (prototype default: 4000, within
   * the recommended 3–5 s band). Exposed so focused tests can run the
   * same code path quickly; UI code always uses the default.
   */
  intervalMs?: number;
}

/** One request-focused snapshot: the request row + its offer ledger. */
export interface RequestSnapshot {
  request: ServiceRequest;
  offers: PersistedOffer[];
}

/** Event emitted by subscribeToRequestUpdates. */
export interface RequestUpdateEvent extends RealtimeUpdate<RequestSnapshot> {
  /** The request lifecycle status differs from the previous snapshot. */
  statusChanged: boolean;
  /** The persisted offer ledger differs from the previous snapshot. */
  offersChanged: boolean;
}

export type RequestUpdateListener = (event: RequestUpdateEvent) => void;

/** A single offer row status transition observed between snapshots. */
export interface OfferRowChange {
  offerId: string;
  requestId: string;
  previous: DispatchOfferStatus;
  next: DispatchOfferStatus;
}

/** Event emitted by subscribeToOfferUpdates (raw backend offer rows). */
export interface OfferUpdateEvent extends RealtimeUpdate<PersistedOffer[]> {
  /** Rows present now that did not exist at the previous snapshot. */
  added: PersistedOffer[];
  /** Rows whose status changed since the previous snapshot. */
  statusChanges: OfferRowChange[];
}

export type OfferUpdateListener = (event: OfferUpdateEvent) => void;
