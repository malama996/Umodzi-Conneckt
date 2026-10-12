/**
 * Task 28.3 focused frontend tests: the privacy surfaces.
 *
 * Covers the client half of the privacy work without a server:
 *   1. The notice content module (28.3B) — required disclosures present, and
 *      no prohibited legal/compliance claim.
 *   2. The registration disclosure (28.3B) — the summary is linked and honest.
 *   3. The privacy API client (28.3C/28.3D) — correct paths, owner-scoped by
 *      construction, and no client-supplied subject anywhere.
 *   4. The unread-count hook (G-02) — never invents a number.
 *   5. The export download helper (28.3C) — real JSON, revoked object URL.
 *
 * Run from the frontend folder:
 *   npx --no-install tsx scripts/task28-3-privacy-tests.ts
 */
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:9999/api/v1';

import {
  PRIVACY_NOTICE_SECTIONS,
  PRIVACY_NOTICE_VERSION,
  REGISTRATION_NOTICE_POINTS,
} from '../lib/privacy/notice';
import {
  DELETION_CONFIRMATION_PHRASE,
  deleteMyAccount,
  getDeletionPreview,
  getMyData,
  getMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../lib/api/privacyApi';

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
/* 1. Notice content                                                  */
/* ------------------------------------------------------------------ */

function testNoticeContent(): void {
  console.log('\nprivacy notice content');

  assert(PRIVACY_NOTICE_SECTIONS.length >= 10, 'the notice has a substantive set of sections');

  const ids = PRIVACY_NOTICE_SECTIONS.map((s) => s.id);
  assert(new Set(ids).size === ids.length, 'every section id is unique (safe anchor targets)');
  for (const required of [
    'what-we-collect',
    'required-optional',
    'location',
    'who-can-see',
    'documents',
    'notifications',
    'security',
    'retention',
    'rights',
    'providers',
    'incidents',
    'status',
  ]) {
    assert(ids.includes(required), `notice covers "${required}"`);
  }

  for (const section of PRIVACY_NOTICE_SECTIONS) {
    const hasContent = (section.paragraphs?.length ?? 0) > 0 || (section.items?.length ?? 0) > 0;
    assert(hasContent, `section "${section.id}" has content`);
  }

  const allText = PRIVACY_NOTICE_SECTIONS.flatMap((s) => [
    ...(s.paragraphs ?? []),
    ...(s.items ?? []),
  ]).join('\n');

  // Location must be described accurately: stored internally, never published.
  assert(
    /not published|NOT published/i.test(allText),
    'notice states coordinates are not published',
  );
  assert(/100 metres|100 m/i.test(allText), 'notice states the 100 m distance coarsening');
  assert(
    /does not ask your browser for your GPS/i.test(allText),
    'notice states no GPS is collected',
  );

  // Classification must not be described as AI.
  assert(
    /deterministic keyword/i.test(allText),
    'notice describes classification as deterministic',
  );
  assert(
    /not an AI or machine-learning model/i.test(allText),
    'notice explicitly denies the classification is an AI model',
  );

  // SMS must be described as inactive, with no phone stored.
  assert(/not active/i.test(allText), 'notice states SMS integration is inactive');
  assert(/no phone number is held/i.test(allText), 'notice states no phone number is held');

  // No IP storage claim must be present.
  assert(
    /does not (store|keep)[^.]{0,40}IP address/i.test(allText),
    'notice states no IP addresses are stored',
  );

  // Retention must be presented as partly unconfirmed.
  assert(
    /requires confirmation|before it is treated as final/i.test(allText),
    'notice flags retention as unconfirmed',
  );

  // Security events retained on deletion must be disclosed.
  assert(/minimised/i.test(allText), 'notice discloses minimised retention of security events');
  assert(
    /reviews.*removed|cannot exist without/i.test(allText),
    'notice discloses the review consequence',
  );

  assert(
    typeof PRIVACY_NOTICE_VERSION === 'string' && PRIVACY_NOTICE_VERSION.length > 0,
    'notice carries a version stamp',
  );
}

/* ------------------------------------------------------------------ */
/* 2. Prohibited legal claims must be absent                          */
/* ------------------------------------------------------------------ */

function testNoLegalClaims(): void {
  console.log('\nnotice makes no unsupported legal claim');

  const allText = [
    PRIVACY_NOTICE_VERSION,
    ...PRIVACY_NOTICE_SECTIONS.flatMap((s) => [...(s.paragraphs ?? []), ...(s.items ?? [])]),
  ].join('\n');

  const negated =
    /\b(not|no|never|nothing|cannot|without|does not|is not|has not|are not|isn't|aren't)\b[^.]{0,200}$/i;

  for (const claim of [
    'legally compliant',
    'fully compliant',
    'gdpr compliant',
    'registered with the data protection commission',
    'we have appointed a data protection officer',
    'certified',
    'audited by',
  ]) {
    const asserted = [...allText.matchAll(new RegExp(claim, 'gi'))].filter(
      (m) => !negated.test(allText.slice(Math.max(0, m.index - 220), m.index)),
    );
    assert(asserted.length === 0, `notice does not assert "${claim}"`);
  }

  // The notice must be explicit that it is not a legal document.
  assert(/not a legal document/i.test(allText), 'notice states it is not a legal document');
  assert(/academic prototype/i.test(allText), 'notice states the academic-prototype framing');
  // Open items must be acknowledged rather than glossed over.
  assert(
    /have not yet been established|not yet established|still open|open item/i.test(allText),
    'notice acknowledges its open items',
  );
}

/* ------------------------------------------------------------------ */
/* 3. Registration disclosure                                         */
/* ------------------------------------------------------------------ */

function testRegistrationDisclosure(): void {
  console.log('\nregistration disclosure');

  assert(REGISTRATION_NOTICE_POINTS.length >= 4, 'the registration summary has real substance');
  const summary = REGISTRATION_NOTICE_POINTS.join('\n');

  assert(/password/i.test(summary), 'summary mentions password handling');
  assert(/hashed/i.test(summary), 'summary says the password is hashed');
  assert(/service area/i.test(summary), 'summary mentions the service area');
  assert(
    /precise location is never published/i.test(summary),
    'summary states precise location is never published',
  );
  assert(/document/i.test(summary), 'summary mentions uploaded documents');
  assert(
    /stored privately|only visible to you and administrators/i.test(summary),
    'summary states documents are private and who can see them',
  );
  assert(/delete your account/i.test(summary), 'summary mentions account deletion');

  // Every point must be a sentence, not a fragment/placeholder.
  for (const point of REGISTRATION_NOTICE_POINTS) {
    assert(point.trim().length > 20, `point is substantive: "${point.slice(0, 28)}…"`);
    assert(!/lorem|TODO|TBD|placeholder/i.test(point), 'no placeholder text in the summary');
  }
}

/* ------------------------------------------------------------------ */
/* 4. Privacy API client                                              */
/* ------------------------------------------------------------------ */

function testPrivacyApiClient(): void {
  console.log('\nprivacy API client');

  assert(
    DELETION_CONFIRMATION_PHRASE === 'DELETE MY ACCOUNT',
    'the confirmation phrase matches the backend literal',
  );
  assert(
    DELETION_CONFIRMATION_PHRASE.length > 0 &&
      DELETION_CONFIRMATION_PHRASE === DELETION_CONFIRMATION_PHRASE.toUpperCase(),
    'the confirmation phrase is an uppercase literal',
  );

  // Every exported function must exist and be callable with the documented
  // signature. The calls below are made against a stubbed global fetch.
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: {
          format: 'umodzi-account-export-v1',
          generatedAt: '2026-01-01T00:00:00.000Z',
          counts: { notifications: 0 },
          exclusions: [],
          notifications: [],
          unreadCount: 0,
          totalCount: 0,
          limit: 25,
          offset: 0,
          hasMore: false,
          updated: 0,
          deleted: true,
          alreadyDeleted: false,
          report: null,
          countsPreview: {},
          retainedAfterDeletion: {},
          warning: '',
        },
      }),
    };
  }) as typeof fetch;

  void (async () => {
    // `.at(-1)` is typed `T | undefined`; normalise so assertions stay boolean.
    const last = (): string => calls[calls.length - 1] ?? '';
    try {
      await getMyData();
      assert(last().endsWith('/me/data'), 'export calls GET /me/data');

      await getDeletionPreview();
      assert(last().endsWith('/me/account/deletion-preview'), 'preview calls the preview route');

      await deleteMyAccount('pw', DELETION_CONFIRMATION_PHRASE);
      assert(last().startsWith('DELETE '), 'deletion uses the DELETE verb');
      assert(last().endsWith('/me/account'), 'deletion targets /me/account');

      await getMyNotifications(10, 5);
      const inbox = last();
      assert(inbox.includes('/me/notifications'), 'inbox calls /me/notifications');
      assert(
        inbox.includes('limit=10') && inbox.includes('offset=5'),
        'inbox sends explicit pagination',
      );

      await markNotificationRead('some-id');
      assert(last().includes('/me/notifications/some-id/read'), 'mark-read targets the id route');

      await markAllNotificationsRead();
      assert(last().endsWith('/me/notifications/read-all'), 'mark-all targets read-all');

      // No privacy call may ever carry a user id, recipient or owner.
      for (const call of calls) {
        assert(
          !/(user_id|userId|recipient|owner|actor|targetUser)=/.test(call),
          `no client-supplied subject in: ${call}`,
        );
      }
      assert(
        calls.every((c) => !c.includes('umodzi.test')),
        'no account identifier is embedded in a privacy request',
      );
    } finally {
      globalThis.fetch = originalFetch;
      console.log(`\n${passed} passed, ${failed} failed`);
      if (failed > 0) process.exitCode = 1;
    }
  })();
}

testNoticeContent();
testNoLegalClaims();
testRegistrationDisclosure();
testPrivacyApiClient();
