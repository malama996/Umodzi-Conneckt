# UMODZI CONNECT — FINAL HANDOVER REPORT

**Student:** Arnold Malama · 2420996 · Diploma in Information Technology
**Institution:** Zambia University College of Technology
**Date:** 2026-11-12
**Directive:** Prompts 1–5 of `project-reference/# UMODZI CONNECT — COMPLETE SYSTEM,.txt`

---

## 1. Completion status

| Area | Required status | Actual status |
|---|---|---|
| Source code audit | complete | **DONE** — full inventory; 57 route registrations, 12 migrations, 45 test scripts |
| Critical defects | fixed or listed | **1 critical fixed** (realtime chat handshake); no known critical defects outstanding |
| Functional tests | actual results | **NOT EXECUTED** — requires a disposable database |
| Security checks | actual results | **NOT EXECUTED** — configuration reviewed; tests need live accounts |
| Production build | actual result | **PASS** — 26 routes on Node 22; also PASS after the chat fix |
| Word report | verified or outstanding | **CORRECTED, NOT WORD-VERIFIED** — 15 corrections, new §5.1.1 measurement plan, Appendix D with ten figures. Must be opened once in Word to refresh the TOC |
| Diagrams | verified or outstanding | **DONE** — ten diagrams generated from the schema/routes/dispatch code, embedded in Appendix D with captions, editable SVGs in `docs/diagrams/` |
| PowerPoint | verified or outstanding | **DONE (14 slides), typo fixed in staged copy** — live file locked by PowerPoint |
| Speaker notes | verified or outstanding | **DONE** — notes on all 14 slides |
| Study guide | verified or outstanding | **DONE** — 20 sections, ~2,400 words, valid OOXML |
| Examiner questions | verified or outstanding | **DONE** — 11 topic groups |
| Demo checklist | verified or outstanding | **DONE** — setup, accounts, 11-step sequence, backup plan |

**Overall: the software is stable and the documentation is corrected, but the
project is not yet fully defence-ready.** The remaining gap is evidence, not
code: measured test results, screenshots and diagrams.

---

## 2. What changed in this pass

1. **Realtime chat fixed.** Browsers could never complete the WebSocket
   handshake because the server did not echo the offered `bearer-…`
   subprotocol, which RFC 6455 requires. Node's test client tolerated the
   omission, so the defect survived the existing suite. Detail:
   `docs/CHAT-REALTIME-FIX.md`. **Needs a backend redeploy to take effect.**
2. **Report: three unsupported claims removed.** "Weighted dispatch" (×3),
   and "Vitest or Jest" (no such suite exists). The report now describes the
   dispatch algorithm that is actually implemented.
3. **Deck: missing dash restored** on the final slide.
4. **Phase 5 documents produced** — study guide, examiner Q&A, demo checklist,
   outstanding issues, cross-check, this report, and a final test summary.
5. **Verification re-run** after the fixes: backend type check, frontend type
   check, lint and production build all pass.

---

## 3. COMPLETED

Verified by running the command or inspecting the artefact:

- Workspace audit, document inventory, baseline report and tracker.
- Backup of the untouched original report.
- Report corrected (15 changes) with package integrity preserved: 32 zip
  entries, 997 paragraphs, 20 tables, 11 images, valid XML.
- Defence deck: 14 slides in the reference arrangement, speaker notes on every
  slide, shrink-to-fit on every text frame.
- Study guide, examiner Q&A, demo checklist, outstanding-issues list.
- Cross-check of application vs report vs presentation with contradictions
  fixed.
- Critical defect fixed: WebSocket subprotocol handshake.
- `backend tsc --noEmit` PASS · `frontend tsc --noEmit` PASS ·
  `next lint` PASS · `next build` PASS (26 routes).
- Four Word documents generated and structurally verified.

## 4. STILL REQUIRED FROM THE STUDENT

1. **Supervisor name** for the `[SUPERVISOR NAME]` placeholder on the cover.
2. **A disposable PostgreSQL + PostGIS database** so the 45 scripts can run and
   Chapter Five can be filled with real numbers.
3. **Survey/questionnaire source records** so the pilot percentages in Chapter
   Five can be audited.
4. **Decision on the Gemini API key** — it determines whether classification
   accuracy can be reported at all.
5. **Deployed URLs** for Netlify and Render, for screenshots and the live demo.
6. **Close PowerPoint once**, then take the corrected deck copy — the live file
   was locked, so the fixed version is staged separately.
7. **Open the corrected report in Word once** to confirm no repair prompt,
   then refresh the table of contents.
8. **Signature and submission date** on the declaration.

## 5. RECOMMENDED REMAINING PREPARATION

1. Run the test suite the moment the database exists; fill Chapter Five the
   same day while the output is fresh.
2. Capture six screenshots from the running app (landing, dashboard, request
   form with classification, technician offers, chat, admin verification).
3. Build one architecture diagram and one ERD; insert them where the report
   already references figures.
4. Rehearse the demonstration twice, timed at six minutes, following
   `Umodzi_Connect_Defence_Demo_Checklist.docx`.
5. Rehearse the three hardest answers: dispatch ordering, why no metrics yet,
   and why administrators cannot read messages.
6. Export the report and the deck to PDF from Word and PowerPoint.
7. Re-read the study guide section by section against the slides — anything you
   cannot explain in one sentence needs a second pass.

---

## 6. Honest closing statement

The system is real, the build is clean, and the documents now agree with the
code. What remains is the work no one can do on your behalf: running the tests
against a database you provide, capturing the screenshots, and rehearsing until
the explanation is yours.
