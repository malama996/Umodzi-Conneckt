import { getEligibleTechnicians, rankEligibleTechnicians } from '@/lib/services/dispatchService';
import type { RankedTechnician, ServiceRequest, SmartDispatchResult } from '@/lib/types';

/**
 * Smart Dispatch orchestration service (V0.2).
 *
 * Connects the existing eligibility and ranking services into a controlled
 * dispatch workflow. Does NOT implement cascading offers, notifications,
 * lifecycle transitions, or UI.
 *
 * Architecture:
 *   ServiceRequest → getEligibleTechnicians() → rankEligibleTechnicians() → SmartDispatchResult
 *
 * The orchestration does NOT duplicate eligibility or ranking logic.
 * It delegates entirely to the existing dispatchService functions.
 */

/**
 * Run the smart dispatch orchestration for a service request.
 *
 * 1. Obtains eligible technicians via getEligibleTechnicians().
 * 2. Passes them to rankEligibleTechnicians().
 * 3. Returns a SmartDispatchResult with matched/no_match status.
 *
 * Never mutates the request or technician source data.
 * Never changes the request lifecycle status.
 * Never sends offers or notifications.
 */
export async function dispatchServiceRequest(
  request: ServiceRequest,
): Promise<SmartDispatchResult> {
  const eligible = await getEligibleTechnicians(request);

  if (eligible.length === 0) {
    return {
      requestId: request.id,
      status: 'no_match',
      candidates: [],
    };
  }

  const ranked: RankedTechnician[] = rankEligibleTechnicians(request, eligible);

  return {
    requestId: request.id,
    status: 'matched',
    candidates: ranked,
  };
}
