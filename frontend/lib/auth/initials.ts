import type { AuthUser } from './authTypes';

/**
 * Avatar initials — ONE implementation for the topbar chip, the avatar menu,
 * the drawer identity header, the dashboard chip and the technician profile.
 *
 * Rules (§4):
 *   * first letter of the first name + first letter of the last name, uppercased
 *     ("Malama Malama" → "MM");
 *   * a single name gives a single letter ("Malama" → "M");
 *   * an administrator with no usable name shows "AD";
 *   * otherwise the email local part is used ("ada.lovelace@…" → "AL") and the
 *     very last fallback is "?" — never a blank or a made-up letter.
 */
export function initialsFor(
  user: Pick<AuthUser, 'firstName' | 'lastName' | 'email' | 'role'> | null | undefined,
): string {
  const letters = (value: string) =>
    value
      .split(/[\s._+\-@]+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

  const fullName = user ? `${user.firstName} ${user.lastName}`.trim() : '';
  const fromName = letters(fullName);
  if (fromName) return fromName;

  if (user?.role === 'administrator') return 'AD';

  const fromEmail = letters(user?.email ?? '');
  return fromEmail || '?';
}

/**
 * The label under/next to the avatar: full name, else the email, else a
 * neutral placeholder while the session is still resolving.
 */
export function displayNameFor(
  user: Pick<AuthUser, 'firstName' | 'lastName' | 'email'> | null | undefined,
): string {
  const fullName = user ? `${user.firstName} ${user.lastName}`.trim() : '';
  return fullName || user?.email || '…';
}
