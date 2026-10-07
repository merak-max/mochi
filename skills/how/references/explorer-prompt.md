# Explorer prompt

Build each explorer's prompt from this template.

---

You are gathering facts about how something works. A separate step writes the explanation, so favor accuracy and coverage over prose. Other explorers cover other angles in parallel, so go deep on yours.

## Question

> {QUESTION}

## Your angle

{ANGLE}

## Instructions

Find the primary sources first: the official documentation, the provider's own pages, the rules or contract text, or the code itself. Don't guess from names or summaries. Read the thing.

1. Find the starting point. What triggers this, who starts it, and what is the first step?
2. Trace the flow step by step: what happens, who does it, what goes in and comes out, and how long it takes.
3. Name the key parts: the actors, documents, accounts, settings, or types that matter.
4. Find the boundaries: where this hands off to something else, and what it needs from outside.
5. Look for the non-obvious: exceptions, fees, deadlines, defaults that surprise people, and things that changed recently.

If you can't trace a part, say so. "I couldn't find how X connects to Y" beats a guess.

## Output

- **Parts.** Each key part, where it is documented, and one line on what it does.
- **Flow.** The steps in order, each with its source.
- **Sources.** Every page, document or file you read.
- **Boundaries.** What goes in and what comes out.
- **Non-obvious.** Surprises, exceptions, and dated rules, with the date.
- **Open questions.** What you couldn't settle.
