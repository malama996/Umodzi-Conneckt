import { isTechnicianCategory } from '@/lib/categories';
import type { AccountStatus, AvailabilityStatus, Technician } from '@/lib/types';
import type { ApiTechnician } from './techniciansApi';

const AVAILABILITY_STATUSES: readonly string[] = ['available', 'unavailable'];
const ACCOUNT_STATUSES: readonly string[] = ['active', 'inactive', 'suspended'];

/**
 * Single explicit API → frontend transformation boundary (Task 21B).
 *
 * Maps a backend technician record to the frontend Technician shape.
 * Category and status strings are validated against the domain
 * vocabulary — unknown values throw instead of entering the
 * dispatch engine. No unsafe casts, no duplicated mapping logic.
 *
 * `city` is derived from `serviceArea`: in the pilot data the service
 * area IS the city (Kitwe/Ndola). Documented derivation — revisit if
 * service areas ever diverge from city names.
 *
 * Task 28.3A.1 (G-01): precise coordinates are deliberately NOT mapped.
 * The backend stopped returning them on public technician routes, and the
 * frontend must not reintroduce the exposure by treating a server-provided
 * coordinate as display data. The prototype map instead derives a COARSE
 * city-centre marker from `serviceArea` (see lib/mapData).
 */
export function mapApiTechnicianToFrontend(apiTech: ApiTechnician): Technician {
  if (!isTechnicianCategory(apiTech.category)) {
    throw new Error(`Backend returned an unknown technician category: ${apiTech.category}`);
  }
  if (!AVAILABILITY_STATUSES.includes(apiTech.availabilityStatus)) {
    throw new Error(
      `Backend returned an unknown availability status: ${apiTech.availabilityStatus}`,
    );
  }
  if (!ACCOUNT_STATUSES.includes(apiTech.accountStatus)) {
    throw new Error(`Backend returned an unknown account status: ${apiTech.accountStatus}`);
  }
  const serviceArea = apiTech.serviceArea.trim();
  if (!serviceArea) {
    throw new Error(`Backend technician ${apiTech.id} has an empty service area`);
  }
  return {
    id: apiTech.id,
    name: apiTech.name,
    category: apiTech.category,
    skills: [...apiTech.skills],
    serviceArea,
    city: serviceArea,
    rating: apiTech.rating,
    jobs: apiTech.jobs,
    verified: apiTech.verified,
    availability: apiTech.availability,
    availabilityStatus: apiTech.availabilityStatus as AvailabilityStatus,
    accountStatus: apiTech.accountStatus as AccountStatus,
    // Intentionally no latitude/longitude — see the boundary comment above.
    bio: apiTech.bio ?? null,
    hasPhoto: apiTech.hasPhoto ?? false,
  };
}

/** Map a backend technician list to frontend technicians. */
export function mapApiTechniciansToFrontend(apiTechs: ApiTechnician[]): Technician[] {
  return apiTechs.map(mapApiTechnicianToFrontend);
}
