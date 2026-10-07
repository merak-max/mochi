import assert from "node:assert/strict";
import { test } from "node:test";
import { pause } from "./pause.ts";

test("pause resolves early on abort and rethrows anything else", async () => {
	const controller = new AbortController();
	const started = Date.now();
	setTimeout(() => controller.abort(), 20);
	await pause(10_000, controller.signal);
	assert.ok(Date.now() - started < 1000);
	await assert.rejects(pause(Number.NaN, { aborted: false, addEventListener: () => { throw new Error("boom"); } } as unknown as AbortSignal), /boom/);
});
