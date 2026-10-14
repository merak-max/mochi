import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { newFaux, openTestMochi, tempDir } from "../test-support.ts";
import { SearchIndex, toMatchExpression } from "./fts.ts";
import { indexOnce } from "../memory/feed.ts";

const context = BACKGROUND_CONTEXT;
const at = "2026-10-05T08:00:00.000Z";

test("BM25 ranks the closer match first and root above other conversations", async () => {
	const index = new SearchIndex(join(await tempDir(), "index.sqlite"));
	index.addEntries(1, [
		{ text: "We talked about the weather and also, briefly, a dentist", kind: "user", ref: "10", at },
		{ text: "Dentist appointment moved: dentist on Friday, the dentist is Dr Rao", kind: "assistant", ref: "11", at },
	], 11);
	index.addEntries(7, [{ text: "dentist dentist dentist dentist", kind: "assistant", ref: "20", at }], 20);

	const hits = index.search({ query: "dentist?", limit: 10 });
	assert.deepEqual(hits.map((hit) => hit.ref), ["11", "10", "20"]);
	assert.match(hits[0]?.snippet ?? "", /\[Dentist\]/);
	assert.equal(index.cursor(1), 11);
	assert.deepEqual(index.search({ query: "dentist", limit: 10, after: "2026-10-06" }), []);
	assert.equal(toMatchExpression("what's \"up\" OR NOT"), '"what" OR "s" OR "up" OR "OR" OR "NOT"');
	index.close();
});

test("replacing notes drops the old bodies from search", async () => {
	const index = new SearchIndex(join(await tempDir(), "index.sqlite"));
	const note = { slug: "dog", kind: "fact", subject: "dog", writtenBy: "mochi", updated: "2026-10-05", body: "Dog is Biscuit." } as const;
	index.replaceNotes([note]);
	index.replaceNotes([{ ...note, body: "Dog is Pancake." }]);
	assert.deepEqual(index.search({ query: "Biscuit", limit: 5 }), []);
	assert.equal(index.search({ query: "pancake", limit: 5 })[0]?.ref, "note:dog");
	index.close();
});

test("deleting index.sqlite and reindexing reproduces the chat index", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Noted, Biscuit the beagle.")]);
	const mochi = await openTestMochi(dir, faux);
	await (await mochi.root.submit({ type: "input", content: "My dog is called Biscuit." }, context)).wait(context);

	assert.equal(await indexOnce(mochi.harness, mochi.index, context), 2);
	assert.equal(await indexOnce(mochi.harness, mochi.index, context), 0);
	const before = mochi.index.search({ query: "biscuit", limit: 10 });
	assert.deepEqual(before.map((hit) => hit.kind).sort(), ["assistant", "user"]);
	mochi.index.close();

	await rm(join(dir, "index.sqlite"));
	const rebuilt = new SearchIndex(join(dir, "index.sqlite"));
	assert.equal(await indexOnce(mochi.harness, rebuilt, context), 2);
	assert.deepEqual(rebuilt.search({ query: "biscuit", limit: 10 }), before);
	const scroll = rebuilt.scroll(Number(before[0]?.ref), 5);
	assert.deepEqual(scroll?.map((row) => row.kind), ["user", "assistant"]);
	rebuilt.close();
	await mochi.harness.close(context);
});
