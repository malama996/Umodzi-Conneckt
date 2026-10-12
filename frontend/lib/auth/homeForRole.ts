import type { UserRole } from './authTypes';

/**
 * The workspace each role lands in after signing in (Phase 2).
 *
 * This mapping existed in three disconnected copies — RequireAuth's
 * `HOME_FOR_ROLE`, AuthForm's `homeForRole()`, and the logout redirect —
 * which is exactly the kind of drift that sends a user to the wrong
 * dashboard. It is now defined once and imported everywhere.
 *
 *   customer       → /matching          (create & track a service request)
 *   technician     → /technician/offers (incoming opportunities)
 *   administrator  → /dashboard         (platform overview)
 */
export const HOME_FOR_ROLE: Record<UserRole, string> = {
  customer: '/matching',
  technician: '/technician/offers',
  administrator: '/dashboard',
};

/** Safe lookup — an unknown role falls back to the landing page. */
export function homeForRole(role: UserRole | undefined | null): string {
  return (role && HOME_FOR_ROLE[role]) || '/';
}
