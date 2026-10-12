import type {
  DispatchScoreBreakdown,
  EligibleTechnicianResult,
  RankedTechnician,
  ServiceRequest,
  Technician,
} from '@/lib/types';
import { getTechnicians as fetchTechnicians } from '@/lib/api/techniciansApi';
import { mapApiTechniciansToFrontend } from '@/lib/api/technicianMapper';

/**
 * Dispatch scoring weights. Must sum to exactly 1.
 * These are prototype design values — not calibrated against real data.
 */
export const DISPATCH_WEIGHTS = {
  proximity: 0.4,
  trust: 0.3,
  availability: 0.2,
  fairness: 0.1,
} as const;

/**
 * Normalize a city/service-area string for comparison.
 * Limited to trim + lowercase. Does NOT normalize spelling variations.
 */
function normalizeCity(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Round a score to 4 decimal places for display/test stability.
 */
function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Clamp a value to the range [0, 1].
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * PROXIMITY SCORE — MOCK PROXY ONLY.
 *
 * There is currently no coordinate/radius data. This is a deterministic
 * city-match proxy: exact normalized service-area/city match → 1.0.
 *
 * This is NOT real geographic proximity. It is a temporary placeholder
 * for future PostGIS distance scoring.
 */
function scoreProximity(technician: Technician, request: ServiceRequest): number {
  const match = normalizeCity(technician.serviceArea) === normalizeCity(request.city);
  return match ? 1.0 : 0.0;
}

/**
 * TRUST SCORE.
 *
 * Deterministic trust score using ONLY existing Technician fields:
 *   trust = 0.5 * verifiedScore + 0.3 * ratingScore + 0.2 * jobScore
 *
 * where:
 *   verifiedScore = verified ? 1 : 0
 *   ratingScore   = rating / 5
 *   jobScore      = min(jobs / 100, 1)
 *
 * No reviews, disputes, response time, or cancellation history.
 */
function scoreTrust(technician: Technician): number {
  const verifiedScore = technician.verified ? 1 : 0;
  const ratingScore = clamp01(technician.rating / 5);
  const jobScore = clamp01(technician.jobs / 100);
  return clamp01(0.5 * verifiedScore + 0.3 * ratingScore + 0.2 * jobScore);
}

/**
 * AVAILABILITY SCORE.
 *
 * Task 11 already guarantees eligible technicians have
 * availabilityStatus === 'available'. Therefore for this deterministic
 * prototype: available → 1.0.
 *
 * Kept separate so a future real availability score can replace it.
 */
function scoreAvailability(technician: Technician): number {
  return technician.availabilityStatus === 'available' ? 1.0 : 0.0;
}

/**
 * FAIRNESS SCORE.
 *
 * There is no historical dispatch/fairness data yet.
 * Uses a deterministic neutral baseline: 0.5
 *
 * This is a PLACEHOLDER — NOT a real fairness algorithm.
 */
function scoreFairness(): number {
  return 0.5;
}

/**
 * Compute the full dispatch score breakdown for a technician.
 *
 * All score functions are pure — they receive a Technician object
 * and a ServiceRequest and return numeric scores. No I/O is performed.
 */
function computeScore(technician: Technician, request: ServiceRequest): DispatchScoreBreakdown {
  const proximity = scoreProximity(technician, request);
  const trust = scoreTrust(technician);
  const availability = scoreAvailability(technician);
  const fairness = scoreFairness();

  const finalScore = clamp01(
    DISPATCH_WEIGHTS.proximity * proximity +
      DISPATCH_WEIGHTS.trust * trust +
      DISPATCH_WEIGHTS.availability * availability +
      DISPATCH_WEIGHTS.fairness * fairness,
  );

  return {
    proximity: roundScore(proximity),
    trust: roundScore(trust),
    availability: roundScore(availability),
    fairness: roundScore(fairness),
    finalScore: roundScore(finalScore),
  };
}

/**
 * Get technicians eligible for a service request.
 *
 * Applies five filters in order — ALL must pass:
 *   1. Category match (technician.category === request.category)
 *   2. Service area/city match (normalized comparison)
 *   3. Account status = active
 *   4. Availability status = available
 *   5. Verified (Task 26): verification is a hard eligibility gate, not
 *      just a trust-score input — an unverified technician is never
 *      offered, no matter how available they are. Scoring, cascading,
 *      and the lifecycle are unchanged.
 *
 * The flow:
 *   1. Async: fetch technicians from the backend API (PostgreSQL)
 *   2. Transform: map API technicians to the frontend Technician shape
 *   3. Synchronous: apply eligibility filters (no I/O)
 *
 * Throws when the backend is unreachable — matching cannot run on stale data.
 */
export async function getEligibleTechnicians(
  request: ServiceRequest,
): Promise<EligibleTechnicianResult[]> {
  // Step 1: async data access — the full backend technician set.
  // (Radius filtering is a PostGIS query concern; eligibility here
  // stays the deterministic category/city/status ruleset.)
  const apiTechs = await fetchTechnicians();

  // Step 2: transform API data to the frontend shape (single mapping boundary)
  const technicians = mapApiTechniciansToFrontend(apiTechs);

  // Step 3: Synchronous eligibility filtering (no I/O)
  const normalizedRequestCity = normalizeCity(request.city);

  return technicians
    .filter((tech) => tech.category === request.category)
    .filter((tech) => normalizeCity(tech.serviceArea) === normalizedRequestCity)
    .filter((tech) => tech.accountStatus === 'active')
    .filter((tech) => tech.availabilityStatus === 'available')
    .filter((tech) => tech.verified)
    .map((tech) => ({
      technician: tech,
      matchedCategory: tech.category,
    }));
}

/**
 * Rank eligible technicians by dispatch score.
 *
 * Accepts ONLY already-filtered eligible technicians.
 * Does NOT perform eligibility filtering itself.
 * Does NOT call getEligibleTechnicians internally.
 * Does NOT modify the request.
 * Does NOT update request status.
 *
 * Pure scoring function — no I/O, no async.
 * Sorts descending by finalScore.
 * Tie-breaking: preserves original input order (stable).
 */
export function rankEligibleTechnicians(
  request: ServiceRequest,
  eligible: EligibleTechnicianResult[],
): RankedTechnician[] {
  return eligible
    .map((result, index) => ({
      technician: result.technician,
      matchedCategory: result.matchedCategory,
      score: computeScore(result.technician, request),
      originalIndex: index,
    }))
    .sort((a, b) => {
      if (b.score.finalScore !== a.score.finalScore) {
        return b.score.finalScore - a.score.finalScore;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map(({ technician, matchedCategory, score }) => ({
      technician,
      matchedCategory,
      score,
    }));
}
