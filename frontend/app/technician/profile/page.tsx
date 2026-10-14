'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LuCamera,
  LuCircleAlert,
  LuCircleCheck,
  LuClock,
  LuFileText,
  LuSave,
  LuShieldCheck,
  LuTrash2,
  LuUpload,
} from 'react-icons/lu';
import RequireAuth from '@/components/RequireAuth';
import { AdminEmpty, AdminError, AdminLoading } from '@/components/admin/AdminStates';
import TechnicianReviewsSection from '@/components/TechnicianReviewsSection';
import { Badge, BrandAsset, DashboardLayout } from '@/components/ui';
import { technicianCategories, type TechnicianCategory } from '@/lib/categories';
import { compressTechnicianPhoto } from '@/lib/media';
import { notifyError, notifySuccess } from '@/lib/notifications/store';
import { apiBaseUrl } from '@/lib/api/client';
import type {
  OwnTechnicianProfile,
  VerificationDocumentType,
} from '@/lib/api/technicianProfileApi';
import {
  DOCUMENT_TYPE_LABELS,
  fetchDocumentBlob,
  fetchOwnProfile,
  formatBytes,
  profileCompleteness,
  profileErrorMessage,
  saveOwnProfile,
  submitForReview,
  uploadDocument,
  uploadProfilePhoto,
  verificationDisplay,
  withdrawDocument,
} from '@/lib/services/technicianProfileService';
import { formatTimestamp } from '@/lib/services/adminService';
import type { AvailabilityStatus } from '@/lib/types';

interface Flash {
  tone: 'ok' | 'err';
  text: string;
}

/**
 * Technician profile & verification (Task 26 §11) — /technician/profile.
 *
 * The technician maintains the profile fields that drive their public
 * profile and dispatch eligibility (photo, bio, skills, category, service
 * area, availability), uploads verification evidence, and follows the
 * review lifecycle. Every figure on the page comes from the backend; the
 * completeness meter is computed from real fields only.
 */
export default function TechnicianProfilePage() {
  return (
    <RequireAuth role="technician">
      <TechnicianProfileView />
    </RequireAuth>
  );
}

function TechnicianProfileView() {
  const [profile, setProfile] = useState<OwnTechnicianProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setNotFound(false);
    try {
      setProfile(await fetchOwnProfile());
    } catch (error) {
      setProfile(null);
      const status = (error as { status?: number }).status;
      if (status === 404) setNotFound(true);
      else setLoadError(profileErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DashboardLayout active="Profile">
      <main className="t26-page">
        <div className="dashboard-heading">
          <div>
            <div className="eyebrow eyebrow-dark">TECHNICIAN</div>
            <h1>Profile &amp; verification</h1>
            <p>Keep your public profile current and complete your verification review.</p>
          </div>
        </div>

        {notFound ? (
          <AdminEmpty
            title="No technician profile is linked to this account."
            hint="Contact the platform team if you expected one."
          />
        ) : loadError ? (
          <AdminError message={loadError} onRetry={() => void load()} />
        ) : profile === null ? (
          <AdminLoading label="Loading your profile…" />
        ) : (
          <ProfileBody profile={profile} onChanged={setProfile} />
        )}
      </main>
    </DashboardLayout>
  );
}

function ProfileBody({
  profile,
  onChanged,
}: {
  profile: OwnTechnicianProfile;
  onChanged: (next: OwnTechnicianProfile) => void;
}) {
  const completeness = profileCompleteness(profile);
  return (
    <div className="t26-grid">
      <section className="t26-card" aria-label="Profile completeness">
        <div className="t26-completeness-head">
          <h2>Profile completeness</h2>
          <b>{completeness.percent}%</b>
        </div>
        <div
          className="t26-meter"
          role="progressbar"
          aria-valuenow={completeness.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Profile completeness"
        >
          <span style={{ width: `${completeness.percent}%` }} />
        </div>
        <ul className="t26-checks">
          {completeness.checks.map((check) => (
            <li key={check.key} className={check.done ? 'done' : ''}>
              {check.done ? (
                <LuCircleCheck size={11} aria-hidden="true" />
              ) : (
                <LuCircleAlert size={11} aria-hidden="true" />
              )}
              {check.label}
            </li>
          ))}
        </ul>
      </section>

      <PhotoCard profile={profile} onChanged={onChanged} />
      <ProfileFormCard profile={profile} onChanged={onChanged} />
      <VerificationCard profile={profile} onChanged={onChanged} />
      <section className="t26-card" aria-label="Ratings and reputation">
        <TechnicianReviewsSection technicianId={profile.id} heading="Your reputation" />
      </section>
    </div>
  );
}

/* ------------------------------ photo ------------------------------ */

function PhotoCard({
  profile,
  onChanged,
}: {
  profile: OwnTechnicianProfile;
  onChanged: (next: OwnTechnicianProfile) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  const photoUrl = profile.hasPhoto
    ? `${apiBaseUrl()}/technicians/${encodeURIComponent(profile.id)}/photo`
    : null;

  const chooseFile = (file: File | null) => {
    setFlash(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPendingFile(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setFlash({ tone: 'err', text: 'That is not an image. Choose a JPEG, PNG, or WebP file.' });
      return;
    }
    setPendingFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const upload = async () => {
    if (!pendingFile) return;
    setBusy(true);
    setFlash(null);
    try {
      const compressed = await compressTechnicianPhoto(pendingFile);
      if (!compressed) {
        setFlash({ tone: 'err', text: 'Could not read that image. Try a JPEG or PNG file.' });
        return;
      }
      const jpeg = new File([compressed], pendingFile.name.replace(/\.\w+$/, '') + '.jpg', {
        type: 'image/jpeg',
      });
      await uploadProfilePhoto(jpeg);
      const fresh = await fetchOwnProfile();
      onChanged(fresh);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setPendingFile(null);
      if (inputRef.current) inputRef.current.value = '';
      setFlash({ tone: 'ok', text: 'Photo updated.' });
      notifySuccess({ title: 'Profile photo updated' });
    } catch (error) {
      const message = profileErrorMessage(error);
      setFlash({ tone: 'err', text: message });
      notifyError({ title: 'Photo upload failed', message });
    } finally {
      setBusy(false);
    }
  };

  const initials = profile.name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <section className="t26-card" aria-label="Profile photo">
      <h2>Profile photo</h2>
      <div className="t26-photo-row">
        <span className="t26-photo-frame">
          {previewUrl ? (
            <BrandAsset src={previewUrl} alt="Selected photo preview" width={96} height={96} />
          ) : photoUrl ? (
            <BrandAsset
              src={photoUrl}
              alt={`${profile.name} profile photo`}
              width={96}
              height={96}
            />
          ) : (
            <span className="t26-photo-initials" aria-hidden="true">
              {initials}
            </span>
          )}
        </span>
        <div className="t26-photo-actions">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="t26-file-input"
            aria-label="Choose a profile photo"
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          />
          <div className="t26-photo-buttons">
            <button
              type="button"
              className="admin-action"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              <LuCamera size={12} aria-hidden="true" /> Choose photo
            </button>
            {pendingFile && (
              <button
                type="button"
                className="admin-action admin-action-confirm"
                onClick={() => void upload()}
                disabled={busy}
              >
                <LuUpload size={12} aria-hidden="true" /> {busy ? 'Uploading…' : 'Upload photo'}
              </button>
            )}
          </div>
          <small className="admin-note">
            JPEG, PNG, or WebP — compressed automatically to about 800px / 150KB.
          </small>
          {flash && (
            <p
              className={`profile-status ${flash.tone === 'ok' ? 'profile-status-saved' : 'profile-status-error'}`}
              role={flash.tone === 'err' ? 'alert' : 'status'}
            >
              {flash.tone === 'ok' ? (
                <LuCircleCheck size={12} aria-hidden="true" />
              ) : (
                <LuCircleAlert size={12} aria-hidden="true" />
              )}
              {flash.text}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ profile form ------------------------------ */

function ProfileFormCard({
  profile,
  onChanged,
}: {
  profile: OwnTechnicianProfile;
  onChanged: (next: OwnTechnicianProfile) => void;
}) {
  const [bio, setBio] = useState(profile.bio ?? '');
  const [skills, setSkills] = useState(profile.skills.join(', '));
  const [category, setCategory] = useState<TechnicianCategory>(
    profile.category as TechnicianCategory,
  );
  const [serviceArea, setServiceArea] = useState(profile.serviceArea);
  const [availability, setAvailability] = useState(profile.availability);
  const [availabilityStatus, setAvailabilityStatus] = useState<AvailabilityStatus>(
    profile.availabilityStatus as AvailabilityStatus,
  );
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  // Re-sync when the profile is refreshed elsewhere (photo/save).
  useEffect(() => {
    setBio(profile.bio ?? '');
    setSkills(profile.skills.join(', '));
    setCategory(profile.category as TechnicianCategory);
    setServiceArea(profile.serviceArea);
    setAvailability(profile.availability);
    setAvailabilityStatus(profile.availabilityStatus as AvailabilityStatus);
  }, [profile]);

  const save = async () => {
    const parsedSkills = skills
      .split(',')
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 0);
    if (bio.trim().length === 0) {
      setFlash({ tone: 'err', text: 'Write a short professional bio first.' });
      return;
    }
    if (parsedSkills.length === 0) {
      setFlash({ tone: 'err', text: 'Add at least one skill.' });
      return;
    }
    setBusy(true);
    setFlash(null);
    try {
      const fresh = await saveOwnProfile({
        bio: bio.trim(),
        skills: parsedSkills,
        category,
        serviceArea,
        availability: availability.trim(),
        availabilityStatus,
      });
      onChanged(fresh);
      setFlash({ tone: 'ok', text: 'Profile saved.' });
      notifySuccess({ title: 'Profile saved' });
    } catch (error) {
      const message = profileErrorMessage(error);
      setFlash({ tone: 'err', text: message });
      notifyError({ title: 'Could not save the profile', message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="t26-card" aria-label="Profile details">
      <h2>Profile details</h2>
      <div className="profile-editor t26-form">
        <label>
          <span>
            Professional bio <small className="t26-counter">{bio.trim().length}/500</small>
          </span>
          <textarea
            value={bio}
            maxLength={500}
            rows={3}
            placeholder="Example: Experienced electrical technician specializing in residential wiring, fault diagnosis and electrical appliance installation."
            onChange={(event) => setBio(event.target.value)}
          />
        </label>
        <label>
          <span>Skills (comma separated)</span>
          <input
            value={skills}
            placeholder="Example: Home wiring, Fault diagnosis"
            onChange={(event) => setSkills(event.target.value)}
          />
        </label>
        <label>
          <span>Service category</span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as TechnicianCategory)}
          >
            {technicianCategories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Service area</span>
          <select value={serviceArea} onChange={(event) => setServiceArea(event.target.value)}>
            <option value="Kitwe">Kitwe</option>
            <option value="Ndola">Ndola</option>
          </select>
        </label>
        <label>
          <span>Availability note</span>
          <input
            value={availability}
            maxLength={60}
            placeholder="Example: Weekdays 8am–5pm"
            onChange={(event) => setAvailability(event.target.value)}
          />
        </label>
        <label>
          <span>Accepting jobs?</span>
          <select
            value={availabilityStatus}
            onChange={(event) => setAvailabilityStatus(event.target.value as AvailabilityStatus)}
          >
            <option value="available">Available — accepting requests</option>
            <option value="unavailable">Unavailable — not accepting requests</option>
          </select>
        </label>
        {flash && (
          <p
            className={`profile-status ${flash.tone === 'ok' ? 'profile-status-saved' : 'profile-status-error'}`}
            role={flash.tone === 'err' ? 'alert' : 'status'}
          >
            {flash.tone === 'ok' ? (
              <LuCircleCheck size={12} aria-hidden="true" />
            ) : (
              <LuCircleAlert size={12} aria-hidden="true" />
            )}
            {flash.text}
          </p>
        )}
        <div className="profile-editor-actions">
          <button
            type="button"
            className="button button-coral button-small"
            onClick={() => void save()}
            disabled={busy}
          >
            <LuSave size={12} aria-hidden="true" /> {busy ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ verification ------------------------------ */

function VerificationCard({
  profile,
  onChanged,
}: {
  profile: OwnTechnicianProfile;
  onChanged: (next: OwnTechnicianProfile) => void;
}) {
  const display = verificationDisplay(profile.verificationStatus);
  const editable =
    profile.verificationStatus === 'unverified' || profile.verificationStatus === 'rejected';
  // The two policy documents are tracked separately so the technician is told
  // exactly which one is missing, rather than being blocked by a generic
  // "document required" message (production-fix Task 6).
  const hasNationalId = profile.documents.some((doc) => doc.documentType === 'national_id');
  const hasCertificate = profile.documents.some((doc) => doc.documentType === 'certificate');

  return (
    <section className="t26-card t26-verify" aria-label="Verification">
      <div className="t26-verify-head">
        <h2>Verification</h2>
        <Badge tone={display.tone}>
          {profile.verificationStatus === 'verified' ? (
            <LuShieldCheck size={10} aria-hidden="true" />
          ) : profile.verificationStatus === 'pending' ? (
            <LuClock size={10} aria-hidden="true" />
          ) : (
            <LuCircleAlert size={10} aria-hidden="true" />
          )}
          {display.heading}
        </Badge>
      </div>
      <p className="t26-verify-copy">{display.copy}</p>
      {profile.verificationRejectionReason && (
        <p className="admin-inline-error" role="alert">
          Review feedback: {profile.verificationRejectionReason}
        </p>
      )}
      <dl className="admin-detail-grid">
        {profile.verificationSubmittedAt && (
          <div>
            <dt>Submitted</dt>
            <dd>{formatTimestamp(profile.verificationSubmittedAt)}</dd>
          </div>
        )}
        {profile.verificationReviewedAt && (
          <div>
            <dt>Reviewed</dt>
            <dd>{formatTimestamp(profile.verificationReviewedAt)}</dd>
          </div>
        )}
      </dl>

      <DocumentsBlock profile={profile} editable={editable} onChanged={onChanged} />

      {editable && (
        <div className="t26-submit-row">
          <SubmitButton profile={profile} hasNationalId={hasNationalId} onChanged={onChanged} />
          {!hasNationalId && (
            <small className="admin-note">
              A National Registration Card (NRC) is required before submitting.
            </small>
          )}
          {hasNationalId && !hasCertificate && (
            <small className="admin-note">
              Your NRC is attached. Add a certificate or other proof of qualification so the
              reviewer can confirm the trade you registered for — both documents are shown to the
              reviewer.
            </small>
          )}
        </div>
      )}
      {profile.verificationStatus === 'pending' && (
        <p className="admin-note">
          Submitted{' '}
          {profile.verificationSubmittedAt
            ? formatTimestamp(profile.verificationSubmittedAt)
            : 'recently'}{' '}
          — the review team will decide here.
        </p>
      )}
      {profile.verificationStatus === 'verified' && (
        <p className="admin-note">
          Verified
          {profile.verificationReviewedAt
            ? ` on ${formatTimestamp(profile.verificationReviewedAt)}`
            : ''}
          . Availability is still yours to control above.
        </p>
      )}
    </section>
  );
}

function SubmitButton({
  profile,
  hasNationalId,
  onChanged,
}: {
  profile: OwnTechnicianProfile;
  hasNationalId: boolean;
  onChanged: (next: OwnTechnicianProfile) => void;
}) {
  const [busy, setBusy] = useState(false);
  const label =
    profile.verificationStatus === 'rejected'
      ? 'Resubmit for verification'
      : 'Submit for verification';
  return (
    <button
      type="button"
      className="button button-coral button-small"
      disabled={busy || !hasNationalId}
      onClick={() => {
        setBusy(true);
        submitForReview()
          .then(async () => {
            onChanged(await fetchOwnProfile());
            notifySuccess({
              title: 'Verification submitted',
              message: 'The review team has your documents.',
            });
          })
          .catch((error: unknown) => {
            const message = profileErrorMessage(error);
            notifyError({ title: 'Could not submit verification', message });
          })
          .finally(() => setBusy(false));
      }}
    >
      <LuShieldCheck size={12} aria-hidden="true" /> {busy ? 'Submitting…' : label}
    </button>
  );
}

function DocumentsBlock({
  profile,
  editable,
  onChanged,
}: {
  profile: OwnTechnicianProfile;
  editable: boolean;
  onChanged: (next: OwnTechnicianProfile) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<VerificationDocumentType>('national_id');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  const upload = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setFlash(null);
    try {
      await uploadDocument(docType, file);
      onChanged(await fetchOwnProfile());
      setFlash({ tone: 'ok', text: `${DOCUMENT_TYPE_LABELS[docType]} uploaded.` });
      notifySuccess({ title: 'Document uploaded' });
    } catch (error) {
      const message = profileErrorMessage(error);
      setFlash({ tone: 'err', text: message });
      notifyError({ title: 'Document upload failed', message });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const view = async (id: string) => {
    try {
      const blob = await fetchDocumentBlob(id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      notifyError({ title: 'Could not open the document', message: profileErrorMessage(error) });
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await withdrawDocument(id);
      onChanged(await fetchOwnProfile());
      notifySuccess({ title: 'Document removed' });
    } catch (error) {
      notifyError({ title: 'Could not remove the document', message: profileErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="t26-docs">
      <h3>Documents</h3>
      {profile.documents.length === 0 ? (
        <p className="admin-note">
          No documents yet — start with your National Registration Card (NRC), then add your
          certificate or proof of qualification.
        </p>
      ) : (
        <ul className="t26-doc-list">
          {profile.documents.map((doc) => (
            <li key={doc.id}>
              <span className="t26-doc-icon" aria-hidden="true">
                <LuFileText size={14} />
              </span>
              <span className="t26-doc-meta">
                <b>{DOCUMENT_TYPE_LABELS[doc.documentType]}</b>
                <small>
                  {doc.fileName} · {formatBytes(doc.sizeBytes)} · {formatTimestamp(doc.createdAt)}
                </small>
              </span>
              <span className="t26-doc-actions">
                <button type="button" className="admin-action" onClick={() => void view(doc.id)}>
                  View
                </button>
                {editable && (
                  <button
                    type="button"
                    className="admin-action"
                    aria-label={`Remove ${DOCUMENT_TYPE_LABELS[doc.documentType]}`}
                    disabled={busy}
                    onClick={() => void remove(doc.id)}
                  >
                    <LuTrash2 size={11} aria-hidden="true" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="t26-doc-upload">
          <label className="admin-field">
            <span>Document type</span>
            <select
              value={docType}
              onChange={(event) => setDocType(event.target.value as VerificationDocumentType)}
            >
              {(Object.keys(DOCUMENT_TYPE_LABELS) as VerificationDocumentType[]).map((key) => (
                <option key={key} value={key}>
                  {DOCUMENT_TYPE_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="t26-file-input"
            aria-label="Choose a verification document"
            onChange={(event) => void upload(event.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className="admin-action"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <LuUpload size={12} aria-hidden="true" /> {busy ? 'Uploading…' : 'Upload document'}
          </button>
        </div>
      )}
      {flash && (
        <p
          className={`profile-status ${flash.tone === 'ok' ? 'profile-status-saved' : 'profile-status-error'}`}
          role={flash.tone === 'err' ? 'alert' : 'status'}
        >
          {flash.tone === 'ok' ? (
            <LuCircleCheck size={12} aria-hidden="true" />
          ) : (
            <LuCircleAlert size={12} aria-hidden="true" />
          )}
          {flash.text}
        </p>
      )}
    </div>
  );
}
