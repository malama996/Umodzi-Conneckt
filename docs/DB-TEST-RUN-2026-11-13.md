# Database test run — 13 November 2026 (seeded, single sequential pass)

**Executed once, sequentially, on a database created, migrated and seeded by the runner.**
Numbers below are summed from `docs/test-results.csv`; per-script output is in `docs/test-logs/`.

## What changed since the pre-seed run

| Fix | Effect |
|---|---|
| Migration runner refuses any non-loopback host | `aws-0-eu-west-1.pooler.supabase.com` is now rejected before a single statement runs (no override switch) |
| `npm run seed` → nine technician prototypes + administrator | baseline now exists, so the "9 seed prototypes" / "seeded administrator" assertions can pass |
| `task331`–`task334` choose SSL only for non-local hosts | the four suites connect to local PostgreSQL instead of crashing |
| Runner seeds between migrate and test | every suite starts from the same baseline |

Verified during this run: guard refuses `aws-0-…pooler.supabase.com`; guard allows localhost;
migrations applied 001–012; seed inserted 9 prototypes + 1 administrator (3 unverified:
Mulenga P., Mumba J., Nkonde R.) and was idempotent on re-run; schema 20 tables / 16 policies /
accepted-offer index; PostGIS 3.7.

## Results

| Test category | Conducted | Passed | Failed |
|---|---|---|---|
| Authentication and sessions | 132 | 122 | 10 |
| Profiles and administration | 51 | 24 | 27 |
| Verification | 86 | 75 | 11 |
| Service requests and dispatch | 48 | 48 | 0 |
| Notifications and push | 206 | 177 | 29 |
| Communication (chat and realtime) | 95 | 42 | 53 |
| Schema and migrations | 38 | 38 | 0 |
| Security (row-level access control) | 0 | 0 | 0 |
| **Functional subtotal** | **656** | **526** | **130** |
| Documentation-verification script | 183 | 145 | 38 |
| **Whole run** | **839** | **671** | **168** |

Pass rate over executed assertions: **671 / 839 = 80.0 %**.

Fully green: `task23-migration-tests` (38/0), `task28-3a1-location-privacy-tests` (48/0).
`task28-3a1` was 47/1 before seeding; the single failure was the baseline-data drift it warned
about, and seeding removed it.

## Why 19 scripts still record no assertion, and why 168 fail

1. **Login rate limiting (dominant).** Every suite authenticates repeatedly through one shared
   limiter. The API log records 13 hard `429 Rate limit exceeded` rejections; each one leaves the
   suite without a token, and every dependent assertion then fails `401`. This is why
   `task25`, `task26`, `task27`, `task28-offer-*`, `task28-request-status`,
   `task28-verification` and much of `task331`–`task334` fail — several report
   `suite issued exactly 4 logins (saw 1)` before crashing in `sessionFrom`.
2. **Stub TLS certificates.** `task28-push-delivery-tests` and `task28-push-e2e-tests` need
   certificates in `%TEMP%` that this machine does not have.
3. **Hosted-only helpers.** `task352-create-runtime-role` (`Cannot derive project ref`),
   `task352-grant-extensions-usage` (no `extensions` schema) and `task352-switch-connection`
   (`APP_DATABASE_URL missing`) cannot run outside Supabase.
4. **Seeded prototypes now compete in dispatch.** Assertions that expect a specific fixture to win
   dispatch ("another eligible tech won") must account for nine seeded verifiable candidates.

Not changed here: the rate limits themselves, which are product security behaviour and were not in
scope. Relaxing them for tests, or serialising suites with a pause between them, is the next step
if a clean functional pass rate is required.

## Chapter Five

Table 5.x (functional results) now carries the eight category rows above, and §5.1.1 states the
whole-run totals (839 / 671 / 168, 80.0 %), the 656-assertion table scope, the 183-assertion
documentation suite, and 19 scripts that recorded no assertion.
