/**
 * Task 32 regression checks: legal documents and footer plumbing.
 *
 * Content-level invariants (no I/O): the Terms module stays a draft, keeps
 * unique section ids, and never acquires positive legal/quality claims.
 * Route-level checks assert the new /terms route file exists beside the
 * established /privacy route (rendering itself is verified in the browser).
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMS_SECTIONS, TERMS_VERSION } from '../lib/legal/terms';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const fullText = TERMS_SECTIONS.map(
  (s) => `${s.heading} ${(s.paragraphs ?? []).join(' ')} ${(s.items ?? []).join(' ')}`,
).join('\n');

// Structure
assert(TERMS_SECTIONS.length >= 8, `at least 8 sections (got ${TERMS_SECTIONS.length})`);
assert(
  new Set(TERMS_SECTIONS.map((s) => s.id)).size === TERMS_SECTIONS.length,
  'section ids unique (TOC anchors)',
);
assert(
  TERMS_SECTIONS.every(
    (s) => s.heading.length > 0 && ((s.paragraphs?.length ?? 0) > 0 || (s.items?.length ?? 0) > 0),
  ),
  'every section has a heading and body',
);
assert(
  TERMS_VERSION.startsWith('Draft'),
  `version stamped as draft (got "${TERMS_VERSION.slice(0, 24)}…")`,
);

// Honesty markers: limits stated openly, review required
for (const marker of [
  'does not guarantee',
  'No payments are processed',
  'no dispute-resolution process',
  'no dedicated abuse-reporting channel',
  'has not been reviewed by a lawyer',
  'legal review',
]) {
  assert(fullText.includes(marker), `states openly: "${marker}"`);
}

// No positive legal/quality claims may creep in. Known-honest negations
// ("does not claim …", "there is no …") are stripped before scanning so
// the check targets positive claims, not their denial.
const negated = fullText
  .replace(/does not claim that the system complies with any law\.?/gi, '')
  .replace(/there is no escrow, no payment protection, and no dispute-resolution process\.?/gi, '');
for (const banned of [
  /\bguaranteed\b/i,
  /we guarantee/i,
  /complies with/i,
  /\bcertified\b/i,
  /bank-grade|military-grade/i,
  /payment protection/i,
  /escrow service/i,
]) {
  assert(!banned.test(negated), `no positive claim matching ${banned}`);
}

// Routes and footer wiring exist in source
assert(existsSync(join(root, 'app', 'terms', 'page.tsx')), '/terms route exists');
assert(existsSync(join(root, 'app', 'privacy', 'page.tsx')), '/privacy route exists');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
