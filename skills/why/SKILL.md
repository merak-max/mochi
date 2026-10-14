---
name: why
description: Find the reasons and history behind something, with evidence and honest confidence. For "why did X happen".
---

# Why

Find what led to something, from the record, and say how sure you are. `how` explains what a thing does. `why` explains what forces shaped it.

Work as a careful investigator. Separate what the record says from what you infer, per [references/epistemics.md](references/epistemics.md).

## 1. Pin the target and the question

Name the thing (a charge, a decision, a rule, a message, an action mochi took) and the question about it. If the target is vague, take your best reading from the conversation, state it in one line, and go.

## 2. Anchor it

Collect the concrete handles before searching: dates, amounts, names, reference numbers, the exact wording of the message or rule, and the entry id of the conversation where it came up. Search `recall` first, because the owner's own chats are often the answer.

## 3. Investigate in parallel

Map the evidence to sources, one investigator per source that could hold it:

1. **Past chats and notes.** `recall`, and the notes in your prompt. What the owner said and decided, and what mochi did.
2. **Email and messages.** Through Executor apps: receipts, confirmations, notices, threads with the other party.
3. **Calendar and accounts.** Calendar entries, bank or card statements, order histories, account settings pages.
4. **The public record.** Official pages, terms, changelogs, news, status pages, through `web_search` and `web_fetch`.
5. **Files and code.** Documents in the work directory, or a repository with its history when the target is code.

Skip a source only with a written reason, for example "no bank app connected" or "the target has no public side". A skipped source is a gap in the answer, not a choice.

For a narrow question where one source already holds a direct answer, answer it yourself and say which sources you didn't search. Otherwise start the investigators in one `fork({ briefs: [...] })` call, each brief built from [references/investigator-prompt.md](references/investigator-prompt.md).

## 4. Synthesize

Weigh the findings yourself per [references/synthesizer-prompt.md](references/synthesizer-prompt.md), or hand them to one fork when they are bulky. Spot-check the citations that carry the answer. Never upgrade an inference into a fact.

## 5. Reply

Lead with the best-supported answer and its confidence, then the evidence. On a chat channel, send the short version and put the full write-up in a file. If the owner is about to act on this, end with what to keep, change or avoid.

**Reply:** the answer with its confidence tier, the evidence with links, competing explanations if any, what you don't know, and which sources you searched.
