# Umodzi Connect — Privacy Implementation Gap Analysis

**Task:** 28.3A (discovery) and **28.3A.1 + 28.3B–28.3J (remediation)**. **Basis:** verified
against the code, the six migrations (`001`–`006`), and the running system. Every "Evidence"
cell names a file or a verified observation.
**Nature of this document:** an academic analysis of what the system does and does not yet
support. It is **not** a compliance statement. Umodzi Connect is not asserted to be compliant,
not asserted to be registered with the Data Protection Commission, and not asserted to have a
data protection officer.

> **Legal-source limitation.** The official gazetted text of the Zambia Data Protection Act
> No. 3 of 2021 and the DPC website were **unreachable** during this stage (legislation host
> returned HTTP 403, DPC site returned a transport error, web search returned no results). The
> requirement rows below are therefore framed as **principles and questions**, mapped to the
> areas of the Act the project must address, **without** asserting section numbers or statutory
> terminology. Section-level mapping requires legal confirmation and is itself recorded as gap
> **G-12**.

---

## 0. Task 28.3 outcome — what was resolved and what remains

| Gap | Subject | Outcome |
|---|---|---|
| **G-01** | Public precise technician coordinates | **RESOLVED** in 28.3A.1 |
| **G-02** | No data-subject notification surface | **RESOLVED** in 28.3C |
| **G-05** | No retention rule or enforcement | **PARTIALLY RESOLVED** in 28.3E — policy documented; enforced for sessions and read notifications; most periods still need confirmation |
| **G-06** | No erasure mechanism | **RESOLVED** in 28.3D (real deletion, not a flag) |
| **G-08** | No privileged-access logging | **RESOLVED** in 28.3F (`audit_events`) |
| **G-10** | No processor register | **RESOLVED** in 28.3H (`docs/THIRD_PARTY_PROCESSORS.md`) |
| **G-03** | Unbounded admin free text | **OPEN** — see §0.1 |
| **G-04** | Admin sees all contact data | **PARTIALLY RESOLVED** — the boundary is now disclosed in the privacy notice and privileged changes are audited; admin *reads* are still not individually logged |
| **G-07** | Push subscriptions survive suspension | **OPEN** — see §0.1 |
| **G-09** | Unauthenticated `/classify` | **OPEN** — see §0.1 |
| **G-11** | Cross-border location unestablished | **OPEN** — deployment-time |
| **G-12** | Legal basis, registration, DPO, incident procedure | **OPEN** — deployment-time |

New records produced by 28.3B–28.3I:

- `docs/PRIVACY_POLICY.md` — the notice, with registration disclosure and a live `/privacy` page
- `docs/DATA_RETENTION_POLICY.md` — retention rules, distinguishing implemented from proposed
- `docs/THIRD_PARTY_PROCESSORS.md` — provider register, distinguishing implemented / inactive / planned
- `docs/DATA_PROTECTION_IMPACT_ASSESSMENT.md` — the DPIA

### 0.1 Why G-03, G-07 and G-09 remain open

These are honest non-completions, not oversights:

- **G-03 (admin free text).** Bounding and moderating the rejection-reason field changes an
  existing data field and an existing notification message contract. It was deliberately not
  done inside the privacy stages, which were about not *disclosing* more than necessary. It
  remains the top open hardening item.
- **G-07 (push subscriptions on suspension).** Revoking subscriptions at suspension time
  requires choosing whether suspension should be a full or partial logout. That is a product
  decision, not a privacy fix.
- **G-09 (`/classify`).** The endpoint is deterministic, local, advisory and rate limited.
  Adding authentication would change a public product capability.

---

## 1. Gap register

Priority key: **P1** blocks deployment · **P2** needed before production launch · **P3**
hardening / good practice.

---

### G-01 — Precise technician coordinates published unauthenticated — **RESOLVED in 28.3A.1**

| Column | Value |
|---|---|
| **Requirement / principle** | Data minimisation; purpose limitation (location collected for proximity dispatch, not for publication) |
| **Status** | **RESOLVED (Task 28.3A.1, 2026-10-08).** The public technician projections no longer carry a stored coordinate. See "Corrected behaviour" below. |
| **Original implementation (the finding)** | Three unauthenticated endpoints returned `latitude`/`longitude`, and `/nearby` additionally returned `distanceKm`. The PostGIS `location` point is the genuine operational input; the public coordinate fields were a by-product of a shared projection |
| **Original evidence** | `backend/src/server.ts` `GET /api/v1/technicians`, `GET /api/v1/technicians/:id`, `GET /api/v1/technicians/nearby` — none carried a `preHandler`; all three projected `latitude`/`longitude`. `technicians.location` is `GEOGRAPHY(POINT, 4326)` NOT NULL with a GiST index (`001_initial_schema.sql`) |
| **Original gap** | Operational location data was disclosed to anyone, including scrapers, with no authentication and no rate limit. Even though current rows were approximate seed coordinates, real rows would have been published verbatim |

**Corrected behaviour (verified by `backend/scripts/task28-3a1-location-privacy-tests.ts`, 48/48):**

| Route | Before | After |
|---|---|---|
| `GET /api/v1/technicians` | projected `latitude`, `longitude` | projects neither; coarse location conveyed by `serviceArea` |
| `GET /api/v1/technicians/:id` | projected `latitude`, `longitude` | projects neither; coarse location conveyed by `serviceArea` |
| `GET /api/v1/technicians/nearby` | projected `latitude`, `longitude`, exact `distance_meters` | projects neither coordinate nor raw geometry; `distance_meters` coarsened to a **100 m bucket**; route is now **rate limited** (`RATE_LIMIT_TECHNICIAN_SEARCH`, default 30/min) |

- **Preserved:** the PostGIS radius search is untouched. `location` is still used inside the SQL predicate (`ST_DWithin`) and ordering (`ST_Distance`); results are still ordered by distance ascending. `assertOfferEligibility` in `backend/src/auth/authorization.ts` still reads stored coordinates directly for internal dispatch ranking. The columns remain in the schema for that internal use.
- **Preserved:** the public field set is otherwise unchanged (`id, name, category, skills, serviceArea, rating, jobs, verified, availability, availabilityStatus, accountStatus, bio, hasPhoto, createdAt, updatedAt`), as are the input-validation and 404 behaviours of all three routes.
- **Frontend:** `frontend/lib/api/technicianMapper.ts` no longer maps any coordinate into the frontend `Technician` object, so a server-provided coordinate cannot re-enter the UI as display data. The prototype map derives a **coarse service-area city-centre** marker via `getServiceAreaPoint()` in `frontend/lib/mapData.ts`, so the map UX is preserved without a location fix. The displayed map distance is therefore an area-level figure between two city centres, not a true technician distance.
- **`/nearby` caller input:** the caller still supplies their *own* `latitude`/`longitude` as query parameters. Echoing a caller's own input back to them is not a disclosure, and a radius search cannot function without it.
- **Residual risk, stated honestly:** 100 m rounding is a mitigation, not a proof. A caller who probes from many different points can still narrow a technician's position over time. This is why the route is now rate limited, and why the underlying data today is a city-centre seed rather than a residential point. If deployment ever captures genuine technician coordinates, re-assess this endpoint before launch.
- **Pre-existing, NOT changed here:** `GET /technicians/:id` does not call `assertUuid`, so a malformed UUID reaches Postgres and surfaces as a generic `500` rather than `400` (the sibling `/photo` route does validate). Fixing it would change an existing API contract and is out of scope for a location-privacy correction; the response remains safe (generic message, no coordinates, no internals, no stack).

### G-02 — No data-subject-facing notification surface — **RESOLVED in 28.3C**

| Column | Value |
|---|---|
| **Requirement** | Transparency; right of access; storage limitation |
| **Status** | **RESOLVED (Task 28.3C, 2026-10-08).** A real, owner-scoped notification inbox now exists. |
| **Original implementation (the finding)** | `NotificationService` implemented `getUserNotifications`, `markAsRead`, `markAllAsRead` — but **no HTTP route exposed any of them**. Notification personal data (including a technician's name and administrator-authored rejection text) was stored and forwarded to an external push provider, yet the data subject could not list, read or delete their own history |
| **Original evidence** | `backend/src/notifications/notificationService.ts` (methods existed); **no** `/notifications` route in `backend/src/server.ts` or `backend/src/auth/routes.ts`; the dashboard "Notifications" item was a `#` placeholder |
| **Original gap** | A person could not exercise access or objection over data about them. A privacy notice published at that point would have had to describe a surface that did not exist |

**Corrected behaviour (28.3C):**

| Route | Behaviour |
|---|---|
| `GET /api/v1/me/notifications` | The caller's own history. Recipient from the **session only** — no client-supplied recipient. Explicit `limit`/`offset` pagination (default 25, max 100) plus a real `unreadCount`, `totalCount` and `hasMore`. An empty account gets an honest empty list |
| `PATCH /api/v1/me/notifications/:id/read` | Marks one notification read, owner-scoped in SQL (`id AND user_id`); a foreign id updates nothing and yields the same 404 |
| `POST /api/v1/me/notifications/read-all` | Marks every unread notification read and returns the **real** number changed (may legitimately be `0`) |

- **No competing notification system.** These routes call the existing `NotificationService` read methods over the existing `notifications` table. No second store, no schema change, and **no change to push/SMS delivery semantics**.
- **Frontend:** a real inbox at `/dashboard/notifications` (mobile-first, 25 per page, honest empty state, failed-delivery status shown honestly). The sidebar "Notifications" item now points at it, and its badge shows the **real** unread count — replacing a hardcoded `2` that was fabricated data describing a history the application could not even show.
- Deletion of a notification history remains available through account deletion (28.3D).

### G-03 — Unbounded administrator-authored free text stored and re-sent

| Column | Value |
|---|---|
| **Requirement** | Data minimisation; storage limitation; accuracy |
| **Current implementation** | `technicians.verification_rejection_reason` is free TEXT written by an administrator and stored, then placed verbatim into a notification message sent to the technician. It can quote uploaded document content (an ID number, a face, a signature) |
| **Evidence** | `backend/src/db/migrations/003_technician_verification.sql` (`verification_rejection_reason TEXT`); `backend/src/server.ts` verification-decision hook: message `` `Your technician verification was rejected: ${decision.reason}` `` |
| **Gap** | Higher-risk identity content can be duplicated into an unmoderated text field and re-surfaced in a second channel, with no length policy and no redaction control |
| **Planned stage** | **28.3G** (verification document privacy) |
| **Priority** | **P2** |

### G-04 — Administrator role can read every user's contact data and full name

| Column | Value |
|---|---|
| **Requirement** | Transparency; access control; accountability |
| **Current implementation** | `GET /api/v1/admin/users` returns every user's `id, email, role, firstName, lastName, accountStatus, createdAt`. `GET /api/v1/admin/requests` additionally returns each request customer's **full name and email**. Both are `requireRole('administrator')` |
| **Evidence** | `backend/src/server.ts` — `AdminUserRow` selects `email`; admin-requests projection sets `customerEmail` and `customerName` |
| **Gap** | This is legitimate operational access, but it is undocumented anywhere, unlogged, and indistinguishable from any other administrator's access. No staff access-log exists |
| **Planned stage** | **28.3B** (disclose the privileged-access boundary) + **28.3F** (log privileged reads) |
| **Priority** | **P2** |

### G-05 — No retention rule or enforcement for any category — **PARTIALLY RESOLVED in 28.3E**

| Column | Value |
|---|---|
| **Requirement** | Storage limitation |
| **Original implementation (the finding)** | Every category persisted indefinitely. `sessions` had `expires_at` and was *enforced* at read time, but expired and revoked rows were **never deleted**. Verification documents, notifications, reviews, offers and requests had no expiry at all |
| **Original evidence** | No scheduled job existed anywhere in `backend/src` (no scheduler/cron module) |
| **Status** | **PARTIALLY RESOLVED (28.3E).** See below |
| **Priority** | **P1** (remaining periods) |

**Implemented in 28.3E** (`docs/DATA_RETENTION_POLICY.md`, `backend/src/privacy/retentionService.ts`):

- A documented retention schedule covering all 16 categories, with each period explicitly
  marked **implemented** or **proposed — requires deployment-time/legal confirmation**. No
  legal period is asserted, because none could be verified (see the header note).
- **Enforced:** expired/revoked sessions (default 30 days) and read, delivered notifications
  (default 180 days). Both are configurable by environment variable.
- **Deliberately never deleted:** unread notifications, and `pending`/`failed` notification
  rows (an operator may still need to inspect a failed delivery).
- **No autonomous job.** The sweep is explicitly operator-invoked, deterministic, idempotent,
  scoped per category, and returns exactly what it removed. There is still no `setInterval`,
  cron entry or scheduler in the codebase — a misconfigured unattended deleter is a larger
  risk than retained rows.
- Push subscriptions are pruned only on a **genuine 404/410** from the provider (already
  implemented inline). No sweep guesses at staleness.

**Remaining:** most categories still have no agreed period, and the security-record period is
undefined. This gap is therefore **not closed** — it is documented, and partly enforced.

### G-06 — Erasure semantics undefined — **RESOLVED in 28.3D**

| Column | Value |
|---|---|
| **Requirement** | Right to erasure |
| **Status** | **RESOLVED (Task 28.3D).** `DELETE /api/v1/me/account` performs real deletion. |
| **Priority** | **P2** |

> **Correction to the 28.3A analysis.** The 28.3A entry stated that foreign keys cascade
> "broadly" from `users` to `service_requests`. Re-reading `002_authentication.sql` for 28.3D
> showed that is **wrong**, and the wrongness was material: `service_requests.customer_user_id`
> and `technicians.user_id` are both **`ON DELETE SET NULL`**, not `ON DELETE CASCADE`.
> A bare `DELETE FROM users` would therefore have **orphaned** a deleted user's service
> requests (with their free-text descriptions) and technician profile rather than removing
> them. The implementation removes those rows explicitly first.

**Implemented behaviour:**

1. Requires a valid session **and** the account password **and** the exact phrase
   `DELETE MY ACCOUNT`. A stolen live session alone is insufficient. The subject is always the
   authenticated principal — there is no client-supplied user id.
2. In one transaction: reviews authored → service requests (cascading offers/reviews) →
   technician profile (cascading offers received, verification documents, reviews about it) →
   notifications → push subscriptions → sessions → the account row.
3. Post-commit and best-effort: unlinks the owned profile photo and verification document
   files through the real `FileStorage` abstraction (provider-neutral; no Supabase Storage is
   assumed or introduced).
4. A **read-only preview** route shows real counts — including the number of security events
   that will be retained — so the confirmation screen states facts rather than a generic
   warning.
5. Sessions are revoked by their removal, so the account cannot be used again.

**Deliberate, documented consequences:**

- Reviews written by *other* customers about a deleted technician profile are removed with it
  (`reviews.technician_id` is `NOT NULL` and cascades). A review cannot exist without a
  subject; the rating and job-count aggregates disappear with it.
- **Security events are retained** in minimised form. `audit_events` deliberately has **no
  foreign key** to `users`, so honouring an erasure request does not destroy the
  accountability record.
- If storage unlink fails, the deletion still succeeds and the failure is logged. An orphaned
  file is unreachable, because bytes are only served after a database key lookup and that row
  no longer exists.
- The system revokes its own sessions and removes its own records. It has **no mechanism** to
  request deletion from a push service or any other third party, and does not claim to.

### G-07 — Administrative account suspension does not revoke push capability

| Column | Value |
|---|---|
| **Requirement** | Security; access control |
| **Current implementation** | `PATCH /api/v1/admin/users/:id/status` flips `account_status` to `suspended`/`disabled`, which does block login and API access. The user's `push_subscriptions` rows are untouched, and `PushService` selects subscriptions by `user_id` only |
| **Evidence** | `backend/src/server.ts` admin status route (updates `users.account_status` only); `pushService.ts` selects on `user_id` with no account-status join |
| **Gap** | Notifications can continue to be pushed to a suspended account's devices until the subscription is removed or the provider rejects it |
| **Planned stage** | **28.3F** (audit/control hardening) |
| **Priority** | **P3** |

### G-08 — No audit logging of privileged or state-changing activity — **RESOLVED in 28.3F**

| Column | Value |
|---|---|
| **Requirement** | Accountability |
| **Status** | **RESOLVED (Task 28.3F).** `audit_events` (migration `006`) plus `backend/src/privacy/auditService.ts`. |
| **Priority** | **P2** |

**Implemented events** (a closed vocabulary, so a typo cannot create an unreadable type):

| Event | Recorded when |
|---|---|
| `auth.login_failed` | Failed sign-in. **No email, no user id** — a null actor, so the log cannot be mined to enumerate accounts |
| `auth.login_succeeded` | Successful sign-in |
| `auth.account_locked` | Password proven but the account is suspended/disabled |
| `admin.user_status_changed` | An administrator changes an account's status, with previous → new |
| `account.suspended` | The specific suspension/disablement event |
| `admin.verification_decision` | A verification approve/reject. The **rejection reason is not copied** — it is free text that can quote document content |
| `security.verification_document_accessed` | Document bytes are read, distinguishing **owner** from **reviewer** |
| `security.verification_document_deleted` | A document is withdrawn |
| `privacy.data_exported` | A data export is generated (counts only, never contents) |
| `privacy.account_deleted` | A deletion completes, **or** is denied for a wrong password |

**Three design decisions that matter:**

1. **No foreign key to `users`, on purpose.** An audit record is about a person, not owned by
   them. An FK would make permanent deletion either impossible or destructive of the security
   history. Plain UUIDs let the person's rows vanish while accountability survives, minimised.
2. **No IP address column, on purpose.** The system stores client IPs nowhere. Adding broad IP
   collection as a side effect of a logging feature would introduce a new, pervasive
   personal-data category. It is not introduced.
3. **Allow-listed metadata.** Only low-cardinality technical keys are accepted, values are
   restricted to primitives, and an over-length value is dropped rather than truncated. A
   nested payload cannot smuggle personal data into the log.

Auditing is **log-and-continue**: a write failure is logged and swallowed, so it can never fail
or roll back the business operation it describes. The administrator view is
`GET /api/v1/admin/audit-events` (`requireRole('administrator')`, paginated, filterable);
ordinary users reach their own history through their data export instead.

**Not covered (unchanged, and stated):** request status *history* is still not preserved — only
the current status and `updated_at`. Access-token issuance and rate-limit events are still not
persisted. Administrator *reads* of `admin/users` and `admin/requests` are not individually
logged (see G-04).

### G-09 — "AI-assisted" framing does not match the implementation

| Column | Value |
|---|---|
| **Requirement** | Accuracy of documentation; automated-decision transparency |
| **Current implementation** | `POST /api/v1/classify` is a **deterministic ordered keyword-regex chain** (plumbing → electrical → automotive → IT → appliance) returning a single category or `null`. **No model, no inference call, no external AI vendor, no confidence score**, and the route is **unauthenticated** |
| **Evidence** | `backend/src/server.ts` `classifyCategory()` — `t.match(/leak\|tap\|pipe\|toilet\|drain/)?.input ?? …`; no `requireAuth` on the route; no AI dependency in `backend/package.json` |
| **Gap** | Two distinct issues. (a) *Documentation accuracy*: any narrative calling this "AI classification" overstates it. (b) *Exposure*: an unauthenticated endpoint accepts customer free text; there is no stated limit on volume or intent |
| **Planned stage** | Documentation correction is immediate (this stage). Exposure limit → **28.3H** or hardening |
| **28.3B–28.3I status** | **Documentation corrected and still accurate.** `docs/PRIVACY_POLICY.md` and the DPIA both describe `POST /classify` as a deterministic, local, advisory keyword check — explicitly "not an AI or machine-learning model", with no data sent to any provider. No document describes it as AI. The unauthenticated exposure remains open (it is rate limited) |
| **Priority** | **P3** (low risk precisely *because* it is deterministic) |

### G-10 — No processor arrangements or third-party register

| Column | Value |
|---|---|
| **Requirement** | Accountability for third-party processing |
| **Current implementation** | Three external parties are capable of receiving personal data — the database/storage host, the browser push provider, and (if activated) Africa's Talking. **No data-processing agreement, no sub-processor register, and no vendor inventory exists in the repository** |
| **Evidence** | `backend/src/db/client.ts` (pooled connection), `backend/src/notifications/pushService.ts` (`web-push` POST to vendor endpoint), `backend/src/notifications/notificationService.ts` (`ConfigurableSmsProvider`) |
| **Gap** | Commercially deploying requires arrangements that have not been started, and the third-party inventory that a privacy notice must list does not exist |
| **Planned stage** | **28.3H** |
| **Priority** | **P2** |

### G-11 — Cross-border processing status unestablished

| Column | Value |
|---|---|
| **Requirement** | Transparency; accountability for transfer of personal data |
| **Current implementation** | The architecture can transmit personal data outside Zambia — notification payloads (which can contain a name or a rejection reason) go to the browser push vendor; a future SMS path would send message content plus a telephone number; the database host is external. **The repository contains no evidence of any provider's processing location**, and no region is configured |
| **Evidence** | No region/endpoint configuration for the database or push service; Africa's Talking endpoint hard-coded as the provider's public API; storage is local today |
| **Gap** | The question the DPC registration process asks — is personal data stored outside Zambia — **cannot be answered from the repository** |
| **Planned stage** | **28.3H** (+ deployment checklist) |
| **Recorded position** | **"Provider/infrastructure location requires deployment-time confirmation."** No claim is made either way |
| **Priority** | **P1** for deployment |

### G-12 — Legal and organisational basis unconfirmed

| Column | Value |
|---|---|
| **Requirement** | Legal basis; accountability |
| **Current implementation** | The project operates with no documented legal-basis analysis, no consent record, no breach-handling procedure, no data-protection-officer designation, and no registration status. The official legal sources were unreachable during this stage, so even the statutory terminology is unverified |
| **Evidence** | No such documents exist in the repository; `docs/` contained no privacy material before this stage |
| **Gap** | Everything statutory is an organisational/legal workstream, not an engineering one |
| **Planned stage** | **28.3I** (DPIA) and **28.3J** (final verification); legal-basis analysis should precede 28.3B |
| **Priority** | **P2** |

---

## 2. Data-subject rights matrix

**Updated after Task 28.3 (28.3B–28.3J).** Access, portability, erasure, and the notification
inbox are now implemented. The statutory wording and section mapping still require legal
confirmation (G-12), so this matrix records **technical** support, not legal conclusions.

| Right | Relevant Umodzi data | Current technical support | Missing control | Status |
|---|---|---|---|---|
| **Right to information** | Everything; especially location collection, document handling, third parties | `docs/PRIVACY_POLICY.md`; a live `/privacy` page; a concise disclosure with a working link on the registration form; a link from privacy settings | A named privacy contact and complaints route (open item) | **Implemented (28.3B)**, contact open |
| **Right of access** | Own account, profile, requests, offers, reviews, notifications, subscriptions | **Implemented.** `GET /api/v1/me/data` returns a consolidated export; `GET /api/v1/me/notifications` is a real inbox (G-02 closed) | — | **Implemented (28.3C)** |
| **Right to correction** | Own name, email, bio, category, skills, availability, service area, account status | **Partial.** Technician can edit bio/category/skills/availability/service area; **name and email are not self-service editable** | Self-service identity-field edit; a correction path for verification rejection reasons | **Open** |
| **Right to erasure** | Account, profile, requests, offers, reviews, notifications, subscriptions, verification documents, profile photo | **Implemented.** `DELETE /api/v1/me/account` — real deletion, password + phrase confirmed, storage objects unlinked, sessions revoked, retained security events disclosed beforehand | — | **Implemented (28.3D)** |
| **Right to object** | Notifications/push to a user's devices; location use for dispatch | **Partial.** `DELETE /me/push-subscriptions/:id` is a real, working objection for the push channel, and deleting the account withdraws consent for everything | A general objection mechanism for processing that is not channel-specific | **Partial** |
| **Right to restrict / limit processing** | Any category; most acutely verification (a pending document) | **None.** No state gates processing | A restriction state honoured across notifications and dispatch | **Open** |
| **Right to data portability** | Own account + technician data, machine-readable | **Implemented.** `GET /api/v1/me/data` → `umodzi-account-export-v1` JSON, generated per request, downloaded in the browser; nothing stored | — | **Implemented (28.3C)** |
| **Rights relating to automated decision-making** | Category classification; dispatch ordering; eligibility rules | **Strong position.** Classification is deterministic keyword rules, not a learned model, and is **advisory only**; eligibility is explicit, inspectable rules with human-readable reasons. Disclosed accurately in the notice and DPIA | — | **Implemented (28.3B, 28.3I)** |
| **Complaint / reporting path** | Any processing activity | **None.** No named contact or documented internal procedure | A published channel and handling procedure | **Open — stated, not faked** |

### Automated-decision findings (accurate statement)

- **Where assistance occurs:** one function, `POST /api/v1/classify`.
- **Input:** the customer's own free-text description, 1–2000 characters, lowercased.
- **Output:** one canonical category string, or `null` when nothing matches.
- **Confidence/fallback:** **no confidence value exists**; unmatched input returns `null` and the
  customer must pick a category manually.
- **Manual fallback:** present — the category is a customer selection on the request.
- **Human intervention:** yes — the customer decides the final category, and the technician
  decides whether to accept an offer. **No automated decision is made about a person and is then
  treated as final.**
- **Dispatch:** ordering uses `candidate_index` from explicit, inspectable rules (canonical
  category match, optional PostGIS distance cap, availability, verification state). The
  technician retains the accept/reject choice. No ranking model exists.
- **Conclusion:** the algorithmic surface is currently **lower risk** than a learned model would
  be, because it is deterministic and advisory. The obligation is to describe it accurately
  rather than to overstate it.

---

## 3. Principle-by-principle analysis

| Requirement / principle | Current implementation (after Task 28.3) | Evidence | Remaining gap | Status |
|---|---|---|---|---|
| **Transparency** | `docs/PRIVACY_POLICY.md`; live `/privacy` page; concise registration disclosure with a working link; linked from privacy settings | `frontend/lib/privacy/notice.ts`, `frontend/app/privacy/page.tsx` | No named privacy contact | **Implemented**, contact open |
| **Purpose limitation** | Purposes are now documented per activity. Location is collected for proximity and, since 28.3A.1, is **no longer published** | `server.ts` public projections; `authorization.ts` internal `ST_Distance`; `PRIVACY_POLICY.md` §3 | — | **Resolved** |
| **Data minimisation** | Coordinates absent from public payloads; export excludes credentials, keys and document bytes; audit metadata is allow-listed; **no IP storage** | `server.ts`; `accountDataService.ts`; `auditService.ts`; `006` migration | Over-retention of most categories (G-05) | **Substantially resolved** |
| **Accuracy** | Rejection reasons remain free text with no length policy; no self-service name/email change; **no correction path for identity fields** | `003` migration; `auth/routes.ts` | G-03 open; identity correction open | **Open** |
| **Storage limitation** | Documented schedule; enforced purge for sessions and read notifications; explicit operator-invoked sweep; **no autonomous job** | `retentionService.ts`; `DATA_RETENTION_POLICY.md` | Most categories have no agreed period | **Partially resolved** |
| **Security of processing** | argon2id, HS256 JWT, hashed refresh tokens with reuse detection, role/ownership guards, CORS allow-list, per-route rate limits, security headers, 5 MB upload cap, magic-byte validation, private document storage, `no-store` on document bytes, key traversal rejection, existence-hidden 404s, **audit logging** | `auth/*`, `server.ts`, `storage/*`, `auditService.ts` | Push subscriptions survive suspension (G-07); no MFA; no breach procedure | **Improved** |
| **Data-subject rights** | Access, portability, erasure and the notification inbox **implemented**; push unsubscribe works | `GET /me/data`, `DELETE /me/account`, `GET /me/notifications*` | Restriction right; identity-field correction; general objection | **Mostly implemented** |
| **Automated decision-making** | Deterministic, advisory, non-final; no model. Disclosed accurately in the notice and DPIA | `server.ts` `classifyCategory()`; `PRIVACY_POLICY.md` §6; DPIA §8 | Unauthenticated exposure (G-09) | **Accurate**, exposure open |
| **Third-party processors** | A provider register exists, distinguishing implemented / inactive / planned, with no invented locations or terms | `THIRD_PARTY_PROCESSORS.md` | No contractual arrangements established | **Documented** |
| **Cross-border processing** | Still unestablished, and documented as unestablished | `THIRD_PARTY_PROCESSORS.md` §2 | Cannot answer the storage-location question (G-11) | **Open — deployment** |
| **Breach handling** | **Still no procedure.** The audit log provides evidence, but there is no runbook, notification channel or evidence-preservation policy | `auditService.ts`; no organisational document | G-12 / DPIA R10 | **Open** |
| **Retention** | Sessions and read notifications purged on an explicit idempotent sweep; policy documents all 15 categories | `retentionService.ts`; `DATA_RETENTION_POLICY.md` | Periods unconfirmed | **Partially resolved** |
| **Deletion / erasure** | Real deletion with storage unlink, session revocation, and disclosed retained security events | `accountDataService.ts`; `DELETE /me/account` | — | **Implemented (28.3D)** |
| **Access / export** | Consolidated owner-scoped JSON export and a real notification inbox | `GET /me/data`; `GET /me/notifications*` | — | **Implemented (28.3C)** |
| **Privacy notice** | Published in-repo and in-app, with registration disclosure | `PRIVACY_POLICY.md`; `/privacy`; `AuthForm.tsx` | Contact/escalation route | **Implemented** |
| **Consent / legal basis** | **No consent record is stored, by design.** The registration checkbox is a UI gate; the absence of a consent store is documented as pending legal confirmation | `AuthForm.tsx`; `PRIVACY_POLICY.md` §13 | Basis undocumented per purpose | **Open — legal** |
| **DPC registration / deployment obligations** | Not established; legal sources remain unreachable | This document's header | Registration status, DPO designation, processor obligations | **Open — legal** |

---

## 4. Prioritised action order (after Task 28.3)

**Completed:**

1. **G-01 — DONE (28.3A.1).** Precise technician coordinates are no longer published by any
   public endpoint; coarse `serviceArea` and a 100 m-bucketed `distance_meters` are used instead,
   and `/nearby` is rate limited.
2. **G-02 — DONE (28.3C).** A real owner-scoped notification inbox now exists, so the notice
   describes a surface that genuinely exists.
3. **G-06 — DONE (28.3D).** Permanent deletion, including the `ON DELETE SET NULL` trap that
   would otherwise have orphaned requests and profiles.
4. **G-08 — DONE (28.3F).** `audit_events` with no FK to `users`, no IP storage, and
   allow-listed metadata.

**Still required before a production launch:**

5. **G-11** — establish provider and infrastructure locations (deployment-time; the
   storage-location question cannot be answered until then).
6. **G-12** — legal basis, registration status, DPO designation, breach procedure, and a named
   complaints route.
7. **G-05 (remaining)** — agree retention periods for requests, offers, reviews, verification
   documents and security events, then decide whether to automate the sweep.
8. **G-04 (remaining)** — decide whether administrator *reads* of `admin/users` and
   `admin/requests` should be individually logged.

**Hardening, still open:**

9. **G-03** — bound and moderate administrator-authored rejection text.
10. **G-07** — revoke push subscriptions on account suspension (needs a product decision).
11. **G-09** — keep documentation aligned with the deterministic classifier; consider limiting
    the unauthenticated `/classify` endpoint.
12. **Self-service correction of name/email**, and a **restriction** state — both absent.
3. **G-04** — decide and document the administrator privileged-access boundary.

**Before production launch:**

4. **G-05 / G-06** — retention and deletion semantics (28.3E, 28.3D).
5. **G-11** — establish provider and infrastructure locations for the cross-border question.
6. **G-10** — processor inventory and arrangements (28.3H).
7. **G-12** — legal-basis, breach procedure, registration status (28.3I, 28.3J).

**Hardening:**

8. **G-03** — bound and moderate administrator-authored rejection text.
9. **G-07** — revoke push subscriptions on account suspension.
10. **G-09** — keep documentation aligned with the deterministic classifier; consider limiting
    the unauthenticated `/classify` endpoint.

---

## 5. What was deliberately **not** done

### 5.1 In 28.3A (documentation only)

No endpoint, table, migration, job, component or configuration was added or changed. G-01 was
recorded rather than patched **at that time**.

### 5.2 In 28.3A.1 (location correction only)

Three public projections, one frontend mapping boundary, one map-data helper and one rate
limit. No schema change, no new table, no retention change.

### 5.3 In 28.3B–28.3J (privacy implementation)

Implemented: the notice and registration disclosure; the data export; permanent account
deletion; the documented retention policy with a safe operator-invoked sweep; the audit log
and its integrations; verification-document hardening (`no-store`, filename sanitising, access
auditing); the notification inbox; and the four new documents.

**Deliberately not done, and why:**

- **A consent database.** No consent record is stored. Inventing a consent store to look
  compliant would create a new personal-data category and a false assurance; the lawful basis
  is unconfirmed. The registration checkbox is a UI gate and is labelled as such.
- **An SMS pipeline.** Migration `008_communication_phone.sql` adds `user_phones`, an optional
  self-service number (`purpose = 'service_contact'`) used by exactly one route,
  `GET /api/v1/requests/:id/contact`, to offer a `tel:` link. It is deliberately **not** connected
  to any SMS provider: no route calls `ConfigurableSmsProvider` and no notification type is
  SMS-eligible, so SMS stays inactive. Purpose, E.164-style validation, owner-only visibility and
  `ON DELETE CASCADE` deletion are in place; retention period for an idle number remains open.
- **A Supabase Storage client.** The storage abstraction is provider-neutral and `LocalFileStorage`
  remains the only implementation. Object storage is recorded as a **deployment requirement**.
- **An AI/classification vendor.** Classification remains deterministic and local.
- **Attachments, typing, reactions, edit/delete, presence, voice/video and group chat.** Task
  28.4 delivered plain-text chat only: `/dashboard/messages` (conversation list) and
  `/dashboard/messages/[conversationId]` (thread), over REST plus an optional WebSocket
  transport. The sidebar "Messages" item now points at the real list; none of the excluded
  features is implemented or claimed anywhere.
- **An autonomous retention scheduler.** No `setInterval` or cron entry exists; cleanup is
  operator-invoked, deterministic and idempotent.
- **IP-address collection.** Not introduced, deliberately, in either the app or the audit log.
- **Bounding the administrator rejection-reason field (G-03).** Would change an existing data
  field and notification contract; left open rather than done quietly.
- **Self-service name/email correction** and a **restriction** state. Absent, and recorded as
  missing rather than implied.