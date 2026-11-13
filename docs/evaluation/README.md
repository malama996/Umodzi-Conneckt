# Evaluation evidence — Chapter Five

Two measurements support Tables 5.16 and 5.17 of the final report. Everything here is
reproducible from the repository; no figure in the report is an estimate.

## 1. Fault classification (Table 5.16)

**What is measured.** `frontend/lib/classification.ts` — the deterministic keyword classifier
that the deployed build actually runs when no Gemini key is configured.

**Corpus.** `classification-corpus.json` — 90 English fault descriptions, 10 for each of the
nine canonical categories. Each item carries a hand-written label and a `split` field
(`dev`/`test`, alternating within each category, 45 each).

| File | Contents |
|---|---|
| `classification-corpus.json` | the labelled corpus |
| `eval-classify.ts` | harness: accuracy, per-category precision/recall/F1, confusion matrix |
| `classification-all.json` | released classifier over all 90 items — **96.7 %** |
| `classification-baseline.json` | pre-revision classifier over the 45 held-out items — **40.0 %** |
| `classification-dev.json` | released classifier over the 45 development items — 93.3 % |
| `classification-results.json` | released classifier over the 45 held-out items — 100.0 % |

Run it:

```bash
cd backend
npx --no-install tsx ../docs/evaluation/eval-classify.ts --split=all --out=classification-all.json
```

**Result reported in the chapter:** the released classifier scores 96.7 % overall
(87/90), with three errors in Electrical, Appliance Repair and Electronics.

**Limitation, stated in the report.** The corpus was written by the researcher who wrote the
keyword vocabulary, so these numbers measure coverage of a designed corpus, not accuracy on
descriptions written by independent users. The pre-revision classifier's 40.0 % on the same
held-out half shows the size of the gap the revision closed, but both figures share that
authorship bias. Independent annotation is the outstanding measurement.

## 2. Dispatch (Table 5.17)

**What is measured.** The real dispatch flow through the API, with timings read from the
database timestamps dispatch writes.

**Setup.** Two technician accounts (Plumbing/Kitwe) registered through the API, taken to
`pending` and verified by the administrator through the API, then marked available.
`MAX_ACTIVE_ASSIGNMENTS_PER_TECHNICIAN` was raised for the run so that all journeys fit
through two fixtures.

**Journeys.** 12 single-acceptance, 6 forced cascades (first technician rejects, the next
accepts), 4 requests in a category with no eligible technician.

**Result.**

| Metric | Value |
|---|---|
| Requests | 22 |
| Matched | 18 |
| Match rate | 81.8 % |
| Median time to first offer | 0.003 s |
| Median time to acceptance | 0.069 s |
| Mean candidates contacted | 1.33 (max 2) |
| Cancellations | 0 |
| Distance | not measured — the create payload carries no coordinates |

Run it (API on :3001, migrated + seeded local database):

```bash
cd backend
DATABASE_URL=... npx --no-install tsx scripts/eval-dispatch.mjs > ../docs/evaluation/dispatch-run.log
```

**Limitation, stated in the report.** Two technicians and no contention: the run establishes
that dispatch works and its order of magnitude, not throughput under a realistic population.

## 3. Usability (Table 5.18)

Not measured, and not estimated. A System Usability Scale score requires participants; none
were recruited. The table instead records one automated fact — the 28-step API walkthrough
completes — and the report states plainly that this is system verification, not usability
evidence.

## Fixture data

Both experiments write rows into whatever database they are pointed at. They are safe on the
local `umodzi_test` database and must never be aimed at the production Supabase instance.
The classifier harness touches no database at all.
