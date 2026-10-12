'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import {
  LuArrowLeft,
  LuCircleAlert,
  LuCircleCheck,
  LuClock,
  LuFileText,
  LuShieldCheck,
} from 'react-icons/lu';
import RequireAuth from '@/components/RequireAuth';
import { AdminEmpty, AdminError, AdminLoading } from '@/components/admin/AdminStates';
import TechnicianReviewsSection from '@/components/TechnicianReviewsSection';
import {
  AvailabilityBadge,
  ProfileAccountBadge,
  VerificationBadge,
} from '@/components/admin/StatusBadge';
import { Badge, BrandAsset, DashboardLayout } from '@/components/ui';
import { notifyError, notifySuccess } from '@/lib/notifications/store';
import { apiBaseUrl } from '@/lib/api/client';
import type { AdminTechnicianVerification } from '@/lib/api/technicianProfileApi';
import {
  DOCUMENT_TYPE_LABELS,
  decideVerification,
  fetchAdminVerification,
  fetchDocumentBlob,
  formatBytes,
  profileErrorMessage,
  verificationLabel,
  verificationTone,
} from '@/lib/services/technicianProfileService';
import { adminErrorMessage, formatTimestamp } from '@/lib/services/adminService';

/**
 * Administrator verification review (Task 26 §13) — /admin/technicians/<id>.
 *
 * One technician's full verification bundle: profile, lifecycle state,
 * linked account, and every submitted document (bytes fetched through the
 * authorized endpoint only). The decision actions — Verify / Reject with a
 * required reason — are server-authorized; the UI never hides the fact
 * that only a PENDING verification can be reviewed.
 */
export default function AdminVerificationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <RequireAuth role="administrator">
      <DashboardLayout active="Technicians">
        <AdminVerificationView technicianId={id} />
      </DashboardLayout>
    </RequireAuth>
  );
}

function AdminVerificationView({ technicianId }: { technicianId: string }) {
  const [bundle, setBundle] = useState<AdminTechnicianVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setMissing(false);
    try {
      setBundle(await fetchAdminVerification(technicianId));
    } catch (err) {
      setBundle(null);
      const status = (err as { status?: number }).status;
      if (status === 404) setMissing(true);
      else setError(adminErrorMessage(err));
    }
  }, [technicianId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="dashboard-page admin-page">
      <Link href="/admin/technicians" className="back-link">
        <LuArrowLeft size={11} className="ic" aria-hidden="true" /> Back to technicians
      </Link>
      {missing ? (
        <AdminEmpty title="This technician does not exist." hint="It may have been removed." />
      ) : error ? (
        <AdminError message={error} onRetry={() => void load()} />
      ) : bundle === null ? (
        <AdminLoading label="Loading verification bundle…" />
      ) : (
        <VerificationBundle bundle={bundle} onChanged={setBundle} />
      )}
    </main>
  );
}

function VerificationBundle({
  bundle,
  onChanged,
}: {
  bundle: AdminTechnicianVerification;
  onChanged: (next: AdminTechnicianVerification) => void;
}) {
  const photoUrl = bundle.hasPhoto
    ? `${apiBaseUrl()}/technicians/${encodeURIComponent(bundle.id)}/photo`
    : null;
  const initials = bundle.name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <>
      <div className="dashboard-heading">
        <div>
          <div className="eyebrow eyebrow-dark">ADMINISTRATOR · VERIFICATION REVIEW</div>
          <h1>{bundle.name}</h1>
          <p>
            {bundle.category} · {bundle.serviceArea}
            {bundle.userEmail ? ` · ${bundle.userEmail}` : ' · prototype profile (no account)'}
          </p>
        </div>
        <Badge tone={verificationTone(bundle.verificationStatus)}>
          {bundle.verificationStatus === 'verified' ? (
            <LuShieldCheck size={10} aria-hidden="true" />
          ) : bundle.verificationStatus === 'pending' ? (
            <LuClock size={10} aria-hidden="true" />
          ) : (
            <LuCircleAlert size={10} aria-hidden="true" />
          )}
          {verificationLabel(bundle.verificationStatus)}
        </Badge>
      </div>

      <div className="t26-admin-grid">
        <section className="t26-card" aria-label="Technician profile">
          <h2>Profile</h2>
          <div className="t26-photo-row">
            <span className="t26-photo-frame">
              {photoUrl ? (
                <BrandAsset
                  src={photoUrl}
                  alt={`${bundle.name} profile photo`}
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
              <span className="admin-cell-strong">{bundle.name}</span>
              <span className="admin-cell-sub">{bundle.userEmail ?? 'No linked account'}</span>
              <VerificationBadge verified={bundle.verified} />
            </div>
          </div>
          {bundle.bio && <p className="profile-about">{bundle.bio}</p>}
          <dl className="admin-detail-grid">
            <div>
              <dt>Skills</dt>
              <dd>{bundle.skills.length > 0 ? bundle.skills.join(', ') : '—'}</dd>
            </div>
            <div>
              <dt>Availability</dt>
              <dd>
                <AvailabilityBadge status={bundle.availabilityStatus} /> {bundle.availability}
              </dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>
                <ProfileAccountBadge status={bundle.accountStatus} />
              </dd>
            </div>
            <div>
              <dt>Rating</dt>
              <dd>
                {bundle.rating} · {bundle.jobs} jobs
              </dd>
            </div>
            <div>
              <dt>Registered</dt>
              <dd>{formatTimestamp(bundle.createdAt)}</dd>
            </div>
          </dl>
        </section>

        <section className="t26-card" aria-label="Verification state">
          <h2>Verification state</h2>
          <dl className="admin-detail-grid">
            <div>
              <dt>Status</dt>
              <dd>
                <Badge tone={verificationTone(bundle.verificationStatus)}>
                  {verificationLabel(bundle.verificationStatus)}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd>
                {bundle.verificationSubmittedAt
                  ? formatTimestamp(bundle.verificationSubmittedAt)
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Reviewed</dt>
              <dd>
                {bundle.verificationReviewedAt
                  ? formatTimestamp(bundle.verificationReviewedAt)
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Reviewer</dt>
              <dd>{bundle.verificationReviewerEmail ?? '—'}</dd>
            </div>
          </dl>
          {bundle.verificationRejectionReason && (
            <p className="admin-inline-error" role="alert">
              Rejection reason: {bundle.verificationRejectionReason}
            </p>
          )}
          <DocumentsList bundle={bundle} />
          <DecisionPanel bundle={bundle} onChanged={onChanged} />
        </section>

        <section className="t26-card" aria-label="Customer reviews">
          <TechnicianReviewsSection technicianId={bundle.id} heading="Customer reviews" />
        </section>
      </div>
    </>
  );
}

function DocumentsList({ bundle }: { bundle: AdminTechnicianVerification }) {
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

  return (
    <div className="t26-docs">
      <h3>Submitted documents ({bundle.documents.length})</h3>
      {bundle.documents.length === 0 ? (
        <p className="admin-note">No documents submitted.</p>
      ) : (
        <ul className="t26-doc-list">
          {bundle.documents.map((doc) => (
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
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DecisionPanel({
  bundle,
  onChanged,
}: {
  bundle: AdminTechnicianVerification;
  onChanged: (next: AdminTechnicianVerification) => void;
}) {
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState<'verified' | 'rejected' | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  if (bundle.verificationStatus !== 'pending') {
    return (
      <p className="admin-note t26-decision-note">
        <LuCircleCheck size={11} aria-hidden="true" /> Only a pending verification can be reviewed —
        this one is {verificationLabel(bundle.verificationStatus).toLowerCase()}.
      </p>
    );
  }

  const decide = async (decision: 'verified' | 'rejected') => {
    setBusy(true);
    setFlash(null);
    try {
      const fresh = await decideVerification(
        bundle.id,
        decision === 'verified'
          ? { decision: 'verified' }
          : { decision: 'rejected', reason: reason.trim() },
      );
      onChanged(fresh);
      setConfirming(null);
      setFlash({
        tone: 'ok',
        text:
          decision === 'verified' ? 'Technician verified.' : 'Verification rejected with feedback.',
      });
      notifySuccess({
        title: decision === 'verified' ? 'Technician verified' : 'Verification rejected',
        message: `${bundle.name} is now ${decision}.`,
      });
    } catch (error) {
      const message = profileErrorMessage(error);
      setFlash({ tone: 'err', text: message });
      notifyError({ title: 'Could not record the decision', message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="t26-decision">
      <h3>Review decision</h3>
      <label className="t26-reason">
        <span>Rejection reason (required to reject — the technician sees this)</span>
        <textarea
          value={reason}
          rows={2}
          maxLength={500}
          placeholder="Example: National ID photo is unreadable — please upload a clearer scan."
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {flash && (
        <p
          className={`profile-status ${flash.tone === 'ok' ? 'profile-status-saved' : 'profile-status-error'}`}
          role={flash.tone === 'err' ? 'alert' : 'status'}
        >
          {flash.text}
        </p>
      )}
      {confirming === null ? (
        <div className="admin-actions">
          <button
            type="button"
            className="admin-action"
            disabled={busy}
            onClick={() => {
              setFlash(null);
              setConfirming('verified');
            }}
          >
            <LuShieldCheck size={12} aria-hidden="true" /> Verify
          </button>
          <button
            type="button"
            className="admin-action admin-action-confirm"
            disabled={busy || reason.trim().length < 8}
            onClick={() => {
              setFlash(null);
              setConfirming('rejected');
            }}
          >
            <LuCircleAlert size={12} aria-hidden="true" /> Reject with feedback
          </button>
        </div>
      ) : (
        <div className="admin-confirm" role="status">
          <p>
            {confirming === 'verified' ? (
              <>
                <b>Verify {bundle.name}?</b> They become dispatch-eligible when their availability
                allows it (verification never changes availability).
              </>
            ) : (
              <>
                <b>Reject {bundle.name}&apos;s verification?</b> They will see: “{reason.trim()}”
              </>
            )}
          </p>
          <div className="admin-confirm-actions">
            <button
              type="button"
              className="admin-action admin-action-confirm"
              disabled={busy}
              onClick={() => void decide(confirming)}
            >
              {busy ? 'Saving…' : 'Confirm'}
            </button>
            <button
              type="button"
              className="admin-action"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
