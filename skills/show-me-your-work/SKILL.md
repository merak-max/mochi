---
name: show-me-your-work
description: Keep a decision log (what, why, evidence, result) for long or unattended work so the owner can trust it.
---

# Show me your work

Keep one log per piece of work.

## Format

A TSV file at `data/work/<slug>/decisions.tsv`, one row per decision, each cell on one line:

```
ts	phase	decision	why	evidence	result
2026-10-05T09:02:00Z	frame	listed the 14 receipts to file and the bank total to match	know the size before starting	data/work/taxes/receipts.md	14 receipts, 41,200 INR
2026-10-05T09:40:00Z	search	pulled card statements for April to March from email	the receipts alone miss small charges	email search "statement" since 2025-04-01	12 statements found, March missing
2026-10-05T11:30:00Z	file	undid receipt 10 because the app read the date wrong	checked the saved entry instead of trusting the upload result	entry 890 deleted, re-added as 891	fixed
```

- **ts.** ISO 8601 time.
- **phase.** The step or workstream.
- **decision.** What was chosen or done, in plain words.
- **why.** The reason.
- **evidence.** A pointer that proves it: a link, a confirmation number, an entry id, a file path, a trigger id. Never a paragraph.
- **result.** `confirmed`, `booked`, `sent`, `undone`, `NOT VERIFIED`, `open`, or the outcome.

## Logging

Append a row with `bash` (`printf` with tabs, `>>`) or `edit`. Strip tabs and newlines from cell text. Prefix a cell that starts with `=`, `+`, `-`, `@` or `"` with a single quote: the owner may open the file in a spreadsheet.

Log forks, completed units with their check, pivots and undos with their cause, blockers, and defaults you applied. Skip the self-evident. Write one row per loop iteration.

When a run picks up a log that has rows (a trigger run, a resumed project), its first row has phase `start` and names the run (trigger id, fork name or profile name). Use phase `start` for nothing else.

The log is append-only. Correct a wrong row with a new row that supersedes it.

## Audit before you hand back

Walk this run's rows against what happened (`recall` with an `entry`). Every row maps to a real action, and every evidence pointer resolves and shows what the row claims. Add each unlogged fork or undo that shaped the work.

## Second opinion

For work the owner will rely on, send the log path to a profile on a model other than the one that did the work (`profile_list`). It reads the log and the run and flags weak or missing evidence, checks claimed but not done, risky choices, and gaps a skim would miss. It does not redo the work.

A reply for a run with a log ends with an Attention section. Its first line is `reviewed by <model>`, then each flag with the row or moment it points to. "No flags" is a valid result.
