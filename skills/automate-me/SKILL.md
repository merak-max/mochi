---
name: automate-me
description: Learn how the owner writes and likes things done from past chats and sent messages; save it as notes.
---

# Automate me

Turn the owner's habits into notes mochi follows. The output is an `owner-voice` note of kind `preference` for how they write, plus `rule` or `preference` notes for standing instructions. Mochi does not generate skills.

## 1. Check what exists

Read the existing `user` and `rule` notes in your prompt, and the `preference` notes through `recall`. If an `owner-voice` note exists, this is an update. Mine only what came after its `updated` date, and change what the new evidence contradicts.

## 2. Mine the evidence

Search for patterns in three places, each slice in a `fast` subagent that returns patterns with entry ids or message links:

- **Corrections in past chats.** `recall` for "too long", "shorter", "don't", "always", "never", "I prefer", and the owner rewriting mochi's drafts.
- **The owner's own sent messages and emails**, through the Executor apps. Look at greetings, sign-offs, length, language mix, formality by recipient, and emoji.
- **Choices they made.** Bookings, purchases and plans they accepted or rejected, and why.

Keep a pattern only when it shows up in two or more places or times. A lone signal is noise.

## 3. Ask once

Mining misses intent. Send the owner one message with the five or so patterns you are least sure of, each as a short statement they can confirm or correct, plus one open question: "Anything else I should always or never do?"

## 4. Write the notes

- `owner-voice` (`preference`): how they write, by audience (close friends, family, work, strangers), with two or three short real examples of each.
- Standing instructions as `rule` notes, one rule per note, in imperative form. Rules are always in the prompt and share a 4,000-character cap, so keep them few and short. Merge before adding.
- Everything else as `preference` notes, which load on demand.

Use the owner's words where you can. Write through `unslop`. No section that only says "communicate clearly".

## 5. Check

Draft one short message to a real recent contact in the owner's voice and show it to them. Their reaction is the test. Revise the notes from it.

**Reply:** the notes written or changed, the patterns kept and dropped, and the test draft.
