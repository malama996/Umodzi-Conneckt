/**
 * Compatibility shim kept during the V0.2 mock-layer migration.
 *
 * Canonical definitions now live in:
 * - lib/types.ts         — SkillCategory, Technician, etc. (single source of truth)
 * - lib/mocks/           — typed mock data layer
 *
 * Existing imports of `services` / `technicians` keep working. New code should
 * import from '@/lib/mocks' and '@/lib/types' directly. No mock records are
 * duplicated here.
 */
import { SKILL_CATEGORIES } from './types';
import { technicians } from './mocks/technicians';

/** @deprecated Use `SKILL_CATEGORIES` from '@/lib/types' instead. */
export const services = [...SKILL_CATEGORIES];

/** @deprecated Use `technicians` from '@/lib/mocks' instead. */
export { technicians };

export const landingPageConfig = {
  hero: {
    title: 'Local Skills. Real Solutions.',
    description:
      'Find skilled technicians for home, business and community needs across Kitwe and Ndola.',
    backgroundImage: '/images/landing-background-city.jpg',
    backgroundPosition: 'center right',
    overlayOpacity: 0.78,
  },
};
