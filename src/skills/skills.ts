import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { parse } from "yaml";

interface SkillLine {
	readonly name: string;
	readonly description: string;
}

async function readSkills(dir: string): Promise<readonly SkillLine[]> {
	const names = (await readdir(dir).catch(() => [])).sort();
	const skills: SkillLine[] = [];
	for (const name of names) {
		const text = await readFile(join(dir, name, "SKILL.md"), "utf8").catch(() => undefined);
		if (text === undefined) continue;
		const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
		const data: unknown = front === undefined ? undefined : parse(front, { schema: "failsafe" });
		const description = typeof data === "object" && data !== null && "description" in data && typeof data.description === "string" ? data.description : "";
		skills.push({ name, description });
	}
	return skills;
}

/**
 * The `skills-index` section, pi's pattern: name and description, and the model opens the file with `read`. Re-read
 * when a SKILL.md's modification time changes, so an edited skill reaches the next request without a restart.
 */
export function skillsExtension(dir: string): Extension {
	let cached: { readonly key: string; readonly text: string | undefined } | undefined;
	const render = async (): Promise<string | undefined> => {
		const names = (await readdir(dir).catch(() => [])).sort();
		const times = await Promise.all(names.map((name) => stat(join(dir, name, "SKILL.md")).then((file) => file.mtimeMs, () => 0)));
		const key = names.map((name, i) => `${name}:${times[i]}`).join("\n");
		if (cached?.key !== key) cached = { key, text: indexText(dir, await readSkills(dir)) };
		return cached.text;
	};
	return defineExtension({ name: "skills", sections: [section("skills-index", render)] });
}

function indexText(dir: string, skills: readonly SkillLine[]): string | undefined {
	if (skills.length === 0) return undefined;
	const lines = skills.map(({ name, description }) => `${name}: ${description}`);
	return [`Skills, each at ${dir}/<name>/SKILL.md; read one before following it.`, ...lines].join("\n");
}
