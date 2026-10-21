import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryId } from "@earendil-works/pi-durable";
import { type Known, uncovered } from "./later.ts";

const answer = 10 as EntryId;
const keyOf = (id: string) => `imessage:${id}`;

test("a newer message with no submission yet is not covered", () => {
	const known = (): Known => ({ kind: "missing" });
	assert.deepEqual(uncovered([{ id: "b", text: "and another thing" }], "a", keyOf, known, answer), ["imessage:b"]);
});

test("a newer message answered by the same run is covered", () => {
	const known = (): Known => ({ kind: "submitted", answer });
	assert.deepEqual(uncovered([{ id: "b", text: "and another thing" }], "a", keyOf, known, answer), []);
});

test("a newer message in a later run is not covered", () => {
	const known = (): Known => ({ kind: "submitted", answer: undefined });
	assert.deepEqual(uncovered([{ id: "b", text: "x" }], "a", keyOf, known, answer), ["imessage:b"]);
});

test("the turn's own message and commands are skipped", () => {
	const known = (): Known => ({ kind: "missing" });
	assert.deepEqual(uncovered([{ id: "a", text: "sup" }, { id: "c", text: "/stop" }, { id: "d", text: " /new " }], "a", keyOf, known, answer), []);
});
