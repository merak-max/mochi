import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ModelThinkingLevel, Type } from "@earendil-works/pi-ai";
import { AgentDoc, configure, type PromptSection, section, type ConversationId, defineDocFamily, defineTool, type Harness, type ModelRef, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { abortTargets } from "../turn/commands.ts";
import { allPages } from "../pages.ts";
import { createSeatConversation } from "../seats.ts";

// An agent definition is a named worker: `<home>/agents/<name>.md` or the bundled `agents/<name>.md`, with front matter
// for description, model, thinking, tools and `resident`. tools.agent runs a job under one. A resident definition keeps
// one standing conversation, and its jobs go there.

const THINKING = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
type Thinking = (typeof THINKING)[number];

export interface Definition {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly model?: string;
	readonly thinking?: Thinking;
	/** The only tools its conversations may use; absent: its seat's tools. `codemode`, `notify` and the context readers stay, so a list names script functions. */
	readonly tools?: readonly string[];
	readonly resident: boolean;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const ROOT = "root";

function parseDefinition(name: string, text: string): Definition {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	const fields = new Map<string, string>();
	for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
		const pair = /^([\w-]+):\s*(.*)$/.exec(line);
		if (pair?.[1] !== undefined) fields.set(pair[1], (pair[2] ?? "").trim());
	}
	const named = fields.get("name");
	if (named !== undefined && named !== name) throw new Error(`agent ${name}: front matter says name "${named}"; the file name is the name.`);
	const thinkingText = fields.get("thinking");
	const thinking = THINKING.find((level) => level === thinkingText);
	if (thinkingText !== undefined && thinking === undefined) throw new Error(`agent ${name}: thinking "${thinkingText}" is not one of ${THINKING.join(", ")}.`);
	const residentText = fields.get("resident");
	if (residentText !== undefined && residentText !== "true" && residentText !== "false") throw new Error(`agent ${name}: resident is true or false, not "${residentText}".`);
	const model = fields.get("model") || undefined;
	const tools = fields.get("tools")?.split(",").map((tool) => tool.trim()).filter(Boolean);
	return {
		name,
		description: fields.get("description") ?? "",
		...(tools === undefined ? {} : { tools }),
		instructions: (match?.[2] ?? text).trim(),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		resident: residentText === "true",
	};
}

async function readDir(dir: string, found: Map<string, Definition>): Promise<void> {
	const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith(".md")).sort();
	for (const file of files) {
		const name = file.slice(0, -3);
		if (NAME.test(name)) found.set(name, parseDefinition(name, await readFile(join(dir, file), "utf8")));
	}
}

/** The definitions on disk, read again on each call so an edited file reaches the next job without a restart. */
export class Definitions {
	readonly #dir: string;
	readonly #bundled: string;
	readonly model: (name: string) => ModelRef;

	constructor(dir: string, bundled: string, model: (name: string) => ModelRef) {
		this.#dir = dir;
		this.#bundled = bundled;
		this.model = model;
	}

	/** Bundled first; the owner's file of the same name replaces it. */
	/** Root's own definition, `<home>/agents/root.md`: the owner's conversation runs under it. Only the owner's copy counts. */
	async root(): Promise<Definition> {
		const found = new Map<string, Definition>();
		await readDir(this.#dir, found);
		const root = found.get(ROOT);
		if (root === undefined) throw new Error(`No ${ROOT}.md in ${this.#dir}. Copy root.example.md from the repository there as root.md: root runs under it.`);
		return root;
	}

	/** Every definition a job can name; root is the owner's conversation, never a job. */
	async all(): Promise<Definition[]> {
		const found = new Map<string, Definition>();
		await readDir(this.#bundled, found);
		await readDir(this.#dir, found);
		found.delete(ROOT);
		return [...found.values()];
	}

	async get(name: string): Promise<Definition> {
		const all = await this.all();
		const found = all.find((definition) => definition.name === name);
		if (found === undefined) throw new Error(`Unknown agent definition "${name}". Definitions: ${all.map((definition) => definition.name).join(", ")}.`);
		return found;
	}
}

export type RunAgent = { readonly definition: string | undefined; readonly agent: { model: ModelRef; thinkingLevel?: ModelThinkingLevel }; readonly tools: readonly string[] | undefined; readonly instructions: string };

/** The model, tools and instructions a conversation runs under for `definition`, after `header`. */
export function agentOf(definition: Definition, definitions: Definitions, header: string): RunAgent {
	return {
		definition: definition.name,
		agent: { model: definitions.model(definition.model ?? "default"), ...(definition.thinking === undefined ? {} : { thinkingLevel: definition.thinking }) },
		tools: definition.tools === undefined ? undefined : ["codemode", "notify", "handoff", "context_read", "context_list", ...definition.tools],
		instructions: [header, definition.instructions].filter((part) => part !== "").join("\n\n"),
	};
}

/** A resident definition's standing conversation, by name. The kind keeps its stored name, so history survives. */
const ResidentDoc = defineDocFamily<{ conversation: ConversationId | null }, null>({
	kind: "mochi.profile",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ conversation: null }),
	checkpointWhen: () => false,
});

/** Which definition owns each conversation. The kind and the `profile` field keep their stored names. */
const OwnerDoc = defineDocFamily<{ profile: string | null }, null>({
	kind: "mochi.profile-of",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ profile: null }),
	checkpointWhen: () => false,
});

/** The definition a conversation runs as, or "root". */
export async function ownerIn(tx: Tx, conversation: ConversationId): Promise<string> {
	const { profile } = await tx.doc(OwnerDoc, String(conversation), null);
	return profile ?? "root";
}

/** A fork works as its parent's definition, so its messages carry the same sender. */
export async function inheritOwner(tx: Tx, parent: ConversationId, child: ConversationId): Promise<void> {
	const { profile } = await tx.doc(OwnerDoc, String(parent), null);
	if (profile !== null) (await tx.doc(OwnerDoc, String(child), null)).profile = profile;
}

/** Writes a run's definition, model, instructions and tool list into a conversation; no list clears an old one. */
export async function applyAgent(tx: Tx, conversation: ConversationId, run: RunAgent): Promise<void> {
	await configure(tx, conversation, { ...run.agent, instructions: run.instructions });
	(await tx.doc(OwnerDoc, String(conversation), null)).profile = run.definition ?? null;
	const agent = await tx.doc(AgentDoc, conversation);
	if (run.tools === undefined) delete agent.tools;
	else agent.tools = [...run.tools];
}

const CONTEXT_READERS = ["context_read", "context_list"];

/**
 * Gives every definition's conversation with a narrowed tool list the context readers, so held input stays readable in
 * conversations whose list was written before the readers existed or by a path that skips applyAgent. Run before resume.
 */
export async function addContextReaders(tx: Tx): Promise<void> {
	const records = await allPages((cursor) => tx.scanConversations({}, 256, cursor));
	for (const record of records) {
		const { profile } = await tx.doc(OwnerDoc, String(record.id), null);
		if (profile === null) continue;
		const agent = await tx.doc(AgentDoc, record.id);
		const tools = agent.tools;
		if (!Array.isArray(tools)) continue;
		for (const name of CONTEXT_READERS) {
			if (!tools.includes(name)) tools.push(name);
		}
	}
}

const RESIDENT_HEADER = (name: string) =>
	`You are the ${name} agent, a standing teammate of mochi. Each message here starts with [from <sender>]: root (mochi) or another agent, never the owner. ` +
	"Answer the sender. Hand a teammate a job with tools.agent({ jobs: [{ name, brief, definition }] }) when you need what they know. Use notify only when the owner must see something now. " +
	"Anything that must happen later is a tools.schedule_add: {at} once, {cron} repeating. Never use systemd-run, crontab, at or nohup: root cannot see or stop those.";

/** The standing conversation of a resident definition, created the first time, with its agent written again. */
export async function residentConversation(tx: Tx, definition: Definition, definitions: Definitions): Promise<ConversationId> {
	const doc = await tx.doc(ResidentDoc, definition.name, null);
	doc.conversation ??= await createSeatConversation(tx, "agent", { kind: "ownerless" });
	await applyAgent(tx, doc.conversation, agentOf(definition, definitions, RESIDENT_HEADER(definition.name)));
	return doc.conversation;
}

type StopHost = Pick<Harness, "commit" | "taskGraph" | "inspect" | "abortSubmission" | "abortTask" | "waitForTask">;

/** agent_stop: the one control a resident needs that a job cannot give. */
export function agentStopTool(definitions: Definitions, host: () => StopHost): ToolRegistration {
	return defineTool({
		name: "agent_stop",
		description:
			"Stop a resident agent now: abort its running turn, its queued jobs, and the forks and agents it started. Use it when the owner says stop or a brief is wrong. " +
			"It does not stop shell processes or schedules the agent made: check proc_status, schedule_list and `systemctl --user list-timers` after it. Resolves to what it stopped.",
		parameters: Type.Object({ name: Type.String() }),
		structuredOutputSchema: Type.String(),
		replay: "safe",
		execute: async ({ name }, api, context) => {
			const definition = await definitions.get(name);
			if (!definition.resident) throw new Error(`${name} is not resident; its jobs are children of the caller, stopped with it.`);
			const conversation = await api.commit(async (tx) => (await tx.doc(ResidentDoc, name, null)).conversation, context);
			if (conversation === null) return { structuredOutput: `${name} has never run; nothing to stop.` };
			const harness = host();
			const targets = await abortTargets(harness, { id: conversation }, "stop", context);
			for (const id of targets.submissions) await harness.abortSubmission(id, context);
			for (const id of targets.tasks) await harness.abortTask(id, context);
			for (const id of targets.tasks) await harness.waitForTask(id, context);
			if (!targets.running) return { structuredOutput: `${name} was idle; nothing was running.` };
			return { structuredOutput: `Stopped ${name}: ${targets.submissions.length} messages and ${targets.tasks.length} child tasks aborted. Calls that already ran are not undone; check their results.` };
		},
	});
}

/** The definitions in every agent seat's prompt, so root and each agent see who owns what without a lookup. */
export function definitionsSection(definitions: Definitions): PromptSection {
	return section("agents", async () => {
		const lines = (await definitions.all()).map((definition) => `${definition.name}${definition.resident ? " (resident)" : ""}: ${definition.description}`);
		if (lines.length === 0) return undefined;
		return [
			"Agent definitions. When a task is one of these roles, hand it over with tools.agent({ jobs: [{ name, brief, definition }] }) instead of doing it yourself. A resident one keeps its own standing conversation and memory.",
			...lines,
		].join("\n");
	});
}
