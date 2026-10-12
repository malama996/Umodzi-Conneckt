# Umodzi Connect — Record of Processing Activities (RoPA)

**Task:** 28.3A. **Basis:** the actual code and schema, not design intent.
**Status:** working record for an academic project. It is **not** a statement of legal
compliance, and it is **not** a substitute for a DPC-registration submission.

> **Legal reference used.** Zambia Data Protection Act No. 3 of 2021, and Data Protection
> Commission (DPC) materials on registration, controllers/processors, records of processing
> activities and data-subject rights.
>
> **Citation limitation — recorded honestly.** During 28.3A the official gazetted text and the
> DPC site were **not reachable** from this environment (the legislation host returned HTTP 403;
> the DPC site returned a transport error; web search returned no results). This RoPA therefore
> cites the Act **by name and number only** and deliberately omits section numbers, and it does
> not restate the DPC's rights list as a quotation. Section-level references, the exact statutory
> terminology for each data-subject right, and the current DPC registration form content all
> **require confirmation against the official sources** before any of this is relied upon
> externally or submitted to the DPC. That confirmation is an organizational requirement, not a
> technical one, and is recorded as gap **G-12**.

---

## How to read this record

Each activity below records: purpose, data subjects, personal-data categories, recipients,
storage/location, retention status, security controls, cross-border/third-party considerations,
controller/processor notes, and unresolved questions.

Only **implemented** operations have activities. Planned operations are listed in one clearly
separated section at the end and are never mixed into the implemented record.

---

# PART A — IMPLEMENTED PROCESSING ACTIVITIES

## A.1 — Account registration

| Field | Value |
|---|---|
| **Processing operation** | `POST /api/v1/auth/register` → `registerAccount()` creates the `users` row (and, for a technician, a linked `technicians` row with name/category/service area and a seeded PostGIS `location` point) |
| **Purpose** | Create an account and the associated role, so the person can later authenticate and use the platform |
| **Data subjects** | Customers; technicians. Administrator accounts cannot be self-registered (rejected 403) |
| **Personal-data categories** | Identity (first/last name), contact (email), account/security (argon2id password hash, role, account status), professional (technician name, category, service area, coarse location) |
| **Recipients** | None external. The registrant is the data subject; administrators can later read account data |
| **Storage / location** | PostgreSQL `users`, `technicians`. Seed technician coordinates are hard-coded approximate city-centre values — **no real GPS is collected at registration** |
| **Retention status** | **TBD** — no expiry, no deletion job |
| **Security controls** | argon2id hashing; email normalised (trim + lowercase) before every lookup/insert; `UNIQUE (lower(email))` as the hard backstop; validation bounds (email ≤254, password 8–128, names ≤80); strict Zod body schema; rate limit 15/min; administrator role refused |
| **Cross-border / third-party** | None in this operation |
| **Controller/processor notes** | Registration is inherently a controller activity (the platform decides what to collect) |
| **Unresolved questions** | Whether a privacy notice must be shown and accepted *before* submission; whether a lawful-basis/consent record is required for the technician's professional data; whether the technician `location` seed should be replaced by self-declared service area only |

## A.2 — Authentication (login)

| Field | Value |
|---|---|
| **Operation** | `POST /api/v1/auth/login` → `authenticateUser()` |
| **Purpose** | Verify a returning user and issue a short-lived access token plus a refresh session |
| **Data subjects** | All authenticated users |
| **Categories** | Account/security (submitted email + password, both transient); account status read |
| **Recipients** | None external |
| **Storage** | **Plaintext credentials are not stored.** Only the argon2id digest comparison and a new `sessions` row (SHA-256 token hash) are persisted |
| **Retention status** | Session rows TBD (see A.3) |
| **Security controls** | One **generic** error for unknown email *and* wrong password (no account enumeration); `verifyAgainstDummy` equalises timing; HTTP-only, SameSite cookie for the refresh token; scoped rate limiter on the auth plugin (60/min) with a tighter 15/min on register; refresh-token reuse detection marks the session `revoked_reason='reuse'` |
| **Cross-border / third-party** | None |
| **Unresolved questions** | Whether failed-login telemetry should be retained for security monitoring (currently it is not persisted anywhere) |

## A.3 — Session lifecycle (refresh / logout / rotation)

| Field | Value |
|---|---|
| **Operation** | `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout` → `sessionService.ts` |
| **Purpose** | Re-issue access tokens without re-authentication, and allow explicit termination of a session |
| **Data subjects** | All authenticated users |
| **Categories** | Account/security (opaque token, stored as SHA-256 hash; expiry; revocation timestamp + reason; last-used timestamp) |
| **Recipients** | None external |
| **Storage** | PostgreSQL `sessions` |
| **Retention status** | **TBD.** `expires_at` exists and is enforced, but **no job deletes rows after expiry or revocation** — revoked sessions accumulate indefinitely |
| **Security controls** | Raw token never persisted; HttpOnly cookie; rotation on refresh with a grace window for concurrent tabs; reuse detection revokes; `token_hash` uniquely indexed; cascade delete with the user |
| **Cross-border / third-party** | None |
| **Unresolved questions** | Should expired/revoked session rows be purged, and after how long (gap **G-05**) |

## A.4 — Technician profile management

| Field | Value |
|---|---|
| **Operation** | `GET/PATCH /api/v1/technician/profile`, `POST /api/v1/technician/photo` |
| **Purpose** | Let a technician maintain the profile customers browse: bio, category, skills, availability, and profile photo |
| **Data subjects** | Technicians |
| **Categories** | Professional (bio, category, skills, availability), technical/device (photo bytes), location (city/service area) |
| **Recipients** | **Public** — profile fields and the photo are served unauthenticated |
| **Storage** | PostgreSQL `technicians`; photo bytes in the storage adapter under an opaque key |
| **Retention status** | TBD. Replacing a photo deletes the previous object immediately — one of the few implemented deletion behaviours |
| **Security controls** | Mutation is `requireRole('technician')` and strictly own-profile; photo upload limited to 1 file ≤5 MB; declared MIME checked **and** magic bytes validated; empty file rejected; public read served with an explicit content type and short public cache |
| **Cross-border / third-party** | None — storage is server-local in the current implementation |
| **Unresolved questions** | ~~**Whether the public technician projection should continue to include precise coordinates** (gap **G-01**)~~ — **resolved and implemented in 28.3A.1: it no longer does.** Still open: whether `bio` should be length-bounded and moderated |

## A.5 — Technician verification (upload → submit → decision)

| Field | Value |
|---|---|
| **Operation** | `POST /api/v1/technician/verification/documents`, `DELETE .../documents/:id`, `POST /api/v1/technician/verification/submit`, `GET /api/v1/admin/technicians/:id/verification`, `PATCH /api/v1/admin/technicians/:id/verification` |
| **Purpose** | Establish technician identity and qualification so customers can rely on the `verified` flag before booking |
| **Data subjects** | Technician (data subject); administrator (decision-maker whose identity is recorded) |
| **Categories** | **Higher-risk personal data**: uploaded identity/qualification documents (bytes, filename, MIME, size), verification status, administrator-authored rejection reason, reviewer identity, timestamps |
| **Recipients** | Restricted to the owning technician and administrators. Never public |
| **Storage** | Metadata in PostgreSQL; document bytes in the storage adapter under `verification/<technicianId>/<docId>.<ext>` |
| **Retention status** | **TBD — highest-priority retention question.** Documents and rejection reasons persist with no expiry. `verification_reviewed_by` is `ON DELETE SET NULL`, so deleting an administrator anonymises the reviewer rather than orphaning the row |
| **Security controls** | Upload ≤5 MB, one file, magic-byte validated; `document_type` CHECK-constrained to `national_id`/`certificate`/`other`; size > 0 enforced; document bytes reachable **only** through `GET /api/v1/verification-documents/:id/file` after authentication, returning **404 (not 403)** for another technician's document so existence does not leak; document mutation blocked (409) once submitted or decided; state machine restricted to `unverified → pending → verified|rejected`; rejection requires a non-empty reason; technicians cannot decide (403, including on themselves); administrator role enforced |
| **Cross-border / third-party** | None in this implementation |
| **Unresolved questions** | Retention of rejected documents; whether the rejection reason should be length-bounded and stripped of quoted document content (**G-03**); whether technicians should be able to delete a document after a decision |

## A.6 — Service-request creation

| Field | Value |
|---|---|
| **Operation** | `POST /api/v1/requests` |
| **Purpose** | Capture what service a customer needs and in which city, so a technician can be dispatched |
| **Data subjects** | Customers (authors); technicians and administrators (readers, per scope) |
| **Categories** | Transactional (description free text, category, city, status), identifier link (`customer_user_id`), location (city; coordinate columns exist but are **not** populated by this API) |
| **Recipients** | The customer, technicians holding an offer on the request, administrators |
| **Storage** | PostgreSQL `service_requests` |
| **Retention status** | TBD |
| **Security controls** | `requireRole('customer')`-equivalent scoping (admin/technician receive 403 in the regression suite); strict body schema with length bounds; description may contain free text; index on `city` |
| **Cross-border / third-party** | None |
| **Unresolved questions** | If coordinate capture is ever enabled, this becomes a genuine location-processing activity requiring its own notice and retention rule — flagged, not built |

## A.7 — Category classification assistance

| Field | Value |
|---|---|
| **Operation** | `POST /api/v1/classify` → `classifyCategory()` |
| **Purpose** | Suggest a service category from the customer's free-text description |
| **Data subjects** | Customers (their description text is the input) |
| **Categories** | Transactional free text in, a single category label out. **No result is stored** — the response is returned to the caller and the customer chooses a category for their request |
| **Recipients** | None external |
| **Storage** | **None.** Stateless |
| **Retention status** | n/a |
| **Security controls** | Length bounded 1–2000 characters; **unauthenticated endpoint** (verified: no `preHandler`), which means the endpoint is publicly callable |
| **Cross-border / third-party** | **None.** No external AI service is called |
| **Unresolved questions** | Whether an unauthenticated endpoint should accept customer free text at all; whether classification input should be logged |

> **Important accuracy note — this is not an AI/ML model.** Verified by reading the handler:
> classification is a **deterministic ordered keyword-regex chain** (`leak|tap|pipe|toilet|drain`
> → plumbing, `wire|socket|power|light|breaker|electric` → electrical, and so on) with a `null`
> fallback. There is **no model, no inference call, no external AI vendor, and no confidence
> score**. Any documentation describing "AI classification" should be read as "deterministic
> rule-based assistance". This is *lower* risk than a learned model, and that is worth stating
> explicitly (see gap **G-09**).

## A.8 — Technician discovery and proximity search

| Field | Value |
|---|---|
| **Operation** | `GET /api/v1/technicians`, `GET /api/v1/technicians/:id`, `GET /api/v1/technicians/nearby` |
| **Purpose** | Let a customer browse or search technicians by category, service area and distance |
| **Data subjects** | Technicians |
| **Categories** | Professional, reputation (rating, jobs, verified), availability, **coarse location** (`service_area` only) |
| **Recipients** | **Public / unauthenticated** |
| **Storage** | PostgreSQL `technicians`; PostGIS `ST_DWithin`/`ST_Distance` computed at query time |
| **Retention status** | TBD |
| **Security controls** | Strict latitude (−90..90), longitude (−180..180) and radius (0..100 km) validation; category must be one of the canonical set; results ordered by computed distance. **`/technicians/nearby` is rate limited** (`RATE_LIMIT_TECHNICIAN_SEARCH`, default 30/min) as of 28.3A.1; the list and detail routes remain unrate limited and unauthenticated. **No precise coordinate is projected by any of these routes since 28.3A.1**; the PostGIS point is used only inside the SQL predicate and ordering. (`assertUuid` is applied on `/technicians/:id/photo`, **not** on `/technicians/:id` — a pre-existing gap, see G-01) |
| **Cross-border / third-party** | None |
| **Unresolved questions** | ~~**G-01**: coordinates should be an internal dispatch input, not part of a public payload.~~ **Resolved in 28.3A.1** — coordinates are now internal-only. Still open: whether `/nearby` should require authentication at all |

## A.9 — Dispatch and offer lifecycle

| Field | Value |
|---|---|
| **Operation** | `POST /api/v1/offers`, `GET /api/v1/requests/:requestId/offers`, `GET /api/v1/offers/technician/:technicianId`, `POST /api/v1/offers/:offerId/accept|reject|timeout` |
| **Purpose** | Present a request to eligible technicians, record their response, and resolve which technician is engaged |
| **Data subjects** | Customers and technicians (both parties), administrators (monitors) |
| **Categories** | Relationship (request ↔ technician), **dispatch ranking metadata (`candidate_index`)**, transactional status, timestamps |
| **Recipients** | The two parties; administrators |
| **Storage** | PostgreSQL `dispatch_offers` (cascade from request and technician) |
| **Retention status** | TBD |
| **Security controls** | Offer creation restricted to the request owner; **server-side eligibility enforcement** (`assertOfferEligibility`: canonical category match, and an optional PostGIS distance cap when `MAX_SERVICE_RADIUS_KM` is configured); duplicate offer per technician/request → 409; technician may read only their own offers; accept/reject/timeout guarded by role + ownership; `assertOfferEligibility` prevents a technician without a matching offer from writing status |
| **Cross-border / third-party** | None |
| **Unresolved questions** | Whether `candidate_index` (an internal ranking signal) should be hidden from the customer-facing offer list; whether offers for a cancelled request should be purged |

## A.10 — Service-request status transitions

| Field | Value |
|---|---|
| **Operation** | `PATCH /api/v1/requests/:id/status`, `GET /api/v1/requests/:id` |
| **Purpose** | Move a request through its lifecycle (`pending → matching → matched → in_progress → completed`, plus `no_match` / `cancelled`) |
| **Data subjects** | Customers, technicians (participants), administrators |
| **Categories** | Transactional status and timestamps; reads the full request row |
| **Recipients** | Owner, participating technician, administrators |
| **Storage** | PostgreSQL `service_requests` |
| **Retention status** | TBD |
| **Security controls** | `requireAuth`; `loadRequestForUser` returns 404 (existence hidden) for strangers; `assertRequestStatusWriteScope` limits technicians to `matched`/`no_match` on requests holding one of their offers; invalid status → 400 |
| **Cross-border / third-party** | None |
| **Unresolved questions** | Whether status history should be retained as a separate audit trail (currently only `updated_at` reflects the last change — relevant to gap **G-08**) |

## A.11 — Reviews and ratings

| Field | Value |
|---|---|
| **Operation** | `POST /api/v1/requests/:id/review`, `GET /api/v1/requests/:id/review`, `GET /api/v1/technicians/:id/reviews` |
| **Purpose** | Provide customer trust signals and technician reputation |
| **Data subjects** | Customers (reviewer/author), technicians (subject) |
| **Categories** | Reputation (rating), **free-text comment**, reviewer identity link, timestamp |
| **Recipients** | **Public** (the technician's review bundle), with the reviewer **pseudonymised** to "first name + last initial"; plus the request's participating parties, and administrators |
| **Storage** | PostgreSQL `reviews` |
| **Retention status** | TBD |
| **Security controls** | Reviewer must be a **customer** owning the request (technician and administrator roles → 403); request must be `completed` (other statuses → 409); one review per request (409 on duplicate); rating CHECK-constrained; comment length-bounded by the body schema; client-supplied customer/technician ids **rejected** by a strict schema (400) so impersonation is impossible; unrelated customers get 404 |
| **Cross-border / third-party** | None |
| **Unresolved questions** | Whether free-text comments need moderation or a reporting path; whether the reviewer's pseudonymisation is documented in the privacy notice; whether the public review `id` should be exposed |

## A.12 — Notifications and Web Push delivery

| Field | Value |
|---|---|
| **Operation** | `NotificationService.recordEventNotification()` + `deliverPendingNotification()` invoked from 11 event hook sites across offer, request-status and verification routes; delivery via `PushService.sendPushToUser()` |
| **Purpose** | Tell a participant, in near real time, that something happened that concerns them (new offer, offer outcome, status change, verification outcome) |
| **Data subjects** | Customers, technicians, administrators |
| **Categories** | Notification (title, message, event type, reference, channel), delivery metadata (status, `sent_at`, `provider_message_id`, `failure_reason`), read state |
| **Recipients** | The single addressed data subject. Two message templates carry personal data: `${tech.name} submitted verification for review.` (technician name → administrators) and `Your technician verification was rejected: ${reason}` (administrator-authored text → the technician) |
| **Storage** | PostgreSQL `notifications`; subscription keys in `push_subscriptions` |
| **Retention status** | TBD. No pruning of read/old notifications |
| **Security controls** | Recipients resolved **only** from authoritative database relationships, never from client input; natural-key dedupe on `(user_id, type, reference_type, reference_id)` under an advisory lock, so a repeated event cannot spam or duplicate; rows inserted `pending` and only marked `sent` on a genuine provider acceptance — never on insert success; failures recorded honestly with a reason and no fabricated provider id; notification failure is logged and never rolls back the business write; no provider call happens inside a database transaction; 404/410 responses delete the dead subscription; **no route currently exposes notifications to a data subject** (gap **G-02**) |
| **Cross-border / third-party** | **Yes — a real external provider.** `web-push` POSTs an encrypted payload to the browser vendor's push endpoint (Firefox/Google/Mozilla endpoints as supplied by the browser at subscription time). The platform sends title/message content to that provider under VAPID authorisation |
| **Unresolved questions** | Retention for notification history; whether the in-app inbox route should be added before the privacy notice is published, so the notice can accurately describe it |

## A.13 — Push subscription registration and removal

| Field | Value |
|---|---|
| **Operation** | `POST /api/v1/me/push-subscriptions`, `DELETE /api/v1/me/push-subscriptions/:id` |
| **Purpose** | Register/remove a browser profile so notifications can be delivered to that device |
| **Data subjects** | The device owner |
| **Categories** | Technical/device (**push endpoint, `p256dh` public key, `auth` secret**), user agent |
| **Recipients** | Stored locally only. The endpoint is *used* by A.12 to reach the browser vendor |
| **Storage** | PostgreSQL `push_subscriptions`, unique per `(user_id, endpoint)` |
| **Retention status** | TBD. Removed on unsubscribe or on provider 404/410; **not** removed when an account is suspended (gap **G-11**) |
| **Security controls** | `requireAuth`; strictly caller-scoped, another user's id → identical 404; strict schema **rejects a client-supplied `user_id`**; endpoint must be a valid `https:` URL (http/ftp/whitespace/oversized all → 400); duplicate same-user POST is an idempotent 200 update; route rate limit; VAPID **private** key read from backend environment only and never exposed to the frontend |
| **Cross-border / third-party** | The endpoint is a third-party URL controlled by the browser vendor. Location of that provider's infrastructure **requires deployment-time confirmation** |
| **Unresolved questions** | Whether subscription keys should be revoked when an account is suspended or disabled |

## A.14 — Administration and account management

| Field | Value |
|---|---|
| **Operation** | `GET /api/v1/admin/overview`, `/admin/users`, `/admin/technicians`, `/admin/requests`; `PATCH /api/v1/admin/users/:id/status`; verification decision route (A.5) |
| **Purpose** | Operate and moderate the platform: review accounts, resolve verification, suspend or re-activate accounts |
| **Data subjects** | All users, viewed by administrators |
| **Categories** | Identity, contact (**email**), account status, verification state, and on `/admin/requests` the customer's **full name and email** |
| **Recipients** | Administrators only |
| **Storage** | PostgreSQL |
| **Retention status** | n/a (read + status writes) |
| **Security controls** | `requireRole('administrator')` on every admin route (401 unauthenticated, 403 for customer and technician); safety messages carry no stack or internals; admin routes rate-limited; an administrator cannot create another administrator via public registration |
| **Cross-border / third-party** | None |
| **Unresolved questions** | **G-04**: this is privileged access to every user's contact data. It needs to be documented as an accepted boundary in the privacy notice, and — if the deployment ever has multiple staff administrators — an internal access-logging requirement (gap **G-08**) |

## A.15 - File storage operations

| Field | Value |
|---|---|
| **Operation** | `fileStorage.ts` — `put` / `read` / `remove` behind the `FileStorage` interface, currently `LocalFileStorage` |
| **Purpose** | Persist technician photos and verification document bytes without the domain layer ever holding a path |
| **Data subjects** | Technicians (both object sets) |
| **Categories** | **Higher-risk personal data** for verification documents; ordinary for photos |
| **Recipients** | Photo bytes public by design; document bytes restricted (A.5) |
| **Storage** | Server-local directory tree under `STORAGE_DIR`, namespaced `profiles/` and `verification/<technicianId>/` |
| **Retention status** | Photo replacement deletes the old object; document deletion is possible before submission **and now also on account deletion (A.17)** |
| **Security controls** | Storage keys validated strictly — traversal sequences and absolute paths rejected, so a hostile key cannot escape the root; the root path never appears in an API payload or database value; missing keys map to 404; upload size/type/magic-byte limits (A.4, A.5). **Added in 28.3G:** document responses carry `Cache-Control: no-store` / `Pragma: no-cache`, and the download filename is re-sanitised |
| **Cross-border / third-party** | **None in the current implementation.** The abstraction exists so a future object store can be substituted without touching routes. **No Supabase Storage client exists** — see `docs/THIRD_PARTY_PROCESSORS.md` |
| **Unresolved questions** | Whether the deployment target uses object storage and, if so, in which jurisdiction; whether photo and document objects need separate retention policies |

## A.16 - Data-subject access and export (28.3C)

| Field | Value |
|---|---|
| **Operation** | `GET /api/v1/me/data`; `GET /api/v1/me/account/deletion-preview` |
| **Data subjects** | Customer, technician, administrator (their own account only) |
| **Categories** | Account, technician profile (incl. the subject's own stored coordinates), verification status + document **metadata**, sessions, requests, offers made/received, reviews written/received, notifications, push-subscription metadata, own security events |
| **Recipients** | The data subject only. The subject id comes from the session — there is no client-supplied user id |
| **Format** | `umodzi-account-export-v1` JSON, generated per request. **Nothing is stored**; the file is created in the browser |
| **Deliberately excluded** | `password_hash`; `sessions.token_hash`; document `storage_key` and bytes (retrieved instead through the owner-scoped route after authorization); push `p256dh`/`auth` and full endpoint URLs; other users' data; reviewer identities for reviews received |
| **Security controls** | `requireAuth`; rate limit 10/min; every projection omits sensitive columns by construction rather than filtering them out afterwards; the export is itself audited (`privacy.data_exported`, counts only) |
| **Cross-border / third-party** | None — the export is served by the application itself |
| **Unresolved questions** | Retention of exports is moot (none stored). A future machine-readable "correct your data" flow is not implemented |

## A.17 - Permanent account deletion (28.3D)

| Field | Value |
|---|---|
| **Operation** | `DELETE /api/v1/me/account` (password + `DELETE MY ACCOUNT` phrase required); `GET /api/v1/me/account/deletion-preview` (read-only) |
| **Data subjects** | The authenticated account holder |
| **Recipients** | No third party. The system has **no** mechanism to request deletion from a push service or any other processor, and does not claim to |
| **Mechanism** | Real deletion in one transaction: reviews authored → service requests (cascade offers/reviews) → technician profile (cascade offers received, verification documents, reviews about the profile) → notifications → push subscriptions → sessions → the account row. Then post-commit, best-effort unlink of the owned profile photo and verification document files via the real `FileStorage` abstraction |
| **Why it is not a bare `DELETE FROM users`** | `service_requests.customer_user_id` and `technicians.user_id` are **`ON DELETE SET NULL`**, so a bare delete would **orphan** the deleted user's request descriptions and profile instead of removing them |
| **Retained** | Security/audit events, **minimised** (opaque ids, no name/email/text/document content). `audit_events` has **no FK** to `users` specifically so an erasure request does not destroy the accountability record. The retained count is disclosed before confirmation |
| **Documented consequences** | Reviews *about* a deleted technician profile are removed with it (`NOT NULL` cascade); rating and job-count aggregates disappear. No anonymised-profile option is offered, because retaining the profile would retain the name/bio/verification state that make it personal data |
| **Security controls** | `requireAuth`; **password re-authentication**; exact confirmation phrase; rate limit 5/min; subject is the authenticated principal; failure is audited as `denied` with reason `password_mismatch`; deleted content is never logged |
| **Failure policy** | If storage unlink fails the deletion still succeeds and the failure is logged — an orphaned file is unreachable because bytes are only served after a database key lookup that no longer resolves |

## A.18 - Retention and lifecycle operations (28.3E)

| Field | Value |
|---|---|
| **Operation** | `runRetentionSweep()` → `purgeExpiredSessions()`, `purgeOldNotifications()` (operator-invoked; no scheduler, cron or `setInterval` exists) |
| **Data subjects** | All, indirectly |
| **Categories removed** | Sessions past `expires_at` and the retention window (default 30 days, `RETENTION_SESSIONS_DAYS`); notifications that are `read` **and** `sent`/`delivered` past the window (default 180 days, `RETENTION_NOTIFICATIONS_DAYS`) |
| **Deliberately never removed** | Unread notifications; `pending`/`failed` notification rows (an operator may need to inspect a failed delivery); push subscriptions with no genuine 404/410 signal |
| **Idempotency / safety** | Deterministic, per-category scoped, safe to re-run (a second run removes 0), and returns exactly what it removed. No autonomous job: a misconfigured unattended deleter is a larger risk than retained rows |
| **Unresolved questions** | Most categories still have **no agreed period** — every such row in `DATA_RETENTION_POLICY.md` is marked as requiring deployment-time/legal confirmation. Do not automate the sweep until those are settled |

## A.19 - Privacy/security audit logging (28.3F)

| Field | Value |
|---|---|
| **Operation** | `recordAuditEvent()` at each instrumented site; `GET /api/v1/admin/audit-events` (administrator) |
| **Data subjects** | All principals, as actor or target |
| **Categories** | Event type, opaque actor/target ids, actor role, outcome, bounded technical metadata, timestamp |
| **Events** | `auth.login_failed`, `auth.login_succeeded`, `auth.account_locked`, `admin.user_status_changed`, `admin.verification_decision`, `security.verification_document_accessed`, `security.verification_document_deleted`, `privacy.data_exported`, `privacy.account_deleted`, `account.suspended`, `account.reactivated` |
| **Never recorded** | Passwords (any form), access/refresh tokens or token hashes, VAPID private keys, SMS credentials, document bytes, document filenames, storage keys, notification bodies, the administrator rejection reason, and **client IP addresses** (not stored anywhere in the system, and deliberately not introduced here) |
| **Controls** | Closed event-type vocabulary; metadata **allow-list** with primitive values, over-length values dropped rather than truncated; **no FK** to `users` so deletion can proceed; log-and-continue so an audit write can never fail or roll back the business action |
| **Visibility** | Administrators only (`requireRole('administrator')`); an ordinary user sees their own history only, via their data export |
| **Unresolved questions** | Request status history, access-token issuance, rate-limit events and administrator *reads* are still not logged. The retention period for audit rows is undefined |

## A.20 - Data-subject notification inbox (28.3C)

| Field | Value |
|---|---|
| **Operation** | `GET /api/v1/me/notifications`; `PATCH /api/v1/me/notifications/:id/read`; `POST /api/v1/me/notifications/read-all` |
| **Data subjects** | Customer, technician, administrator (own notifications only) |
| **Categories** | Own notification rows: type, title, message, channel, reference, read state, delivery status, timestamps |
| **Recipients** | The recipient is taken from the **session only** — no client-supplied recipient exists |
| **Design** | Reuses the existing `notifications` table and `NotificationService` read methods. **No competing store**, no schema change, and **no change to push/SMS delivery semantics** |
| **Security controls** | `requireAuth`; `assertUuid`; owner-scoped in SQL (`id AND user_id`) so a foreign id updates nothing and yields the same 404; explicit pagination; honest empty state; the sidebar badge shows the real unread count (it previously rendered a hardcoded `2`) |
| **Retention** | Read notifications past the window are removed by A.18; unread and undelivered ones are not |

---

# PART B — EXTERNAL PROCESSORS AND PROVIDERS

Provider status below is taken from the code and configuration. **A provider being *possible* is
not recorded as a provider being *present*.**

| Provider | Present in code? | Reached in production configuration? | Data sent | Location evidence |
|---|---|---|---|---|
| **PostgreSQL / PostGIS database** | Yes — `pg` pool, migrations, PostGIS functions | Yes (local scratch; production target named in config as Supabase PostgreSQL/PostGIS) | All categories | **Requires deployment-time confirmation.** No region configured in the repo |
| **Object/file storage** | Yes — but only the **server-local** adapter | Yes (local filesystem). **No Supabase Storage client exists** | Photos, verification documents | Local filesystem today; a future object store would need confirmation |
| **Browser push service (Web Push)** | Yes — `web-push` + `push_subscriptions` | Yes, when `VAPID_*` is configured | Encrypted notification payload (title/message) | Vendor determined by the browser; **requires deployment-time confirmation** |
| **Africa's Talking SMS** | Yes — `ConfigurableSmsProvider` behind `ISmsProvider` | **No.** Requires `AFRICASTALKING_USERNAME` + `AFRICASTALKING_API_KEY` (both empty/commented), and **no route calls it** | SMS body + recipient number | **Requires deployment-time confirmation** |
| **AI/ML classification vendor** | **No** | No | n/a | n/a — classification is deterministic keyword rules (A.7) |
| **Analytics / advertising / third-party tracking** | **No** | No | n/a | n/a |

### Controller / processor considerations (qualified, not a legal determination)

- **Umodzi Connect as controller.** Registration, authentication, verification, requests,
  offers, reviews and notifications are activities where the platform decides *what* is
  collected and *why* — the ordinary shape of a **controller** relationship. This is an
  observation about the operating model, **not** a legal conclusion; it requires legal
  confirmation.
- **Umodzi Connect acting as a possible processor** is not identified as a present activity in
  the code. Should the platform later white-label or operate on behalf of an organisation or
  cooperative, the analysis would change. Not currently in scope.
- **Processor relationships requiring arrangements at commercial deployment:** the database /
  storage operator, the browser push provider, and (once activated) Africa's Talking. Each would
  need the appropriate contractual and data-processing arrangements. **None is documented in the
  repository today** — recorded as gap **G-10**.
- The DPC currently provides registration resources for both controllers and processors. Whether
  and how Umodzi Connect must register is a **deployment requirement** requiring confirmation
  against current DPC guidance — not something this stage can settle.

### Cross-border processing

The architecture *can* result in personal data being processed outside Zambia:

1. **Database / storage hosting** — if deployed on infrastructure outside Zambia.
2. **Web Push** — the notification payload (which can contain a person's name or an
   administrator-authored rejection reason) is transmitted to the browser vendor's push service.
3. **SMS** — if activated, message content and the recipient's telephone number would be
   transmitted to the SMS provider.

For all three, the repository contains **no evidence** establishing the processing location.
The honest position recorded here is:

> **Provider/infrastructure location requires deployment-time confirmation.**

Nothing in this record asserts that data is or is not stored exclusively in Zambia. The DPC's
current registration process asks whether personal data is stored outside Zambia and notes that
separate authorisation may be required where applicable — so this question must be answered
before deployment, not assumed.

---

# PART C — PLANNED OPERATIONS (recorded separately, NOT implemented)

Listed so the RoPA is honest about scope. **None of these exist in the code.**

| Planned operation | Status |
|---|---|
| Notification inbox routes (`GET /notifications`, mark-read) | Service methods exist; **no HTTP route** |
| Data export / access | Not started — Task 28.3C |
| Account deletion | Not started — Task 28.3D |
| Retention enforcement jobs | Not started — Task 28.3E |
| Audit logging of privileged access | Not started — Task 28.3F |
| Privacy notice in registration/UI | Not started — Task 28.3B |
| Phone-number collection and storage | Not started — blocks any real SMS delivery |
| DPIA | Not started — Task 28.3I |
| Notification moderation/reporting | Not started |

---

# PART D — CROSS-CUTTING UNRESOLVED QUESTIONS

1. ~~**Public coordinate exposure (G-01)** — should the public technician projection drop
   `latitude`/`longitude` entirely, retaining only `service_area` and `city`?~~
   **Answered yes, and implemented in 28.3A.1.** The public projections now drop
   `latitude`/`longitude` and the raw PostGIS point entirely, retaining `serviceArea` only.
   `/nearby` additionally returns a 100 m-bucketed `distance_meters` and is rate limited.
   Internal dispatch still uses the stored point.
2. **Retention for every category** — nothing has a defined period, including verification
   documents and revoked sessions (G-05).
3. **Erasure semantics** — what "delete my account" must remove: `users` row (cascades to
   sessions, requests, offers, reviews, notifications, push subscriptions) but **not**
   `technicians` rows for a technician with no linked account, and not storage objects. Needs a
   decision before 28.3D (G-06).
4. **Reviewer/verifier identity** — should `verification_reviewed_by` remain identifiable, or be
   reduced to a role after a retention period?
5. **Free-text fields** — request descriptions, review comments and rejection reasons are all
   user- or administrator-authored free text with no moderation path.
6. **Privileged access** — administrator visibility of all users' email and names (G-04), and
   whether staff access should itself be logged (G-08).
7. **Transparency timing** — the privacy notice must describe the in-app inbox, which does not
   exist as a route yet; better to add the route before publishing, or describe the actual state
   (G-02).
8. **Legal confirmation** — section-level citations, statutory rights terminology, DPC
   registration obligations and processor-contract requirements all require confirmation against
   official sources that were unreachable in this stage (G-12).