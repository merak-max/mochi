---
name: reflect
description: "Turn a finished conversation or run into concrete fixes: a memory line, trigger or skill edit. For \"reflect\" or repeats."
---

# Reflect

Mine a conversation for lessons that change what mochi does next time, and route each to a concrete edit. Skip a trivial conversation or one that went as the skills say. A one-off is not a lesson.

## 1. Gather the transcript

Pin the conversation or run: root's recent turns, a trigger's run history, or a fork's or profile's work. Pull it with `recall` and read around each hit with its `entry`. When it is long, have a fork write a digest of turns, tool calls, corrections and outcomes, with entry ids.

## 2. Review from three angles

Start three read-only reviewers in one `fork({ briefs: [...] })` call, each brief with the digest or entry range and its prompt:

| Lens | Prompt |
|---|---|
| Judgment | [references/judgment-reviewer.md](references/judgment-reviewer.md) |
| Tooling | [references/tooling-reviewer.md](references/tooling-reviewer.md) |
| Blind spots | [references/divergent-reviewer.md](references/divergent-reviewer.md) |

## 3. Synthesize

Weigh the three outputs per [references/synthesizer.md](references/synthesizer.md), yourself or in one fork. The result is an Accepted, Rejected and Backlog list.

## 4. Apply

Route each Accepted item to a mechanism where one can enforce it: a classify step instead of "don't over-notify", a trigger instead of "remember to check", a `note` instead of a repeated correction.

- Memory lines, trigger fixes and classify steps are two-way doors. Apply them and report them.
- A skill edit changes every future run. Show it and apply what the owner approves.
- A change to mochi's code or config is the owner's. Put it in the reply as a proposal.

**Reply:** what was applied (one line each, with the memory line, trigger id or skill), what awaits approval, and what was dropped and why.
