import { get, post } from './client';
import type { AuthPayload, AuthUser, RegisterInput } from '@/lib/auth/authTypes';

/**
 * Auth API boundary (Task 23) — the ONLY place that talks to
 * /api/v1/auth/*. Requests go through the shared client (lib/api/client.ts)
 * so the Bearer token, credentialed cookie fetches, and the single
 * 401-triggered refresh retry apply automatically. There is no second
 * HTTP client anywhere in the app.
 *
 * The refresh token is never handled here as a value — it travels only
 * inside the HttpOnly cookie with credentials: 'include'.
 */

interface UserEnvelope {
  data: { user: AuthUser };
}

interface PayloadEnvelope {
  data: AuthPayload;
}

/** Create a customer or technician account (never an administrator). */
export async function register(input: RegisterInput): Promise<AuthUser> {
  const response = await post<UserEnvelope>('/auth/register', input);
  return response.data.user;
}

/** Exchange credentials for an access token + refresh cookie session. */
export async function login(email: string, password: string): Promise<AuthPayload> {
  const response = await post<PayloadEnvelope>('/auth/login', { email, password });
  return response.data;
}

/** Rotate the refresh cookie session and obtain a new access token. */
export async function refresh(): Promise<AuthPayload> {
  const response = await post<PayloadEnvelope>('/auth/refresh');
  return response.data;
}

/** Revoke the current refresh session and clear the cookie. */
export async function logout(): Promise<void> {
  await post<{ data: { ok: boolean } }>('/auth/logout');
}

/** Re-read the authenticated identity from the database. */
export async function getCurrentUser(): Promise<AuthUser> {
  const response = await get<UserEnvelope>('/auth/me');
  return response.data.user;
}
