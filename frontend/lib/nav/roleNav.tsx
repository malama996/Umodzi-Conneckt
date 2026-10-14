import type { ReactNode } from 'react';
import {
  LuBell,
  LuBriefcaseBusiness,
  LuClipboardList,
  LuLayoutDashboard,
  LuMessageCircle,
  LuPlus,
  LuSettings,
  LuShieldCheck,
  LuUser,
  LuUsers,
  LuWrench,
} from 'react-icons/lu';
import type { UserRole } from '@/lib/auth/authTypes';

/**
 * THE role → menu mapping (Phase 3 / §3 + §4).
 *
 * One definition, two consumers: the signed-in drawer (`Sidebar`) renders it
 * as a vertical nav, and the avatar menu (`AccountMenu`) renders the same
 * entries as a popover/bottom sheet. They are the same array, so a route can
 * never appear in one and be missing from the other — the drift this file
 * exists to prevent.
 *
 * RULES ENCODED HERE
 *   * Every href resolves to a route that EXISTS in `app/`, and only to one
 *     the role is allowed to open (the backend re-checks authorization; this
 *     list is about not offering dead or forbidden links).
 *   * A role with no known session (undefined/null) gets NOTHING. A
 *     logged-out visitor must never see Offers, Settings or Log out, so the
 *     fallback is an empty list rather than the least-privileged role.
 *   * Badges read real owner-scoped counts and are hidden at zero.
 */

export type NavBadge = 'offers' | 'notifications';

export interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  /** Which live count (if any) renders as a number badge beside the label. */
  badge?: NavBadge;
}

export interface NavGroup {
  /** Only administrators have named groups; the other roles have one group. */
  heading?: string;
  items: NavItem[];
}

const customerGroups: NavGroup[] = [
  {
    items: [
      {
        label: 'Dashboard',
        href: '/dashboard',
        icon: <LuLayoutDashboard size={14} aria-hidden="true" />,
      },
      { label: 'New Request', href: '/matching', icon: <LuPlus size={14} aria-hidden="true" /> },
      {
        label: 'My Requests',
        href: '/dashboard/requests',
        icon: <LuClipboardList size={14} aria-hidden="true" />,
      },
      {
        label: 'Messages',
        href: '/dashboard/messages',
        icon: <LuMessageCircle size={14} aria-hidden="true" />,
      },
      {
        label: 'Notifications',
        href: '/dashboard/notifications',
        icon: <LuBell size={14} aria-hidden="true" />,
        badge: 'notifications',
      },
      {
        label: 'Settings',
        href: '/dashboard/privacy',
        icon: <LuSettings size={14} aria-hidden="true" />,
      },
    ],
  },
];

/**
 * Technicians previously fell through to the customer list, so their drawer
 * offered "New Request" — a customer-only action — while their own offers,
 * profile and verification screens stayed unreachable from navigation. They
 * now get their own list, built only from routes that really exist, and
 * "Offers" carries the real pending-offer count.
 */
const technicianGroups: NavGroup[] = [
  {
    items: [
      {
        label: 'Offers',
        href: '/technician/offers',
        icon: <LuBriefcaseBusiness size={14} aria-hidden="true" />,
        badge: 'offers',
      },
      {
        label: 'My Requests',
        href: '/dashboard/requests',
        icon: <LuClipboardList size={14} aria-hidden="true" />,
      },
      {
        label: 'Profile',
        href: '/technician/profile',
        icon: <LuUser size={14} aria-hidden="true" />,
      },
      {
        label: 'Messages',
        href: '/dashboard/messages',
        icon: <LuMessageCircle size={14} aria-hidden="true" />,
      },
      {
        label: 'Notifications',
        href: '/dashboard/notifications',
        icon: <LuBell size={14} aria-hidden="true" />,
        badge: 'notifications',
      },
      {
        label: 'Settings',
        href: '/dashboard/privacy',
        icon: <LuSettings size={14} aria-hidden="true" />,
      },
    ],
  },
];

/**
 * Administrators get the two-level structure the other roles have implicitly —
 * platform work grouped together, the administrator's own account entry
 * separate. There is deliberately no "System management" group: the backend
 * exposes no platform-configuration endpoints, and a link to an empty page
 * would be worse than no link.
 */
const adminGroups: NavGroup[] = [
  {
    heading: 'Platform',
    items: [
      {
        label: 'Overview',
        href: '/dashboard',
        icon: <LuLayoutDashboard size={14} aria-hidden="true" />,
      },
      { label: 'Users', href: '/admin/users', icon: <LuUsers size={14} aria-hidden="true" /> },
      {
        label: 'Technicians',
        href: '/admin/technicians',
        icon: <LuWrench size={14} aria-hidden="true" />,
      },
      {
        label: 'Requests',
        href: '/admin/requests',
        icon: <LuClipboardList size={14} aria-hidden="true" />,
      },
      {
        label: 'Audit log',
        href: '/admin/audit',
        icon: <LuShieldCheck size={14} aria-hidden="true" />,
      },
    ],
  },
  {
    heading: 'Account',
    items: [
      {
        label: 'Settings',
        href: '/dashboard/privacy',
        icon: <LuSettings size={14} aria-hidden="true" />,
      },
    ],
  },
];

const GROUPS_BY_ROLE: Record<UserRole, NavGroup[]> = {
  customer: customerGroups,
  technician: technicianGroups,
  administrator: adminGroups,
};

/**
 * Menu groups for a role. An unresolved session gets no items at all — never
 * another role's menu.
 */
export function navGroupsForRole(role: UserRole | undefined | null): NavGroup[] {
  if (!role) return [];
  return GROUPS_BY_ROLE[role] ?? [];
}

/** Flat view of the same mapping (drawer rendering, active-item matching). */
export function navItemsForRole(role: UserRole | undefined | null): NavItem[] {
  return navGroupsForRole(role).flatMap((group) => group.items);
}
