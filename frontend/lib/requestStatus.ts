import type { ServiceRequestStatus } from '@/lib/types';

/**
 * ONE presentation contract for the 7 persisted request statuses, shared by
 * the dashboard list, request detail page and technician assignments.
 *
 * These are labels and hints only — the backend remains the owner of the
 * lifecycle. Keeping them in one module prevents two screens from describing
 * the same status differently.
 */

export type RequestStatusTone = 'success' | 'warning' | 'neutral' | 'teal' | 'coral';

export const REQUEST_STATUS_LABEL: Record<ServiceRequestStatus, string> = {
  pending: 'Pending',
  matching: 'Finding a technician',
  matched: 'Matched',
  no_match: 'No technician found',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const REQUEST_STATUS_TONE: Record<ServiceRequestStatus, RequestStatusTone> = {
  pending: 'neutral',
  matching: 'teal',
  matched: 'success',
  no_match: 'coral',
  in_progress: 'teal',
  completed: 'success',
  cancelled: 'neutral',
};

export const REQUEST_STATUS_HINT: Record<ServiceRequestStatus, string> = {
  pending: 'Your request is queued for dispatch.',
  matching: 'Dispatch is contacting eligible technicians.',
  matched: 'A technician accepted this request.',
  no_match: 'No eligible technician is available right now. You can retry dispatch or cancel.',
  in_progress: 'Your technician is working on this request.',
  completed: 'This request is closed. You can review the technician from the request list.',
  cancelled: 'This request was cancelled.',
};

export const TECHNICIAN_REQUEST_STATUS_HINT: Record<ServiceRequestStatus, string> = {
  ...REQUEST_STATUS_HINT,
  matched: 'You accepted this request. Start work when you arrive on site.',
  no_match: 'Dispatch could not place this request with you.',
  in_progress: 'You are working on this request. Mark it completed when the job is done.',
  completed: 'You completed this request.',
  cancelled: 'This request was cancelled by the customer or an administrator.',
};

export function requestStatusHint(
  status: ServiceRequestStatus,
  isTechnician: boolean,
): string {
  return (isTechnician ? TECHNICIAN_REQUEST_STATUS_HINT : REQUEST_STATUS_HINT)[status];
}
