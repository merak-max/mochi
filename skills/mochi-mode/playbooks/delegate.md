# Delegate

**You own the result and every word the owner hears about it, also when a fork or an agent does the work.**

1. Pick the worker.
   - Yourself: a few tool calls, or the owner waits in the chat.
   - `agent` with `fork: true`: a slice that needs this conversation.
   - `agent`: one slice of data with a full brief.
   - `agent` with `definition`: only when the work is that definition's role.
   - Work that can take more than a few minutes goes to `agent` with `background: true`. One slow inline child loses the answers of the whole batch.
2. Check that the work started. A job to a resident definition whose answer starts with `NOT STARTED` waits behind that agent's current turn, which can take an hour. Its real answer comes back later as a `[name]` note. Send the work to a fork or a fresh agent, call `agent_stop` first when the current turn is the wrong work, or tell the owner it is queued.
3. Keep one lead per workstream. Before you send a resident agent a stop, a scope change or a correction, read the answer to your last job to it. If that answer was `NOT STARTED`, or the owner said stop, call `agent_stop` first: a stop sent as a message waits behind the queue it should cancel. Then send one complete brief that starts "This replaces my brief of <time>." Send no addenda.
4. Write the brief for a reader with no memory of this chat. It holds each of these:
   - Done, as a check, and the report you want back: what it did, the proof per item, what is left, NOT VERIFIED.
   - The owner's exact words, with the time, for each one-way door (send, submit, pay, delete) and each limit. An act the brief does not name stays a draft.
   - The facts the worker may use, with their source, and the owner's corrections that still apply.
   - Where proof goes, and an order to stop if that proof already exists, so that a second run does not act twice.
   - An order to put later work on the board with `board_add`, never on a timer, a cron job, a systemd unit or a nohup job. The owner's stop cannot find work outside the board.
5. Report state, not intent. Give each workstream one state: queued (behind what), running (the last proof of activity and its time), done (the proof), stopped, or failed (the error). Never report queued work as started.
6. Make counts add up. When the parts do not sum to the total, find the missing items, or report the gap as a gap. Do not explain it with a guess.
7. Keep time promises.
   - A time you give the owner is a `board_add` item with that `at` in the same turn.
   - When it will slip, tell the owner before it passes, with the new time and the reason.
   - A per-item promise is due in the first turn that shows that item's proof.
   - Before each status reply, list the proof directory and report every proof newer than your last report.
8. Merge results. Check the claims the owner will rely on, and write your own words. When an answer is a duplicate or changes nothing for the owner, end the turn with no message.

Facts about this workspace (checked 2026-10-20):
- The bundled definition `mochi` is a teammate, not root. A message tagged `[from mochi]` is its answer. Root's own tag is `[from root]`, on each job that root sends to a resident definition.
- Root's `/stop` does not reach a resident agent's running turn. `agent_stop` does.
- A resident agent merges its queued jobs into one turn and sends one reply.

**Reply:** who has the work, its state (queued or running, with proof), and when the owner hears next.
