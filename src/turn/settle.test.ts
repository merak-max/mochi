import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { newFaux, openTestMochi, tempDir } from "../test-support.ts";
import { due, SETTLE_AFTER_MS, SETTLE_MIN_TOKENS } from "./settle.ts";

const CACHE = 300_000;
const thread = (quietMs: number, tokens: number, busy = false) => ({ conversation: ROOT_CONVERSATION_ID, lastAt: 1_000_000, tokens, busy, now: 1_000_000 + quietMs });

test("a thread is compacted once it has been quiet past the settle time but before its cache expires, and only when it is large and idle", () => {
	const check = (quietMs: number, tokens: number, busy = false, settled?: number) => {
		const { now, ...rest } = thread(quietMs, tokens, busy);
		return due(rest, settled, now, CACHE);
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
	const mochi = await openTestMochi(await tempDir(), faux, undefined, undefined, [], { now, settleLookMs: 50, settleMinTokens: 1, log: (event) => logs.push(event) });
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
