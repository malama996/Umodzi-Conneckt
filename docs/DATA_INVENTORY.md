# Umodzi Connect — Data Inventory

**Task:** 28.3A (discovery) — updated by **28.3A.1** (location correction),
**28.3B–28.3J** (privacy implementation) and **28.4A–28.4C** (communication: conversations,
messages, realtime transport and phone contact).
**Stage scope:** 28.3A was discovery/classification/documentation only. 28.3A.1 and 28.3B–J
changed code and schema; those changes are reflected below and are labelled.
**Build basis:** Direct source inspection of the running codebase and the eight applied database
migrations. Every "verified" claim below cites the file it was read from.

> **Status of this document.** Umodzi Connect is an academic project. Nothing here asserts that
> the platform is legally compliant, registered with the Data Protection Commission (DPC), or has
> appointed a data protection officer. Statements describe what the code **does**, what it is
> **designed to support**, and what remains an **identified requirement** or a **deployment
> requirement**. Legal characterisation is explicitly left open for confirmation.

---

## 0. Method and verification basis

| Basis | Where read |
|---|---|
| Schema (authoritative) | `backend/src/db/migrations/001_initial_schema.sql` … `006_privacy_and_audit.sql` |
| API surface + visibility | `backend/src/server.ts`, `backend/src/auth/routes.ts` |
| Auth/session crypto | `backend/src/auth/{password,sessionService,jwt,authService,authorization,authMiddleware}.ts` |
| Notifications/push | `backend/src/notifications/{notificationService,pushService}.ts` |
| Privacy services (28.3) | `backend/src/privacy/{auditService,accountDataService,retentionService}.ts` |
| Communication + phone (28.4) | `backend/src/privacy/communicationAuth.ts`, `backend/src/realtime/websocketServer.ts`, communication routes in `backend/src/server.ts` |
| Storage | `backend/src/storage/{fileStorage,fileValidation}.ts` |
| Frontend behaviour | `frontend/app/**`, `frontend/components/**`, `frontend/lib/**`, `frontend/.env.example` |

**Applied migration set:**
`001_initial_schema.sql`, `002_authentication.sql`, `003_technician_verification.sql`,
`004_reviews.sql`, `005_notifications_and_push.sql`, **`006_privacy_and_audit.sql`** (added by
28.3F — the `audit_events` table; see §1.10), **`007_communication.sql`** (added by 28.4A —
`conversations` + `messages`, see §1.11) and **`008_communication_phone.sql`** (added by 28.4B —
`user_phones`, see §1.11).

**Data that is NOT collected** (explicitly verified absent, so it is not inventoried as if it
were): IP address of the user, date of birth, national ID *number*, payment or card data,
biometric data, precise customer GPS coordinates at request time, analytics/advertising
identifiers, third-party tracking cookies.

**Data that became collectable in 28.4:** a telephone number. It is **optional**, stored only
if the user types one themselves (`user_phones`, §1.11), read only by the owner and by the
other participant of that user's own accepted service request, and never inferred from any
other field. No number exists in the repository, in fixtures or in logs.

---

## 1. Data categories

Eleven categories are processed. Each is described with fields, subject, classification,
visibility, storage and purpose. Visibility values used:

`public` (no authentication) · `authenticated` · `owner-only` · `relationship-scoped`
(only the other participant of that specific request/offer) · `administrator-only` ·
`backend-only` · `private storage object` (bytes never leave the storage adapter directly).

---

### 1.1 Identity & account data

**Source of truth:** `users`, `sessions` (migration `002_authentication.sql`).

| Field | Column | Type | Classification |
|---|---|---|---|
| User id | `users.id` | UUID | ordinary personal data (pseudonymous identifier) |
| Email address | `users.email` | TEXT, unique on `lower(email)` | ordinary personal data (contact) |
| Password | `users.password_hash` | TEXT (argon2id digest) | confidential/security-sensitive |
| Role | `users.role` | TEXT CHECK `customer`\|`technician`\|`administrator` | ordinary (account/security) |
| First name | `users.first_name` | TEXT | ordinary (identity) |
| Last name | `users.last_name` | TEXT | ordinary (identity) |
| Account status | `users.account_status` | TEXT CHECK `active`\|`suspended`\|`disabled` | ordinary (account/security) |
| Created / updated | `users.created_at`, `users.updated_at` | TIMESTAMPTZ | ordinary (metadata) |
| Session id | `sessions.id` | UUID | confidential/security-sensitive |
| Refresh token | `sessions.token_hash` | TEXT, unique — SHA-256 hex of the raw token | confidential/security-sensitive |
| Session expiry | `sessions.expires_at` | TIMESTAMPTZ | confidential/security-sensitive |
| Revocation | `sessions.revoked_at`, `sessions.revoked_reason` | TIMESTAMPTZ / TEXT | confidential/security-sensitive |
| Session activity | `sessions.created_at`, `sessions.last_used_at` | TIMESTAMPTZ | confidential/security-sensitive |

**Data subjects:** customers, technicians, administrators.

**Purpose:** create and authenticate accounts, hold authorisation role, maintain revocable
refresh sessions so an access token can be re-issued without re-entering a password.

**Storage:** PostgreSQL (`users`, `sessions`). `sessions.user_id` cascades on user delete.

**Visibility**
- Own email/name/role/status: `owner-only` via `GET /api/v1/auth/me`.
- Own email/name/role/status of **any** user: `administrator-only` via `GET /api/v1/admin/users`.
- Password hash, session rows, token hashes: `backend-only`. Verified absent from every response
  projection (`authService.ts` builds user shapes from explicit column lists; `login` returns
  `id, email, role, firstName, lastName, accountStatus, createdAt`).
- Administrator **email** is visible to administrators (`admin/users` projection selects
  `email`). Flagged in the gap analysis.

**Security properties (verified in code)**
- Passwords: `argon2id` only (`auth/password.ts`); plaintext never stored or logged.
- Generic single login error + dummy-hash timing equalisation (`authService.ts`).
- Refresh token: opaque 256-bit random value; only its SHA-256 hash is persisted; the raw value
  lives solely in an HttpOnly cookie (`auth/sessionService.ts`, `auth/routes.ts`).
- Access token: HS256 JWT with `sub`, `role`, `jti`; issuer/audience/expiry verified on every
  protected route (`auth/jwt.ts`).

---

### 1.2 Technician profile data

**Source of truth:** `technicians` (migration `001`, extended by `002` and `003`).

| Field | Column | Type | Classification |
|---|---|---|---|
| Technician id | `technicians.id` | UUID | ordinary (identifier) |
| Linked account | `technicians.user_id` | UUID → `users.id`, **nullable** | ordinary (identifier link) |
| Display name | `technicians.name` | TEXT | ordinary (identity) |
| Category | `technicians.category` | TEXT (canonical enum) | professional |
| Skills | `technicians.skills` | JSONB | professional |
| Service area | `technicians.service_area` | TEXT (canonical enum) | ordinary (coarse location) |
| Latitude / longitude | `technicians.latitude`, `.longitude` | DOUBLE PRECISION, nullable | **location — higher-risk; internal use only since 28.3A.1** (never projected publicly) |
| PostGIS point | `technicians.location` | `GEOGRAPHY(POINT, 4326)` NOT NULL, GiST index | **location — higher-risk; internal use only since 28.3A.1** (used in SQL predicate/ordering, never projected) |
| Rating | `technicians.rating` | DOUBLE PRECISION | reputation |
| Jobs completed | `technicians.jobs` | INTEGER | professional/reputation |
| Verified flag | `technicians.verified` | BOOLEAN | reputation |
| Availability | `technicians.availability`, `.availability_status` | TEXT | professional |
| Account status | `technicians.account_status` | TEXT | ordinary (account/security) |
| Bio | `technicians.bio` | TEXT (nullable, added in `003`) | ordinary (professional) |
| Photo reference | `technicians.photo_key` | TEXT (nullable) | private storage object reference |
| Created / updated | `technicians.created_at`, `updated_at` | TIMESTAMPTZ | ordinary (metadata) |

**Data subjects:** technicians. Registration captures **name, category, service area** only
(`authService.ts` registration schema: `email, password, firstName, lastName, role, category?,
serviceArea?`). Bio is set later via `PATCH /api/v1/technician/profile`.

**Purpose:** present a technician to customers as a discoverable service provider, record
professional capability, support dispatch eligibility, and drive public reputation display.

**Storage:** PostgreSQL `technicians`; photo bytes in the storage adapter.

**Visibility — verified against the live projections in `server.ts`**

| Surface | Guard | Exposed |
|---|---|---|
| `GET /api/v1/technicians` | **none (public)** | id, name, category, skills, **serviceArea** (coarse location), rating, jobs, verified, availability, availabilityStatus, accountStatus, bio, hasPhoto, createdAt, updatedAt — **no coordinate** (28.3A.1) |
| `GET /api/v1/technicians/:id` | **none (public)** | same field set — **no coordinate** (28.3A.1) |
| `GET /api/v1/technicians/nearby` | **none (public), rate limited 30/min** | same field set, **no coordinate**, **plus** `distance_meters` coarsened to a 100 m bucket (28.3A.1) |
| `GET /api/v1/technicians/:id/reviews` | **none (public)** | rating aggregate + review list (see 1.8) |
| `GET /api/v1/technicians/:id/photo` | **none (public, by design)** | photo bytes, `Cache-Control: public, max-age=60` |
| `GET /api/v1/technician/profile` | `requireRole('technician')`, own profile only | full own profile incl. verification state and document list |
| `PATCH /api/v1/technician/profile` | `requireRole('technician')` | mutates bio/category/skills/availability/service area |
| `GET /api/v1/admin/technicians` | `requireRole('administrator')` | administrative technician list |

> **Finding G-01 — CORRECTED in Task 28.3A.1 (2026-10-08).** At 28.3A this was recorded as the
> highest-priority finding: a technician's **precise latitude/longitude and their PostGIS point
> were returned by three unauthenticated endpoints.** Those coordinates exist to support internal
> PostGIS proximity checks, not to be published.
>
> **28.3A.1 removed the coordinate from all three public projections.** Public technician
> information now conveys location as the self-declared `serviceArea` only.
> `GET /technicians/nearby` keeps its PostGIS radius search (the `location` point is used in the
> SQL predicate and ordering only, never projected) and returns `distance_meters` rounded to a
> **100 m bucket**; that route is now **rate limited**. The columns remain in the schema for
> internal dispatch use (`assertOfferEligibility` still reads them).
>
> On the frontend, `technicianMapper.ts` no longer maps any coordinate into the `Technician`
> object, and the prototype map derives a **coarse service-area city-centre** marker from
> `serviceArea`. So a server-provided coordinate cannot re-enter the UI as display data.
>
> Verified by `backend/scripts/task28-3a1-location-privacy-tests.ts` (48/48) and
> `backend/scripts/verify-28-3a-docs.ts` (118/118). Residual risk and a pre-existing
> malformed-UUID behaviour on `GET /technicians/:id` are documented in
> `PRIVACY_IMPLEMENTATION_GAP_ANALYSIS.md` under G-01.

**Data subject:** technician. Note that `technicians.user_id` is **nullable**: seed/legacy rows
belong to nobody. This is why D1 notification delivery safely skips those rows.

---

### 1.3 Verification data — **higher-risk personal data**

**Source of truth:** `technician_verification_documents` + the `verification_*` columns on
`technicians` (migration `003_technician_verification.sql`).

| Field | Column | Type | Classification |
|---|---|---|---|
| Document id | `technician_verification_documents.id` | UUID | higher-risk (identifier) |
| Owner technician | `.technician_id` | UUID → `technicians.id` CASCADE | higher-risk |
| Document type | `.document_type` | TEXT CHECK `national_id`\|`certificate`\|`other` | higher-risk |
| Original filename | `.file_name` | TEXT | higher-risk (may embed identity) |
| MIME type | `.content_type` | TEXT | higher-risk |
| Size | `.size_bytes` | INTEGER CHECK > 0 | ordinary (metadata) |
| Storage reference | `.storage_key` | TEXT (opaque) | higher-risk |
| Uploaded at | `.created_at` | TIMESTAMPTZ | ordinary (metadata) |
| Verification status | `technicians.verification_status` | TEXT CHECK `unverified`\|`pending`\|`verified`\|`rejected`, default `unverified` | higher-risk |
| Rejection reason | `technicians.verification_rejection_reason` | TEXT, nullable | **higher-risk — may quote document content** |
| Submitted at | `technicians.verification_submitted_at` | TIMESTAMPTZ | higher-risk |
| Reviewed at | `technicians.verification_reviewed_at` | TIMESTAMPTZ | higher-risk |
| Reviewer identity | `technicians.verification_reviewed_by` | UUID → `users.id`, `ON DELETE SET NULL` | higher-risk (identifies the deciding human) |

**Why this is the highest-risk category in the system.** Uploaded `national_id` documents can
contain a photograph of a face, a government identity number, signature and date of birth. The
system stores the file bytes and receives an administrator-authored free-text rejection reason
which can quote that content. A reviewer identity is recorded against every decision.

**Purpose:** establish that a technician is who they claim to be and is qualified, so customers
can rely on the `verified` flag before booking.

**Storage:** metadata in PostgreSQL; **bytes in the storage adapter** under an opaque key shaped
`verification/<technicianId>/<docId>.<ext>` (`fileStorage.ts` doc comment).

**Visibility (verified from `server.ts` + `task26` regression expectations)**
- Upload / list own documents: `owner-only` (`requireRole('technician')`).
- Delete own document: `owner-only`; blocked with 409 once verification is submitted/decided.
- `GET /api/v1/verification-documents/:id/file`: authenticated; returns 404 (not 403) for
  another technician's document and 401 when anonymous — cross-technician isolation is
  deliberate so existence does not leak.
- `GET /api/v1/admin/technicians/:id/verification` and
  `PATCH /api/v1/admin/technicians/:id/verification`: `requireRole('administrator')`.
- **Never** exposed on any public technician projection: verified — the public
  `TechnicianApi` shape carries `verified`/`hasPhoto` but not `verification_status`,
  `verification_rejection_reason`, `verification_reviewed_by`, or any document metadata.
  `task26` asserts the public projection hides `verification_status` and `photo_key`.

**Not collected (verified):** the national ID *number* is never extracted into a structured
column. The system only holds the uploaded artefact.

---

### 1.4 Service-request data

**Source of truth:** `service_requests` (migration `001`, extended by `002`).

| Field | Column | Type | Classification |
|---|---|---|---|
| Request id | `id` | UUID | ordinary (identifier) |
| Owning customer | `customer_user_id` | UUID → `users.id`, **nullable** | ordinary (identifier link) |
| Description | `description` | TEXT | ordinary — **free text, may contain personal detail** |
| Category | `category` | TEXT | ordinary |
| City | `city` | TEXT | ordinary (coarse location) |
| Latitude / longitude | `latitude`, `longitude` | DOUBLE PRECISION, nullable | **location — higher-risk** |
| Status | `status` | TEXT | ordinary (transactional) |
| Created / updated | `created_at`, `updated_at` | TIMESTAMPTZ | ordinary (metadata) |

**Data subjects:** customers (authors); technicians and administrators (readers, per scope).

**Purpose:** capture what service a customer needs and where, so a matching technician can be
dispatched.

**Storage:** PostgreSQL `service_requests`.

**Coordinates — important distinction (verified):** the columns exist and are schema-ready, but
**the API does not currently accept or populate them.** `POST /api/v1/requests` takes
`description`, `category`, `city` only; `backend/.env.example` records this explicitly
("API-created requests currently do not [carry coordinates], so the city match remains the
operative rule"). Verified on the live database: **zero** `service_requests` rows carry
coordinates.

No real customer GPS fix exists in the system today. Precisely: there is **no geolocation API
call anywhere in the frontend code** — no `getCurrentPosition`, no `watchPosition`, no
`navigator.geolocation` call in `frontend/app/**`, `frontend/components/**` or
`frontend/lib/**`. The word "geolocation" does appear twice, but only inside **comments** in
`frontend/lib/mapData.ts`, describing a documented replacement seam for a future task; that file
also states its coordinates are deterministic mock values and that it performs no geolocation.

**Visibility**
- `GET /api/v1/requests/:id`: `requireAuth` + owner-or-participant scoping (`loadRequestForUser`)
  — strangers get 404 so existence does not leak.
- `PATCH /api/v1/requests/:id/status`: `requireAuth` + `assertRequestStatusWriteScope`
  (customer owns it; technician limited to `matched`/`no_match` on requests holding one of their
  offers; administrator may write).
- `GET /api/v1/admin/requests`: `requireRole('administrator')` — and this projection **does**
  include `customerEmail` and the customer's full name (`server.ts` ~line 1461).

---

### 1.5 Dispatch / offer data

**Source of truth:** `dispatch_offers` (migration `001`).

| Field | Column | Type | Classification |
|---|---|---|---|
| Offer id | `id` | UUID | ordinary (identifier) |
| Request | `request_id` | UUID → `service_requests.id` CASCADE | ordinary (relationship) |
| Technician | `technician_id` | UUID → `technicians.id` CASCADE | ordinary (relationship) |
| **Dispatch order** | `candidate_index` | INTEGER NOT NULL | ordinary — **ranking/dispatch metadata** |
| Status | `status` | TEXT (`pending`\|`accepted`\|`rejected`\|`timed_out`) | ordinary (transactional) |
| Created / updated | `created_at`, `updated_at` | TIMESTAMPTZ | ordinary (metadata) |

**Data subjects:** customers and technicians (the two parties), and administrators (monitors).

**Purpose:** record who was offered a given request, in what order they were considered, and how
the offer resolved. `candidate_index` is the persisted ordering of the dispatch pipeline.

**Storage:** PostgreSQL `dispatch_offers`.

**Visibility**
- `GET /api/v1/requests/:requestId/offers`: authenticated, owner/participant scoped.
- `GET /api/v1/offers/technician/:technicianId`: authenticated; a technician may read only their
  own offers (403 "you may only read your own offers"); only technician role may read that route.
- `POST /api/v1/offers`: authenticated, request-owner scoped, with server-side eligibility
  enforcement (`assertOfferEligibility`).
- Accept / reject / timeout: authenticated with role- and ownership-specific guards.

---

### 1.6 Review / rating data

**Source of truth:** `reviews` (migration `004_reviews.sql`).

| Field | Column | Type | Classification |
|---|---|---|---|
| Review id | `id` | UUID | ordinary (identifier) |
| Reviewer | `customer_id` | UUID → `users.id` CASCADE | ordinary (identifier link) |
| Technician reviewed | `technician_id` | UUID → `technicians.id` CASCADE | ordinary (relationship) |
| Request | `service_request_id` | UUID → `service_requests.id` CASCADE | ordinary (relationship) |
| Rating | `rating` | INTEGER, CHECK-constrained | reputation |
| Free text | `comment` | TEXT, nullable | ordinary — **free text, may contain personal detail** |
| Created / updated | `created_at`, `updated_at` | TIMESTAMPTZ | ordinary (metadata) |

**Data subjects:** customers (authors) and technicians (subjects of the reputation).

**Purpose:** give customers trust signals when choosing a technician, and give technicians
reputation credit for completed work.

**Storage:** PostgreSQL `reviews`. (Denormalised `technicians.rating` / `technicians.jobs` carry
the public aggregate.)

**Visibility — the deliberate pseudonymisation is worth recording**
- `GET /api/v1/technicians/:id/reviews` is **public**, and returns, per review: `id`, `rating`,
  `comment`, `customerName`, `createdAt`.
- `customerName` is **not** the reviewer's account name. `toReviewApi()` deliberately renders
  "first name + last initial" (e.g. `"Chipo T."`).
- The reviewer's `customer_id`, email, and full name are **not** returned by that public route.
- `GET /api/v1/requests/:id/review`: authenticated, scoped to participating parties.
- `POST /api/v1/requests/:id/review`: customer only, the reviewing customer must own the
  request, request must be `completed`, one review per request.
- The public response includes the internal review `id`. Minor, recorded in the gap analysis.

---

### 1.7 Notification data

**Source of truth:** `notifications` (migration `005_notifications_and_push.sql`).

| Field | Column | Type | Classification |
|---|---|---|---|
| Notification id | `id` | UUID | ordinary (identifier) |
| Recipient | `user_id` | UUID → `users.id` CASCADE | ordinary (identifier link) |
| Event type | `type` | TEXT | ordinary (metadata) |
| Title | `title` | TEXT | ordinary |
| Message | `message` | TEXT | ordinary — **content may name a person (see below)** |
| Channel | `channel` | TEXT CHECK, default `in_app` | ordinary |
| Reference type | `reference_type` | TEXT, nullable | ordinary |
| Reference id | `reference_id` | UUID, nullable | ordinary |
| Read state | `read`, `read_at` | BOOLEAN default false / TIMESTAMPTZ | ordinary |
| Delivery status | `status` | TEXT CHECK, default `'sent'` | ordinary |
| Provider message id | `provider_message_id` | TEXT, nullable | ordinary |
| Failure reason | `failure_reason` | TEXT, nullable | ordinary |
| Created / sent | `created_at`, `sent_at` | TIMESTAMPTZ | ordinary (metadata) |

**Event types actually implemented (verified in `server.ts`):**
`dispatch_offer_created`, `dispatch_offer_accepted`, `dispatch_offer_rejected`,
`dispatch_offer_timed_out`, `request_status_pending|matching|matched|no_match|in_progress|completed|cancelled`,
`technician_verification_submitted`, `technician_verification_approved`,
`technician_verification_rejected`.

**Do notification messages contain personal information?** Yes — verified, and worth stating
precisely rather than generally:

| Message template | Contains personal data? |
|---|---|
| `You have a new ${category} service offer in ${city}.` | No |
| Offer accepted / rejected / expired copy using **city + category** | No individual named |
| Request-status copy using **city + category** | No individual named |
| `${tech.name} submitted verification for review.` | **Yes — the technician's full display name**, sent to administrators |
| `Your technician verification was rejected: ${reason}` | **Yes — administrator-authored free text**, sent to the technician |

So two of eleven event types carry a person's name or human-authored content. Both recipients are
themselves authenticated principals (the reviewer, or the technician whose document it concerns),
so this is intra-platform correspondence rather than disclosure to the public — but it is still
personal data processed for notification purposes, and it is recorded as such.

**Storage:** PostgreSQL `notifications`. One row per (recipient, event, reference) enforced by
the D1 natural-key dedupe in `NotificationService.recordEventNotification()` — a repeated event
returns the existing row instead of inserting a second one.

**Visibility — RESOLVED in 28.3C (was gap G-02).** At 28.3A, `NotificationService` implemented
the read methods but **no HTTP route exposed notifications to any user**, and the dashboard
"Notifications" item was a `#` placeholder. The browser panel was the push control, not an
inbox. The consequence for privacy was specific: personal data described above was written to
the database and pushed to the browser, but **a data subject had no way to list, read or delete
their own notification history**.

*(Correction: the 28.3A text attributed this finding to gap **G-07**. G-07 is "push subscriptions
survive account suspension"; the correct id for the missing notification surface is **G-02**.)*

| Route | Guard | Returns |
|---|---|---|
| `GET /api/v1/me/notifications` | `requireAuth`; recipient from the **session only** | Own history, paginated (`limit` 1–100 default 25, `offset`), plus real `unreadCount`, `totalCount`, `hasMore` |
| `PATCH /api/v1/me/notifications/:id/read` | `requireAuth`; `assertUuid`; owner-scoped in SQL | `{ id, read: true }`, or 404 for a foreign/unknown id (identical to non-existent) |
| `POST /api/v1/me/notifications/read-all` | `requireAuth` | `{ updated }` — the **real** count, which may honestly be `0` |

No second notification store was created: these routes call the existing
`NotificationService` methods over the existing `notifications` table, and push/SMS delivery
semantics are unchanged. A frontend inbox exists at `/dashboard/notifications`. An account
with no notifications gets an honest empty state, and the sidebar badge shows the real unread
count (it previously rendered a hardcoded `2`).

---

### 1.8 Push-subscription data — security-sensitive technical data

**Source of truth:** `push_subscriptions` (migration `005`).

| Field | Column | Type | Classification |
|---|---|---|---|
| Subscription id | `id` | UUID | ordinary (identifier) |
| Owner | `user_id` | UUID → `users.id` CASCADE | ordinary (identifier link) |
| Push endpoint | `endpoint` | TEXT — the browser push service URL | **confidential/security-sensitive** |
| Public key | `p256dh` | TEXT — subscriber's P-256 public key | **confidential/security-sensitive** |
| Auth secret | `auth` | TEXT — 16-byte subscription authentication secret | **confidential/security-sensitive** |
| User agent | `user_agent` | TEXT, nullable | ordinary (device metadata) |
| Created / updated | `created_at`, `updated_at` | TIMESTAMPTZ | ordinary (metadata) |

**Data subject:** the device owner. Uniqueness on `(user_id, endpoint)`.

**Purpose:** let the server deliver a notification to a specific browser profile, and — because
the endpoint is a per-device push-service URL — identify which devices belong to one account.

**Storage:** PostgreSQL `push_subscriptions`. **There is no separate push-encryption key store;
the subscription keys *are* the stored material.**

**Visibility:** `owner-only`. `POST /api/v1/me/push-subscriptions` and
`DELETE /api/v1/me/publish-subscriptions/:id` are `requireAuth` and strictly caller-scoped;
another user's id returns the identical 404 so subscription existence never leaks. The route
uses a **strict schema that rejects a client-supplied `user_id`** (asserted in
`task28-push-subscriptions-tests.ts`). The endpoint/p256dh/auth values are returned to no route
response except the caller's own subscription id + endpoint (keys never echoed).

**Deactivation:** `PushService` deletes subscriptions that the push provider rejects with HTTP
`404` or `410` — expired/rotated endpoints self-clean.

---

### 1.9 Storage-object data (photos and verification documents)

**Verified implementation:** `backend/src/storage/fileStorage.ts` defines a `FileStorage`
interface (`put` / `read` / `remove`) with **one implemented adapter**, `LocalFileStorage`,
writing under a server-local root configured by `STORAGE_DIR`. The domain layer stores only an
**opaque `storage_key`**; routes never see a filesystem path.

> **Correction to a common assumption, established by source inspection:** there is **no
> Supabase Storage client in this codebase.** `Select-String` for `supabase` across
> `backend/src/**` returns **no matches** — no SDK import, no bucket API call, no
> `SUPABASE_SERVICE_ROLE_KEY` reference in any runtime file. The logical namespaces
> `profiles/` and `verification/<technicianId>/` exist as key prefixes in the local adapter.
> They are the *conceptual* equivalents of a `technician-photos` and a
> `verification-documents` bucket, but as of this stage they are local directories, and no third
> bucket exists or is created here. A future object-store adapter would implement the same
> interface without touching routes — by design, per the `fileStorage.ts` header comment.

| Object set | Key shape | Purpose | Access control |
|---|---|---|---|
| Technician profile photo | `profiles/<uuid>.<ext>` | public-facing profile image | **public by design** via `GET /api/v1/technicians/:id/photo`; upload/replace `owner-only` |
| Verification document | `verification/<technicianId>/<docId>.<ext>` | identity/qualification evidence | **private**: bytes reachable only through `GET /api/v1/verification-documents/:id/file` after auth + ownership/admin check |

**Upload controls verified in `server.ts`:** one file per request
(`@fastify/multipart`, `limits: { fileSize: 5 * 1024 * 1024, files: 1 }`), declared MIME must map
to an allowed photo extension, and the **declared type is cross-checked against the file's actual
magic bytes** (`validateMagicBytes`, JPEG/PNG/WebP/PDF only) to defeat renamed executables.
Non-empty size enforced. Replacing a photo deletes the previous stored object.

---

### 1.10 Security / audit event data — **added in 28.3F**

**Source of truth:** `audit_events` (migration `006_privacy_and_audit.sql`).
**Implementation:** `backend/src/privacy/auditService.ts`.

| Field | Column | Type | Classification |
|---|---|---|---|
| Event id | `id` | UUID | ordinary (identifier) |
| Event type | `event_type` | TEXT, from a **closed vocabulary** | ordinary (metadata) |
| Actor | `actor_user_id` | UUID, **no FK**, nullable | ordinary (identifier link) |
| Actor role | `actor_role` | TEXT, nullable | ordinary |
| Target user | `target_user_id` | UUID, **no FK**, nullable | ordinary (identifier link) |
| Target entity | `target_entity_type`, `target_entity_id` | TEXT / UUID, nullable | ordinary |
| Outcome | `outcome` | TEXT CHECK (`success`/`failure`/`denied`) | ordinary |
| Metadata | `metadata` | JSONB, **allow-listed keys only** | ordinary (technical facts) |
| Created | `created_at` | TIMESTAMPTZ | ordinary (metadata) |

**Event types implemented:** `auth.login_failed`, `auth.login_succeeded`, `auth.account_locked`,
`admin.user_status_changed`, `admin.verification_decision`,
`security.verification_document_accessed`, `security.verification_document_deleted`,
`privacy.data_exported`, `privacy.account_deleted`, `account.suspended`, `account.reactivated`.

**Three deliberate design decisions:**

1. **No foreign key to `users`, on purpose.** An audit record is *about* a person, not owned by
   them. An FK would make permanent deletion either impossible or destructive of the
   accountability record. Plain UUIDs let the person's rows vanish while the security history
   survives, minimised. This is the mechanism that lets 28.3D honour an erasure request without
   lying about either.
2. **No IP address column, on purpose.** The system stores client IPs nowhere. Introducing
   broad IP collection as a side effect of a logging feature would add a new, pervasive
   personal-data category. It is not introduced.
3. **No personal data denormalised in.** No email, no name, no request text, no document
   content, no rejection reason. `metadata` accepts only allow-listed keys with primitive
   values, capped in length; a non-primitive value is **dropped, not truncated**, so a nested
   payload cannot smuggle personal data into a security record.

**Never recorded:** passwords (any form), access/refresh tokens or token hashes, VAPID private
keys, SMS credentials, document bytes, document filenames, storage keys, notification bodies.

**Visibility:** `GET /api/v1/admin/audit-events` is `requireRole('administrator')`, paginated
and filterable by type/actor/outcome. An ordinary user reaches **their own** security history
only, and only through their data export (`listAuditEventsForUser`, where they are actor or
target).

**Deletion behaviour:** audit rows are **retained** when an account is deleted — the one
deliberate exception to erasure, disclosed to the user (with a count) before they confirm.
Retention period is an **open item**.

**Note:** request status *history* is still not preserved (only current status and
`updated_at`); access-token issuance and rate-limit events are still not persisted;
administrator *reads* of `admin/users` and `admin/requests` are not individually logged.

---

### 1.11 Communication data — **added in 28.4**

**Source of truth:** `conversations`, `messages` (migration `007_communication.sql`);
`user_phones` (migration `008_communication_phone.sql`).
**Implementation:** `backend/src/privacy/communicationAuth.ts`,
`backend/src/realtime/websocketServer.ts`, the communication routes in `backend/src/server.ts`,
`frontend/lib/api/communicationApi.ts`, `frontend/app/dashboard/messages/**`.

| Field | Column | Type | Classification |
|---|---|---|---|
| Conversation id | `conversations.id` | UUID | ordinary (identifier) |
| Linked request | `conversations.service_request_id` | UUID, **UNIQUE** index, FK `ON DELETE CASCADE` | ordinary (link) |
| Participants | `conversations.customer_id`, `conversations.technician_id` | UUID FKs `ON DELETE CASCADE` | ordinary (identity link) |
| Conversation state | `conversations.status` | TEXT CHECK `active`\|`closed` | ordinary (metadata) |
| Message id | `messages.id` | UUID | ordinary (identifier) |
| Sender | `messages.sender_id` | UUID FK — **always written by the server from the session**, never from the client | ordinary (identity) |
| Message body | `messages.message` | TEXT, CHECK length **1–2000** | ordinary, free text — **relationship-scoped** |
| Message time | `messages.created_at` | TIMESTAMPTZ | ordinary (metadata) |
| Read state | `messages.read_at` | TIMESTAMPTZ, nullable | ordinary (metadata) |
| Phone number | `user_phones.phone_normalized` | TEXT, E.164-style, `UNIQUE (user_id, phone_normalized)` | ordinary (contact) |
| Phone as entered / country | `user_phones.phone_raw`, `country_code` | TEXT, `country_code` default `+260` | ordinary (contact) |
| Phone purpose | `user_phones.purpose` | TEXT CHECK `service_contact`\|`emergency_contact`\|`verification` | ordinary (metadata) |

**Data subjects:** the customer and the technician of one **accepted** service relationship. An
account that has never been in an accepted relationship has no conversation, no message and —
unless the user volunteered one — no phone row.

**Purpose:** let the two parties of an accepted job exchange plain text, and let either party
reach the other by phone through a local `tel:` handoff.

**Visibility:** `relationship-scoped` for every message in both directions; `owner-only` for
`user_phones`. Conversation and message access is decided by `canAccessConversation()` /
`canCommunicateOnRequest()`, which re-derive participant identity from the session and the
database — there is no client-supplied participant id anywhere in the path.

**Communication surfaces (all `requireAuth`, subject always session-derived):**

| Route | Guard | What it exposes |
|---|---|---|
| `GET /api/v1/me/conversations` | `requireAuth`, 120/min | Own conversations, other participant's display name, latest real message, real unread count |
| `GET /api/v1/requests/:id/conversation` | `requireAuth` | Own conversation for one request, or 404 |
| `GET /api/v1/conversations/:id` | `requireAuth` | The same payload keyed by conversation id (notification deep links) |
| `GET /api/v1/conversations/:id/messages` | `requireAuth`, 120/min | Cursor (`before`) paginated history |
| `POST /api/v1/conversations/:id/messages` | `requireAuth`, 60/min, **strict schema `message` only** | The stored message with server-set `senderId`/`createdAt`/`readAt` |
| `PATCH /api/v1/conversations/:id/read` | `requireAuth`, 120/min | Marks **only the other participant's** unread rows |
| `GET /api/v1/requests/:id/contact` | `requireAuth`, 60/min | The other participant's authoritative number, or **404** |
| `GET`/`PUT /api/v1/me/phone` | `requireAuth` (PUT 30/min) | The owner's own number; `phone: null` when unset |

**Not collected in connection with communication:** attachments, voice/video, typing indicators,
presence, delivery receipts beyond `read_at`, reactions, edit/delete history. Message text never
reaches a notification payload, a push body, an audit event or a log line — the `chat_message`
notification carries only the conversation id, and the client fetches the text under authorization.

**Deletion behaviour:** conversation rows cascade from `service_requests`, `users` and
`technicians`; message rows cascade from `conversations`; `user_phones` cascades from `users`.
Account deletion therefore removes the phone number and the conversations the account owns.

---

### 1.12 Classification summary

| Category | Data subject(s) | Highest classification | Publicly exposed today |
|---|---|---|---|
| Identity & account | customer, technician, administrator | confidential (password hash, token hash) | name only, via review pseudonymisation |
| Technician profile | technician | higher-risk (precise coordinates) | **coarse only** — `serviceArea`; stored coords travel with the row but are not publicly disclosed (since 28.3A.1) |
| Verification | technician (subject), administrator (reviewer) | **higher-risk (identity documents)** | no |
| Service request | customer (author) | ordinary, free text | no |
| Dispatch / offer | customer, technician | ordinary, incl. ranking metadata | no |
| Review / rating | customer (author), technician (subject) | ordinary, free text | yes — pseudonymised |
| Notification | customer, technician, administrator | ordinary, may carry a name or admin-authored text | no — **but listable by the subject since 28.3C** |
| Push subscription | device owner | confidential/security-sensitive | no |
| Storage objects | technician | higher-risk (documents) | photos yes; documents no |
| **Security / audit events** (28.3F) | all principals | confidential (security record) | no — administrators only; subject sees their own via export |
| **Communication** (28.4) | customer, technician of one accepted job | ordinary, free text + optional contact number | no — **relationship-scoped only**; number returns 404 when absent |

---

## 1.13 Data-subject privacy surfaces — **added in 28.3**

Every route below derives its subject from the authenticated session. There is **no**
client-supplied user id, recipient or owner anywhere in this set.

| Route | Guard | Purpose | What it exposes |
|---|---|---|---|
| `GET /api/v1/me/data` | `requireAuth`, 10/min | Access / portability (28.3C) | A consolidated JSON export (`umodzi-account-export-v1`) built from authoritative relationships. Includes the subject's **own** stored coordinates. **Excludes** password material, token hashes, document bytes/keys, push device keys, full endpoint URLs, and other users' data — each for a stated reason |
| `GET /api/v1/me/account/deletion-preview` | `requireAuth`, 10/min | Erasure preview (28.3D) | Real counts of what deletion removes, **including the number of security events that will be retained**. Removes nothing |
| `DELETE /api/v1/me/account` | `requireAuth`, 5/min, **password + phrase `DELETE MY ACCOUNT`** | Erasure (28.3D) | `{ deleted, alreadyDeleted, report }` with real per-category counts |
| `GET /api/v1/me/notifications` | `requireAuth`, 60/min | Notification access (28.3C) | Own history, paginated, with real unread/total counts |
| `PATCH /api/v1/me/notifications/:id/read` | `requireAuth`, 120/min | Read state (28.3C) | `{ id, read }` or 404 |
| `POST /api/v1/me/notifications/read-all` | `requireAuth`, 60/min | Read state (28.3C) | `{ updated }` — the real count |
| `GET /api/v1/admin/audit-events` | `requireRole('administrator')`, 60/min | Accountability (28.3F) | Paginated, filterable security events |
| `GET /api/v1/me/phone` | `requireAuth` | Phone access (28.4B) | The owner's own number, or `null` |
| `PUT /api/v1/me/phone` | `requireAuth`, 30/min | Phone correction (28.4B) | The stored normalized number; strict schema, invalid values rejected |
| `GET /api/v1/requests/:id/contact` | `requireAuth`, 60/min | Contact handoff (28.4B) | Other participant's number **only** inside an accepted relationship, else 404 |
| `GET /api/v1/me/conversations` | `requireAuth`, 120/min | Conversation list (28.4C) | Own conversations and real unread counts only |

**Deletion consequences (documented, not hidden):** reviews *about* a deleted technician
profile are removed with it (`reviews.technician_id` is `NOT NULL` and cascades), and the
rating/job aggregates disappear with the profile. **Security events are retained** in minimised
form. The system revokes its own sessions and removes its own records; it has **no mechanism**
to request deletion from a push service or other third party, and does not claim to.

**Frontend surfaces added:** `/privacy` (public notice), `/dashboard/privacy` (export +
deletion), `/dashboard/notifications` (inbox), plus a privacy disclosure on the registration
form linking to the notice. In 28.4: `/dashboard/messages` (conversation list) and
`/dashboard/messages/[conversationId]` (thread), both entry points resolving to a
server-authorized conversation.

---

## 2. Summary of the most significant 28.3A findings

1. **G-01 — precise technician coordinates were published unauthenticated. CORRECTED in
   28.3A.1.** At 28.3A three public endpoints returned `latitude`/`longitude`, which serve an
   internal proximity purpose only. Since 28.3A.1 no public projection returns a coordinate:
   coarse `serviceArea` is used instead, `/nearby` distance is bucketed to 100 m and rate
   limited, and the internal PostGIS dispatch path is unchanged.
2. **G-02 — no in-app notification inbox route.** Notification personal data is written and
   pushed, but a data subject cannot list, read or delete their own notification history.
3. **G-03 — verification rejection reasons are free text that can quote document content.**
   Stored, sent to the technician, and unbounded in length by any policy.
4. **G-04 — administrator role can read every customer's email and full name** via
   `GET /api/v1/admin/users` and `GET /api/v1/admin/requests`. Necessary for platform
   operation; needs to be documented as an accepted privileged-access boundary.
5. **G-05 — no retention job exists for any category**, including verification documents and
   expired sessions.
6. **G-06 — no notification-carrying data redaction path**: deleting an account (not yet
   implemented) would need to decide whether historical notification text naming that person
   must be removed.
7. **G-07 — push subscription keys have no revocation-on-suspension path.** An administrator can
   suspend an account, but the associated push endpoints remain in the table.

All are carried into `PRIVACY_IMPLEMENTATION_GAP_ANALYSIS.md` with planned stages. None was
fixed in 28.3A.