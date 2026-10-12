import type { AccountStatus, UserRole } from '@/lib/auth/authTypes';
import type { BadgeTone } from '@/components/ui';
import { Badge } from '@/components/ui';
import type { DispatchOfferStatus, ServiceRequestStatus } from '@/lib/types';

/**
 * Status badges for the administrator screens (Task 25 §9: clear status
 * badges everywhere). Tone maps are exhaustive `Record`s over the shared
 * domain unions, so TypeScript rejects a missing case; the colour is
 * never the only signal — the text label always spells the status out.
 *
 * Technician-profile account status keeps its OWN vocabulary
 * (active | inactive | suspended — Task 11) which is distinct from the
 * users table's (active | suspended | disabled), hence the separate map
 * with a neutral fallback for anything unexpected.
 */

/* ------------------------- tone maps ------------------------- */

const REQUEST_STATUS_TONES: Record<ServiceRequestStatus, BadgeTone> = {
  pending: 'neutral',
  matching: 'warning',
  matched: 'teal',
  in_progress: 'teal',
  no_match: 'coral',
  completed: 'success',
  cancelled: 'neutral',
};

const OFFER_STATUS_TONES: Record<DispatchOfferStatus, BadgeTone> = {
  pending: 'warning',
  accepted: 'success',
  rejected: 'neutral',
  timed_out: 'neutral',
};

const USER_ACCOUNT_TONES: Record<AccountStatus, BadgeTone> = {
  active: 'success',
  suspended: 'warning',
  disabled: 'coral',
};

const PROFILE_ACCOUNT_TONES: Record<string, BadgeTone> = {
  active: 'success',
  inactive: 'neutral',
  suspended: 'warning',
};

const ROLE_TONES: Record<UserRole, BadgeTone> = {
  customer: 'neutral',
  technician: 'teal',
  administrator: 'success',
};

const AVAILABILITY_TONES: Record<string, BadgeTone> = {
  available: 'success',
  unavailable: 'neutral',
};

/* ------------------------- helpers ------------------------- */

/** 'no_match' → 'No match', 'in_progress' → 'In progress', else Capitalised. */
export function requestStatusLabel(status: string): string {
  if (status === 'no_match') return 'No match';
  if (status === 'in_progress') return 'In progress';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/* ------------------------- components ------------------------- */

export function RequestStatusBadge({ status }: { status: ServiceRequestStatus }) {
  return <Badge tone={REQUEST_STATUS_TONES[status]}>{requestStatusLabel(status)}</Badge>;
}

export function OfferStatusBadge({ status }: { status: DispatchOfferStatus }) {
  const label = status === 'timed_out' ? 'Timed out' : requestStatusLabel(status);
  return <Badge tone={OFFER_STATUS_TONES[status]}>{label}</Badge>;
}

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  return <Badge tone={USER_ACCOUNT_TONES[status]}>{requestStatusLabel(status)}</Badge>;
}

/** Technician-profile status (Task 11 vocabulary, string on the wire). */
export function ProfileAccountBadge({ status }: { status: string }) {
  const tone = PROFILE_ACCOUNT_TONES[status] ?? 'neutral';
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <Badge tone={tone}>{label}</Badge>;
}

export function RoleBadge({ role }: { role: UserRole }) {
  const label = role === 'administrator' ? 'Admin' : requestStatusLabel(role);
  return <Badge tone={ROLE_TONES[role]}>{label}</Badge>;
}

export function VerificationBadge({ verified }: { verified: boolean }) {
  return (
    <Badge tone={verified ? 'success' : 'warning'}>{verified ? 'Verified' : 'Unverified'}</Badge>
  );
}

export function AvailabilityBadge({ status }: { status: string }) {
  const tone = AVAILABILITY_TONES[status] ?? 'neutral';
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <Badge tone={tone}>{label}</Badge>;
}
