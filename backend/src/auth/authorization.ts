import { query } from '../db/client.js';
import type { AuthenticatedUser } from './authMiddleware.js';
import { assertUuid } from './authService.js';
import { HttpError } from './httpError.js';

/**
 * Data-ownership authorization (Task 23).
 *
 * The backend derives ownership exclusively from the authenticated
 * identity — request.customer_user_id and the offer → technician → user
 * chain decide access, never a client-supplied id.
 *
 * Failure policy (§23 / §45):
 *   - reading a resource that exists but belongs to someone else → 404,
 *     so a valid UUID does not confirm existence to a stranger;
 *   - an authenticated caller hitting an endpoint they may never use
 *     (wrong role / another technician's id in the path) → 403.
 *
 * Legacy note: rows created before Task 23 have customer_user_id NULL.
 * They are never claimed: only administrators (and technicians already
 * holding an offer on them) can touch them.
 */

export interface RequestRow {
  id: string;
  description: string;
  category: string;
  city: string;
  status: string;
  created_at: string;
  updated_at: string;
  customer_user_id: string | null;
}

export interface OfferRow {
  id: string;
  request_id: string;
  technician_id: string;
  candidate_index: number;
  status: string;
  created_at: string;
  updated_at: string;
}

const REQUEST_COLUMNS =
  'id, description, category, city, status, created_at, updated_at, customer_user_id';

/** Is this technician account linked to the profile that holds offers? */
async function isOfferParticipant(requestId: string, userId: string): Promise<boolean> {
  const rows = await query(
    `SELECT 1 FROM dispatch_offers o
     JOIN technicians t ON t.id = o.technician_id
     WHERE o.request_id = $1 AND t.user_id = $2
     LIMIT 1`,
    [requestId, userId],
  );
  return rows.length > 0;
}

/**
 * Load a service request the caller is allowed to see:
 * administrator, the owning customer, or a technician holding an offer
 * on it (the technician flow hydrates the request it must respond to).
 * Anything else → 404 "Service request not found".
 */
export async function loadRequestForUser(
  requestId: string,
  user: AuthenticatedUser,
): Promise<RequestRow> {
  assertUuid(requestId);
  const rows = await query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM service_requests WHERE id = $1`,
    [requestId],
  );
  const row = rows[0];
  if (!row) {
    throw new HttpError(404, 'Service request not found');
  }
  if (user.role === 'administrator') return row;
  if (user.role === 'customer' && row.customer_user_id === user.id) return row;
  if (user.role === 'technician' && (await isOfferParticipant(requestId, user.id))) {
    return row;
  }
  // Hides existence from other customers / unrelated technicians.
  throw new HttpError(404, 'Service request not found');
}

/**
 * Load an offer (+ its request) for a response mutation
 * (accept / reject / timeout). Allowed: administrator, the technician
 * who owns the offer, or the customer who owns the request the offer
 * sits on (the customer-side accept/reject flow on /matching).
 */
export async function loadOfferForResponse(
  offerId: string,
  user: AuthenticatedUser,
): Promise<{ offer: OfferRow; request: RequestRow }> {
  assertUuid(offerId);
  const rows = await query<
    OfferRow & {
      r_id: string;
      r_description: string;
      r_category: string;
      r_city: string;
      r_status: string;
      r_created_at: string;
      r_updated_at: string;
      r_customer_user_id: string | null;
    }
  >(
    `SELECT o.id, o.request_id, o.technician_id, o.candidate_index, o.status,
            o.created_at, o.updated_at,
            r.id AS r_id, r.description AS r_description, r.category AS r_category,
            r.city AS r_city, r.status AS r_status, r.created_at AS r_created_at,
            r.updated_at AS r_updated_at, r.customer_user_id AS r_customer_user_id
     FROM dispatch_offers o
     JOIN service_requests r ON r.id = o.request_id
     WHERE o.id = $1`,
    [offerId],
  );
  const row = rows[0];
  if (!row) {
    throw new HttpError(404, 'Offer not found');
  }

  const offer: OfferRow = {
    id: row.id,
    request_id: row.request_id,
    technician_id: row.technician_id,
    candidate_index: row.candidate_index,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  const request: RequestRow = {
    id: row.r_id,
    description: row.r_description,
    category: row.r_category,
    city: row.r_city,
    status: row.r_status,
    created_at: row.r_created_at,
    updated_at: row.r_updated_at,
    customer_user_id: row.r_customer_user_id,
  };

  if (user.role === 'administrator') return { offer, request };

  if (user.role === 'technician') {
    const owned = await query(
      'SELECT 1 FROM technicians WHERE id = $1 AND user_id = $2',
      [offer.technician_id, user.id],
    );
    if (owned.length > 0) return { offer, request };
    // Another technician's offer: indistinguishable from a missing row.
    throw new HttpError(404, 'Offer not found');
  }

  if (user.role === 'customer' && request.customer_user_id === user.id) {
    return { offer, request };
  }
  throw new HttpError(404, 'Offer not found');
}

/**
 * GET /offers/technician/:technicianId — endpoint-level identity check.
 * A technician may read ONLY the collection keyed by their own profile id
 * (administrator may read any); anyone else gets 403. Unlike resource
 * reads, this 403 leaks nothing: it answers about the caller's own right
 * to use the endpoint, not about whether some id exists.
 */
export async function assertTechnicianOfferCollection(
  technicianId: string,
  user: AuthenticatedUser,
): Promise<void> {
  assertUuid(technicianId);
  if (user.role === 'administrator') return;
  if (user.role !== 'technician') {
    throw new HttpError(403, 'Forbidden: only technicians may read technician offers');
  }
  const mine = await query<{ id: string }>(
    'SELECT id FROM technicians WHERE user_id = $1',
    [user.id],
  );
  if (!mine[0] || mine[0].id !== technicianId) {
    throw new HttpError(403, 'Forbidden: you may only read your own offers');
  }
}

/**
 * POST /offers — creating a (cascade) offer row requires write access to
 * the owning request (owner customer / technician participant / admin)
 * and a technician target that actually exists (FK integrity without
 * surfacing a raw database error).
 */
export async function assertOfferCreateAccess(
  requestId: string,
  targetTechnicianId: string,
  user: AuthenticatedUser,
): Promise<RequestRow> {
  const request = await loadRequestForUser(requestId, user);
  assertUuid(targetTechnicianId);
  const target = await query('SELECT 1 FROM technicians WHERE id = $1', [
    targetTechnicianId,
  ]);
  if (target.length === 0) {
    throw new HttpError(404, 'Technician not found');
  }
  return request;
}

/**
 * POST /offers — Task 28 server-side eligibility gate (handoff §6).
 *
 * The backend NEVER trusts the frontend dispatch/candidate pipeline: before
 * an offer row is persisted it independently re-verifies, from the database,
 * that the request is open for offers and that the target technician is a
 * genuinely eligible candidate. A hand-crafted offer to an ineligible
 * technician is rejected here even though the real dispatch UI could never
 * produce one.
 *
 * Failure policy:
 *   - request not in an offerable state, or a duplicate offer → 409;
 *   - technician inactive / unverified / unavailable / wrong category /
 *     outside the service area (or radius) → 422;
 *   - missing technician → 404 (existence already checked upstream).
 *
 * Service radius: the canonical dispatch rule (Tasks 11–12) is a city /
 * service-area match — there is no per-technician radius column — so that is
 * the primary gate. When MAX_SERVICE_RADIUS_KM is configured AND both the
 * request and the technician carry coordinates, a PostGIS ST_Distance cap is
 * applied on top (best effort; API-created requests have no coordinates).
 */
const OFFERABLE_REQUEST_STATUSES = new Set(['pending', 'matching']);

interface TechnicianEligibilityRow {
  id: string;
  category: string;
  service_area: string;
  account_status: string;
  availability_status: string;
  verification_status: string;
  verified: boolean;
  latitude: number | null;
  longitude: number | null;
}

function normalizeArea(value: string): string {
  return value.trim().toLowerCase();
}

export async function assertOfferEligibility(
  request: RequestRow,
  technicianId: string,
): Promise<void> {
  if (!OFFERABLE_REQUEST_STATUSES.has(request.status)) {
    throw new HttpError(409, 'Service request is not open for offers');
  }

  const rows = await query<TechnicianEligibilityRow>(
    `SELECT id, category, service_area, account_status, availability_status,
            verification_status, verified, latitude, longitude
     FROM technicians WHERE id = $1`,
    [technicianId],
  );
  const tech = rows[0];
  if (!tech) {
    throw new HttpError(404, 'Technician not found');
  }

  if (tech.account_status !== 'active') {
    throw new HttpError(422, 'Technician is not active');
  }
  if (tech.verification_status !== 'verified' && tech.verified !== true) {
    throw new HttpError(422, 'Technician is not verified');
  }
  if (tech.availability_status !== 'available') {
    throw new HttpError(422, 'Technician is not available');
  }
  if (tech.category !== request.category) {
    throw new HttpError(
      422,
      'Technician does not cover the requested service category',
    );
  }
  if (normalizeArea(tech.service_area) !== normalizeArea(request.city)) {
    throw new HttpError(422, 'Technician is outside the requested service area');
  }

  const maxRadiusKm = Number(process.env.MAX_SERVICE_RADIUS_KM);
  if (
    Number.isFinite(maxRadiusKm) &&
    maxRadiusKm > 0 &&
    tech.latitude !== null &&
    tech.longitude !== null
  ) {
    const reqRows = await query<{
      latitude: number | null;
      longitude: number | null;
    }>('SELECT latitude, longitude FROM service_requests WHERE id = $1', [
      request.id,
    ]);
    const req = reqRows[0];
    if (req && req.latitude !== null && req.longitude !== null) {
      const dist = await query<{ meters: number }>(
        `SELECT ST_Distance(
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
         ) AS meters`,
        [req.longitude, req.latitude, tech.longitude, tech.latitude],
      );
      if (dist[0] && dist[0].meters > maxRadiusKm * 1000) {
        throw new HttpError(
          422,
          'Technician is outside the permitted service radius',
        );
      }
    }
  }

  const duplicate = await query(
    'SELECT 1 FROM dispatch_offers WHERE request_id = $1 AND technician_id = $2 LIMIT 1',
    [request.id, technicianId],
  );
  if (duplicate.length > 0) {
    throw new HttpError(
      409,
      'An offer already exists for this technician on this request',
    );
  }
}

/**
 * PATCH /requests/:id/status write scope for technician participants:
 * the respond flow may only persist the terminal statuses produced by
 * its own cascade ('matched' / 'no_match'). Customers keep the existing
 * full status vocabulary (unchanged Task-15 lifecycle behaviour).
 */
export function assertRequestStatusWriteScope(
  status: string,
  user: AuthenticatedUser,
): void {
  if (user.role === 'technician' && status !== 'matched' && status !== 'no_match') {
    throw new HttpError(
      403,
      'Forbidden: technicians may only record matched or no_match on requests they were offered',
    );
  }
}
