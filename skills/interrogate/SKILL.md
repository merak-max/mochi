---
name: interrogate
description: Use for "poke holes", or before a costly or one-way plan. Reviewers on other models attack it, and you give the verdict.
---

# Interrogate

One reviewer per model, on the same material. The adversarial signal comes from model diversity, not from personas. The result is a verdict. Apply no change on your own.

## 1. Gather

Collect what is under review (the plan, the draft, the decision with its options, the claim with its sources). Add the context a reviewer needs: the owner's constraints from memory, the budget, the deadline, the people.

## 2. State the intent

Write one paragraph on what the material tries to achieve, from the owner's messages and the material. Reviewers challenge how well the material achieves the intent, not the intent. If you cannot tell the intent, ask the owner.

## 3. Review

Send the same brief in one `agent` call, with one job per reviewer. Give each job a `definition` that names a definition on a different model family. The definitions list in your prompt shows each one, and its file shows its model. Build the brief from [references/reviewer-prompt.md](references/reviewer-prompt.md), with the intent, the material and [references/rubric.md](references/rubric.md).

## 4. Judge

Merge duplicates, and note which models raised each finding. A finding that two or more models raised on their own is the strongest signal. Then judge as the lead per [references/lead-judgment.md](references/lead-judgment.md). Put each finding in one bucket:

| Bucket | What goes in |
| --- | --- |
| Act on | A real problem with cost, safety, feasibility or the owner's goal. Five or fewer. |
| Consider | A fair point whose fix may not be worth it. The owner decides. |
| Noted | True, but not worth acting on now. |
| Dismissed | Wrong, a nitpick, or missing context. One line on why. |

**Reply:** the intent, then Act on, Consider, Noted and Dismissed, each finding with its models and a one-line reason, then where the models agreed and where they split. On a chat channel, send Act on and Consider, and put the rest in a file.
