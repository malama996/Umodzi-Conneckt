/**
 * Task 22 focused tests: realtime update layer + in-app notification
 * abstraction (+ Smart Dispatch integrity regression).
 *
 * Run from the frontend folder:
 *   npx tsx scripts/task22-tests.ts
 *
 * The realtime layer is exercised end-to-end against a mocked global
 * fetch (same code path the UI uses: realtime → services → API client),
 * with short polling intervals so the suite runs in a few seconds.
 * Polling is verified to be read-only (no POST/PATCH ever issued).
 */
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:9999/api/v1';

import {
  clearNotifications,
  dismissNotification,
  entityStateKey,
  getNotifications,
  notifyError,
  notifyInfo,
  notifySuccess,
  notifyWarning,
  resetNotificationStore,
  subscribeNotifications,
  wasNotificationObserved,
} from '../lib/notifications';
import { subscribeToOfferUpdates, subscribeToRequestUpdates } from '../lib/realtime';
import type { OfferUpdateEvent, RequestUpdateEvent } from '../lib/realtime';
import { DISPATCH_WEIGHTS, rankEligibleTechnicians } from '../lib/services/dispatchService';
import { advanceOffer, createInitialOffer } from '../lib/services/cascadingOfferService';
import {
  applyCascadingOutcome,
  beginDispatching,
  transitionServiceRequest,
} from '../lib/services/serviceRequestLifecycleService';
import { technicianCategories } from '../lib/categories';
import type {
  EligibleTechnicianResult,
  ServiceRequest,
  SmartDispatchResult,
  Technician,
} from '../lib/types';

/* ------------------------------------------------------------------ */
/* Tiny assertion harness                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  label = 'condition',
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(10);
  }
  console.log(`       (timed out waiting for: ${label})`);
  return false;
}

/* ------------------------------------------------------------------ */
/* Mock backend (global fetch replacement)                            */
/* ------------------------------------------------------------------ */

interface OfferRow {
  id: string;
  requestId: string;
  technicianId: string;
  candidateIndex: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface MockState {
  request: Record<string, string> | null;
  requestOffers: OfferRow[];
  technicianOffers: OfferRow[];
  networkDown: boolean;
  getRequests: number;
  mutatingRequests: number;
}

const mock: MockState = {
  request: null,
  requestOffers: [],
  technicianOffers: [],
  networkDown: false,
  getRequests: 0,
  mutatingRequests: 0,
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    headers: { 'Content-Type': 'application/json' },
  });
}

const originalFetch = globalThis.fetch.bind(globalThis);
const BASE = 'http://localhost:9999/api/v1';

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    mock.mutatingRequests += 1;
    throw new Error(`Realtime layer issued a non-GET request: ${method} ${url}`);
  }
  mock.getRequests += 1;
  if (mock.networkDown) {
    throw new TypeError('network unavailable');
  }
  if (!url.startsWith(BASE)) {
    throw new Error(`Unexpected URL: ${url}`);
  }
  const path = url.slice(BASE.length);

  const requestOffersMatch = /^\/requests\/([^/]+)\/offers$/.exec(path);
  if (requestOffersMatch) {
    return jsonResponse(mock.requestOffers);
  }
  const requestMatch = /^\/requests\/([^/]+)$/.exec(path);
  if (requestMatch) {
    return mock.request ? jsonResponse(mock.request) : jsonResponse({ error: 'gone' }, 404);
  }
  const technicianOffersMatch = /^\/offers\/technician\/([^/]+)$/.exec(path);
  if (technicianOffersMatch) {
    return jsonResponse(mock.technicianOffers);
  }
  throw new Error(`Unexpected URL: ${url}`);
}) as typeof fetch;

function makeRequest(id: string, status: string): Record<string, string> {
  return {
    id,
    description: 'The kitchen sink is leaking water.',
    category: technicianCategories[0],
    city: 'Kitwe',
    status,
    createdAt: '2026-10-06T08:00:00.000Z',
    updatedAt: '2026-10-06T08:00:00.000Z',
  };
}

function makeOffer(
  id: string,
  requestId: string,
  candidateIndex: number,
  status: string,
): OfferRow {
  return {
    id,
    requestId,
    technicianId: 'tech-1',
    candidateIndex,
    status,
    createdAt: '2026-10-06T08:00:00.000Z',
    updatedAt: '2026-10-06T08:00:00.000Z',
  };
}

/* ------------------------------------------------------------------ */
/* 1. Notification abstraction                                        */
/* ------------------------------------------------------------------ */

async function testNotifications(): Promise<void> {
  section('Notifications: success/info/warning/error + duplicate suppression');

  resetNotificationStore();

  const got: string[] = [];
  const unsubscribe = subscribeNotifications(() => got.push('changed'));

  assert(notifySuccess({ title: 'Technician offer accepted' }) === true, 'success delivered');
  assert(notifyInfo({ title: 'New service request available' }) === true, 'info delivered');
  assert(notifyWarning({ title: 'Offer timed out' }) === true, 'warning delivered');
  assert(notifyError({ title: 'Refresh failed' }) === true, 'error delivered');

  const tones = getNotifications().map((n) => n.tone);
  assert(
    tones.join(',') === 'success,info,warning,error',
    'all four tones stored with correct tone values',
  );
  assert(got.length === 4, 'subscribers notified of every change');

  const key = entityStateKey('request', 'req-1', 'accepted');
  assert(key === 'request:req-1:accepted', 'entityStateKey builds deterministic entity+state key');

  const first = notifySuccess({ title: 'Offer accepted', dedupeKey: key });
  const countAfterFirst = getNotifications().length;
  const second = notifySuccess({ title: 'Offer accepted again', dedupeKey: key });
  const countAfterSecond = getNotifications().length;

  assert(first === true, 'first delivery with dedupeKey succeeds');
  assert(second === false, 'duplicate with same dedupeKey suppressed');
  assert(countAfterFirst === countAfterSecond, 'suppressed duplicate adds no visible notification');
  assert(wasNotificationObserved(key), 'dedup ledger records the observed key');

  // Scenario from the task: an observer re-seeing an already-notified
  // transition (mutation handler notified first) must stay silent.
  const observerReplay = notifyWarning({
    title: 'Offer accepted (poll replay)',
    dedupeKey: entityStateKey('request', 'req-1', 'accepted'),
  });
  assert(observerReplay === false, 'poll replay of an already-notified transition is suppressed');

  const firstNotification = getNotifications()[0];
  dismissNotification(firstNotification.id);
  assert(
    getNotifications().some((n) => n.id === firstNotification.id) === false,
    'dismiss removes one notification',
  );

  notifyInfo({ title: 'A' });
  notifyInfo({ title: 'B' });
  notifyInfo({ title: 'C' });
  notifyInfo({ title: 'D' });
  notifyInfo({ title: 'E' });
  assert(getNotifications().length === 4, 'visible list is capped (oldest dropped)');

  clearNotifications();
  assert(getNotifications().length === 0, 'clearNotifications empties the list');
  assert(wasNotificationObserved(key) === true, 'dedup ledger survives dismissal/clearing');

  unsubscribe();
  const changesAfterUnsubscribe = got.length;
  notifyInfo({ title: 'After unsubscribe' });
  assert(got.length === changesAfterUnsubscribe, 'unsubscribe stops change delivery');

  resetNotificationStore();
  assert(
    getNotifications().length === 0 && wasNotificationObserved(key) === false,
    'resetNotificationStore clears list and ledger',
  );
}

/* ------------------------------------------------------------------ */
/* 2. Realtime: request status updates                                */
/* ------------------------------------------------------------------ */

async function testRequestUpdates(): Promise<void> {
  section('Realtime: request updates (baseline, detection, cleanup, terminal, failure)');

  // --- start + baseline -------------------------------------------
  mock.request = makeRequest('req-baseline', 'pending');
  mock.requestOffers = [];
  const events: RequestUpdateEvent[] = [];
  const sub = subscribeToRequestUpdates('req-baseline', (event) => events.push(event), {
    intervalMs: 25,
  });

  assert(
    await waitFor(() => events.length >= 1, 2000, 'baseline event'),
    'subscription starts and delivers an initial snapshot',
  );
  const baseline = events[0];
  assert(baseline.baseline === true, 'first snapshot is flagged as baseline');
  assert(baseline.connection === 'live', 'successful first read reports live connection');
  assert(baseline.data?.request.status === 'pending', 'baseline carries backend request state');
  assert(
    baseline.statusChanged === false && baseline.offersChanged === false,
    'baseline reports no change',
  );

  // --- unchanged state produces no duplicate events ---------------
  const countAfterBaseline = events.length;
  await sleep(120); // ~4 intervals
  assert(
    events.length === countAfterBaseline,
    'unchanged backend state emits no duplicate events across polling cycles',
  );

  // --- status change detected: pending -> matching ----------------
  mock.request = makeRequest('req-baseline', 'matching');
  assert(
    await waitFor(
      () => events.some((e) => e.statusChanged && e.data?.request.status === 'matching'),
      2000,
      'pending -> matching detection',
    ),
    'pending -> matching transition detected once',
  );
  const matchingEvents = events.filter((e) => e.statusChanged);
  assert(matchingEvents.length === 1, 'matching transition emitted exactly once');

  // --- status change detected: matching -> matched (terminal) -----
  mock.requestOffers = [makeOffer('offer-1', 'req-baseline', 0, 'accepted')];
  mock.request = makeRequest('req-baseline', 'matched');
  assert(
    await waitFor(
      () => events.some((e) => e.data?.request.status === 'matched'),
      2000,
      'matching -> matched detection',
    ),
    'matching -> matched transition detected',
  );
  assert(
    events.some((e) => e.offersChanged && e.data?.offers.length === 1),
    'offer ledger change (pending -> accepted) detected alongside status',
  );
  assert(
    events.some((e) => e.connection === 'stopped'),
    'terminal status ends observation with a stopped event',
  );

  const requestsBeforeStop = mock.getRequests;
  const eventsBeforeStop = events.length;
  await sleep(140); // several intervals after terminal
  assert(
    mock.getRequests === requestsBeforeStop,
    'terminal state stops the polling timer (no further reads)',
  );
  assert(events.length === eventsBeforeStop, 'no events emitted after terminal state');

  sub.unsubscribe();

  // --- pending -> matching -> no_match on a fresh request ---------
  mock.request = makeRequest('req-nomatch', 'pending');
  mock.requestOffers = [];
  const noMatchEvents: RequestUpdateEvent[] = [];
  const sub2 = subscribeToRequestUpdates('req-nomatch', (e) => noMatchEvents.push(e), {
    intervalMs: 25,
  });
  assert(
    await waitFor(() => noMatchEvents.length >= 1, 2000, 'second baseline'),
    'second subscription starts',
  );
  mock.request = makeRequest('req-nomatch', 'matching');
  assert(
    await waitFor(
      () => noMatchEvents.some((e) => e.data?.request.status === 'matching'),
      2000,
      'second: pending -> matching',
    ),
    'pending -> matching detected (no_match scenario)',
  );
  mock.request = makeRequest('req-nomatch', 'no_match');
  assert(
    await waitFor(
      () => noMatchEvents.some((e) => e.data?.request.status === 'no_match'),
      2000,
      'second: matching -> no_match',
    ),
    'matching -> no_match transition detected',
  );
  assert(
    noMatchEvents.some((e) => e.connection === 'stopped'),
    'no_match also stops observation (terminal)',
  );
  sub2.unsubscribe();

  // --- failed refresh never fabricates success --------------------
  mock.request = makeRequest('req-failure', 'pending');
  mock.requestOffers = [];
  const failureEvents: RequestUpdateEvent[] = [];
  const sub3 = subscribeToRequestUpdates('req-failure', (e) => failureEvents.push(e), {
    intervalMs: 25,
  });
  assert(
    await waitFor(() => failureEvents.length >= 1, 2000, 'failure baseline'),
    'pre-failure baseline delivered',
  );

  mock.networkDown = true;
  assert(
    await waitFor(() => failureEvents.some((e) => e.connection === 'error'), 2000, 'error event'),
    'polling failure emits a connection error event',
  );
  const errorEvent = failureEvents.find((e) => e.connection === 'error');
  assert(
    errorEvent?.changed === false && errorEvent?.baseline === false,
    'failure is never reported as a state change',
  );
  assert(
    errorEvent?.data?.request.status === 'pending',
    'failure preserves the last known valid state (no false success)',
  );
  assert((errorEvent?.error.length ?? 0) > 0, 'failure event carries an error message');

  await sleep(100); // several failing intervals
  const falseSuccesses = failureEvents.filter((e) => e.changed);
  assert(falseSuccesses.length === 0, 'repeated failures never emit changed=true');

  mock.networkDown = false;
  mock.request = makeRequest('req-failure', 'matching');
  assert(
    await waitFor(
      () =>
        failureEvents.some((e) => e.connection === 'live' && e.data?.request.status === 'matching'),
      2000,
      'recovery event with refreshed state',
    ),
    'recovery: backend reachable again reports live connection with current state',
  );
  sub3.unsubscribe();

  // --- cleanup: unsubscribe stops the shared loop -----------------
  mock.request = makeRequest('req-cleanup', 'pending');
  const cleanupEvents: RequestUpdateEvent[] = [];
  const sub4 = subscribeToRequestUpdates('req-cleanup', (e) => cleanupEvents.push(e), {
    intervalMs: 25,
  });
  assert(
    await waitFor(() => cleanupEvents.length >= 1, 2000, 'cleanup baseline'),
    'cleanup subscription started',
  );
  sub4.unsubscribe();
  const readsAtUnsubscribe = mock.getRequests;
  await sleep(120);
  assert(
    mock.getRequests === readsAtUnsubscribe,
    'unsubscribe clears the timer (no reads after cleanup)',
  );
  assert(cleanupEvents.length >= 1, 'events received before cleanup remain intact');

  // --- 404: no data, error only (never a fake success) -------------
  mock.request = null; // the router now 404s every request lookup
  const missingEvents: RequestUpdateEvent[] = [];
  const sub5 = subscribeToRequestUpdates('req-missing', (e) => missingEvents.push(e), {
    intervalMs: 25,
  });
  assert(
    await waitFor(() => missingEvents.length >= 1, 2000, 'missing-request error'),
    'unknown request reports an error event',
  );
  const missing = missingEvents[0];
  assert(
    missing.data === null && missing.connection === 'error' && missing.changed === false,
    'unknown request yields no fabricated data',
  );
  sub5.unsubscribe();
}

/* ------------------------------------------------------------------ */
/* 3. Realtime: technician offer updates                              */
/* ------------------------------------------------------------------ */

async function testOfferUpdates(): Promise<void> {
  section('Realtime: technician offer updates (added, transitions, dedup, read-only)');

  mock.technicianOffers = [makeOffer('offer-a', 'req-a', 0, 'pending')];
  const events: OfferUpdateEvent[] = [];
  const sub = subscribeToOfferUpdates('tech-1', (e) => events.push(e), { intervalMs: 25 });

  assert(
    await waitFor(() => events.length >= 1, 2000, 'offers baseline'),
    'offer subscription starts with a baseline read',
  );
  assert(events[0].baseline === true, 'first offer snapshot is baseline (no notify trigger)');
  assert(
    events[0].added.length === 0 && events[0].statusChanges.length === 0,
    'baseline reports no additions or transitions',
  );

  // Unchanged polls stay silent.
  const countAfterBaseline = events.length;
  await sleep(100);
  assert(events.length === countAfterBaseline, 'unchanged offer rows emit no duplicate events');

  // New offer appears (e.g. dispatched by Smart Dispatch elsewhere).
  mock.technicianOffers = [
    makeOffer('offer-a', 'req-a', 0, 'pending'),
    makeOffer('offer-b', 'req-b', 0, 'pending'),
  ];
  assert(
    await waitFor(
      () => events.some((e) => e.added.length === 1 && e.added[0].id === 'offer-b'),
      2000,
      'added offer detection',
    ),
    'new backend offer detected without a reload (by database id)',
  );

  // pending -> accepted.
  mock.technicianOffers = [
    makeOffer('offer-a', 'req-a', 0, 'accepted'),
    makeOffer('offer-b', 'req-b', 0, 'pending'),
  ];
  assert(
    await waitFor(
      () =>
        events.some((e) =>
          e.statusChanges.some(
            (c) => c.offerId === 'offer-a' && c.previous === 'pending' && c.next === 'accepted',
          ),
        ),
      2000,
      'pending -> accepted detection',
    ),
    'pending -> accepted transition detected with backend ids preserved',
  );

  // pending -> rejected.
  mock.technicianOffers = [
    makeOffer('offer-a', 'req-a', 0, 'accepted'),
    makeOffer('offer-b', 'req-b', 0, 'rejected'),
  ];
  assert(
    await waitFor(
      () =>
        events.some((e) =>
          e.statusChanges.some((c) => c.offerId === 'offer-b' && c.next === 'rejected'),
        ),
      2000,
      'pending -> rejected detection',
    ),
    'pending -> rejected transition detected',
  );

  // pending -> timed_out (fresh technician to keep diffs clean).
  sub.unsubscribe();
  mock.technicianOffers = [makeOffer('offer-c', 'req-c', 0, 'pending')];
  const timeoutEvents: OfferUpdateEvent[] = [];
  const sub2 = subscribeToOfferUpdates('tech-2', (e) => timeoutEvents.push(e), { intervalMs: 25 });
  assert(
    await waitFor(() => timeoutEvents.length >= 1, 2000, 'tech-2 baseline'),
    'second offer subscription starts',
  );
  mock.technicianOffers = [makeOffer('offer-c', 'req-c', 0, 'timed_out')];
  assert(
    await waitFor(
      () => timeoutEvents.some((e) => e.statusChanges.some((c) => c.next === 'timed_out')),
      2000,
      'pending -> timed_out detection',
    ),
    'pending -> timed_out transition detected',
  );
  sub2.unsubscribe();

  // Shared loop: two subscribers, one loop (same resource key).
  mock.technicianOffers = [makeOffer('offer-d', 'req-d', 0, 'pending')];
  const readsBeforeDoubleSub = mock.getRequests;
  const sharedA: OfferUpdateEvent[] = [];
  const sharedB: OfferUpdateEvent[] = [];
  const subA = subscribeToOfferUpdates('tech-3', (e) => sharedA.push(e), { intervalMs: 25 });
  const subB = subscribeToOfferUpdates('tech-3', (e) => sharedB.push(e), { intervalMs: 25 });
  assert(
    await waitFor(() => sharedA.length >= 1 && sharedB.length >= 1, 2000, 'both subscribers fed'),
    'two subscribers both receive events from the shared loop',
  );
  await sleep(80);
  const doubleSubReads = mock.getRequests - readsBeforeDoubleSub;
  assert(
    doubleSubReads < 8,
    `no duplicate polling loops for the same resource (${doubleSubReads} reads for 2 subscribers over ~100ms)`,
  );
  subA.unsubscribe();
  subB.unsubscribe();

  // Read-only guarantee: the entire realtime suite issued only GETs.
  assert(
    mock.mutatingRequests === 0,
    'realtime layer issued zero mutating requests (read-only polling)',
  );
}

/* ------------------------------------------------------------------ */
/* 4. Smart Dispatch integrity (Task 21B regression guard)            */
/* ------------------------------------------------------------------ */

function buildTechnician(overrides: Partial<Technician> & { name: string }): Technician {
  return {
    id: 'test-tech',
    category: technicianCategories[0],
    skills: [],
    serviceArea: 'Kitwe',
    rating: 5,
    jobs: 100,
    verified: true,
    availability: 'Available',
    availabilityStatus: 'available',
    accountStatus: 'active',
    city: 'Kitwe',
    bio: null,
    hasPhoto: false,
    ...overrides,
  };
}

function testDispatchIntegrity(): void {
  section('Smart Dispatch integrity: weights, scoring, tie-breaks, cascade, lifecycle');

  assert(
    DISPATCH_WEIGHTS.proximity === 0.4 &&
      DISPATCH_WEIGHTS.trust === 0.3 &&
      DISPATCH_WEIGHTS.availability === 0.2 &&
      DISPATCH_WEIGHTS.fairness === 0.1,
    'DISPATCH_WEIGHTS unchanged (0.4 / 0.3 / 0.2 / 0.1)',
  );
  assert(
    Math.abs(
      DISPATCH_WEIGHTS.proximity +
        DISPATCH_WEIGHTS.trust +
        DISPATCH_WEIGHTS.availability +
        DISPATCH_WEIGHTS.fairness -
        1,
    ) < 1e-9,
    'weights still sum to exactly 1',
  );

  const request: ServiceRequest = {
    id: 'req-score',
    description: 'Leaking pipe under the sink.',
    category: technicianCategories[0],
    status: 'pending',
    city: 'Kitwe',
    createdAt: '2026-10-06T08:00:00.000Z',
    updatedAt: '2026-10-06T08:00:00.000Z',
  };

  const perfect = buildTechnician({ name: 'Perfect Match' });
  const mid = buildTechnician({ name: 'Mid Score', rating: 4.2, jobs: 60 });
  const weak = buildTechnician({
    name: 'Weak Score',
    serviceArea: 'Ndola',
    verified: false,
    rating: 0,
    jobs: 0,
  });

  const eligible: EligibleTechnicianResult[] = [perfect, mid, weak].map((technician) => ({
    technician,
    matchedCategory: technicianCategories[0],
  }));

  const ranked = rankEligibleTechnicians(request, eligible);
  assert(ranked.length === 3, 'ranking returns every eligible technician');
  assert(ranked[0].score.finalScore === 0.95, 'known vector: perfect technician scores 0.95');
  assert(
    ranked[1].score.finalScore === 0.9116,
    'known vector: mid technician scores 0.9116 (regression)',
  );
  assert(ranked[2].score.finalScore === 0.25, 'known vector: weak technician scores 0.25');
  assert(
    ranked[0].score.proximity === 1 &&
      ranked[0].score.availability === 1 &&
      ranked[0].score.fairness === 0.5,
    'component scores unchanged (1 / 1 / 0.5)',
  );

  // Deterministic tie-break: equal final scores keep input order.
  const tieA = buildTechnician({ name: 'Tie A' });
  const tieB = buildTechnician({ name: 'Tie B' });
  const tied = rankEligibleTechnicians(request, [
    { technician: tieA, matchedCategory: technicianCategories[0] },
    { technician: tieB, matchedCategory: technicianCategories[0] },
  ]);
  assert(
    tied[0].technician.name === 'Tie A' && tied[1].technician.name === 'Tie B',
    'tie-break preserves original input order (stable sort)',
  );

  // Cascading offer behaviour unchanged.
  const dispatchResult: SmartDispatchResult = {
    requestId: 'req-cascade',
    status: 'matched',
    candidates: rankEligibleTechnicians(request, eligible),
  };
  const initial = createInitialOffer(dispatchResult);
  assert(
    initial.status === 'offering' &&
      initial.offer?.candidateIndex === 0 &&
      initial.offer.status === 'pending',
    'cascade starts at candidate 0 (pending)',
  );
  const accepted = advanceOffer(dispatchResult, { ...initial.offer!, status: 'accepted' });
  assert(accepted.status === 'accepted' && accepted.offer !== null, 'accepted stops cascading');
  const rejected = advanceOffer(dispatchResult, { ...initial.offer!, status: 'rejected' });
  assert(
    rejected.status === 'offering' && rejected.offer?.candidateIndex === 1,
    'rejected advances to candidate 1',
  );
  const timedOut = advanceOffer(dispatchResult, { ...initial.offer!, status: 'timed_out' });
  assert(
    timedOut.status === 'offering' && timedOut.offer?.candidateIndex === 1,
    'timed_out advances to candidate 1',
  );
  const lastOffer = {
    requestId: 'req-cascade',
    technicianId: 'x',
    candidateIndex: 2,
    status: 'rejected' as const,
  };
  const exhausted = advanceOffer(dispatchResult, lastOffer);
  assert(
    exhausted.status === 'exhausted' && exhausted.offer === null,
    'cascade exhausts at the end',
  );
  const noCandidates = createInitialOffer({ requestId: 'r', status: 'no_match', candidates: [] });
  assert(noCandidates.status === 'exhausted', 'no_match result is exhausted immediately');

  // Lifecycle behaviour unchanged.
  const matching = beginDispatching(request);
  assert(matching.status === 'matching', 'pending -> matching allowed');
  const matched = applyCascadingOutcome(matching, accepted);
  assert(matched.status === 'matched', 'accepted outcome yields matched');
  const stillMatching = applyCascadingOutcome(matching, rejected);
  assert(stillMatching.status === 'matching', 'offering outcome keeps the request in matching');
  const noMatch = applyCascadingOutcome(matching, exhausted);
  assert(noMatch.status === 'no_match', 'exhausted outcome yields no_match');
  let threw = false;
  try {
    transitionServiceRequest(request, 'matched'); // pending -> matched is invalid
  } catch {
    threw = true;
  }
  assert(threw, 'invalid lifecycle transition still throws (pending -> matched)');
}

/* ------------------------------------------------------------------ */
/* 5. Notification + realtime dedup integration                       */
/* ------------------------------------------------------------------ */

function testNotificationRealtimeDedup(): void {
  section('Notifications: mutation-then-observer dedup (realtime integration)');

  resetNotificationStore();
  const requestId = 'req-integration';

  // Confirmed mutation handler notifies immediately (technician page).
  const mutationDelivered = notifySuccess({
    title: 'Offer accepted',
    message: `You accepted service request ${requestId}.`,
    dedupeKey: entityStateKey('request', requestId, 'accepted'),
  });
  // The subsequent polling cycle observes the same backend transition
  // and tries to notify with the identical entity+state key.
  const observerDelivered = notifySuccess({
    title: 'Offer accepted',
    message: `Service request ${requestId} is now matched.`,
    dedupeKey: entityStateKey('request', requestId, 'accepted'),
  });
  assert(mutationDelivered === true, 'confirmed mutation notification delivered once');
  assert(observerDelivered === false, 'observer replay of the same transition suppressed');
  assert(
    getNotifications().filter((n) => n.title === 'Offer accepted').length === 1,
    'exactly one visible notification for the transition',
  );

  // A later poll of the SAME terminal state is not an event at all.
  const observerReplay = notifySuccess({
    title: 'Offer accepted',
    dedupeKey: entityStateKey('request', requestId, 'accepted'),
  });
  assert(observerReplay === false, 'every subsequent observation stays suppressed');

  resetNotificationStore();
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testNotifications();
  await testRequestUpdates();
  await testOfferUpdates();
  testDispatchIntegrity();
  testNotificationRealtimeDedup();

  globalThis.fetch = originalFetch;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error('Test runner crashed:', error);
  process.exitCode = 1;
});
