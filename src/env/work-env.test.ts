import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { tempDir } from "../test-support.ts";
import { workEnv } from "./work-env.ts";

test("a bash call without its own timeout stops at the default", async () => {
	const dir = await tempDir();
	let out = "";
	const result = await workEnv(dir, dir, 1).exec("sleep 5; echo finished", { onOutput: (text) => (out += text) }, context);
	assert.equal(result.ok, false);
	assert.match(result.ok ? out : result.error.message, /timed out after 1 seconds, the default limit/);
});
