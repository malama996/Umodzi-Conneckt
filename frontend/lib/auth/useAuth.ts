'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { ensureAuthInitialized, getAuthSnapshot, subscribeAuth } from './authStore';
import type { AuthState } from './authTypes';

/**
 * React binding for the auth store (Task 23).
 *
 * On first mount it kicks off the single startup refresh so the app
 * resolves from 'loading' → 'authenticated' | 'anonymous'. Components
 * must treat 'loading' as "not yet known" and keep protected content
 * hidden (see components/RequireAuth.tsx).
 */
export function useAuth(): AuthState {
  const state = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot);

  useEffect(() => {
    void ensureAuthInitialized();
  }, []);

  return state;
}
