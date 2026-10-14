import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { newFaux, openTestMochi, tempDir, type TestMochi } from "../test-support.ts";
import { messageText } from "../text.ts";
import { BoardDoc, boardBrief, dueTasks } from "./board.ts";

const script = (code: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
const lastResult = async (mochi: TestMochi) => messageText((await mochi.root.entries({}, 50, undefined, context)).items.find((entry) => entry.kind === "pi.tool-result")!.model![0]!);

test("a due task wakes once per due time, and a task with no due or a finished one never does", () => {
	const base = { title: "t", bots: ["root"], log: [] };
	const now = Date.parse("2026-10-14T12:00:00Z");
	const tasks = [
		{ ...base, id: 1, status: "open" as const, due: "2026-10-14T11:00:00Z" },
		{ ...base, id: 2, status: "open" as const, due: "2026-10-14T13:00:00Z" },
		{ ...base, id: 3, status: "open" as const },
		{ ...base, id: 4, status: "done" as const, due: "2026-10-14T11:00:00Z" },
		{ ...base, id: 5, status: "waiting" as const, due: "2026-10-14T11:00:00Z", nudged: "2026-10-14T11:00:00Z" },
		{ ...base, id: 6, status: "waiting" as const, due: "2026-10-14T11:30:00+05:30", nudged: "2026-10-14T11:00:00Z" },
	];
	assert.deepEqual(dueTasks(tasks, now).map((task) => task.id), [1, 6]);

	const due = "2026-10-14T11:00:00Z";
	const woken = Date.parse("2026-10-13T11:00:00Z");
	const stuck = { ...base, id: 7, status: "open" as const, due, nudged: due, nudgedAt: woken, wakes: 1, log: [{ at: "2026-10-13T10:00:00Z", by: "root", text: "added" }] };
	assert.deepEqual(dueTasks([stuck], now).map((task) => task.id), [7], "woken a day ago and untouched: wake again");
	assert.deepEqual(dueTasks([{ ...stuck, log: [{ at: "2026-10-13T12:00:00Z", by: "root", text: "called, no answer" }] }], now), [], "touched since: leave it");
	assert.deepEqual(dueTasks([{ ...stuck, nudgedAt: now - 1000 }], now), [], "woken a second ago");
	assert.deepEqual(dueTasks([{ ...stuck, wakes: 4 }], now), [], "past the cap");
	assert.match(boardBrief({ ...stuck, wakes: 3 }), /woken 3 times .* tell the owner/);
	const { nudged: _nudged, ...fresh } = stuck;
	assert.match(boardBrief(fresh), /^Board task #7 is due/);
});

test("board functions add, list and update tasks; a rerun of board_add does not add twice; a due without offset is refused", async () => {
	const faux = newFaux();
	faux.setResponses([
		script(`const a = await tools.board_add({ title: "Call the bank", due: "2026-10-20T10:00:00+05:30", bots: ["root", "kubera"], note: "owner asked" });
const b = await tools.board_add({ title: "Read the paper" });
await tools.board_update({ id: a.id, status: "waiting", note: "left a voicemail" });
let bad = "";
try { await tools.board_add({ title: "x", due: "tomorrow" }); } catch (e) { bad = String(e); }
return JSON.stringify({ a: a.id, b: b.id, open: (await tools.board_list({})).map((t) => [t.id, t.status]), kubera: (await tools.board_list({ bot: "kubera" })).map((t) => t.id), bad });`),
		fauxAssistantMessage("done"),
	]);
	const mochi = await openTestMochi(await tempDir(), faux);
	await (await mochi.root.submit({ type: "input", content: "go" }, context)).wait(context);
	const out = JSON.parse((await lastResult(mochi)).split("\n").at(-1)!);
	assert.deepEqual({ ...out, bad: /ISO 8601 with an offset/.test(out.bad) }, { a: 1, b: 2, open: [[2, "open"], [1, "waiting"]], kubera: [1], bad: true });
	const board = await mochi.harness.snapshot(BoardDoc, context);
	assert.deepEqual(board!.tasks["1"]!.log.map((entry) => entry.text), ["owner asked", "waiting: left a voicemail"]);
	assert.equal(board!.next, 3);
	await mochi.close();
});

test("the sweep forks root once for a due task; the fork sees root's chat and closes the task", async () => {
	const faux = newFaux();
	let forkSaw: string[] = [];
	// Each request is answered by who is asking: the fork by its brief, root by its newest owner message.
	const answer = (transcript: TranscriptContext) => {
		const texts = transcript.messages.map((message) => messageText(message));
		const after = transcript.messages.at(-1)?.role === "toolResult";
		const fork = texts.findLastIndex((text) => text.startsWith("Board task #1 is due"));
		if (fork >= 0) {
			if (!after) forkSaw = texts;
			return after ? fauxAssistantMessage("Done.") : script(`await tools.board_update({ id: 1, status: "done", note: "reminded" }); return "ok"`);
		}
		if (texts.at(-1)?.includes("Remind me to call") || texts.findLast((text) => text.startsWith("What's the bank"))) {
			const asked = texts.findLast((text) => text === "Put it on the board." || text.startsWith("What's the bank"));
			if (asked === "Put it on the board.") return after ? fauxAssistantMessage("On the board.") : script(`return (await tools.board_add({ title: "Remind the owner to call the bank", due: "2020-01-01T00:00:00Z" })).id`);
		}
		return fauxAssistantMessage("Sure, the bank's number is 1800-111.");
	};
	faux.setResponses(Array.from({ length: 12 }, () => answer));
	const logs: string[] = [];
	const mochi = await openTestMochi(await tempDir(), faux, undefined, undefined, [], { sweepEveryMs: 50, log: (event) => logs.push(event) });
	await (await mochi.root.submit({ type: "input", content: "What's the bank's number? Remind me to call." }, context)).wait(context);
	await (await mochi.root.submit({ type: "input", content: "Put it on the board." }, context)).wait(context);
	mochi.harness.resume();
	for (let i = 0; i < 300 && (await mochi.harness.snapshot(BoardDoc, context))?.tasks["1"]?.status !== "done"; i++) await sleep(20);
	await sleep(300);
	const task = (await mochi.harness.snapshot(BoardDoc, context))!.tasks["1"]!;
	assert.equal(task.status, "done");
	assert.equal(task.nudged, "2020-01-01T00:00:00Z");
	assert.ok(forkSaw.some((text) => text.includes("1800-111")), "the fork has root's context");
	assert.match(forkSaw.at(-1)!, /Board task #1 is due: Remind the owner to call the bank/);
	assert.deepEqual(logs.filter((event) => event === "board.woke"), ["board.woke"], "woken once");
	const rootAnswers = (await mochi.root.entries({}, 50, undefined, context)).items.filter((entry) => entry.kind === "pi.assistant").length;
	assert.equal(rootAnswers, 3, "the fork writes nothing into root");
	await mochi.close();
});
