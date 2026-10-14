'use client';

/**
 * Log-out confirmation (§3 + §4) — ONE dialog for the drawer, the avatar menu
 * and the public header, so the wording, the destructive styling and the
 * default focus (Cancel, not Log out) can never differ between them.
 *
 * Only one of these is ever mounted at a time (each owner renders it only
 * while its own trigger has asked), so the ids below are unique in the
 * document as long as the dialog is open.
 */
export default function LogoutConfirm({
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** The server-side logout is already running. */
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div className="confirm-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="logout-confirm-title"
        aria-describedby="logout-confirm-desc"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <p id="logout-confirm-title">Log out of Umodzi Connect?</p>
        <p id="logout-confirm-desc" className="confirm-desc">
          You will need your email and password to sign back in.
        </p>
        <div className="confirm-actions">
          <button type="button" className="outline-button" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button button-coral" disabled={busy} onClick={onConfirm}>
            {busy ? 'Signing out…' : 'Log out'}
          </button>
        </div>
      </div>
    </div>
  );
}
