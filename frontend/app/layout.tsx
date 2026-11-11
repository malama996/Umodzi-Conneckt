import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import NotificationCenter from '@/components/NotificationCenter';
import ScrollReveals from '@/components/ScrollReveals';
import SplashScreen from '@/components/SplashScreen';

/* Theme B typography: the system font stack, applied in globals.css on
   `body` (and inherited by headings and inputs). It matches the visual weight
   of the previous webfont while avoiding a network dependency during the
   Netlify build — a `next/font` declaration here would have been dead code,
   so it is deliberately not duplicated. */

export const metadata: Metadata = {
  title: 'Umodzi Connect',
  description: 'Skilled People. Stronger Communities.',
  icons: {
    icon: [
      { url: '/branding/umodzi-connect-favicon.svg', type: 'image/svg+xml' },
      { url: '/branding/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/branding/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: { capable: true, title: 'Umodzi Connect', statusBarStyle: 'default' },
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

/**
 * Theme resolution before the first paint (no incorrect-theme flash).
 *
 * The application has no app-wide dark theme yet, so this does NOT restyle
 * pages: it records the resolved preference on <html data-theme> — a saved
 * explicit choice first, the device preference otherwise — and the launch
 * splash uses that one attribute to pick its matching brand variant and
 * background. Runs synchronously before the body paints; every failure is
 * swallowed so a blocked localStorage can never break the document.
 */
const THEME_BOOT_SCRIPT = `(function(){try{var s=null;try{s=window.localStorage.getItem('umodzi-theme')}catch(e){}var d=s==='light'||s==='dark'?s:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var h=document.documentElement;h.setAttribute('data-theme',d);}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <SplashScreen />
        {children}
        <ScrollReveals />
        <NotificationCenter />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
