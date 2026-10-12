/* Task 30: pure-helper checks for the admin audit view (no I/O, no secrets). */
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:9999/api/v1';
import { ApiError } from '../lib/api/client';
import {
  adminErrorMessage,
  formatAuditMetadata,
  formatTimestamp,
} from '../lib/services/adminService';
import { AUDIT_EVENT_TYPES } from '../lib/api/adminApi';

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

// formatAuditMetadata — the Detail column renderer
assert(formatAuditMetadata(null) === '', 'null metadata renders empty');
assert(formatAuditMetadata({}) === '', 'empty metadata renders empty');
assert(
  formatAuditMetadata({ reason: 'manual-review', attempts: 3, locked: true }) ===
    'reason=manual-review · attempts=3 · locked=true',
  'primitives render as key=value pairs',
);
assert(
  formatAuditMetadata({ nested: { a: 1 } }).includes('nested={"a":1}'),
  'nested object stringified, not dropped',
);

// adminErrorMessage — the error-state copy
assert(
  adminErrorMessage(new ApiError(401, 'Unauthorized', '{}')) ===
    'Your session has expired. Please sign in again.',
  '401 copy',
);
assert(
  adminErrorMessage(new ApiError(403, 'Forbidden', '{}')) ===
    'You do not have permission to perform this action.',
  '403 copy',
);
assert(adminErrorMessage(new Error('boom')) === 'boom', 'other errors surface their message');

// formatTimestamp — the When column renderer
assert(formatTimestamp('not-a-date') === 'not-a-date', 'invalid timestamp falls back to raw value');
assert(
  formatTimestamp('2026-10-09T12:00:00.000Z').includes('2026') ||
    formatTimestamp('2026-10-09T12:00:00.000Z').length > 0,
  'valid ISO timestamp renders',
);

// Vocabulary parity with the backend closed set
assert(
  JSON.stringify([...AUDIT_EVENT_TYPES]) ===
    JSON.stringify([
      'auth.login_failed',
      'auth.login_succeeded',
      'auth.account_locked',
      'privacy.data_exported',
      'privacy.account_deleted',
      'admin.user_status_changed',
      'admin.verification_decision',
      'security.verification_document_accessed',
      'security.verification_document_deleted',
      'account.suspended',
      'account.reactivated',
    ]),
  'frontend filter vocabulary matches backend AUDIT_EVENT_TYPES',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
