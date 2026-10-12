'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LuDownload, LuShieldAlert, LuTrash2 } from 'react-icons/lu';

import {
  DELETION_CONFIRMATION_PHRASE,
  deleteMyAccount,
  getDeletionPreview,
  getMyData,
  privacyErrorMessage,
  type AccountDeletionCounts,
  type AccountExport,
} from '@/lib/api/privacyApi';
import { get, put } from '@/lib/api/client';
import { useAuth } from '@/lib/auth';
import { logout } from '@/lib/auth/authStore';

/**
 * Privacy settings (Task 28.3C access/export, 28.3D permanent deletion).
 *
 * Two genuinely destructive-capable controls live here, and they are kept
 * visually and behaviourally distinct:
 *
 *   1. Export  — read-only, produces a real JSON snapshot of the caller's own
 *                data and downloads it in the browser. Nothing is stored.
 *   2. Delete  — irreversible. Guarded three ways: the caller must open the
 *                panel explicitly, type the exact confirmation phrase, AND
 *                re-enter their password. The server enforces the last two;
 *                this UI enforces the first and states the real counts that
 *                deletion would remove.
 *
 * Deletion navigates to the signed-out landing page afterwards, because the
 * account (and its session) genuinely no longer exists — leaving the user on
 * an authenticated page would be a lie about the app's state.
 */

/** Turn a JSON export into a download in the browser. No server round-trip. */
function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

const COUNT_LABELS: [keyof AccountDeletionCounts, string][] = [
  ['service_requests', 'Service requests'],
  ['reviews_written', 'Reviews you wrote'],
  ['notifications', 'Notifications'],
  ['push_subscriptions', 'Push subscriptions'],
  ['sessions', 'Active sessions'],
  ['technician_profiles', 'Technician profile'],
  ['verification_documents', 'Verification documents'],
];

export default function PrivacySettings() {
  const [exportState, setExportState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSummary, setExportSummary] = useState<AccountExport | null>(null);

  const [counts, setCounts] = useState<AccountDeletionCounts | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ---------------- Phone (28.4B) ----------------
  const [phone, setPhone] = useState('');
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSaved, setPhoneSaved] = useState<string | null>(null);

  const router = useRouter();
  useAuth();

  const loadCounts = useCallback(async () => {
    try {
      const preview = await getDeletionPreview();
      setCounts(preview.counts);
      setCountsError(null);
    } catch (err) {
      setCountsError(privacyErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  // Load the user's existing number so the field shows their real value
  // rather than an empty placeholder.
  useEffect(() => {
    void (async () => {
      try {
        const body = await get<{ data: { phone: string | null } }>('/me/phone');
        if (body.data?.phone) setPhone(body.data.phone);
      } catch {
        // Non-fatal: the field simply starts empty.
      }
    })();
  }, []);

  const savePhone = async () => {
    setPhoneSaving(true);
    setPhoneError(null);
    setPhoneSaved(null);
    try {
      const body = await put<{ data: { phone: string } }>('/me/phone', { phone: phone.trim() });
      setPhone(body.data.phone);
      setPhoneSaved('Contact number saved.');
    } catch (err) {
      setPhoneError(privacyErrorMessage(err));
    } finally {
      setPhoneSaving(false);
    }
  };

  const runExport = async () => {
    setExportState('busy');
    setExportError(null);
    try {
      const payload = await getMyData();
      setExportSummary(payload);
      const stamp = payload.generatedAt.slice(0, 10);
      downloadJson(`umodzi-my-data-${stamp}.json`, payload);
      setExportState('done');
    } catch (err) {
      setExportState('idle');
      setExportError(privacyErrorMessage(err));
    }
  };

  const phraseMatches = phrase === DELETION_CONFIRMATION_PHRASE;
  const canDelete = phraseMatches && password.length > 0 && !deleting;

  const runDeletion = async () => {
    if (!canDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteMyAccount(password, phrase);
      // The account and its sessions no longer exist: clear the local session
      // state and leave the authenticated area.
      await logout().catch(() => undefined);
      router.push('/?account-deleted=1');
      router.refresh();
    } catch (err) {
      setDeleteError(privacyErrorMessage(err));
      setDeleting(false);
    }
  };

  return (
    <div className="privacy-settings">
      <div className="panel">
        <div className="panel-head">
          <div>
            <div className="eyebrow eyebrow-dark">YOUR DATA</div>
            <h2>Privacy settings</h2>
            <p className="panel-sub">
              View a copy of your data, or delete your account permanently.
            </p>
          </div>
          <Link href="/privacy" className="outline-button">
            Read the privacy notice
          </Link>
        </div>
      </div>

      {/* ---------------- Access / export ---------------- */}
      <section className="panel" aria-labelledby="export-heading">
        <div className="panel-head">
          <div>
            <h3 id="export-heading">Download my data</h3>
            <p className="panel-sub">
              A JSON snapshot of the information held about your account, generated now from the
              live records. Nothing is stored: the file is created in your browser.
            </p>
          </div>
          <button
            type="button"
            className="button button-teal"
            onClick={() => void runExport()}
            disabled={exportState === 'busy'}
          >
            <LuDownload size={13} className="ic" aria-hidden="true" />
            {exportState === 'busy' ? 'Preparing…' : 'Download my data'}
          </button>
        </div>

        {exportError && (
          <div className="inline-error" role="alert">
            {exportError}
          </div>
        )}

        {exportSummary && (
          <div className="export-summary" role="status">
            <h4>Your export is ready</h4>
            <p className="export-summary-line">
              Generated {new Date(exportSummary.generatedAt).toLocaleString()} ·{' '}
              {Object.values(exportSummary.counts).reduce((a, b) => a + b, 0)} records included
            </p>
            <ul className="export-counts">
              {Object.entries(exportSummary.counts).map(([key, value]) => (
                <li key={key}>
                  <span>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                  <b>{value}</b>
                </li>
              ))}
            </ul>
            <details className="export-exclusions">
              <summary>What is deliberately not included</summary>
              <ul>
                {exportSummary.exclusions.map((item) => (
                  <li key={item.slice(0, 40)}>{item}</li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </section>

      {/* ---------------- Permanent deletion ---------------- */}
      <section className="panel panel-danger" aria-labelledby="delete-heading">
        <div className="panel-head">
          <div>
            <h3 id="delete-heading">Delete my account</h3>
            <p className="panel-sub">
              This permanently removes your account and the data listed below. It cannot be undone.
            </p>
          </div>
          <button
            type="button"
            className="button button-danger"
            onClick={() => setPanelOpen((v) => !v)}
            aria-expanded={panelOpen}
            aria-controls="deletion-confirm-panel"
          >
            <LuTrash2 size={13} className="ic" aria-hidden="true" />
            {panelOpen ? 'Cancel' : 'Delete account'}
          </button>
        </div>

        {countsError && (
          <div className="inline-error" role="alert">
            {countsError}
          </div>
        )}

        {counts && (
          <ul className="deletion-counts">
            {COUNT_LABELS.map(([key, label]) => (
              <li key={key}>
                <span>{label}</span>
                <b>{counts[key] ?? 0}</b>
              </li>
            ))}
          </ul>
        )}

        <p className="deletion-note">
          <LuShieldAlert size={13} className="ic" aria-hidden="true" />
          Security events about your account are kept in a minimised form (no name, email or
          document content) so there is still a record of what happened. Reviews other customers
          wrote about a deleted technician profile are removed with it, because a review cannot
          exist without a subject.
        </p>

        {panelOpen && (
          <div className="deletion-confirm" id="deletion-confirm-panel">
            <p className="deletion-confirm-lead">
              To confirm, type <code>{DELETION_CONFIRMATION_PHRASE}</code> and enter your password.
            </p>
            <label>
              <span>Type the confirmation phrase</span>
              <input
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="phrase-status"
              />
            </label>
            <span id="phrase-status" className="deletion-phrase-status">
              {phrase.length === 0
                ? 'Not entered yet.'
                : phraseMatches
                  ? 'Phrase matches.'
                  : 'Phrase does not match yet.'}
            </span>
            <label>
              <span>Your password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>

            {deleteError && (
              <div className="inline-error" role="alert">
                {deleteError}
              </div>
            )}

            <div className="deletion-actions">
              <button
                type="button"
                className="button button-danger"
                onClick={() => void runDeletion()}
                disabled={!canDelete}
              >
                {deleting ? 'Deleting…' : 'Permanently delete my account'}
              </button>
              <button type="button" className="outline-button" onClick={() => setPanelOpen(false)}>
                Keep my account
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ---------------- Phone (28.4B) ---------------- */}
      <section className="panel" aria-labelledby="phone-heading">
        <div className="panel-head">
          <div>
            <h3 id="phone-heading">Contact number</h3>
            <p className="panel-sub">
              Used so the other person in an accepted job can reach you by phone. Stored once, on
              your own account, and only ever shared with a participant of that service request.
            </p>
          </div>
        </div>

        {phoneError && (
          <div className="inline-error" role="alert">
            {phoneError}
          </div>
        )}
        {phoneSaved && (
          <div className="inline-success" role="status">
            {phoneSaved}
          </div>
        )}

        <form
          className="phone-form"
          onSubmit={(event) => {
            event.preventDefault();
            void savePhone();
          }}
        >
          <label htmlFor="phone-input">
            <span>Phone number</span>
            <input
              id="phone-input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="0971 234 567"
              maxLength={20}
            />
          </label>
          <button
            type="submit"
            className="button button-teal"
            disabled={phoneSaving || phone.trim().length < 6}
          >
            {phoneSaving ? 'Saving…' : 'Save number'}
          </button>
        </form>
      </section>
    </div>
  );
}
