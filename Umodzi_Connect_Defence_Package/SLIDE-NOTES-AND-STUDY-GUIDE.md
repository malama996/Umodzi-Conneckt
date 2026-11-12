# UMODZI CONNECT — SLIDE NOTES AND STUDY GUIDE

Generated from `Umodzi_Connect_Final_Defence_Presentation.pptx` on 2026-11-12. Speaker notes are also embedded in the deck itself; this file is the printable study copy.

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
