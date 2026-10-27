import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUNDLED_PROMPTS_DIR, prompt, PROMPT_NAMES, readPrompts } from "./prompts.ts";

test("every file in prompts/ is a prompt the code reads, and every prompt has its file and placeholders", () => {
	const files: string[] = [];
	for (const entry of readdirSync(BUNDLED_PROMPTS_DIR, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) files.push(join(entry.parentPath, entry.name).slice(BUNDLED_PROMPTS_DIR.length + 1));
	}
	const expected = PROMPT_NAMES.map((name) => `${name}.md`);
	assert.deepEqual(files.sort(), expected.sort());
	const loaded = readPrompts(undefined);
	assert.equal(loaded.size, PROMPT_NAMES.length);
	for (const name of PROMPT_NAMES) assert.notEqual(loaded.get(name), "", `${name} is empty`);
});

test("a filled value is not scanned again, and brace text that is not a placeholder stays", () => {
	const note = prompt("memory/too-long", { bytes: "600", limit: "512", cut: "{limit} $& {cut}" });
	assert.match(note, /was 600 bytes,\nover the 512-byte limit/);
	assert.match(note, /\n\{limit\} \$& \{cut\}\| ← LIMIT$/);
	assert.match(prompt("brain/agent-system"), /A when of \{at\} fires once, \{cron\} fires at each slot/);
});

test("a prompt without its value throws", () => {
	assert.throws(() => prompt("brain/people", {} as { people: string }), /no value for \{people\}/);
});

test("an owner file replaces the bundled prompt of the same path, and must keep its placeholders", () => {
	const owner = mkdtempSync(join(tmpdir(), "mochi-prompts-"));
	try {
		mkdirSync(join(owner, "brain"));
		writeFileSync(join(owner, "brain", "identity.md"), "You are Mochi.\n");
		const loaded = readPrompts(owner);
		assert.equal(loaded.get("brain/identity"), "You are Mochi.");
		assert.equal(loaded.get("brain/system"), readPrompts(undefined).get("brain/system"));

		writeFileSync(join(owner, "brain", "new-tools.md"), "Write tools in the tools folder.\n");
		assert.throws(() => readPrompts(owner), /new-tools\.md has no \{tools-dir\} placeholder/);
	} finally {
		rmSync(owner, { recursive: true, force: true });
	}
});
