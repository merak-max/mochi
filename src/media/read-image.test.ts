import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { newFaux, openTestMochi, tempDir } from "../test-support.ts";
import { readImage } from "./read-image.ts";

const execute = promisify(execFile);
const LIMIT = 1568;
const models = fauxProvider({
	models: [
		{ id: "seeing", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: LIMIT, maxHeight: LIMIT } } } },
		{ id: "blind", input: ["text"] },
	],
});
const seeing = models.getModel("seeing");
const blind = models.getModel("blind");

async function sizeOf(image: ImageContent): Promise<[number, number]> {
	const measured = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, { maxWidth: 100_000, maxHeight: 100_000, maxBytes: 1e9 });
	assert.ok(measured !== null);
	return [measured.originalWidth, measured.originalHeight];
}

async function ffmpeg(args: string[]): Promise<void> {
	await execute("/usr/bin/ffmpeg", ["-nostdin", "-loglevel", "error", ...args]);
}

/** A 64x48 RGB png, written to `path`. Returns its bytes. */
async function smallPng(path: string): Promise<Buffer> {
	await ffmpeg(["-f", "lavfi", "-i", "testsrc=s=64x48", "-frames:v", "1", path]);
	return readFile(path);
}

test("a small png passes through unchanged", async () => {
	const dir = await tempDir();
	const png = await smallPng(join(dir, "dot.png"));
	const [note, image] = await readImage(join(dir, "dot.png"), seeing);
	assert.deepEqual(note, { type: "text", text: "Read image file [image/png]" });
	assert.deepEqual(image, { type: "image", mimeType: "image/png", data: png.toString("base64") });
});

test("a 2331x3297 jpeg comes back within the model's resize limit, with pi's dimension note", async () => {
	const dir = await tempDir();
	await ffmpeg(["-f", "lavfi", "-i", "testsrc=s=2331x3297", "-frames:v", "1", join(dir, "scan.jpg")]);
	const [note, image] = await readImage(join(dir, "scan.jpg"), seeing);
	assert.ok(image?.type === "image");
	const [width, height] = await sizeOf(image);
	assert.ok(height <= LIMIT && width <= LIMIT, `${width}x${height}`);
	assert.equal(height, LIMIT);
	assert.ok(note?.type === "text" && note.text.includes(`[Image: original 2331x3297, displayed at ${width}x${height}.`), JSON.stringify(note));
});

test("an avif goes through ffmpeg to jpeg and says it was converted", async () => {
	const dir = await tempDir();
	await ffmpeg(["-f", "lavfi", "-i", "testsrc=s=320x240", "-frames:v", "1", join(dir, "shot.avif")]);
	const [note, image] = await readImage(join(dir, "shot.avif"), seeing);
	assert.ok(image?.type === "image");
	assert.deepEqual(await sizeOf(image), [320, 240]);
	assert.ok(note?.type === "text" && note.text.includes(`[Image converted from image/avif to ${image.mimeType}.]`), JSON.stringify(note));
});

test("a model without image input gets pi's text note instead of the image", async () => {
	const dir = await tempDir();
	await smallPng(join(dir, "dot.png"));
	const content = await readImage(join(dir, "dot.png"), blind);
	assert.equal(content.length, 1);
	assert.ok(content[0]?.type === "text" && content[0].text.includes("[Current model does not support images."));
});

test("read hands the model the picture instead of an unsupported-image error", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	const mochi = await openTestMochi(dir, faux);
	try {
		await mkdir(join(dir, "work"), { recursive: true });
		await smallPng(join(dir, "work", "dot.png"));
		const path = join(dir, "work", "dot.png");
		let seen = "";
		faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }), (request) => {
			seen = JSON.stringify(request.messages.at(-1));
			return fauxAssistantMessage("a dot");
		}]);
		await (await mochi.root.submit({ type: "input", content: "look" }, context)).wait(context);
		assert.ok(seen.includes(`"type":"image"`), seen.slice(0, 400));
		assert.ok(seen.includes("Read image file [image/png]"), seen.slice(0, 400));
		assert.ok(!seen.includes("not supported"));
	} finally { await mochi.close(); }
});
