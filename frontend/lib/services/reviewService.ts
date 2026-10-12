import { ApiError } from '@/lib/api/client';
import {
  getRequestReview,
  getTechnicianReviews,
  postReview,
  type RequestReviewState,
  type Review,
  type TechnicianReviews,
} from '@/lib/api/reviewsApi';

/**
 * Review service boundary (Task 27). Pages call these helpers — never the
 * API client directly. Display helpers (star labels, validation, error
 * copy) live here so every surface agrees.
 */

export const fetchRequestReview = (requestId: string): Promise<RequestReviewState> =>
  getRequestReview(requestId);

export const fetchTechnicianReviews = (technicianId: string): Promise<TechnicianReviews> =>
  getTechnicianReviews(technicianId);

export const submitReview = (
  requestId: string,
  input: { rating: number; comment?: string },
): Promise<Review> => postReview(requestId, input);

/* ------------------------- display helpers ------------------------- */

/** Whole-star meaning (§5). Index 0 unused so RATING_LABELS[n] reads naturally. */
export const RATING_LABELS: readonly string[] = [
  '',
  'Very poor',
  'Poor',
  'Average',
  'Good',
  'Excellent',
];

export function ratingLabel(rating: number): string {
  return RATING_LABELS[rating] ?? '';
}

/** Client-side mirror of the backend comment rule (server remains authoritative). */
export function validateReviewInput(rating: number, comment: string): string {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return 'Choose a star rating between 1 and 5.';
  }
  const trimmed = comment.trim();
  if (trimmed.length > 0 && trimmed.length < 8) {
    return 'A comment needs at least 8 characters (or leave it empty).';
  }
  if (trimmed.length > 1000) {
    return 'Keep the comment under 1000 characters.';
  }
  return '';
}

/** Human-readable message for a failed review call. */
export function reviewErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session has expired. Please sign in again.';
    if (error.status === 403) return 'You do not have permission to perform this action.';
    try {
      const parsed = JSON.parse(error.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* fall through */
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong while contacting the server.';
}
