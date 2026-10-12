import { get, post, patch, del, ApiError } from './client';

/**
 * Data-subject privacy API client (Task 28.3C / 28.3D) and the notification
 * inbox (28.3C, closing gap G-02).
 *
 * Every call here is owner-scoped by the BACKEND: the recipient/owner is
 * always taken from the authenticated session, so there is deliberately no
 * user id, recipient or owner parameter anywhere in this module. The only
 * identifiers sent are the notification ids the caller already owns and the
 * one account they are acting on.
 */

/* ------------------------------------------------------------------ */
/* Types — mirror the real API payloads                                */
/* ------------------------------------------------------------------ */

export interface AccountDeletionCounts {
  service_requests?: number;
  reviews_written?: number;
  notifications?: number;
  push_subscriptions?: number;
  sessions?: number;
  technician_profiles?: number;
  verification_documents?: number;
  retained_security_events?: number;
}

export interface DeletionPreview {
  counts: AccountDeletionCounts;
  retainedAfterDeletion: {
    securityEvents: string;
    reviewRecipients: string;
  };
  warning: string;
}

export interface DeletionReport {
  technicianProfileDeleted: boolean;
  serviceRequestsDeleted: number;
  offersDeleted: number;
  reviewsDeleted: number;
  reviewsAuthoredDeleted: number;
  reviewsAboutProfileDeleted: number;
  notificationsDeleted: number;
  pushSubscriptionsDeleted: number;
  sessionsDeleted: number;
  verificationDocumentsDeleted: number;
  storageObjectsDeleted: number;
  storageObjectsFailed: number;
}

export interface AccountDeletionResult {
  deleted: boolean;
  alreadyDeleted: boolean;
  report: DeletionReport | null;
}

/**
 * The full export shape is intentionally typed loosely at the top level:
 * it is a structured, machine-readable snapshot whose exact keys evolve with
 * the processing activities. The parts the UI renders (counts) are typed.
 */
export interface AccountExport {
  format: string;
  generatedAt: string;
  counts: Record<string, number>;
  exclusions: string[];
  [section: string]: unknown;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  channel: string;
  referenceType: string | null;
  referenceId: string | null;
  read: boolean;
  status: string;
  createdAt: string;
  sentAt: string | null;
  readAt: string | null;
}

export interface NotificationPage {
  notifications: NotificationItem[];
  unreadCount: number;
  totalCount: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface Envelope<T> {
  data: T;
}

/* ------------------------------------------------------------------ */
/* 28.3C — access / export                                            */
/* ------------------------------------------------------------------ */

/** Fetch the caller's own data export (real data, assembled server-side). */
export async function getMyData(): Promise<AccountExport> {
  const body = await get<Envelope<AccountExport>>('/me/data');
  return body.data;
}

/* ------------------------------------------------------------------ */
/* 28.3D — permanent deletion                                         */
/* ------------------------------------------------------------------ */

/** Read what deletion would remove. Removes nothing. */
export async function getDeletionPreview(): Promise<DeletionPreview> {
  const body = await get<Envelope<DeletionPreview>>('/me/account/deletion-preview');
  return body.data;
}

/**
 * Permanently delete the caller's account.
 *
 * `confirm` must be the exact literal the backend requires, and `password`
 * re-authenticates the request. Both are enforced server-side; the UI mirrors
 * them only so the user sees the same requirement before submitting.
 */
export async function deleteMyAccount(
  password: string,
  confirm: string,
): Promise<AccountDeletionResult> {
  const body = await del<Envelope<AccountDeletionResult>>('/me/account', {
    password,
    confirm,
  });
  return body.data;
}

/** The exact acknowledgement literal the API requires. Single source of truth. */
export const DELETION_CONFIRMATION_PHRASE = 'DELETE MY ACCOUNT';

/* ------------------------------------------------------------------ */
/* Notification inbox (G-02)                                          */
/* ------------------------------------------------------------------ */

export async function getMyNotifications(limit = 25, offset = 0): Promise<NotificationPage> {
  const body = await get<Envelope<NotificationPage>>(
    `/me/notifications?limit=${limit}&offset=${offset}`,
  );
  return body.data;
}

export async function markNotificationRead(id: string): Promise<void> {
  await patch<Envelope<{ id: string; read: boolean }>>(`/me/notifications/${id}/read`);
}

/** Returns the REAL number of notifications changed (may legitimately be 0). */
export async function markAllNotificationsRead(): Promise<number> {
  const body = await post<Envelope<{ updated: number }>>('/me/notifications/read-all');
  return body.data.updated;
}

/* ------------------------------------------------------------------ */
/* Human-readable error text                                           */
/* ------------------------------------------------------------------ */

/** Safe, user-facing message for a privacy action failure. */
export function privacyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as {
        error?: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
      if (error.status === 400 && parsed.details?.fieldErrors) {
        const first = Object.values(parsed.details.fieldErrors)[0]?.[0];
        if (first) return first;
      }
      if (parsed.error) return parsed.error;
    } catch {
      /* non-JSON body */
    }
    if (error.status === 401) return 'Your password confirmation was not accepted.';
    if (error.status === 403) return 'Your account does not have access to this action.';
    if (error.status === 429) return 'Too many attempts — please wait a moment and try again.';
    if (error.status >= 500) return 'Something went wrong on our side. Please try again.';
  }
  return 'Unable to reach the server. Check your connection and try again.';
}
