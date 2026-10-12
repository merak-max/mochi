import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type ConversationId,
	type ConversationOwnership,
	defineDoc,
	defineExtension,
	type Extension,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { codeTool, type CodeDeps, type ScriptFn } from "./code/code.ts";

/**
 * A seat is the kind of conversation, stored in its agent and written only here.
 *   owner   root. Its only voice is its reply. The only seat that starts agents or adds triggers.
 *   run     a trigger run or a background agent. Reaches the owner only with notify; may end a trigger.
 *   worker  a foreground agent. Its answer returns to the call that started it.
 *   user    a user's iMessage thread. Its reply goes to the user; it has no owner notes and reaches no owner channel.
 */
export const SEATS = ["owner", "run", "worker", "user"] as const;
export type Seat = (typeof SEATS)[number];

const ALL = SEATS;
const OWNER: readonly Seat[] = ["owner"];
const OWNER_AND_RUN: readonly Seat[] = ["owner", "run"];

/** Every tool mochi defines and the seats that get it. */
export const SURFACE: Readonly<Record<string, readonly Seat[]>> = {
	read: ALL,
	bash: ALL,
	edit: ALL,
	write: ALL,
	code: ALL,
	note: OWNER,
	recall: ALL,
	react: OWNER,
	notify: ["run"],
	handoff: ["owner", "user"],
};

/** Caps, in characters, on each seat's tool schemas and each prompt section. A description that grows past one fails the build. */
export const BUDGET: { readonly tools: Readonly<Record<Seat, number>>; readonly sections: Readonly<Record<string, number>> } = {
	tools: { owner: 8560, run: 7000, worker: 5200, user: 5500 },
	sections: { identity: 2000, channels: 700, owner: 4000, "notes-index": 1500, "skills-index": 2000 },
};

/** Every script function and the seats whose `code` can call it. Inline ones are declared; the rest are found with search(). */
export const LIBRARY: Readonly<Record<string, { readonly seats: readonly Seat[]; readonly inline: boolean }>> = {
	web_search: { seats: ALL, inline: true },
	web_fetch: { seats: ALL, inline: true },
	llm: { seats: ALL, inline: true },
	apps_search: { seats: ALL, inline: true },
	apps_call: { seats: ALL, inline: true },
	agent: { seats: OWNER, inline: true },
	agent_start: { seats: OWNER, inline: true },
	trigger_add: { seats: OWNER, inline: true },
	trigger_list: { seats: OWNER_AND_RUN, inline: true },
	trigger_remove: { seats: OWNER_AND_RUN, inline: false },
	web_map: { seats: ALL, inline: false },
	classify: { seats: ALL, inline: false },
	apps_skills: { seats: ALL, inline: false },
	agent_send: { seats: OWNER, inline: false },
	agent_stop: { seats: OWNER, inline: false },
	agent_status: { seats: OWNER, inline: false },
	browse: { seats: ALL, inline: false },
	browse_fast: { seats: ALL, inline: false },
	image_gen: { seats: ALL, inline: false },
	video_gen: { seats: ALL, inline: false },
	speak: { seats: ALL, inline: false },
	transcribe: { seats: ALL, inline: false },
};

/** Anthropic's billing classifier flags these names. */
export const FORBIDDEN_TOOL_NAME = /^(memory|session_search)$|^mcp_(?!_)/;

const SHARED = ["identity", "notes", "skills", "fast-compaction"];

/** The extensions a seat's agent names. Owner notes describe the owner, so a user's thread leaves them out. */
export function selection(seat: Seat): string[] {
	const shared = seat === "user" ? SHARED.filter((name) => name !== "notes") : SHARED;
	return [...shared, `seat-${seat}`];
}

const drift = (names: readonly string[], table: object): string[] => [...names.filter((name) => !Object.hasOwn(table, name)), ...Object.keys(table).filter((name) => !names.includes(name))];

/** One `seat-<seat>` extension per seat, with a `code` over the seat's functions. Throws when the tables and the definitions disagree. */
export function seatExtensions(tools: readonly ToolRegistration[], fns: readonly ScriptFn[], code: CodeDeps): Extension[] {
	const disagree = [...drift([...tools.map((tool) => tool.name), "code"], SURFACE), ...drift(fns.map((fn) => fn.name), LIBRARY)];
	if (disagree.length > 0) throw new Error(`SURFACE, LIBRARY and the definitions disagree on ${disagree.join(", ")}.`);
	return SEATS.map((seat) => {
		const callable = fns.filter((fn) => LIBRARY[fn.name]!.seats.includes(seat));
		const library = { inline: callable.filter((fn) => LIBRARY[fn.name]!.inline), tail: callable.filter((fn) => !LIBRARY[fn.name]!.inline) };
		return defineExtension({ name: `seat-${seat}`, tools: [...tools.filter((tool) => SURFACE[tool.name]!.includes(seat)), codeTool(library, code)] });
	});
}

/** The host default, for anything that reaches a conversation without a seat: the least capable one. */
export const defaultSelection = (installed: (name: string) => Extension | undefined): Extension[] => selection("worker").flatMap((name) => installed(name) ?? []);

export interface SeatChange {
	readonly instructions?: string;
	/** Absent: root's, read in the same commit. */
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
}

/**
 * The only creator of conversations. A task-owned conversation would copy its owner's agent and an ownerless one would
 * have no model, so this replaces the whole agent: seat, model and thinking level, in the creating commit.
 */
export async function createSeatConversation(tx: Tx, seat: Seat, ownership: ConversationOwnership, change: SeatChange = {}): Promise<ConversationId> {
	const { id } = await tx.createConversation({ ownership });
	const root = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID);
	const agent = await tx.doc(AgentDoc, id);
	for (const key of Object.keys(agent) as (keyof typeof agent)[]) delete agent[key];
	const model = change.model ?? root.model;
	if (model !== undefined) agent.model = { ...model };
	agent.thinkingLevel = change.thinkingLevel ?? root.thinkingLevel ?? "off";
	agent.extensions = selection(seat);
	if (change.instructions !== undefined) agent.instructions = change.instructions;
	return id;
}

export const MemoryConversationDoc = defineDoc<{ maintenance: boolean }>({ kind: "mochi.memory-conversation", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ maintenance: false }) });

export async function createMemoryConversation(tx: Tx, change: { model: ModelRef; instructions: string }): Promise<ConversationId> {
	const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
	(await tx.doc(MemoryConversationDoc, conversation.id)).maintenance = true;
	const agent = await tx.doc(AgentDoc, conversation.id);
	for (const key of Object.keys(agent) as (keyof typeof agent)[]) delete agent[key];
	agent.model = { ...change.model };
	agent.extensions = [];
	agent.instructions = change.instructions;
	agent.thinkingLevel = "off";
	return conversation.id;
}

/** Root predates seats and `harness.root` ignores `agent` for an existing root, so each boot re-asserts it. */
export async function seatRoot(tx: Tx): Promise<boolean> {
	const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID);
	const owner = selection("owner");
	if (JSON.stringify(agent.extensions) === JSON.stringify(owner)) return false;
	agent.extensions = owner;
	return true;
}
