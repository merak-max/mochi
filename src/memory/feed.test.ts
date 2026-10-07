import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { newFaux, openTestMochi, tempDir } from "../test-support.ts";
import { writeNote } from "./memory.ts";
import { runFeed } from "./feed.ts";

const context = BACKGROUND_CONTEXT;

test("the feed catches up on commits made while it was stopped, then indexes each new message as it commits", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Noted."), fauxAssistantMessage("Noted again.")]);
	const mochi = await openTestMochi(await tempDir(), faux);
	const found = (word: string) => mochi.index.search({ query: word, limit: 5 }).length > 0;
	const until = async (word: string, ms: number) => {
		for (const started = Date.now(); !found(word); await new Promise((resolve) => setTimeout(resolve, 5))) {
			assert.ok(Date.now() - started < ms, `${word} indexed within ${ms} ms`);
		}
	};
	await (await mochi.root.submit({ type: "input", content: "My dog is called Biscuit." }, context)).wait(context);
	assert.equal(found("biscuit"), false);

	const controller = new AbortController();
	const errors: unknown[] = [];
	const feed = runFeed(mochi.harness, mochi.index, withAbortSignal(controller.signal, context), (error) => errors.push(error));
	await until("biscuit", 1000);
	await (await mochi.root.submit({ type: "input", content: "My cat is called Pancake." }, context)).wait(context);
	await until("again", 200);

	await mochi.harness.commit((tx) => writeNote(tx, { slug: "dream-fact", kind: "fact", subject: "durable", body: "Unattended platypus fact." }, undefined, "2026-10-05"), context);
	await until("platypus", 1000);
	assert.equal(mochi.index.search({ query: "platypus", limit: 5 })[0]?.ref, "note:dream-fact");

	const stopping = Date.now();
	controller.abort();
	await feed;
	assert.ok(Date.now() - stopping < 200, "stopped without waiting for a commit");
	assert.deepEqual(errors, []);
	assert.deepEqual(mochi.index.search({ query: "noted", limit: 5 }).map((hit) => hit.kind), ["assistant", "assistant"]);
	await mochi.close();
});
