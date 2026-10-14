import type { UserRole } from './authTypes';

/**
 * Display label for a backend role — the ONE place the word a person reads is
 * decided.
 *
 * ---------------------------------------------------------------------------
 * Why the internal value is NOT renamed
 * ---------------------------------------------------------------------------
 * The stored role value is `customer` (database column, JWT claim, API
 * contract, authorization checks). It is deliberately left exactly as it is:
 * renaming it would invalidate existing sessions, break every API consumer and
 * require a data migration, for no user-visible benefit. Only the PRESENTATION
 * changes — a signed-in customer reads "Customer", never "Consumer".
 *
 * Every user-facing surface (dashboard topbar chip, mobile drawer identity
 * header, role badges) reads its wording from here, so the two drawer
 * implementations and the profile chip can never drift apart.
 */
const ROLE_DISPLAY_LABELS: Record<UserRole, string> = {
  customer: 'Customer',
  technician: 'Technician',
  administrator: 'Administrator',
};

/** Label for a known role, or an empty string when no session is resolved yet. */
export function roleLabel(role: UserRole | undefined | null): string {
  return role ? ROLE_DISPLAY_LABELS[role] : '';
}
