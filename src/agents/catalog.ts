import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type ModelThinkingLevel, type Static, Type } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { parseWith } from "../parse.ts";

export const THINKING = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
type Thinking = (typeof THINKING)[number];

/** One `agents/<name>.md`: its body becomes the child's instructions; `model` and `thinking` are its defaults. */
export interface AgentType {
	readonly name: string;
	readonly instructions: string;
	readonly model?: string;
	readonly thinking?: Thinking;
}

/** The agent types by file name, and how a model name in one (a tier, an alias, or provider/id) becomes a model. */
export class AgentCatalog {
	readonly types: ReadonlyMap<string, AgentType>;
	readonly #ref: (name: string) => ModelRef;

	constructor(types: readonly AgentType[], ref: (name: string) => ModelRef) {
		this.types = new Map(types.map((type) => [type.name, type]));
		this.#ref = ref;
	}

	/** `dir` holds the bundled types; each `<own>/<name>.md` adds a type or replaces the bundled one of that name. */
	static async load(dir: string, own: string | undefined, ref: (name: string) => ModelRef): Promise<AgentCatalog> {
		const types = new Map<string, AgentType>();
		for (const from of own === undefined ? [dir] : [dir, own]) {
			const files = (await readdir(from).catch(() => [] as string[])).filter((file) => file.endsWith(".md")).sort();
			for (const file of files) types.set(basename(file, ".md"), parseAgentFile(basename(file, ".md"), await readFile(join(from, file), "utf8")));
		}
		return new AgentCatalog([...types.values()], ref);
	}

	/** `brain` (or `default`), `fast`, `strongest`, an alias from config.toml's [models.aliases], or provider/id. */
	model(name: string): ModelRef {
		return this.#ref(name);
	}
}

export function parseAgentFile(name: string, text: string): AgentType {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	const fields = new Map<string, string>();
	for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
		const pair = /^([\w-]+):\s*(.*)$/.exec(line);
		if (pair?.[1] !== undefined) fields.set(pair[1], (pair[2] ?? "").trim());
	}
	const thinking = fields.get("thinking");
	const model = fields.get("model") || undefined;
	return {
		name,
		instructions: (match?.[2] ?? text).trim(),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking: parseThinking(thinking, `agents/${name}.md`) }),
	};
}

function parseThinking(value: string, where: string): Thinking {
	const level = THINKING.find((candidate) => candidate === value);
	if (level === undefined) throw new Error(`${where}: thinking "${value}" is not one of ${THINKING.join(", ")}.`);
	return level;
}
