import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { readMemory } from "../memory/memory.ts";
import { newFaux, openTestMochi, tempDir } from "../test-support.ts";
import { messageText } from "../text.ts";
import { due, SETTLE_AFTER_MS, SETTLE_MIN_TOKENS } from "./settle.ts";

const CACHE = 300_000;

test("a thread is compacted once it has been quiet past the settle time but before its cache expires, and only when it is large and idle", () => {
	const check = (quietMs: number, tokens: number, busy = false, settled?: number) => {
		return due({ conversation: ROOT_CONVERSATION_ID, lastAt: 1_000_000, tokens, busy }, settled, 1_000_000 + quietMs, CACHE);
	};
	assert.equal(check(SETTLE_AFTER_MS, SETTLE_MIN_TOKENS), true);
	assert.equal(check(SETTLE_AFTER_MS - 1, SETTLE_MIN_TOKENS), false, "still in conversation");
	assert.equal(check(CACHE, SETTLE_MIN_TOKENS), false, "the cache is already cold");
	assert.equal(check(SETTLE_AFTER_MS, SETTLE_MIN_TOKENS - 1), false, "small enough to rewrite");
	assert.equal(check(SETTLE_AFTER_MS, SETTLE_MIN_TOKENS, true), false, "a run is going");
	assert.equal(check(SETTLE_AFTER_MS, SETTLE_MIN_TOKENS, false, 1_000_000), false, "already compacted after this turn");
});

test("the daemon compacts a large root thread that went quiet, once, with the fast summary", async () => {
	const faux = newFaux();
	const long = "x".repeat(40_000);
	faux.setResponses([fauxAssistantMessage(`One. ${long}`), fauxAssistantMessage(`Two. ${long}`), fauxAssistantMessage("Three."), fauxAssistantMessage("## Goal\nChat.")]);
	let skew = 0;
	const now = () => new Date(Date.now() + skew);
	const logs: string[] = [];
	const mochi = await openTestMochi(await tempDir(), faux, undefined, undefined, [], { now, settleLookMs: 50, settleMinTokens: 1, memory: { reflect: false }, log: (event) => logs.push(event) });
	for (const text of ["one", "two", "three"]) await (await mochi.root.submit({ type: "input", content: text }, context)).wait(context);
	mochi.harness.resume();
	skew = SETTLE_AFTER_MS + 1_000;
	for (let i = 0; i < 300 && !logs.includes("thread.settled"); i++) await sleep(20);
	for (let i = 0; i < 100; i++) {
		if ((await mochi.root.entries({}, 30, undefined, context)).items.some((entry) => entry.kind === "pi.compaction")) break;
		await sleep(20);
	}
	await sleep(200);
	assert.equal(logs.filter((event) => event === "thread.settled").length, 1, "compacted once per quiet spell");
	assert.ok((await mochi.root.entries({}, 30, undefined, context)).items.some((entry) => entry.kind === "pi.compaction"), "a pi.compaction entry is placed");
	await mochi.close();
});

test("before root is compacted, a fork of it saves what it knows with note, once per quiet spell", async () => {
	const faux = newFaux();
	let reflectSaw: string[] = [];
	faux.setResponses([
		fauxAssistantMessage("Got it, Biscuit."),
		(transcript) => {
			reflectSaw = transcript.messages.map((message) => messageText(message));
			return fauxAssistantMessage(fauxToolCall("codemode", { code: `return await tools.note({ slug: "dog", kind: "fact", subject: "Dog", body: "The owner's dog is Biscuit." })` }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Saved dog."),
		fauxAssistantMessage("## Goal\nChat."),
	]);
	let skew = 0;
	const now = () => new Date(Date.now() + skew);
	const logs: string[] = [];
	const mochi = await openTestMochi(await tempDir(), faux, undefined, undefined, [], { now, settleLookMs: 50, settleMinTokens: 1, log: (event) => logs.push(event) });
	await (await mochi.root.submit({ type: "input", content: "My dog is called Biscuit." }, context)).wait(context);
	mochi.harness.resume();
	skew = SETTLE_AFTER_MS + 1_000;
	for (let i = 0; i < 300 && (await readMemory(mochi.harness, context)).notes.dog === undefined; i++) await sleep(20);
	for (let i = 0; i < 300 && !logs.includes("thread.settled"); i++) await sleep(20);
	await sleep(200);
	assert.equal((await readMemory(mochi.harness, context)).notes.dog?.body, "The owner's dog is Biscuit.");
	assert.ok(reflectSaw.includes("My dog is called Biscuit."), "the fork sees root's history");
	assert.match(reflectSaw.at(-1)!, /about to be compacted/);
	assert.deepEqual(logs.filter((event) => event === "thread.reflect" || event === "thread.settled"), ["thread.reflect", "thread.settled"]);
	const rootKinds = (await mochi.root.entries({}, 30, undefined, context)).items.map((entry) => entry.kind);
	assert.equal(rootKinds.filter((kind) => kind === "pi.assistant").length, 1, "nothing of the fork lands in root");
	await mochi.close();
});
