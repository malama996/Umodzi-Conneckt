'use client';

import { LuCheck, LuCopy, LuPhone } from 'react-icons/lu';

import type { ContactCallState } from '@/lib/chat/useContactCall';

/**
 * Contact/call result panel (Task 33.4).
 *
 * Shared by the conversation list and the chat thread so both surfaces
 * behave identically: the AUTHORIZED number returned by the backend is
 * shown as text with a real `tel:` link (mobile dialers) and a copy
 * action (desktop fallback) — a contact action never silently does
 * nothing. Missing/invalid numbers render an honest message and NO link.
 */
interface ContactCallPanelProps {
  state: ContactCallState;
  onCopy: (phone: string) => void;
  /** Show a working row (the list has no other in-flight indicator). */
  showWorking?: boolean;
}

export default function ContactCallPanel({
  state,
  onCopy,
  showWorking = false,
}: ContactCallPanelProps) {
  if (state.status === 'idle') return null;

  if (state.status === 'working') {
    if (!showWorking) return null;
    return (
      <div className="contact-panel contact-panel-note" role="status">
        Looking up the contact number…
      </div>
    );
  }

  if (state.status === 'ready') {
    const who = state.label ?? 'participant';
    return (
      <div className="contact-panel" role="status">
        <span className="contact-panel-label">Contact — {who}</span>
        <span className="contact-number">{state.phone}</span>
        <div className="contact-panel-actions">
          <a
            className="button button-teal button-small"
            href={state.tel}
            aria-label={`Call ${who} at ${state.phone}`}
          >
            <LuPhone size={14} aria-hidden="true" /> Call now
          </a>
          <button
            type="button"
            className="outline-button"
            onClick={() => onCopy(state.phone)}
            aria-label={`Copy ${who}’s phone number`}
          >
            {state.copied ? (
              <>
                <LuCheck size={12} className="ic" aria-hidden="true" /> Copied
              </>
            ) : (
              <>
                <LuCopy size={12} className="ic" aria-hidden="true" /> Copy
              </>
            )}
          </button>
        </div>
        {state.copyError && <p className="contact-panel-note">{state.copyError}</p>}
        {!state.copyError && (
          <p className="contact-panel-note">
            Opens your phone’s dialer on mobile devices — or copy the number.
          </p>
        )}
      </div>
    );
  }

  const who = state.label ?? 'participant';
  return (
    <div
      className={`contact-panel ${state.status === 'error' ? 'contact-panel-error' : 'contact-panel-note'}`}
      role={state.status === 'error' ? 'alert' : 'status'}
    >
      <span className="contact-panel-label">{who}</span>
      <span>{state.message}</span>
    </div>
  );
}
