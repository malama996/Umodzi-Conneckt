# UMODZI CONNECT — SLIDE NOTES AND STUDY GUIDE

Generated from `Umodzi_Connect_Final_Defence_Presentation.pptx` on 2026-11-12. Slides 1–14 follow the reference defence arrangement (Mwape Chipyoka's 14-slide order); the two system diagrams are kept as backup slides 15–16, after the closing slide, to be shown only if a panelist asks. Speaker notes are also embedded in the deck itself; this file is the printable study copy.

---

## Slide 1 — FINAL YEAR PROJECT DEFENCE

Opening line: "Umodzi Connect is a low-data platform that helps consumers in Zambia find verified, available technicians nearby, and helps skilled technicians become visible beyond their personal networks."
Give your name, student number, programme and supervisor in one breath. About 15 seconds.
Likely question: "Why the name Umodzi?" — It means unity in the local languages: it unites consumers and technicians in one trusted space.

---

## Slide 2 — BACKGROUND AND INTRODUCTION

Frame the shift: informal discovery → structured discovery. Anchor on your own pilot figure, 8 of 11.
Say that the platform structures an existing market; it does not invent one.
Likely question: "Why not just use WhatsApp?" — No verification, no availability signal, no proximity matching, no accountability record.

---

## Slide 3 — PROBLEM STATEMENT

Deliver it as a chain: no platform → information asymmetry → repeated calls → lost time and lost income.
Do not quote national waiting-time statistics; your evidence is the pilot.
Likely question: "Is this an assumption?" — The pilot data and the literature review support it.

---

## Slide 4 — RESEARCH OBJECTIVES

Read the aim once, then the four objectives. Keep to ~40 seconds.
"Multi-factor" in SO4 means the eligibility filter plus ordering by workload, completed jobs and rating — not a weighted score.
Likely question: "Do your objectives connect to your questions?" — SO1↔RQ1, SO2↔RQ2, SO3 and SO4↔RQ3, RQ4 informed the requirements.

---

## Slide 5 — RESEARCH QUESTIONS

These four questions drive the defence; return to them at the end.
RQ4 is the requirements question — answer it with the pilot findings on data cost, discovery and language.
Likely question: "Which question does your dispatch answer?" — RQ3, informed by RQ4.

---

## Slide 6 — SCOPE OF RESEARCH

State the boundary confidently: a defence fails when you claim more than you built.
The pilot covered Ndola and one Kitwe respondent; generalisation is limited.
Likely question: "Why exclude payments?" — Trust and dispatch had to be validated first; payments add regulatory and settlement complexity.

---

## Slide 7 — SIGNIFICANCE OF THE STUDY

Do not oversell: the economic claim is visibility, not income.
If asked about academic contribution, point to the combination of trust verification, geolocation and server-side dispatch in a low-data Zambian setting.

---

## Slide 8 — LITERATURE REVIEW

Move through the table quickly and land on the gap statement.
Every source is in your reference list — do not add any you have not read.
Likely question: "What do existing solutions lack?" — Verification, availability signals and accountability for informal local technicians.

---

## Slide 9 — CONCEPTUAL FRAMEWORK

Walk left to right: inputs come from the technician and consumer, the intelligence layer classifies, the dispatch engine chooses one technician at a time, and outputs are expected to lead to the outcomes.
Say clearly that outcomes are expected, not measured — that is what Chapter Five will report.
Likely question: "Where is the AI?" — In the intelligence layer: it only suggests a category, the customer confirms, and keyword fallback applies if the service is unavailable.

---

## Slide 10 — METHODOLOGY — RESEARCH

Explain why Agile: requirements evolved with feedback, and the academic calendar required incremental delivery.
Say plainly that 18 respondents is a pilot: it produces requirements, not population estimates.
Likely question: "Why not Waterfall?" — Early assumptions would have been frozen before users could react to them.

---

## Slide 11 — METHODOLOGY — SOFTWARE

This is the technical-methodology slide: requirements, design and the toolchain.
Be accurate: authentication is custom JWT with argon2id, not a third-party auth service; push is web-push/VAPID, not Firebase.
Likely question: "Why PostGIS?" — Geographic filtering and distance work belong in the database; it also keeps the API simple.

---

## Slide 12 — FINDINGS

Read the table row by row: objective, what was actually built, and what it means.
Be honest about the last box — those measurements are still outstanding and will be reported only when executed.
Likely question: "So what are your test results?" — Static gates and the production build pass; functional, accuracy, dispatch, usability and security measurements are pending against a controlled test database.

---

## Slide 13 — CONCLUSION

Return to the four research questions and answer each in one sentence.
Own the limitation: no controlled evaluation yet, therefore no causal claims.
Likely question: "Did you achieve your objectives?" — Objectives 1 to 3 are met by implemented features; objective 4 is implemented but its performance is not yet evaluated.

---

## Slide 14 — RECOMMENDATIONS

Finish on recommendations, then invite questions.
Prepare for: "What would you do with three more months?" — controlled pilot, labelled dataset, and fairness measurement across technicians.
Keep the closing slide on screen while answering questions.

---

## Slide 15 — SYSTEM ARCHITECTURE (BACKUP)

Backup slide, outside the 14-slide core flow — shown only if a panelist asks about the architecture.
Walk the three tiers top to bottom: the Netlify client never holds a provider key; the Render API exposes eight modules; Supabase PostgreSQL with PostGIS holds sixteen tables behind row-level security.
Emphasise the red EXTERNAL band: Gemini, Resend and Web Push are server-side only — that is the answer to any credential-exposure question.
Likely question: "Why is the browser not allowed to call Gemini directly?" — A key in the browser is a public key; classification therefore happens server-side with a keyword fallback.

---

## Slide 16 — SMART DISPATCH FLOWCHART (BACKUP)

Backup slide for the core contribution, outside the 14-slide core flow — shown on request after the closing slide.
Stress that there is no weighted score: an eligibility filter narrows candidates, deterministic ordering picks one, exactly ONE live offer exists at a time, and accept is atomic under a unique index so two technicians can never both hold the same job.
Reject or timeout cascades to the next candidate; exhaustion yields no_match and the retry queue.
Likely question: "What stops double assignment?" — The unique index on accepted offer per request; the second concurrent accept fails at the database, not in application code.

---

## THE TEN DIAGRAMS — STUDY NOTES

Every diagram was generated from the implemented system and ships as a PNG plus an editable SVG in `docs/diagrams/`. Each appears once in the report body with its canonical number; Appendix D is a cross-reference index, not a second copy. Know one sentence and one likely question per figure.

**Figure 1.1 — Conceptual Framework** (Chapter 1)
Inputs → classification → dispatch engine → outputs → outcomes, with reviews feeding the trust signal back into the next dispatch.
Say: outcomes are expected benefits, not measured results.
Question: "Is the feedback loop real?" — Yes for ratings/reviews influencing ordering; the outcome box is aspirational.

**Figure 4.2 — Context Diagram** (Chapter 4)
Actors (customer, technician, administrator, pilot participant) and the three external services (Gemini, Resend, Web Push) around the system boundary.
Say: survey respondents supplied pilot data but never touch the deployed system.
Question: "Why is the pilot participant dashed?" — They interact with the study, not the software.

**Figure 4.3 — System Architecture** (Chapter 4; also deck slide 15 — backup)
Three tiers: Netlify client, Render Fastify API with eight modules, Supabase PostgreSQL + PostGIS; external services server-side only.
Say: the browser never holds a provider key.
Question: "Where does RLS sit?" — In the data tier, with a restricted runtime role.

**Figure 4.4 — Use-Case Diagram** (Chapter 4)
The three roles and the use cases each may perform; administrator use cases are governance, never message content.
Say: conversation access is participant-only, enforced in the communication authorization layer.
Question: "Can an admin read chats?" — No; authorisation is participant-only.

**Figure 4.5 — Sequence Diagram: Accepting an Offer** (Chapter 4)
The atomic accept path: begin, lock rows, conditional update, unique index admits one accepted offer, status → matched, conversation created.
Say: the guard is the database unique index, not application logic.
Question: "What if two technicians tap accept together?" — One succeeds; the other fails the unique index and cascades.

**Figure 4.6 — State-Machine Diagram: Request Lifecycle** (Chapter 4)
The seven persisted statuses and the guarded transitions; cancelled and completed are terminal.
Say: transitions are validated against a server-side matrix and every transition writes an audit event.
Question: "Can a completed job be reopened?" — No; terminal states have no outgoing transitions.

**Figure 4.7 — Activity Diagram: Requesting a Service** (Chapter 4)
Three swimlanes (customer, system, technician) and the branch that produces no_match into the retry queue.
Say: classification suggests, the customer confirms, then the request persists as pending.
Question: "What happens on no_match?" — Retry queue, swept at a configurable interval.

**Figure 4.8 — Class Diagram (implemented modules)** (Chapter 4)
The eight service modules and their shared Database (pg Pool) dependency; responsibilities mirror source files.
Say: each box maps to a real module — auth, authorization, dispatch, communicationAuth, requests, notifications, ai, realtime.
Question: "Is this design or code?" — Code: the methods listed exist in the repository.

**Figure 4.9 — Entity-Relationship Diagram** (Chapter 4)
The sixteen tables; foreign keys carry ownership, and service_request_events plus the audit/verification tables are append-only.
Say: the unique accepted-offer-per-request index lives on dispatch_offers.
Question: "How is audit integrity kept?" — Append-only event tables; no updates or deletes.

**Figure 4.10 — Smart Dispatch Flowchart** (Chapter 4; also deck slide 16 — backup)
Eligibility filter → deterministic order → one live offer → accept/reject/timeout → atomic accept, with the cascade back to ordering.
Say: there is no weighted score; selection is filter then deterministic ordering.
Question: "Why not score technicians?" — Deterministic ordering is auditable and avoids opaque weighting.

Known cosmetic note: five diagrams (4.2, 4.5, 4.6, 4.7, 4.9) have small label collisions in their legend or footnote regions. Content and numbering are correct; the SVG sources in `docs/diagrams/` can be re-exported if a clean reprint is ever required.
