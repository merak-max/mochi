---
name: show-me-your-work
description: Keep a decision log (what, why, evidence, result) for long or unattended work so the owner can trust it.
---

# Show me your work

Keep one log per piece of work.

## Format

A TSV file at `data/work/<slug>/decisions.tsv`, one row per decision. Cells stay on one line. Evidence is a pointer, not prose. The header row:

```
ts	phase	decision	why	evidence	result
```

- **ts.** ISO 8601 time.
- **phase.** The step or workstream.
- **decision.** What was chosen or done, in one line.
- **why.** The reason in plain words.
- **evidence.** What proves it: a link, a confirmation number, an entry id, a file path, a trigger id. Never a paragraph.
- **result.** The outcome: `confirmed`, `booked`, `sent`, `undone`, `NOT VERIFIED`, `open`.

An example in plain words, the way you'd tell a friend what you did:

```
ts	phase	decision	why	evidence	result
2026-10-05T09:02:00Z	frame	listed the 14 receipts to file and the bank total to match	know the size before starting	data/work/taxes/receipts.md	14 receipts, 41,200 INR
2026-10-05T09:40:00Z	search	pulled card statements for April to March from email	the receipts alone miss small charges	email search "statement" since 2025-04-01	12 statements found, March missing
2026-10-05T10:15:00Z	file	filed receipts 1 to 9 in the expense app	matched each to a statement line	expense app entries 881-889	filed, totals match
2026-10-05T11:30:00Z	file	undid receipt 10 because the app read the date wrong	checked the saved entry instead of trusting the upload result	entry 890 deleted, re-added as 891	fixed
```

## Logging

Append a row with `bash` (`printf` with tabs, appended with `>>`) or `edit`. Strip tabs and newlines from cell text. Prefix a cell that starts with `=`, `+`, `-`, `@` or `"` with a single quote, because the owner may open the file in a spreadsheet.

Log forks, completed units with their check, pivots and undos with their cause, blockers, and defaults you applied for the owner. Skip the self-evident. For loops, write one row per iteration.

When a new run picks up a log that already has rows (a trigger run, a resumed project), its first row has phase `start` and names the run, such as the trigger id, fork name or profile name. Use phase `start` for nothing else.

The log is append-only. A wrong call gets a new row that supersedes it. Never edit or delete history.

## Audit before handing back

Check that the log told the truth. Walk this run's rows against what actually happened in the conversation (`recall` with an `entry`). Every row maps to a real action, and every evidence pointer resolves and shows what the row claims. A fork or undo that shaped the work but isn't logged is a gap, so add it. Correct the log with new rows, never by editing old ones.

## Second opinion

For work the owner will rely on, send the log path to a profile on a different model from the one that did the work (`profile_list` shows each one's model). It reads the log and the run, and flags what the owner should look at: weak or missing evidence, checks claimed but not done, risky choices, and gaps a skim would miss. It doesn't redo the work.

A reply for a run with a log ends with an Attention section. Its first line is `reviewed by <model>`, followed by each flag with the row or moment it points to. "No flags" is a valid result.
