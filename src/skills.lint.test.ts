import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { LIBRARY, SURFACE } from "./seats.ts";

const REPO = join(import.meta.dirname, "..");
const SCRIPT_GLOBALS = ["store", "load", "text", "image", "searchTools", "describeTool"];

/** A backticked token that names a tool: `name(`, `tools.name`, a snake_case word, or a bare word followed by "tool". */
function toolReferences(markdown: string): string[] {
	const prose = markdown.replace(/^```[\s\S]*?^```/gm, "");
	const names: string[] = [];
	for (const match of prose.matchAll(/`([^`\n]+)`( tools?\b)?/g)) {
		const token = match[1]!;
		if (/^tools\.\w+/.test(token)) continue;
		const name = /^([a-z]\w*)\(/.exec(token)?.[1] ?? /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/.exec(token)?.[1] ?? (match[2] && /^([a-z]+)$/.exec(token)?.[1]);
		if (name) names.push(name);
	}
	return names;
}

function unknownToolReferences(files: ReadonlyMap<string, string>, known: ReadonlySet<string>): string[] {
	return [...files].flatMap(([file, text]) => toolReferences(text).filter((name) => !known.has(name)).map((name) => `${file}: ${name}`));
}

async function markdownFiles(): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const skills = (await readdir(join(REPO, "skills"), { recursive: true })).map((file) => join("skills", file));
	const agents = (await readdir(join(REPO, "agents"))).map((file) => join("agents", file));
	for (const file of [...skills, ...agents].filter((name) => name.endsWith(".md")).sort()) files.set(file, await readFile(join(REPO, file), "utf8"));
	return files;
}

test("skills and agent files name only tools mochi has", async () => {
	const known = new Set([...Object.keys(SURFACE), ...Object.keys(LIBRARY), ...SCRIPT_GLOBALS]);
	const files = await markdownFiles();
	assert.ok(files.has(join("skills", "swarm", "SKILL.md")) && files.has(join("skills", "mochi-mode", "SKILL.md")));
	assert.deepEqual(unknownToolReferences(files, known), []);

	const scratch = new Map([["skills/scratch/SKILL.md", "Start the build with the `process` tool, then call `process({ action: \"list\" })`."]]);
	assert.deepEqual(unknownToolReferences(scratch, known), ["skills/scratch/SKILL.md: process", "skills/scratch/SKILL.md: process"]);
});
