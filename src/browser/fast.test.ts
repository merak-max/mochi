import assert from "node:assert/strict";
import { test } from "node:test";
import { choice, noProgress } from "./fast.ts";

test("three unchanged non-wait actions stop the loop but loading waits do not", () => {
	const unchanged = { kind: "click", page_changed: false };
	assert.equal(noProgress([unchanged, unchanged]), false);
	assert.equal(noProgress([unchanged, unchanged, unchanged]), true);
	assert.equal(noProgress([unchanged, unchanged, { kind: "wait", page_changed: false }]), false);
	assert.equal(noProgress([unchanged, unchanged, { kind: "click", page_changed: true }]), false);
});

test("classifier decisions require a normalized maximum-probability offered choice", () => {
	const question = { type: "choice", instructions: "Next action.", criteria: { CLICK: "Click.", DONE: "Done." } } as const;
	assert.equal(choice({ type: "choice", choice: "CLICK", probabilities: { CLICK: 0.9, DONE: 0.1 }, confidence: 0.9 }, question), "CLICK");
	for (const probabilities of [
		{ CLICK: 0.1, DONE: 0.9 },
		{ CLICK: 0.9, DONE: 0.9 },
		{ CLICK: Number.NaN, DONE: 0.1 },
		{ CLICK: 1, DONE: 0, HIDDEN: 0 },
	]) assert.throws(() => choice({ type: "choice", choice: "CLICK", probabilities, confidence: 0.9 }, question), /Invalid classifier probabilities/);
	assert.throws(() => choice({ type: "choice", choice: "DELETE", probabilities: { CLICK: 0.9, DONE: 0.1 }, confidence: 0.9 }, question), /Invalid classifier probabilities/);
	assert.throws(() => choice(undefined, question), /No valid classifier choice/);
});
