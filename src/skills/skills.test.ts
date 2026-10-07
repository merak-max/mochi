import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { newFaux, openTestMochi, tempDir } from "../test-support.ts";

const context = BACKGROUND_CONTEXT;
const skill = (description: string) => `---\nname: x\ndescription: ${description}\n---\nBody.\n`;

test("the skills index lists each skill with a cut description, and an edited skill reaches the next request", async () => {
	const dir = await tempDir();
	const skills = join(dir, "bundled");
	for (const name of ["beta", "alpha"]) await mkdir(join(skills, name), { recursive: true });
	await writeFile(join(skills, "alpha", "SKILL.md"), skill("Short one."));
	await writeFile(join(skills, "beta", "SKILL.md"), skill("y".repeat(200)));
	await mkdir(join(skills, "not-a-skill"));

	const faux = newFaux();
	const seen: (string | null | undefined)[] = [];
	const capture = (transcript: TranscriptContext) => {
		const patches = transcript.messages.flatMap((message) => (message.role === "system" && message.sections?.["skills-index"] !== undefined ? [message.sections["skills-index"]] : []));
		seen.push(patches.at(-1));
		return fauxAssistantMessage("ok");
	};
	faux.setResponses([capture, capture]);
	const mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { skillsDir: skills });
	await (await mochi.root.submit({ type: "input", content: "hi" }, context)).wait(context);
	await writeFile(join(skills, "alpha", "SKILL.md"), skill("Edited."));
	await utimes(join(skills, "alpha", "SKILL.md"), new Date(), new Date(Date.now() + 10_000));
	await (await mochi.root.submit({ type: "input", content: "again" }, context)).wait(context);
	await mochi.close();

	const header = `Skills, each at ${skills}/<name>/SKILL.md; read one before following it.`;
	assert.deepEqual(seen, [
		`<skills-index>\n${header}\nalpha: Short one.\nbeta: ${"y".repeat(119)}…\n</skills-index>`,
		`<skills-index>\n${header}\nalpha: Edited.\nbeta: ${"y".repeat(119)}…\n</skills-index>`,
	]);
});
