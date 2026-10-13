import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import NotificationCenter from '@/components/NotificationCenter';

/* Theme B typography: Using system font stack for reliable builds.
   These match the visual weight of Manrope/Inter while avoiding
   network dependencies during Netlify deployment. */
const fontFamilies = {
  heading: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  body: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

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
