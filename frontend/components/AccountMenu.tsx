'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuChevronDown, LuLogOut } from 'react-icons/lu';

import { useAuth } from '@/lib/auth';
import { displayNameFor, initialsFor } from '@/lib/auth/initials';
import { roleLabel } from '@/lib/auth/roleLabels';
import { useLogoutAction } from '@/lib/auth/useLogoutAction';
import { navItemsForRole } from '@/lib/nav/roleNav';
import { usePendingOffersCount } from '@/lib/offers/usePendingOffersCount';
import { useUnreadNotificationCount } from '@/lib/privacy/useUnreadNotificationCount';
import { useAccountMenu } from '@/lib/ui/useAccountMenu';
import LogoutConfirm from './LogoutConfirm';

/**
 * Interactive profile avatar (§4) — ONE component for EVERY signed-in role.
 *
 * The initials badge in the top-right corner used to be a plain label: it
 * looked like a control and did nothing. It is now a real button that opens a
 * menu built from the session, not from a per-role copy:
 *
 *   - header       avatar, full name, email, role badge
 *   - menu items   the SAME list the drawer renders (lib/nav/roleNav), so the
 *                  two can never drift; each item links only to a screen that
 *                  exists and that the role may open
 *   - badges       live owner-scoped counts (pending offers, unread
 *                  notifications), hidden at zero — never a fabricated number
 *   - Log out      last, visually separated, behind the shared confirmation,
 *                  running the existing server-side logout
 *
 * WHY THE MENU IS PORTALED TO <body>
 *   The trigger lives in two hosts that both create a containing block for
 *   `position: fixed` children: the public header (`backdrop-filter`) and the
 *   mobile drawer (`transform`), and the dashboard topbar is `position:
 *   sticky`. A fixed panel rendered inline would be clipped to the host box —
 *   the header is only 72px tall. Portaling to <body> makes the sheet/popover
 *   viewport-anchored in every host, which is also what keeps it clear of
 *   notches and the home bar.
 *
 * `variant="dark"` restyles the trigger for the translucent public header;
 * `compact` hides the name/role text where there is no room for it.
 */

/** The portaled surface must not render during SSR — there is no body yet. */
function portalHost(): Element | null {
  return typeof document === 'undefined' ? null : document.body;
}

export default function AccountMenu({
  variant = 'light',
  compact = false,
}: {
  variant?: 'light' | 'dark';
  compact?: boolean;
}) {
  const { status, user } = useAuth();
  const [open, setOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, panelRef } = useAccountMenu(open, close);
  const pendingOffers = usePendingOffersCount();
  const unread = useUnreadNotificationCount();
  const { busy, run } = useLogoutAction();

  const items = navItemsForRole(user?.role);
  const initials = initialsFor(user);
  const name = displayNameFor(user);
  const label = roleLabel(user?.role);
  const host = portalHost();

  const countFor = (badge?: 'offers' | 'notifications') =>
    badge === 'offers' ? pendingOffers : badge === 'notifications' ? unread : 0;

  // Session still resolving: show the avatar's SHAPE, not a guess at its
  // content, so the corner never flickers from "?" to the real initials.
  if (status === 'loading' || !user) {
    return (
      <span
        className={`avatar-button avatar-button-${variant} is-skeleton`}
        aria-hidden="true"
        data-session-pending="true"
      >
        <span className="avatar-circle skeleton-block" />
        {!compact && <span className="avatar-name skeleton-line w-60" />}
      </span>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`avatar-button avatar-button-${variant}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="account-menu-panel"
        aria-label={`Account menu for ${name}${label ? `, ${label}` : ''}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="avatar-circle" aria-hidden="true">
          {initials}
        </span>
        {!compact && (
          <span className="avatar-name">
            <b>{name}</b>
            <small>{label}</small>
          </span>
        )}
        <LuChevronDown className="avatar-chevron" size={14} aria-hidden="true" />
      </button>

      {open &&
        host &&
        createPortal(
          <>
            {/* Tapping the page behind a phone sheet closes it; the hook's
                outside-pointer listener covers the desktop popover too. */}
            <div className="account-menu-scrim" role="presentation" onClick={close} />
            <div
              ref={panelRef}
              id="account-menu-panel"
              className="account-menu-panel"
              role="menu"
              aria-label="Account menu"
            >
              <div className="account-menu-head">
                <span className="avatar-circle account-menu-avatar" aria-hidden="true">
                  {initials}
                </span>
                <span className="account-menu-identity">
                  <b>{name}</b>
                  <small>{user.email}</small>
                </span>
                {label && <span className="badge badge-teal account-menu-role">{label}</span>}
              </div>

              <nav className="account-menu-items" aria-label="Account navigation">
                {items.map((item) => {
                  const count = countFor(item.badge);
                  return (
                    <Link
                      key={item.label}
                      href={item.href}
                      role="menuitem"
                      className="account-menu-item"
                      onClick={close}
                    >
                      <span className="account-menu-icon">{item.icon}</span>
                      {item.label}
                      {count > 0 && <b className="account-menu-count">{count}</b>}
                    </Link>
                  );
                })}
              </nav>

              <button
                type="button"
                role="menuitem"
                className="account-menu-item account-menu-logout"
                onClick={() => {
                  close();
                  setConfirmLogout(true);
                }}
              >
                <span className="account-menu-icon">
                  <LuLogOut size={14} aria-hidden="true" />
                </span>
                Log out
              </button>
            </div>
          </>,
          host,
        )}

      {confirmLogout &&
        host &&
        createPortal(
          <LogoutConfirm
            open
            busy={busy}
            onCancel={() => setConfirmLogout(false)}
            onConfirm={() => {
              setConfirmLogout(false);
              void run();
            }}
          />,
          host,
        )}
    </>
  );
}
