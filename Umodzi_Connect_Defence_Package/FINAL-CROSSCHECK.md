# PROMPT 5A — CROSS-CHECK: APPLICATION vs REPORT vs PRESENTATION

Date: 2026-11-12
Inputs: `project-reference/Umodzi_Connect_Final_Report_CORRECTED.docx`,
`Umodzi_Connect_Final_Defence_Presentation.pptx`, the repository source.

## 1. Agreement table

| Item | Report | Deck | Application | Verdict |
|---|---|---|---|---|
| Project name | Umodzi Connect | Umodzi Connect | `@umodzi/*` packages | **Consistent** |
| Student | Arnold Malama, 2420996 | Arnold Malama, 2420996 | — | **Consistent** |
| Programme | Diploma in Information Technology | same | — | **Consistent** |
| Institution | Zambia University College of Technology | same | — | **Consistent** |
| Aim | low-data smart dispatch and trust-verification platform | identical wording | implemented | **Consistent** |
| Objectives | SO1–SO4 | SO1–SO4, same order | each mapped to a module | **Consistent** |
| Research questions | RQ1–RQ4 | RQ1–RQ4 | — | **Consistent** |
| Scope | Kitwe and Ndola, households/SMEs | same, plus explicit out-of-scope list | `CITY_CENTRES` in `authService.ts` | **Consistent** |
| Frontend stack | Next.js 15, React 19 | Next.js 15 · React 19 | `frontend/package.json` | **Consistent** |
| Backend stack | Fastify with TypeScript | TypeScript · Fastify 5 | `backend/package.json` (fastify 5.3.3) | **Consistent** |
| Database | PostgreSQL with PostGIS | PostgreSQL + PostGIS | migrations use `postgis`, `geometry` | **Consistent** |
| Authentication | custom JWT + argon2id + rotating refresh | JWT + argon2id | `auth/jwt.ts`, `auth/password.ts` | **Consistent** |
| AI | Gemini-classified, customer confirms | Gemini API + keyword fallback | `ai/faultClassifier.ts` | **Consistent** |
| Hosting | Netlify, Render, Supabase | Netlify · Render · Supabase | `netlify.toml`, `render.yaml` | **Consistent** |
| Dispatch | filter then deterministic ordering | "Filter: category, area, verified, available / Order: workload, jobs, rating" | `findNextCandidate()` | **Consistent after correction** |
| Lifecycle statuses | pending → matching → matched → … | described in dispatch/output slides | 7-value vocabulary in migrations | **Consistent** |
| Limitations | §6.3 lists sample, geography, self-report | slide 13 states what is not proven | — | **Consistent** |
| Recommendations | §6.4 | slide 14, five items | — | **Consistent** |

## 2. Contradictions found and corrected in this pass

| Contradiction | Where | Correction |
|---|---|---|
| "Weighted dispatch" claimed as a system feature; no weighting exists in code | Report §2.3, §2.4 (×2) | Changed to "Multi-factor dispatch" |
| "Geolocation and weighted dispatch" in the Agile progression | Report §3.x version plan | Changed to "Geolocation and rule-based dispatch" |
| "Vitest or Jest" listed as project tooling | Report §4.3.1 | Changed to "tsx (TypeScript script runner) for automated test scripts" — the project has no Vitest/Jest suite |
| Missing dash on the final slide: "service quality  those need" | Deck slide 13 | Corrected to "service quality — those need" |

Earlier corrections already verified absent: "RESEARCH PROPOSAL", "A proposal
submitted", "Supabase Auth", "Firebase", "Cloud deployment platform", the
`Final Score = w1…w4` formula. Scan of both documents now returns **0** for each.

## 3. Gaps that remain (not contradictions — absences)

| Gap | Effect on the defence | Fix |
|---|---|---|
| Ten diagrams exist in the report (Appendix D) but not in the deck | The deck's design slide describes the architecture in words; the report now carries all ten figures | Decide whether to add two diagram slides (architecture, dispatch) — the 14-slide reference arrangement has no slot for them |
| No application screenshots in the deck | The deck describes the system but never shows it | Capture from the running app once the database exists |
| Chapter Five evaluation tables blank | Cannot quote a system-wide result yet | §5.1.1 now states what has been measured (484 assertions, 0 failures) and, for each gap, the method and sample size |
| Report Table of Contents not refreshed | Page numbers may be stale after edits | Open in Word and update the field |
| Diagram labels styled as headings pollute the TOC | "Technician Input", "Dispatch Engine" appear in the contents list | Style demotion, best done with the document open |
| ~~Figure 1.1 referenced but absent~~ | **Resolved** — Figure 1.1 is now present in Appendix D with a caption | — |

## 4. Verdict

The three deliverables **do not contradict each other** on identity, objectives,
questions, technology, dispatch, AI, security or limitations. What is missing is
visual evidence (diagrams, screenshots) and measured results — both blocked on
work only the student can enable: a database to test against and the app running
long enough to capture.

Stating that plainly is stronger than filling the gap with a plausible-looking
figure.
