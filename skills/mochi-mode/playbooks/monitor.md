# Monitor

**You own a watch that speaks only when it matters.**

1. Define the signal: the event, where to check it, and when the owner wants to hear and when not.
2. Pick the `when`. A `cron` polls, at the slowest interval that still catches the event in time. A `webhook` fits when the source can push. A single later check or reminder is an `at`.
3. Write the schedule prompt for a cold reader, because the run sees none of this conversation. Say what to check and how, what was last reported (or to read earlier runs), when to call `notify` and what to say, and to finish silently otherwise. Silence is the normal result.
4. Gate the noise with a `check` script that prints nothing when there is nothing new, or a yes/no classify step in the schedule's `steps`. Put it before `{ model: {} }` to stop junk input before the model runs, or add `on: "output"` to judge the notify text. Try the question with `classify` on two or three sample payloads first.
5. Make runs converge. Each run compares against what earlier runs reported and never notifies the same thing twice. Report an error once, not on every fire.
6. Verify. `schedule_list` shows the schedule and its next fire time. For a webhook, send a test delivery. For a cron, add an `at` copy one minute out, read its run; it ends by itself.
7. Give it an end. The run removes its own schedule with `schedule_remove` once the condition is met, or the prompt names an end date.

**Reply:** what is watched, how often, when the owner will hear, the schedule id to stop it, and the test run's result.
