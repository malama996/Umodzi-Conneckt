import type { DispatchOffer, DispatchOfferStatus } from '@/lib/types';
import { post } from './client';
import { get } from './client';

/** Backend offer row: the domain DispatchOffer plus its database id. */
export interface PersistedOffer extends DispatchOffer {
  id: string;
}

interface OfferDto {
  id: string;
  requestId: string;
  technicianId: string;
  candidateIndex: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const OFFER_STATUSES: readonly string[] = ['pending', 'accepted', 'rejected', 'timed_out'];

/** Validate a backend offer payload against the domain contract. */
function toPersistedOffer(dto: OfferDto): PersistedOffer {
  if (!OFFER_STATUSES.includes(dto.status)) {
    throw new Error(`Backend returned an unknown offer status: ${dto.status}`);
  }
  return {
    id: dto.id,
    requestId: dto.requestId,
    technicianId: dto.technicianId,
    candidateIndex: dto.candidateIndex,
    status: dto.status as DispatchOfferStatus,
  };
}

/**
 * Persist a newly dispatched offer (POST /api/v1/offers).
 * The backend validates request/technician references and status.
 */
export async function createOffer(input: {
  requestId: string;
  technicianId: string;
  candidateIndex: number;
  status: DispatchOfferStatus;
}): Promise<PersistedOffer> {
  const body = await post<{ data: OfferDto }>('/offers', input);
  return toPersistedOffer(body.data);
}

/** All offers recorded for one technician (backend order: newest first). */
export async function getTechnicianOffers(technicianId: string): Promise<PersistedOffer[]> {
  const body = await get<{ data: OfferDto[] }>(
    `/offers/technician/${encodeURIComponent(technicianId)}`,
  );
  return body.data.map(toPersistedOffer);
}

/** All offers recorded for one service request, oldest candidate first. */
export async function getRequestOffers(requestId: string): Promise<PersistedOffer[]> {
  const body = await get<{ data: OfferDto[] }>(`/requests/${encodeURIComponent(requestId)}/offers`);
  return body.data.map(toPersistedOffer);
}

/** Persist an 'accepted' outcome for one offer row. */
export async function acceptOffer(offerId: string): Promise<PersistedOffer> {
  const body = await post<{ data: OfferDto }>(`/offers/${encodeURIComponent(offerId)}/accept`);
  return toPersistedOffer(body.data);
}

/** Persist a 'rejected' outcome for one offer row. */
export async function rejectOffer(offerId: string): Promise<PersistedOffer> {
  const body = await post<{ data: OfferDto }>(`/offers/${encodeURIComponent(offerId)}/reject`);
  return toPersistedOffer(body.data);
}

/** Persist an explicit prototype 'timed_out' outcome (no timers). */
export async function timeoutOffer(offerId: string): Promise<PersistedOffer> {
  const body = await post<{ data: OfferDto }>(`/offers/${encodeURIComponent(offerId)}/timeout`);
  return toPersistedOffer(body.data);
}
