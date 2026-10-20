---
name: why
description: Find why something happened or is the way it is, with evidence and honest confidence. For "why did X happen".
---

# Why

Find what led to something, from the record, and say how sure you are. Separate what the record says from what you infer, per [references/epistemics.md](references/epistemics.md).

## 1. Pin the target

Name the thing (a charge, a decision, a rule, a message, an act of mochi) and the question about it. If it is vague, state your best reading in one line and go.

## 2. Anchor it

Collect the handles first: dates, amounts, names, reference numbers, exact wording, and the entry id where it came up. Search `recall` first: the owner's own chats are often the answer.

## 3. Investigate in parallel

One investigator per source that could hold the evidence:

1. **Past chats and memory.** What the owner said and decided, and what mochi did.
2. **Mail and messages.** Through the `apps` skill: receipts, confirmations, notices, threads.
3. **Calendar and accounts.** Calendar entries, statements, order histories, account settings.
4. **The public record.** Official pages, terms, changelogs, news, status pages.
5. **Files and code.** The work directory, or a repository with its history.

Skip a source only with a written reason, such as "no bank app connected". A skipped source is a gap in the answer.

When one source already holds a direct answer, answer yourself and say which sources you did not search. Otherwise start the investigators in one `fork({ briefs: [...] })` call, each brief built from [references/investigator-prompt.md](references/investigator-prompt.md).

## 4. Synthesize

Weigh the findings per [references/synthesizer-prompt.md](references/synthesizer-prompt.md), yourself or in one fork when they are bulky. Spot-check the citations the answer rests on. Never upgrade an inference into a fact.

## 5. Reply

Lead with the best-supported answer and its confidence, then the evidence. On a chat channel, send the short version and put the full write-up in a file. If the owner is about to act, end with what to keep, change or avoid.

**Reply:** the answer with its confidence tier, the evidence with links, competing explanations, what you do not know, and the sources you searched.
