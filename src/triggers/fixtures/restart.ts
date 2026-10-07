// One daemon life for the trigger restart test: node src/triggers/fixtures/restart.ts <dir> <clock ISO> <kill point | none>
// The clock starts at <clock> and runs at real speed. The first life adds a daily 09:00 IST trigger. A life with a kill
// point SIGKILLs itself there; the last life waits for the 09:00 slot of 2026-10-05 to settle and prints a summary.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type CommitChange, UserEntry } from "@earendil-works/pi-durable";
import { newFaux, openTestMochi } from "../../test-support.ts";
import { addTrigger, scanTriggers, type TriggerRecord } from "../trigger.ts";

const [dir, clock, kill] = process.argv.slice(2) as [string, string, string];
const SLOT = Date.parse("2026-10-05T03:30:00Z");
const skew = Date.parse(clock) - Date.now();
const faux = newFaux();
faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("Nothing new.")));

const trigger = (change: CommitChange) => (change.type === "task" && change.value.kind === "mochi.trigger" ? (change.value as unknown as TriggerRecord) : undefined);
const KILLS: Record<string, (change: CommitChange) => boolean> = {
	sleeping: (change) => trigger(change)?.state.checkpoint?.phase === "fire",
	submitted: (change) => change.type === "submission" && change.value.requestId === `cron:daily:${new Date(SLOT).toISOString()}`,
};
const mochi = await openTestMochi(dir, faux, new Map(), undefined, [], { now: () => new Date(Date.now() + skew) });
const killAt = KILLS[kill];
if (killAt !== undefined) mochi.harness.subscribeCommits(({ changes }) => void (changes.some(killAt) && process.kill(process.pid, "SIGKILL")));
mochi.harness.resume();
if (!existsSync(join(dir, "added"))) {
	writeFileSync(join(dir, "added"), "");
	const daily = { kind: "cron", id: "daily", cron: "0 9 * * *", tz: "Asia/Kolkata", prompt: "Summarize." } as const;
	await mochi.harness.commit((tx) => addTrigger(tx, mochi.trigger, { trigger: daily, origin: "model" }, []), context);
}
let task: TriggerRecord | undefined;
while (task?.state.checkpoint?.last?.at !== SLOT) {
	await sleep(20);
	[task] = await mochi.harness.commit((tx) => scanTriggers(tx), context);
}
const entries = (await (await mochi.harness.conversation(task.conversationId, context))!.entries({}, 50, undefined, context)).items;
const summary = { last: task.state.checkpoint?.last.result, inputs: entries.filter((entry) => UserEntry.is(entry)).length, modelCalls: faux.state.callCount };
await mochi.close();
process.stdout.write(`${JSON.stringify(summary)}\n`);
