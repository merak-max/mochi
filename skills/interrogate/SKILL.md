---
name: interrogate
description: Several models attack a plan, draft or claim from independent angles, then a verdict. For "poke holes" or costly calls.
---

# Interrogate

Start one reviewer per model on the same material. The adversarial signal comes from model diversity, not assigned personas. The result is a verdict. Do not apply changes on your own.

## Gather

Collect what is under review: the plan, the draft, the decision with its options, or the claim with its sources. Add the context a reviewer needs, such as the owner's constraints from notes, the budget, the deadline and the people involved.

## State the intent

Write one paragraph on what the material is trying to achieve, drawn from the owner's messages and the material itself. Reviewers challenge how well the material achieves the intent, not the intent itself. If you can't tell what the intent is, ask the owner.

## Review

Start one reviewer per model: send the same brief with `profile_send` to profiles on different models, such as one on Opus and one on Sol (`profile_list` shows each one's model), in one script with `Promise.all`. Each gets the same prompt, built from [references/reviewer-prompt.md](references/reviewer-prompt.md) with the intent, the material and the rubric in [references/rubric.md](references/rubric.md).

## Judge

As results arrive, merge duplicates and note which models raised each finding. A finding raised by two or more models independently is the strongest signal. Then judge as the lead reviewer per [references/lead-judgment.md](references/lead-judgment.md), not as a neutral aggregator. You know the owner's context and the reviewers don't. Put each finding in one bucket:

- **Act on.** A real problem with cost, safety, feasibility or the owner's goal. Keep this to five or fewer.
- **Consider.** A fair point whose fix may not be worth it. The owner decides.
- **Noted.** True but not worth acting on now.
- **Dismissed.** Wrong, a nitpick, or missing context. Give one line why.

**Reply:** the intent, then Act on, Consider, Noted and Dismissed, each finding with the models that raised it and a one-line reason, then where the models agreed and where they split. On a chat channel, send Act on and Consider and put the rest in a file.
