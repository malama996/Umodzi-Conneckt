'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Behaviour for the interactive avatar menu (§4).
 *
 * Deliberately NOT `useMobileDrawer`: that hook traps focus and locks page
 * scroll, which is right for a full-height drawer and wrong for a menu that
 * should let the page behind it stay usable. What the two DO share is the
 * contract people expect from a menu, implemented once here:
 *
 *   - Closes on an outside tap/click (pointerdown, so it feels immediate).
 *   - Closes on Escape, and only while it is open.
 *   - Closes on any real route change (a re-render does not close it).
 *   - ArrowUp/ArrowDown/Home/End move through the items with wrap-around;
 *     focus enters the first item when the menu opens on keyboard intent.
 *   - Focus returns to the trigger button on close (WCAG 2.4.3).
 *
 * `close` MUST be stable (useCallback with no dependencies) — it is an
 * effect dependency.
 */

const FOCUSABLE_ITEM =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useAccountMenu(open: boolean, close: () => void) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    const panel = panelRef.current;
    const trigger = triggerRef.current;
    const items = panel
      ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_ITEM))
      : [];

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panel?.contains(target) || trigger?.contains(target)) return;
      close();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (items.length === 0) return;
      const active = document.activeElement;
      const index = items.findIndex((item) => item === active);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[(index + 2) % items.length].focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[(index <= 0 ? items.length : index) - 1].focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0].focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items[items.length - 1].focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      // Return focus to the avatar the moment the menu closes.
      trigger?.focus();
    };
  }, [open, close]);

  // Close on a REAL navigation only. If the menu re-rendered on every
  // pathname change it would also close while the user is still reading it.
  const pathname = usePathname();
  const pathnameWhenOpenedRef = useRef<string | null>(null);
  const latestPathnameRef = useRef(pathname);
  latestPathnameRef.current = pathname;

  useEffect(() => {
    pathnameWhenOpenedRef.current = open ? latestPathnameRef.current : null;
  }, [open]);

  useEffect(() => {
    if (
      open &&
      pathnameWhenOpenedRef.current !== null &&
      pathname !== pathnameWhenOpenedRef.current
    ) {
      close();
    }
  }, [pathname, open, close]);

  return { triggerRef, panelRef };
}
