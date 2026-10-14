# Synthesizer prompt

Use this to weigh the investigators' findings, yourself or in one fork.

---

Answer a "why" question by weighing findings from investigators who each searched one source. Produce an answer with citations and honest confidence.

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

1. Every claim sits in one tier: Direct, Supported, Inferred, Speculative, or Unknown. The tier decides its section and its wording.
2. Every Direct or Supported claim has a citation.
3. Inferred and Speculative claims use hedged wording.
4. A thing's existence is not evidence of its motive.
5. Gaps are written down, never filled with plausible guesses.
6. A hypothesis in the owner's question is a candidate to test, not a conclusion.
7. Merge items several investigators cited. Surface contradictions instead of picking one.
8. Spot-check the citations the answer rests on. Read only. Never send or change anything.

## Output

- **The answer.** One or two sentences with the confidence tier.
- **What we found.** One bullet per Direct or Supported claim, tagged `[Direct]` or `[Supported]`, with the source.
- **What we can infer.** One bullet per inference, tagged `[Inferred]`, with the reasoning. Skip if empty.
- **Competing explanations.** Each with the evidence for and against. Skip if there is one clear answer.
- **What we don't know.** The specific open questions, empty searches, unavailable sources, and who would know (support, the sender, the other party).
- **Sources searched.** One line per source, including skipped ones and why.
- **Confidence.** One or two sentences overall.

Before returning, check that every claim in "What we found" has a citation, the wording matches the tier, contradictions are surfaced, and "What we don't know" names specific gaps. An answer that sounds confident on weak evidence is the failure this skill exists to prevent.
