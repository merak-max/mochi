import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, SystemMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { indexOnce } from "./feed.ts";
import type { Note, NoteKind } from "../notes/schema.ts";
import { messageText } from "../text.ts";
import { newFaux, openTestMochi, type TestMochi, tempDir } from "../test-support.ts";
import { INDEX_EMPTY, MemoryDoc, OWNER_EMPTY, readMemory, writeNote } from "./memory.ts";

const context = BACKGROUND_CONTEXT;
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const note = (slug: string, kind: string, subject: string, body: string) => call("note", { slug, kind, subject, body });
const systems = (messages: readonly Message[]) => messages.filter((message): message is SystemMessage => message.role === "system");
const ask = async (mochi: TestMochi, content: string) => (await mochi.root.submit({ type: "input", content }, context)).wait(context);

async function results(mochi: TestMochi): Promise<string[]> {
	const entries = (await mochi.root.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === "pi.tool-result");
	return entries.reverse().map((entry) => messageText(entry.model![0]!));
}

test("a note write reaches the next request as one positional system patch of the owner section, indexed, with its source", async () => {
	const faux = newFaux();
	let seen: readonly Message[] = [];
	faux.setResponses([
		note("owner-name", "user", "name", "The owner is Shaurya."),
		(transcript: TranscriptContext) => {
			seen = transcript.messages;
			return fauxAssistantMessage("Saved.");
		},
	]);
	const mochi = await openTestMochi(await tempDir(), faux);
	await ask(mochi, "My name is Shaurya.");

	const [first, patch, ...more] = systems(seen);
	assert.deepEqual(more, []);
	assert.equal(first?.sections?.owner, `<owner>\n${OWNER_EMPTY}\n</owner>`);
	assert.equal(first?.sections?.["notes-index"], `<notes-index>\n${INDEX_EMPTY}\n</notes-index>`);
	assert.deepEqual(patch?.sections, { owner: "<owner>\n## name (user)\nThe owner is Shaurya.\n</owner>" });
	assert.equal(seen.indexOf(patch!), seen.findIndex((message) => message.role === "toolResult") + 1, "the patch sits right after the tool result");
	const saved = (await readMemory(mochi.harness, context)).notes["owner-name"];
	const assistant = (await mochi.root.entries({}, 50, undefined, context)).items.filter((entry) => entry.kind === "pi.assistant").at(-1);
	assert.deepEqual(saved?.source, { conversation: mochi.root.id, entry: assistant?.id });
	assert.equal(mochi.index.search({ query: "Shaurya", limit: 5 })[0]?.ref, "note:owner-name");
	await mochi.close();
});

test("owner and notes-index keep their section keys whether memory is empty or not", async () => {
	const faux = newFaux();
	const keys: string[][] = [];
	const capture = (transcript: TranscriptContext) => {
		keys.push(Object.keys(systems(transcript.messages)[0]?.sections ?? {}).sort());
		return fauxAssistantMessage("ok");
	};
	faux.setResponses([capture]);
	let mochi = await openTestMochi(await tempDir(), faux);
	await ask(mochi, "hi");
	await mochi.close();

	faux.setResponses([capture]);
	mochi = await openTestMochi(await tempDir(), faux);
	await mochi.harness.commit((tx) => writeNote(tx, { slug: "dog", kind: "fact", subject: "dog", body: "Biscuit" }, undefined, "2026-10-05"), context);
	await mochi.harness.commit((tx) => writeNote(tx, { slug: "me", kind: "user", subject: "me", body: "Shaurya" }, undefined, "2026-10-05"), context);
	await ask(mochi, "hi");
	await mochi.close();
	assert.equal(keys.length, 2);
	assert.deepEqual(keys[0], keys[1]);
	assert.ok(keys[0]?.includes("owner") && keys[0].includes("notes-index"));
});

test("an empty body forgets; recall asOf reads the earlier body; the index drops the note", async () => {
	const faux = newFaux();
	const mochi = await openTestMochi(await tempDir(), faux);
	faux.setResponses([note("dog", "fact", "dog", "Dog is Biscuit."), fauxAssistantMessage("ok")]);
	await ask(mochi, "dog is Biscuit");
	const between = new Date().toISOString();
	await new Promise((resolve) => setTimeout(resolve, 5));
	faux.setResponses([note("dog", "fact", "dog", "Dog is Pancake."), fauxAssistantMessage("ok")]);
	await ask(mochi, "no, Pancake");
	faux.setResponses([
		call("recall", { asOf: between }),
		note("dog", "fact", "dog", " "),
		note("dog", "fact", "dog", ""),
		note("cat", "fact", "cat", `The cat is Miso. ${"She sleeps on the router most afternoons. ".repeat(4)}Vet is Dr Rao.`),
		call("recall", { query: "miso" }),
		fauxAssistantMessage("done"),
	]);
	await ask(mochi, "check and forget");

	const [, , past, forgot, again, , full] = await results(mochi);
	assert.match(past ?? "", /Dog is Biscuit\./);
	assert.equal(forgot, "Forgot note dog.");
	assert.equal(again, "No note dog; nothing to forget.");
	assert.match(full ?? "", /note:cat: cat \(fact\)\nThe cat is Miso\..*Vet is Dr Rao\.$/s, "a note hit carries the whole body");
	assert.equal((await readMemory(mochi.harness, context)).notes.dog, undefined);
	assert.deepEqual(mochi.index.search({ query: "Pancake", limit: 5 }), []);
	await mochi.close();
});

test("note refuses a credential, an owner note, and user/rule notes over the cap", async () => {
	const faux = newFaux();
	faux.setResponses([
		note("deepgram", "fact", "deepgram", "Key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"),
		note("owner-rule", "rule", "tone", "Emojis are fine."),
		note("owner-rule", "rule", "tone", ""),
		note("huge", "user", "life story", "x".repeat(4000)),
		fauxAssistantMessage("Not saved."),
	]);
	const mochi = await openTestMochi(await tempDir(), faux);
	const owner: Note = { slug: "owner-rule", kind: "rule", subject: "tone", writtenBy: "owner", updated: "2026-10-01", body: "No emojis." };
	await mochi.harness.commit(async (tx) => {
		(await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID)).notes["owner-rule"] = owner;
	}, context);
	await ask(mochi, "remember stuff");

	const [secret, edit, forget, cap] = await results(mochi);
	assert.match(secret ?? "", /Store a reference instead/);
	assert.match(edit ?? "", /written by the owner/);
	assert.match(forget ?? "", /written by the owner/);
	assert.match(cap ?? "", /over the 4000 cap/);
	assert.deepEqual((await readMemory(mochi.harness, context)).notes, { "owner-rule": owner });
	await mochi.close();
});

test("writeNote validates slug, kind and subject itself, whatever the caller", async () => {
	const mochi = await openTestMochi(await tempDir(), newFaux());
	const write = (slug: string, kind: string, subject: string) =>
		mochi.harness.commit((tx) => writeNote(tx, { slug, kind: kind as NoteKind, subject, body: "b" }, undefined, "2026-10-05"), context);
	await assert.rejects(write("../escaped", "fact", "x"), /Invalid note/);
	await assert.rejects(write("ok", "diary", "x"), /Invalid note/);
	await assert.rejects(write("ok", "fact", ""), /Invalid note/);
	await write("ok", "fact", "x");
	assert.deepEqual(Object.keys((await readMemory(mochi.harness, context)).notes), ["ok"]);
	await mochi.close();
});

test("a v1 memory document with imported file hashes opens as v2 with its notes", async () => {
	const dir = await tempDir();
	const V1 = defineDoc<{ notes: Record<string, Note>; imported: Record<string, string> }>({
		kind: "mochi.memory",
		version: 1,
		scope: "conversation",
		history: "rewindable",
		fork: "current",
		initial: () => ({ notes: {}, imported: {} }),
	});
	const city: Note = { slug: "city", kind: "fact", subject: "city", writtenBy: "owner", updated: "2026-10-01", body: "Lives in Pune." };
	let mochi = await openTestMochi(dir, newFaux());
	await mochi.harness.commit(async (tx) => {
		const doc = await tx.doc(V1, ROOT_CONVERSATION_ID);
		doc.notes.city = city;
		doc.imported["city.md"] = "abc";
	}, context);
	await mochi.close();

	const faux = newFaux();
	let index = "";
	faux.setResponses([
		(transcript: TranscriptContext) => {
			index = systems(transcript.messages)[0]?.sections?.["notes-index"] ?? "";
			return fauxAssistantMessage("ok");
		},
	]);
	mochi = await openTestMochi(dir, faux);
	assert.deepEqual(await readMemory(mochi.harness, context), { notes: { city } });
	assert.equal(mochi.index.search({ query: "Pune", limit: 5 })[0]?.ref, "note:city");
	await ask(mochi, "hi");
	assert.equal(index, "<notes-index>\ncity: city (fact)\n</notes-index>");
	await mochi.close();
});

test("recall skips root entries still in context, finds them after a reset, and reads around a hit", async () => {
	const faux = newFaux();
	const mochi = await openTestMochi(await tempDir(), faux);
	const lastResult = async () => (await results(mochi)).at(-1) ?? "";
	faux.setResponses([fauxAssistantMessage("Noted, the dog is Pancake.")]);
	await ask(mochi, "My dog is called Pancake.");
	await indexOnce(mochi.harness, mochi.index, context);

	faux.setResponses([call("recall", { query: "pancake" }), fauxAssistantMessage("ok")]);
	await ask(mochi, "what is my dog called?");
	assert.equal(await lastResult(), "No matches.");

	await mochi.root.reset(undefined, context);
	faux.setResponses([call("recall", { query: "pancake" }), fauxAssistantMessage("ok")]);
	await ask(mochi, "after the reset?");
	const hit = /entry (\d+): .*\[Pancake\]/.exec(await lastResult());
	assert.ok(hit, await lastResult());

	faux.setResponses([call("recall", { entry: Number(hit[1]) }), fauxAssistantMessage("ok")]);
	await ask(mochi, "read around it");
	assert.match(await lastResult(), /--- entry \d+ user .*\nMy dog is called Pancake\.\n--- entry \d+ assistant/);
	await mochi.close();
});
