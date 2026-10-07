import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { newFaux, openTestMochi, tempDir } from "./test-support.ts";

const context = BACKGROUND_CONTEXT;

test("a nightly checkpoint turn left by the rollover is aborted at boot and never answers into root", async () => {
	const dir = await tempDir();
	const hung = newFaux();
	hung.setResponses([(_c, options) => new Promise<AssistantMessage>((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("closed"))))]);
	const old = await openTestMochi(dir, hung);
	await old.root.submit({ type: "input", content: "[mochi nightly checkpoint 2026-10-06]", requestId: "rollover:2026-10-06", whenBusy: "reject" }, context);
	const run = (await old.harness.snapshot(LiveDoc, old.root.id, context))?.run;
	assert.ok(run !== undefined, "the checkpoint turn is in flight when the old daemon stops");
	await old.close();

	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("handoff note")]);
	const logs: unknown[] = [];
	const mochi = await openTestMochi(dir, faux, new Map(), undefined, [], { log: (event, fields) => logs.push({ event, ...fields }) });
	assert.deepEqual(logs, [{ event: "upgrade", unit: "U10", name: "retire-rollover", changed: 1 }]);
	mochi.harness.resume();
	assert.deepEqual((await mochi.harness.waitForTask(run.taskId, context)).state, { status: "terminal", outcome: { status: "aborted" } });
	assert.equal(faux.state.callCount, 0);
	assert.deepEqual((await mochi.root.entries({}, 50, undefined, context)).items.map((entry) => entry.kind), ["pi.user"]);
	await mochi.close();
	const again: unknown[] = [];
	await (await openTestMochi(dir, newFaux(), new Map(), undefined, [], { log: (event) => again.push(event) })).close();
	assert.deepEqual(again, []);
});
