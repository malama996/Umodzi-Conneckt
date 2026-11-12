# UMODZI CONNECT — PHASE 1 BASELINE REPORT

**Date:** 2026-11-12 · **Phase:** Prompt 1 (discovery, inventory, baseline)
**Method:** static inspection of the repository, extraction of the report .docx, execution of the project's own gates. Nothing below is inferred from prior summaries; each claim names its evidence.

---

## 1. Files found

| Item | Path | State |
|---|---|---|
| Final report | `project-reference/Umodzi_Connect_Final_Report.docx` | 1.25 MB · 997 paragraphs · 20 tables · 11 images · 9 figure captions |
| Original backup | `project-reference/backups/2026-11-12/…_ORIGINAL.docx` | created this phase |
| Reference PowerPoint | `project-reference/DEFENSE PRESENTATION (MWAPE CHIPYOKA).pptx` | **FOUND** — 14 slides, 16:9, 2 media · profiled in §7 |
| Project proposal | — | **MISSING** |
| Frontend | `frontend/` (Next.js App Router) | 15 route folders |
| Backend | `backend/` (Fastify, single `server.ts`) | 57 route registrations |
| Migrations | `backend/src/db/migrations/001–012` | 12 files, RLS from `010` |
| Tests | `frontend/scripts/` (10), `backend/scripts/` (35) | 45 standalone `tsx` scripts |
| Docs | `docs/` (10 files), `README.md`, `DEPLOYMENT.md`, `STATE.md`, `TEST-STATUS.md`, `THEME-B-CANONICAL.md` | present |
| CI | `.github/workflows/ci.yml`, `render-keepalive.yml` | present |
| Brand assets | `frontend/public/branding/` | 10 files; 4 new PNGs uncommitted |
| Screenshots | `docs/umodzi-connect.png` only | effectively none |

---

## 2. Actual technology stack (verified)

- **Frontend:** Next.js 15.5.29, React 19, TypeScript 5.8, App Router, PWA (manifest + service worker).
- **Backend:** Node + Fastify 5, TypeScript, `ws` WebSocket, `@fastify/jwt`, `@fastify/rate-limit`, `@fastify/multipart`, `argon2`, `zod`, `pg`, `web-push`.
- **Database:** PostgreSQL + PostGIS, 12 forward-only SQL migrations, row-level security with a restricted runtime role (`umodzi_app`).
- **Integrations:** Gemini (`gemini-2.0-flash`) for fault classification · Resend for recovery email · Africa's Talking for SMS · VAPID web push · Supabase Storage or local disk.
- **Hosting:** Netlify (frontend) + Render (backend) + Supabase (PostgreSQL/PostGIS).

**Environment reality (names checked, values never read):**
`DATABASE_URL`, `MIGRATIONS_DATABASE_URL`, `JWT_SECRET`, `VAPID_PRIVATE_KEY` **set**;
`GEMINI_API_KEY` **unset**; `RESEND_API_KEY` **unset**.

---

## 3. Implemented features (existence verified; runtime behaviour where stated)

- Registration, login, logout, session persistence, rotating refresh cookie, password recovery (endpoint only — no email key), role-based access for customer / technician / administrator.
- Customer dashboard, service-request creation with review step and idempotency key, request detail route, request lifecycle actions.
- Technician profiles, skills, service areas, availability, verification submission, offer accept/reject.
- **Server-side dispatch engine:** eligibility filtering, deterministic candidate selection, offer cascade, offer timeout sweeper, waiting-queue re-match, workload cap (default 3), atomic accept inside one transaction, audit rows.
- Chat: REST-persisted messages + WebSocket realtime, participant-only authorization.
- Notifications: in-app rows with dedupe, web push (VAPID), SMS policy gate (no delivery path without credentials/numbers).
- Reviews and ratings; administrator console (users, technicians, requests, audit); privacy pages and data export.
- Geolocation: Leaflet map, opt-in GPS for the customer, coarse published city centres for technicians (precise technician coordinates are deliberately withheld).
- PWA: manifest, icons, service worker, splash screen — **present in the working tree but uncommitted, therefore not deployed.**

**Runtime-unverified:** anything requiring a live database, live provider keys, or an authenticated session. The live-system rule in `STATE.md` restricts testing, so most flows are statically verified only.

---

## 4. Incomplete or unverified

| # | Item | Evidence | Consequence |
|---|---|---|---|
| 1 | **Chapter Five evaluation tables are blank** — functional testing (9 categories), AI precision/recall/F1 (8 categories), dispatch metrics, usability, security | `.tmp-docx/report.txt` lines 700–780 | The report asserts testing but presents no results. Highest defence risk. |
| 2 | AI classification never executed in production | `GEMINI_API_KEY` unset | Only the keyword fallback can be demonstrated |
| 3 | Password-recovery email never sends | `RESEND_API_KEY` unset | Feature is code-complete but undemonstrable |
| 4 | SMS cannot be sent | no credentials, no stored phone numbers | Must not be presented as a working channel |
| 5 | ~~Frontend production build fails~~ **Resolved on Node 22** | Failed twice on Node 25.8.0 (`pages-manifest.json` ENOENT); passes with `npx -y node@22 … next build frontend` → 26 routes, `build_exit=0` | Build evidence now exists; must always build on Node 22 here |
| 6 | 45 test scripts are not a runnable suite | no `test` script; no `.test.*` files; CI runs 5 of 45 | "Full test suite" cannot be claimed as run |
| 7 | Migration `012` may not yet be applied to the live DB | `STATE.md` §4 | New audit/idempotency constraints activate only on next backend start |
| 8 | PWA/splash work is uncommitted | `git status` | Not in the deployed build |
| 9 | Report diagrams exist only as flattened images | no diagram sources | Cannot re-edit; must be regenerated in Phase 3 |

---

## 5. Report inconsistencies (all line-referenced)

1. **Cover says "A RESEARCH PROPOSAL ON"** (line 2) and **"A proposal submitted in partial fulfilment…"** (line 10). This is a final report.
2. **Supervisor field blank on the cover** (line 7) while the acknowledgement names *Mr. Nkole Ndanji* (line 21).
3. **Proposal-tense language survives throughout:** "The **proposed** system uses Next.js…" (25); "The **proposed** deployment architecture is…" (546); "Umodzi Connect **was proposed** as a platform…" (6.2).
4. **Authentication misdescribed:** "Supabase Auth or equivalent" (4.4.1) — the system uses custom Fastify JWT + argon2id. No Supabase Auth exists in the code.
5. **Testing tools misdescribed:** "Vitest, Jest, Postman and browser tools" (4.4.1). No Vitest, Jest or Postman artifacts exist; tests are 45 standalone `tsx` scripts.
6. **Hosting vague:** "Cloud deployment platform" (4.4.1) — actual is Netlify + Render + Supabase.
7. **Firebase referenced** (References: "Google (2026) Firebase Cloud Messaging documentation") — no Firebase is used; push is `web-push`/VAPID. Must be removed or replaced.
8. **Dispatch scoring formula unsupported:** "Final Score = w1(Proximity) + w2(Trust) + w3(Availability) + w4(Fairness)" (4.4.2). The implemented engine filters by eligibility and orders candidates deterministically with a workload cap; no weighted score exists. Either the code or the text is wrong — the code is the source of truth.
9. **No table captions anywhere** although 20 tables exist; no List of Tables, no List of Figures.
10. **Figure numbering starts at 4.1** — the Conceptual Framework in §1.7 has no figure or caption, so a Figure 1.1 reference would be dangling.
11. **Diagram labels styled as headings.** TOC entries include "Technician Input", "Consumer Request Input", "Intelligence Layer", "Dispatch Engine", "Outputs", "Expected Outcomes" (TOC lines 54–59) — these are conceptual-framework box labels formatted as level-3 headings, polluting the table of contents.
12. **Reference gap:** `World Bank (2020a)` implies a `2020b` entry that is not present.
13. **Chapter Five mixes survey findings with unmeasured technical claims** without clearly separating them; the structural split demanded by Prompt 3C is currently absent.

---

## 6. Missing diagrams and evaluation evidence

**Figures present (captions):** 4.1 System Architecture · 4.2 Context · 4.3 Use Case · 4.4 Sequence · 4.5 State Machine · 4.6 Activity · 4.7 Class · 4.8 ERD · 4.9 Smart Dispatch Algorithm.

**Figures required but missing:** Figure 1.1 Conceptual Framework (section exists, figure does not).

**Diagram sources:** none — figures are embedded raster/vector images inside the .docx with no editable originals.

**Missing evaluation evidence:** functional-test pass/fail counts, AI precision/recall/F1, dispatch match rate and timings, usability/SUS results, security-test outcomes. The report's tables are structurally present and entirely empty.

---

## 7. Presentation weaknesses

- **No defence PowerPoint exists** — Phase 4 must build it from scratch.
- **Reference deck profiled** (14 slides): title → background → problem → objectives → questions → scope → significance → literature table → conceptual framework → methodology (research/software) → findings table → conclusion → recommendations. Its **objective → result → discussion** findings table is the pattern worth adopting; it has no architecture, ERD, implementation screenshots, testing slide or speaker notes, so the directive's 37-slide structure is still required.
- No speaker notes, no slide-by-slide study guide, no examiner Q&A, no demo checklist.
- No authentic screenshots of the running application to populate the implementation section.

---

## 8. Risks that must be addressed before defence

| Risk | Severity | Why |
|---|---|---|
| Blank Chapter Five evidence tables | **Critical** | An examiner will ask "what were your results?" and the document shows empty cells |
| Report still reads as a proposal | **High** | Immediately visible on the cover; signals an unrevised submission |
| Technology claims contradict the code | **High** | Supabase Auth, Vitest/Jest, Firebase, weighted dispatch scoring are all unsupported |
| No production build evidence | ~~High~~ **Cleared** | Frontend build now passes on Node 22 (26 routes); backend build passes |
| No defence presentation | **High** | A required deliverable is entirely absent |
| AI classification not demonstrable | Medium | Must be presented as "implemented, awaiting key", never as a live AI result |
| Reference deck available but is another student's work | Medium | Structure may be reused; content, diagrams and wording must not be — risk of accidental copying during Phase 4 |
| Uncommitted PWA/UI work | Low | Deployed site differs from the repository |

---

## 9. Next actions

1. ~~Obtain the reference PowerPoint~~ — received; structure profiled (see §7).
2. ~~Fix the frontend production build~~ — now passes on Node 22 (26 routes, `build_exit=0`).
3. Execute the 45 test scripts against a disposable database and capture actual counts.
4. Reconcile the dispatch description with `dispatchService.ts`.
5. Only then begin report correction (Phase 3), starting with the cover and Chapter Five.
