'use client';
/**
 * React binding for the in-app notification store (Task 22).
 * Uses useSyncExternalStore so server and client snapshots stay
 * consistent (the store is empty during SSR/hydration).
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  clearNotifications,
  dismissNotification,
  getNotifications,
  subscribeNotifications,
} from './store';
import type { AppNotification } from './types';

export interface UseNotificationsResult {
  notifications: AppNotification[];
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

export function useNotifications(): UseNotificationsResult {
  const notifications = useSyncExternalStore(
    subscribeNotifications,
    getNotifications,
    getNotifications,
  );
  const dismiss = useCallback((id: string) => dismissNotification(id), []);
  const dismissAll = useCallback(() => clearNotifications(), []);
  return { notifications, dismiss, dismissAll };
}
