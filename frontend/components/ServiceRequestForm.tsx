'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { LuArrowRight, LuCircleAlert, LuCircleCheck, LuLoader } from 'react-icons/lu';
import { isTechnicianCategory } from '@/lib/categories';
import { createServiceRequest } from '@/lib/services/requestService';
import type { ServiceRequest } from '@/lib/types';

/**
 * Task 36 (Stage 5, finding #10): browser idempotency key for a submission.
 * Prefers crypto.randomUUID (secure contexts); falls back to a v4-shaped
 * UUID from getRandomValues (available in every browser and Node ≥ 19,
 * including non-secure contexts). No Web Crypto at all → an honest error:
 * a malformed key would only earn a backend 400.
 */
function newClientRequestId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error(
    'This browser cannot generate a submission id. Please update your browser and try again.',
  );
}

type FormMode = 'editing' | 'reviewing';
type CreateState = 'idle' | 'creating' | 'success' | 'error';

/**
 * The backend decides the request's real dispatch state (a request with no
 * eligible technician is persisted as `no_match`, not `pending`). Showing a
 * literal "Pending" here made the success panel contradict the stored row.
 */
const CREATED_STATUS_LABEL: Record<ServiceRequest['status'], string> = {
  pending: 'Pending — queued for dispatch',
  matching: 'Matching — an eligible technician has been offered the job',
  matched: 'Matched — a technician accepted this request',
  no_match: 'No technician is available right now',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

interface ServiceRequestFormProps {
  description: string;
  category: string;
  /**
   * Called when a service request is successfully created.
   * Lets the parent page display the persisted, server-authoritative
   * request state after the backend has selected an eligible first offer.
   */
  onRequestCreated?: (request: ServiceRequest) => void;
  /**
   * Called when the form resets to editing mode
   * ("Create another request").
   */
  onRequestReset?: () => void;
}

/**
 * Consumer Service Request creation form (V0.2).
 *
 * Two-step flow: EDITING → REVIEWING → confirm → persisted.
 * Does NOT implement dispatch, matching, or lifecycle transitions.
 * The request remains in 'pending' status after creation.
 */
export default function ServiceRequestForm({
  description,
  category,
  onRequestCreated,
  onRequestReset,
}: ServiceRequestFormProps) {
  const [city, setCity] = useState('');
  const [mode, setMode] = useState<FormMode>('editing');
  const [createState, setCreateState] = useState<CreateState>('idle');
  const [createdRequest, setCreatedRequest] = useState<ServiceRequest | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  /**
   * Task 36 (Stage 5): idempotency key for the CURRENT submission attempt.
   * Kept across a failed confirm→confirm-again cycle (a network retry of the
   * same logical submission replays to the same request); cleared when the
   * user goes back to edit or resets, so edited content is a NEW submission.
   */
  const clientRequestIdRef = useRef<string | null>(null);

  const isCreating = createState === 'creating';

  const validate = (): string => {
    // Mirrors the backend request schema (min 8 / max 2000; the textarea
    // already caps input at the maximum via maxLength).
    if (description.trim().length < 8)
      return 'Please describe the problem in at least 8 characters so a technician can diagnose it.';
    if (!category || !isTechnicianCategory(category)) return 'Please select a service category.';
    if (!city.trim()) return 'Please enter a service city.';
    return '';
  };

  const handleReview = (e: React.FormEvent) => {
    e.preventDefault();
    if (isCreating) return;
    const error = validate();
    if (error) {
      setErrorMessage(error);
      setCreateState('error');
      return;
    }
    setErrorMessage('');
    setCreateState('idle');
    setMode('reviewing');
  };

  const handleBackToEdit = () => {
    setMode('editing');
    setErrorMessage('');
    setCreateState('idle');
    // Edited content is a new logical submission — new idempotency key.
    clientRequestIdRef.current = null;
  };

  const handleConfirm = async () => {
    if (isCreating) return;
    setErrorMessage('');
    setCreateState('creating');

    try {
      // Reuse the key from a failed attempt (same submission retried) or
      // mint one for this submission; the backend replays duplicates to the
      // original request instead of creating a second row.
      clientRequestIdRef.current ||= newClientRequestId();
      const request = await createServiceRequest({
        description: description.trim(),
        category: category as ServiceRequest['category'],
        city: city.trim(),
        clientRequestId: clientRequestIdRef.current,
      });
      setCreatedRequest(request);
      setCreateState('success');
      onRequestCreated?.(request);
    } catch (error) {
      // Backend persistence failed: stay in editing mode with the
      // entered data preserved. Nothing is presented as saved.
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create request.');
      setCreateState('error');
      setMode('editing');
    }
  };

  const handleReset = () => {
    setCity('');
    setMode('editing');
    setCreateState('idle');
    setCreatedRequest(null);
    setErrorMessage('');
    clientRequestIdRef.current = null;
    onRequestReset?.();
  };

  if (createState === 'success' && createdRequest) {
    return (
      <section className="request-created" aria-live="polite">
        <div className="request-created-icon">
          <LuCircleCheck size={28} aria-hidden="true" />
        </div>
        <h3>Service Request Created</h3>
        <dl className="request-created-details">
          <div>
            <dt>Request ID</dt>
            <dd>{createdRequest.id}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{createdRequest.category}</dd>
          </div>
          <div>
            <dt>City</dt>
            <dd>{createdRequest.city}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{CREATED_STATUS_LABEL[createdRequest.status]}</dd>
          </div>
        </dl>
        <p className="form-note" role="status">
          {createdRequest.status === 'no_match'
            ? 'We could not find an eligible technician for this category, area and availability right now. Open the request to retry dispatch later or cancel it.'
            : createdRequest.status === 'matching'
              ? 'Dispatch has offered this job to an eligible technician. Chat unlocks when they accept.'
              : 'You can follow the request and its conversation from My Requests.'}
        </p>
        <div className="request-review-actions">
          <Link
            className="button button-coral button-small"
            href={`/dashboard/requests/${createdRequest.id}`}
          >
            Track this request <LuArrowRight size={12} aria-hidden="true" />
          </Link>
          <Link className="outline-button" href="/dashboard">
            Back to dashboard
          </Link>
          <button type="button" className="outline-button" onClick={handleReset}>
            Create another request
          </button>
        </div>
      </section>
    );
  }

  if (mode === 'reviewing') {
    return (
      <section className="request-review" aria-label="Review your request">
        <div className="request-form-header">
        </div>
        <dl className="request-review-details">
          <div>
            <dt>Problem</dt>
            <dd>{description.trim()}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{category}</dd>
          </div>
          <div>
            <dt>Service city</dt>
            <dd>{city.trim()}</dd>
          </div>
        </dl>
        {createState === 'error' && errorMessage && (
          <p className="request-form-error" role="alert">
            <LuCircleAlert size={12} className="ic" aria-hidden="true" /> {errorMessage}
          </p>
        )}
        <div className="request-review-actions">
          <button
            type="button"
            className="outline-button"
            onClick={handleBackToEdit}
            disabled={isCreating}
          >
            Back to Edit
          </button>
          <button
            type="button"
            className="button button-coral button-small"
            onClick={handleConfirm}
            disabled={isCreating}
          >
            {isCreating ? (
              <>
                <LuLoader size={12} className="ic" aria-hidden="true" /> Creating...
              </>
            ) : (
              'Confirm & Create Service Request'
            )}
          </button>
        </div>
      </section>
    );
  }

  return (
    <form className="request-form" onSubmit={handleReview} aria-label="Create service request">
      <div className="request-form-header">
        <p className="form-note">
          Your request is saved securely. When an eligible verified technician is available, the
          platform sends them an offer automatically.
        </p>
      </div>
      <label>
        <span>Service city</span>
        <input
          type="text"
          value={city}
          onChange={(e) => {
            setCity(e.target.value);
            if (createState === 'error') {
              setCreateState('idle');
              setErrorMessage('');
            }
          }}
          placeholder="e.g. Kitwe"
          disabled={isCreating}
        />
      </label>
      {createState === 'error' && errorMessage && (
        <p className="request-form-error" role="alert">
          <LuCircleAlert size={12} className="ic" aria-hidden="true" /> {errorMessage}
        </p>
      )}
      <button
        type="submit"
        className="button button-coral button-small"
        disabled={isCreating || !description.trim() || !category}
      >
        Review Request
      </button>
    </form>
  );
}
