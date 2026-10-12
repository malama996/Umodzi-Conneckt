'use client';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { LuArrowUpRight } from 'react-icons/lu';
import { logout, useAuth } from '@/lib/auth';

/**
 * Header session controls (Task 23) — rendered inside PublicHeader.
 *
 *   loading     → nothing (avoids a login/logout flash during restore)
 *   anonymous   → the original "Login" link + "Get Started" button
 *   authenticated → signed-in chip + a real Log out button
 *
 * Logout clears the refresh session server-side and drops local auth
 * state; the router then returns the user to the landing page.
 */
export default function AuthNav() {
  const { status, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  if (status === 'loading') {
    return null;
  }

  if (status === 'anonymous') {
    return (
      <>
        <Link href="/login" className="header-login">
          Login
        </Link>
        <Link href="/register" className="button button-coral button-small">
          Get Started <LuArrowUpRight size={13} aria-hidden="true" />
        </Link>
      </>
    );
  }

  const handleLogout = async () => {
    await logout();
    // Protected pages already redirect themselves the moment the store
    // flips to anonymous (RequireAuth → /login?next=…). Issuing a second
    // navigation from here would race that redirect — both transitions
    // abort and the router stalls — so on those pages we navigate NOWHERE
    // and let the gate own the single transition. On public pages there is
    // no gate, so return to the landing page ourselves.
    const onProtectedPage =
      pathname === '/matching' ||
      pathname === '/dashboard' ||
      pathname === '/technician/offers' ||
      pathname.startsWith('/admin');
    if (!onProtectedPage) {
      router.push('/');
    }
  };

  return (
    <div className="header-auth">
      <span className="header-user">
        Signed in as {user ? `${user.firstName} ${user.lastName}`.trim() : '…'}
      </span>
      <button type="button" className="header-login" onClick={() => void handleLogout()}>
        Log out
      </button>
    </div>
  );
}
