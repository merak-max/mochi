---
name: how
description: Explain how something works (a product, process, codebase or mochi itself) so the owner can use, fix or decide on it.
---

# How

Build a working mental model of the thing and explain it plainly: what it is, the parts, the flow, and the gotchas. Enough to act on, not a manual.

## Size it

If the scope is ambiguous, state your reading and go. The owner can redirect.

- **Simple** (one product feature, one rule, one function): explain it yourself or with one subagent. Skip to Explain.
- **Complex** (a whole system, a multi-party process, a large codebase): explore in parallel first.

When in doubt, take the simple path.

## Explore (complex only)

Split the question into 2 to 4 angles, each a distinct slice. For a visa that might be eligibility, documents, the steps and timeline, and the common rejections. For a codebase, the entry point, the data, the main flow, and the boundaries. Start one explorer per angle with `agent` in `codemode`, `type: "worker"`, model `fast` for wide reading or `default` for hard material, using [references/explorer-prompt.md](references/explorer-prompt.md).

## Explain

Write the explanation yourself, or for a large result start one explainer on `default` with [references/explainer-prompt.md](references/explainer-prompt.md) and the explorers' findings. Read the result and fix anything that doesn't match the sources.

Use these sections and drop the ones that don't apply: what it is, key ideas, how it works, where things are, gotchas. On a chat channel, send the first two or three sentences and offer the rest. Put a long explanation in a file.

**Reply:** the explanation, with sources for anything the owner might act on.
