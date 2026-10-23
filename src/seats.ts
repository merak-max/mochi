import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type ConversationId,
	type ConversationOwnership,
	type EntryId,
	defineExtension,
	type Extension,
	type ModelRef,
	type PromptSection,
	ROOT_CONVERSATION_ID,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

/**
 * A seat is how far a conversation is trusted, stored in its agent and written only here.
 *   agent    root, every fork of it and every profile. A fork has its parent's tools and prompt, so it reuses its
 *            parent's prompt cache, and forks can fork at any depth.
 *   trigger  a trigger run. It reads outside data (webhook bodies, mail), so it cannot write notes, fork, add
 *            triggers or change profiles. It reaches the owner only with notify.
 *   peer     another agent's requests over A2A. It works with the owner's apps and answers; nothing else.
 *   user     a user's iMessage thread. Its reply goes to the user; it has no owner notes and reaches no owner channel.
 */
const SEATS = ["agent", "trigger", "peer", "user"] as const;
type Seat = (typeof SEATS)[number];

const ALL = SEATS;
const AGENT: readonly Seat[] = ["agent"];
const AGENT_TRIGGER: readonly Seat[] = ["agent", "trigger"];
/** A user's thread never reaches the owner's apps: the apps server's approvals are accepted without asking. */
const NOT_USER: readonly Seat[] = ["agent", "trigger", "peer"];

/** The tools the model calls directly, and the seats that get each. Their `control` (handoff, terminate) works only on a model-issued call. */
const SURFACE: Readonly<Record<string, readonly Seat[]>> = {
	codemode: ALL,
	notify: AGENT_TRIGGER,
	handoff: ["agent", "user"],
};

/** Every tool scripts call as `tools.<name>`, and the seats that get it. The `codemode` section declares the inline ones; scripts find the rest with `searchTools()`. */
const LIBRARY: Readonly<Record<string, { readonly seats: readonly Seat[]; readonly inline: boolean }>> = {
	read: { seats: ALL, inline: true },
	bash: { seats: ALL, inline: true },
	edit: { seats: ALL, inline: true },
	write: { seats: ALL, inline: true },
	find: { seats: ALL, inline: true },
	grep: { seats: ALL, inline: true },
	recall: { seats: ALL, inline: true },
	history: { seats: NOT_USER, inline: false },
	note: { seats: AGENT, inline: true },
	zoom: { seats: NOT_USER, inline: true },
	react: { seats: AGENT, inline: true },
	send: { seats: AGENT, inline: true },
	web_search: { seats: ALL, inline: true },
	web_fetch: { seats: ALL, inline: true },
	llm: { seats: ALL, inline: true },
	context_read: { seats: ALL, inline: true },
	context_put: { seats: ALL, inline: true },
	context_list: { seats: ALL, inline: false },
	agent: { seats: AGENT, inline: true },
	apps_search: { seats: NOT_USER, inline: true },
	apps_call: { seats: NOT_USER, inline: true },
	fork: { seats: AGENT, inline: true },
	fork_start: { seats: AGENT, inline: false },
	trigger_add: { seats: AGENT, inline: true },
	trigger_list: { seats: AGENT_TRIGGER, inline: true },
	trigger_remove: { seats: AGENT_TRIGGER, inline: false },
	web_map: { seats: ALL, inline: false },
	web_find_tools: { seats: ALL, inline: false },
	web_alexandria: { seats: ALL, inline: false },
	classify: { seats: ALL, inline: false },
	apps_skills: { seats: NOT_USER, inline: false },
	browse: { seats: ALL, inline: false },
	browse_fast: { seats: ALL, inline: false },
	image_gen: { seats: ALL, inline: false },
	video_gen: { seats: ALL, inline: false },
	speak: { seats: ALL, inline: false },
	gif_search: { seats: ALL, inline: false },
	gif_save: { seats: ALL, inline: false },
	transcribe: { seats: ALL, inline: false },
	message: { seats: AGENT, inline: false },
	proc_start: { seats: AGENT_TRIGGER, inline: false },
	proc_status: { seats: AGENT_TRIGGER, inline: false },
	proc_logs: { seats: AGENT_TRIGGER, inline: false },
	proc_stop: { seats: AGENT_TRIGGER, inline: false },
	a2a_list: { seats: AGENT_TRIGGER, inline: false },
	a2a_ask: { seats: AGENT_TRIGGER, inline: false },
	a2a_send: { seats: AGENT_TRIGGER, inline: false },
	a2a_status: { seats: AGENT_TRIGGER, inline: false },
	board_add: { seats: AGENT, inline: true },
	board_list: { seats: AGENT, inline: false },
	board_update: { seats: AGENT, inline: false },
	board_claim: { seats: AGENT, inline: false },
	profile_list: { seats: AGENT, inline: false },
	profile_send: { seats: AGENT, inline: true },
	profile_update: { seats: AGENT, inline: false },
	profile_stop: { seats: AGENT, inline: false },
};

const SHARED = ["identity", "notes", "skills", "fast-compaction"];

/** The extensions a seat's agent names. Owner notes describe the owner, so a user's thread leaves them out. */
function selection(seat: Seat): string[] {
	const shared = seat === "user" ? SHARED.filter((name) => name !== "notes") : SHARED;
	return [...shared, `seat-${seat}`];
}

const drift = (names: readonly string[], table: object): string[] => [...names.filter((name) => !Object.hasOwn(table, name)), ...Object.keys(table).filter((name) => !names.includes(name))];

/** Longest script run, set when a script names no `timeout_ms` of its own. */
const SCRIPT_DEADLINE_MS = 10 * 60_000;
const SCRIPT_MEMORY_BYTES = 256 * 1024 * 1024;

/** A script with no options line gets the default deadline, so a hung call never holds a turn forever. */
function withDeadline(code: string): string {
	if (code.trimStart().startsWith("// @options:")) return code;
	return `// @options: {"timeout_ms": ${SCRIPT_DEADLINE_MS}}\n${code}`;
}

/**
 * One `seat-<seat>` extension per seat: its model tools, `codemode` with its prompt section, and the library tools its
 * scripts may call. Throws when the tables and the definitions disagree.
 */
export function seatExtensions(modelTools: readonly ToolRegistration[], library: readonly ToolRegistration[], agentSections: readonly PromptSection[], everySeat: readonly PromptSection[]): Extension[] {
	const codemode = createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: SCRIPT_MEMORY_BYTES }), models: false });
	const tool = codemode.tools![0]!;
	const codemodeTool: ToolRegistration = { ...tool, execute: (args, api, context) => tool.execute({ code: withDeadline((args as { code: string }).code) }, api, context) };
	const disagree = [...drift([...modelTools.map((each) => each.name), "codemode"], SURFACE), ...drift(library.map((each) => each.name), LIBRARY)];
	if (disagree.length > 0) throw new Error(`SURFACE, LIBRARY and the definitions disagree on ${disagree.join(", ")}.`);
	return SEATS.map((seat) => {
		// handoff's `control` works only on a model-issued call, so scripts do not see it. notify sends from a script too;
		// only its early end of the run is lost there, and trigger runs have alerted the owner from scripts.
		const direct = modelTools.filter((each) => SURFACE[each.name]!.includes(seat)).map((each): ToolRegistration => (each.name === "handoff" ? { ...each, callers: ["model"] } : each));
		const scripted: ToolRegistration[] = [];
		for (const each of library) {
			const entry = LIBRARY[each.name]!;
			if (!entry.seats.includes(seat)) continue;
			scripted.push(entry.inline ? { ...each, callers: ["tools"] } : { ...each, callers: ["tools"], deferred: true });
		}
		const sections = seat === "agent" ? [...agentSections, ...(codemode.sections ?? []), ...everySeat] : [...(codemode.sections ?? []), ...everySeat];
		return defineExtension({ name: `seat-${seat}`, tools: [...direct, codemodeTool, ...scripted], sections });
	});
}

/** The host default, for anything that reaches a conversation without a seat: the least capable one. */
export const defaultSelection = (installed: (name: string) => Extension | undefined): Extension[] => selection("user").flatMap((name) => installed(name) ?? []);

/** Root's extensions, set when the harness creates root; an existing root keeps its stored ones. */
export const rootSelection = (installed: (name: string) => Extension | undefined): Extension[] => selection("agent").flatMap((name) => installed(name) ?? []);

interface SeatChange {
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

/** The entry a fork made now would start after: the parent's newest. Read it before the commit's first write. */
export async function forkPoint(tx: Tx, parent: ConversationId): Promise<EntryId> {
	const newest = (await tx.scanEntries({ conversationId: parent }, 1)).items[0];
	if (newest === undefined) throw new Error("There is nothing to fork yet.");
	return newest.id;
}
