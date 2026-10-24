---
name: show-me-your-work
description: Use for long or unattended work the owner reviews later. A decision log of what, why, evidence and result.
---

# Show me your work

Keep one log per piece of work, so the owner can audit it later without asking you.

## Format

A TSV file at `<slug>/decisions.tsv` in the work directory, one row per decision, each cell on one line. The first line is the header:

```
ts	phase	decision	why	evidence	result
```

- **ts.** ISO 8601 time.
- **phase.** The step or workstream.
- **decision.** What was chosen or done, in plain words.
- **why.** The reason.
- **evidence.** A pointer that proves it: a link, a confirmation number, an entry id, a file path, a trigger id. Never a paragraph.
- **result.** `confirmed`, `booked`, `sent`, `undone`, `NOT VERIFIED`, `open`, or the outcome.

## Logging

Append a row with `bash` (`printf` with tabs, `>>`) or `edit`. Strip tabs and newlines from cell text. Prefix a cell that starts with `=`, `+`, `-`, `@` or `"` with a single quote: the owner may open the file in a spreadsheet.

Log forks, completed units with their check, pivots and undos with their cause, blockers, and defaults you applied. Write one row per loop iteration. Skip the self-evident.

When a run picks up a log that has rows (a trigger run, a resumed project), its first row has phase `start` and names the run (trigger id, fork name or agent name). Use phase `start` for nothing else.

The log is append-only. Correct a wrong row with a new row that supersedes it.

## Audit before you hand back

Walk this run's rows against what happened (`zoom` the view). Every row maps to a real action, and every evidence pointer resolves and shows what the row claims. Add each unlogged fork or undo that shaped the work.

## Second opinion

For work the owner will rely on, send the log path in a job with `definition` that names a definition on a model other than the one that did the work. The definitions list in your prompt shows each one, and its file shows its model. It reads the log and the run and flags weak or missing evidence, checks claimed but not done, risky choices, and gaps a skim would miss. It does not redo the work.

A reply for a run with a log ends with an Attention section. Its first line is `reviewed by <model>`, then each flag with the row or moment it points to. "No flags" is a valid result.
