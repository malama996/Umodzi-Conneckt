import type { TechnicianCategory } from '@/lib/categories';
import { ApiError, get } from './client';

/**
 * Technician record exactly as the backend sends it (camelCase JSON,
 * wrapped in a `{ data }` envelope). Category and status fields are
 * plain strings on the wire and are validated by the mapper before
 * they enter the frontend domain.
 */
export interface ApiTechnician {
  id: string;
  name: string;
  category: string;
  skills: string[];
  serviceArea: string;
  rating: number;
  jobs: number;
  verified: boolean;
  availability: string;
  availabilityStatus: string;
  accountStatus: string;
  /**
   * Task 28.3A.1 (G-01): the public technician endpoints no longer return
   * precise coordinates, so these are optional and are absent in practice.
   * The map derives a COARSE service-area marker instead (see lib/mapData).
   */
  latitude?: number;
  longitude?: number;
  /** Task 26: optional public bio (null until the technician writes one). */
  bio?: string | null;
  /** Task 26: true when a profile photo exists (bytes via GET /technicians/:id/photo). */
  hasPhoto?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Backend technician plus the PostGIS distance for the query point. */
export interface NearbyTechnician extends ApiTechnician {
  distance_meters: number;
}

/** Backend envelope shared by every technician endpoint. */
interface TechnicianEnvelope<T> {
  data: T;
}

/**
 * List every technician (backend order: by name).
 * Throws ApiError when the backend is unreachable or errors.
 */
export async function getTechnicians(): Promise<ApiTechnician[]> {
  const body = await get<TechnicianEnvelope<ApiTechnician[]>>('/technicians');
  return body.data;
}

/** Fetch one technician by backend id. Returns null on 404. */
export async function getTechnicianById(id: string): Promise<ApiTechnician | null> {
  try {
    const body = await get<TechnicianEnvelope<ApiTechnician>>(
      `/technicians/${encodeURIComponent(id)}`,
    );
    return body.data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export interface NearbyTechniciansParams {
  latitude: number;
  longitude: number;
  radius?: number;
  category?: TechnicianCategory;
}

/**
 * PostGIS radius search. The backend validates coordinates and radius
 * and returns 400 for invalid input — those errors propagate to callers.
 */
export async function getNearbyTechnicians(
  params: NearbyTechniciansParams,
): Promise<NearbyTechnician[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('latitude', String(params.latitude));
  searchParams.set('longitude', String(params.longitude));
  if (params.radius !== undefined) searchParams.set('radius', String(params.radius));
  if (params.category) searchParams.set('category', params.category);

  const body = await get<TechnicianEnvelope<NearbyTechnician[]>>(
    `/technicians/nearby?${searchParams.toString()}`,
  );
  return body.data;
}
