import {
  login as apiLogin,
  logout as apiLogout,
  refresh as apiRefresh,
  register as apiRegister,
} from '@/lib/api/authApi';
import { ApiError } from '@/lib/api/client';
import {
  markSessionDead,
  resetTokenHolderForTests,
  setAccessToken,
  setRefreshHandler,
  tryRefreshOnce,
} from './tokenHolder';
import type { AuthPayload, AuthState, RegisterInput } from './authTypes';

/**
 * Auth state store (Task 23) — a tiny external store consumed via
 * useSyncExternalStore (same pattern as the notification store).
 *
 * Responsibilities:
 *   - expose { status, user } to the app (the access token itself stays
 *     in tokenHolder — components never see it);
 *   - restore the session on startup through ONE refresh call (the
 *     HttpOnly cookie carries the refresh token);
 *   - provide login/logout/register actions;
 *   - serve as the API client's single 401→refresh handler, retrying
 *     the original request exactly once (client-side) — and flipping the
 *     whole app to 'anonymous' when the session is truly gone.
 *
 * No JWT logic lives in components; no auth state is persisted to
 * localStorage — the refresh cookie is the only durable credential.
 */

type Listener = () => void;

let state: AuthState = { status: 'loading', user: null };
const listeners = new Set<Listener>();

function setState(next: AuthState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot reference — only changes when the state actually changes. */
export function getAuthSnapshot(): AuthState {
  return state;
}

let initPromise: Promise<void> | null = null;

/**
 * Startup session restore (§33): attempt a refresh; authenticated on
 * success, anonymous otherwise. Idempotent — every caller shares the
 * first in-flight attempt.
 *
 * Task 29: this now goes through tryRefreshOnce() rather than calling the
 * refresh endpoint directly. Boot previously ran its own refresh OUTSIDE
 * the single flight, so a protected request firing while the boot refresh
 * was still in flight (accessToken is still null, so it 401s) started a
 * SECOND refresh with the same rotating cookie. Both are now coalesced
 * into one request.
 */
export function ensureAuthInitialized(): Promise<void> {
  initPromise ??= (async () => {
    try {
      // The refresh handler has already applied the payload on success.
      const refreshed = await tryRefreshOnce();
      if (!refreshed) {
        setAccessToken(null);
        setState({ status: 'anonymous', user: null });
      }
    } catch {
      // Handler failures are swallowed inside the handler; this only
      // guards against a throwing handler so init never rejects.
      setAccessToken(null);
      setState({ status: 'anonymous', user: null });
    }
  })();
  return initPromise;
}

function applyPayload(payload: AuthPayload): void {
  setAccessToken(payload.accessToken);
  setState({ status: 'authenticated', user: payload.user });
}

/** Sign in with credentials (throws ApiError on failure — never logs them). */
export async function login(email: string, password: string): Promise<void> {
  const payload = await apiLogin(email, password);
  applyPayload(payload);
}

/**
 * Register a customer/technician account. Registration does NOT create a
 * session — the caller redirects to /login so the user signs in normally.
 */
export async function register(input: RegisterInput): Promise<void> {
  await apiRegister(input);
}

/** Logout: revoke the session server-side, then clear local state. */
export async function logout(): Promise<void> {
  try {
    await apiLogout();
  } catch {
    // Best effort — the local session is cleared regardless, and a
    // stale cookie can no longer authenticate anything by itself.
  }
  // The server has revoked this session and cleared the cookie, so no
  // later request may try to refresh with it. A subsequent login clears
  // this flag (setAccessToken re-arms refresh), so it cannot stick.
  markSessionDead();
  setAccessToken(null);
  setState({ status: 'anonymous', user: null });
}

// Register as the API client's refresh handler (module side effect —
// imported by RequireAuth / AuthForm / AuthNav before any request runs).
// Every refresh in the app reaches this callback through
// tokenHolder.tryRefreshOnce(), so the rotating cookie is presented by
// exactly one request at a time.
setRefreshHandler(async () => {
  try {
    const payload = await apiRefresh();
    applyPayload(payload);
    return true;
  } catch (error) {
    setAccessToken(null);
    setState({ status: 'anonymous', user: null });
    // Only a server-side rejection is definitive. A network failure or a
    // 429 must stay retryable, so neither is allowed to kill the session;
    // a 401 from /auth/refresh means the cookie itself is gone, and the
    // rest of a simultaneous 401 burst must not re-present it.
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      markSessionDead();
    }
    return false;
  }
});

/**
 * TEST-ONLY seam (see tokenHolder.resetTokenHolderForTests). Not
 * referenced by any application code.
 */
export function resetAuthStoreForTests(): void {
  initPromise = null;
  state = { status: 'loading', user: null };
  for (const listener of listeners) listener();
  resetTokenHolderForTests();
}
