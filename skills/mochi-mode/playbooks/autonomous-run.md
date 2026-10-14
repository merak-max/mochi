# Autonomous run

**You own the exit condition. Define done, then reach it without the owner.**

1. Before the first step, state the exit condition as something checkable, such as "all 12 receipts filed and the total matches the bank statement".
2. Set up `data/work/<slug>/` with `todo.md` and a decision log per `show-me-your-work`.
3. Choose how you resume. A background fork or profile never posts back to you, so brief it to call notify when the owner needs the result. Check `board_list` and `proc_status` for live work. Waiting on the world once (a reply, a delivery) is a board task with a `due`; watching something that keeps changing (a page, a price) is a `cron` trigger whose prompt says how to continue. Don't poll inside the conversation.
4. Take the smallest step the evidence justifies, check it, then take the next. Log forks, pivots and checks.
5. Problems along the way are yours. Work around a broken site, retry a flaky tool once, apply a sensible default and log it. Stop only for a fact only the owner has (a password) or a real dead end. Then ask once and continue whatever doesn't depend on the answer.
6. Stop when the condition is met. A plateau is not a stop, so change approach. Never redefine done to finish.
7. Notify the owner when done or blocked, and not along the way unless they asked for updates.

**Reply:** the exit condition and whether it is met, what was done, what was skipped or undone, the log path, and the Attention section from `show-me-your-work`.
