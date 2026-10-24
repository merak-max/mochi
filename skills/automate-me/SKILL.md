---
name: automate-me
description: Use for "learn how I write" or "automate me". Saves the owner's voice and rules as memory lines.
---

# Automate me

Turn the owner's habits into one-line entries in the memory files: how the owner writes, and the owner's standing instructions. This skill writes memory lines, never a skill.

## 1. Check what exists

Read the memory files for lines on how the owner writes. If such lines exist, this run is an update: mine only what came after their dates, and write a new line for each one that the new evidence contradicts.

## 2. Mine the evidence

Mine three places, one fork each, in a single `agent` call with `fork: true`. Each fork returns patterns with entry ids or message links.

- **Corrections in past chats.** The owner's complaints, standing orders and rewrites of mochi's drafts, found in the view with `zoom`.
- **The owner's sent messages and mail**, through the owner's MCP tools (`searchTools()`): greetings, sign-offs, length, language mix, formality by recipient, emoji.
- **Choices the owner made.** Bookings, purchases and plans the owner accepted or rejected, and why.

Keep a pattern only when it shows up in two or more places or times.

## 3. Ask once

Send the owner one message with the five or so patterns you are least sure of, each a short statement to confirm or correct. Add one open question about what else you should always or never do.

## 4. Write the memory lines

- How the owner writes: one line per audience (close friends, family, work, strangers), each with a short real example.
- Standing instructions: one imperative rule per line.

The model reads these files before it resumes work, so keep the lines few and short, and skip what memory already holds. Use the owner's words where you can.

A line names something you can check in a message: a greeting, a sign-off, a length, a case, a language. Drop a line that only praises or describes.

## 5. Test

Draft one short message in the owner's voice to a real recent contact, and show it. The owner's reaction is the test. Write a correcting line from it.

**Reply:** the memory lines written, the patterns kept and dropped, and the test draft.
