import type { MetadataRoute } from 'next';

/**
 * PWA web app manifest.
 *
 * Icons: the approved Umodzi Connect artwork is the single source. The SVG
 * favicon stays as the scalable `any` icon; 192px/512px PNGs (generated from
 * the same artwork with `sharp`, not redrawn) make the app installable, and a
 * purpose-built maskable 512px PNG keeps the mark inside Android's safe zone
 * so launchers never crop it. `apple-touch-icon.png` (180px) is referenced
 * from `app/layout.tsx` for iOS home-screen launches.
 *
 * Native launch presentation: Android builds its launch screen from
 * `background_color` + the app icon, so `background_color` matches the
 * application splash background token (`--bg`, #F5F8FA) and `theme_color`
 * matches the navy status bar (#0B1F3A). CSS animations cannot and do not
 * control that native surface; the in-app splash takes over from an identical
 * background, so a PWA launch does not read as two different screens.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Umodzi Connect',
    short_name: 'Umodzi',
    description: 'Skilled People. Stronger Communities.',
    lang: 'en',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#F5F8FA',
    theme_color: '#0B1F3A',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/branding/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/branding/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/branding/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      { src: '/branding/umodzi-connect-favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
