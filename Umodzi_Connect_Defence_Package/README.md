# Umodzi Connect — Defence Package

Prepared 2026-11-12 for Arnold Malama (2420996), Zambia University College of Technology.

## Contents

| File | What it is |
|---|---|
| `Umodzi_Connect_Final_Report_CORRECTED.docx` | The report with 12 verified corrections (cover, proposal wording, technology claims, dispatch description). Original preserved in `project-reference/backups/2026-11-12/`. |
| `Umodzi_Connect_Final_Defence_Presentation.pptx` | 14-slide defence deck, 16:9, speaker notes on every slide. |
| `Umodzi_Connect_Defence_Study_Guide.docx` | 20-section explanation of the system with code locations. |
| `Umodzi_Connect_Defence_Questions_and_Answers.docx` | Examiner questions grouped by topic, answered from the implementation. |
| `Umodzi_Connect_Defence_Demo_Checklist.docx` | Pre-flight setup, demonstration sequence, backup plan. |
| `Umodzi_Connect_Outstanding_Issues_and_Actions.docx` | What is done, what is pending, what only the student can provide. |
| `SLIDE-NOTES-AND-STUDY-GUIDE.md` | Printable slide-by-slide notes. |
| `FINAL-CROSSCHECK.md` | Application vs report vs presentation, with every contradiction found and fixed. |
| `FINAL-TEST-SUMMARY.md` | Exactly which checks were executed and passed, and which were not run. |
| `CHAT-REALTIME-FIX.md` | Root cause and fix for the broken live chat on the deployed system. |
| `FINAL_HANDOVER_REPORT.md` | Completion table plus completed / required-from-student / recommended lists. |
| `diagrams/` | The ten Prompt 3D diagrams, as SVG sources and 2480×1600 PNGs. All ten are embedded in the report's Appendix D. |
| `DATABASE-SETUP.md` | Runbook for the scratch database: create it, run migrations 001–012, execute the 31 remaining scripts, capture the results. Confirms PostGIS 3.6.2 is already installed on this machine. |
| `REPORT-CORRECTION-SUMMARY.md` | Every change made to the report, before and after. |
| `DEFENCE-BASELINE-REPORT.md` | The Phase 1 audit the corrections are based on. |

## Not yet in this folder

- **PDF exports** of the report and the deck: no Word or LibreOffice automation was available. Open each file and use *Save as PDF*.
- ~~Diagrams as separate files~~: **resolved** — all ten are in `diagrams/` as editable SVG plus print-resolution PNG, and embedded in Appendix D.
- **Final test summary**: the executed checks are recorded in `FINAL-TEST-SUMMARY.md`; the 45 automated scripts remain unexecuted until a disposable database exists.

## Deck note

The `.pptx` in this folder contains the corrected final slide. The copy open in PowerPoint on the desktop did not have the punctuation fix and could not be written to while locked — the same corrected file is staged beside it as
`Umodzi_Connect_Final_Defence_Presentation_v2.pptx`. Close PowerPoint, then use either the packaged copy or `_v2`.

## Standing rule

No measurement is reported that was not executed. Chapter Five's evaluation tables remain blank on purpose until real results exist.
