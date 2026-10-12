import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { newFaux, openTestMochi, tempDir } from "../test-support.ts";
import { loadImage } from "./read-image.ts";

const execute = promisify(execFile);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8WQAAAAASUVORK5CYII=", "base64");

test("a small png passes through and a large jpeg is scaled to at most 1568px", async () => {
	const dir = await tempDir();
	await writeFile(join(dir, "dot.png"), PNG);
	const small = await loadImage(join(dir, "dot.png"));
	assert.deepEqual([small.mimeType, small.scaled, small.content.data], ["image/png", false, PNG.toString("base64")]);
	await execute("/usr/bin/ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=2331x3297", "-frames:v", "1", join(dir, "scan.jpg")]);
	const big = await loadImage(join(dir, "scan.jpg"));
	assert.equal(big.scaled, true);
	await writeFile(join(dir, "out.jpg"), Buffer.from(big.content.data, "base64"));
	const { stdout } = await execute("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(dir, "out.jpg")]);
	assert.equal(stdout.trim(), "1108,1568");
});

test("read hands the model the picture instead of an unsupported-image error", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	const mochi = await openTestMochi(dir, faux);
	try {
		await mkdir(join(dir, "work"), { recursive: true });
		await writeFile(join(dir, "work", "dot.png"), PNG);
		const path = join(dir, "work", "dot.png");
		let seen = "";
		faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }), (request) => {
			seen = JSON.stringify(request.messages.at(-1));
			return fauxAssistantMessage("a dot");
		}]);
		await (await mochi.root.submit({ type: "input", content: "look" }, context)).wait(context);
		assert.ok(seen.includes(`"type":"image"`), seen.slice(0, 400));
		assert.ok(!seen.includes("not supported"));
	} finally { await mochi.close(); }
});
