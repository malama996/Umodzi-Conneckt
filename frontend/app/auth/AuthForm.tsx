'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  LuArrowLeft,
  LuArrowRight,
  LuCircleCheck,
  LuLock,
  LuMail,
  LuMapPin,
  LuUser,
  LuUsers,
} from 'react-icons/lu';
import { Logo } from '@/components/ui';
import { ApiError } from '@/lib/api/client';
import { login as loginAction, register as registerAction, useAuth } from '@/lib/auth';
import { homeForRole } from '@/lib/auth/homeForRole';
import { technicianCategories } from '@/lib/categories';
import { REGISTRATION_NOTICE_POINTS } from '@/lib/privacy/notice';

/**
 * Login / register form (Task 23) — wired to the real auth API.
 *
 * Design rules:
 *   - the existing visual design and login-background-technician.jpg are
 *     untouched (styling lives in globals.css / .auth-* classes);
 *   - the local field labels keep their original wording; "Consumer" maps
 *     to the `customer` role and "Technician" to `technician` — the
 *     `administrator` role is NOT offered (public registration can never
 *     mint an admin; the backend rejects it with 403 anyway);
 *   - technician registration additionally captures the service category
 *     and area, which seed the account's single technician profile row;
 *   - passwords are only ever held in component state, sent to the API,
 *     and NEVER logged;
 *   - errors are safe server messages surfaced via role="alert"; the
 *     backend answers unknown-email and wrong-password identically;
 *   - a successful login redirects via `?next=` (validated same-site
 *     path) or the role's home page; an already signed-in visitor is
 *     moved out of the auth pages.
 */

const SERVICE_AREAS = ['Kitwe', 'Ndola'] as const;

/** Safe, user-facing message from an API/network failure. Never echoes secrets. */
function messageFromError(error: unknown): string {
  if (error instanceof ApiError) {
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
      // Non-JSON body — fall through to status-based messaging.
    }
    if (error.status === 401) return 'Invalid email or password';
    if (error.status === 409) return 'An account with this email already exists.';
    if (error.status === 429) return 'Too many attempts — please wait a minute and try again.';
    if (error.status >= 500) return 'Something went wrong on our side. Please try again.';
  }
  return 'Unable to reach the server. Check your connection and try again.';
}

export default function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const [show, setShow] = useState(false);
  const [accountType, setAccountType] = useState('Consumer');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Task 32: two separate, explicit acknowledgements (terms + privacy).
  // Client-side only, like the previous single checkbox: nothing is sent
  // to the backend and nothing is stored as a consent record (see the
  // footnote below) — registration must not invent legal proof.
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [readPrivacy, setReadPrivacy] = useState(false);
  const [category, setCategory] = useState('');
  const [serviceArea, setServiceArea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);
  const router = useRouter();
  const { status, user } = useAuth();

  // Query params (registered / next) read client-side — avoids pulling
  // useSearchParams into a statically rendered page.
  const [nextPath, setNextPath] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setRegistered(params.get('registered') === '1');
    const next = params.get('next');
    // Only same-site absolute paths — never an off-site redirect.
    setNextPath(next && next.startsWith('/') && !next.startsWith('//') ? next : null);
  }, []);

  // Already signed in (restored session or fresh login) → leave the form.
  useEffect(() => {
    if (status === 'authenticated' && user) {
      router.replace(nextPath ?? homeForRole(user.role));
    }
  }, [status, user, nextPath, router]);

  const validate = (): string | null => {
    if (mode === 'login') {
      if (!email.trim() || !password) return 'Enter your email and password.';
      return null;
    }
    if (!fullName.trim() || !email.trim() || !password) {
      return 'Fill in all required fields.';
    }
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (!agreeTerms) return 'Please agree to the Terms and Conditions to continue.';
    if (!readPrivacy) return 'Please confirm you have read the Privacy Policy.';
    if (accountType === 'Technician' && (!category || !serviceArea)) {
      return 'Choose your service category and area.';
    }
    return null;
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    try {
      if (mode === 'login') {
        // Redirect happens in the status effect above once the store flips
        // to 'authenticated' (uses ?next= or the role home).
        await loginAction(email.trim(), password);
      } else {
        const nameParts = fullName.trim().split(/\s+/);
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ');
        await registerAction({
          email: email.trim(),
          password,
          firstName,
          lastName,
          role: accountType === 'Technician' ? 'technician' : 'customer',
          ...(accountType === 'Technician' ? { category, serviceArea } : {}),
        });
        // No session is created by registration — sign in explicitly.
        router.push('/login?registered=1');
      }
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={`auth-page theme-b-auth ${mode === 'login' ? 'auth-login' : 'auth-register'}`}>
      <section className="auth-visual">
        <div className="auth-visual-overlay">
          <Logo light />
          <div className="auth-visual-copy">
            <div className="eyebrow">UMODZI CONNECT</div>
            <h1>{mode === 'login' ? 'Welcome back.' : 'Join the connection.'}</h1>
            <p>Skilled people. Stronger communities.</p>
            <div className="auth-location">
              <LuMapPin size={11} className="ic" aria-hidden="true" /> Kitwe · Ndola · Zambia
            </div>
          </div>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-mobile-logo">
          <Logo />
        </div>
        <Link href="/" className="back-link">
          <LuArrowLeft size={11} className="ic" aria-hidden="true" /> Back to Umodzi Connect
        </Link>
        <form className="auth-card" onSubmit={(e) => void onSubmit(e)} noValidate>
          <div className="eyebrow eyebrow-dark">UMODZI CONNECT</div>
          <h2>{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
          <p>
            {mode === 'login'
              ? 'Continue to your community services.'
              : 'Get started as a consumer or technician.'}
          </p>
          {mode === 'register' && (
            <>
              <label>
                <span>
                  <LuUser size={11} className="ic" aria-hidden="true" /> Full name
                </span>
                <input
                  required
                  placeholder="Your full name"
                  autoComplete="name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </label>
              <label>
                <span>
                  <LuUsers size={11} className="ic" aria-hidden="true" /> Account type
                </span>
                <select value={accountType} onChange={(e) => setAccountType(e.target.value)}>
                  <option>Consumer</option>
                  <option>Technician</option>
                </select>
              </label>
              {accountType === 'Technician' && (
                <>
                  <label>
                    <span>
                      <LuUsers size={11} className="ic" aria-hidden="true" /> Service category
                    </span>
                    <select value={category} onChange={(e) => setCategory(e.target.value)}>
                      <option value="">Choose a category</option>
                      {technicianCategories.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>
                      <LuMapPin size={11} className="ic" aria-hidden="true" /> Service area
                    </span>
                    <select value={serviceArea} onChange={(e) => setServiceArea(e.target.value)}>
                      <option value="">Choose an area</option>
                      {SERVICE_AREAS.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </>
          )}
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
          <label>
            <span>
              <LuLock size={11} className="ic" aria-hidden="true" /> Password
            </span>
            <div className="password-field">
              <input
                required
                minLength={8}
                type={show ? 'text' : 'password'}
                placeholder="At least 8 characters"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" onClick={() => setShow(!show)}>
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
          {mode === 'register' && (
            <fieldset className="privacy-notice">
              <legend>Before you create an account</legend>
              <p className="privacy-notice-intro">
                We collect only what the service needs, and you keep control of it. In summary:
              </p>
              <ul>
                {REGISTRATION_NOTICE_POINTS.map((point) => (
                  <li key={point.slice(0, 40)}>{point}</li>
                ))}
              </ul>
              <p className="privacy-notice-link">
                <Link href="/privacy" target="_blank" rel="noopener noreferrer">
                  Read the full privacy notice
                </Link>{' '}
                — it opens in a new tab so you keep this form.
              </p>
              <label className="terms">
                <input
                  type="checkbox"
                  checked={agreeTerms}
                  onChange={(e) => setAgreeTerms(e.target.checked)}
                />{' '}
                I agree to the{' '}
                <Link
                  href="/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  Terms and Conditions
                </Link>
                .
              </label>
              <label className="terms">
                <input
                  type="checkbox"
                  checked={readPrivacy}
                  onChange={(e) => setReadPrivacy(e.target.checked)}
                />{' '}
                I have read the{' '}
                <Link
                  href="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  Privacy Policy
                </Link>
                .
              </label>
              <p className="privacy-notice-footnote">
                These choices are used by this form only. They are not stored as consent records on
                our servers, because the legal basis for each purpose has not yet been confirmed
                with a lawyer. The notice explains this in full.
              </p>
            </fieldset>
          )}
          {mode === 'login' && (
            <div className="auth-options">
              <label className="remember">
                <input type="checkbox" /> Remember me
              </label>
              <span>Recovery flow not yet connected</span>
            </div>
          )}
          <button className="button button-coral auth-submit" type="submit" disabled={busy}>
            {busy
              ? mode === 'login'
                ? 'Signing in…'
                : 'Creating account…'
              : mode === 'login'
                ? 'Log in'
                : 'Create account'}{' '}
            <LuArrowRight size={14} aria-hidden="true" />
          </button>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          {registered && !error && (
            <div className="inline-success" role="status">
              <LuCircleCheck size={12} className="ic" aria-hidden="true" /> Account created — sign
              in to continue.
            </div>
          )}
          <div className="auth-switch">
            {mode === 'login' ? 'New to Umodzi?' : 'Already have an account?'}{' '}
            <Link href={mode === 'login' ? '/register' : '/login'}>
              {mode === 'login' ? 'Create account' : 'Log in'}
            </Link>
          </div>
        </form>
      </section>
    </main>
  );
}
