# Troubleshoot

**You own the cause, not just the symptom going away.**

1. See it yourself: open the page, read the bill, check the log, run the command. Ask the owner only for what you can't reach, and name the exact thing you need, such as the error text.
2. Search `recall` for earlier occurrences and what fixed them.
3. Ask why until you reach a cause you can show. Change one thing at a time. When two fixes that share an assumption both fail, test the assumption.
4. For mochi itself, read its logs, the files under `data/`, `trigger_list` results and process output. A change to mochi's code or config is the owner's call, so report the cause with evidence and the change you propose.
5. Fix it, or give the owner the exact steps when only they can. Then confirm the symptom is gone where it first showed up.
6. Prevent the repeat with a `rule` note, a monitor trigger, or a reminder before the next expiry.

**Reply:** the cause and its evidence, what you changed, the proof it is fixed, and anything NOT VERIFIED.
