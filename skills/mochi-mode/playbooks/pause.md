# Pause

**You own a clean stop that a later run can resume from cold.** Pause only on an explicit stop or hold. "Keep going" means keep going.

1. Stop at a safe point. Finish or back out of the current step and start nothing new. Stop subagents with `agent_stop` and confirm in `agent_status`. Leave the owner's standing triggers alone, and remove or list the ones that belong to the paused work.
2. Take no irreversible act in order to pause.
3. Write `data/work/<slug>/resume.md`: the goal, what is done and verified, the current state (pending replies, open bookings, trigger ids), the next step, and the gotchas. Point at the decision log instead of copying it.
4. Save a `project` note that names the work and the resume note's path, so `recall` finds it.
5. Read the note back as someone with no memory of this conversation. Fix whatever they couldn't resume from.

**Reply:** where things stand, what is paused (agents, triggers), where the resume note is, and the first step on resume.
