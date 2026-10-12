'use client';

import { useCallback, useEffect, useState } from 'react';
import { LuCircleAlert, LuCircleCheck, LuStar } from 'react-icons/lu';
import { notifyError, notifySuccess } from '@/lib/notifications/store';
import type { Review } from '@/lib/api/reviewsApi';
import {
  fetchRequestReview,
  ratingLabel,
  reviewErrorMessage,
  submitReview,
  validateReviewInput,
} from '@/lib/services/reviewService';
import { formatTimestamp } from '@/lib/services/adminService';

/**
 * Customer review card (Task 27 §17) — shown on /matching once the active
 * request is completed.
 *
 * The backend decides eligibility; this card only renders the form when
 * GET /requests/:id/review says `eligible`. After submission it shows the
 * persisted review ("Reviewed") and the form can never resubmit (the
 * backend enforces one review per completed service with 409 + a unique
 * index).
 */
export default function ReviewCard({
  requestId,
  technicianName,
  onReviewed,
}: {
  requestId: string;
  technicianName: string | null;
  onReviewed?: (review: Review) => void;
}) {
  const [state, setState] = useState<'loading' | 'form' | 'reviewed' | 'hidden'>('loading');
  const [existing, setExisting] = useState<Review | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const current = await fetchRequestReview(requestId);
      if (current.review) {
        setExisting(current.review);
        setState('reviewed');
      } else if (current.eligible) {
        setState('form');
      } else {
        setState('hidden');
      }
    } catch {
      setState('hidden');
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    const validation = validateReviewInput(rating, comment);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const trimmed = comment.trim();
      const review = await submitReview(requestId, {
        rating,
        ...(trimmed ? { comment: trimmed } : {}),
      });
      setExisting(review);
      setState('reviewed');
      notifySuccess({
        title: 'Review submitted',
        message: 'Thank you for sharing your experience.',
      });
      onReviewed?.(review);
    } catch (err) {
      const message = reviewErrorMessage(err);
      setError(message);
      notifyError({ title: 'Could not submit the review', message });
    } finally {
      setBusy(false);
    }
  };

  if (state === 'hidden') return null;

  return (
    <section className="t27-review" aria-label="Service review">
      {state === 'loading' && <p className="admin-state">Checking review status…</p>}

      {state === 'reviewed' && existing && (
        <div className="t27-review-done">
          <h3>
            <LuCircleCheck size={14} aria-hidden="true" /> Your review
          </h3>
          <p className="t27-stars" aria-label={`You rated ${existing.rating} of 5`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <LuStar
                key={n}
                size={16}
                aria-hidden="true"
                fill={n <= existing.rating ? 'currentColor' : 'none'}
              />
            ))}
            <span className="t27-stars-label">{ratingLabel(existing.rating)}</span>
          </p>
          {existing.comment && <p className="t27-review-comment">{existing.comment}</p>}
          <small className="admin-note">
            Reviewed {technicianName ?? 'the technician'} · {formatTimestamp(existing.createdAt)}
          </small>
        </div>
      )}

      {state === 'form' && (
        <div className="t27-review-form">
          <h3>How was your service{technicianName ? ` with ${technicianName}` : ''}?</h3>
          <div className="t27-star-select" role="group" aria-label="Choose a star rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={`t27-star ${rating >= n ? 't27-star-on' : ''}`}
                aria-pressed={rating === n}
                aria-label={`Rate ${n} of 5 — ${ratingLabel(n)}`}
                onClick={() => {
                  setRating(n);
                  setError('');
                }}
              >
                <LuStar size={22} aria-hidden="true" fill={rating >= n ? 'currentColor' : 'none'} />
              </button>
            ))}
            <span className="t27-stars-label" aria-live="polite">
              {rating > 0 ? ratingLabel(rating) : 'Tap a star'}
            </span>
          </div>
          <label className="t27-comment">
            <span>
              Tell us about your experience{' '}
              <small className="t26-counter">{comment.trim().length}/1000</small>
            </span>
            <textarea
              value={comment}
              rows={3}
              maxLength={1000}
              placeholder="Example: The technician arrived on time and fixed the fault quickly. Very professional service."
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          {error && (
            <p className="profile-status profile-status-error" role="alert">
              <LuCircleAlert size={12} aria-hidden="true" /> {error}
            </p>
          )}
          <button
            type="button"
            className="button button-coral button-small"
            disabled={busy || rating === 0}
            onClick={() => void submit()}
          >
            {busy ? 'Submitting…' : 'Submit review'}
          </button>
        </div>
      )}
    </section>
  );
}
