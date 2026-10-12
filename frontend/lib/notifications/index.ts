/**
 * In-app notification abstraction (Task 22).
 *
 * UI and application code import from this barrel only:
 *
 *   import { notifySuccess, notifyWarning, entityStateKey } from '@/lib/notifications';
 *
 * In-app (aria-live toast) delivery only — no browser notification
 * permission, SMS, email, or push infrastructure exists here.
 */
export type { AppNotification, NotificationInput, NotificationTone } from './types';
export {
  clearNotifications,
  dismissNotification,
  entityStateKey,
  getNotifications,
  notify,
  notifyError,
  notifyInfo,
  notifySuccess,
  notifyWarning,
  resetNotificationStore,
  subscribeNotifications,
  wasNotificationObserved,
} from './store';
export { useNotifications } from './useNotifications';
export type { UseNotificationsResult } from './useNotifications';
