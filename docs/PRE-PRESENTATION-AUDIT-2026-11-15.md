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

**B3 — Chat REST fallback when the socket is unavailable.**
`app/dashboard/messages/[conversationId]/page.tsx`. When the transport reports `offline` (blocked
network, no realtime server, repeated reconnect failure) the thread now re-reads the newest page
every 20 seconds while visible, merging by message id. Previously the thread stopped updating
entirely in that state, which is the one failure mode that would look like broken chat on stage.
The connection notice text was corrected to match the behaviour.

No database, schema, API-contract or dependency changes were made. No existing test was modified.

## C. Chat verification

Verified by reading the implemented code paths, **not** by running the two-session browser test the
brief specifies. All sixteen steps of that test (customer sends → technician receives → reply →
refresh → disconnect → send → reconnect → unread → foreign-user access) remain **unexecuted**, and
should be run on the presentation machine before the audience arrives.

What the code does establish: persistence is server-side and authoritative, sender identity and
timestamps are server-derived, foreign conversation ids resolve to 404, and no path marks a message
delivered before the backend confirms it.

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

## G. Presentation readiness

**READY WITH LIMITATIONS.**

The P0 set — authentication, role-based access, chat, persistence, request navigation, no known
authorization hole, no crash path found in the audited surfaces — is implemented and reviewed, and
the production build compiles cleanly with the new code in it.

The remaining limitations are evidential, not architectural: the two-session live chat test, the
responsive viewport matrix and the physical-device installs have not been performed.

Before Wednesday: perform the chat walkthrough on the actual presentation hardware with two browser
profiles, and install once on the phone you will demonstrate with.
