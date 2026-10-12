/**
 * Auth layer barrel (Task 23).
 *
 * App code imports from '@/lib/auth' — types, the hook, and the store
 * actions. The access token is intentionally NOT exported as readable
 * state; only the token holder (wired into the API client) sees it.
 */

export { useAuth } from './useAuth';
export {
  ensureAuthInitialized,
  getAuthSnapshot,
  login,
  logout,
  register,
  subscribeAuth,
} from './authStore';
export type {
  AccountStatus,
  AuthPayload,
  AuthState,
  AuthStatus,
  AuthUser,
  RegisterInput,
  UserRole,
} from './authTypes';
