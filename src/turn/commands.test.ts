import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, ResetEntry, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSeatConversation } from "../seats.ts";
import { commandOf, commandTask, runCommand, statusText } from "./commands.ts";
import { ensureLine } from "./turn.ts";
import { fastCompletion } from "./lifecycle.ts";

const Replies = defineDoc<{ texts: string[] }>({ kind: "test.replies", version: 1, scope: "session", initial: () => ({ texts: [] }) });
const Sleeper = defineTask<null, { phase: "sleep" }, null>({
	name: "test.sleep", version: 1, initial: () => ({ phase: "sleep" }),
	phases: { sleep: async (_task, runtime, context) => { await runtime.sleep(runtime.now() + 86_400_000, context); } },
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

async function open(dir: string, options: { pauseReply?: () => void } = {}) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test", tasks: [Sleeper] }));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "db.sqlite")), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const lineId = await ensureLine(harness, context);
	const reply = defineTask<{ text: string }, { phase: "send" }, null>({
		name: "test.reply", version: 1, initial: () => ({ phase: "send" }),
		phases: { send: (task, runtime, context) => runtime.commit(async (tx) => {
			(await tx.doc(Replies)).texts.push(task.input.text);
			return { status: "terminal", outcome: { status: "completed", result: null } };
		}, context) },
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	const deps = { harness, root, lineId: () => lineId, fast: fastCompletion(models, { provider: "faux", modelId: "faux-1" }), now: () => Date.now(), timeZone: "Asia/Kolkata", channels: ["whatsapp"],
		openReply: async (tx: Tx, input: { text: string }) => {
			return tx.createTask(reply, { text: input.text }, { ownership: { kind: "conversation" }, conversationId: lineId, background: true });
		},
	};
	const task = commandTask(deps);
	const installed = options.pauseReply === undefined ? task : defineTask({ ...task.definition, phases: { ...task.definition.phases, reply: async (_task, runtime, context) => {
		options.pauseReply?.();
		await runtime.sleep(runtime.now() + 86_400_000, context);
	} } });
	registry.install(defineExtension({ name: "command", tasks: [installed, reply] }));
	return { ...deps, task, faux };
}

const temp = () => mkdtemp(join(tmpdir(), "mochi-command-"));

test("whole-text owner commands are trimmed and case-insensitive, not prefixes", () => {
	assert.equal(commandOf(" /NeW \n"), "new");
	assert.equal(commandOf("/STOP"), "stop");
	assert.equal(commandOf(" /status "), "status");
	assert.equal(commandOf("/new please"), undefined);
	assert.equal(commandOf("please /stop"), undefined);
});

test("commands dedupe across reopen and a crash after execution before opening the reply Turn", async () => {
	const dir = await temp();
	let reached!: () => void;
	const blocked = new Promise<void>((resolve) => { reached = resolve; });
	const first = await open(dir, { pauseReply: reached });
	await first.root.submit({ type: "write", entry: { kind: "old", model: [{ role: "user", content: "keep the meeting promise", timestamp: Date.now() }] } }, context);
	first.faux.setResponses([fauxAssistantMessage("meet sam tomorrow")]);
	const input = { key: "whatsapp:new1", command: "new", channel: "whatsapp" } as const;
	const pending = runCommand(first, input, context);
	void pending.catch(() => {});
	await blocked;
	await first.harness.close(context);
	const second = await open(dir);
	try {
		const result = await runCommand(second, input, context);
		assert.equal(result.text, "fresh thread. kept: meet sam tomorrow");
		const again = await runCommand(second, input, context);
		assert.deepEqual(again, result);
		await second.harness.waitForIdle(context);
		const history = await second.root.entries({}, 100, undefined, context);
		assert.equal(history.items.filter((entry) => entry.kind === ResetEntry.kind).length, 1);
		assert.equal(second.faux.state.callCount, 0);
		assert.deepEqual((await second.harness.snapshot(Replies, context))?.texts, [result.text]);
		assert.equal(history.items.filter((entry) => entry.kind === "app.notify").length, 0);
	} finally { await second.harness.close(context); }
});

test("/stop aborts root background work, not ownerless triggers or line tasks", async () => {
	const mochi = await open(await temp());
	try {
		const trigger = { id: await mochi.harness.commit((tx) => createSeatConversation(tx, "agent", { kind: "ownerless" }), context) };
		const ids = await mochi.harness.commit(async (tx) => ({
			root: await tx.createTask(Sleeper, null, { ownership: { kind: "conversation" }, conversationId: mochi.root.id, background: true }),
			trigger: await tx.createTask(Sleeper, null, { ownership: { kind: "conversation" }, conversationId: trigger.id, background: true }),
			line: await tx.createTask(Sleeper, null, { ownership: { kind: "conversation" }, conversationId: mochi.lineId(), background: true }),
		}), context);
		const stopped = await runCommand(mochi, { key: "w:s1", channel: "whatsapp", command: "stop" }, context);
		assert.equal(stopped.text, "stopped.");
		assert.equal((await mochi.harness.getTask(ids.root, context))?.state.outcome?.status, "aborted");
		assert.notEqual((await mochi.harness.getTask(ids.trigger, context))?.state.status, "terminal");
		assert.notEqual((await mochi.harness.getTask(ids.line, context))?.state.status, "terminal");
		assert.equal((await runCommand(mochi, { key: "w:s2", channel: "whatsapp", command: "stop" }, context)).text, "nothing was running.");
	} finally { await mochi.harness.close(context); }
});

test("/new keeps root background work running", async () => {
	const mochi = await open(await temp());
	try {
		const id = await mochi.harness.commit((tx) => tx.createTask(Sleeper, null, { ownership: { kind: "conversation" }, conversationId: mochi.root.id, background: true }), context);
		await runCommand(mochi, { key: "w:n0", channel: "whatsapp", command: "new" }, context);
		assert.notEqual((await mochi.harness.getTask(id, context))?.state.status, "terminal");
	} finally { await mochi.harness.close(context); }
});

test("/new starts the next request from its handoff and fallback resets without it", async () => {
	const mochi = await open(await temp());
	try {
		await mochi.root.submit({ type: "write", entry: { kind: "old", model: [{ role: "user", content: "old thread", timestamp: Date.now() }] } }, context);
		mochi.faux.setResponses([fauxAssistantMessage("pending booking"), (request) => {
			const text = JSON.stringify(request.messages);
			assert.ok(text.includes("pending booking"));
			assert.ok(!text.includes("old thread"));
			return fauxAssistantMessage("ok");
		}]);
		await runCommand(mochi, { key: "w:n1", channel: "whatsapp", command: "new" }, context);
		await (await mochi.root.submit({ type: "input", content: "continue" }, context)).wait(context);
		mochi.faux.setResponses([fauxAssistantMessage("bad", { stopReason: "error" })]);
		assert.equal((await runCommand(mochi, { key: "w:n2", channel: "whatsapp", command: "new" }, context)).text, "fresh thread.");
		assert.equal((await mochi.root.context(context)).messages.length, 0);
	} finally { await mochi.harness.close(context); }
});

test("/status is deterministic lowercase plain text with relative times and cache tokens", async () => {
	const mochi = await open(await temp());
	try {
		const answer = structuredClone(fauxAssistantMessage("done"));
		answer.usage.input = 100;
		answer.usage.cacheRead = 200;
		answer.usage.cacheWrite = 300;
		await mochi.root.submit({ type: "write", entry: { kind: ResetEntry.kind, head: "self", data: { at: Date.now() - 2 * 3_600_000 }, model: [answer] } }, context);
		const text = await statusText(mochi, context);
		assert.equal(text, text.toLowerCase());
		assert.ok(!/[\u2014*_#`]/.test(text));
		assert.equal(text.split("\n").length, 4);
		assert.match(text, /idle\. thread about 600 tokens/);
		assert.match(text, /reset 2h ago/);
		assert.match(text, /today about \$0\.00/);
		assert.match(text, /0 live triggers, no timed slot/);
		assert.match(text, /channels whatsapp/);
		assert.equal(mochi.faux.state.callCount, 0);
		const cost = structuredClone(fauxAssistantMessage("paid today"));
		cost.usage.cost.total = 1.25;
		cost.timestamp = Date.now();
		await mochi.root.submit({ type: "write", entry: { kind: "pi.assistant", model: [cost] } }, context);
		// Passive writes do not bill. The ledger is the authority for spend.
		const { UsageDoc } = await import("@earendil-works/pi-durable");
		await mochi.harness.commit(async (tx) => {
			(await tx.doc(UsageDoc, mochi.root.id)).models["faux/faux-1"] = cost.usage;
		}, context);
		assert.match(await statusText(mochi, context), /today about \$1\.25/);
	} finally { await mochi.harness.close(context); }
});
