import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { newFaux, openTestMochi } from "../../test-support.ts";
import { DreamDoc } from "../dream.ts";
import { readMemory } from "../memory.ts";

const dir = process.argv[2]!;
const point = process.argv[3]!;
const faux = newFaux();
faux.setResponses([fauxAssistantMessage("[]")]);
const skew = Date.parse(point === "expired-recover" ? "2026-10-05T04:00:01Z" : point === "recover" ? "2026-10-05T03:30:01Z" : "2026-10-05T03:29:59Z") - Date.now();
const mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, {
	memory: { repo: join(dir, "memory"), dreaming: { enabled: true, cron: "30 3 * * *", tz: "UTC" } }, now: () => new Date(Date.now() + skew),
});
if (point === "expired-proposal") {
	const source = await mochi.harness.commit((tx) => tx.appendEntry(mochi.root.id, { kind: "test.source", model: [{ role: "user", content: "The dog is Biscuit.", timestamp: Date.now() + skew }] }), context);
	faux.setResponses([fauxAssistantMessage(JSON.stringify([{ kind: "put", note: { slug: "dog", kind: "fact", subject: "Dog", body: "The dog is Biscuit." }, evidence: [{ conversation: source.conversationId, entry: source.id, text: "The dog is Biscuit." }] }]))]);
}
if (point !== "recover" && point !== "expired-recover") mochi.harness.subscribeCommits(({ changes }) => {
	for (const change of changes) {
		if (point === "submission" && change.type === "submission" && change.value.requestId?.startsWith("dream:")) process.kill(process.pid, "SIGKILL");
		if ((point === "proposal" || point === "expired-proposal") && change.type === "task" && change.value.kind === "mochi.dream" && change.value.state.checkpoint !== undefined && typeof change.value.state.checkpoint === "object" && change.value.state.checkpoint !== null && !Array.isArray(change.value.state.checkpoint) && change.value.state.checkpoint.phase === "apply") process.kill(process.pid, "SIGKILL");
	}
});
mochi.harness.resume();
for (let i = 0; i < 1000; i++) {
	const owner = await mochi.harness.snapshot(DreamDoc, context);
	if (owner?.last !== null && owner?.last !== undefined) {
		const memory = await readMemory(mochi.harness, context);
		const root = (await mochi.root.entries({}, 50, undefined, context)).items;
		await mochi.close();
		process.stdout.write(JSON.stringify({ last: owner.last.result, notes: Object.keys(memory.notes).length, rootTurns: root.filter((entry) => entry.kind === "pi.assistant").length }) + "\n");
		process.exit(0);
	}
	await sleep(10);
}
throw new Error("Dream did not settle");
