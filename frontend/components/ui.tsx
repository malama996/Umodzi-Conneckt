'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  LuArrowRight,
  LuBell,
  LuBriefcaseBusiness,
  LuClipboardList,
  LuClock,
  LuLayoutDashboard,
  LuLogOut,
  LuMapPin,
  LuMessageCircle,
  LuPlus,
  LuSettings,
  LuShieldCheck,
  LuStar,
  LuUser,
  LuUsers,
  LuWrench,
} from 'react-icons/lu';

import type { TechnicianCategory } from '@/lib/categories';
import { logout, useAuth } from '@/lib/auth';
import type { UserRole } from '@/lib/auth/authTypes';
import { useUnreadNotificationCount } from '@/lib/privacy/useUnreadNotificationCount';
import AuthNav from './AuthNav';

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
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
}) {
  const decorative = alt === '';
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      width={width}
      height={height}
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

export function PublicHeader() {
  return (
    <header className="public-header">
      <Logo light />
      <nav className="desktop-nav" aria-label="Primary navigation">
        <Link className="nav-active" href="/">
          Home
        </Link>
        <Link href="/#services">Services</Link>
        <Link href="/#how">How It Works</Link>
        <Link href="/#about">About</Link>
      </nav>
      <div className="header-actions">
        <AuthNav />
      </div>
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
export function Sidebar({ active = 'Dashboard' }: { active?: string }) {
  const { user } = useAuth();
  const unread = useUnreadNotificationCount();
  const router = useRouter();
  const pathname = usePathname();
  const consumerItems: [string, string, ReactNode][] = [
    ['Dashboard', '/dashboard', <LuLayoutDashboard key="dashboard" size={14} aria-hidden="true" />],
    ['New Request', '/matching', <LuPlus key="new" size={14} aria-hidden="true" />],
    [
      'My Requests',
      '/dashboard/requests',
      <LuClipboardList key="requests" size={14} aria-hidden="true" />,
    ],
    [
      'Messages',
      '/dashboard/messages',
      <LuMessageCircle key="messages" size={14} aria-hidden="true" />,
    ],
    [
      'Notifications',
      '/dashboard/notifications',
      <LuBell key="notifications" size={14} aria-hidden="true" />,
    ],
    ['Settings', '/dashboard/privacy', <LuSettings key="settings" size={14} aria-hidden="true" />],
  ];
  /**
   * Phase 3: technicians previously fell through to `consumerItems`, so their
   * sidebar offered "New Request" and "My Requests" — customer-only actions —
   * while their own profile, verification and offer pages stayed unreachable
   * from navigation. They now get their own list, built only from routes that
   * really exist.
   *
   * The consumer "Profile" item is gone too: it pointed at
   * `/technicians/Chanda%20M.`, a fabricated name that resolved to the retired
   * prototype route and redirected to /matching. There is no customer profile
   * page (§9), so the entry is removed rather than left broken.
   */
  const technicianItems: [string, string, ReactNode][] = [
    [
      'Offers',
      '/technician/offers',
      <LuBriefcaseBusiness key="offers" size={14} aria-hidden="true" />,
    ],
    [
      'My Requests',
      '/dashboard/requests',
      <LuClipboardList key="requests" size={14} aria-hidden="true" />,
    ],
    ['Profile', '/technician/profile', <LuUser key="profile" size={14} aria-hidden="true" />],
    [
      'Messages',
      '/dashboard/messages',
      <LuMessageCircle key="messages" size={14} aria-hidden="true" />,
    ],
    [
      'Notifications',
      '/dashboard/notifications',
      <LuBell key="notifications" size={14} aria-hidden="true" />,
    ],
    ['Settings', '/dashboard/privacy', <LuSettings key="settings" size={14} aria-hidden="true" />],
  ];
  /**
   * Task 31: administrators get the same two-level structure the other
   * roles have implicitly — platform work grouped together, the
   * administrator's own account entry separate. Every href below resolves
   * to a route that exists and that an administrator may open:
   *   - Platform → the five Task 25/Phase 6 screens (all real, all
   *     server-authorized);
   *   - Account → /dashboard/privacy, the existing own-account page
   *     (contact phone, data export, deletion preview) that the consumer
   *     and technician lists already call "Settings". It has no role
   *     gate because it only ever touches the signed-in account, so it
   *     is equally correct for an administrator. There is deliberately
   *     no "System management" group: the backend exposes no platform
   *     configuration endpoints, and a link to an empty page would be
   *     worse than no link (see STATE.md Task 31 gaps).
   */
  const adminGroups: { heading: string; items: [string, string, ReactNode][] }[] = [
    {
      heading: 'Platform',
      items: [
        [
          'Overview',
          '/dashboard',
          <LuLayoutDashboard key="overview" size={14} aria-hidden="true" />,
        ],
        ['Users', '/admin/users', <LuUsers key="users" size={14} aria-hidden="true" />],
        [
          'Technicians',
          '/admin/technicians',
          <LuWrench key="technicians" size={14} aria-hidden="true" />,
        ],
        [
          'Requests',
          '/admin/requests',
          <LuClipboardList key="requests" size={14} aria-hidden="true" />,
        ],
        ['Audit log', '/admin/audit', <LuShieldCheck key="audit" size={14} aria-hidden="true" />],
      ],
    },
    {
      heading: 'Account',
      items: [
        [
          'Settings',
          '/dashboard/privacy',
          <LuSettings key="settings" size={14} aria-hidden="true" />,
        ],
      ],
    },
  ];
  const isAdmin = user?.role === 'administrator';
  const items = isAdmin
    ? adminGroups.flatMap((group) => group.items)
    : user?.role === 'technician'
      ? technicianItems
      : consumerItems;
  const [loggingOut, setLoggingOut] = useState(false);

  /**
   * Real logout (Phase 2 P0 fix).
   *
   * This used to be `<Link href="/">`, which only changed the URL — the
   * HttpOnly refresh cookie survived, so the user believed they had signed
   * out while the session was still fully usable. The store's `logout()`
   * revokes the refresh session SERVER-SIDE first, then we navigate.
   *
   * On gated pages the RequireAuth transition owns the single navigation
   * (a second one races it and stalls the router — see AuthNav); on any
   * ungated page we return to the landing page ourselves.
   */
  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
    const onGatedPage =
      pathname === '/matching' ||
      pathname.startsWith('/dashboard') ||
      pathname.startsWith('/admin') ||
      pathname.startsWith('/technician');
    if (!onGatedPage) {
      router.replace('/');
    }
  };

  return (
    <aside className="sidebar">
      <Logo light />{' '}
      <nav className="sidebar-nav" aria-label="Primary navigation">
        {isAdmin
          ? adminGroups.map((group) => (
              <div key={group.heading} className="sidebar-group">
                <p className="sidebar-heading">{group.heading}</p>
                {group.items.map(([label, href, icon]) => (
                  <Link
                    key={label}
                    href={href}
                    className={active === label ? 'sidebar-active' : ''}
                  >
                    <span>{icon}</span>
                    {label}
                  </Link>
                ))}
              </div>
            ))
          : items.map(([label, href, icon]) => (
              <Link key={label} href={href} className={active === label ? 'sidebar-active' : ''}>
                <span>{icon}</span>
                {label}
                {label === 'Notifications' && unread > 0 && (
                  <b className="sidebar-count">{unread}</b>
                )}
              </Link>
            ))}
      </nav>
      <button
        type="button"
        className="sidebar-logout"
        /* At ≤950px the CSS hides the visible label (icon-only control), so the
           accessible name must not depend on that text. */
        aria-label={loggingOut ? 'Signing out' : 'Log out'}
        title="Log out"
        onClick={() => void handleLogout()}
        disabled={loggingOut}
      >
        <LuLogOut size={13} className="ic" aria-hidden="true" />{' '}
        <span>{loggingOut ? 'Signing out…' : 'Log Out'}</span>
      </button>
    </aside>
  );
}

/** Display label for each backend role, used in the topbar identity chip. */
const IDENTITY_LABELS: Record<UserRole, string> = {
  customer: 'Consumer',
  technician: 'Technician',
  administrator: 'Administrator',
};

/**
 * Dashboard chrome: sidebar + topbar + children.
 *
 * Task 25: the topbar identity chip shows the REAL signed-in administrator
 * (name + "Administrator" label) on admin pages; every other role keeps the
 * original static chip, so consumer/technician dashboards are unchanged.
 */
export function DashboardLayout({
  children,
  active = 'Dashboard',
}: {
  children: ReactNode;
  active?: string;
}) {
  const { user } = useAuth();

  /**
   * The identity chip previously rendered HARDCODED values for every
   * non-administrator — the name "Arnold Malama", the initials "AM" and the
   * label "Consumer" — so every signed-in customer and technician saw
   * somebody else's name in their own header. It now shows the real session
   * identity, and the label reflects the account's actual backend role.
   */
  const fullName = user ? `${user.firstName} ${user.lastName}`.trim() : '';
  const displayName = fullName || user?.email || '…';
  const initials =
    (fullName || user?.email || '')
      .split(/[\s@.]+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?';

  return (
    <div className="dashboard-shell">
      <Sidebar active={active} />
      <div className="dashboard-main">
        <div className="dashboard-topbar">
          {/* Phone widths hide the sidebar (and its logo) — keep a compact
              brand mark in the topbar there. Hidden at wider widths so the
              desktop topbar is unchanged. */}
          <Link href="/" className="dashboard-brand" aria-label="Umodzi Connect home">
            <BrandAsset src="/branding/umodzi-connect-mark.svg" alt="" width={112} height={116} />
          </Link>
          {/* The former global search box had no handler, no state and no
              destination — it accepted typing and did nothing. Removed rather
              than left as a control that only looks functional. */}
          <div className="profile-chip">
            <span className="mini-avatar">{initials}</span>
            <span>
              <b>{displayName}</b>
              <small>{user ? IDENTITY_LABELS[user.role] : ''}</small>
            </span>
          </div>
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
