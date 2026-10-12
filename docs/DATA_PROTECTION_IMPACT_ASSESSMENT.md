# Umodzi Connect — Data Protection Impact Assessment

**Status:** Draft 0.3 — prepared for Task 28.3. Academic prototype.

> **This is an academic assessment of a prototype, not a legal opinion.** It does not claim
> regulatory compliance, supervisory-authority registration, a data protection officer, or
> statutory certification. The Zambia Data Protection Act's gazetted text and the DPC site were
> **unreachable** during the 28.3A discovery stage (HTTP 403 and a transport error), so this
> assessment is framed in terms of **risks and controls** rather than statutory sections. The
> legal-basis determination is an open item throughout.

**Basis:** the actual code, the five pre-existing migrations plus `006_privacy_and_audit.sql`,
the running system, and the verification suites. Every control described here is implemented
and, where a test exists, named.

---

## 1. System description

Umodzi Connect is a web application connecting customers with local technicians in Kitwe and
Ndola, Zambia.

**Architecture:** Next.js frontend → Fastify TypeScript API → PostgreSQL/PostGIS, with a
server-local file storage adapter behind a `FileStorage` interface. The API is the
authoritative security and business-logic boundary; the frontend holds no authorization
authority.

**Core flows:** registration and sign-in; technician profile and verification; customer
service requests; PostGIS-based matching and an offer lifecycle; reviews; in-app notifications
with optional Web Push; administrator review.

**Scale assumption:** a community pilot in two cities. Volume is not currently a material
privacy risk; **provenance and misuse are**, which is why the assessment concentrates on
identity documents, precise location and privileged access.

---

## 2. Data subjects

| Subject | Nature of their data | Sensitivity |
|---|---|---|
| Customers | Identity, service requests, offers, reviews, notifications | Ordinary, some free text |
| Technicians | Identity, professional profile, **identity documents**, reputation | **Higher risk** — identity evidence |
| Administrators | Identity, privileged access | Higher risk by virtue of role |
| Verification reviewers | Access to identity documents | Higher risk by role |

---

## 3. Processing activities

Fifteen implemented activities (A.1–A.15) are recorded in
`docs/RECORD_OF_PROCESSING_ACTIVITIES.md`. The highest-risk ones are assessed below.

---

## 4. Location processing

**What happens.** Technician coordinates are stored and used by the matching engine to
calculate distances and order candidates. Customer request coordinate columns exist but are
**never populated**. There is **no** geolocation API call anywhere in the frontend.

**Finding G-01 and its remediation.** Task 28.3A found that `latitude`/`longitude` were
returned by three **unauthenticated** endpoints. This was corrected in Task 28.3A.1:

| Route | Now returns |
|---|---|
| `GET /technicians` | `serviceArea` only — no coordinate |
| `GET /technicians/:id` | `serviceArea` only — no coordinate |
| `GET /technicians/nearby` | `serviceArea` + `distance_meters` in **100 m buckets**; no coordinate, no geometry; **rate limited** |

The PostGIS radius search itself is preserved: the stored point is used inside the SQL
predicate (`ST_DWithin`) and ordering (`ST_Distance`) only. Internal dispatch ranking
(`assertOfferEligibility`) still reads coordinates directly.

The frontend no longer maps any coordinate into its `Technician` object, so a server-provided
coordinate cannot re-enter the UI as display data. The prototype map derives a coarse
service-area city-centre marker instead — verified by a 19-assertion frontend suite that
proves markers still render and are derived from the service area, not a stored point.

**Residual risk.** 100 m rounding is a mitigation, not a proof: a caller probing repeatedly
from different points can still narrow a position. Mitigations: the route is rate limited; the
data today is a city-centre seed, not a residential address. **If deployment ever captures
genuine technician coordinates, this endpoint must be re-assessed before launch.**

---

## 5. Verification documents — the highest-risk processing

Identity documents (national ID, certificate) are processed. Risk: an ID document can expose a
face, an identity number and a signature. This is the most sensitive activity in the system.

**Implemented controls:**

| Control | Implementation |
|---|---|
| Never public | No route lists documents publicly; bytes leave storage via one owner-scoped route only |
| Authorized access | Owning technician **or** administrator; everyone else gets `404` |
| No existence leak | A foreign document and a non-existent document return an **identical** 404 |
| No path disclosure | Storage keys are opaque and traversal-validated; the storage root never appears in a payload |
| No key disclosure | `storage_key` is never returned by any route, including the owner's export |
| Upload validation | Size cap, declared-type check, and **magic-byte** verification of actual content |
| Filename safety | Sanitised on upload and again on download (quotes, backslash, CR/LF, `/` removed; length capped) |
| No caching | `Cache-Control: no-store, no-cache, must-revalidate, private` and `Pragma: no-cache` |
| No log leakage | Document bytes and storage keys are never logged |
| Deletion | Replacing or withdrawing a document deletes the stored file; account deletion removes them all |
| Accountability | Every read of document bytes is recorded in the audit log, distinguishing owner from reviewer |

**Residual risks.**

- Administrators can read identity evidence. That is a necessary operational function, so the
  control is **accountability** (audited access) rather than prevention. It does not prevent
  misuse by a compromised administrator account.
- Rejection reasons are **administrator-authored free text** that is then placed into a
  notification to the technician. An administrator could quote document content in that text,
  duplicating higher-risk content into a second, unmoderated field. **Not yet mitigated** — see
  §10 open items.
- Documents are stored on the API server's local disk. A real deployment should move them to
  private object storage. That is a **deployment requirement**, not a claim of implementation.

---

## 6. Dispatch and matching

Customers describe a service; the engine selects technicians by category, skills, rating,
availability and PostGIS distance; the selected candidates receive offers; a technician
accepts or declines. Authorization is server-side: a customer may only act on their own
request, a technician only on offers they hold, an administrator within their role. A PostGIS
distance cap is applied on top of the role check where coordinates exist.

**Risk.** Dispatch metadata reveals which technicians were considered for which request —
commercially sensitive and mildly privacy-relevant. Mitigated by ownership guards; the offer
lifecycle is not a public surface.

**Notification side-effects.** Offer and status events create notifications for non-actor
participants only, deduplicated on a natural key `(user_id, type, reference_type, reference_id)`
with a race-safe advisory lock, and marked `pending` until genuinely delivered. A notification
failure never rolls back the business write.

---

## 7. Notifications and Web Push

**Implemented.** Notifications are persisted; the data subject can now read their own history,
mark items read, and mark all read (`GET /api/v1/me/notifications*`). The recipient always
comes from the session — there is no client-supplied recipient anywhere.

**Gap G-02 is closed.** The application previously persisted notifications and delivered them
to devices but exposed **no** subject-facing route at all. A privacy notice published at that
point would have had to describe a surface that did not exist. It exists now, on top of the
existing table and the existing `NotificationService` read methods — no competing store, no
change to delivery semantics.

**Web Push.** Enabled only by explicit user action. Payloads are `aes128gcm`-encrypted to the
subscription's key material; the push service receives ciphertext, an endpoint and key
material. Delivery truthfulness: a row is marked `sent` only on genuine provider acceptance,
`provider_message_id` stays `NULL` because the protocol returns none, and failed delivery
records a `failure_reason`.

**SMS boundary.** The Africa's Talking adapter is implemented and unit-tested but **inactive**:
no route calls the provider, so nothing is sent. An optional number *can* now be stored in
`user_phones` (28.4), read only by `GET /api/v1/requests/:id/contact` to offer a `tel:` link,
and deleted with the account. **No real credits are spent in tests**; the network boundary is
stubbed.

**Communication boundary (28.4).** Chat text moves only between the browser and our own API
over HTTPS, and optionally over the same-origin WebSocket (`/api/v1/realtime`) after access-token
verification and a database re-authorization check. The transport carries message ids and
timestamps, never the body — the body stays in PostgreSQL and is fetched under authorization.
Message text enters no notification, push payload, audit event or log line, and no phone number
appears in any of them.

**Risk.** Notification message text can carry a technician's name and, in the rejection case,
administrator-authored text. A push provider therefore receives that content in encrypted
form. Mitigated by encryption and a conservative SMS event allow-list.

---

## 8. Automated decision-making

**`POST /classify` is a deterministic keyword/regex chain executing inside our own server.**

It is **not** an AI model, **not** machine learning, and **not** a third-party service. No data
is transmitted to any provider. It is advisory: it suggests a category, the user can change it,
and every consequential decision (request status, offer acceptance, verification outcome)
remains with a person or the ordinary application workflow. Its unauthenticated exposure is
recorded as gap G-09.

**Future AI (Task 28.6/28.8, not started).** If an external model were introduced it would be
**new processing involving a new provider**, requiring its own assessment, minimal data
transmission, a confidence threshold with a deterministic fallback, timeout/error handling,
rate limiting, a notice update, and a processor entry. None of that exists today and none of it
is claimed.

---

## 9. Data-subject rights — implementation status

| Right | Status | Control |
|---|---|---|
| Access / portability | **Implemented (28.3C)** | `GET /api/v1/me/data` → JSON, server-generated, in-browser download |
| Erasure | **Implemented (28.3D)** | `DELETE /api/v1/me/account`, real deletion, password + phrase confirmation |
| Notification history | **Implemented (28.3C)** | Inbox, read state, mark-all-read, honest empty state |
| Rectification | Partial | Biography, skills, availability editable. No self-service name/email change |
| Restriction | Not implemented | Would require a status the schema does not have |
| Objection / withdraw push | **Implemented** | `DELETE /api/v1/me/push-subscriptions/:id` |
| Automated decision review | Not applicable | Classification is deterministic and advisory |

**Access controls enforced in every case:** subject derived from the authenticated principal
only; server-side authorization; `404`-on-foreign rather than `403`, to avoid confirming
existence; no administrator bypass on self-service routes; strict rate limits.

**Erasure leaves retained security events** in minimised form (opaque ids only). This is
deliberate: `audit_events` has no foreign key to `users` precisely so an erasure request does
not destroy the accountability record. The retained count is disclosed before confirmation.

---

## 10. Risks, mitigations and residual risk

| # | Risk | Severity | Mitigations implemented | Residual |
|---|---|---|---|---|
| R1 | Identity document exposure | **High** | Private storage, owner/admin-only access, identical 404s, no key disclosure, magic-byte validation, no-store caching, audited access | Administrator misuse; documents on local disk; rejection-reason duplication (unmitigated) |
| R2 | Precise location exposure | **High** (was) | **Remediated (28.3A.1)**: no coordinate in any public projection; 100 m buckets; rate limit; coarse frontend markers | Triangulation over many probes; re-assess if real coordinates are captured |
| R3 | Cross-user data access | **High** | Server-side authz on every route; session-scoped subject; ownership guards; cross-user `404` | None identified |
| R4 | Credential compromise | **High** | Argon2id; hashed refresh tokens in HttpOnly cookies; reuse detection revoking all sessions; rate limits; account-status re-read per request | No MFA, no breach-response procedure |
| R5 | Privileged-administrator misuse | Medium | Every admin action audited with actor, target, outcome; no IP storage (privacy-minimal) | Audit does not prevent; no staff offboarding process |
| R6 | Over-retention | Medium | Documented policy; implemented idempotent cleanup for sessions and read notifications; explicit deletion | Most categories have no agreed period; **no scheduled job** by design |
| R7 | Unverified cross-border position | Medium | Documented as unresolved rather than assumed | **Cannot answer "where is my data"** — blocks launch |
| R8 | Notification data without a user surface | Medium (was) | **Remediated (28.3C)**: real inbox | None |
| R9 | Unbounded admin free text | Medium | Currently none | Rejection reason can quote document content; needs a length bound + moderation |
| R10 | No incident procedure | Medium | Audit log provides evidence | **No runbook, notification channel, or evidence policy** |
| R11 | Fake/placeholder privacy data | Low–Medium | Removed the hardcoded sidebar "2" unread count; honest empty states throughout | None known |
| R12 | Unauthenticated `/classify` | Low | Rate limited; deterministic and local | Unbounded input volume; advisory only |
| R13 | Consent basis unestablished | Medium | Documented explicitly; no consent records fabricated | **Cannot state a lawful basis** — blocks launch |

---

## 11. Data minimisation

- Public technician projections return no coordinate (G-01 remediated) and no storage key.
- The export excludes password material, token hashes, document bytes/keys, push device keys
  and endpoint URLs, and other users' data — each for a stated reason.
- Audit metadata is constrained to an **allow-listed** key set with primitive values only, so
  personal data cannot be smuggled into a security record.
- **No IP addresses are stored**, and IP collection was deliberately not introduced for audit.
- No analytics, advertising or tracking provider exists, and no token is persisted to web
  storage.

---

## 12. Access control summary

Server-side enforcement on every protected route; role and ownership re-read from PostgreSQL
per request (a token claim alone grants nothing); refresh-token reuse detection; CORS
allow-list; rate limits; strict Zod schemas that reject client-supplied identity fields;
security headers; existence-hidden 404s.

---

## 13. Third-party processing

Five parties assessed in `docs/THIRD_PARTY_PROCESSORS.md`: database hosting, the Web Push
service, the SMS gateway (inactive), planned object storage, and a future AI provider. Only
the database and the push service are capable of active processing today. **No processing
location is established for any of them**, and no contractual arrangement is claimed.

---

## 14. Conclusion

Task 28.3 materially reduced the prototype's privacy risk. The two highest-severity findings
from 28.3A — public coordinate exposure (G-01) and the absence of any subject-facing
notification surface (G-02) — are **resolved and verified**. Data access, export and permanent
erasure are now real, server-authoritative capabilities rather than aspirations, and
security-relevant events are recorded without collecting new personal data.

The system is **not** ready for an unrestricted production launch, primarily because of
residual R1 (identity documents on local disk, unmoderated rejection text), R7 (unknown data
location), R10 (no incident procedure) and R13 (no confirmed lawful basis). None of these is
disguised as solved: each is stated, assigned and left open.
