'use client';

import Link from 'next/link';
import { Fragment, useCallback, useState, type ReactNode } from 'react';
import {
  LuArrowRight,
  LuBriefcaseBusiness,
  LuClock,
  LuHouse,
  LuInfo,
  LuLayoutGrid,
  LuListChecks,
  LuLogOut,
  LuMapPin,
  LuMenu,
  LuShieldCheck,
  LuStar,
  LuX,
} from 'react-icons/lu';

import type { TechnicianCategory } from '@/lib/categories';
import { useAuth } from '@/lib/auth';
import { displayNameFor, initialsFor } from '@/lib/auth/initials';
import { roleLabel } from '@/lib/auth/roleLabels';
import { useLogoutAction } from '@/lib/auth/useLogoutAction';
import { navGroupsForRole, type NavBadge } from '@/lib/nav/roleNav';
import { useUnreadNotificationCount } from '@/lib/privacy/useUnreadNotificationCount';
import { useMobileDrawer } from '@/lib/ui/useMobileDrawer';
import { usePendingOffersCount } from '@/lib/offers/usePendingOffersCount';
import { UI_V2 } from '@/lib/uiFlags';
import AccountMenu from './AccountMenu';
import AuthNav from './AuthNav';
import LogoutConfirm from './LogoutConfirm';

/**
 * Approved Umodzi Connect brand asset (Task 24).
 *
 * The approved SVGs live in `public/branding/` and `public/illustrations/`
 * and are referenced directly as static public assets: this project has no
 * image-optimization pipeline for SVG (Next.js serves `.svg` as-is anyway),
 * so a plain `<img>` is the correct lowest-cost primitive — hence the scoped
 * lint exemption below.
 *
 * Pass `alt=""` for a purely decorative asset (the surrounding link/text
 * already carries the meaning) — it is then also marked `aria-hidden`.
 * Meaningful illustrations pass a short purpose-describing `alt` instead.
 */
/* eslint-disable @next/next/no-img-element */
export function BrandAsset({
  src,
  alt,
  width,
  height,
  className,
  loading,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  /* Below-the-fold artwork passes loading="lazy" (low-data promise);
     above-the-fold assets stay eager, the browser default. */
  loading?: 'lazy' | 'eager';
}) {
  const decorative = alt === '';
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading={loading}
      decoding="async"
      aria-hidden={decorative || undefined}
    />
  );
}
/* eslint-enable @next/next/no-img-element */

/**
 * Brand lockup — approved SVG logo variants (Task 24).
 *
 * `light`   → white-lettering variant for dark backgrounds (public header,
 *             footer, dashboard sidebar, auth photo panel).
 * `compact` → mark only, no tagline.
 * The full logo ↔ compact mark swap on narrow viewports is driven by CSS
 * (`.logo-full` / `.logo-mark-img`), so the same markup serves the 650px
 * header breakpoint and the 950px collapsed-sidebar breakpoint.
 */
export function Logo({ light = false, compact = false }: { light?: boolean; compact?: boolean }) {
  const logoArt = light
    ? '/branding/umodzi-connect-logo-dark.svg'
    : '/branding/umodzi-connect-logo.svg';
  const markArt = light
    ? '/branding/umodzi-connect-mark-dark.svg'
    : '/branding/umodzi-connect-mark.svg';
  return (
    <Link
      href="/"
      className={`logo ${light ? 'logo-light' : ''} ${compact ? 'logo-compact' : ''}`}
      aria-label="Umodzi Connect home"
    >
      <BrandAsset className="logo-full" src={logoArt} alt="" width={552} height={116} />
      <BrandAsset className="logo-mark-img" src={markArt} alt="" width={112} height={116} />
      {!compact && (
        <span className="logo-word">
          <small>SKILLED PEOPLE. STRONGER COMMUNITIES.</small>
        </span>
      )}
    </Link>
  );
}

/**
 * One shared config drives the desktop top nav AND the mobile drawer so
 * the two can never drift apart (§3). Icons use the existing Lucide set
 * (react-icons/lu) and only render inside the drawer.
 */
const PUBLIC_NAV_LINKS: { label: string; href: string; icon: ReactNode }[] = [
  { label: 'Home', href: '/', icon: <LuHouse size={17} aria-hidden="true" /> },
  { label: 'Services', href: '/#services', icon: <LuLayoutGrid size={17} aria-hidden="true" /> },
  { label: 'How It Works', href: '/#how', icon: <LuListChecks size={17} aria-hidden="true" /> },
  { label: 'About', href: '/#about', icon: <LuInfo size={17} aria-hidden="true" /> },
];

/* Initials and display names come from ONE shared helper
   (lib/auth/initials) so the drawer identity header, the topbar avatar and
   the avatar menu can never disagree about what a user is called. */

export function PublicHeader() {
  const [navOpen, setNavOpen] = useState(false);
  const close = useCallback(() => setNavOpen(false), []);
  const { panelRef, onTouchStart, onTouchEnd } = useMobileDrawer(navOpen, close);
  return (
    <header className="public-header">
      <Logo light />
      <nav className="desktop-nav" aria-label="Primary navigation">
        {PUBLIC_NAV_LINKS.map((link, index) => (
          <Link key={link.label} className={index === 0 ? 'nav-active' : ''} href={link.href}>
            {link.label}
          </Link>
        ))}
      </nav>
      <div className="header-actions">
        <AuthNav />
      </div>
      {/* Mobile (≤950px): the CSS hides .desktop-nav; this hamburger +
          left drawer replace it. Gated by the UI_V2 flag (lib/uiFlags) for
          a one-env-var rollback. */}
      {UI_V2 && (
        <>
          <button
            type="button"
            className="nav-toggle"
            aria-expanded={navOpen}
            aria-controls="public-mobile-nav"
            aria-label={navOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setNavOpen((open) => !open)}
          >
            {navOpen ? <LuX size={22} aria-hidden="true" /> : <LuMenu size={22} aria-hidden="true" />}
          </button>
          <nav
            ref={panelRef}
            id="public-mobile-nav"
            data-drawer-panel
            className={`mobile-nav ${navOpen ? 'mobile-nav-open' : ''}`}
            aria-label="Mobile navigation"
            aria-hidden={!navOpen}
            inert={!navOpen || undefined}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          >
            <div className="mobile-nav-head">
              <Logo light />
            </div>
            <div className="mobile-nav-links">
              {PUBLIC_NAV_LINKS.map((link) => (
                <Link
                  key={link.label}
                  href={link.href}
                  onClick={close}
                  tabIndex={navOpen ? 0 : -1}
                >
                  <span className="mobile-nav-icon">{link.icon}</span>
                  {link.label}
                </Link>
              ))}
            </div>
            <div className="mobile-nav-actions">
              <Link
                href="/matching"
                className="button button-coral"
                onClick={close}
                tabIndex={navOpen ? 0 : -1}
              >
                Find a Technician <LuArrowRight size={13} aria-hidden="true" />
              </Link>
              {/* Compact: the drawer's action column has no room for the name,
                  and the drawer's identity is already shown above. */}
              <AuthNav compact />
            </div>
          </nav>
        </>
      )}
    </header>
  );
}

/**
 * Public footer (Task 32) — one shared component rendered once per public
 * page (landing, matching, technician profile, legal pages). Dashboard
 * layouts never render it, so authenticated navigation is untouched.
 *
 * Links are public routes only: nothing here leads to an administrator,
 * dashboard, or otherwise gated page. The year is dynamic; the "Prototype"
 * marker stays until the product genuinely launches.
 */
export function PublicFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="public-footer">
      <div className="footer-grid">
        <div>
          <Logo light />
          <p>
            Local skills. Real solutions.
            <br />
            Building stronger connections through service.
          </p>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <div className="footer-group">
            <p className="footer-heading">Platform</p>
            <Link href="/#services">Services</Link>
            <Link href="/#how">How It Works</Link>
            <Link href="/matching">Find a Technician</Link>
            <Link href="/register">Join Umodzi</Link>
          </div>
          <div className="footer-group">
            <p className="footer-heading">Legal</p>
            <Link href="/terms">Terms and Conditions</Link>
            <Link href="/privacy">Privacy Policy</Link>
          </div>
        </nav>
      </div>
      <div className="footer-bottom">
        <span>© {year} Umodzi Connect</span>
        <span>Kitwe · Ndola · Zambia</span>
      </div>
    </footer>
  );
}

export function Button({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button className={`button ${className}`} {...props}>
      {children}
    </button>
  );
}

/** Badge colour vocabulary (Task 24 tones + Task 25 coral for failures). */
export type BadgeTone = 'success' | 'warning' | 'neutral' | 'teal' | 'coral';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function VerifiedBadge() {
  return (
    <Badge tone="success">
      <LuShieldCheck size={10} aria-hidden="true" /> Verified
    </Badge>
  );
}

/**
 * A global search box used to live here. It had no state, no handler and no
 * destination — typing into it did nothing — so it was removed rather than
 * left in the topbar looking like a working control (§13). If global search
 * is ever built, it should return here with a real query path.
 */

/**
 * Sidebar navigation — one item list per role (Phase 3).
 *
 * The role comes from the authenticated session (backend-authoritative),
 * and every dashboard route that renders this sidebar sits behind
 * RequireAuth — so the auth state is already resolved before the sidebar
 * mounts (no nav flash). Administrators see ONLY the Task 25 functionality
 * that actually exists (no placeholder items).
 *
 * Phase 3 changed the non-admin branch from "administrator ? admin : consumer"
 * to a genuine three-way switch. Technicians had been handed the CONSUMER list,
 * so their sidebar offered customer-only actions while their offers, profile
 * and verification screens were unreachable from navigation. Every entry below
 * now resolves to a route that exists, and only to one the role may open.
 *
 * Task 28.3 (G-02): the "Notifications" badge previously rendered a HARDCODED
 * "2", which was fabricated data — the application had no notification
 * history to read and no unread count to report. It is now the REAL unread
 * count from the owner-scoped API, and it is hidden entirely when zero (or
 * while loading/failing) rather than showing a made-up number. The
 * Notifications and Settings items also point at real routes instead of "#".
 * Task 28.4: "Messages" now points at the real conversation list (it was a
 * "#" placeholder while chat did not exist). Administrators deliberately do
 * NOT get an admin-to-user chat: their item list stays Task 25 only.
 */
export function Sidebar({
  active = 'Dashboard',
  onNavigate,
}: {
  active?: string;
  /** Called after any nav link is tapped — the drawer closes itself. */
  onNavigate?: () => void;
}) {
  const { user } = useAuth();
  const unread = useUnreadNotificationCount();
  const pendingOffers = usePendingOffersCount();
  /* The item list is the SHARED role → menu mapping (lib/nav/roleNav), the
     same array the avatar menu renders — a route can therefore never be in
     the drawer and missing from the menu, or vice versa. */
  const groups = navGroupsForRole(user?.role);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const { busy, run } = useLogoutAction();
  const fullName = displayNameFor(user);
  const initials = initialsFor(user);

  /** Live owner-scoped count for a badge; zero hides it (never a literal). */
  const countFor = (badge?: NavBadge) =>
    badge === 'offers' ? pendingOffers : badge === 'notifications' ? unread : 0;

  return (
    <aside className="sidebar" data-drawer-panel>
      <Logo light />
      {/* Drawer identity header (§3): avatar + full name + role label.
          Visible only where the sidebar becomes a drawer (≤950px). */}
      {user && (
        <div className="sidebar-user">
          <span className="sidebar-user-avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="sidebar-user-meta">
            <b>{fullName || user.email}</b>
            <small>{roleLabel(user.role)}</small>
          </span>
        </div>
      )}
      <nav id="sidebar-nav" className="sidebar-nav" aria-label="Primary navigation">
        {groups.map((group) => {
          const links = group.items.map((item) => {
            const count = countFor(item.badge);
            return (
              <Link
                key={item.label}
                href={item.href}
                className={active === item.label ? 'sidebar-active' : ''}
                onClick={onNavigate}
              >
                <span>{item.icon}</span>
                {item.label}
                {count > 0 && <b className="sidebar-count">{count}</b>}
              </Link>
            );
          });
          // Only administrators have named groups; the other roles render
          // their single group flat, exactly as before.
          return group.heading ? (
            <div key={group.heading} className="sidebar-group">
              <p className="sidebar-heading">{group.heading}</p>
              {links}
            </div>
          ) : (
            <Fragment key="items">{links}</Fragment>
          );
        })}
      </nav>
      <button
        type="button"
        className="sidebar-logout"
        aria-label={busy ? 'Signing out' : 'Log out'}
        title="Log out"
        onClick={() => setConfirmLogout(true)}
        disabled={busy}
      >
        <LuLogOut size={13} className="ic" aria-hidden="true" />{' '}
        <span>{busy ? 'Signing out…' : 'Log Out'}</span>
      </button>
      {/* Log-out confirmation (§3) — the shared dialog, so the drawer, the
          avatar menu and the public header can never word it differently. */}
      <LogoutConfirm
        open={confirmLogout}
        busy={busy}
        onCancel={() => setConfirmLogout(false)}
        onConfirm={() => {
          setConfirmLogout(false);
          void run();
        }}
      />
    </aside>
  );
}

/**
 * Dashboard chrome: sidebar + topbar + children.
 *
 * Task 25: the topbar identity chip shows the REAL signed-in administrator
 * (name + role label) on admin pages; every other role keeps the original
 * chip, so customer/technician dashboards are unchanged in appearance.
 *
 * §4: that chip is now the interactive avatar menu (`AccountMenu`) for every
 * role — same size, same position, same identity data, but tapping it opens
 * the account menu instead of doing nothing. It replaces the hardcoded
 * "Arnold Malama / AM / Consumer" values that used to appear in every
 * customer's and technician's own header.
 */
export function DashboardLayout({
  children,
  active = 'Dashboard',
}: {
  children: ReactNode;
  active?: string;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const { panelRef, onTouchStart, onTouchEnd } = useMobileDrawer(mobileNavOpen, closeMobileNav);

  return (
    <div className="dashboard-shell">
      {/* Sidebar drawer (≤950px) + dimmed backdrop. Focus trap, Escape,
          scroll lock, swipe-left and route-change close come from the
          shared useMobileDrawer hook. */}
      <div
        ref={panelRef}
        className={`sidebar-wrapper ${mobileNavOpen ? 'sidebar-open' : ''}`}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <Sidebar active={active} onNavigate={closeMobileNav} />
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation menu"
          tabIndex={mobileNavOpen ? 0 : -1}
          onClick={closeMobileNav}
        />
      </div>

      <div className="dashboard-main">
        <div className="dashboard-topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="mobile-menu-toggle"
              aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileNavOpen}
              aria-controls="sidebar-nav"
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              {mobileNavOpen ? (
                <LuX size={22} aria-hidden="true" />
              ) : (
                <LuMenu size={22} aria-hidden="true" />
              )}
            </button>
            {/* Compact brand mark beside the toggle — phone widths hide the
                sidebar (and its logo); wider widths hide both (CSS). */}
            <Link href="/" className="dashboard-brand" aria-label="Umodzi Connect home">
              <BrandAsset src="/branding/umodzi-connect-mark.svg" alt="" width={112} height={116} />
            </Link>
          </div>
          {/* The former global search box had no handler, no state and no
              destination — it accepted typing and did nothing. Removed rather
              than left as a control that only looks functional. */}
          <AccountMenu />
        </div>
        {children}
      </div>
    </div>
  );
}

export function TechnicianCard({
  name,
  category,
  skills,
  serviceArea,
  rating,
  jobs,
  verified,
  availability,
}: {
  name: string;
  category: TechnicianCategory;
  skills: string[];
  serviceArea: string;
  rating: number;
  jobs: number;
  verified: boolean;
  availability: string;
}) {
  return (
    <article className="technician-card">
      <div className="tech-photo">
        {name
          .split(' ')
          .map((x) => x[0])
          .join('')}
      </div>
      <div className="tech-card-body">
        <div className="tech-card-heading">
          <div>
            <h3>{name}</h3>
            <p>{[category, ...skills].join(' · ')}</p>
          </div>
          <strong>
            <LuStar size={10} fill="currentColor" className="ic" aria-hidden="true" /> {rating}
          </strong>
        </div>
        <div className="tech-card-meta">
          <span>
            <LuMapPin size={10} className="ic" aria-hidden="true" /> {serviceArea}
          </span>
          <span>
            <LuBriefcaseBusiness size={10} className="ic" aria-hidden="true" /> {jobs} jobs
          </span>
          {verified ? (
            <VerifiedBadge />
          ) : (
            <Badge tone="warning">
              <LuClock size={10} aria-hidden="true" /> Pending
            </Badge>
          )}
        </div>
        <div className="tech-card-footer">
          <span className="availability-dot">
            <LuClock size={10} className="ic" aria-hidden="true" /> {availability}
          </span>
          <Link href={`/technicians/${encodeURIComponent(name)}`} className="outline-button">
            View profile{' '}
            <span>
              <LuArrowRight size={10} aria-hidden="true" />
            </span>
          </Link>
        </div>
      </div>
    </article>
  );
}
