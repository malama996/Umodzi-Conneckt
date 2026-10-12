import {
  runSmartDispatchPipeline,
  type SmartDispatchPipelineResult,
} from '@/lib/services/smartDispatchPipelineService';
import type { DispatchOfferStatus, ServiceRequest } from '@/lib/types';

// Re-exported so the UI can type pipeline results while importing
// only from the application-facing boundary (matchingService).
export type { SmartDispatchPipelineResult };

/**
 * Application-facing matching service (V0.2).
 *
 * Integration boundary between the application/matching flow and the
 * Smart Dispatch domain pipeline. Delegates entirely to the existing
 * `runSmartDispatchPipeline()` — does NOT reimplement eligibility, ranking,
 * cascading, or lifecycle logic.
 *
 * Architecture:
 *   Application / Matching Flow
 *     → matchingService
 *     → runSmartDispatchPipeline()
 *     → SmartDispatchPipelineResult
 *
 * No UI, no backend, no notifications, no timers, no real communication.
 * Outcomes are explicit application inputs for this prototype.
 */

/**
 * Run Smart Dispatch for a service request.
 *
 * Application-facing wrapper around `runSmartDispatchPipeline()`.
 * Accepts an optional sequence of explicit demo outcomes
 * ('accepted', 'rejected', 'timed_out') to simulate technician responses
 * without real communication.
 *
 * @param request - The service request to dispatch (must be in 'pending' status)
 * @param outcomes - Optional sequence of offer outcomes to simulate
 * @returns The pipeline result with updated request, dispatch result, and current offer
 *
 * Does NOT mutate the original request or technician data.
 */
export async function executeSmartDispatch(
  request: ServiceRequest,
  outcomes: DispatchOfferStatus[] = [],
): Promise<SmartDispatchPipelineResult> {
  return runSmartDispatchPipeline(request, outcomes);
}
