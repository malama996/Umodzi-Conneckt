'use client';
import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { HOME_FOR_ROLE } from '@/lib/auth/homeForRole';
import type { UserRole } from '@/lib/auth/authTypes';

/**
 * Protected-route gate.
 *
 * Behaviour:
 *   - status 'loading'   → subtle brand-tinted loading state (no stark white screen)
 *   - status 'anonymous' → instantly redirects to /login?next=<path>
 *   - role mismatch     → displays polite role alert
 *   - authenticated     → renders protected children immediately
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
      <main className="auth-gate auth-gate-loading" role="status" aria-live="polite">
        <div className="auth-gate-spinner" aria-hidden="true" />
      </main>
    );
  }

  if (role && user && user.role !== role) {
    return (
      <main className="auth-gate" role="alert">
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
