/**
 * Central HTTP boundary for frontend → backend communication (Task 21B).
 *
 * All backend calls go through these helpers — React components and
 * application services must not scatter raw fetch() calls.
 * Uses NEXT_PUBLIC_API_BASE_URL; contains no secrets or credentials.
 *
 * Task 23 additions (still the single HTTP boundary):
 *   - every request carries `credentials: 'include'` so the HttpOnly
 *     refresh cookie reaches /api/v1/auth/* (CORS is an explicit origin
 *     allow-list with credentials enabled on the backend);
 *   - the in-memory access token is attached as `Authorization: Bearer`;
 *   - a 401 on a protected request triggers ONE coordinated refresh
 *     (single-flight) and retries the original request EXACTLY once —
 *     never more, never for /auth/* endpoints (no refresh loops).
 */

import { getAccessToken, tryRefreshOnce } from '@/lib/auth/tokenHolder';

/** Error thrown for non-2xx API responses. Never includes secrets. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    super(`API ${status} ${statusText}: ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function baseUrl(): string {
  const value = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!value) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL environment variable is required');
  }
  return value;
}

/** Public read of the configured API base (e.g. public photo URLs). */
export function apiBaseUrl(): string {
  return baseUrl();
}

async function request<T>(path: string, init: RequestInit, body?: unknown): Promise<T> {
  // The JSON content type is only sent when a body is present:
  // Fastify rejects empty bodies declared as application/json.
  // FormData (Task 26 uploads) is passed through untouched — the browser
  // sets the multipart boundary itself.
  const headers: Record<string, string> = { ...init.headers } as Record<string, string>;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  // Token is read per attempt so a retry uses the REFRESHED token.
  const doFetch = (): Promise<Response> => {
    const attemptHeaders: Record<string, string> = { ...headers };
    const token = getAccessToken();
    if (token) {
      attemptHeaders['Authorization'] = `Bearer ${token}`;
    }
    return fetch(`${baseUrl()}${path}`, {
      credentials: 'include',
      ...init,
      headers: attemptHeaders,
      body: payload,
    });
  };

  let response = await doFetch();

  // 401 on a protected endpoint → one coordinated refresh, one retry.
  // /auth/* is excluded so login/refresh/logout failures can never loop.
  if (response.status === 401 && !path.startsWith('/auth/')) {
    const refreshed = await tryRefreshOnce();
    if (refreshed) {
      response = await doFetch(); // exactly one retry per request
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new ApiError(response.status, response.statusText, errorText);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST' }, body);
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH' }, body);
}

/**
 * PUT with an optional JSON body (Task 28.4B).
 *
 * Used by the self-service phone-number form, which replaces the stored
 * number outright. Behaves like patch() with a different verb.
 */
export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT' }, body);
}

/** Multipart upload (Task 26). The boundary header is set by the browser. */
export function postForm<T>(path: string, form: FormData): Promise<T> {
  return request<T>(path, { method: 'POST' }, form);
}

/** Raw binary GET — same token + single refresh-retry policy as request(). */
async function requestBlob(path: string): Promise<Blob> {
  const doFetch = (): Promise<Response> => {
    const headers: Record<string, string> = {};
    const token = getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return fetch(`${baseUrl()}${path}`, { credentials: 'include', headers });
  };
  let response = await doFetch();
  if (response.status === 401 && !path.startsWith('/auth/')) {
    const refreshed = await tryRefreshOnce();
    if (refreshed) {
      response = await doFetch();
    }
  }
  if (!response.ok) {
    const errorText = await response.text();
    throw new ApiError(response.status, response.statusText, errorText);
  }
  return response.blob();
}

/** Binary GET for authorized file downloads (Task 26 documents). */
export function getBlob(path: string): Promise<Blob> {
  return requestBlob(path);
}

/**
 * DELETE with an optional JSON body.
 *
 * Task 28.3D needs this for permanent account deletion, which sends a
 * confirmation phrase plus a re-authentication password. Without a body
 * argument this stays byte-identical in behaviour to a bodyless DELETE.
 */
export function del<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'DELETE' }, body);
}
