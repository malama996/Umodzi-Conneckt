import type { AccountStatus, UserRole } from '@/lib/auth/authTypes';
import type { DispatchOfferStatus, ServiceRequestStatus } from '@/lib/types';
import { get, patch } from './client';

/**
 * Administrator / platform-management API surface (Task 25).
 *
 * Typed mirrors of the backend admin contract (camelCase JSON inside the
 * standard `{ data }` envelope). Every shape is a SAFE projection — the
 * backend never returns password hashes, session rows, or tokens, and
 * nothing here ever asks for them. All endpoints are administrator-only
 * and are enforced SERVER-SIDE (requireRole) — the frontend role gate is
 * convenience, never the security boundary.
 */

export interface AdminUser {
  id: string;
  email: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  accountStatus: AccountStatus;
  createdAt: string;
}

export interface AdminTechnician {
  id: string;
  name: string;
  category: string;
  skills: string[];
  serviceArea: string;
  rating: number;
  jobs: number;
  verified: boolean;
  availability: string;
  availabilityStatus: string;
  /** Profile vocabulary (seed data): active | inactive | suspended. */
  accountStatus: string;
  /** Linked account (null for seeded prototype profiles without an account). */
  userId: string | null;
  userEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminOfferSummary {
  id: string;
  technicianId: string;
  technicianName: string;
  status: DispatchOfferStatus;
  createdAt: string;
}

export interface AdminRequest {
  id: string;
  description: string;
  category: string;
  city: string;
  status: ServiceRequestStatus;
  createdAt: string;
  updatedAt: string;
  /** Null for legacy pre-auth rows that were never claimed. */
  customerUserId: string | null;
  customerEmail: string | null;
  customerName: string | null;
  offers: AdminOfferSummary[];
}

export type AdminActivityEvent =
  | {
      kind: 'request';
      id: string;
      category: string;
      city: string;
      status: ServiceRequestStatus;
      at: string;
    }
  | { kind: 'user'; id: string; email: string; role: UserRole; at: string }
  | {
      kind: 'offer';
      id: string;
      technicianName: string;
      category: string;
      status: DispatchOfferStatus;
      at: string;
    };

export interface AdminOverview {
  users: {
    total: number;
    byRole: Record<UserRole, number>;
    active: number;
    suspended: number;
    disabled: number;
  };
  technicians: {
    total: number;
    active: number;
    available: number;
    verified: number;
    unverified: number;
  };
  requests: {
    total: number;
    byStatus: Record<ServiceRequestStatus, number>;
    open: number;
    completed: number;
    cancelled: number;
    noMatch: number;
  };
  offers: {
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
    timedOut: number;
  };
  recent: AdminActivityEvent[];
}

/** Backend envelope shared by every admin endpoint. */
interface AdminEnvelope<T> {
  data: T;
}

/** Platform overview (counts + recent activity), administrator only. */
export async function getAdminOverview(): Promise<AdminOverview> {
  const body = await get<AdminEnvelope<AdminOverview>>('/admin/overview');
  return body.data;
}

/** All accounts, safe fields only, oldest first (backend order). */
export async function getAdminUsers(): Promise<AdminUser[]> {
  const body = await get<AdminEnvelope<AdminUser[]>>('/admin/users');
  return body.data;
}

/** All technician profiles with their linked account, by name (backend order). */
export async function getAdminTechnicians(): Promise<AdminTechnician[]> {
  const body = await get<AdminEnvelope<AdminTechnician[]>>('/admin/technicians');
  return body.data;
}

/** All service requests with customer + offers, newest first (backend order). */
export async function getAdminRequests(): Promise<AdminRequest[]> {
  const body = await get<AdminEnvelope<AdminRequest[]>>('/admin/requests');
  return body.data;
}

/**
 * Set an account's status (activation/deactivation). Server-authorized:
 * 400 invalid status/id, 403 self-change or wrong role, 404 unknown user.
 */
export async function updateAdminUserStatus(
  id: string,
  accountStatus: AccountStatus,
): Promise<AdminUser> {
  const body = await patch<AdminEnvelope<AdminUser>>(
    `/admin/users/${encodeURIComponent(id)}/status`,
    { accountStatus },
  );
  return body.data;
}

/* ---------------------------------------------------------------------------
 * Audit log (Phase 6)
 *
 * The backend has recorded audit events since Task 28.3F and exposes them at
 * GET /admin/audit-events, but nothing in the UI ever read them — privileged
 * activity was written and then invisible to the administrators who need it.
 *
 * Field names stay snake_case because that is exactly what the endpoint
 * returns (listAuditEvents returns raw rows); renaming them here would invent
 * a shape the server never sends.
 * ------------------------------------------------------------------------- */

/** One audit-log entry, exactly as the backend returns it. */
export interface AuditEvent {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  actor_role: string | null;
  target_user_id: string | null;
  target_entity_type: string | null;
  target_entity_id: string | null;
  outcome: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface AuditEventPage {
  events: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AuditEventQuery {
  limit?: number;
  offset?: number;
  eventType?: string;
  outcome?: 'success' | 'failure' | 'denied';
  actorUserId?: string;
}

/**
 * Mirrors AUDIT_EVENT_TYPES in backend/src/privacy/auditService.ts so the
 * filter can offer every category the server accepts. The server remains the
 * authority: it validates the query and answers 400 for a value outside this
 * vocabulary, so a future divergence fails loudly rather than silently
 * filtering nothing.
 */
export const AUDIT_EVENT_TYPES = [
  'auth.login_failed',
  'auth.login_succeeded',
  'auth.account_locked',
  'privacy.data_exported',
  'privacy.account_deleted',
  'admin.user_status_changed',
  'admin.verification_decision',
  'admin.conversation_metadata_accessed',
  'security.verification_document_accessed',
  'security.verification_document_deleted',
  'account.suspended',
  'account.reactivated',
] as const;

/**
 * Administrator-only audit read (403 for everyone else — enforced on the
 * server, not here). Filters are forwarded as query parameters; this layer
 * never narrows the result itself.
 */
export async function getAuditEvents(query: AuditEventQuery = {}): Promise<AuditEventPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.eventType) params.set('eventType', query.eventType);
  if (query.outcome) params.set('outcome', query.outcome);
  if (query.actorUserId) params.set('actorUserId', query.actorUserId);
  const search = params.toString();
  const body = await get<AdminEnvelope<AuditEventPage>>(
    `/admin/audit-events${search ? `?${search}` : ''}`,
  );
  return body.data;
}
