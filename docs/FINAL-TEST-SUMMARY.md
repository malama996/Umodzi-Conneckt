# FINAL TEST SUMMARY — as executed on 2026-11-12

Every result below comes from a command run in this session. Nothing is
estimated, projected or copied from documentation.

## 1. Executed suite results

### 1.1 Frontend scripts — 10 of 10 executed, all green

Run from `frontend/` with `npx --no-install tsx scripts/<name>.ts`. These use a
stubbed `fetch` and pure helpers, so they need **no database**.

| Script | Passed | Failed | Exit | Notes |
|---|---|---|---|---|
| `task22-tests.ts` | 82 | 0 | 0 | notification behaviours, polling read-only |
| `task26-tests.ts` | 26 | 0 | 0 | dispatch ranking helpers |
| `task27-tests.ts` | 33 | 0 | 0 | review decoding |
| `task28-3-privacy-tests.ts` | 84 | 0 | 0 | privacy notice honesty markers |
| `task28-3a1-location-privacy-tests.ts` | 19 | 0 | 0 | service-area fallback |
| `task28-push-tests.ts` | 53 | 0 | 0 | Web Push client branches |
| `task29-refresh-tests.ts` | 38 | 0 | 0 | token refresh/rotation |
| `task30-audit-helper-checks.ts` | 10 | 0 | 0 | audit view helpers + vocabulary parity |
| `task31-request-validation-checks.ts` | 5 | 0 | 0 | request input validation |
| `task32-legal-checks.ts` | 19 | 0 | 0 | terms structure and honesty markers |
| **Total** | **369** | **0** | — | — |

### 1.2 Backend scripts — 3 executed (no database required), all green

| Script | Passed | Failed | Exit | Notes |
|---|---|---|---|---|
| `storage-tests.ts` | 25 | 0 | 0 | file-key validation, no request on reject |
| `task23-tests.ts` | 60 | 0 | 0 | 9 canonical categories, frontend parity |
| `task33-classify-tests.ts` | 30 | 0 | 0 | Gemini classifier with a mocked provider |
| **Total** | **115** | **0** | — | — |

### 1.3 Combined

| Measure | Value |
|---|---|
| Scripts executed | **13 of 45** (10 frontend, 3 backend) |
| Assertions executed | **484** |
| Passed | **484** |
| Failed | **0** |
| Skipped | 0 (scripts do not skip; the other 32 were not run at all) |
| Date | 2026-11-12 |

## 2. Defects found and fixed while executing

1. **Realtime chat handshake** (critical). The server never echoed the offered
   `bearer-…` WebSocket subprotocol, which RFC 6455 requires, so every browser
   connection failed while the Node test client tolerated it. Fixed with
   `handleProtocols`; detail in `CHAT-REALTIME-FIX.md`.
2. **Stale test fixture** (medium). `task30` asserted an 11-entry audit
   vocabulary against a 15-entry implementation. The product code was correct
   and identical to the backend; the expectation had not followed three added
   event types. Fixture updated, test now passes honestly.
3. **Legal version stamps** (low, visible). `TERMS_VERSION` read
   `(academic prototype)` despite the page, meta description and checks all
   describing the terms as a draft; `PRIVACY_NOTICE_VERSION` additionally began
   with a space, rendering as a stray gap on `/privacy`. Both now read
   `Draft — academic prototype`.

## 3. Build and static checks — re-run after those fixes

| Check | Command | Result |
|---|---|---|
| Backend type check | `cd backend && npx tsc --noEmit` | **PASS** (exit 0) |
| Frontend type check | `npm run typecheck -w frontend` | **PASS** (exit 0) |
| Frontend lint | `cd frontend && npx next lint` | **PASS** — "No ESLint warnings or errors" |
| Frontend production build | `npx -y node@22 node_modules/next/dist/bin/next build frontend` | **PASS** (exit 0) — 26 routes, 23 static pages |
| Report package integrity | zip entries + XML parse | **PASS** — 32 entries, 997 paragraphs, 20 tables, 11 images |
| Presentation integrity | slide inventory + `normAutofit` scan | **PASS** — 14 slides |
| Defence documents | OOXML parse + word count | **PASS** — 4 documents |

### Build environment note

The frontend production build passes **only on Node 22** (`.nvmrc`). On this
machine's default Node 25.8.0 it fails with
`ENOENT ... .next/server/pages-manifest.json`.

### Minor defect, not fixed

`next build` reports `ESLint: Could not find config file` because
`eslint.config.mjs` lives in `frontend/` while the build runs from the repo
root. Lint passes when invoked directly; it is simply skipped inside the build.

## 4. NOT executed — and why

| Check | Blocker |
|---|---|
| 32 remaining backend scripts | require a live API **and** PostgreSQL/PostGIS |
| Functional pass rate across all 45 | same |
| AI accuracy / precision / recall / F1 | needs a labelled dataset **and** `GEMINI_API_KEY` |
| Dispatch match rate, timings, fairness | needs seeded technicians and repeated runs |
| Usability metrics (completion, SUS) | needs real participants |
| Security tests (object-level access, roles) | needs live accounts |
| Live chat handshake in a browser | needs the backend on a database |
| Chapter Five evaluation figures | depend on the results above |

## 5. Modified files this session (Prompt 2E.7)

| File | Change | Reason |
|---|---|---|
| `backend/src/realtime/websocketServer.ts` | `handleProtocols` added; doc comments | browser handshake failed without a subprotocol echo |
| `frontend/lib/chat/useChatRealtime.ts` | merges a newest page by id; exposes `subscribed` | a burst of events could drop one; status was ambiguous |
| `frontend/scripts/task30-audit-helper-checks.ts` | expectation updated 11 → 15 entries | stale fixture, not a product defect |
| `frontend/lib/legal/terms.ts` | `TERMS_VERSION = 'Draft — academic prototype'` | stamp contradicted the document's own draft status |
| `frontend/lib/privacy/notice.ts` | same value; leading space removed | stray gap on `/privacy`; consistency with terms |
| `.gitignore` | ignores `~$*` Office lock files | a PowerPoint lock file could have been committed |

Non-source deliverables produced this session: corrected report, 14-slide deck,
four Word documents, seven markdown references, defence package.

---

## Addendum — database-backed run, 13 November 2026

Executed once, sequentially, on a database created, migrated and seeded by the runner
(PostgreSQL 18, PostGIS 3.7, migrations 001–012, nine technician prototypes + administrator).

- Assertions executed: **839**
- Passed: **671**
- Failed: **168**
- Pass rate over executed assertions: **80.0 %**
- Scripts that recorded no assertion: **19 of 31**
- Fully green suites: `task23-migration-tests` (38/0), `task28-3a1-location-privacy-tests` (48/0)

Failures are dominated by login rate limiting — the API log records 13 x HTTP 429, each leaving a
suite without a token and every dependent assertion failing 401. Remaining causes: missing stub TLS
certificates for two push suites, and three `task352` helpers that are Supabase-only.

Harness fixes that made this run possible: a migration/seeder host guard that refuses anything but
loopback, a standalone idempotent seeder (`npm run seed`), SSL selection by host in
`task331`–`task334`, and runner wiring so the baseline is seeded before any suite runs.

Chapter Five of `project-reference/Umodzi_Connect_Final_Report_CORRECTED.docx` carries these
figures: the eight-row functional table and a §5.1.1 paragraph stating 839 / 671 / 168, the
656-assertion table scope, the 183-assertion documentation suite, and 19 scripts without assertions.
Full account: `docs/DB-TEST-RUN-2026-11-13.md`.
