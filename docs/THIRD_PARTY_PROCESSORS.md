# Umodzi Connect — Third-Party Processors & Cross-Border Position

**Status:** Draft 0.3 — prepared for Task 28.3. Academic prototype.

> **Scope discipline.** This register documents only parties that are **actually present in
> the implementation**, plus parties that are **explicitly planned and labelled as such**. No
> provider is listed because it "would be logical" to use one.
>
> **No invented facts.** No processing location, no transfer mechanism, no contractual term
> and no legal role is asserted for any provider. Where the repository contains no evidence,
> the row says so and records the item as requiring confirmation. These descriptions are an
> **operational** characterisation of who does what with the data, not a legal determination
> of controller/processor status.

Each entry is labelled with one of:

- **IMPLEMENTED** — present in the source and reachable.
- **CONFIGURED BUT INACTIVE** — the code path exists and is verified, but cannot run because
  a required input does not exist or is not supplied.
- **PLANNED** — contemplated, **not** implemented. No claim is made that it is.
- **DEPLOYMENT-TIME CONFIRMATION REQUIRED** — an open item that blocks a production launch.

---

## 1. Register

### 1.1 PostgreSQL / Supabase (database hosting)

| Field | Value |
|---|---|
| **Status** | **CONFIGURED BUT INACTIVE** — the local scratch database is running; no production database is deployed |
| **Purpose** | System of record for every category in the inventory |
| **Data categories** | Identity/account, technician profiles, verification metadata, service requests, dispatch/offers, reviews, notifications, push subscriptions, session state, security events |
| **Trigger** | Every request that reads or writes |
| **What leaves Umodzi** | Everything in the schema. This *is* Umodzi's data store — the question is only where it is physically located |
| **Credentials** | `DATABASE_URL` environment variable. Never logged, never in `NEXT_PUBLIC_*`, never in documentation |
| **Processing location** | **NOT ESTABLISHED.** The repository contains no region, host or provider configuration. No claim is made |
| **Deletion / retention boundary** | Umodzi deletes rows directly. There is no processor-side deletion request mechanism, and none is claimed |
| **Confirmation required** | Hosting region; whether a data-processing agreement is required; any transfer mechanism if the region is outside Zambia |

### 1.2 Web Push service (browser vendor)

| Field | Value |
|---|---|
| **Status** | **IMPLEMENTED and ACTIVE** — but only for a user who has explicitly enabled browser notifications |
| **Purpose** | Deliver a notification to a user's device while the app is closed |
| **Data categories** | An **encrypted** notification payload, a push subscription endpoint, and the subscription's public key material |
| **Trigger** | A business event (request status change, offer, verification decision) with a matching notification for a user who has a live subscription |
| **What actually leaves Umodzi** | The `aes128gcm`-encrypted body, the endpoint URL, `p256dh` and `auth` values, and the `TTL`/` Urgency` headers. `web-push` performs the encryption using the subscription's keys — the plaintext is not transmitted |
| **Provider identity** | Determined by the user's **browser**, not by a Umodzi choice. Firefox relays through Mozilla/autumn; Chrome/Edge through Google; Safari through Apple |
| **Provider message id** | **None exists.** The Web Push protocol returns no per-message identifier, so `provider_message_id` stays `NULL`. None is ever fabricated |
| **Credentials** | VAPID key pair from environment variables. The private key is never logged, never returned by any route, and never present in frontend configuration |
| **Processing location** | **NOT ESTABLISHED** for any of the vendors above |
| **Deletion / retention boundary** | Umodzi can delete its own subscription rows. It has **no** mechanism to ask a push service to delete anything, and does not claim to. A stale endpoint is removed only when the provider genuinely answers 404/410 |
| **Confirmation required** | Whether the encrypted payload is treated as personal data in transit; acceptable use terms; location; whether a DPA is required |

### 1.3 Africa's Talking (SMS)

| Field | Value |
|---|---|
| **Status** | **CONFIGURED BUT INACTIVE** — the adapter is implemented and tested, but cannot send |
| **Why inactive** | **No code path calls this provider.** Since 28.4 an optional number *can* be stored in `user_phones`, but that table is read only by `GET /requests/:id/contact` for a `tel:` handoff — nothing is transmitted |
| **Purpose** | Would deliver SMS for events on a conservative allow-list only |
| **Data categories** | Would be a phone number plus a short message. The number may exist; the message is never composed or sent |
| **Trigger** | None — no notification type is SMS-eligible and no route invokes the adapter |
| **Credentials** | `AFRICASTALKING_API_KEY` / `AFRICASTALKING_USERNAME` (with `SMS_*` fallbacks), and `SMS_PROVIDER`. Never logged, never in `NEXT_PUBLIC_*` |
| **SMS policy** | Restricted to important events only, via an explicit allow-list. Message content is deliberately minimal |
| **Processing location** | **NOT ESTABLISHED** |
| **Deletion / retention boundary** | Nothing is sent. A stored `user_phones` row is owned by the account and removed with it (`ON DELETE CASCADE`) |
| **Confirmation required** | Whether SMS is wanted at all; if so the number, purpose, validation and notice work now exist and the remaining work is the activation policy plus retention period; provider location; agreement terms |
| **Test policy** | SMS tests stub the network boundary. **No real credits are spent.** |

### 1.4 Object storage (Supabase Storage or equivalent)

| Field | Value |
|---|---|
| **Status** | **PLANNED — NOT IMPLEMENTED** |
| **Correction to earlier documentation** | Task 28.3A referred to named Supabase buckets. Re-inspection for 28.3 established that **no Supabase Storage client exists in the backend source**. The named buckets were conceptual key prefixes, not real buckets. This register states the correction plainly rather than repeating the earlier assumption |
| **What exists today** | `FileStorage` (an interface: `put`/`read`/`remove`) with `LocalFileStorage` as the only implementation, rooted at `STORAGE_DIR`. Keys are opaque and traversal-validated |
| **Why it matters** | Verification documents and profile photos are higher-risk data. Storing them on the API server's local disk is a deployment risk, not a designed architecture |
| **Migration** | Because the abstraction is provider-neutral, a future object store implements the same three methods without touching routes, services or records. No route change is required |
| **Confirmation required** | Whether production storage should be an object store at all; bucket privacy (must be private, never public); provider location; agreement terms; backup and deletion semantics |

### 1.5 AI / classification vendor

| Field | Value |
|---|---|
| **Status** | **NOT PRESENT** |
| **What exists today** | `POST /classify` is a **deterministic keyword/regex chain** executing inside our own server. It is **not** an AI model, **not** machine learning, and involves **no** external provider |
| **Data sent externally** | **None.** The description is classified locally and is not transmitted anywhere |
| **Planned (Task 28.6/28.8, not started)** | A free-tier Gemini or suitable provider, backend-only key, structured category + confidence, a confidence threshold, a deterministic/manual fallback, timeout/error handling, rate limiting, and minimal data transmission |
| **Confirmation required** | Everything above, plus a genuine assessment of whether sending customer text to a third party is acceptable, and a notice update **before** it happens |

### 1.6 Analytics, advertising and tracking

| Field | Value |
|---|---|
| **Status** | **NOT PRESENT** |
| **Evidence** | No analytics, tag-manager, pixel, session-replay or advertising SDK is present in the frontend or backend |
| **Browser storage** | Frontend `localStorage` is used only for UI drafts: `umodzi:matching:category`, `umodzi:matching:area`, `umodzi:profile:<name>`. **No token or session material is persisted to web storage** — the access token is held in memory only |
| **Cookies** | One HttpOnly refresh cookie scoped to `/api/v1/auth` |
| **Confirmation required** | If analytics is ever added, it is new processing and new disclosure |

### 1.7 Email delivery

| Field | Value |
|---|---|
| **Status** | **NOT PRESENT** |
| **Notes** | No email-sending provider is integrated. `notifications.channel` permits `'email'` in the schema, but nothing writes to it. It is a reserved vocabulary value, not a live channel |

---

## 2. Cross-border position — the honest answer

**Not established.** This is the single largest unresolved item in the privacy work.

- The **database** location is unknown: no region, host or provider is configured anywhere in
  the repository.
- The **push service** is chosen by the user's browser vendor, whose infrastructure locations
  are not configured by Umodzi and are not asserted here.
- The **SMS gateway** location is unknown, and the gateway is inactive anyway.
- **No transfer mechanism is implemented or claimed** — no standard contractual clauses, no
  consent-to-transfer flow, no localisation configuration.

Accordingly, the system **cannot currently answer** "where is my data stored?" for a data
subject. That question is recorded in the privacy notice as unresolved rather than answered
optimistically.

### 2.1 To close this before production

1. Select and configure the production database host; record its region.
2. Select the object-storage provider (if any); record its region.
3. Obtain and file contractual terms for each provider, including any transfer clauses.
4. Update `docs/DATA_FLOW_DIAGRAM.md` and the privacy notice with the confirmed positions.
5. Re-run the DPIA with the locations known.

---

## 3. Controller / processor role — operational description

Stated as an operational description of function, **not** as a legal determination:

| Party | Operational role |
|---|---|
| Umodzi Connect (the project) | Determines what is collected and why, and provides the service. This is the party a data subject deals with |
| Administrators | Internal staff acting on the project's instructions. They are the **privileged-access** group; their access is recorded in the audit log |
| Database host | Stores the data on the project's instructions |
| Push service | Relays an encrypted message to reach a device. It receives the minimum needed for that relay and cannot read the plaintext |
| SMS gateway (inactive) | Would relay a short message to a phone number. Not in use |
| Browser vendor | Determined by the user's browser, outside the project's control |

A legal determination of controller/processor status for each relationship, and whether a
data-processing agreement is required, **requires legal confirmation** and is not made here.

---

## 4. Summary of what must be confirmed before launch

1. Production database host and **region**.
2. Whether identity documents and photos move to private object storage, and that provider's
   region.
3. Web Push vendor terms, and the position on encrypted payloads.
4. Africa's Talking: whether SMS is wanted at all; provider region and terms.
5. Contractual/DPA arrangements for every provider above.
6. Whether any transfer mechanism is required, and if so which.
7. A named privacy contact and complaints route.
