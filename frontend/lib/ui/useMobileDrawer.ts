'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Shared behaviour for the mobile navigation drawers (Phase 3).
 *
 * One implementation drives both the public-header drawer and the
 * dashboard sidebar drawer so they can never drift apart:
 *
 *   - Escape closes the drawer.
 *   - Focus is trapped inside the panel while open (Tab / Shift+Tab cycle),
 *     moved to the first control on open, and restored to the opener on
 *     close (WCAG 2.4.3 / 2.1.2).
 *   - Background scrolling is locked while open.
 *   - A leftward swipe (−60px or more) on the panel closes it.
 *   - Any route change closes it.
 *
 * Only transform/opacity animate (see globals.css); the panel's discrete
 * `visibility` switch keeps the closed drawer out of the tab order without
 * adding an animated property.
 *
 * `close` MUST be stable (useCallback with no deps) — it is an effect
 * dependency.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SWIPE_CLOSE_PX = 60;

export function useMobileDrawer(open: boolean, close: () => void) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const wrapper = panelRef.current;
    const panel =
      (wrapper?.querySelector('[data-drawer-panel]') as HTMLElement | null) ?? wrapper ?? null;

    // Remove inert so the panel can receive focus
    if (panel) panel.removeAttribute('inert');

    // Defer focus until after the drawer becomes visible (CSS transition + React render)
    const focusTimer = setTimeout(() => {
      panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }, 50);

    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.documentElement.style.overflow = previousOverflow;

      // Restore focus AFTER the drawer closes, using requestAnimationFrame
      // to ensure aria-hidden is already set by React before we move focus
      requestAnimationFrame(() => {
        openerRef.current?.focus();
        // Add inert to prevent any focus from entering while hidden
        if (panel) panel.setAttribute('inert', '');
      });
    };
  }, [open, close]);

  // Close on route changes — but ONLY for actual navigations, not
  // Fast Refresh rebuilds or parent re-renders. We track the pathname
  // at the moment the drawer opened to distinguish real navigation from
  // re-renders.
  const pathname = usePathname();
  const pathnameWhenOpenedRef = useRef<string | null>(null);
  /** Mirrors the current pathname without making the "opened at" effect depend
   *  on it: that effect must run ONLY when the drawer opens. If it re-ran on
   *  every navigation it would overwrite the remembered path with the new one
   *  and the drawer would silently stop closing on route change. */
  const latestPathnameRef = useRef(pathname);
  latestPathnameRef.current = pathname;

  useEffect(() => {
    // Remember where we were when it opened; forget it once it closes.
    pathnameWhenOpenedRef.current = open ? latestPathnameRef.current : null;
  }, [open]);

  useEffect(() => {
    // Close only on a REAL navigation while open. A re-render keeps the same
    // pathname, so it leaves the drawer exactly where the user put it.
    if (
      open &&
      pathnameWhenOpenedRef.current !== null &&
      pathname !== pathnameWhenOpenedRef.current
    ) {
      close();
    }
  }, [pathname, open, close]);

  // Swipe-left to close. The threshold ignores ordinary vertical scrolling
  // and small accidental horizontal jitter.
  const touchStartX = useRef<number | null>(null);
  const onTouchStart = (event: React.TouchEvent) => {
    touchStartX.current = event.changedTouches[0].clientX;
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const deltaX = event.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (deltaX <= -SWIPE_CLOSE_PX) close();
  };

  return { panelRef, onTouchStart, onTouchEnd };
}
