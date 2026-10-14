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
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

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
/** A user's thread never reaches the owner's apps: Executor approvals are accepted without asking. */
const OWNER_RUN_WORKER: readonly Seat[] = ["owner", "run", "worker"];

/** The tools the model calls directly, and the seats that get each. Their `control` (handoff, terminate) works only on a model-issued call. */
export const SURFACE: Readonly<Record<string, readonly Seat[]>> = {
	codemode: ALL,
	notify: ["run"],
	handoff: ["owner", "user"],
};

/** Caps, in characters, on each seat's tool schemas and each prompt section. A description that grows past one fails the build. */
export const BUDGET: { readonly tools: Readonly<Record<Seat, number>>; readonly sections: Readonly<Record<string, number>> } = {
	tools: { owner: 3000, run: 3000, worker: 2600, user: 3000 },
	sections: { identity: 2000, channels: 700, owner: 4000, "notes-index": 1500, "skills-index": 2000, codemode: 9000 },
};

/** Every tool scripts call as `tools.<name>`, and the seats that get it. The `codemode` section declares the inline ones; scripts find the rest with `searchTools()`. */
export const LIBRARY: Readonly<Record<string, { readonly seats: readonly Seat[]; readonly inline: boolean }>> = {
	read: { seats: ALL, inline: true },
	bash: { seats: ALL, inline: true },
	edit: { seats: ALL, inline: true },
	write: { seats: ALL, inline: true },
	recall: { seats: ALL, inline: true },
	history: { seats: OWNER_RUN_WORKER, inline: false },
	note: { seats: OWNER, inline: true },
	react: { seats: OWNER, inline: true },
	web_search: { seats: ALL, inline: true },
	web_fetch: { seats: ALL, inline: true },
	llm: { seats: ALL, inline: true },
	apps_search: { seats: OWNER_RUN_WORKER, inline: true },
	apps_call: { seats: OWNER_RUN_WORKER, inline: true },
	agent: { seats: OWNER, inline: true },
	agent_start: { seats: OWNER, inline: true },
	trigger_add: { seats: OWNER, inline: true },
	trigger_list: { seats: OWNER_AND_RUN, inline: true },
	trigger_remove: { seats: OWNER_AND_RUN, inline: false },
	web_map: { seats: ALL, inline: false },
	classify: { seats: ALL, inline: false },
	apps_skills: { seats: OWNER_RUN_WORKER, inline: false },
	agent_send: { seats: OWNER, inline: false },
	agent_stop: { seats: OWNER, inline: false },
	agent_status: { seats: OWNER, inline: false },
	browse: { seats: ALL, inline: false },
	browse_fast: { seats: ALL, inline: false },
	image_gen: { seats: ALL, inline: false },
	video_gen: { seats: ALL, inline: false },
	speak: { seats: ALL, inline: false },
	gif_search: { seats: ALL, inline: false },
	gif_save: { seats: ALL, inline: false },
	transcribe: { seats: ALL, inline: false },
	proc_start: { seats: OWNER_AND_RUN, inline: false },
	proc_status: { seats: OWNER_AND_RUN, inline: false },
	proc_logs: { seats: OWNER_AND_RUN, inline: false },
	proc_stop: { seats: OWNER_AND_RUN, inline: false },
	a2a_list: { seats: OWNER_AND_RUN, inline: false },
	a2a_ask: { seats: OWNER_AND_RUN, inline: false },
	a2a_send: { seats: OWNER_AND_RUN, inline: false },
	a2a_status: { seats: OWNER_AND_RUN, inline: false },
	profile_list: { seats: OWNER, inline: false },
	profile_create: { seats: OWNER, inline: false },
	profile_update: { seats: OWNER, inline: false },
	profile_remove: { seats: OWNER, inline: false },
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

/** Longest script run, set when a script names no `timeout_ms` of its own. */
export const SCRIPT_DEADLINE_MS = 10 * 60_000;
const SCRIPT_MEMORY_BYTES = 256 * 1024 * 1024;

/** A script with no options line gets the default deadline, so a hung call never holds a turn forever. */
export function withDeadline(code: string, deadlineMs: number): string {
	if (code.trimStart().startsWith("// @options:")) return code;
	return `// @options: {"timeout_ms": ${deadlineMs}}\n${code}`;
}

/**
 * One `seat-<seat>` extension per seat: its model tools, `codemode` with its prompt section, and the library tools its
 * scripts may call. Throws when the tables and the definitions disagree.
 */
export function seatExtensions(modelTools: readonly ToolRegistration[], library: readonly ToolRegistration[], deadlineMs = SCRIPT_DEADLINE_MS): Extension[] {
	const codemode = createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: SCRIPT_MEMORY_BYTES }), models: false });
	const tool = codemode.tools![0]!;
	const codemodeTool: ToolRegistration = { ...tool, execute: (args, api, context) => tool.execute({ code: withDeadline((args as { code: string }).code, deadlineMs) }, api, context) };
	const disagree = [...drift([...modelTools.map((each) => each.name), "codemode"], SURFACE), ...drift(library.map((each) => each.name), LIBRARY)];
	if (disagree.length > 0) throw new Error(`SURFACE, LIBRARY and the definitions disagree on ${disagree.join(", ")}.`);
	return SEATS.map((seat) => {
		const direct = modelTools.filter((each) => SURFACE[each.name]!.includes(seat));
		const scripted: ToolRegistration[] = [];
		for (const each of library) {
			const entry = LIBRARY[each.name]!;
			if (!entry.seats.includes(seat)) continue;
			scripted.push(entry.inline ? { ...each, callers: ["tools"] } : { ...each, callers: ["tools"], deferred: true });
		}
		return defineExtension({ name: `seat-${seat}`, tools: [...direct, codemodeTool, ...scripted], sections: codemode.sections ?? [] });
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
