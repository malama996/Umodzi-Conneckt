import { isTechnicianCategory } from '@/lib/categories';
import type { ServiceRequest, ServiceRequestCreateInput, ServiceRequestStatus } from '@/lib/types';
import * as serviceRequestsApi from '@/lib/api/serviceRequestsApi';

/**
 * Application service-request boundary (Task 21B).
 *
 * Flow:
 *   UI → requestService → serviceRequestsApi → Fastify → PostgreSQL
 *
 * Backend persistence is authoritative. A failed mutation throws —
 * it is never presented as successfully persisted and nothing is
 * written to local fallback storage. There is exactly one source
 * of truth for request records: the backend database.
 */

/**
 * Validate input for creating a service request.
 * Length bounds mirror the backend schema (min 8 / max 2000) so the
 * client never claims a value is fine that the server will reject.
 * Throws Error with a useful message for invalid input.
 */
function validateCreateInput(input: ServiceRequestCreateInput): void {
  if (!input.description || input.description.trim().length < 8) {
    throw new Error('Description must be at least 8 characters.');
  }
  if (input.description.trim().length > 2000) {
    throw new Error('Description must be at most 2000 characters.');
  }
  if (!input.city || input.city.trim().length === 0) {
    throw new Error('City is required.');
  }
  if (!isTechnicianCategory(input.category)) {
    throw new Error(`Invalid category: ${input.category}`);
  }
}

/**
 * Create a new service request.
 * Persists via POST /api/v1/requests (status starts at 'pending',
 * id and timestamps assigned by the backend). Throws Error for
 * invalid input or when persistence fails.
 */
export async function createServiceRequest(
  input: ServiceRequestCreateInput,
): Promise<ServiceRequest> {
  validateCreateInput(input);
  return serviceRequestsApi.createServiceRequest({
    description: input.description.trim(),
    category: input.category,
    city: input.city.trim(),
  });
}

/**
 * Retrieve a service request by ID.
 * Returns null when the request does not exist.
 */
export async function getServiceRequest(id: string): Promise<ServiceRequest | null> {
  return serviceRequestsApi.getServiceRequest(id);
}

/**
 * Persist a lifecycle status change for a service request.
 * Only status and updatedAt change; all other fields are preserved
 * by the backend. Returns null when the request does not exist.
 * Does NOT enforce lifecycle transition rules — any valid status
 * may be assigned (transitions are enforced by
 * serviceRequestLifecycleService at dispatch time).
 */
export async function updateServiceRequestStatus(
  id: string,
  status: ServiceRequestStatus,
): Promise<ServiceRequest | null> {
  return serviceRequestsApi.updateServiceRequestStatus(id, status);
}
