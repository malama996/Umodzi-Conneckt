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
import type {
  AdminTechnicianVerification,
  TechnicianDocument,
} from '@/lib/api/technicianProfileApi';
import {
  DOCUMENT_TYPE_LABELS,
  decideDocument,
  decideVerification,
  documentStatusDisplay,
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
          <h1>{bundle.name}</h1>
          <p>
            {bundle.category} · {bundle.serviceArea}
            {bundle.userEmail ? ` · ${bundle.userEmail}` : ' · prototype profile (no account)'}
          </p>
        </div>
        <Badge tone={verificationTone(bundle.verificationStatus)}>
          {bundle.verificationStatus === 'verified' ? (
            <LuShieldCheck size={10} aria-hidden="true" />
          ) : bundle.verificationStatus === 'pending' ||
            bundle.verificationStatus === 'partially_verified' ? (
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
          <DocumentsList bundle={bundle} onChanged={onChanged} />
          <ReviewHistory bundle={bundle} />
          <DecisionPanel bundle={bundle} onChanged={onChanged} />
        </section>

        <section className="t26-card" aria-label="Customer reviews">
          <TechnicianReviewsSection technicianId={bundle.id} heading="Customer reviews" />
        </section>
      </div>
    </>
  );
}

function DocumentsList({
  bundle,
  onChanged,
}: {
  bundle: AdminTechnicianVerification;
  onChanged: (next: AdminTechnicianVerification) => void;
}) {
  return (
    <div className="t26-docs">
      <h3>Submitted documents ({bundle.documents.length})</h3>
      {bundle.documents.length === 0 ? (
        <p className="admin-note">No documents submitted.</p>
      ) : (
        <>
          <ul className="t26-doc-list">
            {bundle.documents.map((doc) => (
              <DocumentRow
                key={doc.id}
                technicianId={bundle.id}
                doc={doc}
                onChanged={onChanged}
              />
            ))}
          </ul>
          <p className="admin-note t26-decision-note">
            Review each document on its own. The overall status is derived from these decisions —
            approve the National Registration Card (NRC) plus every qualification document to fully
            verify.
          </p>
        </>
      )}
    </div>
  );
}

function DocumentRow({
  technicianId,
  doc,
  onChanged,
}: {
  technicianId: string;
  doc: TechnicianDocument;
  onChanged: (next: AdminTechnicianVerification) => void;
}) {
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = documentStatusDisplay(doc.status);

  const view = async () => {
    try {
      const blob = await fetchDocumentBlob(doc.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      notifyError({ title: 'Could not open the document', message: profileErrorMessage(error) });
    }
  };

  const decide = async (decision: 'approved' | 'rejected') => {
    if (decision === 'rejected' && reason.trim().length < 8) return;
    setBusy(true);
    try {
      const fresh = await decideDocument(
        technicianId,
        doc.id,
        decision === 'approved'
          ? { decision: 'approved' }
          : { decision: 'rejected', reason: reason.trim() },
      );
      onChanged(fresh);
      setRejecting(false);
      setReason('');
      notifySuccess({
        title: decision === 'approved' ? 'Document approved' : 'Document rejected',
        message: `${DOCUMENT_TYPE_LABELS[doc.documentType]} — ${decision}.`,
      });
    } catch (error) {
      notifyError({ title: 'Could not record the decision', message: profileErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="t26-doc-row">
      <div className="t26-doc-main">
        <span className="t26-doc-icon" aria-hidden="true">
          <LuFileText size={14} />
        </span>
        <span className="t26-doc-meta">
          <span className="t26-doc-title">
            <b>{DOCUMENT_TYPE_LABELS[doc.documentType]}</b>
            <Badge tone={status.tone}>{status.label}</Badge>
          </span>
          <small>
            {doc.fileName} · {formatBytes(doc.sizeBytes)} · {formatTimestamp(doc.createdAt)}
          </small>
          {doc.status === 'rejected' && doc.reviewReason && (
            <small className="t26-doc-reason">Feedback given: {doc.reviewReason}</small>
          )}
          {doc.reviewedAt && (
            <small className="t26-doc-reviewed">Reviewed {formatTimestamp(doc.reviewedAt)}</small>
          )}
        </span>
        <span className="t26-doc-actions">
          <button type="button" className="admin-action" onClick={() => void view()}>
            View
          </button>
        </span>
      </div>
      <div className="t26-doc-decide">
        {rejecting ? (
          <div className="t26-doc-reject">
            <label className="t26-reason">
              <span>Rejection reason (required — the technician sees this)</span>
              <textarea
                value={reason}
                rows={2}
                maxLength={500}
                placeholder="Example: The photo is unreadable — please upload a clearer scan."
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="admin-confirm-actions">
              <button
                type="button"
                className="admin-action admin-action-confirm"
                disabled={busy || reason.trim().length < 8}
                onClick={() => void decide('rejected')}
              >
                {busy ? 'Saving…' : 'Confirm rejection'}
              </button>
              <button
                type="button"
                className="admin-action"
                disabled={busy}
                onClick={() => {
                  setRejecting(false);
                  setReason('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="admin-actions">
            <button
              type="button"
              className="admin-action"
              disabled={busy}
              onClick={() => void decide('approved')}
            >
              <LuShieldCheck size={12} aria-hidden="true" /> {busy ? 'Saving…' : 'Approve'}
            </button>
            <button
              type="button"
              className="admin-action admin-action-confirm"
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              <LuCircleAlert size={12} aria-hidden="true" /> Reject
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function ReviewHistory({ bundle }: { bundle: AdminTechnicianVerification }) {
  if (bundle.reviews.length === 0) return null;
  const docLabel = (documentId: string) => {
    const doc = bundle.documents.find((candidate) => candidate.id === documentId);
    return doc ? DOCUMENT_TYPE_LABELS[doc.documentType] : 'a document';
  };
  return (
    <div className="t26-history">
      <h3>Review history ({bundle.reviews.length})</h3>
      <ul className="t26-history-list">
        {bundle.reviews.map((review) => (
          <li key={review.id}>
            <Badge tone={review.decision === 'approved' ? 'success' : 'coral'}>
              {review.decision === 'approved' ? 'Approved' : 'Rejected'}
            </Badge>
            <span className="t26-history-meta">
              <b>{docLabel(review.documentId)}</b>
              <small>
                {review.reviewerEmail ?? 'Reviewer'} · {formatTimestamp(review.createdAt)}
              </small>
              {review.reason && <small className="t26-doc-reason">{review.reason}</small>}
            </span>
          </li>
        ))}
      </ul>
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
        <LuCircleCheck size={11} aria-hidden="true" /> The overall shortcut below applies only while
        a verification is pending — this one is{' '}
        {verificationLabel(bundle.verificationStatus).toLowerCase()}. Use the per-document controls
        above to review individual documents at any time.
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
      <h3>Overall decision (shortcut)</h3>
      <p className="admin-note">
        Approving here verifies the technician in one step; rejecting sends the same feedback for
        every document. Prefer the per-document controls above for a precise review.
      </p>
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
