import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { parse } from "yaml";

interface SkillLine {
	readonly name: string;
	readonly description: string;
	readonly file: string;
}

/** Skill files by name. A skill in a later directory replaces the one with the same name in an earlier directory. */
async function skillFiles(dirs: readonly string[]): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	for (const dir of dirs) {
		for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
			const file = join(dir, name, "SKILL.md");
			const found = await stat(file).then(() => true, () => false);
			if (found) files.set(name, file);
		}
	}
	return files;
}

async function readSkills(files: Map<string, string>): Promise<readonly SkillLine[]> {
	const skills: SkillLine[] = [];
	for (const name of [...files.keys()].sort()) {
		const file = files.get(name)!;
		const text = await readFile(file, "utf8").catch(() => undefined);
		if (text === undefined) continue;
		const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
		const data: unknown = front === undefined ? undefined : parse(front, { schema: "failsafe" });
		const description = typeof data === "object" && data !== null && "description" in data && typeof data.description === "string" ? data.description : "";
		skills.push({ name, description, file });
	}
	return skills;
}

/**
 * The `skills-index` section, pi's pattern: name, description and file, and the model opens the file with `read`.
 * `dirs` are the bundled skills first, then the owner's: an owner skill with a bundled name replaces the bundled one.
 * Re-read when a SKILL.md's modification time changes, so an edited skill reaches the next request without a restart.
 */
export function skillsExtension(dirs: readonly string[]): Extension {
	let cached: { readonly key: string; readonly text: string | undefined } | undefined;
	const render = async (): Promise<string | undefined> => {
		const files = await skillFiles(dirs);
		const paths = [...files.values()].sort();
		const times = await Promise.all(paths.map((file) => stat(file).then((each) => each.mtimeMs, () => 0)));
		const key = paths.map((file, i) => `${file}:${times[i]}`).join("\n");
		if (cached?.key !== key) cached = { key, text: indexText(await readSkills(files)) };
		return cached.text;
	};
	return defineExtension({ name: "skills", sections: [section("skills-index", render)] });
}

function indexText(skills: readonly SkillLine[]): string | undefined {
	if (skills.length === 0) return undefined;
	const lines = skills.map(({ name, description, file }) => `${name} (${file}): ${description}`);
	return ["Skills. Read a skill's file before following it.", ...lines].join("\n");
}
