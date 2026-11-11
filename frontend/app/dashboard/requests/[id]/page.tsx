'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  LuArrowLeft,
  LuCircleAlert,
  LuClipboardList,
  LuMapPin,
  LuMessageCircle,
  LuPhone,
  LuRotateCcw,
  LuUserRound,
} from 'react-icons/lu';

import ContactCallPanel from '@/components/ContactCallPanel';
import RequestLifecycleActions from '@/components/RequestLifecycleActions';
import RequireAuth from '@/components/RequireAuth';
import Reveal from '@/components/Reveal';
import { Badge, Button, DashboardLayout } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  communicationErrorMessage,
  getRequestConversation,
} from '@/lib/api/communicationApi';
import {
  getServiceRequest,
  requestErrorMessage,
  retryServiceRequestDispatch,
  type ServiceRequestDetail,
} from '@/lib/api/serviceRequestsApi';
import { useContactCall } from '@/lib/chat/useContactCall';
import {
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TONE,
  requestStatusHint,
} from '@/lib/requestStatus';

/**
 * /dashboard/requests/[id] — ONE request, tracked end to end (Stage 3).
 *
 * This route closes the navigation gap: the request list, the dashboard cards
 * and the creation success panel all link here, and a refresh or a deep link
 * resolves the same data because everything comes from owner-scoped APIs.
 *
 * Data shown is exactly what the backend authorizes for this session:
 *   - the request row (GET /requests/:id — 404 for strangers, never a leak),
 *   - the conversation (GET /requests/:id/conversation — null until a
 *     technician accepts and active through the whole service window),
 *   - the contact number only through the authorized call hook, which
 *     surfaces an honest "no number" state instead of inventing one.
 *
 * No lifecycle state is invented here: the buttons render the transitions the
 * backend enforces for this role and state, and the server has the final say.
 */
export default function RequestDetailPage() {
  return (
    <RequireAuth>
      <RequestDetailContent />
    </RequireAuth>
  );
}

function RequestDetailContent() {
  const params = useParams();
  const { user } = useAuth();
  const isTechnician = user?.role === 'technician';
  const requestId = typeof params.id === 'string' ? params.id : '';

  const [request, setRequest] = useState<ServiceRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasConversation, setHasConversation] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const contact = useContactCall(hasConversation ? requestId : null);

  const load = useCallback(async () => {
    if (!requestId) {
      setLoadError('No request id was given.');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const detail = await getServiceRequest(requestId);
      setRequest(detail);
      setLoadError(null);
      // Conversation presence is derived, never assumed: a request may be
      // matched without a conversation when the accept flow was interrupted.
      if (detail) {
        try {
          const conversation = await getRequestConversation(requestId);
          setHasConversation(conversation !== null);
        } catch (conversationError) {
          // A conversation failure must not hide the request itself.
          setHasConversation(false);
          console.warn(
            'Conversation lookup failed for request',
            requestId,
            communicationErrorMessage(conversationError),
          );
        }
      } else {
        setHasConversation(false);
      }
    } catch (err) {
      setLoadError(requestErrorMessage(err));
      setRequest(null);
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const retryDispatch = async () => {
    if (!request || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await retryServiceRequestDispatch(request.id);
      await load();
    } catch (err) {
      setRetryError(requestErrorMessage(err));
    } finally {
      setRetrying(false);
    }
  };

  const canRetry =
    !isTechnician && request !== null && request.status === 'no_match';

  return (
    <DashboardLayout active={isTechnician ? 'My Assignments' : 'My Requests'}>
      <main className="dashboard-content">
        <div className="panel">
          <div className="panel-head">
            <div>
              <Link className="outline-button" href="/dashboard/requests">
                <LuArrowLeft size={13} aria-hidden="true" /> Back to requests
              </Link>
              <h2 style={{ marginTop: 12 }}>
                <LuClipboardList size={16} className="ic" aria-hidden="true" />{' '}
                {request ? `${request.category} request` : 'Service request'}
              </h2>
              {request && (
                <p className="panel-sub">
                  <LuMapPin size={11} className="ic" aria-hidden="true" /> {request.city}
                  {' · '}created {new Date(request.createdAt).toLocaleDateString()}
                </p>
              )}
            </div>
            {request && (
              <Badge tone={REQUEST_STATUS_TONE[request.status]}>
                {REQUEST_STATUS_LABEL[request.status]}
              </Badge>
            )}
          </div>

          {loading && (
            <p className="panel-sub" role="status">
              Loading request…
            </p>
          )}

          {!loading && loadError && (
            <p className="inline-error" role="alert">
              <LuCircleAlert size={12} className="ic" aria-hidden="true" /> {loadError}
            </p>
          )}

          {!loading && !request && !loadError && (
            <div className="empty-state">
              <LuClipboardList size={22} aria-hidden="true" />
              <h3>Request not available</h3>
              <p>
                This request does not exist or belongs to another account. That is
                deliberate — a request you do not own is indistinguishable from one
                that is missing.
              </p>
              <Link className="button button-teal" href="/dashboard/requests">
                Back to requests
              </Link>
            </div>
          )}

          {request && (
            <>
              <p className="request-detail-description">{request.description}</p>
              <p className="form-note" role="status">
                {requestStatusHint(request.status, isTechnician)}
              </p>

              {request.assignedTechnicianName && (
                <p className="form-note">
                  <LuUserRound size={11} className="ic" aria-hidden="true" /> Technician:{' '}
                  <strong>{request.assignedTechnicianName}</strong>
                </p>
              )}

              <div className="request-workflow-actions">
                {hasConversation && (
                  <Link
                    className="button button-teal"
                    href={`/dashboard/messages/${request.id}`}
                  >
                    <LuMessageCircle size={13} aria-hidden="true" /> Open conversation
                  </Link>
                )}
                {hasConversation && (
                  <Button
                    type="button"
                    className="outline-button"
                    onClick={() =>
                      void contact.call({ label: request.assignedTechnicianName ?? null })
                    }
                    disabled={contact.state.status === 'working'}
                  >
                    <LuPhone size={13} aria-hidden="true" />{' '}
                    {contact.state.status === 'working' ? 'Connecting…' : 'Call'}
                  </Button>
                )}
                {canRetry && (
                  <button
                    type="button"
                    className="button button-coral button-small"
                    disabled={retrying}
                    onClick={() => void retryDispatch()}
                  >
                    <LuRotateCcw size={12} className="ic" aria-hidden="true" />{' '}
                    {retrying ? 'Looking again…' : 'Look for a technician again'}
                  </button>
                )}
              </div>

              <ContactCallPanel state={contact.state} onCopy={contact.copy} />

              {retryError && (
                <p className="inline-error" role="alert">
                  <LuCircleAlert size={12} className="ic" aria-hidden="true" /> {retryError}
                </p>
              )}

              <Reveal>
                <RequestLifecycleActions
                  request={request}
                  isTechnician={isTechnician}
                  onChanged={load}
                />
              </Reveal>
            </>
          )}
        </div>
      </main>
    </DashboardLayout>
  );
}
