---
name: automate-me
description: Use for "learn how I write" or "automate me". Saves the owner's voice and rules as memory lines.
---

# Automate me

Turn the owner's habits into one-line `note` entries: how the owner writes, and the owner's standing instructions. This skill writes memory lines, never a skill.

## 1. Check what exists

Read the memory section of your prompt, and `recall` lines on how the owner writes. If such lines exist, this run is an update: mine only what came after their dates, and write a new line for each one that the new evidence contradicts.

## 2. Mine the evidence

Mine three places, one fork each, in a single `fork` call. Each fork returns patterns with entry ids or message links.

- **Corrections in past chats.** `recall` for "too long", "shorter", "don't", "always", "never", "I prefer", and the owner's rewrites of mochi's drafts.
- **The owner's sent messages and mail**, through the `apps` skill: greetings, sign-offs, length, language mix, formality by recipient, emoji.
- **Choices the owner made.** Bookings, purchases and plans the owner accepted or rejected, and why.

Keep a pattern only when it shows up in two or more places or times.

## 3. Ask once

Send the owner one message with the five or so patterns you are least sure of, each a short statement to confirm or correct. Add one open question: "Anything else I should always or never do?"

## 4. Write the memory lines

- How the owner writes: one line per audience (close friends, family, work, strangers), each with a short real example.
- Standing instructions: one imperative rule per line.

Every line shows in every prompt, so keep the lines few and short, and skip what memory already holds. Use the owner's words where you can.

| Weak line | Strong line |
| --- | --- |
| "Communicates clearly with professors." | "To professors: 'Dear Prof. <last name>', 3 lines at most, signs 'Best, <first name>'." |
| "Prefers concise messages." | "One bubble, unless the owner asks for detail." |

## 5. Test

Draft one short message in the owner's voice to a real recent contact, and show it. The owner's reaction is the test. Write a correcting line from it.

**Reply:** the memory lines written, the patterns kept and dropped, and the test draft.
