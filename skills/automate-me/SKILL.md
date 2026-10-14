---
name: automate-me
description: Learn how the owner writes and likes things done from past chats and sent messages; save it as memory lines.
---

# Automate me

Turn the owner's habits into memory lines mochi follows. The output is one-line `note` entries for how they write and for their standing instructions. Mochi does not generate skills.

## 1. Check what exists

Read the memory section of your prompt, and `recall` for lines on how the owner writes. If such lines exist, this is an update. Mine only what came after their dates, and write a new line for each one the new evidence contradicts.

## 2. Mine the evidence

Search for patterns in three places, each slice in one fork of a single `fork` call that returns patterns with entry ids or message links:

- **Corrections in past chats.** `recall` for "too long", "shorter", "don't", "always", "never", "I prefer", and the owner rewriting mochi's drafts.
- **The owner's own sent messages and emails**, through the Executor apps. Look at greetings, sign-offs, length, language mix, formality by recipient, and emoji.
- **Choices they made.** Bookings, purchases and plans they accepted or rejected, and why.

Keep a pattern only when it shows up in two or more places or times. A lone signal is noise.

## 3. Ask once

Mining misses intent. Send the owner one message with the five or so patterns you are least sure of, each as a short statement they can confirm or correct, plus one open question: "Anything else I should always or never do?"

## 4. Write the memory lines

- How they write, one line per audience (close friends, family, work, strangers), each with a short real example.
- Standing instructions, one rule per line, in imperative form. Every line shows in the prompt, so keep them few and short. Do not repeat what memory already holds.

Use the owner's words where you can. Write through `unslop`. No section that only says "communicate clearly".

## 5. Check

Draft one short message to a real recent contact in the owner's voice and show it to them. Their reaction is the test. Write a line that corrects memory from it.

**Reply:** the memory lines written, the patterns kept and dropped, and the test draft.
