# Library

The library file has two parts. When it is missing, create it with both headings.

## Edits

One table row per edit or proposal:

| id | date | file | signal | baseline | commit | verdict | today | evidence |
|---|---|---|---|---|---|---|---|---|
| e-2026-10-20-1 | 2026-10-20 | skills/mochi-mode/playbooks/delegate.md | busy_queued | 0.101 | abc1234 | pending | | 1#52421 queued send reported as started |

A code proposal has `code:<path>` as the file, no commit, and the verdict `proposed`.

## Lessons

At most one new lesson per run, and only when judged rows support it:

- cue: the shape of situation it applies to, not this day's facts.
- lesson: the operation to perform on the harness, naming the component.
- evidence: the edit ids and their verdicts.
- confidence: high, medium or low, and why.

Too generic is useless ("be thorough"). Too specific never fires again. A lesson that rests only on `confounded` or `pending` rows is a guess: write NO_ENTRY instead. Adoption alone never shows that an edit helped.
