import { ApiError } from '@/lib/api/client';
import type { BadgeTone } from '@/components/ui';
import {
  deleteVerificationDocument,
  decideTechnicianVerification,
  downloadVerificationDocument,
  getAdminTechnicianVerification,
  getOwnProfile,
  submitVerification,
  updateOwnProfile,
  uploadOwnPhoto,
  uploadVerificationDocument,
  type AdminTechnicianVerification,
  type OwnProfilePatch,
  type OwnTechnicianProfile,
  type TechnicianDocument,
  type TechnicianVerificationStatus,
  type VerificationDocumentType,
} from '@/lib/api/technicianProfileApi';

/**
 * Technician profile + verification service boundary (Task 26). Pages call
 * these helpers — never the API client directly. Pure display helpers
 * (completeness, labels, tones) live here too so every surface agrees.
 */

/* ------------------------- fetch / mutate ------------------------- */

export const fetchOwnProfile = (): Promise<OwnTechnicianProfile> => getOwnProfile();

export const saveOwnProfile = (patch: OwnProfilePatch): Promise<OwnTechnicianProfile> =>
  updateOwnProfile(patch);

export const uploadProfilePhoto = (file: File): Promise<{ hasPhoto: boolean }> =>
  uploadOwnPhoto(file);

export const uploadDocument = (
  documentType: VerificationDocumentType,
  file: File,
): Promise<TechnicianDocument> => uploadVerificationDocument(documentType, file);

export const withdrawDocument = (id: string): Promise<{ deleted: boolean }> =>
  deleteVerificationDocument(id);

export const submitForReview = (): Promise<{ verificationStatus: TechnicianVerificationStatus }> =>
  submitVerification();

export const fetchDocumentBlob = (id: string): Promise<Blob> => downloadVerificationDocument(id);

export const fetchAdminVerification = (
  technicianId: string,
): Promise<AdminTechnicianVerification> => getAdminTechnicianVerification(technicianId);

export const decideVerification = (
  technicianId: string,
  decision: { decision: 'verified' } | { decision: 'rejected'; reason: string },
): Promise<AdminTechnicianVerification> => decideTechnicianVerification(technicianId, decision);

/* ------------------------- display helpers ------------------------- */

/**
 * Upload/review labels for each verification document type.
 *
 * The two documents policy asks for are named explicitly and unambiguously:
 * the National Registration Card (NRC) is the identity document, and the
 * certificate is the professional-qualification evidence. Both are uploaded
 * independently and both are listed to the reviewing administrator with these
 * same labels, so what the technician submitted is what the reviewer sees.
 */
export const DOCUMENT_TYPE_LABELS: Record<VerificationDocumentType, string> = {
  national_id: 'National Registration Card (NRC)',
  certificate: 'Certificate / proof of qualification',
  other: 'Other supporting document',
};

export interface VerificationDisplay {
  heading: string;
  copy: string;
  tone: BadgeTone;
}

/** Status → panel copy for the technician's own verification card. */
export function verificationDisplay(status: TechnicianVerificationStatus): VerificationDisplay {
  switch (status) {
    case 'verified':
      return {
        heading: 'Verified',
        copy: 'Your identity and qualifications have been reviewed and approved.',
        tone: 'success',
      };
    case 'pending':
      return {
        heading: 'Pending review',
        copy: 'Your documents are with the platform team. You will see the outcome here.',
        tone: 'warning',
      };
    case 'rejected':
      return {
        heading: 'Action required',
        copy: 'The review team asked for corrections. Read the feedback below, update your documents, and resubmit.',
        tone: 'coral',
      };
    case 'unverified':
      return {
        heading: 'Not submitted',
        copy: 'Upload your National ID (and any trade certificates), then submit for review to become dispatch-eligible.',
        tone: 'neutral',
      };
  }
}

/** Status → badge tone (admin + technician lists). */
export function verificationTone(status: TechnicianVerificationStatus): BadgeTone {
  return verificationDisplay(status).tone;
}

export function verificationLabel(status: TechnicianVerificationStatus): string {
  switch (status) {
    case 'verified':
      return 'Verified';
    case 'pending':
      return 'Pending review';
    case 'rejected':
      return 'Action required';
    case 'unverified':
      return 'Not submitted';
  }
}

/**
 * Profile completeness from REAL required fields (§12 — never hard-coded).
 * Five checks, each worth 20%: bio, at least one skill, profile photo,
 * service area, availability text. Identity (name/account) always exists
 * from registration and is not "completable", so it is not counted.
 */
export interface CompletenessCheck {
  key: 'bio' | 'skills' | 'photo' | 'serviceArea' | 'availability';
  label: string;
  done: boolean;
}

export interface ProfileCompleteness {
  checks: CompletenessCheck[];
  done: number;
  total: number;
  percent: number;
}

export function profileCompleteness(profile: OwnTechnicianProfile): ProfileCompleteness {
  const checks: CompletenessCheck[] = [
    { key: 'bio', label: 'Professional bio', done: (profile.bio ?? '').trim().length > 0 },
    { key: 'skills', label: 'At least one skill', done: profile.skills.length > 0 },
    { key: 'photo', label: 'Profile photo', done: profile.hasPhoto },
    { key: 'serviceArea', label: 'Service area', done: profile.serviceArea.trim().length > 0 },
    {
      key: 'availability',
      label: 'Availability note',
      done: profile.availability.trim().length > 0,
    },
  ];
  const done = checks.filter((check) => check.done).length;
  return {
    checks,
    done,
    total: checks.length,
    percent: Math.round((done / checks.length) * 100),
  };
}

/** Compact byte formatting for document lists (real sizes). */
export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Human-readable message for failed profile/verification calls. */
export function profileErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session has expired. Please sign in again.';
    if (error.status === 403) return 'You do not have permission to perform this action.';
    if (error.status === 413) return 'That file is too large — the limit is 5 MB.';
    if (error.status === 415) return 'That file type is not supported here.';
    try {
      const parsed = JSON.parse(error.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* fall through */
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong while contacting the server.';
}
