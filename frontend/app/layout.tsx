import type { Metadata, Viewport } from 'next';
import { Manrope, Inter } from 'next/font/google';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import NotificationCenter from '@/components/NotificationCenter';

/* Theme B typography: Manrope for headings, Inter for body/UI. Both are
   self-hosted at build time by next/font (no runtime network requests),
   which keeps the low-data/mobile-first budget intact. Exposed as CSS
   variables so globals.css can reference them with sane fallbacks. */
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-heading',
  display: 'swap',
  preload: true,
  adjustFontFallback: true,
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
  preload: true,
  adjustFontFallback: true,
});

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
    <html lang="en" className={`${manrope.variable} ${inter.variable}`}>
      <body>
        {children}
        <NotificationCenter />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
