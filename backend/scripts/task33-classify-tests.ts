/**
 * Task 33 backend tests: Gemini fault classifier with a MOCKED provider.
 *
 * Run from the backend folder:
 *   npx --no-install tsx scripts/task33-classify-tests.ts
 *
 * No network, no API key, no quota: every case injects `fetchImpl`.
 * The live route (auth, validation, safe messages) is verified separately
 * against the running backend, which has no key configured — so live
 * coverage is the unavailable/fallback path by design.
 */
import { CANONICAL_CATEGORIES } from "../src/types/api.js";
import {
  ClassificationError,
  classifyFaultDescription,
  DEFAULT_GEMINI_MODEL,
} from "../src/ai/faultClassifier.js";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

async function expectCode(
  name: string,
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
    failed += 1;
    console.log(`  FAIL ${name} (no error thrown)`);
  } catch (error) {
    if (error instanceof ClassificationError && error.code === code) {
      passed += 1;
      console.log(`  ok   ${name}`);
    } else {
      failed += 1;
      const got =
        error instanceof ClassificationError ? error.code : String(error);
      console.log(`  FAIL ${name} (got ${got}, want ${code})`);
    }
  }
}

function mockFetch(payload: unknown, status = 200) {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function geminiOk(category: string, summary = "A short summary.") {
  return mockFetch({
    candidates: [
      { content: { parts: [{ text: JSON.stringify({ category, summary }) }] } },
    ],
  });
}

const DESC = "Kitchen sink cold tap drips constantly since Tuesday.";
const KEY = { apiKey: "test-key-never-a-real-secret" };

async function main(): Promise<void> {
  // 1. Every canonical category validates.
  for (const category of CANONICAL_CATEGORIES) {
    const result = await classifyFaultDescription(DESC, {
      ...KEY,
      fetchImpl: geminiOk(category),
    });
    assert(
      result.category === category,
      `canonical category accepted: ${category}`,
    );
  }

  // 2. Unsupported category rejected.
  await expectCode(
    "unsupported category → invalid_response",
    () =>
      classifyFaultDescription(DESC, {
        ...KEY,
        fetchImpl: geminiOk("Plumbng"),
      }),
    "invalid_response",
  );

  // 3. Malformed / empty provider responses.
  await expectCode(
    "non-JSON text → invalid_response",
    () =>
      classifyFaultDescription(DESC, {
        ...KEY,
        fetchImpl: mockFetch({
          candidates: [{ content: { parts: [{ text: "just words" }] } }],
        }),
      }),
    "invalid_response",
  );
  await expectCode(
    "empty candidates → invalid_response",
    () =>
      classifyFaultDescription(DESC, {
        ...KEY,
        fetchImpl: mockFetch({ candidates: [] }),
      }),
    "invalid_response",
  );
  await expectCode(
    "missing category field → invalid_response",
    () =>
      classifyFaultDescription(DESC, {
        ...KEY,
        fetchImpl: mockFetch({
          candidates: [
            {
              content: { parts: [{ text: JSON.stringify({ summary: "x" }) }] },
            },
          ],
        }),
      }),
    "invalid_response",
  );
  const fenced = await classifyFaultDescription(DESC, {
    ...KEY,
    fetchImpl: mockFetch({
      candidates: [
        {
          content: {
            parts: [
              {
                text:
                  "```json\n" +
                  JSON.stringify({ category: "ICT", summary: "Ok." }) +
                  "\n```",
              },
            ],
          },
        },
      ],
    }),
  });
  assert(fenced.category === "ICT", "code-fenced JSON tolerated");

  // 4. Missing key.
  await expectCode(
    "missing key → not_configured",
    () =>
      classifyFaultDescription(DESC, {
        apiKey: "",
        fetchImpl: geminiOk("Plumbing"),
      }),
    "not_configured",
  );

  // 5. Timeout.
  const hanging: typeof fetch = ((
    _url: unknown,
    init?: { signal?: AbortSignal },
  ) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    })) as unknown as typeof fetch;
  await expectCode(
    "hung provider → provider_timeout",
    () =>
      classifyFaultDescription(DESC, {
        ...KEY,
        fetchImpl: hanging,
        timeoutMs: 30,
      }),
    "provider_timeout",
  );

  // 6. Provider statuses.
  await expectCode(
    "429 → rate_limited",
    () =>
      classifyFaultDescription(DESC, {
        ...KEY,
        fetchImpl: mockFetch({ error: "quota" }, 429),
      }),
    "rate_limited",
  );
  await expectCode(
    "500 → provider_error",
    () =>
      classifyFaultDescription(DESC, {
        ...KEY,
        fetchImpl: mockFetch({ error: "x" }, 500),
      }),
    "provider_error",
  );
  await expectCode(
    "403 → provider_error (no detail leaked)",
    () =>
      classifyFaultDescription(DESC, {
        ...KEY,
        fetchImpl: mockFetch({ error: "key invalid" }, 403),
      }),
    "provider_error",
  );
  await expectCode(
    "network throw → provider_error",
    () =>
      classifyFaultDescription(DESC, {
        ...KEY,
        fetchImpl: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      }),
    "provider_error",
  );

  // 7. Input bounds (mirror the request schema).
  await expectCode(
    "empty description → invalid_input",
    () =>
      classifyFaultDescription("   ", {
        ...KEY,
        fetchImpl: geminiOk("Plumbing"),
      }),
    "invalid_input",
  );
  await expectCode(
    "7-char description → invalid_input",
    () =>
      classifyFaultDescription("Leaky!", {
        ...KEY,
        fetchImpl: geminiOk("Plumbing"),
      }),
    "invalid_input",
  );
  await expectCode(
    "2001-char description → invalid_input",
    () =>
      classifyFaultDescription("x".repeat(2001), {
        ...KEY,
        fetchImpl: geminiOk("Plumbing"),
      }),
    "invalid_input",
  );

  // 8. Summary truncation (display aid, never a failure).
  const long = await classifyFaultDescription(DESC, {
    ...KEY,
    fetchImpl: geminiOk("Handyman", "s".repeat(500)),
  });
  assert(
    long.summary.length === 200,
    `summary truncated to 200 (got ${long.summary.length})`,
  );

  // 9. Request hygiene: only the description goes out.
  let seenUrl = "";
  let seenBody = "";
  const spy: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    category: "Electrical",
                    summary: "S.",
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  await classifyFaultDescription(DESC, { ...KEY, fetchImpl: spy });
  assert(
    seenUrl.startsWith(
      "https://generativelanguage.googleapis.com/v1beta/models/",
    ) && seenUrl.includes(":generateContent"),
    "official generateContent endpoint",
  );
  assert(
    seenUrl.includes(DEFAULT_GEMINI_MODEL),
    `default model ${DEFAULT_GEMINI_MODEL}`,
  );
  const parsedBody = JSON.parse(seenBody) as {
    contents?: { parts?: { text?: string }[] }[];
    systemInstruction?: unknown;
    generationConfig?: {
      response_mime_type?: string;
      response_schema?: unknown;
    };
  };
  const sentTexts = (parsedBody.contents ?? []).flatMap((c) =>
    (c.parts ?? []).map((p) => p.text ?? ""),
  );
  assert(
    sentTexts.length === 1 && sentTexts[0] === DESC,
    "exactly one user text: the description",
  );
  assert(
    !seenBody.includes("@") && !seenBody.includes("password"),
    "no identity material in body",
  );
  assert(
    parsedBody.generationConfig?.response_mime_type === "application/json" &&
      parsedBody.generationConfig?.response_schema !== undefined,
    "JSON mode with response schema requested",
  );

  // 10. Model override respected.
  let overrideUrl = "";
  const spy2: typeof fetch = (async (url: unknown) => {
    overrideUrl = String(url);
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: JSON.stringify({ category: "HVAC", summary: "S." }) },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  await classifyFaultDescription(DESC, {
    ...KEY,
    fetchImpl: spy2,
    model: "gemini-2.0-flash",
  });
  assert(
    overrideUrl.includes("models/gemini-2.0-flash:"),
    "model override used in URL",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
