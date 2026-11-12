# UMODZI CONNECT — DEFENCE READINESS TRACKER

**Directive:** `project-reference/# UMODZI CONNECT — COMPLETE SYSTEM,.txt` (Prompts 1–5)
**Student:** Arnold Malama · 2420996 · Zambia University College of Technology · Diploma in Information Technology
**Started:** 2026-11-12
**Rule of this file:** a phase is only marked complete when its stated deliverable exists and was verified. Nothing is marked passed that was not executed.

---

## 1. Phase status

| Phase | Prompt | Deliverable | Status |
|---|---|---|---|
| 1 | Workspace discovery, document inventory, baseline | Baseline report + this tracker + backups | **DONE** — all inputs located; reference deck profiled (Prompt 1C) |
| 2 | System audit, correction, testing | Code fixes + executed test/build evidence | **IN PROGRESS** — **13 of 45 scripts executed: 484 assertions, 484 passed, 0 failed**; realtime chat handshake fixed; stale audit fixture and legal version stamps fixed; type checks, lint and build PASS (26 routes, Node 22). The other 32 scripts need the database |
| 3 | Word report correction, academic improvement, diagrams | `Umodzi_Connect_Final_Report_CORRECTED.docx` + diagrams + PDF | **IN PROGRESS** — 15 corrections plus **ten diagrams embedded in Appendix D** and a new **§5.1.1 Evaluation Status and Measurement Plan**. Outstanding: open in Word, refresh TOC/Lists, export PDF, insert measured figures once tests run |
| 4 | Defence PowerPoint | `Umodzi_Connect_Final_Defence_Presentation.pptx` + notes + PDF | **IN PROGRESS** — 14-slide deck with speaker notes on every slide; the ten diagrams exist but are not in the deck (reference arrangement has no slot); screenshots and PDF export outstanding |
| 5 | Final QA and handover | Study guide, Q&A, demo checklist, package folder, handover report | **IN PROGRESS** — study guide, examiner Q&A, demo checklist and outstanding-issues list produced; package folder assembled. Final cross-check blocked on executed tests and screenshots |

**Honest overall position:** the software builds cleanly and the documents now agree with the code, but the academic evidence is still missing. Chapter Five is blank, no diagram or screenshot exists in the deck, 32 of the 45 test scripts remain unexecuted because they need a database, and neither PDF export has been produced. The project is **close** to defence-ready but not there: the gap is measurement, not code.

---

## 2. How to resume (read this first)

### Backups already made
```
project-reference/backups/2026-11-12/Umodzi_Connect_Final_Report_ORIGINAL.docx
```
This is the untouched original. **Never edit the original.** Work on a copy.

### Reading the report without Word
The report is a .docx (a zip). It was extracted once to `.tmp-docx/` (git-ignored):

```bash
cp "project-reference/Umodzi_Connect_Final_Report.docx" .tmp-report.zip
powershell -NoProfile -Command "Expand-Archive -LiteralPath '.tmp-report.zip' -DestinationPath '.tmp-docx' -Force"
```

- `.tmp-docx/report.txt` — all 997 paragraphs, plain text (document order).
- `.tmp-docx/word/document.xml` — source XML (needed for real edits).
- `.tmp-docx/word/media/` — the 11 embedded images.
- `.tmp-docx/word/styles.xml` — heading/paragraph styles.

`Expand-Archive` **rejects the `.docx` extension** (`NotSupportedArchiveFileExtension`); it only works on the copied `.zip`. This is the only extraction method that worked on this machine.

### Editing the .docx
No `python-docx`, `pandoc`, or LibreOffice was detected in the project. Before Phase 3, either (a) install a tool the user approves, or (b) edit `word/document.xml` surgically and re-zip, verifying by re-extracting. Option (b) preserves the existing formatting and is safest for text-only corrections.

### Known environment problems
1. **Frontend build: RESOLVED on Node 22.** `npm run build -w frontend` failed twice on Node v25.8.0 at *Collecting page data* (`ENOENT ... .next/server/pages-manifest.json`). The same build **passes on Node 22.23.5** via:
   ```bash
   npx -y node@22 node_modules/next/dist/bin/next build frontend
   ```
   Result: `✓ Compiled successfully in 3.4min`, 23/23 static pages, **26 routes**, `build_exit=0`.
   Two variables changed (Node version and invocation directory), so the exact root cause is not isolated; the project's `.nvmrc` says 22, so **always build with Node 22 here**, not the machine default.
   Caveat: invoking from the repo root makes Next print `⨯ ESLint: Could not find config file` (the config lives in `frontend/`). That is an invocation artefact, not a lint failure — `npm run lint -w frontend` passes separately.
2. **Node here is v25.8.0** (`.nvmrc` = 22, `engines` >= 20). Use `npx -y node@22 …` for build evidence.
3. Long commands get cut at 5 minutes by the tool runtime — run builds in the background with output redirected to a log, then poll the log.

### Verified baseline commands (re-run before Phase 2 work)
```bash
npm run typecheck -w backend    # PASS 2026-11-12
npm run typecheck -w frontend   # PASS 2026-11-12
npm run lint -w frontend        # PASS 2026-11-12 (eslint, no output)
npm run build -w backend        # PASS 2026-11-12 (tsc → backend/dist)
npm run build -w frontend       # FAIL (pages-manifest ENOENT, see above)
```

---

## 3. Verified application facts (source of truth for all later claims)

| Area | Verified reality | Evidence |
|---|---|---|
| Frontend | Next.js **15.5.29** (declared `^15.3.3`), React 19, App Router, TypeScript 5.8 | `frontend/package.json`, build banner |
| Frontend routes | 15 route folders: `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/matching`, `/dashboard` (+ `messages`, `notifications`, `privacy`, `requests/[id]`), `/technician/*`, `/technicians/*`, `/admin/*`, `/privacy`, `/terms` | `frontend/app/` |
| Backend | Fastify 5 + TypeScript, single `server.ts` (~5k lines), **57 route registrations** | `grep -c` on `backend/src/server.ts` |
| Database | PostgreSQL + **PostGIS**, **12** SQL migrations (`001`–`012`), RLS enabled from migration `010` | `backend/src/db/migrations/` |
| Authentication | **Custom**: `@fastify/jwt` HS256 access token + rotating refresh HttpOnly cookie, `argon2id` hashing. **Not Supabase Auth.** | `backend/src/auth/*` |
| Realtime | `ws` WebSocket at `/api/v1/realtime`, token subprotocol, per-conversation subscription | `backend/src/realtime/websocketServer.ts` |
| Push | **`web-push` + VAPID**. No Firebase anywhere. | `backend/src/notifications/pushService.ts` |
| Email | Resend HTTP API (password recovery). `RESEND_API_KEY` **unset** → no email sent. | `backend/src/auth/emailService.ts`, env check |
| SMS | Africa's Talking behind `ISmsProvider`; **no credentials, no recipient phone numbers** → no SMS can be sent today | `notificationService.ts`, `backend/.env` |
| AI classification | Gemini (`gemini-2.0-flash`) server-side, strict input bounds, category re-validation, manual fallback. `GEMINI_API_KEY` **unset** → manual path is what actually runs | `backend/src/ai/faultClassifier.ts`, env check |
| Storage | `local` disk or Supabase Storage buckets | `backend/src/storage/fileStorage.ts` |
| Dispatch | Server-side engine: eligibility filter → deterministic candidate order → offer cascade → timeout sweeper → workload cap (default 3) → atomic accept | `backend/src/dispatch/dispatchService.ts` |
| Deployment | Netlify (frontend) + Render (backend) + Supabase Postgres/PostGIS | `netlify.toml`, `render.yaml`, `DEPLOYMENT.md` |
| Tests | **45 standalone `tsx` scripts** (10 frontend, 35 backend). **No `*.test.*`/`*.spec.*`, no test runner, no `npm test`.** CI runs 5 of them. | file scan, `ci.yml` |
| PWA | Manifest + service worker + 192/512/maskable icons exist **uncommitted**; SW registers in production builds only | `frontend/app/manifest.ts`, `public/sw.js` |
| Git state | `main` @ `84fff05`, pushed to `origin`. **Uncommitted:** manifest, sw.js, layout.tsx, globals.css, `SplashScreen.tsx`, 4 icon PNGs | `git status` |

---

## 4. Phase 1 — files found

**Found**
- `project-reference/Umodzi_Connect_Final_Report.docx` — 1.25 MB, 997 paragraphs, **20 tables**, **11 embedded images**, 9 figure captions (4.1–4.9).
- `project-reference/# UMODZI CONNECT – COMPREHENSIVE SY.txt` — the earlier sprint directive (already executed; see `STATE.md`).
- `project-reference/Umodzi Connect – Premium Animated S.txt` — design/animation brief (untracked).
- `project-reference/DEFENSE PRESENTATION (MWAPE CHIPYOKA).pptx` — the reference deck (added by the student during Phase 1). **14 slides**, 16:9, 2 media assets. Profiled in §4.1.
- Full monorepo source (`frontend/`, `backend/`), 12 migrations, 10 docs in `docs/`, deployment configs, CI workflows, brand assets.

**Missing (blocking or limiting later phases)**
- Original project proposal — absent (the report's own cover is the only surviving proposal text).
- Any existing final report PDF — absent.
- Diagram source files (`.drawio`, `.vsdx`, `.svg` for figures) — absent; figures exist only as flattened images inside the .docx.
- Real application screenshots — absent (only `docs/umodzi-connect.png`).
- Existing survey dataset / questionnaire forms — absent; only aggregated numbers in Chapter Five.

### 4.1 Reference deck profile — Prompt 1C

**Source:** `project-reference/DEFENSE PRESENTATION (MWAPE CHIPYOKA).pptx` — a different project (secure cloud storage + MFA for Zambian MFIs) and a different student. **Structure only.** Its content, wording, diagrams, figures and statistics must never appear in the Umodzi deck.

**Slide sequence (14 slides):**
1. Title slide → 2. Background and introduction → 3. Problem statement → 4. Research objectives (3) → 5. Research questions (3) → 6. Scope of research → 7. Significance of study → 8. Literature review (4-author comparison table) → 9. Conceptual framework (image only, no text) → 10. Methodology — research (methodology + requirements-gathering techniques) → 11. Methodology — software (functional/non-functional requirements, UML tools, toolchain) → 12. Findings (3-column table: Specific objective | Result achieved | Discussion) → 13. Conclusion → 14. Recommendations.

**Level of detail:** short bullet statements, one idea per slide; the background and problem slides carry the only long paragraphs; a literature table and a findings table instead of prose; almost no imagery (2 media files).

**Presentation flow worth reusing:** the objectives → questions → scope → significance block, and above all the **findings table that maps each specific objective to its achieved result and a short discussion**. That is the clearest way to answer "did you meet your objectives?" for Umodzi's Chapter Five.

**Gaps in the reference deck (do NOT replicate):** no system architecture slide, no use-case/ERD/database design, no implementation or interface screenshots, no testing-methodology slide, no limitations slide, no speaker notes. The Prompt 4 structure in the directive (≈37 slides) is a superset of this deck and remains the plan.

---

## 5. Phase 2 plan (next work, in order)

Ordered by defence risk, not by code tidiness.

1. **Resolve the frontend production build** (blocker for every "build passed" claim). Try: build from a non-OneDrive path or with the folder excluded from sync; confirm on Node 22. Record the real route table output as evidence.
2. **Run the existing 45 test scripts** against a local/disposable database, capturing pass/fail counts. They are not wired to npm; each is run directly:
   `npx tsx scripts/task23-tests.ts` etc. Record actual numbers — these become the only legitimate source for Chapter Five's functional-testing table.
3. **Verify the dispatch algorithm against `dispatchService.ts`** and settle the report's `w1..w4` scoring formula claim (currently unsupported).
4. **Audit the eight workflow areas** required by Prompt 2B (auth, customer requests, technician dashboard, dispatch, AI classification, chat, notifications, DB/security), fixing only confirmed defects.
5. **Wire a real test command** (npm script) so "run the full available test suite" is reproducible, and extend CI to cover all suites.
6. Update this tracker with executed results, then hand Phase 3 a factual evidence pack.

**Do not** start Phase 3 (report edits) before step 2 exists — otherwise Chapter Five has no honest numbers.

---

## 6. Phase 3 plan (report)

Priority order:
1. Cover + preliminary pages: remove "A RESEARCH PROPOSAL ON" / "A proposal submitted…"; supervisor field (confirm name with student — acknowledgement says *Mr. Nkole Ndanji*, cover is blank); declaration dates.
2. Chapter Five: fill the **9 blank evaluation tables only with executed evidence**; otherwise mark "not yet measured" with the method.
3. Chapter Four technology corrections (see baseline report §5).
4. Figure 1.1: the Conceptual Framework (section 1.7) has **no figure caption**; restore the figure/caption and fix numbering.
5. Add **table captions** (none exist) and a List of Figures / List of Tables.
6. Remove diagram labels that were styled as headings ("Technician Input", "Dispatch Engine", "Outputs", "Expected Outcomes", …) — they currently pollute the Table of Contents.
7. Grammar/academic pass and reference consistency (`World Bank (2020a)` implies a missing `2020b`).
8. Regenerate diagrams 4.1–4.9 in theme (navy `#0B1F3A`, teal, coral) + the 10 required diagram types.

**Done so far (2026-11-12):** items 1 (cover wording only — declaration dates pending), 3 (all six technology corrections), and the dispatch-formula contradiction are applied in `Umodzi_Connect_Final_Report_CORRECTED.docx`. Full change list in `docs/REPORT-CORRECTION-SUMMARY.md`. Items 2, 4, 5, 6, 7, 8 remain open. The corrected file has **not** been opened in Word — layout and TOC refresh are unverified.

---

## 7. Phase 4/5 plan

- **Phase 4:** **14-slide deck generated** (`Umodzi_Connect_Final_Defence_Presentation.pptx`, 16:9, navy/teal/coral, logo badge, speaker notes on all 14 slides) — matching the reference deck's slide count while carrying the directive's content. Structure: title · background · problem · **aim, objectives and research questions (merged)** · scope and limitations · significance · literature and gap · **conceptual framework** · methodology · architecture · dispatch and lifecycle · interfaces · testing status · conclusion. The conceptual framework slide (inputs → classification → dispatch → outputs → outcomes, plus the feedback loop and an explicit "outcomes not yet measured" note) keeps the deck at the reference's 14 slides while satisfying the directive's requirement. Regenerate with `node .tmp-gen-pptx.js` (git-ignored build script; it honours an `OUT` env var so it can stage around a file locked by PowerPoint). **Revised 2026-11-12 after review — arrangement now mirrors the reference deck exactly:** title · background and introduction · problem statement · research objectives · research questions · scope of research · significance of the study · literature review · conceptual framework · methodology (research) · methodology (software) · findings · conclusion · recommendations. Body copy was cut roughly in half (slide 2: 837→480 characters; slide 4: 1154→538; slide 3: 698→400), bullet text raised to 17–18 pt, and **every text frame now carries shrink-to-fit** (`normAutofit`) so long labels resize instead of clipping. The Findings slide uses the reference's three-column objective → result → discussion table. Outstanding: **real screenshots** (slide 12 carries a clearly marked `[INSERT REAL SCREENSHOTS]` placeholder — never fabricate interfaces) and **PDF export** (no Word/LibreOffice automation available).
- **Phase 5:** **four .docx documents produced** in `Umodzi_Connect_Defence_Package/` — Study Guide (20 sections, ~2,400 words), Examiner Questions and Answers (11 topic groups), Demo Checklist (setup, 11-step sequence, backup plan), Outstanding Issues and Actions. Package assembled with the corrected report, the deck and the three markdown references, plus a `README.md` index. Still open: PDF exports, screenshots, and the final test summary (blocked on the test database).

---

## 8. Evidence log

| Date | Action | Result |
|---|---|---|
| 2026-11-12 | Backed up original report | `project-reference/backups/2026-11-12/` |
| 2026-11-12 | Extracted report to text/XML | 997 paragraphs, 20 tables, 11 images |
| 2026-11-12 | `npm run typecheck -w backend` | PASS |
| 2026-11-12 | `npm run typecheck -w frontend` | PASS |
| 2026-11-12 | `npm run lint -w frontend` | PASS |
| 2026-11-12 | `npm run build -w backend` | PASS |
| 2026-11-12 | `npm run build -w frontend` (Node 25.8.0) | **FAIL** ×2 — `pages-manifest.json` ENOENT at Collecting page data, clean `.next` |
| 2026-11-12 | `npx -y node@22 …next build frontend` | **PASS** — compiled 3.4 min, 23/23 static pages, 26 routes, `build_exit=0`; `/manifest.webmanifest` emitted |
| 2026-11-12 | Env presence check (no values read) | `GEMINI_API_KEY` unset, `RESEND_API_KEY` unset, `JWT_SECRET`/`DATABASE_URL`/`MIGRATIONS_DATABASE_URL`/`VAPID_PRIVATE_KEY` set |
| 2026-11-12 | Reference PowerPoint search | **FOUND** (added by student) — 14 slides profiled |
| 2026-11-12 | `next build` on Node 22 | **PASS** — 26 routes, `build_exit=0` |
| 2026-11-12 | Report corrections (12 substitutions) | **APPLIED** — `Umodzi_Connect_Final_Report_CORRECTED.docx`; 32/32 package parts preserved; XML well-formed; old strings 0, new strings 1 each |
| 2026-11-12 | Dispatch algorithm code check | **VERIFIED** — `findNextCandidate()` uses eligibility filter + `ORDER BY` active assignments, jobs, rating, id. No weighted `w1..w4` score exists |
| 2026-11-12 | §1.7 dispatch-formula fix | **APPLIED** — the third occurrence ("calculates a score using factors such as proximity…") corrected; `Final Score` now appears 0 times in the document |
| 2026-11-12 | Defence deck generated | **CREATED** — 14 slides, 14 speaker-note pages, 1 media asset (logo), all slide XML well-formed |
| 2026-11-12 | Slide notes extracted | `docs/SLIDE-NOTES-AND-STUDY-GUIDE.md` |
| 2026-11-12 | Deck revised after review | Arrangement now mirrors the reference deck exactly; body copy halved; shrink-to-fit on every text frame; Findings uses objective → result → discussion |
| 2026-11-12 | Phase 5 documents generated | 4 × .docx verified: valid OOXML, Study Guide ~2,398 words |
| 2026-11-12 | Defence package assembled | `Umodzi_Connect_Defence_Package/` with report, deck, 4 documents, 3 markdown references, README index |
| 2026-11-12 | **Critical defect fixed: realtime chat** | Server never echoed the offered `bearer-…` subprotocol, which RFC 6455 requires; every browser handshake failed while the Node test client tolerated the omission. `handleProtocols` added; client merge-by-id widened. Backend type check PASS |
| 2026-11-12 | Report: 3 more corrections | "Weighted dispatch" ×3 → "Multi-factor dispatch" / "rule-based dispatch"; "Vitest or Jest" → tsx scripts. Repack verified: 32 entries, 997 paragraphs, 20 tables, 11 images |
| 2026-11-12 | Verification re-run after fixes | backend tsc PASS, frontend tsc PASS, `next lint` PASS ("No ESLint warnings or errors"), `next build` PASS — 26 routes, 23 static pages |
| 2026-11-12 | **10 diagrams generated and embedded** | `docs/diagrams/` (SVG + 2480×1600 PNG); report Appendix D carries all ten with captions. Package grew 32 → 42 entries, 21 images, XML valid |
| 2026-11-12 | **Chapter Five §5.1.1 written** | Evaluation status and measurement plan: what passed, that 484 assertions ran, and the method + sample size for every unmeasured metric |
| 2026-11-12 | Prompt 5 deliverables | `docs/FINAL-CROSSCHECK.md`, `docs/FINAL-TEST-SUMMARY.md`, `FINAL_HANDOVER_REPORT.md`, `docs/CHAT-REALTIME-FIX.md` |

---

## 9. Outstanding questions for the student

1. Confirm the supervisor's full name as it must appear on the cover. **Decision taken: leave a clearly marked placeholder** (`[SUPERVISOR NAME]`) — the directive forbids inventing personal details; acknowledgement currently reads *Mr. Nkole Ndanji*.
2. ~~Supply the reference PowerPoint~~ — **received and profiled in §4.1.**
3. Supply the original questionnaire/survey records so Chapter Five percentages can be audited against source data.
4. Confirm whether a Gemini API key will be provisioned (decides whether Chapter Five can report real classification results or must say "not yet measured").
5. Confirm the deployed URLs (Netlify + Render) so screenshots and the demo checklist can reference the live system.

---

## Environment confirmed — 2026-11-12 (PostGIS question closed)

| Check | Finding |
|---|---|
| PostgreSQL | **18**, `C:\Program Files\PostgreSQL\18`, service `postgresql-x64-18` **Running**, port 5432 open |
| **PostGIS** | **Installed — 3.6.2.** `postgis-3.dll` in `lib`, `postgis.control` in `share/extension` |
| `psql.exe` | present in `...\PostgreSQL\18\bin` but **not on PATH** |
| Migration 001 | already runs `CREATE EXTENSION IF NOT EXISTS postgis;` — the extension is per-database, which is why a fresh database looks like it has no PostGIS |

Nothing is missing. The runbook for creating the scratch database, running migrations 001–012, executing the 31 remaining test scripts and capturing results is **`docs/DATABASE-SETUP.md`**.

Thirteen scripts that need no database have already been executed (484 assertions, 0 failures). The 32nd remaining file, `task352-retire-service-key.ts`, is a one-off `.env` maintenance script and must not be run as a test.
