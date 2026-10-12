'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { homeForRole } from '@/lib/auth/homeForRole';

/**
 * Keeps signed-in visitors off the public landing page (Phase 2, §8).
 *
 * Behaviour:
 *   - status 'loading'       → render nothing and DO NOT navigate. Session
 *                              restoration must never redirect early or flash
 *                              the wrong workspace.
 *   - status 'anonymous'     → render nothing; the public page stays put.
 *   - status 'authenticated' → a single replace() to the role's home.
 *
 * The role always comes from the backend session, never from the URL or
 * client storage. This component renders `null`, so no landing markup
 * changes and no protected data is ever mounted here — the redirect is a
 * convenience for navigation, not a security control (the API and
 * RequireAuth remain the actual enforcement).
 */
export default function HomeAuthRedirect() {
  const { status, user } = useAuth();
  const router = useRouter();
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    if (status !== 'authenticated' || !user) return;
    const home = homeForRole(user.role);
    if (home === '/') return; // unknown role — leave the visitor where they are
    sent.current = true;
    router.replace(home);
  }, [status, user, router]);

  return null;
}
