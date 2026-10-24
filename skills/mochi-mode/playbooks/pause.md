# Pause

**You own a clean stop that a later run can resume from cold.** Pause only on an explicit stop or hold. An order to keep going is not a pause.

1. Stop at a safe point. Finish or back out of the current step, and start nothing new.
   - Call `agent_stop({ name })` for each resident agent on the work.
   - Stop processes with `proc_stop` and confirm in `proc_status`.
   - A background fork of root cannot be stopped from here. List it in the resume note.
   - Leave the owner's standing schedules alone. Remove or list the schedules that belong to the paused work.
2. Find every actor on the work before you say "stopped": `schedule_list`, `proc_status`, each child you briefed, and timers outside mochi (`systemctl --user list-timers`, `crontab -l`). Block each pending act at its source. Then read the source back.
3. Read what already went out from the real record. List every item, not the first page.
4. Report each actor as stopped (with proof) or still live (with what it can still do, and when). Never say that nothing will go out until each sending path is closed.
5. Walk through no one-way door in order to pause.
6. Write `<slug>/resume.md` in the work directory: the goal, what is done and verified, the current state, the next step, and the gotchas. Point at the decision log instead of copying it.
7. Write a line in the memory files that names the work and the resume note's path.
8. Read the resume note as someone with no memory of this conversation. Fix what that reader could not resume from.

**Reply:** where things stand, what is paused (processes, forks, agents, schedules, timers), what is still live and why, where the resume note is, and the first step on resume.
