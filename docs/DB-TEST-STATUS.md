# Database testing — status 13 November 2026

## 1. Safety rails now in place

| Control | Where | Behaviour |
|---|---|---|
| Migration host guard | `backend/src/db/migrate.ts` | Refuses any host other than `localhost`, `127.0.0.1`, `::1` before the first statement. No environment variable disables it. |
| Seeder host guard | `backend/src/db/seed.ts` | Same refusal for `DATABASE_URL`; a hosted `MIGRATIONS_DATABASE_URL` in `.env` does not block a local seed. |
| Runner session check | `docs/run-db-tests.sh` | Terminates stray sessions, drops `WITH (FORCE)`, exports `DATABASE_URL`/`MIGRATIONS_DATABASE_URL` to migrations, seed, API and every script, 240 s timeout per script, kills the API process tree on exit. |

Verified: pointing the runner at `aws-0-eu-west-1.pooler.supabase.com` is refused; pointing it at
localhost applies migrations 001–012 normally.

## 2. Seed baseline

`npm run seed -w backend` (`backend/src/db/seed.ts`) inserts the nine canonical prototypes exported
as `SEED_TECHNICIANS` from `client.ts`, plus the administrator from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
The inserts are not duplicated: `seed.ts` calls `seedInitialTechnicians()` from `client.ts`, so the
seeder and the server-startup path create identical rows from one INSERT statement. Both functions
no-op when their rows exist, so re-running is safe and non-destructive; the password is never
printed. Result on a fresh database: 9 technicians (3 unverified), 1 administrator; re-run inserts 0.

## 3. The run

See **`docs/DB-TEST-RUN-2026-11-13.md`**. Headline: **839 assertions, 671 passed, 168 failed
(80.0 %)**; 19 of 31 scripts recorded no assertion, dominated by login rate limiting (13 × HTTP 429
in the API log cascading into 401s).

Fully green suites: `task23-migration-tests` (38), `task28-3a1-location-privacy-tests` (48).

## 4. Live database — what was and was not written

- **Migrations were applied to the live database at 2026-11-13 08:45:46–08:45:57 UTC**, because
  `backend/.env` sets `MIGRATIONS_DATABASE_URL` to the Supabase pooler and one invocation did not
  override it. The migrations are `CREATE … IF NOT EXISTS` with no `DROP TABLE`, `TRUNCATE` or
  `DELETE`, so re-application no-ops. Verified afterwards: 17 tables, 16 RLS policies, 65 indexes,
  PostGIS 3.3, data unchanged (6 users, 5 requests, 2 technicians).
- **No application data was created, changed or deleted.** Newest `users` row is 2026-11-10; every
  suite registers accounts on every run, so a test pass would have left newer rows; fixture-email
  residue is 0; `sessions` is empty.
- The 2026-11-12 14:27–14:38 UTC activity (request dispatched → accepted → started → completed, plus
  one cancelled request) is a human demo on Gmail accounts, not a test suite.
- This class of incident is now impossible for migrations and seeding: both refuse non-local hosts.

## 5. Outstanding harness work (not product defects)

1. Login rate limiting across a sequential sweep — 13 × 429 cascading into ~100 of the failures.
2. Stub TLS certificates for the two push-delivery suites.
3. `task352-*` helpers are Supabase-only.
4. Suites that expect a named fixture to win dispatch must account for nine seeded candidates.

## 6. Housekeeping

`umodzi_test` is left in its post-run state for inspection. The local postgres password is stored in
no file. No dev server or port 3001 listener remains.
