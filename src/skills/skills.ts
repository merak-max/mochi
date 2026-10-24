import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

/**
 * The `skills-index` section: name, description and file, and the model opens the file with `read`.
 * `dirs` are the bundled skills first, then the owner's: an owner skill with a bundled name replaces the bundled one.
 * Read on each render, so an edited skill reaches the next request without a restart.
 */
export function skillsExtension(dirs: readonly string[]): Extension {
	const render = (): string | undefined => {
		const byName = new Map<string, Skill>();
		for (const dir of dirs) {
			for (const skill of loadSkillsFromDir({ dir, source: dir }).skills) byName.set(skill.name, skill);
		}
		const skills = [...byName.values()].filter((skill) => !skill.disableModelInvocation).sort((a, b) => a.name.localeCompare(b.name));
		if (skills.length === 0) return undefined;
		const lines = skills.map(({ name, description, filePath }) => `${name} (${filePath}): ${description}`);
		return ["Skills. Read a skill's file before following it.", ...lines].join("\n");
	};
	return defineExtension({ name: "skills", sections: [section("skills-index", render)] });
}
