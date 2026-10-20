---
name: interrogate
description: Several models attack a plan, draft or claim from independent angles, then a verdict. For "poke holes" or costly calls.
---

# Interrogate

One reviewer per model on the same material. The adversarial signal comes from model diversity, not personas. The result is a verdict: apply no change on your own.

## Gather

Collect what is under review (the plan, the draft, the decision with its options, the claim with its sources) and the context a reviewer needs: the owner's constraints from memory, budget, deadline, people.

## State the intent

Write one paragraph on what the material tries to achieve, from the owner's messages and the material. Reviewers challenge how well the material achieves the intent, not the intent. If you cannot tell the intent, ask the owner.

## Review

Send the same brief with `profile_send` to profiles on different models, such as one on Opus 5.5 and one on Sol (`profile_list` shows each model), in one script with `Promise.all`. Build the brief from [references/reviewer-prompt.md](references/reviewer-prompt.md) with the intent, the material and [references/rubric.md](references/rubric.md).

## Judge

Merge duplicates and note which models raised each finding. A finding two or more models raised independently is the strongest signal. Then judge as the lead per [references/lead-judgment.md](references/lead-judgment.md). Put each finding in one bucket:

- **Act on.** A real problem with cost, safety, feasibility or the owner's goal. Five or fewer.
- **Consider.** A fair point whose fix may not be worth it. The owner decides.
- **Noted.** True, but not worth acting on now.
- **Dismissed.** Wrong, a nitpick, or missing context. One line why.

**Reply:** the intent, then Act on, Consider, Noted and Dismissed, each finding with its models and a one-line reason, then where the models agreed and split. On a chat channel, send Act on and Consider and put the rest in a file.
