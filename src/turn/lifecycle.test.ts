import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, ResetEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSeatConversation } from "../seats.ts";
import { newFaux, openTestMochi, recordingChannel, tempDir } from "../test-support.ts";
import { MemoryDoc, notesExtension } from "../memory/memory.ts";
import { compactionExtension, fastCompletion, handoffTool, idleResetIfStale, SUMMARIZATION_SYSTEM_PROMPT } from "./lifecycle.ts";

async function open(dir: string, now: () => number, compact = false) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const fast = fastCompletion(models, { provider: "faux", modelId: "faux-1" });
	const registry = createRegistry();
	registry.install(notesExtension());
	registry.install(compactionExtension(fast));
	registry.install(defineExtension({ name: "handoff", tools: [handoffTool()] }));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "db.sqlite")), {
		models, registry, now,
		settings: { compaction: { enabled: compact, keepRecentTokens: 1, backgroundTokens: 0 } },
	}, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, tools: [] } });
	return { harness, root, fast, faux, registry, now };
}

test("notify terminates the run after queueing, without a narration request", async () => {
	const faux = newFaux();
	const channel = recordingChannel("whatsapp");
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["whatsapp", channel.channel]]));
	try {
		const run = await mochi.harness.commit((tx) => createSeatConversation(tx, "trigger", { kind: "ownerless" }), context);
		const conversation = await mochi.harness.conversation(run, context);
		assert.ok(conversation);
		faux.setResponses([fauxAssistantMessage(fauxToolCall("notify", { text: "build failed" }), { stopReason: "toolUse" }), fauxAssistantMessage("unneeded narration")]);
		await (await conversation.submit({ type: "input", content: "check build" }, context)).wait(context);
		assert.equal(faux.state.callCount, 1);
		await mochi.harness.waitForTask((await mochi.harness.commit((tx) => tx.scanTasks({ kind: "mochi.turn" }, 100), context)).items[0]!.id, context);
		assert.deepEqual(channel.sent, ["build failed"]);
	} finally { await mochi.close(); }
});

test("idle reset fires once across reopen, keeps notes in the prompt, and never resets recent or disabled threads", async () => {
	const dir = await tempDir();
	let now = Date.now();
	const first = await open(dir, () => now);
	await first.harness.commit(async (tx) => {
		(await tx.doc(MemoryDoc, first.root.id)).notes["owner-rule"] = { slug: "owner-rule", kind: "rule", subject: "owner rule", writtenBy: "owner", updated: "2026-10-05", body: "always keep my notes" };
	}, context);
	await first.root.submit({ type: "write", entry: { kind: "old", model: [{ role: "user", content: "old cold thread", timestamp: now - 61 * 60_000 }] } }, context);
	first.faux.setResponses([fauxAssistantMessage("pending promise")]);
	assert.equal(await idleResetIfStale({ ...first, idleResetMinutes: 60 }, first.root, "w:1", context), true);
	await first.harness.close(context);
	const second = await open(dir, () => now);
	try {
		assert.equal(await idleResetIfStale({ ...second, idleResetMinutes: 60 }, second.root, "w:1", context), true);
		assert.equal(second.faux.state.callCount, 0);
		second.faux.setResponses([(request) => {
			const text = JSON.stringify(request.messages);
			assert.ok(text.includes("always keep my notes"));
			assert.ok(text.includes("pending promise"));
			assert.ok(!text.includes("old cold thread"));
			return fauxAssistantMessage("ok", { timestamp: now });
		}]);
		await (await second.root.submit({ type: "input", content: "hi" }, context)).wait(context);
		assert.equal(await idleResetIfStale({ ...second, idleResetMinutes: 60 }, second.root, "w:2", context), false);
		now += 3_600_001;
		assert.equal(await idleResetIfStale({ ...second, idleResetMinutes: 0 }, second.root, "w:3", context), false);
		assert.equal((await second.root.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === ResetEntry.kind).length, 1);
	} finally { await second.harness.close(context); }
});

test("busy root is never idle-reset", async () => {
	const mochi = await open(await tempDir(), Date.now);
	let started!: () => void;
	const seen = new Promise<void>((resolve) => { started = resolve; });
	mochi.faux.setResponses([async (_request, options) => {
		started();
		await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
		return fauxAssistantMessage("", { stopReason: "aborted" });
	}]);
	try {
		await mochi.root.submit({ type: "write", entry: { kind: "old", model: [{ role: "user", content: "old", timestamp: Date.now() - 7_200_000 }] } }, context);
		await mochi.root.submit({ type: "input", content: "work" }, context);
		await seen;
		assert.equal(await idleResetIfStale({ ...mochi, idleResetMinutes: 60 }, mochi.root, "w:busy", context), false);
	} finally { await mochi.harness.close(context); }
});

test("beforeCompact uses the pinned prompt, memoizes the fast summary, and falls back on errors", async () => {
	const mochi = await open(await tempDir(), Date.now, true);
	try {
		const old = "old conversation ".repeat(100);
		await mochi.root.submit({ type: "write", entry: { kind: "old", model: [{ role: "user", content: old, timestamp: Date.now() }] } }, context);
		await mochi.root.submit({ type: "write", entry: { kind: "recent", model: [{ role: "user", content: "recent".repeat(100), timestamp: Date.now() }] } }, context);
		mochi.faux.setResponses([(request) => {
			const source = JSON.stringify(request.messages);
			assert.ok(source.includes(SUMMARIZATION_SYSTEM_PROMPT.replace(/\n/g, "\\n")));
			assert.ok(source.includes("## Critical Context"));
			assert.ok(source.includes("Additional focus: keep promises"));
			return fauxAssistantMessage("fast summary");
		}]);
		const id = await mochi.root.compact("keep promises", context);
		await mochi.harness.waitForTask(id, context);
		assert.ok(JSON.stringify((await mochi.root.context(context)).messages).includes("fast summary"));
		assert.equal(mochi.faux.state.callCount, 1);
		await mochi.root.submit({ type: "write", entry: { kind: "more", model: [{ role: "user", content: old, timestamp: Date.now() }] } }, context);
		mochi.faux.setResponses([fauxAssistantMessage("failed", { stopReason: "error" }), fauxAssistantMessage("built in summary")]);
		await mochi.harness.waitForTask(await mochi.root.compact(undefined, context), context);
		assert.ok(JSON.stringify((await mochi.root.context(context)).messages).includes("built in summary"));
		assert.equal(mochi.faux.state.callCount, 3);
	} finally { await mochi.harness.close(context); }
});

test("handoff queues Continue exactly once and starts its request from the note", async () => {
	const mochi = await open(await tempDir(), Date.now);
	try {
		await mochi.root.configure({ tools: [handoffTool()] }, context);
		mochi.faux.setResponses([fauxAssistantMessage(fauxToolCall("handoff", { note: "finish the booking" }), { stopReason: "toolUse" }), (request) => {
			const text = JSON.stringify(request.messages);
			assert.ok(text.includes("finish the booking"));
			assert.ok(text.includes("Continue."));
			assert.ok(!text.includes("old thread"));
			return fauxAssistantMessage("finished");
		}]);
		await (await mochi.root.submit({ type: "input", content: "old thread" }, context)).wait(context);
		await mochi.root.waitForIdle(context);
		assert.equal(mochi.faux.state.callCount, 2);
		assert.equal((await mochi.root.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === ResetEntry.kind).length, 1);
	} finally { await mochi.harness.close(context); }
});
