import { CANONICAL_CATEGORIES } from "../types/api.js";

/**
 * Task 33 — server-side Gemini fault classification.
 *
 * A customer's fault description is sent to Google's Gemini API
 * (`models:generateContent`, JSON mode) and the model must answer with one
 * of the nine canonical categories. The category is validated against
 * CANONICAL_CATEGORIES before it leaves this module: an unsupported,
 * missing, or malformed answer is NEVER treated as a success.
 *
 * Privacy boundaries (hard rules, see task spec §6):
 *   - only the trimmed fault description is sent — no names, emails, phone
 *     numbers, addresses, credentials, database rows, or technician lists;
 *   - the API key and the description are never logged (only error codes and
 *     provider HTTP statuses reach the logs);
 *   - the key lives exclusively in `GEMINI_API_KEY` (backend env), never in
 *     `NEXT_PUBLIC_*`, responses, or source.
 *
 * Reliability: one attempt per call (no retry loops — quota is precious),
 * AbortController timeout, and typed failures the route maps to user-safe
 * 503 copy. The manual category select always remains the fallback.
 */

export type FaultCategory = (typeof CANONICAL_CATEGORIES)[number];

export interface FaultClassification {
  category: FaultCategory;
  /** One-line fault summary from the model (display aid only). */
  summary: string;
}

export type ClassificationFailureCode =
  | "not_configured"
  | "invalid_input"
  | "provider_timeout"
  | "rate_limited"
  | "provider_error"
  | "invalid_response";

export class ClassificationError extends Error {
  readonly code: ClassificationFailureCode;
  constructor(code: ClassificationFailureCode, message: string) {
    super(message);
    this.name = "ClassificationError";
    this.code = code;
  }
}

export const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
export const DESCRIPTION_MIN = 8;
export const DESCRIPTION_MAX = 2000;
export const SUMMARY_MAX = 200;
const DEFAULT_TIMEOUT_MS = 12_000;

function timeoutMs(): number {
  const configured = Number(process.env.GEMINI_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

function modelName(): string {
  const configured = process.env.GEMINI_MODEL?.trim();
  return configured ? configured : DEFAULT_GEMINI_MODEL;
}

function isFaultCategory(value: unknown): value is FaultCategory {
  return (
    typeof value === "string" &&
    (CANONICAL_CATEGORIES as readonly string[]).includes(value)
  );
}

const SYSTEM_INSTRUCTION = `You classify a customer's fault description for a home-services platform in Zambia. Reply with JSON only, exactly: {"category": "<one of the categories below>", "summary": "<one short sentence summarising the fault>"}.
Valid categories: ${CANONICAL_CATEGORIES.map((c) => `"${c}"`).join(", ")}.
Pick the single best match. Never invent another category. Keep the summary under 200 characters.`;

/** Injectable seams for deterministic tests (no real quota consumed). */
export interface ClassifierDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
}

export async function classifyFaultDescription(
  description: string,
  deps: ClassifierDeps = {},
): Promise<FaultClassification> {
  const text = typeof description === "string" ? description.trim() : "";
  if (text.length < DESCRIPTION_MIN || text.length > DESCRIPTION_MAX) {
    throw new ClassificationError(
      "invalid_input",
      `Description must be between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} characters.`,
    );
  }

  const apiKey =
    deps.apiKey !== undefined ? deps.apiKey : process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ClassificationError(
      "not_configured",
      "AI classification is not configured.",
    );
  }
  const model = deps.model ?? modelName();
  const limit = deps.timeoutMs ?? timeoutMs();
  const runFetch = deps.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  let response: Response;
  try {
    response = await runFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            response_mime_type: "application/json",
            response_schema: {
              type: "OBJECT",
              properties: {
                category: { type: "STRING" },
                summary: { type: "STRING" },
              },
              required: ["category", "summary"],
            },
          },
        }),
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ClassificationError(
        "provider_timeout",
        "AI classification timed out.",
      );
    }
    throw new ClassificationError(
      "provider_error",
      "AI classification is unavailable.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    throw new ClassificationError(
      "rate_limited",
      "AI classification quota is exhausted.",
    );
  }
  if (!response.ok) {
    // 400/401/403/404 (bad key, unknown model, safety refusal) and 5xx all
    // collapse to one user-safe failure — provider detail never propagates.
    throw new ClassificationError(
      "provider_error",
      "AI classification is unavailable.",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ClassificationError(
      "invalid_response",
      "AI classification returned bad data.",
    );
  }
  const parts = (
    payload as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  )?.candidates?.[0]?.content?.parts;
  const raw = Array.isArray(parts)
    ? parts
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .join("")
        .trim()
    : "";
  if (!raw) {
    throw new ClassificationError(
      "invalid_response",
      "AI classification returned no content.",
    );
  }
  // Tolerate code-fenced JSON; anything else must still parse.
  const fenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced);
  } catch {
    throw new ClassificationError(
      "invalid_response",
      "AI classification returned bad data.",
    );
  }
  const record = parsed as { category?: unknown; summary?: unknown };
  if (!isFaultCategory(record?.category)) {
    throw new ClassificationError(
      "invalid_response",
      "AI classification returned an unsupported category.",
    );
  }
  const summary =
    typeof record.summary === "string" && record.summary.trim()
      ? record.summary.trim().slice(0, SUMMARY_MAX)
      : "";
  return { category: record.category, summary };
}
