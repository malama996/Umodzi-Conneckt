'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { getTechnicianOffers } from '@/lib/api/offersApi';

/**
 * Pending-offers count for the signed-in technician (Phase 3 drawer badge).
 *
 * Approved approximation of an "unseen offers" badge: the platform tracks
 * no read/seen state, so the badge counts offers whose status is still
 * 'pending' — real data from the existing owner-scoped endpoint, no new
 * backend. It is 0 (and therefore hidden) for every other role, on failure
 * and while loading — never a fabricated number (same rule as the
 * Notifications badge, Task 28.3).
 */
export function usePendingOffersCount(): number {
  const { status, user } = useAuth();
  const [count, setCount] = useState(0);

  const technicianId = user?.role === 'technician' ? user.technicianId : undefined;

  const refresh = useCallback(async () => {
    if (status !== 'authenticated' || !technicianId) {
      setCount(0);
      return;
    }
    try {
      const offers = await getTechnicianOffers(technicianId);
      setCount(offers.filter((offer) => offer.status === 'pending').length);
    } catch {
      // Badge-only surface: a failed count hides the badge, never breaks nav.
      setCount(0);
    }
  }, [status, technicianId]);

  useEffect(() => {
    void refresh();
    // Re-count when the tab regains focus — offers can be accepted or
    // dispatched while the app is backgrounded (installed PWA).
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return count;
}
