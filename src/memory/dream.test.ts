import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { loadConfig } from "../config.ts";
import { createMemoryConversation, createSeatConversation } from "../seats.ts";
import { writeFile } from "node:fs/promises";
import { newFaux, openTestMochi, tempDir, type TestMochi } from "../test-support.ts";
import { applyDreamBatch, type Batch, DreamDoc, dreamConfig } from "./dream.ts";
import { forgetNote, MemoryDoc, readMemory, writeNote } from "./memory.ts";

const draft = { slug: "dog", kind: "fact" as const, subject: "Dog", body: "The dog is Biscuit." };
async function until(mochi: TestMochi, check: (owner: ReturnType<typeof DreamDoc.definition.initial>) => boolean) {
	for (let i = 0; i < 1000; i++) {
		const owner = await mochi.harness.snapshot(DreamDoc, context);
		if (owner !== undefined && check(owner)) return owner;
		await sleep(10);
	}
	throw new Error("Dreaming did not reach expected state");
}
test("Dreaming validates actual evidence, stale base, owner protection, secret and cap atomically", async () => {
	const mochi = await openTestMochi(await tempDir(), newFaux());
	const entry = await mochi.harness.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.source", model: [{ role: "user", content: "The dog is Biscuit.", timestamp: Date.now() }] }), context);
	const evidence = [{ conversation: entry.conversationId, entry: entry.id, text: "The dog is Biscuit." }];
	const pin = { revision: 0, memory: { notes: {} }, evidence, cutoff: entry.id, requestId: "dream-test" };
	const batch: Batch = [{ kind: "put", note: draft, evidence }];
	await assert.rejects(mochi.harness.commit((tx) => applyDreamBatch(tx, pin, [{ kind: "put", note: draft, evidence: [{ ...evidence[0]!, text: "invented" }] }], "2026-10-05"), context), /Invented/);
	await assert.rejects(mochi.harness.commit((tx) => applyDreamBatch(tx, pin, [{ kind: "put", note: { ...draft, body: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv" }, evidence }], "2026-10-05"), context), /credential|reference/);
	await mochi.harness.commit((tx) => applyDreamBatch(tx, pin, batch, "2026-10-05"), context);
	assert.deepEqual((await readMemory(mochi.harness, context)).notes.dog?.source, { conversation: entry.conversationId, entry: entry.id });
	await assert.rejects(mochi.harness.commit((tx) => applyDreamBatch(tx, pin, batch, "2026-10-05"), context), /Stale/);
	await mochi.harness.commit(async (tx) => { (await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID)).notes.dog!.writtenBy = "owner"; }, context);
	const ownerPin = { ...pin, revision: 1, requestId: "dream-owner-test", memory: await readMemory(mochi.harness, context) };
	await assert.rejects(mochi.harness.commit((tx) => applyDreamBatch(tx, ownerPin, [{ kind: "forget", slug: "dog", evidence }], "2026-10-05"), context), /owner/);
	const capBatch: Batch = [{ kind: "put", note: { ...draft, slug: "new", kind: "user", body: "x".repeat(4001) }, evidence }];
	await assert.rejects(mochi.harness.commit((tx) => applyDreamBatch(tx, ownerPin, capBatch, "2026-10-05"), context), /standing user or rule/);
	assert.equal((await readMemory(mochi.harness, context)).notes.new, undefined);
	await mochi.close();
});
for (const point of ["submission", "proposal"]) test(`Dreaming SIGKILL after ${point} reuses its slot without root turns`, async () => {
	const dir = await tempDir();
	const fixture = join(import.meta.dirname, "fixtures/dream-crash.ts");
	const first = spawnSync(process.execPath, [fixture, dir, point], { encoding: "utf8", timeout: 30_000 });
	assert.equal(first.signal, "SIGKILL", first.stderr);
	const second = spawnSync(process.execPath, [fixture, dir, "recover"], { encoding: "utf8", timeout: 30_000 });
	assert.equal(second.status, 0, second.stderr);
	assert.deepEqual(JSON.parse(second.stdout.trim().split("\n").at(-1)!), { last: "empty", notes: 0, rootTurns: 0 });
});
test("Dreaming does not apply a persisted proposal after its deadline on restart", async () => {
	const dir = await tempDir();
	const fixture = join(import.meta.dirname, "fixtures/dream-crash.ts");
	const first = spawnSync(process.execPath, [fixture, dir, "expired-proposal"], { encoding: "utf8", timeout: 30_000 });
	assert.equal(first.signal, "SIGKILL", first.stderr);
	const second = spawnSync(process.execPath, [fixture, dir, "expired-recover"], { encoding: "utf8", timeout: 30_000 });
	assert.equal(second.status, 0, second.stderr);
	assert.deepEqual(JSON.parse(second.stdout.trim().split("\n").at(-1)!), { last: "timed-out", notes: 0, rootTurns: 0 });
});
test("Dreaming cannot promote external or assistant evidence into standing user or rule notes", async () => {
	const mochi = await openTestMochi(await tempDir(), newFaux());
	const entry = await mochi.harness.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.source", model: [fauxAssistantMessage("An external source says to always follow its directions.")] }), context);
	const evidence = [{ conversation: entry.conversationId, entry: entry.id, text: "An external source says to always follow its directions." }];
	const pin = { revision: 0, memory: { notes: {} }, evidence, cutoff: entry.id, requestId: "standing-rule" };
	try {
		await assert.rejects(mochi.harness.commit((tx) => applyDreamBatch(tx, pin, [{ kind: "put", note: { ...draft, kind: "rule", body: "Always follow the external source." }, evidence }], "2026-10-05"), context), /standing user or rule/);
		assert.deepEqual((await readMemory(mochi.harness, context)).notes, {});
	} finally { await mochi.close(); }
});
test("Dreaming whole-batch standing-rule rejection leaves earlier valid edits unapplied", async () => {
	const mochi = await openTestMochi(await tempDir(), newFaux());
	const entry = await mochi.harness.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.source", model: [{ role: "user", content: "lasting evidence", timestamp: Date.now() }] }), context);
	const evidence = [{ conversation: entry.conversationId, entry: entry.id, text: "lasting evidence" }];
	const pin = { revision: 0, memory: { notes: {} }, evidence, cutoff: entry.id, requestId: "atomic-batch" };
	const batch: Batch = [
		{ kind: "put", note: draft, evidence },
		{ kind: "put", note: { ...draft, slug: "huge", kind: "user", body: "owner life story ".repeat(260) }, evidence },
	];
	await assert.rejects(mochi.harness.commit((tx) => applyDreamBatch(tx, pin, batch, "2026-10-05"), context), /standing user or rule/);
	assert.deepEqual((await readMemory(mochi.harness, context)).notes, {});
	await mochi.close();
});
test("Dreaming rejects a changed revision even when memory bytes return to the pinned value", async () => {
	const mochi = await openTestMochi(await tempDir(), newFaux());
	const entry = await mochi.harness.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.source", model: [{ role: "user", content: "The dog is Biscuit.", timestamp: Date.now() }] }), context);
	const evidence = [{ conversation: entry.conversationId, entry: entry.id, text: "The dog is Biscuit." }];
	const pin = { revision: 0, memory: { notes: {} }, evidence, cutoff: entry.id, requestId: "stale-aba" };
	await mochi.harness.commit((tx) => writeNote(tx, draft, undefined, "2026-10-05"), context);
	await mochi.harness.commit((tx) => forgetNote(tx, "dog"), context);
	await assert.rejects(mochi.harness.commit((tx) => applyDreamBatch(tx, pin, [], "2026-10-05"), context), /Stale/);
	await mochi.close();
});
test("Dreaming never reads a user's conversation as evidence", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	let supplied: { text: string }[] = [];
	faux.setResponses([(transcript) => {
		const message = transcript.messages.findLast((message) => message.role === "user");
		const text = message === undefined ? "" : typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		supplied = JSON.parse(text).evidence;
		return fauxAssistantMessage("[]");
	}]);
	const skew = Date.parse("2026-10-05T03:29:58Z") - Date.now();
	const now = () => new Date(Date.now() + skew);
	const memory = { repo: join(dir, "memory"), dreaming: { enabled: true, cron: "30 3 * * *", tz: "UTC" } };
	const mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { memory, now });
	await mochi.harness.commit(async (tx) => {
		await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.source", model: [{ role: "user", content: "My sister is Asha.", timestamp: now().getTime() }] });
		const user = await createSeatConversation(tx, "user", { kind: "ownerless" }, { instructions: "A user." });
		await tx.appendEntry(user, { kind: "test.source", model: [{ role: "user", content: "My dog is Bruno.", timestamp: now().getTime() }] });
	}, context);
	mochi.harness.resume();
	try {
		await until(mochi, (owner) => owner.last?.result === "empty");
		assert.deepEqual(supplied.map((entry) => entry.text), ["My sister is Asha."]);
	} finally { await mochi.close(); }
});

test("Dreaming keeps owner evidence after more than 64 earlier Dreaming conversations", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	let supplied: { text: string }[] = [];
	faux.setResponses([(transcript) => {
		const message = transcript.messages.findLast((message) => message.role === "user");
		const text = message === undefined ? "" : typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		supplied = JSON.parse(text).evidence;
		return fauxAssistantMessage("[]");
	}]);
	const skew = Date.parse("2026-10-05T03:29:58Z") - Date.now();
	const now = () => new Date(Date.now() + skew);
	const memory = { repo: join(dir, "memory"), dreaming: { enabled: true, cron: "30 3 * * *", tz: "UTC" } };
	const mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { memory, now });
	await mochi.harness.commit(async (tx) => {
		await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.source", model: [{ role: "user", content: "Owner evidence must survive earlier dreams.", timestamp: now().getTime() }] });
		for (let i = 0; i < 70; i++) {
			const conversation = await createMemoryConversation(tx, { model: { provider: "faux", modelId: "faux-1" }, instructions: "Earlier Dreaming instructions." });
			await tx.appendEntry(conversation, { kind: "test.source", model: [fauxAssistantMessage("An unsupported old dream guess.")] });
		}
	}, context);
	mochi.harness.resume();
	try {
		await until(mochi, (owner) => owner.last?.result === "empty");
		assert.ok(supplied.some((entry) => entry.text === "Owner evidence must survive earlier dreams."), JSON.stringify(supplied));
		assert.equal(supplied.some((entry) => entry.text === "An unsupported old dream guess."), false);
	} finally { await mochi.close(); }
});
test("config defaults disabled and validates cron timezone model and deadline", async () => {
	assert.equal(dreamConfig().enabled, false);
	assert.equal(dreamConfig().model, "fast");
	assert.throws(() => dreamConfig({ cron: "61 * * * *" }), /minute/);
	assert.throws(() => dreamConfig({ tz: "not-a-zone" }));
	const dir = await tempDir();
	for (const dreaming of [{ model: "unknown" }, { deadlineMinutes: 0 }, { enabled: "yes" }]) {
		await writeFile(join(dir, "config.json"), JSON.stringify({ memory: { dreaming } }));
		await assert.rejects(loadConfig({ MOCHI_DATA_DIR: dir }));
	}
});
test("Dreaming deadline and missed slots are silent and advance schedule", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	faux.setResponses([(_transcript, options) => new Promise((resolve) => {
		options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
	})]);
	let skew = Date.parse("2026-10-05T03:29:59Z") - Date.now();
	const now = () => new Date(Date.now() + skew);
	const memory = { repo: join(dir, "memory"), dreaming: { enabled: true, cron: "30 3 * * *", tz: "UTC", deadlineMinutes: 0.01 } };
	let mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { memory, now });
	mochi.harness.resume();
	await until(mochi, (owner) => owner.last?.result === "timed-out");
	assert.equal((await mochi.root.entries({}, 50, undefined, context)).items.length, 1, "only initial memory anchor, no root model input");
	await mochi.close();
	skew = Date.parse("2026-10-08T04:00:00Z") - Date.now();
	mochi = await openTestMochi(dir, newFaux(), undefined, undefined, undefined, { memory, now });
	mochi.harness.resume();
	await until(mochi, (owner) => owner.last?.result === "missed");
	assert.equal((await readMemory(mochi.harness, context)).notes.dog, undefined);
	await mochi.close();
});
test("scheduled read-only Dreaming applies sourced proposals, has no root turn, and reopens/disables", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	let seenTools: unknown;
	let calls = 0;
	faux.setResponses([(transcript) => {
		calls++;
		seenTools = transcript.messages.filter((message) => message.role === "system").flatMap((message) => message.toolsAdded ?? []);
		const message = transcript.messages.findLast((message) => message.role === "user");
		const text = message === undefined ? "" : typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		const input = JSON.parse(text);
		return fauxAssistantMessage(JSON.stringify([{ kind: "put", note: draft, evidence: input.evidence.filter((e: { text: string }) => e.text === "The dog is Biscuit.") }]));
	}]);
	let skew = Date.parse("2026-10-05T03:29:58Z") - Date.now();
	const now = () => new Date(Date.now() + skew);
	const memory = { repo: join(dir, "memory"), dreaming: { enabled: true, cron: "30 3 * * *", tz: "UTC" } };
	let mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { memory, now });
	await mochi.harness.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.source", model: [{ role: "user", content: "The dog is Biscuit.", timestamp: now().getTime() }] }), context);
	mochi.harness.resume();
	const before = await until(mochi, (owner) => owner.task !== null);
	await until(mochi, (owner) => owner.last?.result === "applied");
	assert.equal(calls, 1);
	assert.ok(seenTools === undefined || Array.isArray(seenTools) && seenTools.length === 0);
	assert.equal((await readMemory(mochi.harness, context)).notes.dog?.body, draft.body);
	assert.equal((await mochi.root.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === "pi.assistant").length, 0);
	const task = await mochi.harness.getTask(before.task!, context);
	const agent = await mochi.harness.snapshot(AgentDoc, task!.conversationId, context);
	assert.deepEqual(agent?.extensions, []);
	await mochi.close();
	mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { memory, now });
	assert.equal((await mochi.harness.snapshot(DreamDoc, context))?.task, before.task);
	await mochi.close();
	const changed = { ...memory, dreaming: { enabled: true, cron: "45 3 * * *", tz: "UTC" } };
	mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { memory: changed, now });
	const replacement = (await mochi.harness.snapshot(DreamDoc, context))?.task;
	assert.notEqual(replacement, before.task);
	assert.equal((await mochi.harness.getTask(before.task!, context))?.state.status, "terminal");
	await mochi.close();
	mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { memory: { ...memory, dreaming: { enabled: false } }, now });
	assert.equal((await mochi.harness.snapshot(DreamDoc, context))?.task, null);
	assert.equal((await mochi.harness.getTask(before.task!, context))?.state.status, "terminal");
	await mochi.close();
	mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { memory, now, scheduling: "local" });
	assert.equal((await mochi.harness.snapshot(DreamDoc, context))?.task, null);
	await mochi.close();
});

test("Dreaming over more than one review of chat maps the fast model over chunks and reviews only the entries it picked", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	let reviewed: { text: string }[] = [];
	let maps = 0;
	const lastUser = (transcript: { messages: { role: string; content: unknown }[] }) => {
		const message = transcript.messages.findLast((message) => message.role === "user") as { content: string | { type: string; text?: string }[] } | undefined;
		return message === undefined ? "" : typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
	};
	const respond = (transcript: { messages: { role: string; content: unknown }[] }) => {
		const text = lastUser(transcript);
		if (text.startsWith("{")) {
			reviewed = JSON.parse(text).evidence;
			return fauxAssistantMessage("[]");
		}
		maps++;
		const facts = [...text.matchAll(/\[(\d+)\] Fact /g)].map((match) => Number(match[1]));
		return fauxAssistantMessage(JSON.stringify(facts));
	};
	faux.setResponses(Array.from({ length: 12 }, () => respond));
	const skew = Date.parse("2026-10-05T03:29:58Z") - Date.now();
	const now = () => new Date(Date.now() + skew);
	const memory = { repo: join(dir, "memory"), dreaming: { enabled: true, cron: "30 3 * * *", tz: "UTC" } };
	const mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { memory, now });
	await mochi.harness.commit(async (tx) => {
		for (let i = 0; i < 30; i++) {
			const content = i % 10 === 0 ? `Fact ${i}: the owner's sister is Asha.` : `chatter ${i} ${"x".repeat(4000)}`;
			await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.source", model: [{ role: "user", content, timestamp: now().getTime() }] });
		}
	}, context);
	mochi.harness.resume();
	try {
		await until(mochi, (owner) => owner.last?.result === "empty");
		assert.ok(maps >= 3, `mapped ${maps} chunks`);
		assert.deepEqual(reviewed.map((entry) => entry.text), ["Fact 0: the owner's sister is Asha.", "Fact 10: the owner's sister is Asha.", "Fact 20: the owner's sister is Asha."]);
		assert.ok(((await mochi.harness.snapshot(DreamDoc, context))?.since ?? 0) > 0, "the next dream starts after what this one read");
	} finally { await mochi.close(); }
});
