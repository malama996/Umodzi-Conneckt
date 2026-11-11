# UMODZI CONNECT — STATE OF WORK

**Sprint:** Comprehensive system audit, bug fixing, dispatch engineering & production readiness
**Directive:** `project-reference/# UMODZI CONNECT – COMPREHENSIVE SY.txt`
**Started:** 2026-11-10
**Environment:** LIVE system under improvement. No load, stress, destructive, reseed or reset testing.
**Previous history:** `docs/STATE-archive-2026-11-09.md` (246 KB, ends with the 2026-11-09 production audit sprint and Task 35.2 DB security remediation).

> This file records only what was actually inspected, changed, executed and observed.
> A change is not marked verified until its real execution path was exercised. Static
> checks are labelled as static checks, never as functional proof.

---

## 1. Operating rules for this sprint

1. Audit before editing; follow the directive phase by phase.
2. Preserve the existing architecture, stack, visual identity, routes and API contracts.
3. Preserve user data. Migrations are additive, guarded and documented.
4. Never weaken RLS, authentication or authorization to make a feature work.
5. Never expose `GEMINI_API_KEY` or any other secret to the frontend.
6. No fake technicians, requests, messages, phone numbers or success states.
7. No heavy testing on the live system. Verification = static gates + minimal,
   non-destructive single-flow checks.
8. Do not claim an unexecuted test passed.
9. Record actual outcomes, including failures and external configuration gaps.

### Runtime security baseline carried forward (Task 35.2 — still valid)

- Runtime DB role: `umodzi_app` (DML only, no `TRUNCATE`, no ledger access, no RLS bypass).
- RLS enabled on the 13 application tables with `p_app_all TO umodzi_app`.
- `anon`, `authenticated` and `service_role` have zero grants on application tables.
- TLS `verify-full` with `backend/certs/pooler-chain.pem`.
- Service-role key commented out; admin migrations use `MIGRATIONS_DATABASE_URL` only.
- Any **new table** introduced by this sprint must receive the same RLS policy and
  `umodzi_app` grants in the same migration.

---

## 2. Phase 1 — Architecture and execution-path audit

### 2.1 Stack and ownership map

| Layer | Location | Notes |
|---|---|---|
| HTTP API | `backend/src/server.ts` (~5,060 lines) | All routes, dispatch, accept/reject, chat, contact, admin |
| Auth | `backend/src/auth/*` | JWT access token, rotating refresh cookie, role middleware |
| Authorization | `backend/src/auth/authorization.ts` | Ownership and offer eligibility guards |
| Communication auth | `backend/src/privacy/communicationAuth.ts` | Participant-only conversation access |
| Realtime | `backend/src/realtime/websocketServer.ts` | `ws` transport, token subprotocol, per-conversation subscription |
| Notifications | `backend/src/notifications/*` | In-app rows, dedupe, Web Push, SMS policy gate |
| Gemini | `backend/src/ai/faultClassifier.ts` | Server-only key, JSON-mode classification, validated output |
| DB | `backend/src/db/migrations/001–011` | PostgreSQL + PostGIS, RLS since 010 |
| Frontend | `frontend/app`, `frontend/components`, `frontend/lib` | Next.js App Router PWA |
| Dispatch domain (client) | `frontend/lib/services/*` | Pure ranking/cascade/lifecycle models — **not authoritative** |

### 2.2 Actual service-request lifecycle in the code

Persisted vocabulary (7 values, single source `SERVICE_REQUEST_STATUSES`):

```
pending | matching | matched | no_match | in_progress | completed | cancelled
```

Mapping to the directive's 9-stage model (adapt, do not duplicate):

| Directive stage | Existing value | Gap |
|---|---|---|
| PENDING | `pending` | No idempotency key; no event history |
| DISPATCHING | `matching` | No server-side timeout worker or queue |
| ACCEPTED | `matched` | Assignment is non-atomic |
| IN_PROGRESS | `in_progress` | Allowed by technician with accepted offer |
| COMPLETION_PENDING | — | Customer confirmation not modelled |
| COMPLETED | `completed` | Customer can set it directly; no confirmation step |
| CANCELLED | `cancelled` | No cascade cleanup of pending offers |
| EXPIRED | — | Request-level expiry not modelled |
| FAILED / fallback | `no_match` | Used only by old client-side cascade; creation leaves no-tech requests at `pending` |

Decision for this sprint: **keep the 7-value vocabulary** (it is already persisted,
typed, validated and rendered). Add an auditable transition log and server-enforced
transition permissions instead of a parallel status system. `no_match` is the
fallback/exhausted state; `cancelled` covers explicit cancellation.

### 2.3 Confirmed findings

Severity: **P0** data integrity / security, **P1** core workflow broken,
**P2** degraded UX/operations, **P3** polish.

| # | Sev | Finding | Root cause | Effect |
|---|---|---|---|---|
| 1 | P0 | Offer accept is not atomic | `UPDATE dispatch_offers SET status='accepted' WHERE id=$2` with no status predicate, no request lock, no already-assigned guard, no unique accepted-offer constraint | Two technicians can be assigned to one request; request can move to `matched` while another accept is in flight |
| 2 | P0 | No backend workload limit | Accept never counts the technician's active assignments | One technician can accept unlimited concurrent jobs; frontend has no authority |
| 3 | P0 | Accept does not re-check technician eligibility | `loadOfferForResponse` only checks ownership; eligibility is checked when the offer is created, not when accepted | Suspended/unavailable/unverified technicians can still accept stale offers |
| 4 | P1 | No server-side cascade after reject/timeout | Reject/timeout only update the offer row; next candidate is created by browser code (`technicianOfferService`) | Closing the browser strands the request in `matching`; no queue, no retry, no timeout |
| 5 | P1 | No dispatch timeout worker | `timed_out` is a manual client outcome only | Unanswered offers stay pending forever |
| 6 | P1 | No request fallback visibility | Creation inserts `pending` even when no candidate exists; no match reason returned | Customer sees "created" with no next step and no explanation |
| 7 | P1 | Chat locks when work starts | `canCommunicateOnRequest` requires `service_requests.status === 'matched'` | `/requests/:id/conversation` and `/requests/:id/contact` 404 in `in_progress`/`completed`; message list cannot resolve the thread |
| 8 | P1 | No customer request detail route | `app/dashboard/requests/[id]` does not exist; rows are not links | Deep links impossible; "track request" has nowhere to go |
| 9 | P1 | Navigation dead-ends | Matching success panel has no dashboard/requests link; chat uses history back; request rows not clickable | Customer cannot reliably return to or reopen a request |
| 10 | P1 | Duplicate submissions possible | No idempotency key on `POST /requests`; only the disabled button prevents double click | Network retry / double tap can create two real requests |
| 11 | P1 | Customer can force arbitrary status | `PATCH /requests/:id/status` validates vocabulary but not transition legality for customers/admins | Customer can mark an unmatched request `completed`, reopen history indirectly, or skip dispatch |
| 12 | P1 | No request transition audit | Only notifications and `service_requests.updated_at` exist | No actor/timestamp history for disputes or lifecycle debugging |
| 13 | P1 | `POST /offers` accepts terminal statuses | Route allows `accepted|rejected|timed_out` on create; client-supplied `candidateIndex` unvalidated | A browser can fabricate a completed dispatch decision or duplicate/negative candidate indexes |
| 14 | P2 | Accept notifies twice | `notifyOfferOutcome(..., "accepted")` called before and after conversation creation | Relies on dedupe; still a correctness smell and wasted work |
| 15 | P2 | No technician active-assignment surface | Technician nav has Offers/Profile only; `/me/requests` is not rendered for technicians | Accepted jobs are invisible after the offer disappears; no way to start/complete each job independently |
| 16 | P2 | No no-match retry path | `no_match` is terminal in the client lifecycle model | Customer cannot ask the platform to look again when a technician becomes available |
| 17 | P2 | Availability not tied to workload | `availability_status` is manually edited only | Dispatch can over-offer to technicians already at capacity |
| 18 | P2 | Request creation duplicates dispatch logic | Selection SQL is inlined and only offers the first candidate; cascade lives in browser | Ranking cannot be applied consistently server-side |
| 19 | P3 | Success panel hardcodes `Status: Pending` | `ServiceRequestForm` renders literal "Pending" | Shows false state when backend returned `matching`/`no_match` |
| 20 | P3 | `toTelLink` strips formatting only | Backend already returns `tel:${normalized}`; frontend fallback is not E.164-normalising | Usually harmless because normalized backend value is used; fallback could be imperfect |

### 2.4 Areas audited and found sound (no change required)

- **Gemini:** key is read only in `backend/src/ai/faultClassifier.ts`; strict input
  bounds (8–2000 chars); timeout + single attempt; output category re-validated against
  the canonical 9 categories; no description/key logging; manual category remains the
  fallback. Integration is **implemented**; runtime success depends on
  `GEMINI_API_KEY` being configured in the backend environment.
- **Chat transport:** messages persisted in PostgreSQL; WebSocket authenticates via
  subprotocol, re-checks conversation authorization server-side, heartbeats and
  reconnects; REST remains authoritative; optimistic send/retry states exist.
- **Contact retrieval:** `/requests/:id/contact` derives the other participant from the
  accepted offer and returns only `user_phones.phone_normalized`; it never invents a
  number. The gate bug in finding #7 is the only functional blocker found.
- **Notifications:** in-app rows + dedupe on natural key + optional Web Push with honest
  failure status; notification failure never rolls back a committed business operation.
- **Authorization/RLS:** ownership is derived from the session; admins cannot read
  private message content; Task 35.2 RLS/role work remains intact.

---

## 3. Stage plan and status

| Stage | Scope | Status |
|---|---|---|
| 1 | Audit and root causes | **DONE** (this section) |
| 2 | Architecture weaknesses and priority | **DONE** (findings table above) |
| 3 | Navigation, chat, contact, lifecycle corrections | **DONE** (static verification) |
| 4 | Dispatch, matching, waiting queue, workload | **DONE** (static verification; migration 012 pending execution on next backend start) |
| 5 | Concurrency protections and DB integrity | **DONE** (static verification; migration 012 pending execution on next backend start) |
| 6 | Gemini completion/confirmation | **DONE** (audited + env documented; `GEMINI_API_KEY` NOT set in live backend env → manual fallback is the active path) |
| 7 | Security/functional/integration/concurrency verification | **STATIC GATES DONE** (backend tsc, frontend tsc/lint/build all PASS; no runtime tests executed against the live system) |
| 8 | Final report | **DONE** (see §7) |

### Stage 3 checklist

- [x] Add customer request detail route `/dashboard/requests/[id]`. *(backend `GET /requests/:id` extended with additive `assignedTechnicianName`/`conversationId`; page built on owner-scoped APIs only)*
- [x] Link dashboard rows/cards and matching success panel to request tracking. *(rows are Links; consumer dashboard recent rows clickable; success panel links to detail + dashboard)*
- [x] Replace chat history-back with explicit role-safe navigation; add request context link. *(thread page back button → `/dashboard/messages`; "View request details" link; unavailable state links to `/dashboard/requests`)*
- [x] Unlock request-scoped conversation for `matched`, `in_progress`, `completed`. *(`canCommunicateOnRequest` takes `CommunicationWindowOptions`; conversation route opts into closed history; cancelled stays closed)*
- [x] Keep contact-number exposure limited to the active service window. *(contact gate unchanged for completed/cancelled — number exposure ends with the service window; chat history remains readable)*
- [x] Show real status (not hardcoded "Pending") and next steps after creation. *(shared `frontend/lib/requestStatus.ts` labels/tones/role-aware hints; form success panel renders the backend status honestly)*
- [x] Surface no-contact/no-conversation states honestly. *(detail page shows "no conversation yet" / "no number" states; never fabricated)*
- [x] Add technician active-assignment surface with per-job links/actions. *(nav label "My Assignments"; `/dashboard/requests` doubles as the technician's job list with start/complete actions)*

### Stage 4 checklist

- [x] Move cascade to the server: next eligible candidate on reject/timeout. *(`dispatchService.processOfferOutcome` + `cascadeRequest`; browser cascade retired from `technicianOfferService.ts`)*
- [x] Dispatch timeout sweeper with configurable window. *(`sweepExpiredOffers` mounted after `app.listen`, 60s default, `DISPATCH_OFFER_TIMEOUT_MINUTES` default 15m, timer unref'd, never blocks request flow)*
- [x] Waiting (`no_match`) retry endpoint and periodic re-match. *(`POST /requests/:id/retry` owner-only + `sweepWaitingRequests`, throttled by `last_dispatch_at`, age-bounded 72h; NULL-safe via COALESCE for legacy rows)*
- [x] Distinguish no technician registered / none in area / none available. *(creation counts registered/in_area/available and persists a dispatch reason: `no_registered_technician` \| `no_technician_in_area` \| `none_currently_available` \| `none_below_workload_cap`)*
- [x] Configurable technician active-assignment cap (backend + transaction). *(`assertTechnicianCanTakeWork` counts accepted offers on matched/in_progress requests inside the accept/create transactions; `MAX_ACTIVE_ASSIGNMENTS_PER_TECHNICIAN` default 3)*
- [x] Availability reflected when the cap is reached, restored when released. *(auto-set to `unavailable` flagged `availability_auto=true` only when the cap is reached; `releaseTechnicianCapacity` restores ONLY auto-set unavailability — manual toggles are never overridden)*
- [x] Record every dispatch attempt and outcome. *(`service_request_events` rows on initial dispatch, offer outcomes, fallback, retry, and every lifecycle transition; `dispatch_attempts`/`last_dispatch_at` bookkeeping)*

### Stage 5 checklist

- [x] Atomic accept in one transaction (`FOR UPDATE` + conditional update). *(`assignOfferAtomically`: lock offer+request `FOR UPDATE`, pending/open guards, conditional offer and request updates, one notification after commit)*
- [x] Unique partial index: at most one `accepted` offer per request. *(written in migration 012 with in-migration duplicate correction — keeper = the offer tied to the existing conversation, else most recently updated; others demoted to `rejected`, nothing deleted; index applies once 012 runs)*
- [x] Re-check technician eligibility and workload at accept time. *(same 409/422 gates as create-time, re-run inside the accept transaction)*
- [x] Close competing pending offers on assignment. *(inside the accept transaction; count logged)*
- [x] Idempotent create/accept/reject/timeout. *(create: `clientRequestId` replay returns 200 + original request; accept: already-accepted replay returns the offer unchanged; reject/timeout: resolved offers are no-ops via `processOfferOutcome`)*
- [x] Request transition guard + `service_request_events` audit table. *(PATCH `/requests/:id/status` rewritten as a server-enforced transition matrix — see §4; every real transition audited atomically with actor, role and reason)*
- [x] Client idempotency key for request creation. *(UUID minted per submission in `ServiceRequestForm`; reused across a failed retry, regenerated on edit/reset; `z.string().uuid()` validated; backstopped by the partial unique index)*
- [x] Cancellation cancels pending offers and releases workload. *(cancel closes pending offers — closed as `rejected` within the fixed 4-value offer vocabulary, audit row records that the customer ended them — and releases the accepted technician's capacity; completion releases it too)*

### Stage 6 checklist

- [x] Server-only Gemini key and canonical-category validation (audited).
- [x] Manual fallback when classification is unavailable (audited).
- [x] Customer reviews/confirms before request creation (audited).
- [x] Document required environment variables and verify presence without printing values.
  - `GEMINI_API_KEY`: documented in `backend/.env.example` (§ Gemini AI fault classification). **NOT set** in the live `backend/.env` (checked boolean-only). Manual category fallback is therefore the active classification path; integration remains ready and activates without code change once the key is provisioned.
  - Migration admin connection: `MIGRATIONS_DATABASE_URL` IS set in the live env (presence-checked only).
  - New dispatch knobs documented in `backend/.env.example`: `MAX_ACTIVE_ASSIGNMENTS_PER_TECHNICIAN`, `DISPATCH_OFFER_TIMEOUT_MINUTES`, `DISPATCH_SWEEP_INTERVAL_MS`, `DISPATCH_WAITING_RETRY_MINUTES`, `DISPATCH_WAITING_MAX_AGE_HOURS`. None set in live env → documented defaults apply (3 / 15m / 60s / 30m / 72h).

---

## 4. Database migration plan (not yet executed)

**Migration 012 — dispatch integrity and lifecycle audit** — WRITTEN
(`backend/src/db/migrations/012_dispatch_integrity.sql`), NOT yet executed.
It is applied by the existing migration runner on next backend start
(`runMigrations()` runs before `app.listen`, so no route can answer against a
half-migrated database). No manual execution against the live database during
this sprint unless explicitly requested.

1. `service_requests.client_request_id TEXT` + partial unique index
   `(customer_user_id, client_request_id) WHERE client_request_id IS NOT NULL`
   (legacy keyless rows never participate, so they cannot collide).
2. `service_requests.last_dispatch_at TIMESTAMPTZ` + `dispatch_attempts INTEGER NOT NULL DEFAULT 0`.
   The waiting sweeper reads `COALESCE(last_dispatch_at, created_at)` so legacy
   rows (NULL) remain sweepable WITHOUT any row rewrite.
3. `technicians.availability_auto BOOLEAN NOT NULL DEFAULT FALSE` (existing rows
   default FALSE by design: their availability was set manually, never by the
   workload system, so nothing may be auto-restored).
4. `service_request_events` audit table (request FK, from/to status, actor user
   + role CHECK customer|technician|administrator|system, reason) + index +
   RLS policy + `umodzi_app` grants (mirrors 010/011 exactly, guarded for
   role-less environments).
5. Unique partial index `ONE accepted offer per request`; duplicate accepted rows (if any)
   are corrected first by keeping the offer tied to the existing conversation (or the most
   recently updated accepted offer) and demoting the rest to `rejected`. This is an
   integrity correction, documented here because it changes invalid state. Nothing is deleted.
6. Indexes for workload counts and pending-offer sweeps
   (`idx_offers_technician_status`, `idx_offers_request_status`,
   `idx_offers_pending_updated`, `idx_requests_status_updated`,
   `idx_requests_no_match_waiting`).

### 4.1 Server-enforced transition matrix (PATCH /requests/:id/status)

Applied inside one transaction with a `service_request_events` audit row per
real transition; same-status writes stay no-op successes for idempotent old
clients. The status row is re-read under `FOR UPDATE` before the matrix is
re-evaluated, so a concurrent accept/cancel/completion cannot race the write.

| Role | Allowed transitions |
|---|---|
| Customer (owner) | `pending|matching|matched|in_progress → cancelled` (withdraw); `in_progress → completed` (confirm completion) |
| Technician | `matched → in_progress` (start work); `in_progress → completed` (record completion) — both require their own ACCEPTED offer, re-checked in-transaction |
| Administrator | any transition (operator override, always audited, reason `admin_status_update`) |

`completed`/`cancelled` are closed records for customers and technicians (409,
history is never rewritten). A customer cancelling a `no_match` request is
deliberately NOT in the matrix (the recorded decision): no_match requests stay
in the waiting queue and are retried/swept or retried by the owner endpoint;
the UI never offered that transition either. Technicians can no longer write
`matched`/`no_match` via PATCH at all — those are dispatch outcomes owned by
the offer endpoints and the sweeper; `TECHNICIAN_REQUEST_STATUS_WRITES`
authorization.ts was narrowed to `in_progress|completed` accordingly.

---

## 5. Verification policy for this sprint

- **Static:** backend `tsc --noEmit`; frontend typecheck/lint/build.
- **Functional (light):** at most one authenticated happy-path check per changed endpoint,
  using existing accounts without mutating unrelated data, or a read-only query.
- **Concurrency:** verified by code inspection and transaction/constraint design. No
  parallel load generation against the live system. Any claim about concurrency is labelled
  "statically verified" unless a safe isolated check is actually run.
- **Not run:** full regression battery, stress/load tests, destructive migrations.

---

## 6. Work log

### 2026-11-10

- Read the complete directive (Phases 1–16, Stages 1–8).
- Completed Phase 1 audit of backend routes, authorization, communication auth, WebSocket,
  notifications, Gemini, migrations, customer dashboard/requests/matching, chat/contact UI,
  technician offers and client dispatch services.
- Archived previous 246 KB state history to `docs/STATE-archive-2026-11-09.md`.
- Created this tracker. No code changed yet.

### 2026-11-11 — Stage 3–6 implementation sprint (static verification only)

**Backend — new dispatch engine (`backend/src/dispatch/dispatchService.ts`):**
- Candidate selection (category + area + verified + active + available,
  workload-capped, deterministic order, excludes every technician already
  holding an offer; `FOR UPDATE SKIP LOCKED`), server-assigned
  `candidate_index = MAX+1`, `cascadeRequest`, `processOfferOutcome`
  (idempotent, closes stale offers), `assignOfferAtomically` (full accept
  transaction with eligibility/workload re-check, competing-offer closes,
  conversation creation, audit row, availability-at-cap), `retryDispatchForRequest`,
  `sweepExpiredOffers`, `sweepStuckMatchingRequests`, `sweepWaitingRequests`,
  `releaseTechnicianCapacity`, `acceptedTechnicianId`. Notifications are sent
  by callers only AFTER their transaction commits.

**Backend — `server.ts` rewired:**
- `POST /offers/:offerId/accept` → `assignOfferAtomically` (single notification,
  duplicate second notify removed — finding #14).
- `POST /offers/:offerId/reject` and `/timeout` → `handleOfferOutcome` →
  `processOfferOutcome` (server cascade; next-candidate notification; no_match
  customer notification; honest OfferApi built from the transaction result).
- `POST /offers` restricted to `status='pending'` + integer `candidateIndex`
  0..1000 (finding #13).
- `POST /requests`: supports `clientRequestId` (uuid, optional) with idempotent
  replay (200 + original request); first candidate selected by the shared
  engine; no candidate → persisted `no_match` with diagnosable dispatch reason
  + counts + `last_dispatch_at`/`dispatch_attempts` (finding #6).
- New `POST /requests/:id/retry` (customer-owner only; backend decides
  retryability; returns additive detail fields + dispatch meta).
- `GET /requests/:id` and retry responses carry additive
  `assignedTechnicianName`/`conversationId` (`loadRequestDetailExtras`).
- `PATCH /requests/:id/status` REWRITTEN as the server-enforced transition
  matrix (§4.1) with in-transaction audit rows, cancellation cascade (pending
  offers closed, capacity released) and completion capacity release
  (findings #11, #12, #17).
- Sweeper interval mounted after `app.listen` (expired offers, stuck matching,
  waiting queue); timer unref'd; every job logs failures and never blocks
  request flow.
- `jsonResponse` extended with optional `meta` (additive).
- `authorization.ts`: technician status-write scope narrowed to
  `in_progress|completed` (documented); `assertRequestStatusWriteScope` kept as
  the coarse filter, the route is the authority.

**Frontend:**
- `technicianOfferService.ts` REWRITTEN: client cascade retired. A response is
  one outcome endpoint call + owner-scoped re-fetch; new honest
  `TechnicianOfferResponse {requestId, requestStatus}` result; view gains
  `offerId` (backend row id is the outcome target). No live flow calls the
  pure pipeline modules anymore (`matchingService`/`smartDispatchPipelineService`/
  `smartDispatchService` remain on disk as pure domain models still referenced
  by `scripts/task22-tests.ts`/`task26-tests.ts` fixtures — NOT wired to any
  live flow).
- `technician/offers/page.tsx`: actions target `offer.offerId`; result
  description and confirmed-action notifications use the new response shape.
- `ServiceRequestForm.tsx`: per-submission idempotency key (`crypto.randomUUID`
  with `getRandomValues` v4 fallback; honest error if Web Crypto is absent);
  reused across a failed retry, regenerated on edit/reset.
- `types.ts`/`serviceRequestsApi.ts`: `ServiceRequestCreateInput.clientRequestId?`;
  create passes it through; `ServiceRequestDetail` + `retryServiceRequestDispatch()`.
- (Stage 3, earlier today) `/dashboard/requests/[id]` detail page,
  `RequestLifecycleActions`, shared `requestStatus.ts`, chat/matching navigation
  fixes, honest status copy, clickable rows/cards.

**Migration 012:** written as specified in §4 (see §4 for the exact contents and
the deliberate no-rewrite choices). NOT executed in this session.

**Environment documentation (Stage 6):** dispatch knobs added to
`backend/.env.example`; `GEMINI_API_KEY` documented there since Task 33 and
verified NOT present in the live env (boolean check only) — manual fallback is
the active path.

### Verification record (2026-11-11)

- backend `npm run typecheck` (`tsc --noEmit`): **PASS** (after fixing two
  `jsonResponse` meta-shape errors found by the first run).
- frontend `npm run typecheck` (`tsc --noEmit`): **PASS**.
- frontend `npm run lint` (eslint): **PASS**.
- frontend `npm run build` (next build): **PASS** — 23 routes compiled,
  including the new `/dashboard/requests/[id]`.
- NOT executed: backend build/emission, any runtime endpoint call, any
  migration execution, any concurrency/load test. Migration 012 applies on the
  next backend restart; the live backend currently runs the pre-sprint code
  until that restart.

---

## 7. Final report (Stage 8)

### What changed, in one paragraph

Dispatch, assignment and lifecycle decisions moved from the browser to the
backend. A new transaction-safe dispatch engine owns candidate selection, the
offer cascade, the workload cap, the offer timeout, the waiting queue and the
atomic accept; the old browser cascade was retired. Every real status
transition is now a server-enforced transition matrix with an audit row, and
request creation gained an idempotency key. Navigation dead-ends were closed
with a real request-detail route, honest status presentation, and role-safe
links; chat remains unlocked through the whole service window (including
history after completion) while contact exposure stays limited to the active
window.

### Findings → resolutions (all 20)

| # | Resolution |
|---|---|
| 1 (P0) | `assignOfferAtomically` — one transaction, row locks, pending/open guards, conditional updates, unique accepted-offer index (migration 012). **Statically verified.** |
| 2 (P0) | Workload cap enforced in create/accept transactions, configurable, default 3. **Statically verified.** |
| 3 (P0) | Accept-time eligibility + workload re-check inside the accept transaction. **Statically verified.** |
| 4 (P1) | Server cascade on reject/timeout; browser cascade retired. **Statically verified.** |
| 5 (P1) | Offer timeout sweeper mounted post-listen (default 15m window, 60s cadence). **Statically verified.** |
| 6 (P1) | No-candidate creation persists `no_match` with a diagnosable reason and a customer-visible retry path. **Statically verified.** |
| 7 (P1) | `canCommunicateOnRequest` allows matched/in_progress always and completed history when opted in. **Statically verified.** |
| 8 (P1) | `/dashboard/requests/[id]` built; rows/cards/links point at it. **Statically verified (route in build output).** |
| 9 (P1) | Explicit back links everywhere; chat and matching pages no longer dead-end. **Statically verified.** |
| 10 (P1) | `clientRequestId` idempotent replay + partial unique index backstop. **Statically verified.** |
| 11 (P1) | Transition matrix replaces arbitrary PATCH. **Statically verified.** |
| 12 (P1) | `service_request_events` audit rows on every real transition + dispatch outcome. **Statically verified.** |
| 13 (P1) | `POST /offers` pending-only with bounded candidateIndex. **Statically verified.** |
| 14 (P2) | Single accept notification. **Statically verified.** |
| 15 (P2) | Technician assignment surface (nav "My Assignments", per-job start/complete). **Statically verified.** |
| 16 (P2) | Customer retry endpoint + waiting-queue sweep. **Statically verified.** |
| 17 (P2) | Availability tied to the cap via `availability_auto`; manual toggles never overridden. **Statically verified.** |
| 18 (P2) | Creation delegates to the shared server engine. **Statically verified.** |
| 19 (P3) | Honest status labels/hints everywhere. **Statically verified.** |
| 20 (P3) | Left as-is deliberately: the normalized backend `tel:` value is the operative path; the unused fallback was not worth a behaviour change in this sprint. |

### What is deliberately NOT done in this sprint

- **Migration 012 is written but not executed.** It applies automatically and
  atomically on the next backend restart (before any traffic is served). The
  new audit rows, idempotency index and one-accepted-offer rule activate then.
- **No runtime/live endpoint tests were run** (live-system rule). All
  verification above is static: `tsc` both sides, eslint, next build.
- **Concurrency claims are by design, not by load test:** row locks
  (`FOR UPDATE`), conditional updates, and the unique partial index are the
  guarantees; no parallel traffic was generated against the live system.
- The pure client dispatch domain modules remain on disk as test fixtures and
  models; no live flow references them.

### Operator follow-ups (outside this sprint's authority)

1. Restart the backend to apply migration 012 (watch the startup log for
   "Applied migrations: 012_dispatch_integrity.sql").
2. Provision `GEMINI_API_KEY` in the backend environment to activate AI fault
   classification (currently the manual category fallback serves requests).
3. Optionally set the dispatch knobs (defaults are documented and sensible).
4. Commit the sprint's changes (all changes are currently uncommitted on top
   of `4fbe0a5`).

---

## 8. Follow-up pass — user's five asks (chat/calls, notifications, static
   cards, navigation, real GPS)

### Audit verdicts (from reading the live code, before any edit)

1. **Chat + calls, both roles — CONFIRMED WORKING.** `useContactCall` fetches
   `GET /requests/:id/contact` and hands the number to `tel:` on mobile /
   copy-on-desktop; wired on the messages list, the chat thread and the request
   detail page for both roles. No change made.
2. **Notifications — core working, gaps fixed (below).** Mark-as-read,
   read-all, the "Delivery failed" badge and real unread badges all work.
   In-app toasts had no sound and never auto-dismissed; the inbox deep-linked
   only 1 of 4 persisted reference types.
3. **Static cards — gaps fixed (below).** Technician dashboards were rendered
   with the CONSUMER dashboard (wrong CTAs); admin stat cards and admin
   recent-activity rows were not clickable; customer stat cards were not
   clickable. Consumer/admin quick actions and banners were already links.
4. **Navigation — roleNav is complete and correct** (sidebar + account menu
   render the same array; every href resolves to a real route). The only nav
   gap was the technician dashboard home (fixed below).
5. **Map — real GPS CONFIRMED, no change needed.** Customer marker comes from
   opt-in `navigator.geolocation` (never on mount, never watches, WGS84
   validated), honest "Approx. <city>" fallback; technician pins are
   deliberately COARSE declared service-area centres (G-01: the backend
   withholds precise technician coordinates). The word "mock" in
   `MOCK_CITY_COORDINATES` was misleading naming for coarse, publicly known
   city-centre constants — renamed (below), behaviour unchanged.

### Fixes made in this pass

| Ask | Fix |
|---|---|
| 3 (dashboards) | New `frontend/app/dashboard/TechnicianDashboard.tsx`: technicians get their own dashboard home — workbench heading, banner → `/technician/offers`, stat cards (assignments / active / completed / offers pending via `usePendingOffersCount`), quick actions (My Assignments, Offers, Messages, My Profile). `DashboardHome` now switches all three roles. Data unchanged (`GET /me/requests` was already role-aware). |
| 3 (no static cards) | All consumer + admin stat cards and admin activity rows are now real links (stretched-overlay `.card-link-overlay` pattern in globals.css: visible card stays an `<article>`, the `<Link>` covers the full hit area with a visible focus ring). Admin targets: users→`/admin/users`, technicians/verification→`/admin/technicians`, requests/no-match/offers→`/admin/requests`. |
| 2 + 4 (notifications) | `NotificationInbox` now deep-links every persisted reference type: `service_request` → `/dashboard/requests/{id}`, `dispatch_offer` → `/technician/offers` (technician) or `/dashboard/requests` (customer — the reference id is an offer id, not a request id), `technician` → `/technician/profile`, `conversation` → the chat thread (unchanged). Rows without a reference still get no link (nothing invented). Opening a link also marks the row read. |
| 2 (sound + auto-dismiss) | New `frontend/lib/notifications/sound.ts`: fail-silent Web Audio ping per toast tone (no network, no files; every failure swallowed). `store.ts` arms tone-appropriate auto-dismiss (6 s success/info, 10 s warning/error) and clears timers on manual dismiss/clear/reset. Device push (sw.js) keeps the OS default sound — it already had no `silent` flag, so no change was needed there. |
| 5 (naming only) | `MOCK_CITY_COORDINATES` → `CITY_CENTRES` (incl. the test script and doc comments). Behaviour unchanged; nothing was ever a mock GPS fix — the customer position is real opt-in GPS, the fallback is a declared city centre. |
| Reported: Log out hidden | Sidebar Log Out could fall below the viewport: `.sidebar` was `position: sticky` with `min-height: 100dvh`, so when the nav content grew taller than the window (zoom, short screens) the pinned column's bottom — the `margin-top: auto` Log Out button — became unreachable by page scroll. **First attempt** (exact `100dvh` height + nav as the stretching scroll area) kept Log Out visible but pinned it to the viewport bottom, opening a large empty gap between the nav items and Log Out — rejected after user feedback. **Final layout**: `.sidebar` exact `100dvh` height, `.sidebar-nav` keeps its natural height and only shrinks+scrolls internally when the window is too short (`flex: 0 1 auto; min-height: 0; overflow-y: auto`), and `.sidebar-logout` sits directly under the items (`margin-top: 8px; flex-shrink: 0`) — compact alignment, always visible. The avatar menu panel got the same treatment (panel is a flex column; the item list keeps natural height and scrolls only when the panel's max height is exceeded; Log out is `flex-shrink: 0`, always visible). CSS-only; visual identity unchanged. |
| Reported: Log out STILL hidden (root cause, distinct from the layout above) | The log-out CONFIRMATION dialog rendered by `Sidebar` was trapped inside the sidebar: the sticky `<aside>` is its own stacking context and appears first in the page, so the dialog's `position: fixed; z-index: 1300` backdrop painted BEHIND the dashboard's white content — clicking Log Out appeared to do nothing ("hiding behind the page"). In drawer mode the aside's `transform` also turned it into the containing block for the fixed dialog (sized to the 280px drawer, not the viewport). Fixed in `components/ui.tsx`: the sidebar's `LogoutConfirm` is now portaled to `<body>` (the same pattern the avatar menu already used), so the dialog always stacks above everything and covers the full viewport. Gates re-run: frontend tsc PASS, eslint PASS, next build PASS (23 routes). |

### Verification (static only — live-system rule, no runtime tests)

- backend `npm run typecheck` (`tsc --noEmit`): **PASS** (no backend changes
  in this pass; re-run to confirm).
- frontend `npm run typecheck` (`tsc --noEmit`): **PASS**.
- frontend `npm run lint` (eslint): **PASS**.
- frontend `npm run build` (next build): **PASS** — 23 routes compiled
  (re-run after the Log out visibility fix; still 23 routes).
- NOT executed: any runtime endpoint call, any browser session, any
  concurrency/load test.

### Still true from the main sprint

- Migration 012 is written but not executed; applies automatically on the
  next backend restart, before any traffic is served.
- All changes remain uncommitted on top of `4fbe0a5`.
