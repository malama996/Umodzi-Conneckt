import type { AccountStatus, UserRole } from '@/lib/auth/authTypes';
import { ApiError } from '@/lib/api/client';
import {
  getAdminOverview,
  getAdminRequests,
  getAdminTechnicians,
  getAdminUsers,
  getAuditEvents,
  updateAdminUserStatus,
} from '@/lib/api/adminApi';
import type {
  AdminOverview,
  AdminRequest,
  AdminTechnician,
  AdminUser,
  AuditEventPage,
  AuditEventQuery,
} from '@/lib/api/adminApi';
import type { ServiceRequestStatus } from '@/lib/types';

/**
 * Administrator application service (Task 25).
 *
 * Follows the established layering (UI → services → lib/api → HTTP): pages
 * never call the API client directly. Besides the thin fetch/mutate
 * boundary, this module owns the PURE view helpers the admin screens need —
 * search/filter predicates, status counts, and timestamp formatting — so
 * the filtering logic stays out of the components and out of the browser's
 * "business logic" concern (no data is ever computed here that the server
 * should own; the backend produces every number these views display).
 */

export function fetchAdminOverview(): Promise<AdminOverview> {
  return getAdminOverview();
}

export function fetchAdminUsers(): Promise<AdminUser[]> {
  return getAdminUsers();
}

export function fetchAdminTechnicians(): Promise<AdminTechnician[]> {
  return getAdminTechnicians();
}

export function fetchAdminRequests(): Promise<AdminRequest[]> {
  return getAdminRequests();
}

/** Server-authorized account activation/deactivation. */
export function setUserAccountStatus(id: string, accountStatus: AccountStatus): Promise<AdminUser> {
  return updateAdminUserStatus(id, accountStatus);
}

/** Server-authorized, server-filtered audit read (administrator only). */
export function fetchAuditEvents(query: AuditEventQuery = {}): Promise<AuditEventPage> {
  return getAuditEvents(query);
}

/**
 * Render an audit event's minimised metadata as `key=value` pairs.
 *
 * The backend stores only allow-listed primitive values (opaque ids, booleans,
 * counts, reason codes) precisely so no personal data reaches this log. A
 * non-primitive is still stringified defensively rather than dropped: hiding
 * detail from an audit view would be worse than showing it plainly.
 */
export function formatAuditMetadata(metadata: Record<string, unknown> | null): string {
  if (!metadata) return '';
  const entries = Object.entries(metadata);
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => {
      const rendered =
        value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}=${rendered}`;
    })
    .join(' · ');
}

/**
 * Human-readable message for a failed admin fetch/mutation. Auth-aware:
 * 401/403 get explicit copy, everything else falls back to the error's
 * own message (ApiError carries the backend's safe `{ error }` text and
 * never any secret material).
 */
export function adminErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session has expired. Please sign in again.';
    if (error.status === 403) return 'You do not have permission to perform this action.';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong while contacting the server.';
}

/* ------------------------------------------------------------------ */
/* View helpers (pure — no I/O)                                        */
/* ------------------------------------------------------------------ */

/** ISO timestamp → localised string; falls back to the raw value. */
export function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function matches(needle: string, haystack: (string | null | undefined)[]): boolean {
  const probe = needle.trim().toLowerCase();
  if (!probe) return true;
  return haystack.some((field) => (field ?? '').toLowerCase().includes(probe));
}

export interface AdminUserFilter {
  search: string;
  role: UserRole | 'all';
  status: AccountStatus | 'all';
}

/** Search by name/email, filter by role and account status. */
export function filterAdminUsers(users: AdminUser[], filter: AdminUserFilter): AdminUser[] {
  return users.filter(
    (user) =>
      (filter.role === 'all' || user.role === filter.role) &&
      (filter.status === 'all' || user.accountStatus === filter.status) &&
      matches(filter.search, [user.email, user.firstName, user.lastName]),
  );
}

/** Technician profile account-status vocabulary (distinct from users'). */
export type TechnicianAccountFilter = 'all' | 'active' | 'inactive' | 'suspended';

export interface AdminTechnicianFilter {
  search: string;
  category: string; // canonical category name or 'all'
  status: TechnicianAccountFilter;
}

/**
 * Search by name/category/service area/skills/linked email, filter by
 * category and profile account status.
 */
export function filterAdminTechnicians(
  technicians: AdminTechnician[],
  filter: AdminTechnicianFilter,
): AdminTechnician[] {
  return technicians.filter(
    (tech) =>
      (filter.category === 'all' || tech.category === filter.category) &&
      (filter.status === 'all' || tech.accountStatus === filter.status) &&
      matches(filter.search, [
        tech.name,
        tech.category,
        tech.serviceArea,
        tech.userEmail,
        ...tech.skills,
      ]),
  );
}

export type AdminRequestStatusFilter = ServiceRequestStatus | 'all';

export interface AdminRequestFilter {
  search: string;
  status: AdminRequestStatusFilter;
}

/** Search by category/city/id/description, filter by request status. */
export function filterAdminRequests(
  requests: AdminRequest[],
  filter: AdminRequestFilter,
): AdminRequest[] {
  return requests.filter(
    (request) =>
      (filter.status === 'all' || request.status === filter.status) &&
      matches(filter.search, [request.category, request.city, request.id, request.description]),
  );
}

/**
 * Per-status counts for the filter chips — computed from the loaded rows
 * (display convenience only; the authoritative counts come from the
 * backend overview aggregate).
 */
export function requestStatusCounts(
  requests: AdminRequest[],
): Record<AdminRequestStatusFilter, number> {
  const counts: Record<AdminRequestStatusFilter, number> = {
    all: requests.length,
    pending: 0,
    matching: 0,
    matched: 0,
    no_match: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const request of requests) {
    counts[request.status] += 1;
  }
  return counts;
}
