'use client';
import Link from 'next/link';
import { LuArrowUpRight } from 'react-icons/lu';
import { useAuth } from '@/lib/auth';
import AccountMenu from './AccountMenu';

/**
 * Header session controls (Task 23, refined by §4) — rendered inside
 * PublicHeader, both in the desktop action area and inside the mobile drawer.
 *
 *   loading     → nothing (avoids a login/logout flash during restore)
 *   anonymous   → the original "Login" link + "Get Started" button
 *   authenticated → the shared interactive avatar menu
 *
 * The authenticated branch used to render the label "Signed in as …" next to
 * a plain Log out button: a static indicator where every user expects a
 * control. It is now the same `AccountMenu` the dashboard topbar uses, so the
 * avatar opens the account menu here too — same identity, same items, same
 * confirmed logout. `variant="dark"` restyles it for the translucent header;
 * `compact` keeps the avatar alone where there is no room for the name (the
 * mobile drawer, a 360px header).
 */
export default function AuthNav({ compact = false }: { compact?: boolean }) {
  const { status } = useAuth();

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

  return (
    <div className="header-auth">
      <AccountMenu variant="dark" compact={compact} />
    </div>
  );
}
