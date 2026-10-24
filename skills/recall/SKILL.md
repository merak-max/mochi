---
name: recall
description: Use for "catch me up", before you resume work, and before you say the owner never told you something.
---

# Recall

Rebuild the recent context on a topic and hand back a short brief. Read only what the topic needs.

1. **Pin the scope.** The topic, and the window. "Recent" is the last 7 days unless the owner says otherwise. Never quietly turn "everything" into "recent".
2. **Search the record.** Run `recall` with a few phrasings: the topic, names, places, amounts. Read around the strongest chat hits with the hit's `entry`. Open a merged memory block with `zoom({ block })`. For a broad topic or a long window, give slices to forks in one `fork` call, each returning decisions, open threads and artifacts with entry ids.
3. **Check live state.** `schedule_list`, `proc_status`, the work directory (todo files, decision logs, resume notes), and the owner's apps for what changed since.
4. **Separate words from summaries.** Quote the owner's own message, with its entry id, for each decision. Label your earlier summaries as summaries.
5. **Check before you say "never".** Search the history with at least two phrasings, then memory, then the work directory. Say what you searched.

## The brief

- **Where it stands.** Five lines at most.
- **Threads.** One line each, tagged `[done]`, `[in progress]`, `[waiting on <who>]`, `[scheduled <when>]`, or `[not started]`.
- **Problems.** What went wrong or recurs, if anything.
- **Next.** The single most useful next step.

Cite entry ids or sources.

**Reply:** the brief.
