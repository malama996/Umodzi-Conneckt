'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { LuArrowLeft, LuArrowRight, LuCircleCheck, LuLock } from 'react-icons/lu';
import { Logo } from '@/components/ui';
import { ApiError } from '@/lib/api/client';
import { resetPassword } from '@/lib/api/authApi';

/**
 * Reset-password page (audit §3). Consumes the single-use token from the
 * emailed link (?token=…) plus a new password. The token is read client-side
 * (same approach as AuthForm's query handling) so the page stays statically
 * rendered. Invalid, expired, or already-used tokens yield the same generic
 * failure; on success every existing session has already been revoked by the
 * backend, so the user signs in again.
 */

function messageFromError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return 'Too many attempts — please wait a minute and try again.';
    }
    try {
      const parsed = JSON.parse(error.body) as {
        error?: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
      if (error.status === 400 && parsed.details?.fieldErrors) {
        const first = Object.values(parsed.details.fieldErrors)[0]?.[0];
        if (first) return first;
      }
      if (parsed.error) return parsed.error;
    } catch {
      // fall through
    }
    if (error.status >= 500) {
      return 'Something went wrong on our side. Please try again.';
    }
  }
  return 'Unable to reach the server. Check your connection and try again.';
}

export default function ResetPasswordPage() {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get('token') ?? '');
  }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!token) {
      setError('This password reset link is invalid or has expired.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page theme-b-auth recovery-page">
      <section className="auth-panel">
        <div className="auth-mobile-logo">
          <Logo />
        </div>
        <Link href="/login" className="back-link">
          <LuArrowLeft size={11} className="ic" aria-hidden="true" /> Back to sign in
        </Link>
        <form className="auth-card" onSubmit={(e) => void onSubmit(e)} noValidate>
          <h2>Choose a new password</h2>
          <p>Set a new password for your Umodzi Connect account.</p>

          {done ? (
            <>
              <div className="inline-success" role="status">
                <LuCircleCheck size={12} className="ic" aria-hidden="true" /> Your password has been
                reset. Any other devices signed in to your account have been signed out.
              </div>
              <div className="auth-switch">
                <Link href="/login">Continue to sign in</Link>
              </div>
            </>
          ) : (
            <>
              <label>
                <span>
                  <LuLock size={11} className="ic" aria-hidden="true" /> New password
                </span>
                <div className="password-field">
                  <input
                    required
                    minLength={8}
                    type={show ? 'text' : 'password'}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button type="button" onClick={() => setShow(!show)}>
                    {show ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>
              <label>
                <span>
                  <LuLock size={11} className="ic" aria-hidden="true" /> Confirm new password
                </span>
                <input
                  required
                  minLength={8}
                  type={show ? 'text' : 'password'}
                  placeholder="Re-enter your new password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
              <button className="button button-coral auth-submit" type="submit" disabled={busy}>
                {busy ? 'Resetting…' : 'Reset password'} <LuArrowRight size={14} aria-hidden="true" />
              </button>
              {error && (
                <div className="inline-error" role="alert">
                  {error}
                </div>
              )}
              {!token && !error && (
                <div className="inline-error" role="alert">
                  This password reset link is invalid or has expired. Please request a new one.
                </div>
              )}
            </>
          )}
        </form>
      </section>
    </main>
  );
}
