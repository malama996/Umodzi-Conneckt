'use client';

import { useState } from 'react';
import { LuCircleAlert } from 'react-icons/lu';

import ReviewCard from '@/components/ReviewCard';
import { Button } from '@/components/ui';
import {
  requestErrorMessage,
  updateServiceRequestStatus,
  type MyServiceRequest,
} from '@/lib/api/serviceRequestsApi';

type LifecycleRequest = Pick<
  MyServiceRequest,
  'id' | 'status' | 'assignedTechnicianName'
>;

/**
 * The ONE set of lifecycle controls rendered by both the request list and the
 * request detail page.
 *
 * The buttons are a convenience, never the guard: the backend checks that a
 * technician holds the accepted offer for `in_progress`/`completed`, that the
 * transition is legal for the current state, and that a closed request cannot
 * be reopened. The customer action is deliberately limited to confirming a job
 * that is already in progress — a customer cannot invent a match or skip
 * dispatch from the UI.
 */
export default function RequestLifecycleActions({
  request,
  isTechnician,
  onChanged,
}: {
  request: LifecycleRequest;
  isTechnician: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<'in_progress' | 'completed' | 'cancelled' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const awarded = request.assignedTechnicianName !== null;
  const canStartWork = isTechnician && awarded && request.status === 'matched';
  const canCompleteWork = isTechnician && awarded && request.status === 'in_progress';
  const canConfirmCompletion = !isTechnician && request.status === 'in_progress';
  // A customer may withdraw a request that has not reached a terminal state.
  // Cancelling a matched/in-progress job also cancels its pending offers on the
  // server; the accepted technician keeps the history and is notified.
  const canCancel =
    !isTechnician &&
    (request.status === 'pending' ||
      request.status === 'matching' ||
      request.status === 'matched' ||
      request.status === 'in_progress');

  const advance = async (status: 'in_progress' | 'completed' | 'cancelled') => {
    setBusy(status);
    setError(null);
    try {
      await updateServiceRequestStatus(request.id, status);
      setConfirmingCancel(false);
      await onChanged();
    } catch (err) {
      setError(requestErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const hasActions =
    canStartWork || canCompleteWork || canConfirmCompletion || canCancel || request.status === 'completed';

  if (!hasActions) return null;

  return (
    <div className="request-workflow">
      {(canStartWork || canCompleteWork || canConfirmCompletion || canCancel) && (
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
          {canCompleteWork && (
            <Button
              type="button"
              className="button button-teal"
              disabled={busy !== null}
              onClick={() => void advance('completed')}
            >
              {busy === 'completed' ? 'Saving…' : 'Mark service as completed'}
            </Button>
          )}
          {canConfirmCompletion && (
            <Button
              type="button"
              className="button button-teal"
              disabled={busy !== null}
              onClick={() => void advance('completed')}
            >
              {busy === 'completed' ? 'Saving…' : 'Confirm service completed'}
            </Button>
          )}
          {canCancel && !confirmingCancel && (
            <Button
              type="button"
              className="outline-button"
              disabled={busy !== null}
              onClick={() => setConfirmingCancel(true)}
            >
              Cancel request
            </Button>
          )}
          {canCancel && confirmingCancel && (
            <>
              <Button
                type="button"
                className="outline-button"
                disabled={busy !== null}
                onClick={() => void advance('cancelled')}
              >
                {busy === 'cancelled' ? 'Cancelling…' : 'Yes, cancel this request'}
              </Button>
              <Button
                type="button"
                className="outline-button"
                disabled={busy !== null}
                onClick={() => setConfirmingCancel(false)}
              >
                Keep request
              </Button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          <LuCircleAlert size={12} className="ic" aria-hidden="true" /> {error}
        </p>
      )}
      {/* Rating and written review, offered only once the request is
          completed (and only to the customer who owns it). ReviewCard asks
          the server for eligibility and renders nothing when not allowed. */}
      {request.status === 'completed' && !isTechnician && (
        <ReviewCard requestId={request.id} technicianName={request.assignedTechnicianName} />
      )}
    </div>
  );
}
