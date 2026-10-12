'use client';
import { useState } from 'react';
import { LuCircleAlert, LuCircleCheck, LuLoader } from 'react-icons/lu';
import { isTechnicianCategory } from '@/lib/categories';
import { createServiceRequest } from '@/lib/services/requestService';
import type { ServiceRequest } from '@/lib/types';

type FormMode = 'editing' | 'reviewing';
type CreateState = 'idle' | 'creating' | 'success' | 'error';

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
  };

  const handleConfirm = async () => {
    if (isCreating) return;
    setErrorMessage('');
    setCreateState('creating');

    try {
      const request = await createServiceRequest({
        description: description.trim(),
        category: category as ServiceRequest['category'],
        city: city.trim(),
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
            <dd>Pending</dd>
          </div>
        </dl>
        <button type="button" className="outline-button" onClick={handleReset}>
          Create another request
        </button>
      </section>
    );
  }

  if (mode === 'reviewing') {
    return (
      <section className="request-review" aria-label="Review your request">
        <div className="request-form-header">
          <span className="eyebrow eyebrow-dark">REVIEW YOUR REQUEST</span>
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
        <span className="eyebrow eyebrow-dark">CREATE SERVICE REQUEST</span>
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
