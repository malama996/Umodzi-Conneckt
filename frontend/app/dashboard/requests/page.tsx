'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { LuClipboardList, LuMapPin, LuMessageCircle, LuPlus } from 'react-icons/lu';

import RequireAuth from '@/components/RequireAuth';
import ReviewCard from '@/components/ReviewCard';
import { DashboardLayout, Button, Badge, type BadgeTone } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  listMyServiceRequests,
  requestErrorMessage,
  updateServiceRequestStatus,
  type MyServiceRequest,
} from '@/lib/api/serviceRequestsApi';
import type { ServiceRequestStatus } from '@/lib/types';

/**
 * /dashboard/requests — this account's service-request history (Phase 4).
 *
 * §5 requires customers to see "current and recent service requests" with
 * "status and next steps". That was impossible before: requests could be
 * created and fetched one at a time, but never listed, so the sidebar's
 * "My Requests" entry could only point back at the create form.
 *
 * Every row comes from GET /me/requests, whose scope the backend derives
 * from the session — a customer sees only their own requests, a technician
 * only rows they hold an offer on. Nothing here is sample data: an account
 * with no requests gets a real empty state.
 *
 * Because both roles reach this route, every customer-worded string (the
 * intro, the "New request" button, the empty state, the per-status hint) is
 * chosen from the session role. Two of those destinations — /matching and the
 * customer "create" copy — are unreachable for a technician, so a technician
 * is never shown a control that would bounce them to an ACCESS DENIED panel.
 */

const STATUS_LABEL: Record<ServiceRequestStatus, string> = {
  pending: 'Pending',
  matching: 'Finding a technician',
  matched: 'Matched',
  no_match: 'No technician found',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATUS_TONE: Record<ServiceRequestStatus, BadgeTone> = {
  pending: 'neutral',
  matching: 'teal',
  matched: 'success',
  no_match: 'coral',
  in_progress: 'teal',
  completed: 'success',
  cancelled: 'neutral',
};

/**
 * Plain-language next step for each real lifecycle state. These describe
 * where the request actually is in the Task 15 lifecycle — no state was
 * invented, and no action is offered that the backend does not support.
 */
const STATUS_HINT: Record<ServiceRequestStatus, string> = {
  pending: 'Your request is queued for dispatch.',
  matching: 'Dispatch is contacting eligible technicians.',
  matched: 'A technician accepted this request.',
  no_match: 'No eligible technician was available. You can post it again.',
  in_progress: 'Your technician is working on this request.',
  completed: 'This request is closed.',
  cancelled: 'This request was cancelled.',
};

/**
 * Same lifecycle, technician point of view. The customer wording above
 * ("YOUR technician…") reads as an error when a technician is the one being
 * offered the row, so the few states whose sentence is role-specific get a
 * second entry; the neutral states are shared.
 */
const TECHNICIAN_STATUS_HINT: Record<ServiceRequestStatus, string> = {
  ...STATUS_HINT,
  matched: 'You accepted this request.',
  no_match: 'Dispatch could not place this request with you.',
  in_progress: 'You are working on this request.',
};

/** A conversation exists once a technician has accepted an offer. */
function canMessage(request: MyServiceRequest): boolean {
  return (
    request.assignedTechnicianName !== null &&
    (request.status === 'matched' ||
      request.status === 'in_progress' ||
      request.status === 'completed')
  );
}

/**
 * Progress → completion → rating for ONE request row.
 *
 * The lifecycle was previously reachable through the API but through no
 * screen: a request could be created and an offer accepted, yet nothing in
 * the UI could record progress, close the job or collect the rating — so the
 * cycle could never actually finish. This wires the EXISTING endpoints
 * (PATCH /requests/:id/status and the review route) into the screens the
 * roles already use; no new API surface was added.
 *
 * Permissions are decided by the SERVER, not here: the route requires the
 * ACCEPTED offer for a technician's progress/completion writes, rejects
 * writes to a closed request, and recomputes review eligibility itself. The
 * controls below are a convenience, never the guard.
 */
function RequestWorkflow({
  request,
  isTechnician,
  onChanged,
}: {
  request: MyServiceRequest;
  isTechnician: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<'in_progress' | 'completed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A job that was never awarded to anybody has no progress to record.
  const awarded = request.assignedTechnicianName !== null;
  const canStartWork = isTechnician && awarded && request.status === 'matched';
  const canComplete =
    (isTechnician ? awarded : true) &&
    (request.status === 'matched' || request.status === 'in_progress');

  const advance = async (status: 'in_progress' | 'completed') => {
    setBusy(status);
    setError(null);
    try {
      await updateServiceRequestStatus(request.id, status);
      await onChanged();
    } catch (err) {
      setError(requestErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (!canStartWork && !canComplete && request.status !== 'completed') {
    return null;
  }

  return (
    <div className="request-workflow">
      {(canStartWork || canComplete) && (
        <div className="request-workflow-actions">
          {canStartWork && (
            <Button
              type="button"
              className="outline-button"
              disabled={busy !== null}
              onClick={() => void advance('in_progress')}
            >
              {busy === 'in_progress' ? 'Starting…' : 'Start work'}
            </Button>
          )}
          {canComplete && (
            <Button
              type="button"
              className="button button-teal"
              disabled={busy !== null}
              onClick={() => void advance('completed')}
            >
              {busy === 'completed' ? 'Saving…' : 'Mark service as completed'}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {/* Rating and written review, offered only once the request is
          completed — ReviewCard asks the server for eligibility and renders
          nothing when the account may not review. */}
      {request.status === 'completed' && (
        <ReviewCard requestId={request.id} technicianName={request.assignedTechnicianName} />
      )}
    </div>
  );
}

export default function MyRequestsPage() {
  return (
    <RequireAuth>
      <MyRequestsList />
    </RequireAuth>
  );
}

function MyRequestsList() {
  const { user } = useAuth();
  const isTechnician = user?.role === 'technician';
  const [requests, setRequests] = useState<MyServiceRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRequests(await listMyServiceRequests());
      setError(null);
    } catch (err) {
      setError(requestErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DashboardLayout active="My Requests">
      <main className="dashboard-content">
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow eyebrow-dark">SERVICE REQUESTS</div>
              <h2>
                <LuClipboardList size={16} className="ic" aria-hidden="true" /> My requests
              </h2>
              <p className="panel-sub">
                {isTechnician
                  ? 'Requests Smart Dispatch has offered to you, newest first.'
                  : 'Everything you have asked for on Umodzi Connect, newest first.'}
              </p>
            </div>
            <div className="panel-head-actions">
              <Button type="button" className="button button-teal" onClick={() => void load()}>
                Refresh
              </Button>
              {/* /matching is gated to role="customer" — offering "New request"
                  to a technician would send them to an ACCESS DENIED panel. */}
              {!isTechnician && (
                <Link className="button button-coral" href="/matching">
                  <LuPlus size={13} aria-hidden="true" /> New request
                </Link>
              )}
            </div>
          </div>

          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}

          {loading && (
            <p className="panel-sub" role="status">
              Loading your requests…
            </p>
          )}

          {!loading && requests && requests.length === 0 && (
            <div className="empty-state">
              <LuClipboardList size={22} aria-hidden="true" />
              {isTechnician ? (
                <>
                  <h3>No requests offered yet</h3>
                  <p>
                    A request appears here once Smart Dispatch matches a customer&apos;s job to your
                    profile and you hold an offer on it.
                  </p>
                  <Link className="button button-teal" href="/technician/offers">
                    Go to offers
                  </Link>
                </>
              ) : (
                <>
                  <h3>No service requests yet</h3>
                  <p>Describe what needs fixing and we will look for a local technician.</p>
                  <Link className="button button-teal" href="/matching">
                    Create your first request
                  </Link>
                </>
              )}
            </div>
          )}

          {requests && requests.length > 0 && (
            <ul className="inbox-list">
              {requests.map((request) => (
                <li key={request.id} className="inbox-item">
                  <div className="inbox-item-button">
                    <span className="inbox-item-top">
                      <span className="inbox-item-type">{request.category}</span>
                      <time dateTime={request.createdAt}>
                        {new Date(request.createdAt).toLocaleDateString()}
                      </time>
                    </span>
                    <span className="inbox-item-message">{request.description}</span>
                    <span className="inbox-item-meta">
                      <span className="inbox-channel">
                        <LuMapPin size={11} className="ic" aria-hidden="true" /> {request.city}
                      </span>
                      <Badge tone={STATUS_TONE[request.status]}>
                        {STATUS_LABEL[request.status]}
                      </Badge>
                    </span>
                    <span className="inbox-item-meta">
                      <span className="inbox-channel">
                        {(isTechnician ? TECHNICIAN_STATUS_HINT : STATUS_HINT)[request.status]}
                      </span>
                      {/* For a technician this row IS their own work — naming
                          themselves back as "Technician: …" adds nothing. */}
                      {!isTechnician && request.assignedTechnicianName && (
                        <span className="inbox-channel">
                          Technician: {request.assignedTechnicianName}
                        </span>
                      )}
                      {request.offerCount > 0 && (
                        <span className="inbox-channel">
                          {request.offerCount} offer{request.offerCount === 1 ? '' : 's'} received
                        </span>
                      )}
                    </span>
                  </div>
                  {canMessage(request) && (
                    <Link
                      className="outline-button"
                      href={`/dashboard/messages/${request.id}`}
                      aria-label={`Message the technician about ${request.category}`}
                    >
                      <LuMessageCircle size={13} className="ic" aria-hidden="true" /> Message
                    </Link>
                  )}
                  <RequestWorkflow
                    request={request}
                    isTechnician={isTechnician}
                    onChanged={load}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </DashboardLayout>
  );
}
