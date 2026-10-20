# Pause

**You own a clean stop that a later run can resume from cold.** Pause only on an explicit stop or hold. "Keep going" means keep going.

1. Stop at a safe point. Finish or back out of the current step and start nothing new. Call `profile_stop` for each profile on the work. Stop processes with `proc_stop` and confirm in `proc_status`. A background fork of root cannot be stopped from here, so list it in the resume note. Leave the owner's standing triggers alone. Remove or list the ones that belong to the paused work.
2. Find every actor on the work before you say "stopped": `board_list`, `trigger_list`, `proc_status`, each child you briefed, and timers outside mochi (`systemctl --user list-timers`, `crontab -l`). Block each pending act at its source (move drafts out of Drafts, remove the trigger, stop the timer). Then read the source back.
3. Read what already went out from the real record (Sent folder, form confirmations, send logs). List every item, not the first page.
4. Report each actor as stopped (with proof) or still live (with what it can still do and when). Never say "nothing will go out" until each sending path is closed.
5. Walk through no one-way door in order to pause.
6. Write `data/work/<slug>/resume.md`: the goal, what is done and verified, the current state (pending replies, open bookings, trigger ids), the next step, and the gotchas. Point at the decision log instead of copying it.
7. Save a `note` that names the work and the resume note's path, so `recall` finds it.
8. Read the resume note as someone with no memory of this conversation. Fix what they could not resume from.

**Reply:** where things stand, what is paused (processes, forks, profiles, triggers, timers), what is still live and why, where the resume note is, and the first step on resume.
