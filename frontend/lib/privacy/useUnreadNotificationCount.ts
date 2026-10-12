'use client';

import { useEffect, useState } from 'react';
import { getMyNotifications } from '@/lib/api/privacyApi';
import { useAuth } from '@/lib/auth';

/**
 * Real unread notification count for the sidebar badge (Task 28.3, G-02).
 *
 * Replaces what used to be a hardcoded "2" in the sidebar — a fabricated
 * number that misrepresented an application with no notification history at
 * all. This hook asks the owner-scoped API for the smallest useful page and
 * reads only `unreadCount`.
 *
 * Honest behaviour:
 *   - returns 0 while loading, so the badge simply does not appear yet rather
 *     than flashing a placeholder;
 *   - returns 0 if the request fails, so a network problem never leaves a
 *     stale or invented number on screen;
 *   - no request at all is made for a signed-out visitor, an account that is
 *     still being resolved, or an administrator (whose sidebar deliberately
 *     shows no notification item).
 *
 * The signed-in state comes from the in-memory auth store — NOT from
 * localStorage, because this application never persists tokens or session
 * material to web storage.
 */
export function useUnreadNotificationCount(): number {
  const { status, user } = useAuth();
  const [count, setCount] = useState(0);
  const eligible = status === 'authenticated' && user?.role !== 'administrator';

  useEffect(() => {
    if (!eligible) {
      setCount(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const page = await getMyNotifications(1, 0);
        if (!cancelled) setCount(page.unreadCount);
      } catch {
        // Deliberately silent: a badge is not worth surfacing an error for,
        // and 0 is the truthful "we do not know of any unread item".
        if (!cancelled) setCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eligible]);

  return count;
}
