---
name: swarm
description: Fan out parallel forks over independent slices of a task, or race attempts, and merge into one report.
---

# Swarm

Fan out N forks. They cover separate slices, race the same brief, or both. You wait, merge, and return one report.

## Frame

1. State what done looks like and what the report must contain.
2. Choose the shape. Slices split the work, for example one fork per airline or per month of statements. A race gives N forks the same brief. For a race, decide the rule before spawning: first to pass, rank all, or best of N.
3. Set N from the owner or from the slices. Prefer fewer, larger slices to many tiny ones.
4. Pick the model. A fork runs on your model. A race between models sends the same brief to profiles on different models (`profile_list` shows each one's model) and names each arm's model up front.
5. When workers write, give each its own output path, such as `data/work/<slug>/<slice>.md`. Two workers never write the same file, note or browser profile.

If a deterministic script can process every item in one pass, run it in `codemode` instead. `llm` over `Promise.all` handles the same small judgment over hundreds of items more cheaply than a swarm.

## Fan out

Start every worker in one `fork({ briefs: [...] })` call. A fork already knows this conversation, so each brief names its exact slice, how to check its work, and what to return. A self-contained mechanical slice can go to the `worker` profile with `profile_send` instead, which follows an exact brief on the fast tier. Every worker reports `PASS`, `ISSUES` or `BLOCKED` with evidence (links, quotes, prices with their source). A worker that finds problems lists all of them, not just the first.

## Merge

The `fork` call resolves to the workers' answers in brief order. A background fork cannot be stopped from here, so start fewer. Drop a result that lacks the evidence its brief asked for and rerun that slice once. A second miss is a gap, and a gap is not a pass. Proceed with N-1 when a worker fails and say so.

Never paste raw worker output. Keep a short table of slice and result, one line per issue with its evidence, and the gaps.

**Reply:** the merged answer, the per-slice results in brief, the gaps, and the race rule if you used one.
