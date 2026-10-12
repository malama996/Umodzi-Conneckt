import type { Metadata } from 'next';
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
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Umodzi Connect',
  description: 'Skilled People. Stronger Communities.',
  icons: { icon: '/branding/umodzi-connect-favicon.svg' },
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
