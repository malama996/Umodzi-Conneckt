// Backend API types for Service Request, Technician, Offer, etc.

// Local copies of the lifecycle/offer status unions (mirroring the
// frontend domain contract in frontend/lib/types.ts). The backend
// persists and validates these values but does not implement the
// dispatch state machine.
export type ServiceRequestStatus =
  | 'pending'
  | 'matching'
  | 'matched'
  | 'no_match'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type DispatchOfferStatus = 'pending' | 'accepted' | 'rejected' | 'timed_out';

// Technician API shape (mirrors the frontend Technician but with additional DB fields)
export interface TechnicianApi {
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
  accountStatus: string;
  /**
   * Task 28.3A.1 (G-01): precise coordinates are NEVER included in a public
   * technician projection, so these are optional and in practice always
   * `undefined` on public routes. They exist on the type only so an
   * owner-scoped/internal caller that legitimately holds a coordinate still
   * typechecks. Coarse location is conveyed by `serviceArea`.
   */
  latitude?: number;
  longitude?: number;
  /** Task 26: optional public bio (null until the technician writes one). */
  bio?: string | null;
  /** Task 26: true when a retrievable profile photo exists (photo bytes are served by GET /technicians/:id/photo; storage keys are never exposed). */
  hasPhoto?: boolean;
  createdAt: string;
  updatedAt: string;
}

// Service Request API shape (mirrors frontend ServiceRequest)
export interface ServiceRequestApi {
  id: string;
  description: string;
  category: string;
  city: string;
  /**
   * Reserved for a future opt-in location capture. The current API never
   * accepts or returns request coordinates, and no projection populates these —
   * do not start emitting them without the Task 28.3 location/retention
   * decision that would follow (see docs/DATA_RETENTION_POLICY.md).
   */
  latitude?: number;
  longitude?: number;
  status: ServiceRequestStatus;
  createdAt: string;
  updatedAt: string;
}

// Offer API shape
export interface OfferApi {
  id: string;
  requestId: string;
  technicianId: string;
  candidateIndex: number;
  status: DispatchOfferStatus;
  createdAt: string;
  updatedAt: string;
}

// API response wrapper
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
  details?: any;
}

// For nearby technicians query
export interface NearbyTechniciansQuery {
  latitude: number;
  longitude: number;
  radius?: number; // in kilometers (default 50)
  category?: string;
}

// ---------------------------------------------------------------------------
// Task 23 — authentication & authorization types
// ---------------------------------------------------------------------------

/** The three roles of the system (strongly typed union — never raw strings). */
export type UserRole = 'customer' | 'technician' | 'administrator';

/** Account lifecycle state. Only 'active' accounts may authenticate. */
export type AccountStatus = 'active' | 'suspended' | 'disabled';

/**
 * Safe public identity returned by the auth endpoints. Contains NO
 * password material and NO profile/PII beyond what the account itself
 * needs; mutable state is re-read from the database on every request.
 * `technicianId`/`technicianName` are present for technician accounts and
 * link the session to exactly one technicians row (unique user_id).
 */
export interface AuthUserApi {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  accountStatus: AccountStatus;
  technicianId?: string;
  technicianName?: string;
}

/** Envelope for auth responses: { data: { user, accessToken } } etc. */
export interface AuthResponseApi<T> {
  data: T;
}

// ---------------------------------------------------------------------------
// Task 25 — administrator / platform management types
//
// Every shape below is a SAFE projection: no password hashes, no session
// rows, no tokens — only the fields an administrator needs to operate the
// platform. Role/account-status values are constrained by database CHECK
// constraints, and request/offer statuses are validated at the mapping
// boundary (toRequestStatus/toOfferStatus) before entering a response.
// ---------------------------------------------------------------------------

/** Safe user listing row for administrators (never password/session material). */
export interface AdminUserApi {
  id: string;
  email: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  accountStatus: AccountStatus;
  createdAt: string;
}

/** Technician profile plus the linked account identity when one exists. */
export interface AdminTechnicianApi {
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
  accountStatus: string;
  userId: string | null;
  userEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One dispatch offer reduced to its monitoring fields. */
export interface AdminOfferSummaryApi {
  id: string;
  technicianId: string;
  technicianName: string;
  status: DispatchOfferStatus;
  createdAt: string;
}

/** Service request + owning customer + offers, for platform monitoring. */
export interface AdminRequestApi {
  id: string;
  description: string;
  category: string;
  city: string;
  status: ServiceRequestStatus;
  createdAt: string;
  updatedAt: string;
  customerUserId: string | null;
  customerEmail: string | null;
  customerName: string | null;
  offers: AdminOfferSummaryApi[];
}

/**
 * One merged recent-activity event. `at` is the ISO timestamp of the
 * underlying row (request created, account joined, offer recorded).
 */
export type AdminActivityEventApi =
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

/** Role → count (roles absent from the table are reported as 0). */
export type AdminRoleCounts = Record<UserRole, number>;

/**
 * Platform overview. Every number is a direct aggregate over real rows —
 * nothing is estimated. `requests.open` = pending + matching + matched +
 * in_progress (work that is not yet completed, cancelled, or no-match);
 * `noMatch` = dispatch exhausted and the request remains unresolved.
 */
export interface AdminOverviewApi {
  users: {
    total: number;
    byRole: AdminRoleCounts;
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
  recent: AdminActivityEventApi[];
}

// ---------------------------------------------------------------------------
// Task 26 — technician profile, verification documents & lifecycle
//
// The legacy `verified` boolean remains the canonical "is verified" flag
// (dispatch trust score, public badges, Task 25 admin surface) and is kept
// consistent with `verification_status` in application code at every write
// (verified ⟺ verification_status = 'verified'). Storage keys are NEVER
// part of any wire shape — files are streamed by authorized endpoints.
// ---------------------------------------------------------------------------

/** Verification lifecycle for account-linked technicians. */
export type TechnicianVerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

/** Evidence document categories a technician can submit. */
export type VerificationDocumentType = 'national_id' | 'certificate' | 'other';

/** Safe document metadata (no storage key, no file bytes). */
export interface TechnicianDocumentApi {
  id: string;
  documentType: VerificationDocumentType;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

/** The technician's own profile + verification state (owner-only fields). */
export interface TechnicianOwnProfileApi {
  id: string;
  name: string;
  category: string;
  skills: string[];
  serviceArea: string;
  bio: string | null;
  hasPhoto: boolean;
  rating: number;
  jobs: number;
  availability: string;
  availabilityStatus: string;
  accountStatus: string;
  verified: boolean;
  verificationStatus: TechnicianVerificationStatus;
  verificationRejectionReason: string | null;
  verificationSubmittedAt: string | null;
  verificationReviewedAt: string | null;
  documents: TechnicianDocumentApi[];
  createdAt: string;
  updatedAt: string;
}

/** Administrator verification review bundle: profile + state + documents. */
export interface AdminTechnicianVerificationApi {
  id: string;
  name: string;
  category: string;
  skills: string[];
  serviceArea: string;
  bio: string | null;
  hasPhoto: boolean;
  rating: number;
  jobs: number;
  availability: string;
  availabilityStatus: string;
  accountStatus: string;
  verified: boolean;
  verificationStatus: TechnicianVerificationStatus;
  verificationRejectionReason: string | null;
  verificationSubmittedAt: string | null;
  verificationReviewedAt: string | null;
  verificationReviewedBy: string | null;
  verificationReviewerEmail: string | null;
  userId: string | null;
  userEmail: string | null;
  documents: TechnicianDocumentApi[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Task 27 — customer ratings & reviews
//
// A review belongs to exactly ONE completed service request (unique index),
// written by the request's owner about the technician who ACCEPTED the job.
// customer/technician ids are always derived server-side. Public shapes
// carry only public-safe fields — no emails, no account ids.
// ---------------------------------------------------------------------------

/** One review as exposed publicly (technician profile) and to the owner. */
export interface ReviewApi {
  id: string;
  rating: number;
  comment: string | null;
  /** Public-safe display: first name + last initial ("Chipo T."). */
  customerName: string;
  createdAt: string;
}

/** Owner/admin view of the review state for one service request. */
export interface RequestReviewApi {
  review: ReviewApi | null;
  /** true only when status='completed' AND a matched technician exists AND no review yet. */
  eligible: boolean;
  /** Name of the technician who accepted the job (null when none did). */
  technicianName: string | null;
}

/** Real aggregate over the reviews table — never hard-coded. */
export interface ReviewSummaryApi {
  /** null when the technician has no reviews yet. */
  average: number | null;
  count: number;
  /** Star → number of reviews (all five keys always present, zero-filled). */
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

/** Public reputation bundle for one technician. */
export interface TechnicianReviewsApi {
  technicianId: string;
  summary: ReviewSummaryApi;
  reviews: ReviewApi[];
}

/**
 * Canonical service categories (mirrors the frontend category list).
 * Single in-backend source of truth for validation — registration uses it
 * for technician accounts, request creation uses it for requests.
 */
export const CANONICAL_CATEGORIES = [
  'Plumbing',
  'Electrical',
  'Automotive',
  'HVAC',
  'Appliance Repair',
  'Refrigeration',
  'Electronics',
  'ICT',
  'Handyman',
] as const;


// ---------------------------------------------------------------------------
// Task 28 — Notifications & Push Subscriptions types
// ---------------------------------------------------------------------------

export type NotificationChannel = 'in_app' | 'sms' | 'push' | 'email';
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed';

export interface NotificationApi {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  channel: NotificationChannel;
  referenceType?: string | null;
  referenceId?: string | null;
  read: boolean;
  status: NotificationStatus;
  createdAt: string;
  sentAt?: string | null;
  readAt?: string | null;
}

export interface NotificationListApi {
  notifications: NotificationApi[];
  unreadCount: number;
  totalCount: number;
}

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: PushSubscriptionKeys;
  userAgent?: string;
}

/**
 * Task 28.2B — what GET-your-subscription responses and the
 * POST /me/push-subscriptions success body carry. Deliberately minimal:
 * the id (needed for DELETE), the endpoint (so the browser can match it
 * against its PushManager subscription) and metadata. No keys, no user
 * id (it is always the caller), no database internals.
 */
export interface PushSubscriptionApi {
  id: string;
  endpoint: string;
  userAgent?: string | null;
  createdAt: string;
  updatedAt: string;
}