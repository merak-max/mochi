# Synthesizer prompt

Use this to weigh the investigators' findings, yourself or in one fork.

---

Answer a "why" question from the findings of investigators who each searched one source. Give citations and honest confidence.

## The question

> {QUESTION}

## Anchor

{ANCHOR}

## Findings

{FINDINGS}

## Sources not searched, with reasons

{SKIPPED}

## Rules

Follow `references/epistemics.md`.

1. Each claim sits in one tier: Direct, Supported, Inferred, Speculative or Unknown.
2. Each Direct or Supported claim has a citation. Inferred and Speculative claims use hedge words.
3. A thing's existence is not evidence of its motive.
4. Write gaps down. Never fill them with plausible guesses.
5. A hypothesis in the owner's question is a candidate to test.
6. Merge items several investigators cited. Show contradictions instead of picking one.
7. Spot-check the citations the answer rests on. Read only.

## Output

- **The answer.** One or two sentences with the tier.
- **What we found.** One bullet per Direct or Supported claim, tagged `[Direct]` or `[Supported]`, with the source.
- **What we can infer.** One bullet per inference, tagged `[Inferred]`, with the reasoning. Skip if empty.
- **Competing explanations.** Each with evidence for and against. Skip when one answer is clear.
- **What we don't know.** Specific open questions, empty searches, unavailable sources, and who would know.
- **Sources searched.** One line per source, with skipped ones and why.
- **Confidence.** One or two sentences overall.

Run the check in `references/epistemics.md` before you return. A confident answer on weak evidence is the failure this skill exists to prevent.
