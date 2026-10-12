# Umodzi Connect — Data Flow Architecture

**Task:** 28.3A. **Basis:** the routes, services and storage actually present in the codebase.
External providers are marked distinctly. Components that are *planned but not implemented* are
drawn in a separate section so they cannot be mistaken for live data flows.

> **Status of this document.** Umodzi Connect is an academic project. This diagram describes
> what the code does and where data flows. It makes **no** claim that the platform is legally
> compliant, registered with the Data Protection Commission, or covered by an appointed data
> protection officer. Statements about purposes and controllers/processors are observations about
> the operating model and **require legal/organizational confirmation**.

---

## 1. Verified runtime topology

```mermaid
flowchart TB
  subgraph actors["Data subjects / operators"]
    CU["Customer<br/>(browser)"]
    TE["Technician<br/>(browser)"]
    AD["Administrator<br/>(browser)"]
  end

  subgraph edge["Edge / client"]
    FE["Next.js frontend<br/>:3000<br/>(server-rendered, browser-hydrated)"]
    LS[("Browser localStorage<br/>umodzi:matching:category<br/>umodzi:matching:area<br/>umodzi:profile:&lt;name&gt;")]
    SW["Service worker<br/>/sw.js<br/>(push + notificationclick)"]
  end

  subgraph api["Application backend"]
    API["Fastify API<br/>:3001<br/>CORS allow-list · rate limits<br/>security headers"]
    AUTH["Auth layer<br/>argon2id · JWT · sessions"]
    NOTIF["NotificationService<br/>+ PushService"]
    SMSP["ISmsProvider<br/>ConfigurableSmsProvider"]
    STORE["FileStorage interface<br/>LocalFileStorage"]
  end

  subgraph data["Primary data store"]
    PG[("PostgreSQL / PostGIS<br/>users · sessions · technicians<br/>service_requests · dispatch_offers<br/>technician_verification_documents · reviews<br/>notifications · push_subscriptions")]
    DISK[("Server-local object store<br/>STORAGE_DIR<br/>profiles/ · verification/&lt;techId&gt;/")]
  end

  subgraph ext["EXTERNAL PROVIDERS — location requires deployment-time confirmation"]
    PUSHSVC["Browser push service<br/>(vendor chosen by the browser)"]
    AT["Africa's Talking SMS API<br/>INACTIVE — no credentials,<br/>no route calls it"]
  end

  CU -->|HTTPS| FE
  TE -->|HTTPS| FE
  AD -->|HTTPS| FE
  FE -->|HTTPS + Bearer access token| API
  FE --- LS
  FE --- SW

  API --> AUTH
  API --> NOTIF
  API --> STORE
  API --> PG
  AUTH --> PG
  NOTIF --> PG

  NOTIF -->|"encrypted POST (VAPID)<br/>notification title/message"| PUSHSVC
  PUSHSVC -.->|"push to registered browser"| SW

  SMSP -.->|"not wired: no route calls<br/>the SMS provider"| AT

  STORE --> DISK

  classDef ext fill:#fff4e5,stroke:#d9822b,stroke-width:2px
  classDef actor fill:#eef5ff,stroke:#3b6ea5
  classDef store fill:#eefaf0,stroke:#3f8f5a
  class PUSHSVC,AT ext
  class CU,TE,AD actor
  class PG,DISK,LS store
```

### What the diagram deliberately does **not** show

- **No Supabase client anywhere.** Verified: `Select-String 'supabase'` across `backend/src/**`
  returns no matches — no SDK import, no bucket API, no service-role key reference. Storage is a
  server-local adapter behind an interface. The production *target* named in configuration is
  Supabase PostgreSQL/PostGIS (PostGIS extension, database only).
- **No direct browser → database or browser → storage path.** The frontend receives only an API
  base URL and the **public** VAPID key.
- **No AI/ML vendor.** Category classification is deterministic keyword rules inside the API.
- **No analytics, advertising or third-party tracking.**

---

## 2. Trust boundary map

```mermaid
flowchart LR
  subgraph PUBLIC["Unauthenticated / public surface"]
    P1["GET /technicians<br/>GET /technicians/:id<br/>GET /technicians/nearby<br/>GET /technicians/:id/reviews<br/>GET /technicians/:id/photo<br/>GET /categories<br/>POST /classify<br/>POST /auth/register · login · refresh · logout"]
  end
  subgraph USER["Authenticated surface"]
    U1["Requests · offers · status<br/>Reviews (owner-scoped)<br/>Push subscriptions (caller-scoped)<br/>Verification documents (owner-scoped)"]
  end
  subgraph ADMIN["Administrator surface"]
    A1["Admin overview · users · technicians · requests<br/>Verification decisions<br/>Account status changes"]
  end

  PUBLIC -->|reads only public-safe projections| PG[("PostgreSQL")]
  USER -->|ownership/relationship checked per route| PG
  ADMIN -->|privileged, includes emails + full names| PG
  ADMIN -.->|restricted| DISK[("verification/<techId>/…")]
  PUBLIC -.->|photo only, by design| DISK
```

**The public surface is the privacy-sensitive one.** Everything returned from the six public read
endpoints is reachable without a session. The concrete consequence identified in 28.3A, and
**corrected in 28.3A.1**:

> ~~Technician `latitude`/`longitude` (and the derived `distanceKm`) are returned by
> `GET /technicians`, `GET /technicians/:id` and `GET /technicians/nearby`, all unauthenticated.~~
>
> **As of 28.3A.1 no public route returns a stored coordinate.** Public technician information
> conveys location as the self-declared `serviceArea` only. `GET /technicians/nearby` retains its
> PostGIS radius search — the `location` point is used inside the SQL predicate and ordering, never
> projected — and returns `distance_meters` coarsened to a 100 m bucket, on a rate-limited route.
> Precise coordinates remain an internal dispatch input only.

---

## 3. Flows by data category

### 3.1 Registration and authentication

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant F as Next.js frontend
  participant A as Fastify API
  participant D as PostgreSQL

  B->>F: POST /auth/register (email, password, names, role, category?, serviceArea?)
  F->>A: HTTPS + JSON
  A->>A: Zod validate · rate limit (15/min)
  A->>A: argon2id hash(password)
  A->>D: INSERT users (+ technicians row for technician role)
  A->>D: INSERT technicians.location (seeded approximate city point)
  D-->>A: row
  A-->>B: 201 { id, email, role, names, accountStatus }

  Note over B,D: Login compares against argon2id only; one generic error on failure
  B->>A: POST /auth/login
  A->>D: INSERT sessions (SHA-256 token hash only)
  A-->>B: access JWT (sub/role/jti, 15 min) + HttpOnly refresh cookie
```

Plaintext passwords exist only in request memory; only the argon2id digest and a SHA-256 token
hash are persisted.

### 3.2 Location processing — public vs operational

This is the distinction 28.3A was specifically asked to document.

```mermaid
flowchart TB
  subgraph coarse["Coarse, published — designed to be public"]
    C1["service_area (canonical city enum)<br/>service_requests.city"]
  end
  subgraph precise["Precise — operational, internal purpose"]
    P2["technicians.latitude / .longitude<br/>technicians.location GEOGRAPHY(POINT,4326)<br/>service_requests.latitude / .longitude<br/>(columns exist; NOT populated by the API)"]
  end

  subgraph use["Where precise data is actually used (internal only)"]
    U3["ST_DWithin / ST_Distance<br/>GET /technicians/nearby (SQL predicate + ordering only)<br/>optional MAX_SERVICE_RADIUS_KM<br/>offer-eligibility distance cap"]
  end
  subgraph leak["Public surface since 28.3A.1 — coordinate removed"]
    L4["GET /technicians → serviceArea only<br/>GET /technicians/:id → serviceArea only<br/>GET /technicians/nearby → serviceArea + distance_meters (100 m buckets)<br/>ALL UNAUTHENTICATED · /nearby RATE LIMITED"]
  end

  P2 --> U3
  P2 -->|"service_area only — G-01 remediated"| L4
  C1 -->|"intended public surface"| coarse

  classDef fixed fill:#eaf6ee,stroke:#1e8449,stroke-width:2px
  class L4 fixed
```

Key verified facts:

- **No real GPS anywhere.** There is **no geolocation API call** in the frontend code — no
  `getCurrentPosition`, no `watchPosition`, no `navigator.geolocation` call in
  `frontend/app/**`, `frontend/components/**` or `frontend/lib/**`. (The identifier appears only
  inside **comments** in `mapData.ts`, documenting a future replacement seam.)
- **The frontend map helper is explicit about this:** `frontend/lib/mapData.ts` states its
  coordinates are "deterministic mock values… NOT real GPS locations and NOT real technician
  positions" and performs no geolocation.
- **Technician coordinates at registration are hard-coded approximate city-centre seeds**, not a
  technician's home or current position.
- **Customer request coordinates are schema-ready but never populated** by the API.
- **Since 28.3A.1 no public route projects a stored coordinate.** The prototype map's technician
  pins are derived from the technician's declared `service_area` city centre
  (`getServiceAreaPoint()` in `frontend/lib/mapData.ts`), so the displayed map distance is an
  area-level figure between two city centres rather than a true technician distance.
- Location data is treated as personal data throughout this documentation.

### 3.3 Verification documents — higher-risk flow

```mermaid
flowchart LR
  T["Technician browser"] -->|multipart, ≤5MB,<br/>1 file| A["POST /technician/verification/documents"]
  A --> V1["Magic-byte validation<br/>(JPEG/PNG/WebP/PDF)"]
  V1 --> S[("Storage<br/>verification/&lt;techId&gt;/&lt;docId&gt;.ext")]
  V1 --> D[("technician_verification_documents<br/>type · filename · MIME · size · key")]
  T -->|submit| ST["POST /verification/submit<br/>status → pending"]
  ST --> ADM["Administrator notified<br/>(in-app + push)"]
  ADM -->|PATCH decision| DEC{"verified | rejected"}
  DEC -->|"verified"| OK["status=verified<br/>reviewer + timestamp recorded"]
  DEC -->|"rejected + mandatory reason"| NO["status=rejected<br/>reason stored and sent to technician"]
  D2[("reviews request")] -.->|"GET /verification-documents/:id/file"| T
  X["Another technician"] -->|404, never 403| D2
```

Control properties worth noting: cross-technician requests return **404 rather than 403** so
document existence does not leak; document mutation is blocked with 409 once submitted or
decided; the rejection reason is **mandatory**; `verification_reviewed_by` is `ON DELETE SET
NULL` so deleting an administrator anonymises the reviewer instead of orphaning the decision.

### 3.4 Notification and push flow

```mermaid
sequenceDiagram
  autonumber
  participant R as Business route<br/>(offer / status / verification)
  participant N as NotificationService
  participant D as PostgreSQL
  participant P as PushService (web-push)
  participant X as Browser push service<br/>EXTERNAL
  participant B as Service worker

  R->>R: business write COMMITS first
  R->>N: recordEventNotification(recipient from DB relationship only)
  N->>D: BEGIN → advisory lock on natural key
  N->>D: INSERT ... status='pending' (dedupe: existing row returned instead)
  N->>D: COMMIT
  N->>P: sendPushToUser(user_id, {title, body, data})
  P->>D: SELECT subscriptions for user
  loop each subscription (independent try/catch)
    P->>X: encrypted POST (aes128gcm) + VAPID
    alt 2xx acceptance
      X-->>P: accepted
    else 404 / 410
      X-->>P: gone
      P->>D: DELETE subscription
    else other failure
      X-->>P: error
      P->>P: record failure, continue to next device
    end
  end
  P-->>N: { sent, failed }
  alt sent > 0
    N->>D: UPDATE notifications SET status='sent', sent_at=NOW()
  else sent = 0
    N->>D: UPDATE notifications SET status='failed', failure_reason=<honest reason>
  end
  N-->>R: never throws — logged, business response unaffected
  X-.->|push delivered to browser| B
  B->>B: showNotification + notificationclick handling
```

Honest-delivery guarantees encoded here:

- Business write commits **before** any notification or provider work — no distributed
  transaction, no rollback of a business operation by a notification failure.
- **No provider call inside a database transaction.**
- `sent` is set **only** on genuine provider acceptance — never because the row was inserted.
- `provider_message_id` stays NULL: the Web Push protocol returns no per-message identifier, and
  none is ever fabricated.
- Dedupe on `(user_id, type, reference_type, reference_id)` means a repeated event neither
  duplicates nor re-pushes.
- Missing VAPID configuration fails honestly and claims no delivery.

### 3.5 SMS — designed but not active

```mermaid
flowchart LR
  E["Eligible event<br/>(policy: accepted offer,<br/>verification approved/rejected)"] --> G{"isSmsEligibleEvent(type)"}
  G -->|no| N1["in-app + push only<br/>Web Push stays primary"]
  G -->|yes| M{"authoritative phone<br/>number on the user?"}
  M -.->|"NO - no service_contact number<br/>saved for this user"| STOP["no SMS sent<br/>deliberate dead end"]
  M -->|yes| P["ConfigurableSmsProvider<br/>AFRICASTALKING_* credentials"]
  P --> AT["Africa's Talking API<br/>EXTERNAL — no credentials configured"]
```

Verified state: the Africa's Talking adapter and the policy gate both exist. Migration
`008_communication_phone.sql` now adds `user_phones`, an **optional, self-service** number a
user stores on their own account for service contact (`purpose = 'service_contact'`). That
table is read by exactly one route, `GET /api/v1/requests/:id/contact`, which returns the
number (or an honest **404**) so the browser can offer a `tel:` link. It is **not** wired into
any SMS path: no route calls `ConfigurableSmsProvider`, the notification policy still gates
SMS behind an SMS-eligible event, and `chat_message` notifications are in-app + push only.
SMS therefore remains inactive and no SMS has ever been sent by this system — the dead end is
still deliberate, it is just no longer caused by a missing column.

---

### 3.6 Communication — conversations, messages and phone (28.4)

```mermaid
flowchart LR
  CU["Customer (session)"] --> API
  TE["Technician (session)"] --> API
  API --> AUTH
  API --> PG
  API --> WS["WebSocket /api/v1/realtime<br/>JWT handshake + DB re-authorization"]
  PG -.->|"row committed first"| API
  API -.->|"conversation-scoped event<br/>ids only, never the body"| WS
  WS --> CU
  WS --> TE
  API -->|"chat_message notification<br/>conversation id only"| NOTIF
  CU --> TEL["tel: handoff<br/>GET /requests/:id/contact"]
  TEL -.->|"404 when no authoritative<br/>number exists"| PB["Local dialler<br/>no egress"]
```

Rules that make the diagram honest:

- **Persistence is authoritative.** `POST /conversations/:id/messages` inserts the row and only
  *then* publishes the realtime event. The socket transport never holds message text in memory,
  and a transport failure never fails a persisted message.
- **Authorization is server-derived at both layers.** HTTP requires `requireAuth` plus
  `canAccessConversation()` / `canCommunicateOnRequest()`. The WebSocket handshake re-verifies the
  access token with the same verifier used by HTTP, re-reads the account from PostgreSQL, and
  re-runs `canAccessConversation()` on every `subscribe` — a client can never assert membership.
- **Realtime is optional; REST is not.** Without the `ws` package installed, the transport factory
  returns null, logs that realtime is inactive, and every flow above still completes over REST.
  The chat UI reports "live updates are paused" rather than claiming a connection it does not have.
- **The phone flow does not egress.** `/requests/:id/contact` returns an authoritative number or
  404; the browser only ever receives a `tel:` link and hands off to the local dialler.
- **No message text and no phone number enters a notification payload, a push body or a log line.**
  The `chat_message` notification carries the conversation id and nothing else.

**Data category:** §1.11 Communication data in the Data Inventory.

---

## 4. Third-party data-egress ledger

| Egress | Trigger | Data transmitted | Credential boundary | Location status |
|---|---|---|---|---|
| Browser push service | Notification with a live subscription | Encrypted notification title/message | VAPID **private** key, backend env only | **Requires deployment-time confirmation** |
| Africa's Talking SMS | Would require an SMS-eligible event **and** an SMS route (neither exists; `user_phones` is read only by `/requests/:id/contact`) | SMS body + recipient number | `AFRICASTALKING_*`, backend env only, currently empty | **Requires deployment-time confirmation**; inactive |
| Database host | Every request | Query results across all categories | `DATABASE_URL`, backend env only | **Requires deployment-time confirmation** |
| Object store | Photo/document read | File bytes | Storage root env only | Local filesystem today |

**No other egress path exists in the code.**

### 4.1 Privacy flows added in Task 28.3 — no new egress

None of the four stages below introduces a **new** egress path. Every one of them is a
movement of data **between the browser and the application's own API**, or between the API and
its own database and storage adapter. That is stated explicitly because "we added an export"
is exactly the kind of change that can quietly add a new destination.

```mermaid
flowchart TB
  subgraph DS["Data-subject flows (28.3) — subject always from the session"]
    B2["Browser"]
    API2["Fastify API<br/>(authoritative)"]
    DB2["PostgreSQL"]
    FS2["FileStorage<br/>(LocalFileStorage)"]
  end

  B2 -->|"GET /me/data"| API2
  API2 -->|"reads own rows only"| DB2
  DB2 --> API2
  API2 -->|"JSON built in memory"| B2
  B2 -->|"blob download, browser-local"| X1["User's own file<br/>NOTHING STORED SERVER-SIDE"]

  B2 -->|"DELETE /me/account<br/>+ password + phrase"| API2
  API2 -->|"collect storage keys"| DB2
  API2 -->|"one transaction:<br/>reviews → requests → profile →<br/>notifications → subs → sessions → user"| DB2
  API2 -->|"COMMIT, then best-effort unlink"| FS2

  B2 -->|"GET /me/notifications"| API2
  API2 -->|"owner-scoped read"| DB2

  API2 -->|"audit_events<br/>NO FK to users"| DB2
  DB2 -.->|"survives account deletion"| API2

  classDef noegress fill:#eaf6ee,stroke:#1e8449,stroke-width:2px
  class X1 noegress
```

Guarantees encoded in these flows:

- **No client-supplied subject.** There is no user id, recipient or owner parameter anywhere.
  The subject is `request.authUser`, re-read from PostgreSQL by `requireAuth`.
- **No export archive.** The JSON is assembled per request and the file is created in the
  browser, so there is nothing retained and nothing to purge.
- **Erasure is not a flag.** Relational rows are removed and committed, *then* stored objects
  are unlinked. A bare `DELETE FROM users` would **orphan** requests and the technician profile,
  because `service_requests.customer_user_id` and `technicians.user_id` are `ON DELETE SET NULL`.
- **The audit trail deliberately outlives the account.** `audit_events` has no foreign key to
  `users`, so honouring an erasure request does not destroy the accountability record. The
  retained count is shown to the user before they confirm.
- **Auditing is log-and-continue.** An audit write failure is logged and swallowed; it can
  never fail or roll back the business action.
- **No IP addresses.** None are stored by the application, and none were added for auditing.
- **Provider deletion is not claimed.** The system can delete its own records; it has no
  mechanism to request deletion from a push service or any other third party.

---

## 5. Client-side persistence

The frontend keeps three `localStorage` keys, all containing **user-entered form state only** —
no identity, no tokens, no personal data fetched from the API:

| Key | Content | Lifetime |
|---|---|---|
| `umodzi:matching:category` | selected service category (draft) | until cleared |
| `umodzi:matching:area` | selected service area (draft) | until cleared |
| `umodzi:profile:<technicianName>` | draft profile edits | until cleared |

Access tokens are **not** in `localStorage` or `sessionStorage`: the refresh token is an
HttpOnly cookie, and the access token is held in memory for the session. Verified precisely: no
`localStorage` key anywhere in the frontend carries a token, session, auth, JWT, email or user
id — the only three keys are the draft keys listed above. `sessionStorage` is never *used*; the
only textual occurrence is inside a source **comment** recording that tokens are never placed
there. The `ProfileEditor` component states this to users directly — "Changes are stored in this
browser only (localStorage) and survive refresh. No account …" — which is accurate.

Two consequences for the privacy notice: (a) clearing browser data clears the drafts, and (b) a
shared device leaves the selected category/area visible to the next user, which is minor but
should be disclosed.

**Task 28.3 added no new client-side persistence.** Verified: the three draft keys above are
still the only `localStorage` keys. In particular, the data-export file is created as a
`Blob` in memory and handed to the browser's own download mechanism — it is **not** written to
`localStorage`, `sessionStorage`, IndexedDB or any cache, and the object URL is revoked
immediately. The registration disclosure's checkbox state is component state only and is
deliberately **not** persisted: no consent record is stored server-side or client-side.

---

## 6. Movement summary (what crosses which boundary)

```mermaid
flowchart TB
  subgraph IN["Into the platform"]
    I1["Identity: name, email, password"]
    I2["Professional: category, service area, skills, bio"]
    I3["Documents: verification file bytes"]
    I4["Requests: description, category, city"]
    I5["Reviews: rating, comment"]
    I6["Device: push endpoint + subscription keys"]
  end

  subgraph WITHIN["Inside the platform — PostgreSQL"]
    W1["Account + session tables"]
    W2["Technician + verification tables"]
    W3["Request / offer / review tables"]
    W4["Notification + push tables"]
  end

  subgraph OUT["Outward — disclosed by design"]
    O1["PUBLIC: technician profile fields,<br/>photo bytes, pseudonymised reviews,<br/>category list"]
    O2["RELATIONSHIP-SCOPED: request + offer state<br/>between the two participants"]
    O3["PRIVATE: verification document bytes<br/>(owner or administrator only)"]
    O4["EXTERNAL: encrypted notification payload<br/>to the browser push service"]
  end

  I1 --> W1
  I2 --> W2
  I3 --> W2
  I4 --> W3
  I5 --> W3
  I6 --> W4
  W1 --> O2
  W2 --> O1
  W2 --> O3
  W3 --> O2
  W3 --> O1
  W4 --> O4
  W4 -.->|"gap G-02: no inbox route exists<br/>for the subject to read their own"| X["(no subject-facing surface)"]
```

The dashed line is the finding that matters most for transparency: notification personal data is
collected and forwarded to an external provider, yet the data subject has no surface on which to
read, review or delete it. Either the route is added, or the notice must describe the actual
state accurately.