---
name: reflect
description: "Turn a finished conversation or run into concrete fixes: a memory line, trigger or skill edit. For \"reflect\" or repeats."
---

# Reflect

Mine a conversation for lessons that will change what mochi does next time, then route each to a concrete edit.

Skip it when the conversation was trivial or went as the skills already say. A one-off is not a lesson.

## 1. Gather the transcript

Pin the conversation or run under review: the root conversation's recent turns, a trigger's run history, or a fork's or profile's work. Pull it with `recall`, then read around each hit with its `entry`. When it is long, have a fork write a digest of the turns, tool calls, corrections and outcomes, with entry ids.

## 2. Review from three angles

Start three reviewers in one `fork({ briefs: [...] })` call, each brief with the digest or the entry range and its prompt:

| Lens | Prompt |
|---|---|
| Judgment | [references/judgment-reviewer.md](references/judgment-reviewer.md) |
| Tooling | [references/tooling-reviewer.md](references/tooling-reviewer.md) |
| Blind spots | [references/divergent-reviewer.md](references/divergent-reviewer.md) |

Reviewers only read. They return findings.

## 3. Synthesize

Weigh the three outputs per [references/synthesizer.md](references/synthesizer.md), yourself or in one fork. The result is an Accepted, Rejected and Backlog list.

## 4. Prefer mechanisms

Move each Accepted item that a mechanism could enforce better than prose to that mechanism: a classify step in the trigger's `steps` instead of "don't over-notify", a trigger instead of "remember to check", a memory line from `note` instead of a repeated correction.

## 5. Apply

- Memory lines, trigger fixes and classify steps are reversible. Apply them and report them.
- Edits to skills change every future run. Show the proposed edits and apply the ones the owner approves.
- Changes to mochi's code or config are the owner's. Put them in the reply as proposals.

**Reply:** what was applied (one line each, with the memory line, trigger id or skill), what awaits approval, and what was dropped and why.
