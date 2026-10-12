/**
 * Task 27 focused frontend tests: review star labels, client-side review
 * validation, failure messaging, and the reviews API boundary (same
 * code paths the UI uses, with a stubbed global fetch).
 *
 * Run from the frontend folder:
 *   npx --no-install tsx scripts/task27-tests.ts
 *
 * Server-side eligibility (completion, ownership, duplicates, rating
 * bounds) is enforced — and tested — by scripts/task27-api-tests.ts.
 * The browser suite exercises the form/summary/empty-state rendering.
 */
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:9999/api/v1';

import { ApiError } from '../lib/api/client';
import {
  getTechnicianReviews,
  getRequestReview,
  getRequestReviewOrNull,
  postReview,
} from '../lib/api/reviewsApi';
import {
  RATING_LABELS,
  ratingLabel,
  reviewErrorMessage,
  validateReviewInput,
} from '../lib/services/reviewService';

/* ------------------------------------------------------------------ */
/* Tiny assertion harness                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

/* ------------------------------------------------------------------ */
/* Fetch stub                                                          */
/* ------------------------------------------------------------------ */

interface StubCall {
  url: string;
  method: string;
  body: string | null;
}

let lastCall: StubCall | null = null;

function stubFetch(status: number, payload: unknown): void {
  lastCall = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    lastCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

/* ------------------------------------------------------------------ */
/* 1. Star selector labels (§5, §17)                                   */
/* ------------------------------------------------------------------ */

function testLabels(): void {
  console.log('\nrating labels + star selector semantics');
  assert(RATING_LABELS.length === 6, 'labels indexed 0..5 (6 slots)');
  assert(RATING_LABELS[0] === '', 'index 0 has no label (unselected)');
  assert(ratingLabel(1) === 'Very poor', '1 → Very poor');
  assert(ratingLabel(2) === 'Poor', '2 → Poor');
  assert(ratingLabel(3) === 'Average', '3 → Average');
  assert(ratingLabel(4) === 'Good', '4 → Good');
  assert(ratingLabel(5) === 'Excellent', '5 → Excellent');
  assert(ratingLabel(6) === '' && ratingLabel(0) === '', 'out-of-range rating has no label');
}

/* ------------------------------------------------------------------ */
/* 2. Review form validation (client mirror; server is authoritative)  */
/* ------------------------------------------------------------------ */

function testValidation(): void {
  console.log('\nclient-side review validation');
  assert(validateReviewInput(5, '') === '', 'rating 5 with no comment is valid');
  assert(
    validateReviewInput(1, 'The technician arrived on time and fixed the fault quickly.') === '',
    'boundary rating 1 with a real comment is valid',
  );
  assert(
    validateReviewInput(5, '   Great work, very professional and fast.   ') === '',
    'comment is trimmed before validation',
  );
  assert(validateReviewInput(0, '') !== '', 'rating 0 rejected');
  assert(validateReviewInput(6, '') !== '', 'rating 6 rejected');
  assert(validateReviewInput(-1, '') !== '', 'negative rating rejected');
  assert(validateReviewInput(4.5, '') !== '', 'decimal rating rejected (whole stars only)');
  assert(validateReviewInput(3, 'nice') !== '', 'comment under 8 characters rejected');
  assert(validateReviewInput(3, 'x'.repeat(1001)) !== '', 'comment over 1000 characters rejected');
  assert(
    validateReviewInput(5, '        ') === '',
    'whitespace-only comment treated as absent (form submits rating-only)',
  );
}

/* ------------------------------------------------------------------ */
/* 3. Failure messaging (§24)                                          */
/* ------------------------------------------------------------------ */

function testErrorMessages(): void {
  console.log('\nfailure messaging');
  assert(
    reviewErrorMessage(new ApiError(401, 'Unauthorized', '{}')).includes('session has expired'),
    '401 → session-expired message',
  );
  assert(
    reviewErrorMessage(new ApiError(403, 'Forbidden', '{}')).includes('permission'),
    '403 → permission message',
  );
  assert(
    reviewErrorMessage(
      new ApiError(409, 'Conflict', '{"error":"This service has already been reviewed"}'),
    ) === 'This service has already been reviewed',
    '409 surfaces the backend conflict reason verbatim',
  );
  assert(
    reviewErrorMessage(new Error('network down')) === 'network down',
    'plain errors pass their message through',
  );
  assert(
    reviewErrorMessage(null).includes('server'),
    'unknown failures fall back to a generic message',
  );
}

/* ------------------------------------------------------------------ */
/* 4. API boundary round-trips                                         */
/* ------------------------------------------------------------------ */

async function testApiBoundary(): Promise<void> {
  console.log('\nreviews API boundary');

  stubFetch(201, {
    data: {
      id: 'rev-1',
      rating: 5,
      comment: 'Excellent and punctual service.',
      customerName: 'Chipo T.',
      createdAt: '2026-10-01T10:00:00Z',
    },
  });
  const created = await postReview('req-1', {
    rating: 5,
    comment: 'Excellent and punctual service.',
  });
  assert(
    created.rating === 5 && created.customerName === 'Chipo T.',
    'postReview returns the review',
  );
  assert(
    lastCall?.method === 'POST' && lastCall.url.includes('/requests/req-1/review'),
    'POST targets /requests/:id/review',
  );
  const sent = JSON.parse(lastCall?.body ?? '{}') as Record<string, unknown>;
  assert(
    sent.rating === 5 && typeof sent.comment === 'string',
    'payload carries rating + comment only',
  );
  assert(
    !('customerId' in sent) && !('technicianId' in sent),
    'no identity fields are ever sent from the client',
  );

  stubFetch(409, { error: 'This service has already been reviewed' });
  let conflict: unknown = null;
  try {
    await postReview('req-1', { rating: 4 });
  } catch (error) {
    conflict = error;
  }
  assert(
    conflict instanceof ApiError && conflict.status === 409,
    'duplicate submission surfaces as ApiError 409',
  );

  stubFetch(200, {
    data: { review: null, eligible: true, technicianName: 'Aaron Sakala' },
  });
  const state = await getRequestReview('req-1');
  assert(
    state.eligible === true && state.review === null && state.technicianName === 'Aaron Sakala',
    'request review state decodes the eligibility envelope',
  );

  stubFetch(404, { error: 'Service request not found' });
  const missing = await getRequestReviewOrNull('req-1');
  assert(missing === null, '404 on the request review maps to null');

  stubFetch(200, {
    data: {
      technicianId: 'tech-1',
      summary: { average: 4.5, count: 2, distribution: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 1 } },
      reviews: [
        {
          id: 'r2',
          rating: 5,
          comment: null,
          customerName: 'Mwansa K.',
          createdAt: '2026-10-02T09:00:00Z',
        },
        {
          id: 'r1',
          rating: 4,
          comment: 'Good work.',
          customerName: 'Chipo T.',
          createdAt: '2026-10-01T09:00:00Z',
        },
      ],
    },
  });
  const bundle = await getTechnicianReviews('tech-1');
  assert(
    bundle.summary.count === 2 && bundle.summary.average === 4.5,
    'summary decodes average + count',
  );
  assert(
    bundle.summary.distribution['4'] === 1 && bundle.summary.distribution['1'] === 0,
    'distribution keeps all five star keys',
  );
  assert(
    bundle.reviews.length === 2 && bundle.reviews[0].customerName === 'Mwansa K.',
    'review list decodes with public-safe names',
  );
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  testLabels();
  testValidation();
  testErrorMessages();
  await testApiBoundary();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main();
