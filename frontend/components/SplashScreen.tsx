'use client';
/* The brand artwork is a static SVG served from /public: Next.js serves `.svg`
   as-is, so `<img>` is the correct primitive here — the same rationale (and
   the same scoped rule exemption) as `BrandAsset` in components/ui.tsx. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

/**
 * Umodzi Connect launch splash (professional animated, theme-aware).
 *
 * Scope and rules:
 *   - It covers ONLY the real application-initialization window. The auth
 *     store's single-flight session restore is the initialization signal
 *     (`useAuth` → `ensureAuthInitialized`); this component adds no
 *     competing initialization logic and no fake progress.
 *   - Routing/role selection is NOT duplicated here. Once the splash fades
 *     out, the existing surface underneath (HomeAuthRedirect, RequireAuth,
 *     the login page) performs the real role-based navigation.
 *   - It is mounted once in `app/layout.tsx`, so App Router client
 *     navigations never re-show it. It only appears on an actual app launch.
 *   - The official brand SVGs are reused unchanged (`public/branding/`).
 *     Both the light and the white-lettering variants are in the DOM and
 *     swapped by CSS, so theme selection causes no hydration mismatch.
 *   - Animations are CSS-only (no animation library) and fully disabled by
 *     `prefers-reduced-motion` in globals.css.
 */

/** Presentation floor: lets the staggered entrance actually be seen before
 *  the app appears. It never extends the wait for init — it only prevents a
 *  sub-100ms flash on fast sessions. */
const MIN_VISIBLE_MS = 950;
/** Must match the `.splash-leaving` transition duration in globals.css. */
const EXIT_MS = 520;
/** Hard guard so a stalled init can never become an infinite splash. */
const INIT_TIMEOUT_MS = 15000;

type Phase = 'visible' | 'leaving' | 'gone';

export default function SplashScreen() {
  const { status } = useAuth();
  const [phase, setPhase] = useState<Phase>('visible');
  const [stalled, setStalled] = useState(false);
  const [startedAt] = useState(() => Date.now());

  // Failure guard: if initialization never resolves, offer real recovery
  // instead of spinning forever.
  useEffect(() => {
    if (status !== 'loading') return;
    const timer = setTimeout(() => setStalled(true), INIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // Exit only when initialization is genuinely resolved (or the user chose
  // to continue past a stall).
  useEffect(() => {
    if (status === 'loading') return;
    const remaining = MIN_VISIBLE_MS - (Date.now() - startedAt);
    const timer = setTimeout(() => setPhase('leaving'), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [status, startedAt]);

  useEffect(() => {
    if (phase !== 'leaving') return;
    const timer = setTimeout(() => setPhase('gone'), EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === 'gone') return null;

  const loadingLabel =
    status === 'loading'
      ? 'Restoring your session'
      : status === 'authenticated'
        ? 'Preparing your workspace'
        : 'Ready when you are';

  return (
    <div
      className={`splash${phase === 'leaving' ? ' splash-leaving' : ''}`}
      aria-label="Umodzi Connect is starting"
    >
      <div className="splash-backdrop" aria-hidden="true">
        <span className="splash-accent splash-accent-teal" />
        <span className="splash-accent splash-accent-coral" />
      </div>

      <div className="splash-content">
        {/* Official logo, reused as-is. Only its presentation is animated. */}
        <div className="splash-logo" role="img" aria-label="Umodzi Connect">
          <img
            className="splash-logo-art"
            src="/branding/umodzi-connect-logo.svg"
            alt=""
            width={552}
            height={116}
            fetchPriority="high"
            decoding="async"
          />
          <img
            className="splash-logo-art splash-logo-art-dark"
            src="/branding/umodzi-connect-logo-dark.svg"
            alt=""
            width={552}
            height={116}
            decoding="async"
          />
        </div>

        <p className="splash-tagline">Connecting Skills. Solving Problems.</p>

        {stalled ? (
          <div className="splash-recovery">
            <p className="splash-recovery-text">
              This is taking longer than expected. Check your connection and try again.
            </p>
            <div className="splash-recovery-actions">
              <button
                type="button"
                className="button button-coral"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
              <button type="button" className="outline-button" onClick={() => setPhase('leaving')}>
                Continue anyway
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="splash-loader" aria-hidden="true">
              <span className="splash-loader-ring" />
            </div>
            <p className="splash-status" role="status" aria-live="polite">
              {loadingLabel}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
