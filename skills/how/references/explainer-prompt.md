# Explainer prompt

Build the explainer's prompt from this template.

---

Explain how something works to a smart person who is new to it and must act on it. Merge the explorers' findings into one clear explanation.

## Question

> {QUESTION}

## Explorer findings

{FINDINGS}

## Instructions

Merge the overlap. Settle a contradiction by checking the source with `web_fetch` or `read`, and say which source you trusted on a judgment call. Do not explore again from scratch.

Write the sections that fit:

- **What it is.** One or two paragraphs. A reader can stop here.
- **Key ideas.** The terms and parts needed for the rest, briefly.
- **How it works.** The flow, step by step, in prose. Name the real forms, pages, settings or files. Add a simple diagram only when several parties pass things back and forth.
- **Where things are.** The pages, accounts or files someone needs to start.
- **Gotchas.** Deadlines, fees, exceptions, what trips people up.

Be concrete: name who does each step, how, and how long it takes. Say why a complex part is complex. Do not pad a simple part. Name open questions. Follow `unslop`.
