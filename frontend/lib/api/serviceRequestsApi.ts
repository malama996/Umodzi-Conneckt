import { isTechnicianCategory } from '@/lib/categories';
import type { ServiceRequest, ServiceRequestCreateInput, ServiceRequestStatus } from '@/lib/types';
import { ApiError, get, patch, post } from './client';

/**
 * Service request exactly as the backend sends it (inside a `{ data }`
 * envelope). Status/category arrive as strings and are validated
 * before entering the frontend domain.
 */
interface ServiceRequestDto {
  id: string;
  description: string;
  category: string;
  city: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const REQUEST_STATUSES: readonly string[] = [
  'pending',
  'matching',
  'matched',
  'no_match',
  'in_progress',
  'completed',
  'cancelled',
];

/**
 * Validate a backend service-request payload against the frontend
 * domain contract. Throws when the backend returns a value outside
 * the known lifecycle/category vocabulary.
 */
function toServiceRequest(dto: ServiceRequestDto): ServiceRequest {
  if (!isTechnicianCategory(dto.category)) {
    throw new Error(`Backend returned an unknown category: ${dto.category}`);
  }
  if (!REQUEST_STATUSES.includes(dto.status)) {
    throw new Error(`Backend returned an unknown request status: ${dto.status}`);
  }
  return {
    id: dto.id,
    description: dto.description,
    category: dto.category,
    city: dto.city,
    status: dto.status as ServiceRequestStatus,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

/**
 * Persist a new service request. The backend assigns the id, sets
 * status to 'pending', and returns the stored row. Throws ApiError
 * on validation (400) or server failures — callers must surface the
 * error, never present the request as saved.
 */
export async function createServiceRequest(
  input: ServiceRequestCreateInput,
): Promise<ServiceRequest> {
  const body = await post<{ data: ServiceRequestDto }>('/requests', {
    description: input.description,
    category: input.category,
    city: input.city,
  });
  return toServiceRequest(body.data);
}

/** Fetch one service request by id. Returns null on 404. */
export async function getServiceRequest(id: string): Promise<ServiceRequest | null> {
  try {
    const body = await get<{ data: ServiceRequestDto }>(`/requests/${encodeURIComponent(id)}`);
    return toServiceRequest(body.data);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Persist a lifecycle status change. Returns null when the request
 * does not exist (404); throws on any other backend failure.
 */
export async function updateServiceRequestStatus(
  id: string,
  status: ServiceRequestStatus,
): Promise<ServiceRequest | null> {
  try {
    const body = await patch<{ data: ServiceRequestDto }>(
      `/requests/${encodeURIComponent(id)}/status`,
      { status },
    );
    return toServiceRequest(body.data);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** History row — a request plus the dispatch context shown alongside it. */
export interface MyServiceRequest extends ServiceRequest {
  /** Technician whose offer was accepted on this request, when there is one. */
  assignedTechnicianName: string | null;
  /** Number of dispatch offers the request has received. */
  offerCount: number;
}

interface MyServiceRequestDto extends ServiceRequestDto {
  assignedTechnicianName: string | null;
  offerCount: number;
}

/**
 * GET /me/requests — this account's own service requests, newest first
 * (Phase 4). The scope is decided by the backend from the session, so a
 * customer only ever receives their own rows and a technician only rows
 * they hold an offer on. Rows are validated through the same contract as a
 * single request, so an unexpected backend value fails loudly instead of
 * rendering as an unknown status.
 */
export async function listMyServiceRequests(): Promise<MyServiceRequest[]> {
  const body = await get<{ data: { requests?: MyServiceRequestDto[] } }>('/me/requests');
  return (body.data?.requests ?? []).map((dto) => ({
    ...toServiceRequest(dto),
    assignedTechnicianName: dto.assignedTechnicianName ?? null,
    offerCount: Number.isFinite(dto.offerCount) ? dto.offerCount : 0,
  }));
}

/**
 * Safe, user-facing message for a service-request failure, following the
 * per-domain convention used by the other API modules. Never echoes the
 * response body verbatim unless the backend itself supplied a safe message.
 */
export function requestErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* non-JSON body */
    }
    if (error.status === 401) return 'Your session has expired. Please sign in again.';
    if (error.status === 403) return 'You do not have permission to view this.';
    if (error.status === 404) return 'That service request is no longer available.';
    if (error.status >= 500) return 'Something went wrong on our side. Please try again.';
  }
  if (error instanceof Error && error.message.startsWith('Backend returned')) {
    // A contract mismatch — surface it rather than rendering unknown values.
    return 'The server sent data this app does not recognise. Please try again later.';
  }
  return 'Unable to reach the server. Check your connection and try again.';
}
