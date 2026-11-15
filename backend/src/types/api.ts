export type ServiceRequestStatus =
  | 'pending'
  | 'matching'
  | 'matched'
  | 'no_match'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type DispatchOfferStatus = 'pending' | 'accepted' | 'rejected' | 'timed_out';

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
   * Precise coordinates are never included in a public
   * technician projection, so these are optional and in practice always
   * `undefined` on public routes. They exist on the type only so an
   * owner-scoped/internal caller that legitimately holds a coordinate still
   * typechecks. Coarse location is conveyed by `serviceArea`.
   */
  latitude?: number;
  longitude?: number;
  bio?: string | null;
  hasPhoto?: boolean;
  /**
   * Audit §5.D — customer-facing trust indicators. The document CATEGORIES
   * whose evidence an authorised reviewer has individually APPROVED. Only
   * genuinely approved categories appear; this is derived from real review
   * records, never from upload. Contains no document images, identity
   * numbers, filenames, storage keys, or reviewer notes. Optional because
   * public list projections may omit it (detail profiles populate it).
   */
  verifiedCategories?: VerificationDocumentType[];
  createdAt: string;
  updatedAt: string;
}

export interface ServiceRequestApi {
  id: string;
  description: string;
  category: string;
  city: string;
  /**
   * Reserved for a future opt-in location capture. The current API never
   * accepts or returns request coordinates, and no projection populates these —
   * do not start emitting them without a corresponding location-retention
   * decision (see docs/DATA_RETENTION_POLICY.md).
   */
  latitude?: number;
  longitude?: number;
  status: ServiceRequestStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * Additive detail fields. Only `GET /requests/:id`
   * populates them; other projections omit them, so consumers must treat
   * both as nullable rather than assume presence.
   */
  assignedTechnicianName?: string | null;
  conversationId?: string | null;
}

export interface OfferApi {
  id: string;
  requestId: string;
  technicianId: string;
  candidateIndex: number;
  status: DispatchOfferStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
  details?: any;
}

export interface NearbyTechniciansQuery {
  latitude: number;
  longitude: number;
  radius?: number;
  category?: string;
}

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

/**
 * Verification lifecycle for account-linked technicians.
 *
 * 'partially_verified' means some evidence documents have been
 * approved but the required identity evidence and/or other submitted
 * documents are still outstanding, pending, or rejected. The overall status
 * is DERIVED from the individual document review outcomes by the backend
 * (recomputeVerificationStatus) — it is never conferred by upload alone.
 */
export type TechnicianVerificationStatus =
  | 'unverified'
  | 'pending'
  | 'partially_verified'
  | 'verified'
  | 'rejected';

/** Evidence document categories a technician can submit. */
export type VerificationDocumentType =
  | 'national_id'
  | 'certificate'
  | 'trade_qualification'
  | 'professional_licence'
  | 'business_registration'
  | 'training_certificate'
  | 'other';

/** Per-document review outcome. */
export type VerificationDocumentStatus = 'pending' | 'approved' | 'rejected';

/**
 * Safe document metadata (no storage key, no file bytes). Carries the
 * individual review outcome so a technician can see which of their own
 * documents are approved, rejected (with the correction reason), or still
 * pending, and an administrator can review each document separately.
 */
export interface TechnicianDocumentApi {
  id: string;
  documentType: VerificationDocumentType;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: VerificationDocumentStatus;
  reviewReason: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
}

/** One entry in a document's append-only review history (admin view). */
export interface VerificationReviewApi {
  id: string;
  documentId: string;
  decision: 'approved' | 'rejected';
  reason: string | null;
  reviewerEmail: string | null;
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
  /** Append-only per-document review history, newest first. */
  reviews: VerificationReviewApi[];
  createdAt: string;
  updatedAt: string;
}

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
 * what GET-your-subscription responses and the
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
