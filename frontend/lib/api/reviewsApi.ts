import { ApiError, get, post } from './client';

/**
 * Reviews API (Task 27) — wire shapes mirror the backend exactly.
 * customer/technician ids are always derived server-side; the client only
 * ever sends rating + optional comment.
 */

export interface Review {
  id: string;
  rating: number;
  comment: string | null;
  customerName: string;
  createdAt: string;
}

/** Owner/admin view of the review state for one service request. */
export interface RequestReviewState {
  review: Review | null;
  eligible: boolean;
  technicianName: string | null;
}

export interface ReviewSummary {
  average: number | null;
  count: number;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export interface TechnicianReviews {
  technicianId: string;
  summary: ReviewSummary;
  reviews: Review[];
}

interface Envelope<T> {
  data: T;
}

/** GET /requests/:id/review — review state for the owning customer. */
export async function getRequestReview(requestId: string): Promise<RequestReviewState> {
  const body = await get<Envelope<RequestReviewState>>(
    `/requests/${encodeURIComponent(requestId)}/review`,
  );
  return body.data;
}

/** POST /requests/:id/review — submit the customer's review. */
export async function postReview(
  requestId: string,
  input: { rating: number; comment?: string },
): Promise<Review> {
  const body = await post<Envelope<Review>>(
    `/requests/${encodeURIComponent(requestId)}/review`,
    input,
  );
  return body.data;
}

/** GET /technicians/:id/reviews — public reputation bundle. */
export async function getTechnicianReviews(technicianId: string): Promise<TechnicianReviews> {
  const body = await get<Envelope<TechnicianReviews>>(
    `/technicians/${encodeURIComponent(technicianId)}/reviews`,
  );
  return body.data;
}

/** getRequestReview variant that maps 404 to null (missing request). */
export async function getRequestReviewOrNull(
  requestId: string,
): Promise<RequestReviewState | null> {
  try {
    return await getRequestReview(requestId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
