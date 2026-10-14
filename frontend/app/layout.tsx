import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import NotificationCenter from '@/components/NotificationCenter';

/* Theme B typography: the system font stack, applied in globals.css on
   `body` (and inherited by headings and inputs). It matches the visual weight
   of the previous webfont while avoiding a network dependency during the
   Netlify build — a `next/font` declaration here would have been dead code,
   so it is deliberately not duplicated. */

export const metadata: Metadata = {
  title: 'Umodzi Connect',
  description: 'Skilled People. Stronger Communities.',
  icons: { icon: '/branding/umodzi-connect-favicon.svg' },
};

/* Mobile/PWA viewport (Phase 2):
   - viewportFit 'cover' lets the standalone PWA use the full display
     (notches/home bars); globals.css pairs it with env(safe-area-inset-*)
     padding on the header/footer/hero so nothing is ever covered.
   - themeColor matches the manifest (#0B1F3A) so the Android status bar
     blends with the app chrome. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0B1F3A',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <NotificationCenter />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
