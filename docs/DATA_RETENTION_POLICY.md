# Umodzi Connect — Data Retention & Lifecycle Policy

**Status:** Draft 0.3 — prepared for Task 28.3. Academic prototype.

> **No invented legal periods.** This policy does **not** assert any statutory retention
> period, because none could be verified: during Task 28.3A the gazetted text of the Zambia
> Data Protection Act and the Data Protection Commission site were both unreachable (HTTP 403
> and a transport error respectively), and web search returned no results. Section-level
> mapping is recorded as an open item, not guessed at.
>
> Every period below is therefore either (a) an **implemented technical rule** that the code
> actually enforces, or (b) a **defensible operational proposal** explicitly marked as
> **requires deployment-time/legal confirmation**. Nothing is presented as legally required.

---

## 1. Design principles

1. **Minimise by default.** A category is retained only while it serves a stated purpose.
2. **Credentials die first.** The strongest deletion candidates are the ones that are also the
   biggest liability: session rows hold a credential hash.
3. **Nothing is deleted autonomously.** There is **no** `setInterval`, cron entry, or
   scheduler anywhere in this codebase. Retention is an **explicit, operator-invoked
   operation** that returns exactly what it removed. An unattended job that deletes rows is a
   production hazard: a misconfiguration would destroy data with nobody watching.
4. **Idempotent and observable.** Running any cleanup twice is safe; the second run removes
   zero rows. Every action returns and logs the real number of rows affected.
5. **Deletion of the person must beat deletion of the audit trail.** Security records survive
   an account deletion in minimised form, for a stated reason (see §5).

---

## 2. Retention schedule

| # | Category | Period | Status | Enforced by | Confirmation needed |
|---|---|---|---|---|---|
| 1 | **Sessions (revoked or expired)** | 30 days after expiry | **Implemented** | `purgeExpiredSessions()` | Confirm 30 days is proportionate |
| 2 | **Notifications — read and delivered** | 180 days | **Implemented** | `purgeOldNotifications()` | Confirm 180 days is proportionate |
| 3 | **Notifications — unread** | Retained | **Implemented (no deletion)** | Deliberately excluded from cleanup | Confirm unread retention is acceptable |
| 4 | **Notifications — `pending`/`failed`** | Retained until resolved | **Implemented (no deletion)** | Excluded; an operator may need to inspect a failed delivery | Define an escalation/closure rule |
| 5 | **Push subscriptions (dead endpoint)** | Removed on real 404/410 | **Implemented** | `PushService` prunes inline on genuine provider rejection | None — driven by a real signal |
| 6 | **Push subscriptions (stale, no signal)** | Retained | No action | Deliberately not guessed at | Define a staleness threshold |
| 7 | **Account + profile** | Life of the account | Proposed | Account deletion (28.3D) | Confirm life-of-account is the right default |
| 8 | **Service requests** | Life of the account | Proposed | Account deletion (28.3D) | **Confirm — commercial/contract retention may require a period** |
| 9 | **Dispatch offers** | With the request | Proposed | Cascades with the request | Same as #8 |
| 10 | **Reviews** | With the request / profile | Proposed | Cascades | **Confirm — reputation history may need to survive a profile removal** |
| 11 | **Technician verification documents** | Life of the profile | Proposed | Replaced/withdrawn by the technician, or removed on account deletion | **Confirm — identity evidence retention needs a decision** |
| 12 | **Technician profile photo** | Life of the profile | Implemented | Replacing a photo deletes the previous object immediately | None |
| 13 | **Security / audit events** | See §5 | **Implemented (retained on deletion)** | Not purged | **Confirm a security-record period** |
| 14 | **Data exports** | Not stored | **Implemented** | Generated on demand, held in the browser only | None |
| 15 | **Conversations & messages (28.4)** | Life of the relationship and account | **Implemented (cascade only)** | `ON DELETE CASCADE` from `service_requests` / `users` / `technicians` (migration 007). No time-based purge runs | **Confirm whether a closed conversation needs a retention period** |
| 16 | **Phone number — `user_phones` (28.4)** | Until the owner replaces it, or account deletion | **Implemented (owner overwrite + cascade)** | `PUT /api/v1/me/phone` replaces the row; `ON DELETE CASCADE` with the account (migration 008) | **Confirm an idle-number retention period** |

Rows marked **Confirmation needed** are the ones that genuinely need a decision. They are
listed rather than silently defaulted.

---

## 3. Implemented cleanup — scope and safety

Both implemented operations are in `backend/src/privacy/retentionService.ts` and are invoked
via `runRetentionSweep()`.

### 3.1 Expired sessions — `purgeExpiredSessions()`

Removes session rows that are **both** past `expires_at` **and** older than the retention
window. Active, unexpired sessions are never touched.

*Why this is safe and desirable:* a session row holds the SHA-256 hash of a refresh token.
Once the row is gone, that token can never be replayed. Expiry is already enforced at read
time, so this changes nothing about the security posture — it stops accumulating unusable
credential hashes. Default 30 days, configurable with `RETENTION_SESSIONS_DAYS`.

### 3.2 Old notifications — `purgeOldNotifications()`

Deliberately narrow. A row is eligible only if **all** of these hold:

- `read = true`, and
- `status IN ('sent','delivered')`, and
- `created_at` older than the retention window.

Unread notifications are still live personal data the subject has not consumed. A
`pending` or `failed` row is the record of a delivery attempt an operator may still need to
inspect. **Neither category is ever deleted by the sweep.** Default 180 days, configurable
with `RETENTION_NOTIFICATIONS_DAYS`.

### 3.3 Push subscriptions

No sweep deletes push subscriptions, because there is no persisted "this endpoint is dead"
marker to act on safely. Pruning already happens **inline in the delivery path**, and only on
a **genuine 404/410 from the push provider** — never a guess, never a timeout, never a
network error. `purgeDeadPushSubscriptions()` therefore only *counts* and reports old rows;
it removes nothing, and says so rather than pretending otherwise.

---

## 4. Lifecycle rules for the data that has no automated cleanup

- **Account and profile:** deleted permanently on request (28.3D). No deactivation flag
  exists in the schema; `account_status` expresses suspension/disablement by an
  administrator, which is an operational control, not an erasure mechanism.
- **Requests, offers, reviews:** cascade with their parent. See the deletion consequences in
  `PRIVACY_POLICY.md` §8.2 — in particular, reviews about a deleted technician profile are
  removed with it.
- **Verification documents:** replaced (old file deleted) or withdrawn by the technician while
  the verification is editable; removed on account deletion.
- **Exports:** never persisted. The export endpoint assembles JSON per request and the file
  is created in the browser, so there is no export archive to retain or purge.

---

## 5. Why security events survive account deletion

`audit_events` has **no foreign key** to `users`. This is a deliberate design decision, not
an oversight.

If the audit log referenced `users(id)`, a permanent-deletion request could only be honoured
by destroying the security history — which would erase the accountability record for that
account — or by refusing the deletion. Neither is acceptable.

Instead, on deletion the user's rows disappear and the security events remain, holding only
what is needed to answer "what happened to this account":

- an opaque UUID (no name, email, request text or document content),
- the event type and outcome,
- an allow-listed set of technical metadata.

The number of retained events is disclosed to the user **before** they confirm deletion.

The retention **period** for those records is an open item requiring confirmation.

---

## 6. Operational notes

- Periods are configured by environment variable, never hard-coded into SQL.
- `runRetentionSweep()` returns `{ sessionsRemoved, notificationsRemoved,
  oldPushSubscriptionsObserved, configured }`. An operator can always tell what happened.
- Running the sweep against a database with nothing to remove returns zeros. That is the
  expected steady state, not an error.
- **Do not schedule this against production until the confirmation items in §2 are settled.**
  A retention rule with no agreed period should not be automated.

---

## 7. Open items requiring confirmation

1. **Commercial/contractual retention** for service requests and offers — unverified.
2. **Reputation retention** — whether reviews should survive a technician's profile removal,
   which would require a deliberate design change (a pseudonymous author record) rather than
   the current `NOT NULL` cascade.
3. **Identity-evidence retention** for verification documents.
4. **Security-record retention period.**
5. **Staleness threshold** for push subscriptions with no 404/410 signal.
6. **Closure rule** for `failed`/`pending` notifications, and whether they are retained or
   replaced by an aggregated failure count.
7. **Statutory retention periods** — unverified, see the header note.
