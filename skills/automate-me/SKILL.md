---
name: automate-me
description: Learn how the owner writes and likes things done, from past chats and sent messages, and save it as memory lines.
---

# Automate me

Turn the owner's habits into one-line `note` entries: how they write, and their standing instructions. Mochi does not generate skills.

## 1. Check what exists

Read the memory section of your prompt and `recall` lines on how the owner writes. If lines exist, this is an update: mine only what came after their dates, and write a new line for each one the new evidence contradicts.

## 2. Mine the evidence

Mine three places, one fork each in a single `fork` call, each returning patterns with entry ids or message links:

- **Corrections in past chats.** `recall` for "too long", "shorter", "don't", "always", "never", "I prefer", and the owner's rewrites of mochi's drafts.
- **The owner's sent messages and mail**, through the `apps` skill: greetings, sign-offs, length, language mix, formality by recipient, emoji.
- **Choices they made.** Bookings, purchases and plans they accepted or rejected, and why.

Keep a pattern only when it shows up in two or more places or times.

## 3. Ask once

Send the owner one message with the five or so patterns you are least sure of, each a short statement to confirm or correct, plus one open question: "Anything else I should always or never do?"

## 4. Write the memory lines

- How they write: one line per audience (close friends, family, work, strangers), each with a short real example.
- Standing instructions: one imperative rule per line. Every line shows in the prompt, so keep them few and short, and skip what memory already holds.

Use the owner's words where you can. No line that only says "communicate clearly".

## 5. Check

Draft one short message to a real recent contact in the owner's voice and show it. Their reaction is the test. Write a correcting line from it.

**Reply:** the memory lines written, the patterns kept and dropped, and the test draft.
