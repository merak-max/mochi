import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, AssistantEntry, type ConversationId, ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import { NOTIFY_ENTRY, UserDoc } from "../turn/turn.ts";
import { messageText } from "../text.ts";
import { createSeatConversation } from "../seats.ts";
import { TriggersDoc } from "../upgrade.ts";
import { fixedClassify, newFaux, openTestMochi, recordingChannel, type TestMochi, tempDir, turnsSettled } from "../test-support.ts";
import { addTrigger, type LastSlot, parseSeeds, type Plan, plan, reconcileSeeds, scanTriggers, type TriggerRecord } from "./trigger.ts";
import type { Trigger } from "./types.ts";

const S = Date.parse("2026-10-05T03:30:00Z");
const MIN = 60_000;
const DAY = 1440 * MIN;
const DAILY: Trigger = { kind: "cron", id: "daily", cron: "0 9 * * *", tz: "Asia/Kolkata", prompt: "Summarize." };
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const scriptOutput = (text: string) => text.replace(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n\n/, "");
/** Runs at real speed from `at`; `set` moves it, so a slot can be placed just after a slow open. */
const clockAt = (at: number) => {
	let skew = at - Date.now();
	return Object.assign(() => new Date(Date.now() + skew), { set: (to: number) => void (skew = to - Date.now()) });
};
const add = (mochi: TestMochi, trigger: Trigger) => (mochi.harness.resume(), mochi.harness.commit(async (tx) => addTrigger(tx, mochi.trigger, { trigger, origin: "model" }, await scanTriggers(tx), mochi.catalog), context));

async function until(mochi: TestMochi, check: (task: TriggerRecord) => boolean): Promise<TriggerRecord> {
	for (;;) {
		const found = (await mochi.harness.commit((tx) => scanTriggers(tx), context)).find(check);
		if (found !== undefined) return found;
		await sleep(20);
	}
}

test("plan fires a cron slot on time or inside the grace window, misses it past the window, and always fires a once", () => {
	const once: Trigger = { kind: "once", id: "o", at: "2026-10-05T03:30:00Z", prompt: "p" };
	const gap: Trigger = { kind: "cron", id: "g", cron: "30 2 * * *", tz: "America/New_York", prompt: "p" };
	const done = (at: number): LastSlot => ({ at, result: "done" });
	const cases: [string, Trigger, LastSlot | null, number, Plan][] = [
		["new cron", DAILY, null, S - MIN, { kind: "fire", slot: S }],
		["cron at its slot", DAILY, done(S - DAY), S, { kind: "fire", slot: S }],
		["cron inside grace", DAILY, done(S - DAY), S + 14 * MIN, { kind: "fire", slot: S }],
		["cron past grace", DAILY, done(S - DAY), S + 16 * MIN, { kind: "miss", slot: S }],
		["after a miss", DAILY, { at: S, result: "missed" }, S + 16 * MIN, { kind: "fire", slot: S + DAY }],
		["days down", DAILY, done(S - 3 * DAY), S + 5 * MIN, { kind: "fire", slot: S }],
		["once early", once, null, S - DAY, { kind: "fire", slot: S }],
		["once hours late", once, null, S + DAY, { kind: "fire", slot: S }],
		["once fired", once, done(S), S + DAY, { kind: "done" }],
		["webhook", { kind: "webhook", id: "w", auth: { kind: "bearer", token: "t".repeat(16) }, prompt: "p" }, null, S, { kind: "listen" }],
		["DST gap", gap, null, Date.parse("2026-03-08T06:00:00Z"), { kind: "fire", slot: Date.parse("2026-03-09T06:30:00Z") }],
	];
	for (const [name, trigger, last, now, expected] of cases) assert.deepEqual(plan(trigger, last, now), expected, name);
});

const RESTART = join(import.meta.dirname, "fixtures", "restart.ts");
const LIVES = [
	{ name: "a restart mid-sleep fires the slot once", first: S - 8000, kill: "sleeping", second: S - 3000, last: "done", inputs: 1 },
	{ name: "a restart after the submission submits nothing new", first: S - 1000, kill: "submitted", second: S + 2000, last: "done", inputs: 1 },
	{ name: "a slot missed while down fires inside the grace window", first: S - 60 * MIN, kill: "sleeping", second: S + 5 * MIN, last: "done", inputs: 1 },
	{ name: "a slot missed past the grace window is recorded missed", first: S - 60 * MIN, kill: "sleeping", second: S + 20 * MIN, last: "missed", inputs: 0 },
];
for (const { name, first, kill, second, last, inputs } of LIVES) {
	test(`${name} (SIGKILL)`, async () => {
		const dir = await tempDir();
		const life = (clock: number, point: string) => spawnSync(process.execPath, [RESTART, dir, new Date(clock).toISOString(), point], { encoding: "utf8", timeout: 50_000 });
		assert.equal(life(first, kill).signal, "SIGKILL");
		const end = life(second, "none");
		assert.equal(end.status, 0, end.stderr);
		assert.deepEqual(JSON.parse(end.stdout.trim().split("\n").at(-1)!), { last, inputs, modelCalls: inputs });
	});
}

test("trigger_add validates and replaces by id, trigger_list shows a trigger added a moment ago, trigger_remove stops it", async () => {
	const gate = { question: "Did the run fail?", yes: "Failed", no: "Passed", threshold: 0.7 };
	const script = `const failed = (p) => p.catch((error) => error.message);
const bad = await failed(tools.trigger_add({ id: "bad", prompt: "x", when: "61 * * * *" }));
const gated = await failed(tools.trigger_add({ id: "gated", prompt: "x", when: "0 * * * *", admitWhen: ${JSON.stringify(gate)} }));
const standup = await tools.trigger_add({ id: "standup", prompt: "Plan the day.", when: "30 9 * * 1-5" });
const ci = await tools.trigger_add({ id: "ci", prompt: "CI finished.", when: "webhook", admitWhen: ${JSON.stringify(gate)} });
const listed = await tools.trigger_list({});
await tools.trigger_add({ id: "standup", prompt: "Plan the week.", when: "0 9 * * 1" });
await tools.trigger_remove({ id: "ci" });
return { bad, gated, standup, ci, listed, after: await tools.trigger_list({}) };`;
	const faux = newFaux();
	faux.setResponses([call("codemode", { code: script }), fauxAssistantMessage("done")]);
	const mochi = await openTestMochi(await tempDir(), faux, undefined, undefined, [], { now: clockAt(Date.parse("2026-10-05T03:00:00Z")) });
	await (await mochi.root.submit({ type: "input", content: "set things up" }, context)).wait(context);
	const result = (await mochi.root.entries({}, 50, undefined, context)).items.find((entry) => entry.kind === "pi.tool-result");
	const out = JSON.parse(scriptOutput(messageText(result!.model![0]!)));

	assert.match(out.bad, /minute "61"/);
	assert.match(out.gated, /admitWhen applies only to webhook triggers/);
	assert.deepEqual(out.standup, { id: "standup", next: "2026-10-05T04:00:00.000Z" });
	assert.equal(out.ci.url, "https://mochi.example/hooks/ci");
	assert.equal(out.ci.secret.length, 64);
	assert.deepEqual(out.listed, [
		{ id: "standup", when: "30 9 * * 1-5 Asia/Kolkata", origin: "model", next: "2026-10-05T04:00:00.000Z" },
		{ id: "ci", when: "webhook (hmac-sha256)", origin: "model" },
	]);
	assert.deepEqual(out.after, [{ id: "standup", when: "0 9 * * 1 Asia/Kolkata", origin: "model", next: "2026-10-05T03:30:00.000Z" }]);
	const tasks = await mochi.harness.commit((tx) => scanTriggers(tx), context);
	assert.deepEqual(tasks.map((task) => [task.input.trigger.id, task.state.status === "terminal" ? task.state.outcome.status : "live"]), [["standup", "aborted"], ["ci", "aborted"], ["standup", "live"]]);
	assert.equal(tasks[0]!.conversationId, tasks[2]!.conversationId);
	await mochi.close();
});

test("root's /stop leaves triggers live, and a run that removes its own trigger finishes its turn on root's model", async () => {
	const faux = newFaux();
	faux.setResponses([call("codemode", { code: `return await tools.trigger_remove({ id: "daily" });` }), fauxAssistantMessage("Removed myself.")]);
	const now = clockAt(S);
	const mochi = await openTestMochi(await tempDir(), faux, undefined, undefined, [], { now });
	now.set(S - 300);
	const { id } = await add(mochi, DAILY);
	await mochi.root.abort(context, { background: true });
	const after = await until(mochi, (task) => task.id === id);
	assert.ok(after.state.status !== "terminal" && !after.abortRequested);

	const task = await until(mochi, (record) => record.id === id && record.state.status === "terminal");
	assert.equal(task.state.status === "terminal" && task.state.outcome.status, "aborted");
	const conversation = (await mochi.harness.conversation(task.conversationId, context))!;
	await conversation.waitForIdle(context);
	const entries = (await conversation.entries({}, 50, undefined, context)).items;
	assert.equal(messageText(entries.find((entry) => UserEntry.is(entry))!.model![0]!), "[cron daily] Current time: 2026-10-05 09:00 IST\nSummarize.");
	assert.equal(messageText(entries.find((entry) => AssistantEntry.is(entry))!.model![0]!), "Removed myself.");
	assert.deepEqual((await conversation.agent(context)).model, (await mochi.root.agent(context)).model);
	await mochi.close();
});

test("a hung run hits its deadline, is recorded timed-out, and the next slot fires", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	const hang = async (_c: unknown, options: { signal?: AbortSignal } | undefined): Promise<AssistantMessage> =>
		new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
	faux.setResponses([hang, fauxAssistantMessage("Second slot done.")]);
	const beat: Trigger = { kind: "cron", id: "beat", cron: "* * * * *", tz: "Asia/Kolkata", prompt: "Check." };
	const now = clockAt(S);
	let mochi = await openTestMochi(dir, faux, undefined, undefined, [], { now, triggerDeadlineMs: 300 });
	now.set(S - 200);
	await add(mochi, beat);
	const timedOut = await until(mochi, (task) => task.state.checkpoint?.phase === "fire" && task.state.checkpoint.slot === S + MIN);
	assert.deepEqual(timedOut.state.checkpoint?.last, { at: S, result: "timed-out" });
	await mochi.close();

	mochi = await openTestMochi(dir, faux, undefined, undefined, [], { now: clockAt(S + MIN + 100) });
	mochi.harness.resume();
	const next = await until(mochi, (task) => task.state.checkpoint?.last?.at === S + MIN);
	assert.equal(next.state.checkpoint?.last?.result, "done");
	await mochi.close();
});

test("notifyWhen holds back a notify the classifier answers no, and passes a yes or a classifier error", async () => {
	for (const [outcome, sent] of [[0.2, []], [0.9, ["build broke"]], ["provider down", ["build broke"]]] as const) {
		const faux = newFaux();
		faux.setResponses([call("notify", { text: "build broke" }), fauxAssistantMessage("ok")]);
		const whatsapp = recordingChannel("whatsapp");
		const classify = fixedClassify(outcome);
		const logs: string[] = [];
		const now = clockAt(S);
		const mochi = await openTestMochi(await tempDir(), faux, new Map([["whatsapp", whatsapp.channel]]), classify, [], { now, log: (event) => logs.push(event) });
		now.set(S - 200);
		await add(mochi, { ...DAILY, notifyWhen: { question: "Is the build broken?", yes: "Broken", no: "Fine", threshold: 0.6 } });
		await until(mochi, (task) => task.state.checkpoint?.last?.at === S);
		await turnsSettled(mochi.harness);
		assert.deepEqual(whatsapp.sent, sent);
		assert.deepEqual(classify.calls, [{ trigger: "daily", purpose: "Summarize.", message: "build broke" }]);
		assert.equal(logs.includes("notify.filtered"), outcome === 0.2);
		assert.equal(logs.includes("notify.gate_failed_open"), typeof outcome === "string");
		await mochi.close();
	}
});

test("a trigger notifies each recipient once, on its own line, and records it in each recipient's conversation", async () => {
	const USER = { id: "user2", handle: "+918423152032", name: "Hemant Singh" };
	const faux = newFaux();
	faux.setResponses([call("notify", { text: "Rain at 6." }), fauxAssistantMessage("ok")]);
	const imessage = recordingChannel("imessage");
	const now = clockAt(S);
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["imessage", imessage.channel]]), undefined, [], { now, users: [USER] });
	now.set(S - 200);
	await add(mochi, { ...DAILY, notify: ["user1", "user2"] });
	await until(mochi, (task) => task.state.checkpoint?.last?.at === S);
	await turnsSettled(mochi.harness);
	assert.deepEqual(imessage.sentTo, [
		{ person: undefined, text: "Rain at 6." },
		{ person: USER.handle, text: "Rain at 6." },
	]);
	const records = async (id: ConversationId) => (await mochi.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 100), context)).items.filter((entry) => entry.kind === NOTIFY_ENTRY).map((entry) => messageText(entry.model![0]!));
	assert.deepEqual(await records(ROOT_CONVERSATION_ID), ["[context, no reply needed: told user1 on imessage, from trigger daily] Rain at 6."]);
	const userConversation = (await mochi.harness.snapshot(UserDoc, USER.handle, context))!.conversation!;
	assert.deepEqual(await records(userConversation), ["[context, no reply needed: told user2 on imessage, from trigger daily] Rain at 6."]);
	await mochi.close();
});

test("trigger_add takes notify ids, rejects an unknown one with the valid ids, and defaults to the owner", async () => {
	const script = `const failed = (p) => p.catch((error) => error.message);
const unknown = await failed(tools.trigger_add({ id: "a", prompt: "x", when: "0 9 * * *", notify: ["user1", "Hemant Singh"] }));
const both = await tools.trigger_add({ id: "b", prompt: "x", when: "0 9 * * *", notify: ["user1", "user2"] });
const plain = await tools.trigger_add({ id: "c", prompt: "x", when: "0 9 * * *" });
return { unknown, both, plain };`;
	const faux = newFaux();
	let system = "";
	faux.setResponses([
		(request) => {
			system = JSON.stringify(request.messages.find((message) => message.role === "system"));
			return call("codemode", { code: script });
		},
		fauxAssistantMessage("done"),
	]);
	const users = [{ id: "user2", handle: "+918423152032", name: "Hemant Singh" }];
	const mochi = await openTestMochi(await tempDir(), faux, undefined, undefined, [], { now: clockAt(Date.parse("2026-10-05T03:00:00Z")), users });
	await (await mochi.root.submit({ type: "input", content: "set things up" }, context)).wait(context);
	const result = (await mochi.root.entries({}, 50, undefined, context)).items.find((entry) => entry.kind === "pi.tool-result");
	const out = JSON.parse(scriptOutput(messageText(result!.model![0]!)));
	assert.equal(out.unknown, 'Unknown notify recipient "Hemant Singh". Valid ids: user1, user2.');
	assert.match(system, /People by id: user1: the owner; user2: Hemant Singh \(iMessage\)\./);
	const tasks = await mochi.harness.commit((tx) => scanTriggers(tx), context);
	assert.deepEqual(tasks.map((task) => [task.input.trigger.id, task.input.trigger.notify]), [["b", ["user1", "user2"]], ["c", undefined]]);
	await mochi.close();
});

test("a trigger without notify sends only to the owner", async () => {
	const faux = newFaux();
	faux.setResponses([call("notify", { text: "Rain at 6." }), fauxAssistantMessage("ok")]);
	const imessage = recordingChannel("imessage");
	const now = clockAt(S);
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["imessage", imessage.channel]]), undefined, [], { now, users: [{ id: "user2", handle: "+918423152032" }] });
	now.set(S - 200);
	await add(mochi, DAILY);
	await until(mochi, (task) => task.state.checkpoint?.last?.at === S);
	await turnsSettled(mochi.harness);
	assert.deepEqual(imessage.sentTo, [{ person: undefined, text: "Rain at 6." }]);
	await mochi.close();
});

test("seeds reconcile idempotently, keep their conversation when changed, and never touch a model trigger", async () => {
	const mochi = await openTestMochi(await tempDir(), newFaux(), undefined, undefined, [], { now: clockAt(S - DAY) });
	await add(mochi, { kind: "once", id: "mine", at: "2026-10-06T00:00:00Z", prompt: "Mine." });
	const news = parseSeeds({ triggers: [{ kind: "cron", id: "news", cron: "0 8 * * *", tz: "UTC", prompt: "Old." }] }, []);
	const live = async () => (await mochi.harness.commit((tx) => scanTriggers(tx), context)).filter((task) => task.state.status !== "terminal" && !task.abortRequested);
	await reconcileSeeds(mochi.harness, mochi.trigger, news, mochi.catalog, context);
	const first = await live();
	await reconcileSeeds(mochi.harness, mochi.trigger, news, mochi.catalog, context);
	assert.deepEqual((await live()).map((task) => task.id), first.map((task) => task.id));
	await reconcileSeeds(mochi.harness, mochi.trigger, [{ ...news[0]!, prompt: "New." }], mochi.catalog, context);
	const changed = (await live()).find((task) => task.input.trigger.id === "news")!;
	assert.equal(changed.input.trigger.prompt, "New.");
	assert.equal(changed.conversationId, first.find((task) => task.input.trigger.id === "news")!.conversationId);
	await reconcileSeeds(mochi.harness, mochi.trigger, [], mochi.catalog, context);
	assert.deepEqual((await live()).map((task) => [task.input.trigger.id, task.input.origin]), [["mine", "model"]]);
	assert.throws(() => parseSeeds({ triggers: [{ kind: "cron", id: "x", cron: "* *", tz: "UTC", prompt: "p" }] }, []), /5 fields/);
	assert.throws(() => parseSeeds({ triggers: [{ kind: "cron", id: "x", cron: "* * * * *", tz: "Mars/Base", prompt: "p" }] }, []), /time zone/);
	assert.throws(() => parseSeeds({ triggers: [{ kind: "cron", id: "x", cron: "* * * * *", tz: "UTC", prompt: "p", notify: ["user9"] }] }, []), /Unknown notify recipient/);
	await mochi.close();
});

test("the upgrade turns each live mochi.triggers item into a task with its origin and conversation, once", async () => {
	const dir = await tempDir();
	const open = (logs: unknown[]) => openTestMochi(dir, newFaux(), undefined, undefined, [], { scheduling: "local", log: (event, fields) => logs.push({ event, ...fields }) });
	let mochi = await open([]);
	const old = await mochi.harness.commit(async (tx) => {
		const conversationId = await createSeatConversation(tx, "run", { kind: "ownerless" });
		(await tx.doc(TriggersDoc, ROOT_CONVERSATION_ID)).items = {
			daily: { trigger: DAILY, origin: "model", conversationId, last: { result: "silent" } },
			news: { trigger: { ...DAILY, id: "news" }, origin: "config", conversationId: null, last: null },
			spent: { trigger: { kind: "once", id: "spent", at: "2026-10-01T00:00:00Z", prompt: "p" }, origin: "model", conversationId: null, last: { result: "silent" } },
		};
		return conversationId;
	}, context);
	await mochi.close();
	const logs: unknown[] = [];
	mochi = await open(logs);
	assert.deepEqual(logs, [{ event: "upgrade", unit: "U8", name: "triggers-to-tasks", changed: 3 }]);
	const tasks = await mochi.harness.commit((tx) => scanTriggers(tx), context);
	assert.deepEqual(tasks.map((task) => [task.input.trigger.id, task.input.origin, task.state.status]), [["daily", "model", "pending"], ["news", "config", "pending"]]);
	assert.equal(tasks[0]!.conversationId, old);
	await mochi.close();
	const again: unknown[] = [];
	await (await open(again)).close();
	assert.deepEqual(again, []);
});

test("a cron check gates the slot: empty stdout runs no model, output becomes the run's payload, and each slot checks once", async () => {
	const dir = await tempDir();
	const counter = join(dir, "check-count");
	// Prints nothing on its first call and "new mail: 1" after, counting every call in a file.
	const script = `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; [ $n -ge 2 ] && echo "new mail: 1"; true`;
	const watch: Trigger = { kind: "cron", id: "watch", cron: "* * * * *", tz: "Asia/Kolkata", prompt: "Triage this.", check: ["/bin/sh", "-c", script] };
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Checked; nothing to send.")]);
	let mochi = await openTestMochi(dir, faux, undefined, undefined, [], { now: clockAt(S - 200) });
	await add(mochi, watch);
	const quiet = await until(mochi, (task) => task.state.checkpoint?.last?.at === S);
	assert.equal(quiet.state.checkpoint?.last?.result, "quiet");
	assert.equal(faux.state.callCount, 0, "an empty check costs no model call");
	await mochi.close();

	mochi = await openTestMochi(dir, faux, undefined, undefined, [], { now: clockAt(S + MIN - 200) });
	mochi.harness.resume();
	const ran = await until(mochi, (task) => task.state.checkpoint?.last?.at === S + MIN);
	assert.equal(ran.state.checkpoint?.last?.result, "done");
	assert.equal(faux.state.callCount, 1);
	const input = (await mochi.harness.commit((tx) => tx.scanEntries({ conversationId: ran.conversationId }, 50), context)).items.flatMap((entry) => entry.model ?? []).find((message) => message.role === "user");
	assert.match(JSON.stringify(input?.content), /Triage this\.[\s\S]*check_output source=\\"watch\\"[\s\S]*new mail: 1/);
	assert.equal((await readFile(counter, "utf8")).trim(), "2", "one check per slot");
	await mochi.close();
});

test("a failing cron check skips the slot as check-failed and never reaches the model", async () => {
	const faux = newFaux();
	const mochi = await openTestMochi(await tempDir(), faux, undefined, undefined, [], { now: clockAt(S - 200) });
	await add(mochi, { kind: "cron", id: "broken", cron: "* * * * *", tz: "Asia/Kolkata", prompt: "Triage.", check: ["/bin/sh", "-c", "echo partial; exit 3"] });
	const failed = await until(mochi, (task) => task.state.checkpoint?.last?.at === S);
	assert.equal(failed.state.checkpoint?.last?.result, "check-failed");
	assert.equal(faux.state.callCount, 0);
	await mochi.close();
});

test("each run starts fresh from the last run's note, runs on its role's model and instructions, and a plain run uses fast", async () => {
	const seen: string[][] = [];
	const faux = newFaux();
	const answer = (text: string) => async (request: { messages: { role: string; content: unknown }[] }) => {
		seen.push(request.messages.map((message) => `${message.role}: ${JSON.stringify(message.content)}`));
		return fauxAssistantMessage(text);
	};
	faux.setResponses([answer("Inbox clear; told nobody."), answer("Two new bills; reported none yet.")]);
	const relay = { name: "relay", instructions: "You are relay. You own mail.", model: "sonnet" };
	const dir = await tempDir();
	let mochi = await openTestMochi(dir, faux, undefined, undefined, [relay], { now: clockAt(S - 200) });
	const sweep: Trigger = { kind: "cron", id: "sweep", cron: "* * * * *", tz: "Asia/Kolkata", prompt: "Sweep mail.", role: "relay" };
	await add(mochi, sweep);
	await until(mochi, (task) => task.state.checkpoint?.last?.at === S);
	await mochi.close();
	mochi = await openTestMochi(dir, faux, undefined, undefined, [relay], { now: clockAt(S + MIN - 200) });
	mochi.harness.resume();
	const second = await until(mochi, (task) => task.state.checkpoint?.last?.at === S + MIN);
	assert.equal(second.state.checkpoint?.last?.result, "done");
	assert.equal(seen.length, 2);
	const agent = await mochi.harness.snapshot(AgentDoc, second.conversationId, context);
	assert.match(agent?.instructions ?? "", /unattended trigger run[\s\S]*Trigger: sweep\.\n\nYou are relay\. You own mail\./);
	assert.deepEqual(agent?.model, mochi.catalog.model("sonnet"));
	const secondRun = seen[1]!.filter((line) => !line.startsWith("system:")).join("\n");
	assert.match(secondRun, /previous run of this trigger ended with:\\nInbox clear; told nobody\./);
	assert.doesNotMatch(secondRun, /assistant:/, "the second run does not resend the first run's turns");
	assert.equal((secondRun.match(/Sweep mail\./g) ?? []).length, 1);

	const { runAgent } = await import("./trigger.ts");
	const { role: _role, ...plain } = sweep;
	assert.deepEqual(runAgent(plain, mochi.catalog).agent.model, mochi.catalog.model("fast"));
	assert.throws(() => runAgent({ ...sweep, role: "nobody" }, mochi.catalog), /Unknown role "nobody"\. Use worker, relay\./);
	await mochi.close();
});
