import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type ModelThinkingLevel, type Static, Type } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { bifrostRef } from "../brain/models.ts";
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

const ModelsFileSchema = Type.Object({
	models: Type.Record(Type.String(), Type.String()),
	tiers: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
});
type ModelsFile = Static<typeof ModelsFileSchema>;

/** agents/: the agent types by file name, and agents/models.json, which names models by alias and tier. */
export class AgentCatalog {
	readonly types: ReadonlyMap<string, AgentType>;
	readonly #models: ModelsFile;

	constructor(types: readonly AgentType[], models: ModelsFile) {
		this.types = new Map(types.map((type) => [type.name, type]));
		this.#models = models;
	}

	static async load(dir: string): Promise<AgentCatalog> {
		const files = (await readdir(dir)).filter((file) => file.endsWith(".md")).sort();
		const types = await Promise.all(files.map(async (file) => parseAgentFile(basename(file, ".md"), await readFile(join(dir, file), "utf8"))));
		const models = parseWith(ModelsFileSchema, JSON.parse(await readFile(join(dir, "models.json"), "utf8")), "agents/models.json");
		return new AgentCatalog(types, models);
	}

	/** A tier (fast, default, strongest), an alias (opus, sonnet, fable, haiku), or a full provider/id. */
	model(name: string): ModelRef {
		const tier = Object.hasOwn(this.#models.tiers, name) ? this.#models.tiers[name] : undefined;
		if (Array.isArray(tier)) throw new Error(`Tier ${name} is a list (${tier.join(", ")}); start one agent per model, naming each.`);
		const alias = tier ?? name;
		const id = Object.hasOwn(this.#models.models, alias) ? this.#models.models[alias] : alias.includes("/") ? alias : undefined;
		if (id === undefined) {
			const valid = [...Object.keys(this.#models.tiers), ...Object.keys(this.#models.models), "provider/id"];
			throw new Error(`Unknown model "${name}". Use ${valid.join(", ")}.`);
		}
		return bifrostRef(id);
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
