# Autonomous run

**You own the exit condition. Define done, then reach it without the owner.**

1. Before the first step, write the exit condition as a check. "All 12 receipts filed and the total matches the bank statement" is a check. "Taxes sorted" is not.
2. Set up `<slug>/` in the work directory with `todo.md` and a decision log per the `show-me-your-work` skill.
3. Choose how you resume:
   - A background fork or profile reports back into this conversation. Brief it to call `notify` only when the owner must see something first.
   - A single wait on the world (a reply, a delivery) is a board task with a `due`.
   - A watch on something that changes (a page, a price) is a cron trigger whose prompt says how to continue.
4. Take the smallest step the evidence justifies, check it, then take the next. Log forks, pivots and checks.
5. Problems along the way are yours. Work around a broken site, retry a flaky tool once, and apply a sensible default and log it. Stop only at a one-way door the owner did not open, a fact only the owner has (a password), or a real dead end. Then ask once and continue what does not depend on the answer.
6. Stop when the exit condition is met. A plateau is not a stop: change the approach. Never redefine done to finish.
7. Notify the owner when done or blocked. Send no updates along the way unless the owner asked for them.

**Reply:** the exit condition and whether it is met, what was done, what was skipped or undone, the log path, and the Attention section from `show-me-your-work`.
