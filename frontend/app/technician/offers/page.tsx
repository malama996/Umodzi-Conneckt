'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  LuCircleCheck,
  LuCircleAlert,
  LuClipboardList,
  LuClock,
  LuLoader,
  LuMapPin,
  LuRotateCcw,
  LuUserRound,
} from 'react-icons/lu';
import { Badge, BrandAsset, DashboardLayout } from '@/components/ui';
import RequireAuth from '@/components/RequireAuth';
import TechnicianOfferCard from '@/components/TechnicianOfferCard';
import { useAuth } from '@/lib/auth';
import {
  acceptTechnicianOffer,
  getTechnicianOffers,
  rejectTechnicianOffer,
  type TechnicianOfferView,
} from '@/lib/services/technicianOfferService';
import type { SmartDispatchPipelineResult } from '@/lib/services/matchingService';
import {
  subscribeToOfferUpdates,
  type ConnectionStatus,
  type OfferUpdateEvent,
} from '@/lib/realtime';
import { entityStateKey, notifyInfo, notifySuccess, notifyWarning } from '@/lib/notifications';

type Notice = { tone: 'success' | 'info' | 'warning'; text: string } | null;

/**
 * Technician-side offer experience (Tasks 21B + 22).
 *
 * Shows the service requests Smart Dispatch has offered
 * to the selected technician, and lets the technician
 * explicitly accept, reject, or (prototype-only) simulate
 * a response timeout. Offers and responses are persisted
 * through the backend API (PostgreSQL); all state transitions
 * are produced by the technician offer service, which delegates
 * cascade/lifecycle decisions to the existing Smart Dispatch
 * pipeline.
 *
 * Signed-in technicians see THEIR offers — the profile is bound to the
 * account (one account ↔ one technician profile), so there is no
 * prototype selector anymore. Backend offer changes are
 * observed through the lib/realtime subscription (Task 22): one
 * shared polling loop per technician reads the existing offer
 * endpoint, so new or changed offers appear without a reload, and
 * observed transitions are surfaced once via the in-app
 * notification abstraction (entity+state deduplicated).
 */
function TechnicianOffersContent() {
  // Identity comes exclusively from the authenticated session (Task 23):
  // the backend links each technician account to exactly ONE profile row,
  // and the API authorizes reads by the JWT subject — nothing here is
  // chosen by the client.
  const { user } = useAuth();
  const technicianId = user?.technicianId ?? '';
  const technicianName = user?.technicianName ?? '';
  const [offers, setOffers] = useState<TechnicianOfferView[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const [offersError, setOffersError] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  // Synchronous re-entrancy guard (see matching page): React state
  // updates are async, so rapid clicks would run concurrent mutations.
  const actionBusyRef = useRef(false);
  // Non-destructive live-update indicator driven by the realtime layer.
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  // Latest realtime event handler, kept in a ref so the subscription
  // effect depends only on the technician id (no unsubscribe/resubscribe
  // churn when unrelated state changes).
  const offerEventRef = useRef<(event: OfferUpdateEvent) => void>(() => {});

  /**
   * Hydrate the pending-offer views from the technician offer service.
   * Default behaviour (initial load / post-mutation refresh) shows the
   * loading state and clears the list on failure — matching the
   * existing Task 21B semantics. With `preserveOnFailure` (used by
   * realtime refreshes) the last known valid list is kept and only the
   * connection indicator reports the problem.
   */
  const loadOffers = useCallback(async (id: string, options?: { preserveOnFailure?: boolean }) => {
    const preserve = options?.preserveOnFailure === true;
    if (!id) {
      setOffers([]);
      return;
    }
    if (!preserve) {
      setOffersLoading(true);
      setOffersError('');
    }
    try {
      setOffers(await getTechnicianOffers(id));
      setOffersError('');
    } catch (error) {
      if (!preserve) {
        setOffers([]);
        setOffersError(error instanceof Error ? error.message : 'Failed to load offers.');
      }
    } finally {
      if (!preserve) setOffersLoading(false);
    }
  }, []);

  /**
   * React to backend offer changes reported by the realtime layer.
   * Read-only: it refreshes display views and raises deduplicated
   * notifications — it never mutates offer or request state.
   */
  const handleOfferEvent = (event: OfferUpdateEvent) => {
    setConnection(event.connection);

    if (event.data === null) {
      // No successful read yet — surface the failure without touching
      // previous state (there is none for this technician).
      if (event.connection === 'error') {
        setOffersLoading(false);
        setOffersError(event.error || 'Live updates are unavailable.');
      }
      return;
    }

    if (event.baseline) {
      // Pre-existing backend offers: hydrate the visible list, never
      // notify — this is state the technician simply arrived to find.
      void loadOffers(technicianId);
      return;
    }

    if (event.added.length === 0 && event.statusChanges.length === 0) {
      return; // connection recovery only — the list is already valid
    }

    // Rows changed: re-hydrate the pending views (preserving the last
    // valid list on failure) and surface each observed transition
    // exactly once. Dedup keys are the same entity+state keys used by
    // confirmed mutation handlers, so a transition this technician
    // just acted on is suppressed here — never shown twice.
    void loadOffers(technicianId, { preserveOnFailure: true });

    for (const row of event.added) {
      if (row.status === 'pending') {
        notifyInfo({
          title: 'New service request available',
          message: `Smart Dispatch offered service request ${row.requestId}.`,
          dedupeKey: entityStateKey('request', row.requestId, 'pending'),
        });
      }
    }
    for (const change of event.statusChanges) {
      const dedupeKey = entityStateKey('request', change.requestId, change.next);
      if (change.next === 'accepted') {
        notifySuccess({
          title: 'Offer accepted',
          message: `Service request ${change.requestId} is now matched.`,
          dedupeKey,
        });
      } else if (change.next === 'rejected') {
        notifyWarning({
          title: 'Offer rejected',
          message: `Service request ${change.requestId} — Smart Dispatch will advance to the next ranked technician.`,
          dedupeKey,
        });
      } else if (change.next === 'timed_out') {
        notifyWarning({
          title: 'Offer timed out',
          message: `Service request ${change.requestId} — Smart Dispatch will advance to the next ranked technician.`,
          dedupeKey,
        });
      }
    }
  };

  // Keep the ref above pointing at the latest handler every render.
  useEffect(() => {
    offerEventRef.current = handleOfferEvent;
  });

  // Realtime observation (Task 22): one shared polling loop per
  // technician reads the existing GET /offers/technician/:id endpoint.
  // The first read (baseline) hydrates the visible list; later reads
  // surface added/changed offers without a page reload. The loop stops
  // on unmount — no timers or fetches survive the component.
  useEffect(() => {
    if (!technicianId) return;
    setOffersLoading(true);
    const subscription = subscribeToOfferUpdates(technicianId, (event) => {
      offerEventRef.current(event);
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [technicianId]);

  const describeResult = (result: SmartDispatchPipelineResult): Notice => {
    if (result.request.status === 'matched') {
      return {
        tone: 'success',
        text: `Request accepted — you have accepted service request ${result.request.id}.`,
      };
    }
    if (result.request.status === 'no_match') {
      return {
        tone: 'warning',
        text: `All ranked technicians have been offered request ${result.request.id} — Smart Dispatch found no match.`,
      };
    }
    return {
      tone: 'info',
      text: `Offer recorded — Smart Dispatch will advance request ${result.request.id} to the next ranked technician.`,
    };
  };

  const failureNotice = (error: unknown): Notice => ({
    tone: 'warning',
    text: error instanceof Error ? error.message : 'The response was not saved.',
  });

  /**
   * Surface a confirmed backend transition immediately (the poller may
   * take up to one interval to observe it). Dedup keys use the same
   * entity+state scheme as the realtime observer, so the later poll
   * event for this transition is suppressed — exactly one notification.
   * A failed action raises nothing here: errors are shown via the
   * inline notice and never reported as success.
   */
  const notifyConfirmedAction = (
    result: SmartDispatchPipelineResult,
    action: 'accepted' | 'rejected',
  ) => {
    const requestId = result.request.id;
    const dedupeKey = entityStateKey('request', requestId, action);
    if (action === 'accepted') {
      notifySuccess({
        title: 'Offer accepted',
        message: `You accepted service request ${requestId}.`,
        dedupeKey,
      });
    } else if (action === 'rejected') {
      notifyInfo({
        title: 'Offer rejected',
        message: `Service request ${requestId} — Smart Dispatch will advance to the next ranked technician.`,
        dedupeKey,
      });
    }
  };

  const runOfferAction = async (offer: TechnicianOfferView, action: 'accepted' | 'rejected') => {
    if (!technicianId || !technicianName || actionBusyRef.current) return;
    actionBusyRef.current = true;
    setNotice(null);
    try {
      const result =
        action === 'accepted'
          ? await acceptTechnicianOffer(technicianName, offer.request.id)
          : await rejectTechnicianOffer(technicianName, offer.request.id);
      setNotice(describeResult(result));
      notifyConfirmedAction(result, action);
      await loadOffers(technicianId);
    } catch (error) {
      setNotice(failureNotice(error));
    } finally {
      actionBusyRef.current = false;
    }
  };

  const handleAccept = (offer: TechnicianOfferView) => {
    void runOfferAction(offer, 'accepted');
  };

  const handleReject = (offer: TechnicianOfferView) => {
    void runOfferAction(offer, 'rejected');
  };

  return (
    <DashboardLayout active="Offers">
      <main className="app-page">
        <div className="page-wrap">
          <div className="page-intro">
            <div>
              <div className="eyebrow eyebrow-dark">TECHNICIAN OFFERS</div>
              <h1>Your service offers</h1>
              <p>View and respond to the service requests Smart Dispatch has offered to you.</p>
            </div>
            <Badge tone="teal">
              <LuClipboardList size={11} aria-hidden="true" /> Technician
            </Badge>
          </div>

          <section className="request-card technician-offer-controls">
            <p className="form-note">
              <LuMapPin size={11} className="ic" aria-hidden="true" /> Viewing offers for{' '}
              <strong>{technicianName || user?.email || 'your technician profile'}</strong>
            </p>
            <p className="form-note">
              Your account is bound to a single technician profile — offers Smart Dispatch sends to
              you appear below, and your responses are persisted to the backend API.
            </p>
            <p className="form-note">
              <LuUserRound size={11} className="ic" aria-hidden="true" /> Keep your{' '}
              <Link href="/technician/profile">profile &amp; verification</Link> current to stay
              dispatch-eligible.
            </p>
          </section>

          {technicianId && (
            <p
              className={`dispatch-status realtime-status realtime-status-${connection}`}
              role="status"
            >
              {connection === 'live' && (
                <span>Live — offers refresh automatically every few seconds.</span>
              )}
              {connection === 'connecting' && <span>Connecting to live updates…</span>}
              {connection === 'error' && (
                <span>Live updates interrupted — showing the last known offers.</span>
              )}
              {connection === 'stopped' && <span>Live updates paused.</span>}
            </p>
          )}

          {notice && (
            <div
              className={`dispatch-status technician-offer-notice technician-offer-notice-${notice.tone}`}
              role="status"
            >
              {notice.tone === 'success' ? (
                <LuCircleCheck size={12} className="ic" aria-hidden="true" />
              ) : (
                <LuCircleAlert size={12} className="ic" aria-hidden="true" />
              )}
              <span>{notice.text}</span>
            </div>
          )}

          <section className="results" aria-live="polite">
            <div className="result-head">
              <div>
                <span className="eyebrow eyebrow-dark">PENDING OFFERS</span>
                <h2>{offers.length} awaiting your response</h2>
              </div>
              <span className="result-rule">Smart Dispatch</span>
            </div>
            {offersLoading ? (
              <p className="form-note" role="status">
                <LuLoader size={11} className="ic" aria-hidden="true" /> Loading offers…
              </p>
            ) : offersError ? (
              <p className="request-form-error" role="alert">
                <LuCircleAlert size={12} className="ic" aria-hidden="true" /> {offersError}
              </p>
            ) : offers.length === 0 ? (
              <div className="dispatch-empty">
                <BrandAsset
                  className="dispatch-art"
                  src="/illustrations/technician-offers.svg"
                  alt="Illustration: service offers arriving on a technician's phone"
                  width={640}
                  height={480}
                />
                <h3>No pending offers</h3>
                <p className="form-note">
                  Smart Dispatch has not offered any service requests to {technicianName || 'you'}{' '}
                  yet. Offers appear here when a customer dispatches a request that matches this
                  technician (prototype: backend data only).
                </p>
                {/*
                  Was a Link to /matching, which is gated to role="customer" —
                  every technician who clicked it landed on an ACCESS DENIED
                  panel. There is no technician-facing "browse requests" page
                  by design, so this is a genuine refresh of the offers the
                  technician CAN see (existing loadOffers → GET /offers/…).
                */}
                <button
                  type="button"
                  className="button button-coral button-small"
                  disabled={offersLoading || !technicianId}
                  onClick={() => {
                    if (technicianId) void loadOffers(technicianId);
                  }}
                >
                  {offersLoading ? 'Checking…' : 'Check again'}{' '}
                  <LuRotateCcw size={12} className="ic" aria-hidden="true" />
                </button>
              </div>
            ) : (
              offers.map((offer) => (
                <TechnicianOfferCard
                  key={offer.request.id}
                  offer={offer}
                  onAccept={handleAccept}
                  onReject={handleReject}
                />
              ))
            )}
          </section>

          {offers.length > 0 && (
            <p className="form-note technician-offer-footnote">
              <LuClock size={10} className="ic" aria-hidden="true" /> Prototype: accepting or
              rejecting updates the persisted Smart Dispatch offer state. Feedback is shown in-app
              only — no email, SMS, push, browser-notification permission, message, call, booking,
              or payment takes place.
            </p>
          )}
        </div>
      </main>
    </DashboardLayout>
  );
}

/**
 * /technician/offers route (Task 23): technician-only. Anonymous visitors
 * are redirected to /login?next=/technician/offers; a signed-in customer
 * or administrator sees the access-denied panel. Nothing on this page
 * renders until the session state is known.
 */
export default function TechnicianOffersPage() {
  return (
    <RequireAuth role="technician">
      <TechnicianOffersContent />
    </RequireAuth>
  );
}
