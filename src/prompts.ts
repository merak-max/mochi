import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every prose prompt a model reads is `prompts/<name>.md`, one file each. A file's one trailing newline is not part of
 * its text. `<home>/prompts/<name>.md` replaces the bundled file of the same name. Each name lists the `{placeholder}`
 * slots the code fills; any other brace text in a file is literal.
 */
const PLACEHOLDERS = {
	"board/definition-header": ["id", "no-reply"],
	"brain/agent-system": [],
	"brain/identity": [],
	"brain/new-tools": ["tools-dir"],
	"brain/people": ["people"],
	"brain/writing": [],
	"brain/system": ["memory-dir"],
	"channels/cli": [],
	"channels/imessage": [],
	"fork/background-brief": ["name", "scratch"],
	"fork/context-values": ["keys"],
	"fork/foreground-brief": ["name", "scratch"],
	"fork/job-brief": ["name", "scratch"],
	// The memory prompts are uniichat's prompt.txt (github.com/VictorTaelin/uniichat), adapted only where names differ:
	// Unii is the agent, the user is the owner's side of the chat, and tools are called from scripts as tools.<name>.
	"memory/compaction": ["kinds"],
	"memory/kinds": [],
	"memory/leaf-task": ["id", "limit", "ruler"],
	"memory/merge-task": ["a", "b", "id", "end", "limit", "ruler"],
	"memory/too-long": ["bytes", "limit", "cut"],
	"memory/view": ["kinds"],
	"sections/agents": [],
	"sections/context": [],
	"sections/skills": [],
	"turn/friend": ["id", "about", "owner-id"],
	"turn/handoff-note": [],
	"web/extract-schema": [],
	"web/extract-text": [],
} as const satisfies Record<string, readonly string[]>;

export type PromptName = keyof typeof PLACEHOLDERS;
export const PROMPT_NAMES = Object.keys(PLACEHOLDERS) as PromptName[];
type Values<Name extends PromptName> = Record<(typeof PLACEHOLDERS)[Name][number], string>;
type ValuesArg<Name extends PromptName> = (typeof PLACEHOLDERS)[Name] extends readonly [] ? [] : [values: Values<Name>];

export const BUNDLED_PROMPTS_DIR = join(import.meta.dirname, "..", "prompts");

/** Reads every prompt, the owner's file first when `ownerDir` has one. A missing file or placeholder throws. */
export function readPrompts(ownerDir: string | undefined): Map<PromptName, string> {
	const texts = new Map<PromptName, string>();
	for (const name of PROMPT_NAMES) {
		const ownerFile = ownerDir === undefined ? undefined : join(ownerDir, `${name}.md`);
		const file = ownerFile !== undefined && existsSync(ownerFile) ? ownerFile : join(BUNDLED_PROMPTS_DIR, `${name}.md`);
		let text = readFileSync(file, "utf8");
		if (text.endsWith("\n")) text = text.slice(0, -1);
		for (const placeholder of PLACEHOLDERS[name]) {
			if (!text.includes(`{${placeholder}}`)) throw new Error(`Prompt ${file} has no {${placeholder}} placeholder.`);
		}
		texts.set(name, text);
	}
	return texts;
}

let prompts = readPrompts(undefined);

/** Swaps in the owner's prompts from `<home>/prompts`, once at startup. */
export function loadOwnerPrompts(ownerDir: string): void {
	prompts = readPrompts(ownerDir);
}

/** The prompt's text with each placeholder filled. Filled values are not scanned again. */
export function prompt<Name extends PromptName>(name: Name, ...args: ValuesArg<Name>): string {
	const values: Record<string, string> = args[0] ?? {};
	const placeholders: readonly string[] = PLACEHOLDERS[name];
	for (const placeholder of placeholders) {
		if (typeof values[placeholder] !== "string") throw new Error(`Prompt ${name} has no value for {${placeholder}}.`);
	}
	const text = prompts.get(name)!;
	return text.replace(/\{([a-z-]+)\}/g, (match, key: string) => (placeholders.includes(key) ? values[key]! : match));
}
