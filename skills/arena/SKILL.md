---
name: arena
description: Use for "arena this", or a draft or plan that matters and has no clear shape. Several attempts; keep the best.
---

# Arena

Run N attempts at the same task. Pick the strongest as the base, graft the best ideas of the rest into it, and check the result.

## 1. Frame

Every candidate gets the same brief. The brief is the contract.

1. Name the artifact each candidate produces.
2. Write a rubric of 3 to 6 concrete criteria. Only you and the judge see it.
3. Use three runners by default, more when the task has several distinct directions. Forks share your model, so for model diversity use profiles on different models (`profile_list`).
4. Give each candidate its own output file under `<slug>/arena/` in the work directory.

## 2. Fan out

Start the forked candidates in one `fork({ briefs: [...] })` call. Each fork brief names only its output path, and asks for a short rationale with the options it rejected. For other models, send the brief and the shared background to each profile with `profile_send`, in one script with `Promise.all`. If one candidate fails, continue with N-1 and say so.

## 3. Judge

Send the judging brief to a profile on a model other than yours. The judge sees the rubric and the candidates by label, never by model. It scores each criterion and recommends a base.

Score each candidate yourself too. If you and the judge disagree, read both rationales before you decide. When two candidates are close, pick the simpler one.

## 4. Graft

Take the one or two things worth keeping from each loser, and rewrite them into the base so that it reads as one piece.

- All candidates converge: take the shape as it is.
- The candidates diverge wildly: the brief was unclear. Rewrite it and run again.

## 5. Check

Check the final artifact like any other work: facts confirmed, the owner's constraints met, `unslop` applied.

**Reply:** the artifact (or where it is), the base and why, what you grafted from which candidate, and what you rejected.
