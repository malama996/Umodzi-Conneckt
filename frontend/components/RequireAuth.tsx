'use client';
import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { HOME_FOR_ROLE } from '@/lib/auth/homeForRole';
import type { UserRole } from '@/lib/auth/authTypes';

/**
 * Protected-route gate (Task 23).
 *
 * Behaviour:
 *   - status 'loading'  → render ONLY a "checking session" placeholder
 *                         (protected content is never flashed before the
 *                         authentication state is known, §33);
 *   - status 'anonymous' → redirect to /login?next=<path> (the login page
 *                         returns to the original destination);
 *   - role mismatch      → render an explicit access-denied panel (no
 *                         protected children are rendered) — an
 *                         authenticated but wrong-role user is BLOCKED
 *                         rather than silently redirected;
 *   - authenticated + role match → render children unchanged.
 *
 * The role comes from the backend (GET /auth/me-style session user), never
 * from anything the URL or client storage claims.
 */

const ROLE_LABELS: Record<UserRole, string> = {
  customer: 'customer',
  technician: 'technician',
  administrator: 'administrator',
};

export default function RequireAuth({ role, children }: { role?: UserRole; children: ReactNode }) {
  const { status, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [status, pathname, router]);

  if (status !== 'authenticated') {
    return (
      <main className="auth-gate" role="status" aria-live="polite">
        <p>Checking your session…</p>
      </main>
    );
  }

  if (role && user && user.role !== role) {
    return (
      <main className="auth-gate" role="alert">
        <p className="eyebrow eyebrow-dark">ACCESS DENIED</p>
        <h1>This page is for {ROLE_LABELS[role]} accounts.</h1>
        <p>
          You are signed in as {user.email} ({ROLE_LABELS[user.role]}).
        </p>
        <p>
          <Link href={HOME_FOR_ROLE[user.role]}>Go to my page</Link>
          {' · '}
          <Link href="/">Home</Link>
        </p>
      </main>
    );
  }

  return <>{children}</>;
}
