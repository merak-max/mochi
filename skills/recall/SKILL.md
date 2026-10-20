---
name: recall
description: Catch up on where things stand from chats, memory, triggers, the board and files. For "catch me up" and before resuming work.
---

# Recall

Rebuild the recent context on a topic and hand back a short brief. Read only what the topic needs.

1. **Pin the scope.** The topic, and the window ("recent" is the last 7 days unless the owner says otherwise). Never quietly turn "everything" into "recent".
2. **Search the record.** Run `recall` with a few phrasings: the topic, names, places, amounts. Read around the strongest chat hits with the hit's `entry`. Open a merged memory block with `zoom({ block })`. For a broad topic or a long window, give slices to forks in one `fork` call, each returning decisions, open threads and artifacts with entry ids.
3. **Check live state.** `trigger_list`, `board_list`, `proc_status`, `data/work/` (todo files, decision logs, resume notes), and the owner's apps for what changed since.
4. **Separate words from summaries.** Quote the owner's own message, with its entry id, for each decision. Label your earlier summaries as summaries.
5. **Check before you say "never".** Search the history with at least two phrasings, memory, and the work directory. Say what you searched.

## Brief

- **Where it stands.** At most five lines.
- **Threads.** One line each, tagged `[done]`, `[in progress]`, `[waiting on <who>]`, `[scheduled <when>]`, or `[not started]`.
- **Problems.** What went wrong or recurs, if anything.
- **Next.** The single most useful next step.

Cite entry ids or sources.

**Reply:** the brief.
