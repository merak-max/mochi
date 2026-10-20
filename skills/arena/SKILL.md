---
name: arena
description: Several models attempt the same work; keep the best and graft in the rest's strengths. For drafts or plans that matter.
---

# Arena

Run N attempts at the same task. Read each one, pick the strongest as the base, graft the best ideas from the rest, and check the result.

## Frame

The brief is the contract: every candidate gets the same one.

1. Name the artifact each candidate produces.
2. Write a rubric of 3 to 6 concrete criteria. Only you and the judge see it.
3. Use three runners by default, more when the task has several distinct directions. Forks share your model, so for diversity use profiles on different models (`profile_list`).
4. Give each candidate its own output path, such as `data/work/<slug>/arena/<n>.md`.

## Fan out

Start forked candidates in one `fork({ briefs: [...] })` call. Each fork brief names only its output path and asks for a short rationale with the options it rejected. For other models, send the brief with the shared background to each profile with `profile_send`, in one script with `Promise.all`. If one fails, go on with N-1 and say so.

## Judge and pick

Send the judging brief to a profile on a model other than yours. It sees the rubric and the candidates by label only, never by model, scores each criterion, and recommends a base.

Score each candidate yourself too. If you and the judge disagree, read both rationales before you decide. When two are close, pick the simpler one.

## Graft

Take the one or two things worth keeping from each loser and rewrite them into the base so it reads as one piece. When all candidates converge, take the shape as is. When they diverge wildly, the brief was unclear: rewrite it and run again.

## Check

Check the final artifact like any other work: facts confirmed, the owner's constraints met, `unslop` applied.

**Reply:** the artifact (or where it is), the base and why, what was grafted from which candidate, and what was rejected.
