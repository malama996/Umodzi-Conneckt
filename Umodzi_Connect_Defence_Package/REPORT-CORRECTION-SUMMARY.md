# REPORT CORRECTION SUMMARY — 2026-11-12

**Source:** `project-reference/Umodzi_Connect_Final_Report.docx` (untouched)
**Output:** `project-reference/Umodzi_Connect_Final_Report_CORRECTED.docx`
**Backup:** `project-reference/backups/2026-11-12/Umodzi_Connect_Final_Report_ORIGINAL.docx`

## Method

The `.docx` package was opened as a zip and **only `word/document.xml` was replaced**. No package part was added or removed (32 entries before and after), no style, numbering, relationship or media file was touched, and the resulting XML parses as well-formed (`root: w:document`). Every substitution was asserted to match exactly once before being applied; the script aborted if any target was missing.

This preserves all original formatting, images, page setup and field codes.

## Corrections applied (12)

| # | Location | Before | After |
|---|---|---|---|
| 1 | Cover | "A **RESEARCH PROPOSAL** ON" | "A **RESEARCH REPORT** ON" |
| 2 | Cover | "A proposal submitted in partial fulfilment…" | "A research project report submitted in partial fulfilment…" |
| 3 | Cover | "Supervisor:" (blank) | "Supervisor: **[SUPERVISOR NAME]**" — deliberate placeholder, not an invention |
| 4 | Abstract | "The **proposed** system uses Next.js, Fastify TypeScript…" | "The **implemented** system uses Next.js, Fastify with TypeScript…" |
| 5 | §4.4.1 | "Authentication: Supabase Auth or equivalent." | "Authentication: Custom JSON Web Token (JWT) authentication with rotating refresh cookies and argon2id password hashing." |
| 6 | §4.4.1 | "Testing: Vitest, Jest, Postman and browser tools." | "Testing: Automated TypeScript test scripts executed with tsx, together with manual browser verification." |
| 7 | §4.4.1 | "Hosting: Cloud deployment platform." | "Hosting: Netlify (frontend), Render (backend) and Supabase (PostgreSQL/PostGIS)." |
| 8 | §4.5 | "The **proposed** deployment architecture is:" | "The **implemented** deployment architecture is:" |
| 9 | §6.2 | "Umodzi Connect **was proposed as** a platform…" | "Umodzi Connect **was developed as** a platform…" |
| 10 | References | "Google (2026) **Firebase Cloud Messaging** documentation…" | "Google (2026) **Gemini API** documentation. https://ai.google.dev/gemini-api/docs" (alphabetical position retained; the system uses Gemini, never Firebase) |
| 11 | §4.4.2 | "The dispatch component filters, scores, ranks and contacts technicians. Final Score = w1(Proximity) + w2(Trust) + w3(Availability) + w4(Fairness)." | Accurate description of `findNextCandidate()`: eligibility filter (same category, same service area, verified, active account, available, no previous offer on the request, below the configurable origin cap of 3), then deterministic ordering by fewest active assignments → fewest completed jobs → highest rating → technician id tie-break. |
| 12 | §4.4.2 | Equation line "Final Score = w1(…) + w2(…) + w3(…) + w4(…)" | "Eligibility filter: same category, same service area, verified, active and available" |

Correction 11/12 is grounded in `backend/src/dispatch/dispatchService.ts` (`ORDER BY` active-assignment count, `t.jobs`, `t.rating DESC`, `t.id ASC`, with `FOR UPDATE SKIP LOCKED`). **The weighted-scoring formula asserted in the report had no implementation anywhere in the repository.**

## Second pass — corrections 13–15 (2026-11-12, same day)

A full re-scan of the corrected document found three claims that survived the first pass. All three were contradicted by the repository, not merely imprecise.

| # | Location | Before | After |
|---|---|---|---|
| 13 | §2.3 and §2.4 (×2) | "Weighted dispatch." | "Multi-factor dispatch." — the implementation filters and orders; no weighting exists anywhere in the code |
| 14 | Agile version plan | "Version 0.3: Geolocation and weighted dispatch." | "Version 0.3: Geolocation and rule-based dispatch." |
| 15 | §4.3.1 Software Design Tools | "Vitest or Jest." | "tsx (TypeScript script runner) for automated test scripts." — there is no Vitest or Jest suite in the repository |

Repack verified again: **32 zip entries**, `word/document.xml` well-formed, **997 paragraphs / 20 tables / 11 images** unchanged, 1074 text nodes before and after.

Search for `Weighted`, `Vitest`, `Jest` now returns **0** occurrences in the document body.

## Additions 16–17 (same day, after the ten diagrams were produced)

| # | Addition | Detail |
|---|---|---|
| 16 | §5.1.1 **Evaluation Status and Measurement Plan** | New subsection (15 paragraphs) inserted before 5.2. States which gates passed (type checks, lint, 26-route build), that 13 of 45 scripts ran with 484 assertions and 0 failures, and that the remaining 32 need a database. For each unmeasured metric — functional testing, AI accuracy, dispatch performance, usability, security — it gives the method, sample size, instrument and reporting form. Also separates survey findings from verification results from outstanding measurements. |
| 17 | **Appendix D: System Diagrams** | Ten figures embedded at full width with captions: conceptual framework (1.1), context (4.2), architecture (4.3), use-case (4.4), sequence (4.5), state machine (4.6), activity (4.7), class (4.8), ERD (4.9), dispatch flowchart (4.10). Each was generated from the real schema (16 tables), route set (57 registrations) and `findNextCandidate()`. |

Package growth verified after both additions: **32 → 42 zip entries** (ten media parts added), `word/document.xml` and `word/_rels/document.xml.rels` both well-formed, 1034 paragraphs, 20 tables, **21 images**, 21 image relationships. Source SVGs are in `docs/diagrams/`.

## Deliberately NOT changed

| Item | Why |
|---|---|
| Chapter Five evaluation tables (functional testing, AI metrics, dispatch, usability, security) | They must be filled only with executed results. No database/test evidence exists yet, and inventing figures is prohibited. |
| Figure 1.1 (Conceptual Framework) | The section exists but carries no figure or caption; restoring it requires the diagram source, which does not exist. |
| Missing table captions / List of Tables / List of Figures | Needs a consistent numbering pass together with the diagram work, not a blind text edit. |
| TOC pollution (diagram labels styled as headings: "Technician Input", "Dispatch Engine", "Outputs", …) | Requires style changes (demoting Heading 3 to body text) — a formatting operation to be done with the document open, not by XML surgery. |
| Grammar/academic prose pass | Deferred until Chapter Five content exists so the chapter is edited once, not twice. |
| Reference gap (`World Bank (2020a)` implies a `2020b`) | Requires the student's source list to resolve correctly. |

## Verification performed

- Replacement count asserted per target (12/12 matched exactly once).
- Zip entry count: **32 → 32** (no parts lost).
- `word/document.xml` parses as well-formed XML.
- Old strings confirmed absent (0 occurrences); new strings confirmed present (1 each).

## Verification NOT performed

- **The document was not opened in Microsoft Word.** Layout, page breaks, TOC field refresh and figure placement are unverified and must be checked by opening the file. If Word reports a repair prompt, restore from the backup and report it immediately.
- No PDF was exported (no Word/LibreOffice automation available here).

## Student confirmations still required

1. Supervisor name for the `[SUPERVISOR NAME]` placeholder.
2. Questionnaire/survey source records so Chapter Five percentages can be audited.
3. Decision on the Gemini API key (determines whether Chapter Five reports real classification results or "not yet measured").
