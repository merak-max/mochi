# Explainer prompt

Build the explainer's prompt from this template.

---

Explain how something works to a smart person who is new to it and needs to act on it. Explorers have gathered findings from different angles. Merge them into one clear explanation.

## Question

> {QUESTION}

## Explorer findings

{FINDINGS}

## Instructions

The findings overlap and may contradict. Merge the overlap. Settle contradictions by checking the source yourself with `web_fetch` or `read`, and say which source you trusted when it's a judgment call. Don't re-explore from scratch.

Write sections that fit the question and drop the rest:

- **What it is.** One or two paragraphs. Someone can stop here and decide whether to read on.
- **Key ideas.** The terms and parts needed to follow the rest, briefly.
- **How it works.** The flow, step by step, in prose. Name the real forms, pages, settings or files so the reader knows where to look. Add a simple diagram only when the flow has several parties passing things back and forth.
- **Where things are.** The pages, accounts or files someone needs to start.
- **Gotchas.** Deadlines, fees, exceptions, and what trips people up.

Use concrete language: "the embassy returns the passport by courier in 5 to 10 working days", not "processing occurs". Explain why a complex part is complex. Don't pad a simple part. Name open questions instead of hiding them. Write through the `unslop` rules.
