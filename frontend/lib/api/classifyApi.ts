import { isTechnicianCategory, type TechnicianCategory } from '@/lib/categories';
import { ApiError, post } from './client';

/**
 * AI fault-classification client (Task 33).
 *
 * Thin wrapper over POST /api/v1/classify-fault. The server owns the Gemini
 * call, the key, and response validation; this layer only enforces the
 * category contract a second time (defence in depth — an unexpected value
 * fails loudly instead of selecting a bogus category) and maps failures to
 * safe, user-facing copy. The manual category select always remains.
 */
export interface FaultSuggestion {
  category: TechnicianCategory;
  summary: string;
}

interface ClassifyDto {
  category: string;
  summary: string;
  source: string;
}

export async function classifyFault(description: string): Promise<FaultSuggestion> {
  const body = await post<{ data: ClassifyDto }>('/classify-fault', { description });
  if (!isTechnicianCategory(body.data.category)) {
    throw new Error('The server suggested a category this app does not recognise.');
  }
  return {
    category: body.data.category,
    summary: typeof body.data.summary === 'string' ? body.data.summary : '',
  };
}

/**
 * Safe message for a failed suggestion. Any failure — unconfigured key,
 * quota, timeout, malformed model output — ends at the same place: the
 * customer picks a category manually and nothing is blocked.
 */
export function classificationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* non-JSON body */
    }
    if (error.status === 401) return 'Your session has expired. Please sign in again.';
    if (error.status === 503)
      return 'AI classification is not available right now. Choose a category manually.';
  }
  if (error instanceof Error && error.message.startsWith('The server suggested')) {
    return 'AI classification returned something unexpected. Choose a category manually.';
  }
  return 'AI classification is not available right now. Choose a category manually.';
}
