---
name: swarm
description: Use for "swarm this", many independent items, or a race on one brief. Parallel forks merged into one report.
---

# Swarm

Fan out N workers over separate slices, a race on one brief, or both. Then merge one report.

## 1. Frame

1. Write what done is and what the report must contain.
2. Choose the shape. Slices split the work: one fork per airline, one per month of statements. A race gives N workers the same brief: decide its rule first (first to pass, rank all, or best of N).
3. Set N from the owner or from the slices. Prefer fewer, larger slices.
4. A fork runs on your model. A race between models sends the same brief to profiles on different models (`profile_list`) and names each arm's model.
5. Give each writing worker its own output path, such as `<slug>/<slice>.md` in the work directory. Two workers never write the same file, note or browser profile.

Before you fan out, check for a cheaper lever:

| The work | Lever |
| --- | --- |
| A deterministic script can do every item in one pass | One `codemode` script |
| One small judgment over hundreds of items | `llm` over `Promise.all` |
| Each item needs tools and reading | Swarm |

## 2. Fan out

Start every worker in one `fork({ briefs: [...] })` call, or with `fork_start` for slices that take minutes. Each brief names its exact slice, how to check its work, and what to return. A self-contained mechanical slice can go to the `worker` profile with `profile_send`. Each worker reports `PASS`, `ISSUES` or `BLOCKED` with evidence (links, quotes, prices with their source), and lists every problem, not only the first.

## 3. Merge

A background fork cannot be stopped from here, so start fewer. Drop a result that lacks its evidence and rerun that slice once. A second miss is a gap, and a gap is not a pass. When a worker fails, continue with N-1 and say so.

Keep a short table of slice and result, one line per issue with its evidence, and the gaps. Never paste raw worker output.

**Reply:** the merged answer, the per-slice results in brief, the gaps, and the race rule if any.
