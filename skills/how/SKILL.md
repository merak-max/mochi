---
name: how
description: Use for "how does X work" (a product, a process, a codebase, mochi itself). For causes, use why.
---

# How

Build a working mental model and explain it plainly: what it is, the parts, the flow, the gotchas. Give enough to act on, not a manual. If the scope is unclear, state your reading in one line and go.

## 1. Size it

- **Simple** (one feature, one rule, one function): explain it yourself, or with one fork. Go to step 3.
- **Complex** (a whole system, a process with several parties, a large codebase): explore in parallel first.

When in doubt, take the simple path.

## 2. Explore (complex only)

Split the question into 2 to 4 distinct angles. Start one explorer per angle in one `fork({ briefs: [...] })` call, each brief built from [references/explorer-prompt.md](references/explorer-prompt.md).

| Question | Angles |
| --- | --- |
| "How does the Schengen visa work for me?" | eligibility, documents, steps and timeline, common rejections |
| "How does this repo send mail?" | entry point, data, main flow, boundaries |

## 3. Explain

Write it yourself. For a large result, fork one explainer with [references/explainer-prompt.md](references/explainer-prompt.md) and the findings, then fix what does not match the sources.

Use these sections and drop the ones that do not apply: what it is, key ideas, how it works, where things are, gotchas. On a chat channel, send the first two or three sentences and offer the rest. A long explanation goes in a file.

**Reply:** the explanation, with sources for what the owner might act on.
