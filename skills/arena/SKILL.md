---
name: arena
description: Several models attempt the same work; keep the best and graft in the rest's strengths. For drafts or plans that matter.
---

# Arena

Run N attempts at the same task, read every one, pick the strongest as the base, graft the best ideas from the rest, and check the result.

## Frame

Every candidate gets the same brief, so the brief is the contract.

1. State the artifact each candidate produces.
2. Write a rubric of 3 to 6 concrete criteria for what good means here. Only you and the judge see it.
3. Pick the runners. By default use three. Forks all run on your model, so for model diversity use profiles on different models (`profile_list` shows each one's model). Use more runners when the task has several distinct directions.
4. Give each candidate its own output path, such as `data/work/<slug>/arena/<n>.md`.

## Fan out

Start the forked candidates in one `fork({ briefs: [...] })` call. A fork already holds the shared background, so each brief names only its output path and asks for a short rationale naming the options it considered and rejected. For candidates on different models, send the brief with the shared background to each profile with `profile_send`, in one script with `Promise.all`. If one fails, continue with N-1 and note it.

## Judge and pick

After all candidates finish, send the judging brief to a profile on a model different from yours. It sees the rubric and the candidates by label only, never by model name, scores each criterion, and recommends a base.

Read every candidate yourself and score it against the rubric. If you and the judge agree, that confirms the pick. If you disagree, read both rationales before deciding. When two are close, pick the simpler one.

## Graft

Go through each losing candidate once more for the one or two things worth taking. Rewrite them into the base so the result reads as one piece, not a paste-up. When all candidates converge on the same shape, take it as is. When they diverge wildly, the brief was unclear, so rewrite it and run again.

## Check

The final artifact gets the same checks as any other work: facts confirmed, the owner's constraints met, read through `unslop`.

**Reply:** the final artifact (or where it is), the base and why, what was grafted from which candidate, and what was rejected.
