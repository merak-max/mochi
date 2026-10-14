import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type ModelThinkingLevel, Type } from "@earendil-works/pi-ai";
import { AgentDoc, configure, type ConversationId, type DocumentReader, defineDocFamily, defineTool, type Harness, type ModelRef, type Submission, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { createSeatConversation } from "../seats.ts";
import type { Owner } from "../memory/memory.ts";
import { answerText } from "../turn/turn.ts";

// A profile is a standing teammate inside this daemon: a name, a role (instructions), a model, a conversation that
// lives as long as the profile, and its own memory log. Its file is `<home>/profiles/<name>/instructions.md` with
// front matter for `model` and `thinking`. Work reaches it by `profile_send` or a trigger with `profile`.

const THINKING = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
type Thinking = (typeof THINKING)[number];

interface Profile {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly model?: string;
	readonly thinking?: Thinking;
	/** The only tools its conversations may use; absent: its seat's tools. `codemode` and `notify` stay, so a list names script functions. */
	readonly tools?: readonly string[];
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function parseProfile(name: string, text: string): Profile {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	const fields = new Map<string, string>();
	for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
		const pair = /^([\w-]+):\s*(.*)$/.exec(line);
		if (pair?.[1] !== undefined) fields.set(pair[1], (pair[2] ?? "").trim());
	}
	const thinkingText = fields.get("thinking");
	const thinking = THINKING.find((level) => level === thinkingText);
	if (thinkingText !== undefined && thinking === undefined) throw new Error(`profile ${name}: thinking "${thinkingText}" is not one of ${THINKING.join(", ")}.`);
	const model = fields.get("model") || undefined;
	const tools = fields.get("tools")?.split(",").map((tool) => tool.trim()).filter(Boolean);
	return {
		name,
		description: fields.get("description") ?? "",
		...(tools === undefined ? {} : { tools }),
		instructions: (match?.[2] ?? text).trim(),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
	};
}

/** The profiles on disk, re-read on each call so an edited instructions.md reaches the next run without a restart. */
export class Profiles {
	readonly #dir: string;
	readonly #bundled: string;
	readonly model: (name: string) => ModelRef;

	constructor(dir: string, bundled: string, model: (name: string) => ModelRef) {
		this.#dir = dir;
		this.#bundled = bundled;
		this.model = model;
	}

	async all(): Promise<Profile[]> {
		const found = new Map<string, Profile>();
		for (const file of (await readdir(this.#bundled).catch(() => [] as string[])).filter((each) => each.endsWith(".md")).sort()) {
			const name = file.slice(0, -3);
			found.set(name, parseProfile(name, await readFile(join(this.#bundled, file), "utf8")));
		}
		for (const name of (await readdir(this.#dir).catch(() => [] as string[])).sort()) {
			const file = join(this.#dir, name, "instructions.md");
			if (NAME.test(name) && existsSync(file)) found.set(name, parseProfile(name, await readFile(file, "utf8")));
		}
		return [...found.values()];
	}

	async get(name: string): Promise<Profile> {
		const all = await this.all();
		const found = all.find((profile) => profile.name === name);
		if (found === undefined) throw new Error(`Unknown profile "${name}". Profiles: ${all.map((profile) => profile.name).join(", ")}.`);
		return found;
	}

	async write(name: string, text: string): Promise<void> {
		if (!NAME.test(name)) throw new Error(`Profile names are lowercase words joined by hyphens, not "${name}".`);
		parseProfile(name, text);
		await mkdir(join(this.#dir, name), { recursive: true });
		await writeFile(join(this.#dir, name, "instructions.md"), `${text.trim()}\n`);
	}
}

export type RunAgent = { readonly profile: string | undefined; readonly agent: { model: ModelRef; thinkingLevel?: ModelThinkingLevel }; readonly tools: readonly string[] | undefined; readonly instructions: string };

/** The model, tools and instructions a conversation runs under for `profile`. */
export function agentOf(profile: Profile, profiles: Profiles, header: string): RunAgent {
	return {
		profile: profile.name,
		agent: { model: profiles.model(profile.model ?? "default"), ...(profile.thinking === undefined ? {} : { thinkingLevel: profile.thinking }) },
		tools: profile.tools === undefined ? undefined : ["codemode", "notify", "handoff", ...profile.tools],
		instructions: profile.instructions === "" ? header : `${header}\n\n${profile.instructions}`,
	};
}

const ProfileDoc = defineDocFamily<{ conversation: ConversationId | null }, null>({
	kind: "mochi.profile",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ conversation: null }),
});

/** Which profile owns each conversation: its standing one and each trigger run that names it. */
const ProfileOfDoc = defineDocFamily<{ profile: string | null }, null>({
	kind: "mochi.profile-of",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ profile: null }),
});

/** The memory owner of a conversation, through a committed reader (prompt sections) or a transaction. */
export async function ownerOf(read: Pick<DocumentReader, "snapshot">, conversation: ConversationId, context: Context): Promise<Owner> {
	const profile = (await read.snapshot(ProfileOfDoc, String(conversation), context))?.profile;
	return profile == null ? "root" : { profile };
}

export async function ownerIn(tx: Tx, conversation: ConversationId): Promise<Owner> {
	const { profile } = await tx.doc(ProfileOfDoc, String(conversation), null);
	return profile === null ? "root" : { profile };
}

/** Writes a run's profile, model, instructions and tool list into a conversation; no list clears an old one. */
export async function applyAgent(tx: Tx, conversation: ConversationId, run: RunAgent): Promise<void> {
	await configure(tx, conversation, { ...run.agent, instructions: run.instructions });
	(await tx.doc(ProfileOfDoc, String(conversation), null)).profile = run.profile ?? null;
	const agent = await tx.doc(AgentDoc, conversation);
	if (run.tools === undefined) delete agent.tools;
	else agent.tools = [...run.tools];
}

const HEADER = (name: string) => `You are the ${name} profile, a standing teammate of mochi. Messages here come from mochi or its other profiles, not the owner. Answer the sender; use notify only when the owner must see something now.`;

async function ensureConversation(tx: Tx, profile: Profile, profiles: Profiles): Promise<ConversationId> {
	const doc = await tx.doc(ProfileDoc, profile.name, null);
	const run = agentOf(profile, profiles, HEADER(profile.name));
	doc.conversation ??= await createSeatConversation(tx, "agent", { kind: "ownerless" });
	await applyAgent(tx, doc.conversation, run);
	return doc.conversation;
}

type Host = Pick<Harness, "commit" | "conversation">;

/** Submits `message` to the profile's standing conversation, creating it the first time. Same requestId, same submission. */
export async function sendToProfile(host: Host, profiles: Profiles, name: string, message: string, requestId: string, context: Context): Promise<Submission> {
	const profile = await profiles.get(name);
	const conversation = await host.commit((tx) => ensureConversation(tx, profile, profiles), context);
	const target = await host.conversation(conversation, context);
	if (target === undefined) throw new Error(`Profile ${name} has no conversation.`);
	return target.submit({ type: "input", content: message, requestId, whenBusy: "followUp" }, context);
}

export function profileFns(profiles: Profiles, host: () => Host): ToolRegistration[] {
	return [
		defineTool({
			name: "profile_list",
			description: "The profiles: standing teammates with their own role, model and memory. Each has a name and what it does.",
			parameters: Type.Object({}),
			structuredOutputSchema: Type.Array(Type.Object({ name: Type.String(), description: Type.String(), model: Type.Optional(Type.String()) })),
			replay: "safe",
			execute: async () => ({ structuredOutput: (await profiles.all()).map(({ name, description, model }) => JSON.parse(JSON.stringify({ name, description, model }))) }),
		}),
		defineTool({
			name: "profile_send",
			description:
				"Give a profile a message: a task, a question, or a board item id. It works in its own standing conversation with its own memory. " +
				"Resolves to its answer; with background it returns at once, and the profile calls notify if the owner needs the result.",
			parameters: Type.Object({ name: Type.String(), message: Type.String({ minLength: 1 }), background: Type.Optional(Type.Boolean()) }),
			structuredOutputSchema: Type.String(),
			replay: "unsafe",
			execute: async ({ name, message, background }, api, context) => {
				const submission = await sendToProfile(host(), profiles, name, message, `profile:${api.taskId}`, context);
				if (background === true) return { structuredOutput: `Sent to ${name}.` };
				const settled = await submission.wait(context);
				if (settled.status !== "done" || settled.type !== "input") throw new Error(`Profile ${name} did not answer: ${settled.reason ?? settled.status}.`);
				return { structuredOutput: await api.commit((tx) => answerText(tx, settled.answer), context) };
			},
		}),
		defineTool({
			name: "profile_update",
			description: "Create a profile or replace its instructions.md: front matter with description, model (a tier or alias) and thinking, then the role. Reaches its next message.",
			parameters: Type.Object({ name: Type.String(), text: Type.String({ minLength: 1 }) }),
			structuredOutputSchema: Type.String(),
			replay: "safe",
			execute: async ({ name, text }) => {
				await profiles.write(name, text);
				return { structuredOutput: `Saved profile ${name}.` };
			},
		}),
	];
}
