import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { messageText } from "../text.ts";
import { newFaux, openTestMochi, tempDir } from "../test-support.ts";

type Part = { type: string; text?: string; data?: string; mimeType?: string };

/** Root runs one codemode script; returns the result's parts as the model sees them. */
async function runScript(dir: string, code: string): Promise<Part[]> {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	const mochi = await openTestMochi(dir, faux);
	try {
		await (await mochi.root.submit({ type: "input", content: "go" }, context)).wait(context);
		const entry = (await mochi.root.entries({}, 100, undefined, context)).items.find((item) => item.kind === "pi.tool-result");
		const message = entry!.model![0]! as { content: Part[] };
		return message.content;
	} finally {
		await mochi.close();
	}
}

const ffmpeg = (args: string[]) => execFileSync("/usr/bin/ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args]);

test("a script reads a big JPEG and an AVIF and shows both to the model, scaled to fit", async () => {
	const dir = await tempDir();
	const work = join(dir, "work");
	execFileSync("mkdir", ["-p", work]);
	ffmpeg(["-f", "lavfi", "-i", "testsrc=size=3000x2000", "-frames:v", "1", join(work, "big.jpg")]);
	ffmpeg(["-f", "lavfi", "-i", "testsrc=size=640x480", "-frames:v", "1", "-c:v", "libaom-av1", "-still-picture", "1", join(work, "photo.avif")]);
	const paths = ["big.jpg", "photo.avif"];
	const parts = await runScript(dir, `for (const path of ${JSON.stringify(paths)}) { const shot = await tools.read({ path }); text(shot.note); image(shot); }`);
	const images = parts.filter((part) => part.type === "image");
	assert.equal(images.length, paths.length);
	const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	assert.match(text, /Resized from 3000x2000 to 2000x1333/);
	assert.match(text, /Converted photo\.avif to JPEG with ffmpeg/);
});

test("a script reads a text file as a string", async () => {
	const dir = await tempDir();
	execFileSync("mkdir", ["-p", join(dir, "work")]);
	execFileSync("sh", ["-c", `printf 'hello\\nworld\\n' > ${join(dir, "work", "a.txt")}`]);
	const parts = await runScript(dir, `const body = await tools.read({ path: "a.txt" }); return typeof body + ":" + body.trim();`);
	assert.match(parts.map((part) => part.text ?? "").join(""), /string:hello\nworld/);
});
