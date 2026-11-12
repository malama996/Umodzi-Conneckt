# DATABASE SETUP — LOCAL SCRATCH DATABASE FOR TESTING

Prepared 2026-11-12. This is the last blocker: 31 test scripts and Chapter Five's
measurements need a disposable PostgreSQL database.

---

## 0. What is already on this machine (checked, not assumed)

| Item | Finding |
|---|---|
| PostgreSQL server | **18**, installed at `C:\Program Files\PostgreSQL\18` |
| Service | `postgresql-x64-18` — **Running** |
| Port 5432 | **open** (connection succeeds) |
| **PostGIS** | **Installed — version 3.6.2** |
| `postgis-3.dll` | present in `C:\Program Files\PostgreSQL\18\lib` |
| `postgis.control` | present in `...\share\extension` |
| `psql.exe` | present at `C:\Program Files\PostgreSQL\18\bin\psql.exe` — **not on PATH** |

### On "PostGIS is missing"

It is not missing. PostGIS 3.6.2 ships with this PostgreSQL 18 installation. What
is missing is the **extension inside a database** — PostGIS is enabled per
database, not globally. Seeing no geometry types in a database you just created
is expected until you run `CREATE EXTENSION postgis;` in that database.

You do not even need to run it by hand: migration `001_initial_schema.sql` line 11
already contains `CREATE EXTENSION IF NOT EXISTS postgis;`. The migration must run
as a superuser (`postgres`), because creating an extension requires that right.

If pgAdmin shows no PostGIS in the *Extensions* node, that node lists what is
installed **in the currently selected database**, not on the server.

---

## 1. Create the scratch database

**pgAdmin route:** right-click *Databases* → *Create* → *Database…* →

- Database: `umodzi_test`
- Owner: `postgres`
- Save

**Command route** (PowerShell, full path because `psql` is not on PATH):

```powershell
$env:PGPASSWORD = "<your postgres password>"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost -p 5432 `
  -c "CREATE DATABASE umodzi_test;"
```

Keep the password out of shell history where possible; pgAdmin's saved connection
is safer.

---

## 2. Point the migration runner at it

The backend reads two connection strings and they have different jobs:

| Variable | Role it must use | Purpose |
|---|---|---|
| `MIGRATIONS_DATABASE_URL` | superuser (`postgres`) | creates the extension, the `umodzi_app` role and RLS policies |
| `DATABASE_URL` | restricted runtime role | the application and the test scripts |

Create a local env file used **only for the scratch database** — do not edit the
live `backend/.env`, which currently points at Supabase:

```powershell
@"
MIGRATIONS_DATABASE_URL=postgresql://postgres:<password>@localhost:5432/umodzi_test
DATABASE_URL=postgresql://postgres:<password>@localhost:5432/umodzi_test
JWT_SECRET=<any 32+ character random string>
FRONTEND_ORIGIN=http://localhost:3000
NODE_ENV=development
"@ | Out-File -Encoding utf8 backend\.env.test
```

Using `postgres` for both is acceptable **for a throwaway database**. It does mean
row-level security is not exercised by privilege; the RLS policies still exist and
`task351-rls-audit.ts` inspects them directly. For a faithful test of the
restricted path, after the migrations run as superuser:

```sql
CREATE ROLE umodzi_dev LOGIN PASSWORD 'choose-one' IN ROLE umodzi_app;
```

then set `DATABASE_URL` to connect as `umodzi_dev`. Role membership is what lets
the restricted role reach the policies scoped `TO umodzi_app`.

---

## 3. Run the twelve migrations

```powershell
$env:MIGRATIONS_DATABASE_URL = "postgresql://postgres:<password>@localhost:5432/umodzi_test"
npm run migrate -w backend
```

Expected: migrations `001` … `012` apply in order. `001` creates PostGIS; `010`
creates the `umodzi_app` role and the RLS policies; `012` adds the dispatch
integrity constraints, including the unique index that permits exactly one
accepted offer per request.

**Verify** (pgAdmin Query Tool on `umodzi_test`):

```sql
SELECT postgis_version();                                   -- must return 3.6.x
SELECT count(*) FROM information_schema.tables
 WHERE table_schema = 'public';                             -- expect 16 tables
SELECT count(*) FROM pg_indexes
 WHERE indexname LIKE '%accepted%';                         -- the unique offer guard
SELECT count(*) FROM pg_policies;                           -- RLS policies
```

If `postgis_version()` errors, the extension was not created — confirm the
migration ran as `postgres`, not as a limited role.

---

## 4. Run the remaining test scripts

31 test scripts still need a database. Start the API against the scratch DB in one
terminal, then run the scripts in the other:

```powershell
# terminal 1 — copy .env.test over the values the app reads, or export them
$env:DATABASE_URL = "postgresql://postgres:<password>@localhost:5432/umodzi_test"
npm run dev -w backend

# terminal 2
cd backend
npx --no-install tsx scripts/task23-api-tests.ts
```

Record for each script: name, passed, failed, skipped, exit status. The scripts
already exit non-zero on failure, so a loop can capture everything:

```powershell
$results = @()
Get-ChildItem scripts\*.ts | ForEach-Object {
  $out = npx --no-install tsx $_.FullName 2>&1
  $code = $LASTEXITCODE
  $line = ($out | Select-String -Pattern '^\d+ passed' | Select-Object -Last 1).Line
  $results += [pscustomobject]@{ Script = $_.Name; Result = $line; Exit = $code }
}
$results | Format-Table -AutoSize
$results | Export-Csv ..\docs\test-results.csv -NoTypeInformation
```

Order matters for the end-to-end suites: a few scripts create their own accounts
and requests, but `task351-rls-audit.ts` and `task352-final-integrity-check.ts`
inspect the schema and should run last.

### Already executed — do not re-run as unknown

Thirteen scripts need no database and have passed: ten in `frontend/scripts`
(369 assertions) and `storage-tests.ts`, `task23-tests.ts`, `task33-classify-tests.ts`
in `backend/scripts` (115 assertions). Total 484 assertions, 0 failures, 2026-11-12.

`backend/scripts/task352-retire-service-key.ts` is **not a test** — it edits
`backend/.env` to comment out an unused key. Do not run it against the scratch setup.

---

## 5. Then fill Chapter Five

With results captured, the nine evaluation tables can be completed from real
numbers, and §5.1.1 (already written) tells the examiner exactly which method
produced each one. If a suite cannot run (for example the AI metrics, which need a
Gemini key and a labelled corpus), leave the table blank and say so — that is what
the section already documents.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `extension "postgis" is not available` | migration ran as a non-superuser, or `search_path`/`shared_preload` issue | reconnect as `postgres` |
| `permission denied to create extension` | not superuser | use `MIGRATIONS_DATABASE_URL` with `postgres` |
| `role "umodzi_app" does not exist` | migration 010 skipped role creation because the user lacked `CREATEROLE` | run as `postgres`, then re-run `010` |
| `password authentication failed` | URL escaping | percent-encode special characters in the password |
| Scripts hang on connection | API not started | start `npm run dev -w backend` first |
| `relation "postgis_full_version" ...` no results | extension installed in a different schema | `CREATE EXTENSION postgis SCHEMA public;` |

---

## 7. What this unblocks

| Deliverable | Becomes possible |
|---|---|
| 31 remaining test scripts | real pass/fail evidence |
| Chapter Five's nine tables | measured functional, dispatch, usability, security results |
| Deck slide 12 | a Findings table with real figures instead of "not yet measured" |
| Screenshots | the app can finally run end to end |
| PDF exports | the report can be opened and checked in Word |
