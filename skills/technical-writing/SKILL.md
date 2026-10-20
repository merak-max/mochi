---
name: technical-writing
description: "Standard for guides, how-tos, references, proposals and READMEs: Diátaxis structure, plain global English."
---

# Technical writing

Write so a tired reader understands on the first read. Four layers, one question each: what kind of document is this, how do sentences address the reader, how much does each sentence carry, and can any sentence be read two ways. Apply all four, on top of `unslop`.

- Cut every word that does no work.
- Use the short, everyday word. A long word must buy its length with precision.
- When a rule makes a sentence worse, fix the sentence another way or leave it. A sentence that obeys every rule and sounds machine-made has failed.
- Write the real name of the form, setting, button, file or command, never a synonym or a description. A named term is fine once the doc defines it.

## Vary the rhythm

- Mix sentence lengths. A short sentence lands a point. A longer one carries a fact with its condition or consequence. Split the sentence with two thoughts. Keep the long sentence with one.
- Have a view where the mode allows it. Explanation weighs trade-offs, so say what you make of them. Reference stays dry.
- Be specific: not "late submission can cause issues" but "a form filed after 31 July costs a 5,000 INR fee".

## Pick the mode first (Diátaxis)

One document, one mode. Does it serve action or understanding, and learning or work?

- **Tutorial** (action, learning). You are the teacher, and the learner's success is your job. Open with what they will build. Every step gives a visible result, and you say what they should see. Cut explanation to one clause and a link. Write as "we", in commands.
- **How-to** (action, work). Solve a problem a person has. Assume competence. Action only: link background instead. Allow forks: "If you want x, do y." Name it by the task: "How to calibrate the radar array".
- **Reference** (understanding, work). Describe only: no instruction, persuasion or opinion. Be dry, complete and sure. Mirror the structure of the thing described.
- **Explanation** (understanding, learning). One bounded topic that tolerates an implicit "About..." in front. Anchor on a real why question. Give context: decisions, history, constraints, alternatives. Opinion is allowed here and nowhere else.

Do not mix modes. Split and link instead.

## Write to the reader (Google developer style)

- Address the reader as "you", in the present tense. Use "will" only for what happens later.
- Write instructions as commands: "Click Submit." Never "should be done".
- Put the condition before the instruction: "To delete the document, click Delete."
- Put the common case first, exceptions after.
- No "please", and never "simply", "easy" or "quickly" in a procedure.
- Do not pre-announce ("we will soon support..."). Do not start consecutive sentences with the same phrase.
- Link text says where the link goes. Never "click here".
- Headings carry the point ("Pick the mode first", not "Modes"), in sentence case. A task heading is a verb phrase. One h1 per page, no skipped levels.
- Numbered lists for sequences, bullets for the rest. Introduce a list with a full sentence. Keep items parallel.
- Code in code font, UI elements in bold, serial commas. No "etc.": say up front that a list is partial.

## Load one statement at a time (STE)

- One instruction per sentence. One thought per sentence elsewhere.
- Split instructions over about 20 words and other sentences over about 25.
- Put the warning before the step it guards.
- Keep "the" and "a": "Remove backup file" reads two ways.
- Give each word one meaning, and each action one word ("start", never also "initiate").
- Avoid "-ing" words where you can.

## Leave no second reading (Global English)

- Keep "only" and "not" next to the word they change.
- Break up noun strings: "the visa appointment slot reminder email" becomes "the email that reminds you of your visa appointment".
- Make each "it", "they" and "this" point at one obvious thing. Never use "this" or "which" for a whole clause.
- Do not drop verbs: "Week 1 books the flights and week 2 the hotels" leaves week 2 without one.
- Keep the small words that show structure ("Ensure that the switch is off").
- Repeat the article when a series can misread: "the landlord and the agent".
- Use "both...and", "either...or" and "if...then" when "and" or "or" can group two ways.
- Use periods, not semicolons.
- Text in parentheses is a full grammatical unit. Never form plurals with "(s)". No slashes: write "a, b, or both".
- Call each thing by one name everywhere. Do not reword a sentence that did not change.
- Skip idioms, Latin abbreviations and metaphors.

## Delivery

- Messages are writing too. Every layer except Diátaxis applies.
- Make every number, date and count true at send time, and give its source.

## Worked example

Before:

> Submission of the visa application documents is performed via the online portal. Note that it's important to remember that booking the appointment, which reserves a biometrics slot, should only be done after the payment is confirmed. If not, the slot is lost.

After:

> Upload the documents on the visa portal and pay the fee. Wait for the payment confirmation email. Then book the biometrics appointment. If you book before the payment confirms, the portal cancels the slot.
