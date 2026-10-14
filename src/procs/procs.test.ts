import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { messageText } from "../text.ts";
import { ingest } from "../turn/turn.ts";
import { newFaux, openTestMochi, recordingChannel, tempDir, type TestMochi, turnsSettled } from "../test-support.ts";

const DEMO = "sh -c 'echo ready; sleep 0.2; exit 3'";

function scripted(code: string) {
	const faux = newFaux();
	const results: string[] = [];
	const step = (transcript: TranscriptContext) => {
		const last = transcript.messages.findLast((message) => message.role !== "system")!;
		if (last.role === "toolResult") {
			results.push(messageText(last));
			return fauxAssistantMessage("started");
		}
		if (messageText(last).split("\n").at(-1) === "go") return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 20 }, () => step));
	return { faux, results };
}

const userTexts = async (mochi: TestMochi): Promise<string[]> =>
	(await mochi.root.entries({}, 200, undefined, context)).items.filter((entry) => entry.kind === "pi.user").map((entry) => messageText(entry.model![0]!)).reverse();

const wakes = async (mochi: TestMochi): Promise<string[]> => (await userTexts(mochi)).filter((text) => text.startsWith("[process "));

async function watchersDone(mochi: TestMochi): Promise<void> {
	const tasks = (await mochi.harness.commit((tx) => tx.scanTasks({ kind: "mochi.proc" }, 64), context)).items;
	for (const task of tasks) await mochi.harness.waitForTask(task.id, context);
}

async function rootIdle(mochi: TestMochi, inputs: number): Promise<void> {
	for (let i = 0; i < 200; i++) {
		const live = (await mochi.harness.inspect(context)).submissions.filter((submission) => submission.conversationId === mochi.root.id);
		if ((await userTexts(mochi)).length >= inputs && live.length === 0) return;
		await sleep(25);
	}
	throw new Error("root did not settle");
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("proc_start returns at once; status goes running then exited 3; logs show output; watch and exit each wake root once", async () => {
	const code = `const started = Date.now();
const proc = await tools.proc_start({ name: "demo", command: ${JSON.stringify(DEMO)}, watch: "^ready$" });
const ms = Date.now() - started;
const [row] = await tools.proc_status({ name: "demo" });
return JSON.stringify({ ms, state: row.state, pid: proc.pid });`;
	const { faux, results } = scripted(code);
	const dir = await tempDir();
	const mochi = await openTestMochi(dir, faux, new Map(), undefined, [], { procPollMs: 20 });
	await (await mochi.root.submit({ type: "input", content: "go" }, context)).wait(context);
	const started = JSON.parse(results[0]!.split("\n").at(-1)!) as { ms: number; state: string; pid: number };
	assert.equal(started.state, "running");
	assert.ok(started.ms < 1000, `proc_start took ${started.ms} ms`);

	await watchersDone(mochi);
	await rootIdle(mochi, 3);
	const woken = await wakes(mochi);
	assert.equal(woken.length, 2, JSON.stringify(woken));
	assert.equal(woken[0], "[process demo matched /^ready$/, still running]\nready");
	assert.equal(woken[1], "[process demo exited code=3]\nready");

	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code: `return JSON.stringify({ status: await tools.proc_status({}), logs: await tools.proc_logs({ name: "demo" }) });` }), { stopReason: "toolUse" }),
		fauxAssistantMessage("checked"),
	]);
	await (await mochi.root.submit({ type: "input", content: "check" }, context)).wait(context);
	const entries = (await mochi.root.entries({}, 200, undefined, context)).items.filter((entry) => entry.kind === "pi.tool-result");
	const after = JSON.parse(messageText(entries[0]!.model![0]!).split("\n").at(-1)!) as { status: { name: string; state: string; code: number }[]; logs: string };
	assert.deepEqual(after.status.map(({ name, state, code }) => ({ name, state, code })), [{ name: "demo", state: "exited", code: 3 }]);
	assert.equal(after.logs, "ready");
	assert.equal(await readFile(join(dir, "work", ".procs", "demo.exit"), "utf8"), "3\n");
	assert.ok(!alive(started.pid));
	await mochi.close();
});

test("after the owner wrote on a chat channel, an exit wake reaches them there through a Turn", async () => {
	const { faux } = scripted(`return await tools.proc_start({ name: "chat", command: "echo built; exit 0" });`);
	const whatsapp = recordingChannel("whatsapp");
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["whatsapp", whatsapp.channel]]), undefined, [], { procPollMs: 20 });
	await ingest(mochi.line, { kind: "message", channel: "whatsapp", messageId: "w1", text: "go", at: new Date("2026-10-05T08:32:00Z"), attachments: [] }, context);
	await turnsSettled(mochi.harness);
	await watchersDone(mochi);
	await turnsSettled(mochi.harness);
	assert.deepEqual(whatsapp.sent, ["started", "ok"]);
	assert.deepEqual(await wakes(mochi), ["[process chat exited code=0]\nbuilt"]);
	await mochi.close();
});

test("a watch regex wakes once even when later lines match again", async () => {
	const command = "echo ready; sleep 0.3; echo ready again; sleep 0.2; exit 0";
	const { faux } = scripted(`return await tools.proc_start({ name: "twice", command: ${JSON.stringify(command)}, watch: "ready" });`);
	const mochi = await openTestMochi(await tempDir(), faux, new Map(), undefined, [], { procPollMs: 20 });
	await (await mochi.root.submit({ type: "input", content: "go" }, context)).wait(context);
	await watchersDone(mochi);
	await rootIdle(mochi, 3);
	const woken = await wakes(mochi);
	assert.deepEqual(woken.map((text) => text.split("\n")[0]), ["[process twice matched /ready/, still running]", "[process twice exited code=0]"]);
	await mochi.close();
});

test("an exit while the daemon is down wakes root once on the next boot", async () => {
	const dir = await tempDir();
	const first = scripted(`return await tools.proc_start({ name: "late", command: "echo working; sleep 0.4; exit 5" });`);
	const mochi = await openTestMochi(dir, first.faux, new Map(), undefined, [], { procPollMs: 20 });
	await (await mochi.root.submit({ type: "input", content: "go" }, context)).wait(context);
	await mochi.close();
	await sleep(800);
	assert.equal(await readFile(join(dir, "work", ".procs", "late.exit"), "utf8"), "5\n", "the process ran to its end with no daemon");

	const second = scripted("");
	const again = await openTestMochi(dir, second.faux, new Map(), undefined, [], { procPollMs: 20 });
	again.harness.resume();
	await watchersDone(again);
	await rootIdle(again, 2);
	assert.deepEqual(await wakes(again), ["[process late exited code=5]\nworking"]);
	await again.close();

	const third = await openTestMochi(dir, scripted("").faux, new Map(), undefined, [], { procPollMs: 20 });
	third.harness.resume();
	await sleep(200);
	assert.equal((await wakes(third)).length, 1, "a later boot does not wake again");
	await third.close();
});

test("proc_stop kills the whole process group and no wake follows", async () => {
	const dir = await tempDir();
	const command = "sleep 30 & echo $! > child.pid; echo up; sleep 30";
	const { faux, results } = scripted(`await tools.proc_start({ name: "long", command: ${JSON.stringify(command)} });
return "started";`);
	const mochi = await openTestMochi(dir, faux, new Map(), undefined, [], { procPollMs: 20 });
	await (await mochi.root.submit({ type: "input", content: "go" }, context)).wait(context);
	assert.match(results[0]!, /started/);
	let childPid = "";
	for (let i = 0; i < 100 && childPid === ""; i++) {
		childPid = (await readFile(join(dir, "work", "child.pid"), "utf8").catch(() => "")).trim();
		await sleep(20);
	}
	const meta = JSON.parse(await readFile(join(dir, "work", ".procs", "long.json"), "utf8")) as { pid: number };
	assert.ok(alive(meta.pid) && alive(Number(childPid)));

	faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code: `return await tools.proc_stop({ name: "long" });` }), { stopReason: "toolUse" }), fauxAssistantMessage("stopped")]);
	await (await mochi.root.submit({ type: "input", content: "stop it" }, context)).wait(context);
	await watchersDone(mochi);
	await sleep(100);
	assert.ok(!alive(meta.pid), "the wrapper is gone");
	assert.ok(!alive(Number(childPid)), "the background child is gone");
	assert.deepEqual(await wakes(mochi), []);
	const watcher = (await mochi.harness.commit((tx) => tx.scanTasks({ kind: "mochi.proc" }, 8), context)).items[0]!;
	assert.equal(watcher.state.status === "terminal" && watcher.state.outcome.status, "aborted");
	await mochi.close();
});
