import {
	AgentDoc,
	type ConversationId,
	type ConversationOwnership,
	type EntryId,
	defineExtension,
	type Extension,
	type PromptSection,
	ROOT_CONVERSATION_ID,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { type CodemodeNamespace, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

/**
 * A seat is how far a conversation is trusted, stored in its agent and written only here.
 *   agent    root, every fork of it and every agent definition. A fork has its parent's tools and prompt, so it reuses its
 *            parent's prompt cache, and forks can fork at any depth.
 *   peer     the line, which holds delivery tasks. It works with the owner's MCP servers and answers; nothing else.
 *   user     a user's iMessage thread. Its reply goes to the user; it has no owner notes and reaches no owner channel.
 */
export const SEATS = ["agent", "peer", "user"] as const;
type Seat = (typeof SEATS)[number];

const ALL = SEATS;
const AGENT: readonly Seat[] = ["agent"];
/** A user's thread never reaches the owner's MCP servers: their approvals are accepted without asking. */
const MCP_SEATS: readonly Seat[] = ["agent", "peer"];

/** The tools the model calls directly, and the seats that get each. Their `control` (handoff, terminate) works only on a model-issued call. */
const SURFACE: Readonly<Record<string, readonly Seat[]>> = {
	codemode: ALL,
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
	zoom: { seats: ALL, inline: true },
	react: { seats: AGENT, inline: true },
	send: { seats: AGENT, inline: true },
	web_search: { seats: ALL, inline: true },
	web_fetch: { seats: ALL, inline: true },
	llm: { seats: ALL, inline: true },
	context_read: { seats: ALL, inline: true },
	context_put: { seats: ALL, inline: true },
	context_list: { seats: ALL, inline: false },
	agent: { seats: AGENT, inline: true },
	board_add: { seats: AGENT, inline: true },
	board_list: { seats: AGENT, inline: true },
	board_done: { seats: AGENT, inline: true },
	web_map: { seats: ALL, inline: false },
	web_find_tools: { seats: ALL, inline: false },
	web_alexandria: { seats: ALL, inline: false },
	classify: { seats: ALL, inline: false },
	browse: { seats: ALL, inline: false },
	browse_fast: { seats: ALL, inline: false },
	image_gen: { seats: ALL, inline: false },
	video_gen: { seats: ALL, inline: false },
	speak: { seats: ALL, inline: false },
	gif_search: { seats: ALL, inline: false },
	gif_save: { seats: ALL, inline: false },
	transcribe: { seats: ALL, inline: false },
	message: { seats: AGENT, inline: false },
	proc_start: { seats: AGENT, inline: false },
	proc_status: { seats: AGENT, inline: false },
	proc_logs: { seats: AGENT, inline: false },
	proc_stop: { seats: AGENT, inline: false },
	agent_stop: { seats: AGENT, inline: false },
	tools_reload: { seats: AGENT, inline: false },
};

/** `notes` holds the view: every seat's conversation reads its own chat through it. */
const SHARED = ["identity", "notes", "skills"];

/** The extensions a seat's agent names. */
function selection(seat: Seat): string[] {
	return [...SHARED, `seat-${seat}`];
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

/** One MCP server as scripts see it: the namespace `<name>` with the server's instructions, and its `<name>_<tool>` tools. */
export interface McpTools {
	readonly name: string;
	readonly instructions: string | undefined;
	readonly tools: readonly ToolRegistration[];
}

/** What changes while the daemon runs: the owner's home tools (agent seat only) and the MCP servers that are up. */
export interface LiveTools {
	readonly home: readonly ToolRegistration[];
	readonly mcp: readonly McpTools[];
}

function codemodeFor(servers: readonly McpTools[]): Extension {
	const namespaces: CodemodeNamespace[] = servers.map((server) => ({
		name: server.name,
		prefix: `${server.name}_`,
		description: `Tools of the MCP server ${server.name}. describeNamespace("${server.name}") returns its instructions.`,
		...(server.instructions === undefined ? {} : { instructions: server.instructions }),
	}));
	return createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: SCRIPT_MEMORY_BYTES }), models: false, namespaces });
}

/**
 * Builds the `seat-<seat>` extension: its model tools, `codemode` with its prompt section, the library tools its scripts
 * may call, the MCP tools for MCP_SEATS, and for the agent seat the owner's home tools. Throws when the tables and the
 * definitions disagree.
 */
export function seatExtensions(modelTools: readonly ToolRegistration[], library: readonly ToolRegistration[], agentSections: readonly PromptSection[], everySeat: readonly PromptSection[]): (seat: Seat, live: LiveTools) => Extension {
	const disagree = [...drift([...modelTools.map((each) => each.name), "codemode"], SURFACE), ...drift(library.map((each) => each.name), LIBRARY)];
	if (disagree.length > 0) throw new Error(`SURFACE, LIBRARY and the definitions disagree on ${disagree.join(", ")}.`);
	return (seat, live) => {
		const servers = MCP_SEATS.includes(seat) ? live.mcp : [];
		const codemode = codemodeFor(servers);
		const tool = codemode.tools![0]!;
		const codemodeTool: ToolRegistration = { ...tool, execute: (args, api, context) => tool.execute({ code: withDeadline((args as { code: string }).code) }, api, context) };
		const direct = modelTools.filter((each) => SURFACE[each.name]!.includes(seat)).map((each): ToolRegistration => (each.name === "handoff" ? { ...each, callers: ["model"] } : each));
		const scripted: ToolRegistration[] = [];
		for (const each of library) {
			const entry = LIBRARY[each.name]!;
			if (!entry.seats.includes(seat)) continue;
			scripted.push(entry.inline ? { ...each, callers: ["tools"] } : { ...each, callers: ["tools"], deferred: true });
		}
		const sections = seat === "agent" ? [...agentSections, ...(codemode.sections ?? []), ...everySeat] : [...(codemode.sections ?? []), ...everySeat];
		const home = seat === "agent" ? live.home : [];
		const mcp = servers.flatMap((server) => server.tools);
		return defineExtension({ name: `seat-${seat}`, tools: [...direct, codemodeTool, ...scripted, ...mcp, ...home], sections });
	};
}

/** The host default, for anything that reaches a conversation without a seat: the least capable one. */
export const defaultSelection = (installed: (name: string) => Extension | undefined): Extension[] => selection("user").flatMap((name) => installed(name) ?? []);

/** Root's extensions, set when the harness creates root; an existing root keeps its stored ones. */
export const rootSelection = (installed: (name: string) => Extension | undefined): Extension[] => selection("agent").flatMap((name) => installed(name) ?? []);

/**
 * The only creator of conversations. A task-owned conversation would copy its owner's agent and an ownerless one would
 * have no model, so this replaces the whole agent with root's model and thinking level and the seat, in the creating commit.
 */
export async function createSeatConversation(tx: Tx, seat: Seat, ownership: ConversationOwnership, instructions?: string): Promise<ConversationId> {
	const { id } = await tx.createConversation({ ownership });
	const root = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID);
	const agent = await tx.doc(AgentDoc, id);
	for (const key of Object.keys(agent) as (keyof typeof agent)[]) delete agent[key];
	if (root.model !== undefined) agent.model = { ...root.model };
	if (root.thinkingLevel !== undefined) agent.thinkingLevel = root.thinkingLevel;
	agent.extensions = selection(seat);
	if (instructions !== undefined) agent.instructions = instructions;
	return id;
}

/** The entry a fork made now would start after: the parent's newest. Read it before the commit's first write. */
export async function forkPoint(tx: Tx, parent: ConversationId): Promise<EntryId> {
	const newest = (await tx.scanEntries({ conversationId: parent }, 1)).items[0];
	if (newest === undefined) throw new Error("There is nothing to fork yet.");
	return newest.id;
}
