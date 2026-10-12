/**
 * Frontend auth domain types (Task 23).
 *
 * Strongly typed mirrors of the backend auth contract — no `any`, and no
 * role/status strings are ever written inline anywhere else in the app.
 * The access token itself is deliberately NOT part of these types: it
 * lives only in the in-memory token holder (lib/auth/tokenHolder.ts).
 */

/** The three roles of the system. */
export type UserRole = 'customer' | 'technician' | 'administrator';

/** Account lifecycle state — only 'active' accounts can authenticate. */
export type AccountStatus = 'active' | 'suspended' | 'disabled';

/**
 * Safe public identity (never contains password material).
 * technicianId/technicianName exist for technician accounts and link the
 * session to exactly one technicians row.
 */
export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  accountStatus: AccountStatus;
  technicianId?: string;
  technicianName?: string;
}

/** Login/refresh payload: user + short-lived access token (memory only). */
export interface AuthPayload {
  user: AuthUser;
  accessToken: string;
}

/**
 * Session lifecycle for the UI:
 *   loading       — initial refresh attempt not finished yet (never show
 *                   protected content during this state)
 *   authenticated — a user is known
 *   anonymous     — definitively not signed in
 */
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
}

/** Registration payload accepted by POST /auth/register. */
export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  /** Public registration may only ever create these two roles. */
  role: 'customer' | 'technician';
  /** Required when role === 'technician'. */
  category?: string;
  /** Required when role === 'technician'. */
  serviceArea?: string;
}
