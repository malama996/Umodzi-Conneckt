'use client';

import { useCallback, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { logout } from '@/lib/auth';

/**
 * Fast, flicker-free logout action.
 *
 * Pre-navigates away from protected routes to `/login` immediately so
 * `RequireAuth` never unmounts the page into a "Checking session..." white screen.
 */
export function useLogoutAction() {
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const gated =
        pathname === '/matching' ||
        pathname.startsWith('/dashboard') ||
        pathname.startsWith('/technician') ||
        pathname.startsWith('/admin');

      // Instant pre-navigation: switch view before destroying session state
      if (gated) {
        router.replace('/login');
      } else {
        router.push('/');
      }

      await logout();
    } finally {
      setBusy(false);
    }
  }, [pathname, router]);

  return { busy, run };
}
