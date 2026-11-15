# Umodzi Connect — pre-presentation audit (15 November 2026)

Scope: reconnaissance and defect analysis ahead of the presentation on Wednesday 18 November 2026.
Deliberately light on execution: no full test sweep, no production build, no device installation.
Everything below distinguishes what was **inspected** from what was **run**.

## A. Initial findings

Statuses: PASS = implemented and verified by inspection of the actual code path. PARTIAL = works
but with a real gap. No FAIL or MISSING items were found in the P0 set.

| Area | Status | Evidence |
|---|---|---|
| Customer ↔ technician chat (send, persist, history) | PASS | `app/dashboard/messages/[conversationId]/page.tsx` posts through `communicationApi.sendConversationMessage`; the optimistic row is replaced only by the server's returned row, and a failed send becomes a visible retryable `Not sent · Retry` row — never a fake "delivered" |
| Chat authorization | PASS | Every conversation route (`GET /conversations/:id`, `/messages` GET+POST, `/read`, `/requests/:id/conversation`) calls `canAccessConversation` and answers **404** to a non-participant, administrator included |
| Message validation | PASS | Server schema: `z.string().trim().min(1).max(2000)`; client mirrors `MAX_MESSAGE_LENGTH = 2000`; send route rate-limited at 60 |
| Realtime transport | PASS | `lib/chat/useChatRealtime.ts` — WebSocket authenticated with a `bearer-<token>` subprotocol, one subscription to the active conversation only, explicit cleanup on unmount/conversation change, single reconnect attempt, catch-up refetch on re-subscribe |
| Read state and unread counts | PASS | `PATCH /conversations/:id/read` updates only the other participant's messages and returns the real count; list renders the count with an `sr-only` equivalent |
| Chat list freshness | **PARTIAL → fixed** | The list loaded once and then froze; unread badges and previews went stale until the user pressed Refresh (see B1) |
| Offline state outside chat | **PARTIAL → fixed** | Chat reported connecting/reconnecting/offline; every other surface had no connection indication at all (see B2) |
| PWA manifest | PASS | `app/manifest.ts`: id, name, short_name, description, start_url `/`, scope `/`, `standalone`, theme `#0B1F3A`, background `#F5F8FA`, 192/512 `any` + 512 `maskable` + SVG favicon |
| Icons | PASS | Verified real PNG dimensions: icon-192 = 192×192, icon-512 = 512×512, maskable = 512×512, apple-touch = 180×180 |
| Service worker | PASS | `public/sw.js`: versioned shell/runtime caches, stale caches purged on activate, navigations network-first with cached-shell fallback, `/_next/static/` cache-first, `/images/` stale-while-revalidate, no API or auth caching |
| Push notifications | PASS | `push` + `notificationclick` handlers; payload treated as untrusted, only same-origin relative URLs honoured, empty payload tolerated |
| Launch splash | PASS | `components/SplashScreen.tsx`: official logo assets, no fake percentage, 15 s stall guard with real recovery actions, CSS-only animation, `prefers-reduced-motion` covered in `globals.css` |
| Responsive shell | PASS (static) | Chat uses `100dvh` behind `@supports`, `viewportFit: 'cover'` with safe-area padding; no `100vw` or fixed-px widths that would force horizontal scrolling |

## B. Work completed

**B1 — The conversation list now keeps itself current.**
`app/dashboard/messages/page.tsx`. `load()` gained a `silent` mode that refreshes in place without
swapping the list for a skeleton and without turning a transient failure into an error screen. A
background refresh runs every 20 seconds **only while the tab is visible**, plus an immediate
refresh on `visibilitychange` and on window `focus`. The manual Refresh button is unchanged.

**B2 — Application-wide offline notice.**
New `components/OfflineBanner.tsx`, mounted once in `app/layout.tsx`, with a small `.offline-banner`
block appended to `globals.css`. It reports the browser's connectivity only, announces politely,
pads for the notch, respects reduced-motion and never retries or replays a request.

**B2a — Banner cannot cover the header (measured, then fixed).**
The first version was `position: fixed`. It was replaced with `position: sticky; top: 0`, then
measured in the browser at 431 px wide by forcing the offline branch: banner occupied **0–71 px**
and the site header **0–88 px**, i.e. they overlapped, because the header is itself sticky and both
claimed the viewport's top edge. The banner is now a normal **in-flow** block (`position: relative`),
so it occupies its own band and the header starts below it — true at any width and any scroll
position, since it never leaves the flow. The entrance animation is a fade rather than a slide,
because a transform paints outside the box while animating and would reintroduce the overlap.

**B3 — Chat REST fallback when the socket is unavailable.**
`app/dashboard/messages/[conversationId]/page.tsx`. When the transport reports `offline` (blocked
network, no realtime server, repeated reconnect failure) the thread now re-reads the newest page
every 20 seconds while visible, merging by message id. Previously the thread stopped updating
entirely in that state, which is the one failure mode that would look like broken chat on stage.
The connection notice text was corrected to match the behaviour.

No database, schema, API-contract or dependency changes were made. No existing test was modified.

## C. Chat verification

Two-session run executed on 15 November 2026 against the running API with the local database, one
customer session and one technician session on the same accepted service request:

| Step | Result |
|---|---|
| Customer session authenticates | PASS |
| Technician session authenticates | PASS |
| Sessions are distinct | PASS |
| Both participants resolve the same conversation | PASS (`cf01bc1c…`) |
| Customer message persists | PASS, 201 |
| Technician reads that message | PASS |
| Sender identity is server-derived | PASS |
| Technician reply persists | PASS, 201 |
| Customer reads the reply | PASS |
| History intact after re-reading | PASS (2 messages) |
| Chronological ordering | PASS |
| Empty message rejected | PASS, 400 |
| Oversized (2 001 chars) rejected | PASS, 400 |
| Conversation appears in the customer's list | PASS |
| Mark-read returns a real count | PASS, `updated: 1` |
| Unread count drops after reading | PASS, 1 → 0 |
| Outsider cannot read the conversation | PASS, 404 |
| Outsider cannot post to it | PASS, 404 |
| Unauthenticated read refused | PASS, 401 |
| Administrator is not a silent participant | PASS, 404 |

**20 of 20 checks passed.** Both messages also render in the thread UI — the customer view showed
the exchange with the technician labelled as the other participant.

Still unexecuted: the same exchange driven through two browser windows, and the mid-conversation
network drop (steps 11–14 of the brief). The transport's reconnect path was reviewed but not
observed under a real disconnect.

### Can a technician chat with more than one customer?

Yes, and the schema is built for it. `conversations` is unique per **service request**
(`uq_conversations_service_request`), not per technician, so every accepted job opens its own
conversation. One technician holds **13 conversations** in the current test database.

- `/dashboard/messages` lists every conversation the caller participates in, each with its own
  unread count, last message and timestamp.
- Authorisation is decided per conversation from the database (`canAccessConversation` matches
  `customer_id` or `technician_id`), so access to one says nothing about access to another.
- The live socket subscribes to the **one** open conversation at a time; that is a bandwidth
  choice, not a limit on how many a technician can have. The list refreshes itself every 20
  seconds (B1), so new conversations and unread badges appear without being on that thread.
- Dispatch enforces a ceiling on *concurrent accepted jobs* per technician
  (`MAX_ACTIVE_ASSIGNMENTS_PER_TECHNICIAN`, default 3), which bounds how many can be live at once,
  not how many may exist over time.

## D. PWA verification

Manifest, icon files and service-worker strategies were inspected and the icon dimensions measured.
Not verified: installation on Android Chrome, iOS Add to Home Screen, desktop install, offline
reload on a physical device, and the native launch screen. These need the actual devices and cannot
be established from source.

## E. Test results

| Check | Command | Result |
|---|---|---|
| Frontend type check | `cd frontend && npx tsc --noEmit -p tsconfig.json` | PASS, exit 0 |
| Frontend lint | `cd frontend && npx next lint` | PASS — "No ESLint warnings or errors" |
| Production build | `cd frontend && npx next build` | PASS — Next.js 15.5.29, all 25 routes emitted, shared JS 102 kB, `/manifest.webmanifest` prerendered, zero errors |

The build was run **after** the B1–B3 edits, so it covers them. Not run in this session, by
instruction: the 45-script test suite and browser-driven checks.

## F. Outstanding issues

1. The full customer/technician two-session chat test is unexecuted (section C).
2. Physical-device PWA checks — Android install, iOS Add to Home Screen, desktop window — are unverified.
3. Service-worker updates apply immediately (`skipWaiting` + `clients.claim`) with no "new version,
   reload" prompt. Safe for a single-session demo, but a mid-session deploy can swap assets under
   the user; an update prompt is the correct long-term fix.
4. The `<OfflineBanner>` reports browser connectivity only. A captive portal can report "online"
   while requests fail; per-request error handling remains the authoritative signal.
5. **Service worker vs. a different build on the same origin.** A worker left registered from an
   earlier *production* run (`next start`) broke the *development* pages in this session with
   `Cannot read properties of undefined (reading 'call')` at the first new component in
   `app/layout.tsx`: the worker's cache-first rule served production chunk files for development
   chunk URLs, which are not content-hashed. Clearing the registration and its two caches fixed it
   immediately, and an incognito window (no worker) was never affected.

   This does **not** affect a normal deploy: production chunk URLs are content-hashed and change
   with every build, and navigations are network-first, so a new deployment cannot be served old
   HTML or mismatched chunks. It does matter operationally: if a preview and the live site ever
   share an origin, or if you test `next start` and `next dev` on the same `localhost` port, clear
   the worker (DevTools → Application → Service Workers → Unregister, and clear storage). Anyone
   reviewing a deploy in a browser that ran an older build should hard-reload once.

## G. Presentation readiness

**READY WITH LIMITATIONS.**

The P0 set — authentication, role-based access, chat, persistence, request navigation, no known
authorization hole, no crash path found in the audited surfaces — is implemented and reviewed, and
the production build compiles cleanly with the new code in it.

The remaining limitations are evidential, not architectural: the two-session live chat test, the
responsive viewport matrix and the physical-device installs have not been performed.

Before Wednesday: perform the chat walkthrough on the actual presentation hardware with two browser
profiles, and install once on the phone you will demonstrate with.
