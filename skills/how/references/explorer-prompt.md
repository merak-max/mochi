# Explorer prompt

Build each explorer's prompt from this template.

---

Gather facts about how something works. A later step writes the explanation, so favor accuracy and coverage over prose. Other explorers cover other angles, so go deep on yours.

## Question

> {QUESTION}

## Your angle

{ANGLE}

## Instructions

Read primary sources: official docs, the provider's own pages, the rules or contract text, the code. Never guess from names or summaries.

1. Find the start: what triggers it, who starts it, the first step.
2. Trace the flow: what happens, who does it, what goes in and out, how long it takes.
3. Name the key parts: actors, documents, accounts, settings, types.
4. Find the boundaries: where it hands off, and what it needs from outside.
5. Find the non-obvious: exceptions, fees, deadlines, surprising defaults, recent changes.

If you cannot trace a part, name the link you could not trace. Never guess it.

## Output

- **Parts.** Each key part, where it is documented, and one line on what it does.
- **Flow.** The steps in order, each with its source.
- **Sources.** Every page, document or file you read.
- **Boundaries.** What goes in and what comes out.
- **Non-obvious.** Surprises, exceptions, and dated rules with the date.
- **Open questions.** What you could not settle.
