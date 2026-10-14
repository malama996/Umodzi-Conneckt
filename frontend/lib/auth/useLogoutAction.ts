'use client';

import { useCallback, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { logout } from '@/lib/auth';

/**
 * The ONE logout action (Phase 2 P0 + §3/§4).
 *
 * Logout used to be `<Link href="/">`, which only changed the URL: the
 * HttpOnly refresh cookie survived, so the user believed they had signed out
 * while the session was still fully usable. This hook revokes the refresh
 * session SERVER-SIDE first (the store's `logout()`), then decides who owns
 * the navigation:
 *
 *   - On a gated page, `RequireAuth` already redirects the moment the store
 *     flips to anonymous. Navigating from here would race that redirect —
 *     both transitions abort and the router stalls — so the gate owns the
 *     single transition and we navigate nowhere.
 *   - On an ungated page there is no gate, so we return to the landing page
 *     ourselves.
 *
 * `busy` guards a double tap (the button is also disabled while it runs).
 */
export function useLogoutAction() {
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      await logout();
      const gated =
        pathname === '/matching' ||
        pathname.startsWith('/dashboard') ||
        pathname.startsWith('/technician') ||
        pathname.startsWith('/admin');
      if (!gated) router.push('/');
    } finally {
      setBusy(false);
    }
  }, [pathname, router]);

  return { busy, run };
}
