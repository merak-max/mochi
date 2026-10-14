import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type ModelThinkingLevel, Type } from "@earendil-works/pi-ai";
import { AgentDoc, configure, defineTask, LiveDoc, type SubmissionId, type ConversationId, type DocumentReader, defineDocFamily, defineTool, type Harness, type ModelRef, type Submission, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { journaled } from "../journal.ts";
import { createSeatConversation } from "../seats.ts";
import type { Owner } from "../memory/memory.ts";
import { answerText } from "../turn/turn.ts";

// A profile is a standing teammate inside this daemon: a name, a role (instructions), a model, a conversation that
// lives as long as the profile, and its own memory log. Its file is `<home>/profiles/<name>/instructions.md` with
// front matter for `model` and `thinking`. Work reaches it by `profile_send` or a trigger with `profile`.

export const THINKING = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
type Thinking = (typeof THINKING)[number];

export interface Profile {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly model?: string;
	readonly thinking?: Thinking;
	/** The only tools its conversations may use; absent: its seat's tools. `codemode` and `notify` stay, so a list names script functions. */
	readonly tools?: readonly string[];
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseProfile(name: string, text: string): Profile {
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

/** Each profile's standing conversation, by name. */
export const ProfileDoc = defineDocFamily<{ conversation: ConversationId | null }, null>({
	kind: "mochi.profile",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ conversation: null }),
});

/** Which profile owns each conversation: its standing one and each trigger run that names it. */
export const ProfileOfDoc = defineDocFamily<{ profile: string | null }, null>({
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

const HEADER = (name: string) =>
	`You are the ${name} profile, a standing teammate of mochi. Each message here starts with [from <sender>]: root (mochi) or another profile, never the owner. ` +
	"Answer the sender. Ask any teammate directly with tools.profile_send when you need what they know; profile_list shows who does what. Use notify only when the owner must see something now.";

async function ensureConversation(tx: Tx, profile: Profile, profiles: Profiles): Promise<ConversationId> {
	const doc = await tx.doc(ProfileDoc, profile.name, null);
	const run = agentOf(profile, profiles, HEADER(profile.name));
	doc.conversation ??= await createSeatConversation(tx, "agent", { kind: "ownerless" });
	await applyAgent(tx, doc.conversation, run);
	return doc.conversation;
}

type Host = Pick<Harness, "commit" | "conversation">;

type ReplyInput = { readonly submission: SubmissionId; readonly to: ConversationId; readonly from: string; readonly re: string };

/**
 * Waits for a profile's answer to a message nobody waits for inline, then sends it back to the asker's conversation as
 * a new message, which wakes the asker. Durable, so a restart still delivers it, once.
 */
export const defineReply = (harness: () => Pick<Harness, "submission">) => defineTask<ReplyInput, { readonly phase: "wait" }, null>({
	name: "mochi.reply",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: async (task, runtime, context) => {
			const { submission, to, from, re } = task.input;
			const settled = await (await harness().submission(submission, context))!.wait(context);
			let body = "(no answer: it finished without a reply)";
			if (settled.status === "unanswered") body = `(no answer: ${settled.reason ?? "unanswered"})`;
			else if (settled.type === "input") {
				let answer = "";
				await runtime.commit(async (tx) => void (answer = await answerText(tx, settled.answer)), context);
				if (answer !== "") body = answer;
			}
			const target = await runtime.conversation(to, context);
			if (target !== undefined) await target.submit({ type: "input", content: `[from ${from}] re: ${re}\n${body}`, requestId: `reply:${task.id}`, whenBusy: "followUp" }, context);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const firstLine = (text: string): string => (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();

/** Submits `message` to the profile's standing conversation, creating it the first time. Same requestId, same submission. */
/** Submits `message` to the profile's standing conversation, creating it the first time. Same requestId, same submission. `busy`: it was mid-turn. */
export async function sendToProfile(host: Host, profiles: Profiles, name: string, message: string, requestId: string, context: Context): Promise<{ submission: Submission; busy: boolean }> {
	const profile = await profiles.get(name);
	const conversation = await host.commit((tx) => ensureConversation(tx, profile, profiles), context);
	const target = await host.conversation(conversation, context);
	if (target === undefined) throw new Error(`Profile ${name} has no conversation.`);
	const busy = (await host.commit((tx) => tx.doc(LiveDoc, conversation), context)).run !== undefined;
	return { submission: await target.submit({ type: "input", content: message, requestId, whenBusy: "followUp" }, context), busy };
}

export type ReplyTask = ReturnType<typeof defineReply>;

export function profileFns(profiles: Profiles, host: () => Host, reply: ReplyTask): ToolRegistration[] {
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
				"Give a profile a message: a task, a question, or a board item id. Profiles message each other this way too. It works in its own standing conversation with its own memory. " +
				"Resolves to its answer. With background, or when the profile is busy, it returns at once and the answer arrives here later as a new message.",
			parameters: Type.Object({ name: Type.String(), message: Type.String({ minLength: 1 }), background: Type.Optional(Type.Boolean()) }),
			structuredOutputSchema: Type.String(),
			replay: "unsafe",
			execute: async ({ name, message, background }, api, context) => {
				const owner = await api.commit((tx) => ownerIn(tx, api.conversationId), context);
				const sender = owner === "root" ? "root" : owner.profile;
				if (sender === name) throw new Error(`You are ${name}; send to another profile.`);
				const { submission, busy } = await sendToProfile(host(), profiles, name, `[from ${sender}] ${message}`, `profile:${api.taskId}`, context);
				// A busy profile may be waiting on this very caller, so an inline wait could never end: its answer comes back later.
				if (background === true || busy) {
					await api.commit((tx) => journaled(tx, api.taskId, "reply", () => tx.createTask(reply, { submission: submission.id, to: api.conversationId, from: name, re: firstLine(message) }, { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true })), context);
					return { structuredOutput: busy ? `${name} is busy; your message is queued, and its answer comes back here as a new message.` : `Sent to ${name}; its answer comes back here as a new message.` };
				}
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
