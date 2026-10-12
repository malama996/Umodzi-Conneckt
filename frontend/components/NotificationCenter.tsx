'use client';

/**
 * In-app notification toasts (Task 22).
 *
 * Mounted once in the root layout so every page renders the same
 * notification surface. Accessibility:
 *
 * - The live region container is always in the DOM (even when empty)
 *   so screen readers reliably announce later insertions.
 * - `aria-live="polite"` announces without interrupting.
 * - Tone is conveyed by a visible text label + icon, never colour alone.
 * - Dismiss controls are real buttons: keyboard accessible with the
 *   global visible focus style.
 */
import { LuCircleAlert, LuCircleCheck, LuInfo, LuTriangleAlert, LuX } from 'react-icons/lu';
import { useNotifications } from '@/lib/notifications';
import type { NotificationTone } from '@/lib/notifications';

const TONE_LABEL: Record<NotificationTone, string> = {
  success: 'Success',
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
};

function ToneIcon({ tone }: { tone: NotificationTone }) {
  const size = 14;
  if (tone === 'success') return <LuCircleCheck size={size} aria-hidden="true" />;
  if (tone === 'warning') return <LuTriangleAlert size={size} aria-hidden="true" />;
  if (tone === 'error') return <LuCircleAlert size={size} aria-hidden="true" />;
  return <LuInfo size={size} aria-hidden="true" />;
}

export default function NotificationCenter() {
  const { notifications, dismiss, dismissAll } = useNotifications();

  return (
    <div
      className="notification-center"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      aria-atomic="false"
    >
      {notifications.length > 1 && (
        <button type="button" className="notification-dismiss-all" onClick={dismissAll}>
          Dismiss all
        </button>
      )}
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className={`notification-toast notification-toast-${notification.tone}`}
        >
          <span className="notification-tone">
            <ToneIcon tone={notification.tone} />
            {TONE_LABEL[notification.tone]}
          </span>
          <div className="notification-body">
            <strong>{notification.title}</strong>
            {notification.message && <p>{notification.message}</p>}
          </div>
          <button
            type="button"
            className="notification-dismiss"
            aria-label={`Dismiss notification: ${notification.title}`}
            onClick={() => dismiss(notification.id)}
          >
            <LuX size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
