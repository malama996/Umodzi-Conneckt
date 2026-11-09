'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { LuArrowLeft, LuArrowRight, LuCircleCheck, LuMail } from 'react-icons/lu';
import { Logo } from '@/components/ui';
import { ApiError } from '@/lib/api/client';
import { forgotPassword } from '@/lib/api/authApi';

/**
 * Forgot-password entry point (audit §3). Requests a single-use recovery
 * link for a registered email. The backend response is enumeration-safe and
 * identical whether or not the account exists, so this page always shows the
 * same confirmation and never reveals which emails are registered.
 */

function messageFromError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return 'Too many requests — please wait a minute and try again.';
    }
    if (error.status >= 500) {
      return 'Something went wrong on our side. Please try again.';
    }
    try {
      const parsed = JSON.parse(error.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      // fall through
    }
  }
  return 'Unable to reach the server. Check your connection and try again.';
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError('Enter your registered email address.');
      return;
    }
    setBusy(true);
    try {
      await forgotPassword(email.trim());
      // Always shown — the backend never confirms whether the account exists.
      setSent(true);
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
          <h2>Reset your password</h2>
          <p>Enter your registered email and we&apos;ll send you a recovery link.</p>

          {sent ? (
            <>
              <div className="inline-success" role="status">
                <LuCircleCheck size={12} className="ic" aria-hidden="true" /> If an account exists
                for that email, a password recovery link is on its way. Check your inbox and spam
                folder.
              </div>
              <p className="recovery-note">
                The link is single-use and expires shortly. If it doesn&apos;t arrive within a few
                minutes, you can request another.
              </p>
              <div className="auth-switch">
                <Link href="/login">Return to sign in</Link>
              </div>
            </>
          ) : (
            <>
              <label>
                <span>
                  <LuMail size={11} className="ic" aria-hidden="true" /> Email address
                </span>
                <input
                  required
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <button className="button button-coral auth-submit" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send recovery link'}{' '}
                <LuArrowRight size={14} aria-hidden="true" />
              </button>
              {error && (
                <div className="inline-error" role="alert">
                  {error}
                </div>
              )}
            </>
          )}
        </form>
      </section>
    </main>
  );
}
