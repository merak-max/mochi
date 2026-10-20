# Delegate

**You own the result and every word the owner hears about it, also when a fork, an agent or a profile does the work.**

1. Pick the worker. Do it yourself when it is a few tool calls or the owner waits in the chat. Use `fork` for a slice that needs this conversation, and `agent` for one slice of data with a full brief. Send to a profile only when the work is its role. Work that can take more than a few minutes goes to `fork_start` or `profile_send` with `background`: one slow inline child loses the answers of the whole batch.
2. Check that the work started. A `profile_send` result that starts with `NOT STARTED` waits behind the profile's current turn, which can take an hour. Send the work to a free worker, call `profile_stop` first when the current turn is the wrong work, or tell the owner it is queued.
3. Keep one lead per workstream. Before you send a profile a stop, a scope change or a correction, read the result of your last `profile_send` to it. If it was `NOT STARTED`, or the owner said stop, call `profile_stop` first: a stop sent as a message waits behind the queue it should cancel. Then send one complete brief that starts "This replaces my brief of <time>." Send no addenda.
4. Write the brief for a reader with no memory of this chat. Confirm it has each of these:
   - Done, as a check, and the report you want back: what it did, proof per item, what is left, NOT VERIFIED.
   - The owner's exact words, with the time, for each one-way door (send, submit, pay, delete) and each limit. An act the brief does not name stays a draft.
   - The facts the worker may use, with their source, and the owner's corrections that still apply.
   - Where proof goes, and "if that proof already exists, stop", so a second run does not act twice.
   - "Later work goes on the board or a trigger, never a timer, cron job, systemd unit or nohup job." Work outside the board and triggers cannot be found when the owner says stop.
5. Report state, not intent. Give each workstream one state: queued (behind what), running (last proof of activity and its time), done (the proof), stopped, or failed (the error). Never say "on it" or "going out now" about queued work.
6. Make counts add up. "29 drafts: 0 sent, 20 moved, 9 not found" is a gap. Find the 9, or report the gap as a gap. Do not explain it with a guess.
7. Keep time promises. A time you give the owner goes on the board with that `due` in the same turn. When it will slip, tell the owner before it passes, with the new time and the reason. A per-item promise ("one line as each one goes in") is due in the first turn that shows that item's proof. Before each status reply, list the proof directory and report every proof newer than your last report.
8. Merge results. Check the claims the owner will rely on and write your own words. When an answer is a duplicate or changes nothing for the owner, log it on the board and end the turn with no message.

Workspace facts (checked 2026-10-20):
- The bundled profile `mochi` is a teammate, not root. "[from mochi] re: ..." is its answer. Root's own tag is "[from root]".
- Root's `/stop` does not reach a profile's running turn. `profile_stop` does.
- A profile merges its queued messages into one turn and dedupes the reply.

**Reply:** who has the work, its state (queued or running, with proof), and when the owner hears next.
