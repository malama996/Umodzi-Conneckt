/**
 * In-app notification types (Task 22).
 *
 * Notifications are presentation-layer feedback only: they never
 * mutate domain state, never trigger persistence, and never leave
 * the browser (no browser permission prompts, SMS, email, or push).
 */

/** Visual/semantic tone of a notification. */
export type NotificationTone = 'success' | 'info' | 'warning' | 'error';

/** Input required to raise a notification. */
export interface NotificationInput {
  tone: NotificationTone;
  /** Short headline (e.g. "Offer accepted"). */
  title: string;
  /** Optional supporting detail — factual backend data only. */
  message?: string;
  /**
   * Deterministic entity+state key (e.g. `request:<uuid>:accepted`)
   * used to suppress duplicate deliveries of the same event. Once a
   * key has been observed in this browser session, later attempts to
   * notify with the same key are ignored.
   */
  dedupeKey?: string;
}

/** A stored notification ready for rendering. */
export interface AppNotification extends NotificationInput {
  id: string;
  createdAt: number;
}
