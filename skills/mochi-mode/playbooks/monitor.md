# Monitor

**You own a watch that speaks only when it matters.**

1. Define the signal: the event, where to check it, and when the owner wants to hear and when not.
2. Pick the `when`. A `cron` polls, at the slowest interval that still catches the event in time. A `webhook` fits when the source can push. A single later check or reminder is an `at`.
3. Write the item's text for a cold reader, because the owner of the item gets only that text at each fire. Say what to check and how, what was last reported (or where earlier fires wrote it), when to tell the owner and what to say, and to reply NO_REPLY otherwise. Silence is the normal result. Give the item to a definition when the watch is its role; its final text goes to the owner verbatim.
4. Gate the noise with a `check` script that prints nothing when there is nothing new: empty output ends the fire before the model runs. For a definition owner, add a `gate` that judges its final text before it goes to the owner. Try the question with `classify` on two or three sample payloads first.
5. Make runs converge. Each fire compares against what earlier fires reported and never tells the owner the same thing twice. Report an error once, not on every fire.
6. Verify. `board_list` shows the item and its next fire time. For a webhook, send a test delivery to the URL `board_add` returned. For a cron, add an `at` copy one minute out, read its fire, then remove the copy with `board_done`.
7. Give it an end. The owner of the item removes it with `board_done` once the condition is met, or the text names an end date.

**Reply:** what is watched, how often, when the owner will hear, the board item id to stop it, and the test run's result.
