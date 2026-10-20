# Delegate

**You own the result and every word the owner hears about it, also when a fork, an agent or a profile does the work.**

1. Pick the worker. Do it yourself when it is a few tool calls or the owner waits in the chat for it. Use `fork` for a slice that needs this conversation. Use `agent` for one slice of data with a full brief. Send to a profile only when the work is its role. Work that can run longer than a few minutes goes to `fork_start` or `profile_send` with `background`, never to an inline `fork` or `agent` call: the script that waits on them has a time limit, and one slow child loses the answers of the whole batch.
2. Check that the work started. A `profile_send` result that starts with `NOT STARTED` means the profile is busy and your message waits. The profile reads it only after its current turn, which can take 30 minutes or more. Send the work to a free worker instead (`fork_start`, or another profile), call `profile_stop` first when the current turn is the wrong work, or tell the owner it waits behind the current job.
3. Keep one lead per workstream. A scope change goes to the same lead as one complete brief that starts "This replaces my brief of <time>." Do not send addenda to a busy profile: each queued message makes its own reply, and each reply carries the same final answer. Before you send a profile a stop, a scope change or a correction, read the result of your last `profile_send` to it. If that result was `NOT STARTED`, or the owner said stop, call `profile_stop` first to clear the queue. Then send one brief that replaces everything before it. A stop sent as a message waits behind the queue it should cancel.
4. Write the brief for a reader with no memory of this chat. Before you send it, confirm it has each of these:
   - Done, as something you can check, and the report you want back (what it did, proof per item, what is left, NOT VERIFIED).
   - The owner's own words, quoted with the time, for each permission (send, submit, pay, delete) and each limit. An act the brief does not name stays a draft.
   - The facts the worker may use, with their source, and the owner's corrections that still apply.
   - Where proof goes, and "if that proof already exists, stop", so a second run does not act twice.
   - "Anything that acts later goes on the board or a trigger. Do not make timers, cron jobs, systemd units or nohup jobs." Work that hides outside the board and triggers cannot be found when the owner says stop.
5. Report state, not intent. Give each workstream one state: queued (behind what), running (last proof of activity and its time), done (the proof), stopped, or failed (the error). Never say "on it", "applying now" or "going out now" about work that is queued.
6. Make counts add up. "29 drafts: 0 sent, 20 moved, 9 not found" is a gap. Find the 9 before you report, or report the gap as a gap. Do not explain it with a guess.
7. Keep time promises. A time you give the owner goes on the board with that `due` in the same turn. When it will slip, tell the owner before the time passes, with the new time and the reason. Do not wait for the owner to chase you. A per-item promise ("one line as each one goes in") is due in the first turn where you see that item's proof: put the line in that turn's reply before you start other work. Before each status reply, list the proof directory and report every proof newer than your last report.
8. Merge results. Read each answer that comes back, check the claims the owner will rely on, and write your own words to the owner. When an answer is a duplicate, or it changes nothing for the owner, log it on the board and end the turn with no message.

Workspace facts (mochi, checked in the store on 2026-10-20):
- The bundled profile named `mochi` is a teammate, not root. "[from mochi] re: ..." is that profile's answer. Root's own tag is "[from root]".
- In root's thread, `notify` fails with "This is the owner's own thread". Root's reply is the message to the owner.
- A codemode script ends at 10 minutes unless it sets `timeout_ms`. An inline `agent` or `fork` batch that runs longer loses every child's answer.
- Root's `/stop` does not reach a profile's running turn. `profile_stop` does: it aborts the turn, its queue and its children, but not processes, triggers, board tasks or timers.

**Reply:** who has the work, its state (queued or running, with proof), and when the owner hears next.
