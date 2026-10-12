import type { TechnicianCategory } from '@/lib/categories';
import type { AvailabilityStatus } from '@/lib/types';
import { del, get, patch, post, postForm, getBlob } from './client';

/**
 * Technician profile + verification API (Task 26) — wire shapes mirror the
 * backend exactly. Storage keys never appear here; document bytes travel
 * through getBlob (authorized) and photo bytes are served publicly by the
 * backend (components reference the public photo URL directly).
 */

export type TechnicianVerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

export type VerificationDocumentType = 'national_id' | 'certificate' | 'other';

export interface TechnicianDocument {
  id: string;
  documentType: VerificationDocumentType;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface OwnTechnicianProfile {
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
  documents: TechnicianDocument[];
  createdAt: string;
  updatedAt: string;
}

export interface OwnProfilePatch {
  bio?: string | null;
  skills?: string[];
  category?: TechnicianCategory;
  serviceArea?: string;
  availability?: string;
  availabilityStatus?: AvailabilityStatus;
}

interface Envelope<T> {
  data: T;
}

/** GET /technician/profile — own profile + verification state + documents. */
export async function getOwnProfile(): Promise<OwnTechnicianProfile> {
  const body = await get<Envelope<OwnTechnicianProfile>>('/technician/profile');
  return body.data;
}

/** PATCH /technician/profile — owner-editable fields only. */
export async function updateOwnProfile(changes: OwnProfilePatch): Promise<OwnTechnicianProfile> {
  const body = await patch<Envelope<OwnTechnicianProfile>>('/technician/profile', changes);
  return body.data;
}

/** POST /technician/photo — replace the profile photo (multipart). */
export async function uploadOwnPhoto(file: File): Promise<{ hasPhoto: boolean }> {
  const form = new FormData();
  form.append('file', file, file.name);
  const body = await postForm<Envelope<{ hasPhoto: boolean }>>('/technician/photo', form);
  return body.data;
}

/** POST /technician/verification/documents — one evidence document. */
export async function uploadVerificationDocument(
  documentType: VerificationDocumentType,
  file: File,
): Promise<TechnicianDocument> {
  const form = new FormData();
  form.append('documentType', documentType); // fields BEFORE the file (busboy order)
  form.append('file', file, file.name);
  const body = await postForm<Envelope<TechnicianDocument>>(
    '/technician/verification/documents',
    form,
  );
  return body.data;
}

/** DELETE /technician/verification/documents/:id — withdraw while editable. */
export async function deleteVerificationDocument(id: string): Promise<{ deleted: boolean }> {
  const body = await del<Envelope<{ deleted: boolean }>>(
    `/technician/verification/documents/${encodeURIComponent(id)}`,
  );
  return body.data;
}

/** POST /technician/verification/submit — unverified|rejected → pending. */
export async function submitVerification(): Promise<{
  verificationStatus: TechnicianVerificationStatus;
}> {
  const body = await post<Envelope<{ verificationStatus: TechnicianVerificationStatus }>>(
    '/technician/verification/submit',
    {},
  );
  return body.data;
}

/** GET /verification-documents/:id/file — authorized binary download. */
export function downloadVerificationDocument(id: string): Promise<Blob> {
  return getBlob(`/verification-documents/${encodeURIComponent(id)}/file`);
}

/* ------------------------------------------------------------------ */
/* Administrator review (Task 26)                                      */
/* ------------------------------------------------------------------ */

export interface AdminTechnicianVerification {
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
  documents: TechnicianDocument[];
  createdAt: string;
  updatedAt: string;
}

/** GET /admin/technicians/:id/verification — the review bundle. */
export async function getAdminTechnicianVerification(
  technicianId: string,
): Promise<AdminTechnicianVerification> {
  const body = await get<Envelope<AdminTechnicianVerification>>(
    `/admin/technicians/${encodeURIComponent(technicianId)}/verification`,
  );
  return body.data;
}

/** PATCH /admin/technicians/:id/verification — the administrator decision. */
export async function decideTechnicianVerification(
  technicianId: string,
  decision: { decision: 'verified' } | { decision: 'rejected'; reason: string },
): Promise<AdminTechnicianVerification> {
  const body = await patch<Envelope<AdminTechnicianVerification>>(
    `/admin/technicians/${encodeURIComponent(technicianId)}/verification`,
    decision,
  );
  return body.data;
}
