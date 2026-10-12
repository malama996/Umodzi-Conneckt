/**
 * Realtime update abstraction (Task 22).
 *
 * UI components import subscriptions from this barrel only:
 *
 *   import { subscribeToRequestUpdates, subscribeToOfferUpdates }
 *     from '@/lib/realtime';
 *
 * Transport (short-interval polling of existing read-only GET
 * endpoints, one shared loop per resource) is an implementation
 * detail of this folder — no UI component contains fetch(),
 * setInterval(), WebSocket(), or EventSource().
 */
export { subscribeToRequestUpdates, DEFAULT_REQUEST_POLL_INTERVAL_MS } from './requestUpdates';
export { subscribeToOfferUpdates, DEFAULT_OFFER_POLL_INTERVAL_MS } from './offerUpdates';
export type {
  ConnectionStatus,
  OfferRowChange,
  OfferUpdateEvent,
  OfferUpdateListener,
  RealtimeSubscribeOptions,
  RealtimeSubscription,
  RealtimeUpdate,
  RequestSnapshot,
  RequestUpdateEvent,
  RequestUpdateListener,
} from './types';
