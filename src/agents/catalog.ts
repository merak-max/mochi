import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

export const THINKING = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
type Thinking = (typeof THINKING)[number];

export interface AgentType {
	readonly name: string;
	readonly instructions: string;
	readonly model?: string;
	readonly thinking?: Thinking;
}

export class AgentCatalog {
	readonly types: ReadonlyMap<string, AgentType>;
	readonly #ref: (name: string) => ModelRef;

	constructor(types: readonly AgentType[], ref: (name: string) => ModelRef) {
		this.types = new Map(types.map((type) => [type.name, type]));
		this.#ref = ref;
	}

	/** Each `<own>/<name>.md` adds a type or replaces the bundled one of that name. */
	static async load(dir: string, own: string | undefined, ref: (name: string) => ModelRef): Promise<AgentCatalog> {
		const types = new Map<string, AgentType>();
		for (const from of own === undefined ? [dir] : [dir, own]) {
			const files = (await readdir(from).catch(() => [] as string[])).filter((file) => file.endsWith(".md")).sort();
			for (const file of files) types.set(basename(file, ".md"), parseAgentFile(basename(file, ".md"), await readFile(join(from, file), "utf8")));
		}
		return new AgentCatalog([...types.values()], ref);
	}

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
	const thinkingText = fields.get("thinking");
	const thinking = THINKING.find((level) => level === thinkingText);
	if (thinkingText !== undefined && thinking === undefined) throw new Error(`agents/${name}.md: thinking "${thinkingText}" is not one of ${THINKING.join(", ")}.`);
	const model = fields.get("model") || undefined;
	return {
		name,
		instructions: (match?.[2] ?? text).trim(),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
	};
}
