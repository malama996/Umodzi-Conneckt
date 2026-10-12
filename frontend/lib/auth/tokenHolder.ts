/**
 * In-memory access-token holder + single-flight refresh coordination
 * (Task 23; hardened in Task 29).
 *
 * Rules enforced here:
 *   - the access token exists ONLY as this module-level variable (per
 *     browser tab) — never localStorage, never sessionStorage, never a
 *     URL, never React state rendered to components;
 *   - the refresh token is NOT held here at all: it lives exclusively in
 *     the backend-set HttpOnly cookie and is sent with credentialed
 *     fetches to /api/v1/auth/*;
 *   - concurrent 401s share ONE refresh attempt (single-flight), and the
 *     API client retries each original request at most once — refresh
 *     loops are structurally impossible;
 *   - EVERY refresh in the app funnels through tryRefreshOnce(), the
 *     boot session restore included (authStore.ensureAuthInitialized).
 *     Two refreshes racing the same rotating cookie is the failure this
 *     module exists to prevent.
 *
 * Why a single flight matters here (backend/src/auth/sessionService.ts):
 * POST /auth/refresh ROTATES the cookie — the presented session row is
 * revoked and a fresh one issued. The backend tolerates a replay inside a
 * 60s grace window, but a replay OUTSIDE that window is treated as theft
 * and revokes EVERY session for the user. One request in flight at a time
 * keeps us well inside the grace window and stops redundant rejections
 * from being presented at all.
 *
 * This module has zero imports on purpose: lib/api/client.ts depends on
 * it, so anything that imported the API client from here would create a
 * cycle. The auth store injects the refresh callback via
 * setRefreshHandler() at module init.
 */

let accessToken: string | null = null;
let refreshHandler: (() => Promise<boolean>) | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let sessionDead = false;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  // A real credential re-arms refresh: after a successful login (or any
  // later successful refresh) renewing must be possible again.
  if (token !== null) sessionDead = false;
}

/** Injected by lib/auth/authStore.ts (avoids a circular import). */
export function setRefreshHandler(handler: () => Promise<boolean>): void {
  refreshHandler = handler;
}

/**
 * The server REJECTED the presented refresh cookie (401/403).
 *
 * Until a new credential arrives every further attempt would present the
 * same dead cookie. That is not merely wasteful: replaying a merely-rotated
 * cookie outside the backend's rotation grace window revokes every session
 * for the user, so a burst of redundant refreshes is the path to a
 * self-inflicted mass logout. The whole burst is short-circuited instead.
 *
 * Called only by the auth store, and only for a genuine auth rejection —
 * a network failure or a 429 must stay retryable, so neither sets this.
 */
export function markSessionDead(): void {
  sessionDead = true;
}

/** True while a rejected session blocks further refresh attempts. */
export function isSessionDead(): boolean {
  return sessionDead;
}

/**
 * TEST-ONLY seam. This state is a module singleton, so a script-style
 * suite needs a clean slate between independent cases. Runtime state
 * (token, in-flight attempt, dead-session flag) is cleared; the injected
 * refresh HANDLER is deliberately kept — it is module wiring installed by
 * authStore's import side effect, not per-case state.
 * Not referenced by any application code.
 */
export function resetTokenHolderForTests(): void {
  accessToken = null;
  refreshInFlight = null;
  sessionDead = false;
}

/**
 * Run at most ONE refresh attempt at a time, shared by every caller.
 * Returns true only when a fresh access token is now available.
 */
export function tryRefreshOnce(): Promise<boolean> {
  // Already refreshing → share the in-flight promise (the concurrency
  // guarantee: one rotating cookie, one request).
  if (refreshInFlight) return refreshInFlight;
  // Session already proven dead → do not re-present the same cookie.
  if (sessionDead) return Promise.resolve(false);
  const handler = refreshHandler;
  if (!handler) return Promise.resolve(false);
  refreshInFlight = (async () => {
    try {
      return await handler();
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
