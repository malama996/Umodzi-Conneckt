# Umodzi Connect — Privacy Notice

**Status:** Draft 0.3 — prepared for Task 28.3. Academic prototype being prepared for
production readiness.

> **What this document is not.** This is **not** a legal document and it does **not** claim
> that Umodzi Connect complies with any law, is registered with any supervisory authority,
> has appointed a data protection officer, or holds any certification. Nothing in the
> repository establishes any of those things. Where a decision needs legal or organisational
> confirmation, this notice says so explicitly rather than presenting it as settled.
>
> This notice describes the system **as actually implemented**, verified against the code and
> the database schema. Behaviour that is planned but not built is labelled as such.

**Live version:** the same content is published in the application at `/privacy`, and a
concise summary is shown on the registration form. The in-app text is generated from a single
source (`frontend/lib/privacy/notice.ts`), so the two cannot drift apart.

---

## 1. Who this notice covers

Umodzi Connect is an academic prototype that connects customers with local technicians in
Kitwe and Ndola, Zambia. The data subjects are:

- **Customers** — people who ask for a service.
- **Technicians** — people who offer a service.
- **Administrators** — staff who review accounts and technician verification. They are also
  data subjects in their own right, and they are the people with privileged access.

---

## 2. What we collect

| Category | What it contains | Why it is collected |
|---|---|---|
| Account data | Name, email address, Argon2id password hash, role, account status | To create an account and authenticate it |
| Technician profile | Display name, category, skills, service area, availability, biography | To let customers find and judge a technician |
| Technician verification | Uploaded identity documents (national ID, certificate, other), their type, filename, size, and the review decision | To verify that a technician is who they say they are |
| Service requests | Description, category, city, status | To dispatch a technician to a job |
| Location | Technician service area, and stored coordinates used **only** for internal distance calculation | To match a nearby technician to a request |
| Dispatch / offers | Which technicians were matched to which request, in what order, and the outcome | To run the matching engine and the offer lifecycle |
| Reviews | Star rating and comment for a completed service | Reputation for technicians |
| Notifications | Generated messages about requests, offers and verification | To tell the data subject what happened |
| Push subscriptions | Endpoint, device keys, user agent, timestamps | To deliver a browser notification to that device |
| Storage objects | Profile photo bytes, verification document bytes | To display a photo; to evidence verification |
| Authentication / session | Session id, expiry, revocation state, last-used time | To keep a session alive and to detect token theft |
| Security events | Event type, opaque actor/target ids, outcome, timestamp | To detect and investigate abuse |

### 2.1 What is required and what is optional

**Required to create an account:** name, email address, password.

**Required to register as a technician:** service category and service area.

**Optional:** biography, profile photo, verification documents, browser notifications.
Declining any of these does not prevent use of the service — a technician simply will not
carry a verified badge.

---

## 3. Location processing — the important part

Precise technician coordinates **are stored**, and they are used for a real operational
purpose: the matching engine calculates distances and orders nearby technicians.

Precise coordinates are **not published**. No public route returns a stored coordinate for any
technician. Public technician information is limited to the service area the technician
declared for themselves, plus rating, job count, verification badge, skills and availability.

This was a real finding during Task 28.3A and was **corrected in Task 28.3A.1** (gap G-01).
Before that correction, three unauthenticated endpoints returned `latitude`/`longitude`.
They no longer do.

`GET /technicians/nearby` still performs a genuine PostGIS radius search, but:

- the stored point is used only inside the SQL predicate and ordering, never projected;
- the returned `distance_meters` is coarsened to a **100 metre bucket**, because a precise
  distance would let a caller triangulate a position;
- the route is **rate limited**;
- the caller supplies their *own* coordinates as a query parameter. Echoing a caller's own
  input back is not a disclosure, and a radius search cannot work without it.

**The system does not collect real GPS.** There is no geolocation API call in the frontend,
and technician coordinates at registration are hard-coded approximate city-centre seeds. No
customer request coordinate is ever populated, although the columns exist.

**Residual risk, stated honestly:** 100 m rounding is a mitigation, not a proof. A caller who
probes repeatedly from different points can still narrow a position over time. This is
recorded as a residual risk in the DPIA.

---

## 4. Who can see what

| Audience | Can access |
|---|---|
| Anyone (unauthenticated) | Technician display name, category, skills, service area, rating, jobs completed, verification badge, availability text, biography, profile photo, and the public review bundle (author shown as a pseudonym) |
| The other party in a service | The request details and offers connected to it |
| The data subject | Their sessions, notification history, verification documents, security-event history, and their full data export |
| Administrators | Account records (name, email, role, status), service requests, and technician verification review. **This privileged access is recorded in the audit log** |
| Nobody | The password, the stored password hash, session token hashes, and refresh tokens — never disclosed in any form, to anyone, including administrators |

Reviewer identity is reduced to a pseudonym ("First L.") on the public reviews bundle, so a
review does not expose the reviewer's full name or email to the public.

---

## 5. Verification documents

Identity documents are the highest-risk data this system handles. Implemented controls:

- documents are **never listed publicly** and bytes are served only through one
  owner-scoped route;
- that route allows only the **owning technician** or an **administrator**; every other
  request — including for a document that does not exist — receives the same `404`, so
  document existence is not disclosed;
- stored object keys are opaque references validated against traversal, and the storage root
  is never exposed in any payload;
- uploads are size-limited, type-checked, and **validated by magic bytes** (actual file
  content must match the declared type);
- client filenames are sanitised before use, and the download response sanitises them again;
- document responses are sent with `Cache-Control: no-store` and `Pragma: no-cache`, so
  identity evidence is not written to a browser or intermediary cache;
- document bytes are **never written to a log**, and the storage key is never logged;
- replacing or withdrawing a document deletes the stored file;
- every read of document bytes is recorded in the audit log with the reader's role and
  whether they were the owner or a reviewer.

---

## 6. Notifications, Web Push and SMS

**In-app history.** Notifications are persisted and the data subject can now read their own
history, mark items read, and mark all read (`GET/PATCH/POST /api/v1/me/notifications*`).
This was a Task 28.3 gap (G-02): the application previously persisted notifications and pushed
them to devices but exposed **no** way for a person to read their own history. It is now
closed. The recipient is always taken from the session; there is no client-supplied recipient.

**Web Push.** If browser notifications are enabled, the system uses the Web Push standard.
The browser vendor's push service receives an encrypted payload and a subscription endpoint.
Content is encrypted (aes128gcm) to the subscription's key material. Delivery outcomes are
recorded honestly: a notification is marked `sent` only on genuine provider acceptance, and
no provider message id is ever fabricated (the Web Push protocol returns none).

**Phone number — optional, self-service, never used for SMS.** Migration
`008_communication_phone.sql` adds `user_phones`, where a person may store **their own**
number (`purpose = 'service_contact'`) in E.164-style form. One route reads it:
`GET /api/v1/requests/:id/contact`, which returns the other participant's number **only**
inside an accepted service relationship and returns **404** when no number exists — a number
is never derived, guessed or synthesised. The number is visible to its owner and to the other
participant of that user's own accepted request, appears in no public profile, enters no
notification, push payload or log line, and is deleted with the account.

**SMS — implemented but inactive.** The Africa's Talking adapter and the conservative SMS
policy still exist, but **no route calls the SMS provider** and no notification type is
SMS-eligible, so no SMS is sent. Holding an optional number does not by itself make SMS
active; enabling it remains a deployment decision needing purpose, retention and provider
arrangements.

**Classification.** `POST /classify` is a **deterministic keyword/regex chain** running
inside our own server. It is **not** an AI or machine-learning model, and no data is sent to
any external provider. It only suggests a category; it never decides anything for the user.

---

## 7. Security safeguards (implemented)

- Passwords hashed with **Argon2id**; never stored or logged in readable form.
- **Signed, short-lived access tokens** with issuer and audience verification.
- **Refresh tokens stored only as a SHA-256 hash**, in an **HttpOnly** cookie scoped to the
  auth path, with `SameSite=Lax` and `Secure` applied when the request is HTTPS.
- **Refresh-token reuse detection** — a replayed token revokes every session for the account.
- **Server-side authorization** on every protected route; role and ownership are re-read from
  the database on each request, so a stale or forged token claim grants nothing.
- **Existence-hidden 404s** for cross-user resources, preventing ID enumeration.
- CORS restricted to an **explicit origin allow-list** with credentials.
- **Rate limiting** on authentication and on sensitive routes.
- Security response headers (nosniff, referrer-policy, frame-deny, restrictive CSP,
  permissions-policy).
- **Strict Zod schemas** on every mutating route; client-supplied identity fields are rejected.
- Upload size limits and magic-byte validation; storage-key traversal rejection.
- **Audit logging** of security-relevant events, with an allow-listed metadata vocabulary so
  credentials and personal data cannot reach the log.

### 7.1 Client IP addresses

The system **does not store client IP addresses** anywhere. Task 28.3F deliberately did
**not** introduce IP collection into the audit log, because doing so would add a new,
pervasive personal-data category as a side effect of a logging feature. If a deployment
establishes a concrete abuse-investigation requirement, that is a separate change with its
own notice, retention rule and legal confirmation.

---

## 8. Your rights and controls

| Right | Control | Route |
|---|---|---|
| Access / portability | Download a complete JSON copy of your data | `GET /api/v1/me/data` → in-app "Download my data" |
| Erasure | Permanently delete your account | `DELETE /api/v1/me/account` → in-app "Delete account" |
| Notification history | Read, mark read, mark all read | `GET/PATCH/POST /api/v1/me/notifications*` |
| Rectification | Edit biography, skills, availability | `PATCH /api/v1/technician/profile` |
| Withdraw consent | Turn off browser notifications, withdraw an uploaded document | `DELETE /api/v1/me/push-subscriptions/:id`, `DELETE /api/v1/technician/verification/documents/:id` |

### 8.1 Export scope and format

The export is a real, server-generated JSON document (`format: "umodzi-account-export-v1"`)
built from authoritative database relationships at request time. Nothing is stored: the file
is created in the browser.

**Included:** account record, technician profile (including the subject's *own* stored
coordinates, which are withheld from every public route but are their personal data),
verification status and document metadata, sessions, service requests, offers made and
received, reviews written and received, notifications, push-subscription metadata, and the
account's own security events.

**Deliberately excluded**, and why:

- `password_hash` and all password material — never disclosed in any form;
- session token hashes and refresh tokens — security credentials;
- verification document storage keys and file bytes — retrieved through the owner-scoped
  route *after* authorization, so access still passes the authorization boundary;
- push device keys (`p256dh`, `auth`) and full endpoint URLs — the endpoint is itself a
  delivery capability;
- other users' data and administrator-only records;
- reviewer identities for reviews received — published only as the pseudonym shown publicly.

### 8.2 Permanent deletion — what actually happens

Deletion is **real**, not a deactivation flag. In one transaction, after collecting the
storage keys it owns, the system:

1. deletes reviews the account authored;
2. deletes the account's service requests (cascading their offers and reviews);
3. deletes the account's technician profile (cascading offers received, verification
   documents, and reviews about that profile);
4. deletes notifications, push subscriptions and sessions;
5. deletes the account row;
6. then, post-commit and best-effort, unlinks the owned profile photo and verification
   document files.

Sessions are revoked, so the account cannot be used again. A bare `DELETE FROM users` would
**not** be sufficient: `service_requests.customer_user_id` and `technicians.user_id` are
`ON DELETE SET NULL`, which would orphan a deleted user's request descriptions and profile
rather than removing them. That is why the removal is explicit.

**Confirmed deletion behaviour:** the system revokes sessions and removes its own records.
It has **no mechanism** to request deletion from the browser-vendor push service or from any
other third party, and does not claim to.

**Documented consequences:**

- Reviews that *other* customers wrote about a deleted technician profile are removed with
  that profile, because `reviews.technician_id` is `NOT NULL` and cascades. A review cannot
  exist without a subject. The technician's rating and job-count aggregates also disappear.
- **Security/audit events are retained** in a deliberately minimised form — opaque ids, no
  name, email, request text or document content. `audit_events` has **no foreign key** to
  `users` precisely so that honouring a deletion request does not destroy the accountability
  record. The retained count is shown to the user before they confirm.
- If storage unlink fails, the deletion still succeeds and the failure is logged. An orphaned
  file is unreachable, because bytes are only served after a database lookup of the key and
  that row no longer exists.

### 8.3 Re-authentication and confirmation

Permanent deletion requires a valid session **and** the account password **and** the exact
confirmation phrase `DELETE MY ACCOUNT`. A stolen live session alone is not sufficient. The
UI additionally requires the user to open the panel explicitly, and shows real counts of what
will be removed rather than a generic warning.

---

## 9. Retention

Retention rules and the operational proposal — including every period that still requires
confirmation — are documented in `docs/DATA_RETENTION_POLICY.md`. Summary:

- **Implemented and enforced:** expired/revoked sessions; read, delivered notifications past
  the retention window. Run as an explicit, idempotent, operator-invoked operation — never
  as an unattended timer.
- **Proposed, not enforced as final:** accounts, service requests, offers, reviews,
  verification documents, profile photos, security events, and exports.

---

## 10. External providers and cross-border processing

Documented in full in `docs/THIRD_PARTY_PROCESSORS.md`. Position in summary:

| Provider | Status | Notes |
|---|---|---|
| PostgreSQL (hosting) | Configured but not deployed | **Processing location not established.** No claim is made |
| Web Push service (browser vendor) | **Active when the user enables notifications** | Receives an encrypted payload and an endpoint |
| Africa's Talking (SMS) | **Implemented but inactive** | An optional number may now exist in `user_phones`, but no route calls the provider, so nothing is sent |
| Object storage (Supabase or equivalent) | **Planned, not implemented** | Current storage is a server-local adapter behind a `FileStorage` interface |
| AI/classification vendor | **Not present** | Classification is deterministic and local |
| Analytics / advertising | **Not present** | No tracking provider is integrated |

Provider locations, contractual/DPA arrangements and any transfer mechanism are **not**
established. Each is recorded as requiring confirmation before production.

---

## 11. If something goes wrong (incident handling)

Security-relevant events are recorded in an append-only `audit_events` table: authentication
failures and successes, administrator account-status changes, verification decisions,
verification-document reads and withdrawals, data exports, and account deletions. The log
never contains passwords, tokens, keys, document contents or request text.

**A written incident-response procedure does not yet exist.** No runbook, no notification
channel, no evidence-preservation policy is established anywhere in the repository. This is
recorded as an identified requirement (gap G-12 / the DPIA's residual-risk list) and must be
created before a production launch. This notice does not claim otherwise.

---

## 12. Complaints and escalation

**A named contact point and escalation path have not yet been established.** Until they are,
complaints and concerns should be raised with the project team through the channel advertised
on this site. This is an open item, stated here rather than papered over with a placeholder
address.

---

## 13. Status and open items

This is an academic prototype. The following **require legal and/or organisational
confirmation before any production deployment**, and none of them is claimed as satisfied:

1. The lawful basis for each distinct processing purpose.
2. Whether registration with a supervisory authority is required, and if so, when.
3. Whether a data protection officer must be appointed.
4. Final retention periods per data category.
5. Provider processing locations, and any data-processing agreements or transfer mechanisms.
6. The incident-response procedure, including who is notified and within what timeframe.
7. A named privacy contact and complaints escalation path.
8. Whether explicit consent must be captured and stored for any purpose. **No consent record
   is stored today**: the registration checkbox is a UI gate, and the absence of a consent
   store is a documented design decision pending point 1, not an oversight.
