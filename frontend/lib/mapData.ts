import type { RankedTechnician } from './types';

/**
 * Map data helpers (V0.2 prototype).
 *
 * Pure, framework-free functions for the frontend map UI. These
 * helpers only TRANSFORM existing domain data — they never rank,
 * filter by eligibility, or pick a "best technician". The Smart
 * Dispatch pipeline (via matchingService) remains the single
 * source of truth for matching; the map visualises its output.
 *
 * All coordinates are deterministic mock values. Nothing here
 * performs geolocation, network calls, or backend lookups.
 */

/** A geographic point in WGS84 degrees. */
export interface MapPoint {
  latitude: number;
  longitude: number;
}

/** Axis-aligned geographic bounds enclosing a set of points. */
export interface MapBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * A technician prepared for map display. Derived 1:1 from an
 * existing RankedTechnician — every field is copied from the
 * domain record; nothing is invented here.
 */
export interface TechnicianMapMarker {
  /** Stable marker id (technician name — unique in mock data). */
  id: string;
  name: string;
  category: string;
  rating: number;
  jobs: number;
  verified: boolean;
  availability: string;
  serviceArea: string;
  latitude: number;
  longitude: number;
  /** Great-circle distance from the customer point, in kilometres. */
  distanceKm: number;
}

/**
 * Deterministic COARSE coordinates for the pilot service areas —
 * approximate city-centre points. These are NOT real GPS
 * locations and NOT real technician positions.
 *
 * Task 28.3A.1 (G-01): technician pins on the map are now derived from the
 * technician's self-declared SERVICE AREA city centre via
 * `getServiceAreaPoint()`. The backend no longer returns a technician's
 * stored precise coordinate, and the frontend must not treat one as display
 * data. A city centre is coarse area information, not a location fix.
 *
 * Replacement seams for later tasks:
 * - Customer location: navigator.geolocation or backend-provided
 *   request coordinates (swap the source feeding MapPoint).
 * - Technician marker: already coarse (service-area centre). It should stay
 *   coarse; do NOT wire real technician coordinates into this map.
 */
export const MOCK_CITY_COORDINATES: Readonly<Record<string, MapPoint>> = {
  Kitwe: { latitude: -12.8105, longitude: 28.2073 },
  Ndola: { latitude: -12.9587, longitude: 28.6366 },
};

const DEFAULT_CITY = 'Kitwe';
const EARTH_RADIUS_KM = 6371;

/**
 * Coarse service-area point for a technician's declared area (Task 28.3A.1).
 * Falls back to the default pilot city for unknown values.
 * Returns the shared reference so consumers get stable identity across renders.
 */
export function getServiceAreaPoint(serviceArea: string): MapPoint {
  return MOCK_CITY_COORDINATES[serviceArea] ?? MOCK_CITY_COORDINATES[DEFAULT_CITY];
}

/**
 * Deterministic mock customer location for a request city.
 * Falls back to the default pilot city for unknown values.
 * Returns the shared reference from MOCK_CITY_COORDINATES so
 * consumers get stable identity across renders.
 */
export function getCustomerLocation(city: string): MapPoint {
  return MOCK_CITY_COORDINATES[city] ?? MOCK_CITY_COORDINATES[DEFAULT_CITY];
}

/**
 * Is this a usable WGS84 point?
 *
 * The range check is not decoration: a geolocation provider, a stored value or
 * a URL parameter that yields an out-of-range or non-finite coordinate must be
 * rejected BEFORE it reaches Leaflet (which would throw or silently render a
 * marker in the wrong hemisphere) or any distance calculation. `null`,
 * `undefined` and the `(0, 0)` null-island placeholder are rejected too — a
 * placeholder is not a position, and treating one as a fix is how a map ends up
 * confidently pointing at the Gulf of Guinea.
 */
export function isValidMapPoint(point: unknown): point is MapPoint {
  if (!point || typeof point !== 'object') return false;
  const { latitude, longitude } = point as Partial<MapPoint>;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude < -90 || latitude > 90) return false;
  if (longitude < -180 || longitude > 180) return false;
  if (latitude === 0 && longitude === 0) return false;
  return true;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle (Haversine) distance between two points, in
 * kilometres. Pure math — used only to label mock coordinates.
 */
export function haversineKm(a: MapPoint, b: MapPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Derive map markers from Smart Dispatch ranked candidates.
 *
 * Pass-through only: the input ORDER is preserved (no re-ranking,
 * no re-filtering, no score changes) and every displayed field is
 * copied from the existing technician record.
 *
 * Task 28.3A.1 (G-01): the marker position is the technician's COARSE
 * service-area centre, never a stored precise coordinate. The backend no
 * longer sends one, and a marker is a UI affordance — it must not become a
 * location disclosure. The displayed `distanceKm` is therefore a distance
 * between two city centres, i.e. an approximate area-level figure.
 */
export function toTechnicianMapMarkers(
  ranked: RankedTechnician[],
  customerLocation: MapPoint,
): TechnicianMapMarker[] {
  return toServiceAreaMarkers(
    ranked.map(({ technician, matchedCategory }) => ({
      id: technician.name,
      name: technician.name,
      category: matchedCategory,
      rating: technician.rating,
      jobs: technician.jobs,
      verified: technician.verified,
      availability: technician.availability,
      serviceArea: technician.serviceArea,
    })),
    customerLocation,
  );
}

/**
 * The minimum a technician record must expose to appear on the map. The real
 * platform listing (`GET /technicians`) already satisfies this shape, as does a
 * ranked dispatch candidate.
 */
export interface MapMarkerSource {
  id: string;
  name: string;
  category: string;
  serviceArea: string;
  rating: number;
  jobs: number;
  verified: boolean;
  availability: string;
}

/**
 * Markers for the LIVE technician listing (production-fix Task 5).
 *
 * This is the single marker-building implementation; `toTechnicianMapMarkers`
 * (ranked dispatch candidates) delegates here so the two entry points can never
 * disagree about what a pin means.
 *
 * ---------------------------------------------------------------------------
 * What a technician pin IS, and what it is not
 * ---------------------------------------------------------------------------
 * A pin marks the CENTRE OF THE SERVICE AREA THE TECHNICIAN DECLARED — the
 * coarsest honest position available. It is deliberately NOT the technician's
 * live or stored precise coordinate: the platform does not expose one (the
 * backend omits coordinates from every public technician response, G-01), and
 * publishing a person's whereabouts to anyone browsing the marketplace would
 * be a real-world safety problem, not a feature. The UI labels this plainly, so
 * nobody is led to believe the pin follows a technician around.
 *
 * The distance shown is therefore an AREA-LEVEL figure (customer point → area
 * centre), not a distance to a person.
 */
export function toServiceAreaMarkers(
  technicians: readonly MapMarkerSource[],
  customerLocation: MapPoint,
): TechnicianMapMarker[] {
  return technicians.map((technician) => {
    const area = getServiceAreaPoint(technician.serviceArea);
    return {
      id: technician.id,
      name: technician.name,
      category: technician.category,
      rating: technician.rating,
      jobs: technician.jobs,
      verified: technician.verified,
      availability: technician.availability,
      serviceArea: technician.serviceArea,
      latitude: area.latitude,
      longitude: area.longitude,
      distanceKm: haversineKm(customerLocation, area),
    };
  });
}

/**
 * Bounds enclosing every supplied point (including the customer
 * location when passed in). Returns null for an empty list so
 * callers never fit an empty map.
 */
export function getMapViewBounds(points: readonly MapPoint[]): MapBounds | null {
  if (points.length === 0) {
    return null;
  }
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const point of points) {
    south = Math.min(south, point.latitude);
    north = Math.max(north, point.latitude);
    west = Math.min(west, point.longitude);
    east = Math.max(east, point.longitude);
  }
  return { south, west, north, east };
}

/** Format a distance for display, e.g. `2.4 km` / `49 km`. */
export function formatDistanceKm(km: number): string {
  if (!Number.isFinite(km) || km < 0) {
    return '—';
  }
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/**
 * Escape a string for safe interpolation into marker HTML
 * (Leaflet divIcon markup is raw HTML).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
