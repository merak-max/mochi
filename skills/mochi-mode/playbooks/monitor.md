# Monitor

**You own a watch that speaks only when it matters.**

1. Define the signal: the event or condition, where to check it, when the owner wants to hear, and when they don't.
2. Pick the trigger. Use `cron` for polling, at the slowest interval that still catches the event in time. Use `once` for a reminder or a single later check. Use `webhook` when the source can push. `trigger_add` returns the URL and secret the sender needs.
3. Write the trigger prompt for a cold reader, because the run sees none of this conversation. Say what to check and how, what state was last reported (or tell it to read its earlier runs), when to call `notify` and what to say, and to finish silently otherwise. Silence is the normal result.
4. Gate the noise. Add `notifyWhen`, and `admitWhen` for a webhook, as a yes/no question. Try the gate on two or three sample payloads with `classify` before `trigger_add`.
5. Make runs converge. Each run compares against what earlier runs reported and never notifies the same thing twice. A run that hits an error reports it once, not on every fire.
6. Verify. `trigger_list` shows the trigger and its next fire time. Send a test delivery to a webhook. For a `cron`, add a `once` trigger a minute out with the same prompt and read the run.
7. Give it an end. The run removes its own trigger with `trigger_remove` once the condition is met, or the prompt names an end date.

**Reply:** what is watched, how often, when the owner will hear, the trigger id to stop it, and the test run's result.
