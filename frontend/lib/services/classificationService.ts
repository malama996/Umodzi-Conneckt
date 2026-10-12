import { classifyFaultWithEvidence } from '@/lib/classification';
import type { ClassificationResult } from '@/lib/types';

/**
 * Mock classification service (V0.2).
 *
 * Simulates the future classification API boundary without calling a backend.
 * Calls the existing keyword classifier and adapts its result into the typed
 * service response. Latency is a clearly documented deterministic simulated
 * value, not a real measurement. No external AI service is called.
 *
 * Confidence is a deterministic keyword-evidence heuristic, NOT AI confidence,
 * model confidence, or probability. See lib/classification.ts for the formula.
 */

// Deterministic simulated API latency for the future real endpoint.
const MOCK_API_LATENCY_MS = 150;

export async function classifyFaultViaService(description: string): Promise<ClassificationResult> {
  // Simulate network latency for the future API boundary.
  await new Promise((resolve) => setTimeout(resolve, MOCK_API_LATENCY_MS));

  const evidence = classifyFaultWithEvidence(description);

  return {
    category: evidence.category,
    method: 'keyword',
    latencyMs: MOCK_API_LATENCY_MS,
    confidence: evidence.confidence,
    matchedKeywords: evidence.matchedKeywords,
    alternatives: evidence.alternatives,
  };
}
