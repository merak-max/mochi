---
name: how
description: Explain how something works (a product, a process, a codebase, mochi itself) so the owner can use, fix or decide on it.
---

# How

Build a working mental model and explain it plainly: what it is, the parts, the flow, the gotchas. Enough to act on, not a manual. If the scope is unclear, state your reading and go.

## Size it

- **Simple** (one feature, one rule, one function): explain it yourself or with one fork. Go to Explain.
- **Complex** (a whole system, a multi-party process, a large codebase): explore in parallel first.

When in doubt, take the simple path.

## Explore (complex only)

Split the question into 2 to 4 distinct angles. For a visa: eligibility, documents, steps and timeline, common rejections. For a codebase: entry point, data, main flow, boundaries. Start one explorer per angle in one `fork({ briefs: [...] })` call, each brief built from [references/explorer-prompt.md](references/explorer-prompt.md).

## Explain

Write it yourself, or for a large result fork one explainer with [references/explainer-prompt.md](references/explainer-prompt.md) and the findings. Fix what does not match the sources.

Sections, minus the ones that do not apply: what it is, key ideas, how it works, where things are, gotchas. On a chat channel, send the first two or three sentences and offer the rest. A long explanation goes in a file.

**Reply:** the explanation, with sources for what the owner might act on.
