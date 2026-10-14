---
name: recall
description: Rebuild where things stand from chats, memory, triggers, the board and files. For "catch me up" and before resuming work.
---

# Recall

Rebuild the recent context on a topic and hand back a short brief of where it stands and what to do next. Read only what the topic needs, then stop.

1. **Pin the scope.** The topic if one is named, and the window ("recent" means the last 7 days unless the owner says otherwise). Never quietly turn "everything" into "recent".
2. **Search the record.** Run `recall` with a few phrasings of the topic, names, places and amounts; it returns memory lines and chat hits. Read around the strongest chat hits with `recall` and the hit's `entry`. Check the memory section of your prompt for lines on the topic, and open a merged block with `zoom({ block })`. For a broad topic or a long window, give slices to forks in one `fork` call, each returning decisions, open threads and artifacts with entry ids, so raw transcripts stay out of this conversation.
3. **Check live state.** Look at `trigger_list` for watches and reminders on the topic, `board_list` and `proc_status` for live work, `data/work/` for todo files, decision logs and resume notes, and the owner's apps (email, calendar, orders) for what changed since.
4. **Separate words from summaries.** For what the owner decided, quote their own message with its entry id. Label your own earlier summaries as summaries.
5. **Check before saying "never".** Before you tell the owner something was never discussed or saved, search the history with at least two phrasings, memory, and the work directory. Say what you searched.

## Brief

- **Where it stands.** At most five lines.
- **Threads.** One line each, tagged `[done]`, `[in progress]`, `[waiting on <who>]`, `[scheduled <when>]`, or `[not started]`.
- **Problems.** What went wrong or keeps recurring, if anything.
- **Next.** The single most useful next step.

Cite entry ids or sources. Write through `unslop`.

**Reply:** the brief.
