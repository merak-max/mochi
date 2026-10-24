---
name: swarm
description: Use for "swarm this", many independent items, or a race on one brief. Parallel forks merged into one report.
---

# Swarm

Fan out N workers over separate slices, a race on one brief, or both. Then merge one report.

## 1. Frame

1. Write what done is and what the report must contain.
2. Choose the shape. Slices split the work into independent parts. A race gives N workers the same brief: decide its rule first (first to pass, rank all, or best of N).
3. Set N from the owner or from the slices. Prefer fewer, larger slices.
4. A fork runs on your model. A race between models gives each arm the same brief in a job with `definition` that names a definition on a different model, and names each arm's model. The definitions list in your prompt shows each one, and its file shows its model.
5. Give each writing worker its own output file under `<slug>/` in the work directory. Two workers never write the same file, memory file or browser profile.

Before you fan out, check for a cheaper lever:

| The work | Lever |
| --- | --- |
| A deterministic script can do every item in one pass | One `codemode` script |
| One small judgment over hundreds of items | `llm` over `Promise.all` |
| Each item needs tools and reading | Swarm |

## 2. Fan out

Start every worker in one `agent({ jobs: [...] })` call with `fork: true` on each job, or with `background: true` for slices that take minutes. Each brief names its exact slice, how to check its work, and what to return. A self-contained mechanical slice can go to a job with `definition: "worker"`. Each worker reports `PASS`, `ISSUES` or `BLOCKED` with evidence (links, quotes, prices with their source), and lists every problem, not only the first.

## 3. Merge

A background fork cannot be stopped from here, so start fewer. Drop a result that lacks its evidence and rerun that slice once. A second miss is a gap, and a gap is not a pass. When a worker fails, continue with N-1 and say so.

Keep a short table of slice and result, one line per issue with its evidence, and the gaps. Never paste raw worker output.

**Reply:** the merged answer, the per-slice results in brief, the gaps, and the race rule if any.
