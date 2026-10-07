# Mechanisms, findings and what's next

This pass built the eval, the voice and two playbook changes. It deliberately did not change mochi's runtime code. The owner froze `src/` for an architect pass after this work started, so every runtime change below is a proposal with its evidence. Each entry names the pi-durable feature it uses.

## Built

| Mechanism | Where | pi-durable feature it uses |
|---|---|---|
| Exactly-once scenario reruns. Each owner message has a fixed id, so rerunning a killed scenario finds the same submission, and its Turn sends the answer once. | `eval/drive.ts` | `requestId` on `submit`, plus the `mochi.turn` task and its `mochi.claim` (the Router and `mochi.outbox` until architect U5) |
| Crash recovery under test. The eval SIGKILLs the process during a non-replay-safe `bash` call and reruns it. The model gets an `interrupted` result, checks `bookings.log`, and reports once. | `crash-errand` scenario | Tool tasks with `replay` unset, and `harness.resume()` |
| Zero-cost history. Past turns replay on a scripted model through the real Router and `notes_write`, then a `reset(handoff)`. | `eval/seed.ts` | `MemoryStorage`-style faux runs on SQLite, `reset(note)`, and `mochi.memory`, the rewindable document whose notes carry their source entry |
| Transcript dump without side effects. The dump opens a stopped data directory with an empty registry and never resumes it. | `eval/dump.ts` | `Harness.open` without `resume()`, `scanConversations`, `scanEntries` and `harness.usage()` |
| Trigger runs under test. A model-made `once` trigger fires through the real `Scheduler` into its own ownerless conversation, and `notify` decides with the live classifier gate. | `cron-silent` and `cron-notify` scenarios | `createConversation({ ownership: "ownerless" })`, the `mochi.triggers` document, `api.memo` in `notify`, and `app.notify` write entries |
| Prompt-surface meter. It prints every tool schema and section that the first request carries. | `eval/surface.ts` | The positional `pi.system` entry (`sections`, `toolsAdded`) recorded in the transcript |
| Onboarding playbook. | `skills/mochi-mode/playbooks/onboarding.md` | Notes in `mochi.memory`, and a `cron` trigger with a `notifyWhen` gate for the morning text |
| Follow-through rule: a promise needs a `once` trigger that checks before it nudges. | `skills/mochi-mode/SKILL.md`, identity section | The `mochi.triggers` document and trigger conversations, which survive restarts |

## Defects the eval found

Each defect has a transcript that reproduces it. None is fixed in `src/`, because of the freeze.

1. **A background process's promise dies with the daemon.** In `voice-v1/crash-errand`, mochi started `book.sh` with `process start` and told the owner "i'll ping when it's confirmed". The daemon was killed. The process records live only in memory, so no exit wake ever arrived, the booking never happened, and the owner never heard back. The identity section now says to promise only through a trigger, and later runs used `bash` and waited. The structural fix is for the architect pass: make a process wake a background task that survives restart, or report unfinished processes at start.
2. **The Router delivers invisible text.** In `voice-v2/chat-craft`, mochi reacted, then answered with a zero-width space. `"​".trim()` is not empty, so the Router sent a blank bubble. The identity section now says to send no text after a react, and later runs complied. The fix is one line in `#replyText`: strip format characters before the empty check.
3. **`recall` with a date-only `asOf` reads the end of that day in UTC, not in the owner's zone.** The fix needs the owner's time zone in `recallTool`, which is one more line of harness wiring. It waits for the freeze to lift.
4. **Mochi can reach anything the daemon's user can.** In the unsandboxed `voice-v5/busy-morning`, "put it on my list" led mochi to the owner's Todoist CLI token, and it created a real task. On the owner's own box, finding and using a local tool is what the no-approvals design allows. What it lacked is telling the owner where the task went and how it got there. The reply said "added ... to your todoist inbox", which is honest but says nothing about the token it read. That is a design question for the architect pass, not a guard to add here.

## Not built, and why

- **Hooks for injection defense and done-claims.** The owner ruled out guard layers. Across nine eval batches, Opus never followed the injected order. All 21 claims of an act that the hard check found had a successful acting tool behind them.
- **Errands as `defineTask` with undo.** No scenario has an errand with a real undo, such as a cancellable booking. SPEC's Later section already holds it until one exists.
- **Split bubbles.** See the decision log. A crash mid-sequence would resend earlier bubbles.
- **Learning the owner's writing voice, and teach-a-task.** The onboarding playbook writes an `owner-voice` note from sent mail when apps are connected. Executor is not connected in the eval, so that path is NOT VERIFIED.

## What to build next

1. **Wire identity v6 into `prompt.ts` once the architect pass lands, and rename its tool references to the new surface.** Every hard check passed on two runs, against 10 of 12 scenarios for the old section.
2. **Fix the three small defects above.** These are the invisible-text strip, the `asOf` zone, and a restart notice for unfinished processes. Each has a transcript that reproduces it and costs a few lines.
3. **Connect Executor in a sandboxed eval account and add an onboarding-with-apps scenario.** The "oh, it gets me" moment depends on the read-only sweep, and nothing tests it yet.
4. **Add three scenarios.** The owner says "stop the dinner thing" during an errand, the owner asks "what are you doing" while work runs (the task graph), and the owner corrects a memory ("that's wrong, riya's birthday is the 14th"). The last one exercises `snapshotAsOf` and rewind.
5. **Run each scenario three times per variant.** One run per scenario is noisy. Busy-morning chose `web_fetch` in one run and `web_search` in the next, with the same prompt.
6. **Return `control: { terminate: true }` from `notify` in trigger runs.** It skips the one model request per notifying run that only narrates what was already sent.
