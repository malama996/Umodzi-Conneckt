import type { MetadataRoute } from 'next';

/**
 * PWA web app manifest (V0.2).
 *
 * Task 24 added the approved Umodzi Connect SVG favicon as the single
 * `any`-size icon. Raster 192px/512px PNGs are still deliberately absent —
 * add them here before pursuing installability. Keeping the manifest light
 * supports the low-data requirement.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Umodzi Connect',
    short_name: 'Umodzi',
    description: 'Skilled People. Stronger Communities.',
    start_url: '/',
    display: 'standalone',
    background_color: '#F5F8FA',
    theme_color: '#0B1F3A',
    icons: [
      {
        src: '/branding/umodzi-connect-favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
    ],
  };
}
