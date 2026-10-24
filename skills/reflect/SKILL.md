---
name: reflect
description: Use for "reflect", or the same mistake twice. Turns a finished run into a memory line, a trigger or a skill edit.
---

# Reflect

Mine a conversation for lessons that change what mochi does next time, and route each to a concrete edit. Skip a trivial conversation or one that went as the skills say. A one-off is not a lesson.

## 1. Gather the transcript

Pin the conversation or run: root's recent turns, a trigger's run history, or a fork's or profile's work. Open it with `zoom`. When it is long, have a fork write a digest of turns, tool calls, corrections and outcomes,.

## 2. Review from three angles

Start three read-only reviewers in one `agent({ jobs: [...] })` call with `fork: true` on each job, each brief with the digest or entry range and its prompt:

| Lens | Prompt |
|---|---|
| Judgment | [references/judgment-reviewer.md](references/judgment-reviewer.md) |
| Tooling | [references/tooling-reviewer.md](references/tooling-reviewer.md) |
| Blind spots | [references/divergent-reviewer.md](references/divergent-reviewer.md) |

## 3. Synthesize

Weigh the three outputs per [references/synthesizer.md](references/synthesizer.md), yourself or in one fork. The result is an Accepted, Rejected and Backlog list.

## 4. Apply

Route each Accepted item to a mechanism that enforces it (a classify step, a schedule, a line in the memory files) instead of a reminder in prose.

- Memory lines, trigger fixes and classify steps are two-way doors. Apply them and report them.
- A skill edit changes every future run. Show it and apply what the owner approves.
- A change to mochi's code or config is the owner's. Put it in the reply as a proposal.

**Reply:** what was applied (one line each, with the memory line, trigger id or skill), what awaits approval, and what was dropped and why.
