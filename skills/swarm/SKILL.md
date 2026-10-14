---
name: swarm
description: Fan out parallel subagents over independent slices of a task, or race attempts, and merge into one report.
---

# Swarm

Fan out N subagents. They cover separate slices, race the same brief, or both. You wait, merge, and return one report.

## Frame

1. State what done looks like and what the report must contain.
2. Choose the shape. Slices split the work, for example one agent per airline or per month of statements. A race gives N agents the same brief. For a race, decide the rule before spawning: first to pass, rank all, or best of N.
3. Set N from the owner or from the slices. Prefer fewer, larger slices to many tiny ones.
4. Pick the model. Use tier `fast` for extraction and lookups, `default` for anything that needs judgment. A race between models names each arm's model up front.
5. When workers write, give each its own output path, such as `data/work/<slug>/<slice>.md`. Two workers never write the same file, note or browser profile.

If a deterministic script can process every item in one pass, run it in `codemode` instead. `llm` over `Promise.all` handles the same small judgment over hundreds of items more cheaply than a swarm.

## Fan out

Start every worker in one script with `Promise.all`: `fork` when the slice needs what this conversation knows, otherwise `agent` with `type: "worker"`, often on the fast model. An `agent` brief stands alone: the goal, its exact slice, how to check its work, and what to return. Every worker reports `PASS`, `ISSUES` or `BLOCKED` with evidence (links, quotes, prices with their source). A worker that finds problems lists all of them, not just the first.

## Merge

Each `agent` call resolves to that worker's result. Collect them with `Promise.allSettled`, and stop any worker that will not finish with `agent_stop`. Drop a result that lacks the evidence its brief asked for and rerun that slice once. A second miss is a gap, and a gap is not a pass. Proceed with N-1 when a worker fails and say so.

Never paste raw worker output. Keep a short table of slice and result, one line per issue with its evidence, and the gaps.

**Reply:** the merged answer, the per-slice results in brief, the gaps, and the race rule if you used one.
