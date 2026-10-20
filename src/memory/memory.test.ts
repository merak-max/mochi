import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "@earendil-works/chord";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { FastCompletion } from "../turn/lifecycle.ts";
import { clipBytes, LINE_BYTES, merge, turnLine } from "./memory.ts";

const context = {} as Context;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function scripted(answers: readonly string[]): { fast: FastCompletion; prompts: string[]; systems: string[] } {
	const prompts: string[] = [];
	const systems: string[] = [];
	const fast: FastCompletion = async ({ system, prompt }) => {
		systems.push(system);
		prompts.push(prompt);
		return answers[Math.min(prompts.length - 1, answers.length - 1)]!;
	};
	return { fast, prompts, systems };
}

test("merge names the byte limit and a ruler in the prompt", async () => {
	const { fast, systems } = scripted(["short"]);
	await merge(fast, "#0 a\n#1 b", context);
	assert.match(systems[0]!, /512 bytes \(about 70 words\)/);
	assert.ok(systems[0]!.includes("-".repeat(LINE_BYTES)));
	assert.match(systems[0]!, /Invent nothing; keep names, dates, numbers, ids, decisions, promises, what was sent or submitted/);
});

test("merge asks again after a line too long and keeps the short one", async () => {
	const { fast, prompts } = scripted(["word ".repeat(200), "a short line"]);
	const line = await merge(fast, "input", context);
	assert.equal(line, "a short line");
	assert.equal(prompts.length, 2);
	assert.match(prompts[1]!, /^input\n\nToo long: your last line was 999 bytes, over the 512-byte limit/);
	assert.match(prompts[1]!, /\| ← LIMIT$/);
});

test("merge stops after three tries and clips the shortest to 512 bytes", async () => {
	const { fast, prompts } = scripted(["é".repeat(400), "é".repeat(300), "é".repeat(350)]);
	const line = await merge(fast, "input", context);
	assert.equal(prompts.length, 3);
	assert.ok(bytes(line) <= LINE_BYTES);
	assert.equal(line, "é".repeat(256));
});

test("clipBytes cuts on a UTF-8 boundary", () => {
	assert.equal(clipBytes("ab", 512), "ab");
	assert.equal(clipBytes("aé", 2), "a");
	assert.equal(clipBytes("a😀b", 4), "a");
	assert.equal(clipBytes("a😀b", 5), "a😀");
});

let nextId = 1;
const entry = (kind: string, message: unknown): EntryRecord => ({ id: nextId++, kind, model: [message] }) as unknown as EntryRecord;

test("turnLine keeps tool calls and result heads", () => {
	const code = `const page = await tools.web_fetch({ url: "https://example.com" });\nawait tools.note({ line: "x" });\nawait tools.note({ line: "y" });\nreturn page;`;
	const line = turnLine([
		entry("pi.user", { role: "user", content: "Check example.com and send me the title", timestamp: 0 }),
		entry("pi.assistant", {
			role: "assistant",
			content: [
				{ type: "text", text: "Looking." },
				{ type: "toolCall", id: "c1", name: "codemode", arguments: { code } },
				{ type: "toolCall", id: "c2", name: "notify", arguments: { text: "x".repeat(300), to: "owner" } },
			],
			timestamp: 0,
		}),
		entry("pi.tool-result", { role: "toolResult", toolCallId: "c1", toolName: "codemode", content: [{ type: "text", text: "Example Domain ".repeat(20) }], isError: false, timestamp: 0 }),
		entry("pi.tool-result", { role: "toolResult", toolCallId: "c2", toolName: "notify", content: [{ type: "text", text: "Channel down" }], isError: true, timestamp: 0 }),
		entry("pi.assistant", { role: "assistant", content: [{ type: "text", text: "The title is Example Domain." }], timestamp: 0 }),
	])!;
	const parts = line.split(" | ");
	assert.equal(parts[0], "owner: Check example.com and send me the title");
	assert.equal(parts[1], "mochi: Looking.");
	assert.match(parts[2]!, /^tool codemode\(const page = await tools\.web_fetch.*…\) calls tools\.web_fetch\( tools\.note\($/);
	assert.match(parts[3]!, /^tool notify\(text=x{115}…\)$/);
	assert.match(parts[4]!, /^codemode result: (Example Domain ){10}Example Do…$/);
	assert.equal(parts[5], "notify error: Channel down");
	assert.equal(parts[6], "mochi: The title is Example Domain.");
});
