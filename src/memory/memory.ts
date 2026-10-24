import type { Context } from "@earendil-works/chord";
import { contentText, type Message, type TextContent, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineDocFamily,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	GenerationTask,
	type Harness,
	type HookApi,
	hook,
	section,
} from "@earendil-works/pi-durable";
import { allPages } from "../pages.ts";
import { pause } from "../pause.ts";
import { VIEW } from "./prompt.ts";
import { blocks, bytes, cover, HIGH, NODE, type Node, type Part, reach, SEEN, slot, span, type View, WAIT, whole, zoom } from "./view.ts";

// The transcript is the memory. pi-durable stores a conversation's messages; this doc holds the tree built over them
// and the view of it. Message i is the i-th non-system message of the conversation's model context, so the compactor,
// the request hook and zoom count the same messages. `start` is message 0's timestamp: a reset or a manual compaction
// starts a new context, and with it a new tree.

export type Tree = { start: number; count: number; nodes: Record<string, string>; view: View; seen: View };

export function freshTree(start: number): Tree {
	return {
		start,
		count: 0,
		nodes: {},
		view: { parts: [], size: 0, batch: false, high: HIGH },
		seen: { parts: [], size: 0, batch: false, high: SEEN },
	};
}

/** One tree per standing conversation (root, resident agents, user threads, peers), by conversation id. Children have none. */
export const ViewDoc = defineDocFamily<Tree, null>({
	kind: "mochi.view",
	version: 1,
	scope: "session",
	family: true,
	initial: () => freshTree(0),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

/** The messages the tree counts: the model context without its system messages. */
export const messagesOf = (messages: readonly Message[]): Message[] => messages.filter((message) => message.role !== "system");

/** A message as the view reads it, tagged by its kind. */
export function show(message: Message): string {
	if (message.role === "user") {
		const images = typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "image").length;
		return "user: " + contentText(message.content) + "\n[image]".repeat(images);
	}
	if (message.role === "assistant") {
		const lines: string[] = [];
		for (const part of message.content) {
			if (part.type === "text" && part.text.trim() !== "") lines.push("agent: " + part.text);
			if (part.type === "toolCall") lines.push("tool: " + part.name + " " + JSON.stringify(part.arguments));
		}
		return lines.length === 0 ? "agent: (no text)" : lines.join("\n");
	}
	if (message.role === "toolResult") return "echo: " + (message.isError ? "error: " : "") + contentText(message.content);
	return "";
}

/** Node (l,i): built, or message i itself when it fits in NODE bytes (uniichat stores those at once, with no call). */
export function nodeOf(tree: Pick<Tree, "nodes">, chat: readonly Message[]): Node {
	return (part: Part) => {
		const built = tree.nodes[String(slot(part.l, part.i))];
		if (built !== undefined) return built;
		if (part.l !== 0 || part.i >= chat.length) return null;
		const text = show(chat[part.i]!);
		return bytes(text) <= NODE ? text : null;
	};
}

/** How long a request waits for the view's lines before its tail to be built, as uniichat's settle does. */
const SETTLE_MS = 20_000;
const SETTLE_POLL_MS = 500;
/** View texts kept, one per tree and tail start. */
const FROZEN_MAX = 64;

/**
 * The first message of the tail: from the last user message among the first `limit` messages, cut to its last `high`
 * bytes as uniichat's `whole` does. It starts on a view line's first message and never on a tool result, so no line
 * is cut and every tool call keeps its result. A fork passes its fork point as `limit`, so its tail starts where its
 * parent's did.
 */
export function tailStart(chat: readonly Message[], tree: Readonly<Tree>, limit: number, high: number): number {
	const last = Math.max(chat.slice(0, limit).findLastIndex((message) => message.role === "user"), 0);
	let from = whole(chat.map((message) => bytes(show(message))), last, high);
	for (;;) {
		const before = from;
		const k = cover(tree.view.parts, from);
		if (k < tree.view.parts.length) from = Math.min(from, span(tree.view.parts[k]!)[0]);
		while (from > 0 && chat[from]!.role === "toolResult") from--;
		if (from === before) return from;
	}
}

/** The view's lines before message `from`, and whether one of them is not built yet. */
export function viewBefore(chat: readonly Message[], tree: Readonly<Tree>, from: number): { content: TextContent[]; waiting: boolean } {
	const node = nodeOf(tree, chat);
	const view: View = { ...tree.view, parts: [...tree.view.parts] };
	reach(view, node, from);
	const content: TextContent[] = blocks(view.parts, node, from).map((text) => ({ type: "text", text }));
	let waiting = false;
	for (const part of view.parts) {
		if (node(part) === null) waiting = true;
	}
	return { content, waiting };
}

/**
 * The view text sent for each tree and tail start. A request reuses it while its tail starts at the same message, so a
 * line built mid-turn does not change the prompt the turn already cached, and a fork sends its parent's view.
 */
const frozen = new Map<string, TextContent[]>();

function remember(key: string, content: TextContent[]): void {
	frozen.set(key, content);
	if (frozen.size > FROZEN_MAX) frozen.delete(frozen.keys().next().value!);
}

/** The request: the system messages as given, the view before the tail as one `<chat>` message, then the tail whole. */
async function request(messages: readonly Message[], source: ViewSource, api: HookApi, context: Context): Promise<Message[] | undefined> {
	const system = messages.filter((message) => message.role === "system");
	const chat = messagesOf(messages);
	if (chat.length === 0) return undefined;
	const limit = source.limit ?? chat.length;
	const deadline = Date.now() + SETTLE_MS;
	for (;;) {
		const tree = await api.snapshot(ViewDoc, String(source.owner), context);
		if (tree === undefined || chat[0]!.timestamp !== tree.start) return undefined;
		const from = tailStart(chat, tree, limit, HIGH);
		if (from === 0) return undefined;
		const key = source.owner + ":" + tree.start + ":" + from;
		let content = frozen.get(key);
		if (content === undefined) {
			const view = viewBefore(chat, tree, from);
			const settled = !view.waiting || Date.now() >= deadline || context.abortSignal?.aborted === true;
			if (!settled) {
				await pause(SETTLE_POLL_MS, context.abortSignal);
				continue;
			}
			content = view.content;
			remember(key, content);
		}
		return [...system, { role: "user", content, timestamp: tree.start }, ...chat.slice(from)];
	}
}

/** Whose tree a conversation's requests use, and for a fork, how many of its messages it shares with that tree. */
type ViewSource = { readonly owner: ConversationId; readonly limit?: number };

const forkSources = new Map<ConversationId, ViewSource | null>();

/** The non-system messages a fork took from its parent: those of its entries up to the fork point. */
async function inheritedCount(harness: Harness, id: ConversationId, at: EntryId, context: Context): Promise<number> {
	const view = await (await harness.conversation(id, context))!.context(context);
	let count = 0;
	view.entries.forEach((entry, k) => {
		if (entry.id <= at) count += messagesOf(view.contributions[k] ?? []).length;
	});
	return count;
}

/** A conversation's own tree, else its nearest forked-from ancestor's; null: none (a fresh child). */
async function viewSource(harness: Harness, api: HookApi, context: Context): Promise<ViewSource | null> {
	const id = api.conversationId;
	if ((await api.snapshot(ViewDoc, String(id), context)) !== undefined) return { owner: id };
	const known = forkSources.get(id);
	if (known !== undefined) return known;
	let found: ViewSource | null = null;
	const first = await harness.commit((tx) => tx.conversation(id), context);
	if (first?.parent !== undefined) {
		let ancestor: ConversationId | undefined = first.parent.conversationId;
		while (ancestor !== undefined) {
			if ((await api.snapshot(ViewDoc, String(ancestor), context)) !== undefined) {
				found = { owner: ancestor, limit: await inheritedCount(harness, id, first.parent.at, context) };
				break;
			}
			const record = await harness.commit((tx) => tx.conversation(ancestor!), context);
			ancestor = record?.parent?.conversationId;
		}
	}
	forkSources.set(id, found);
	return found;
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/** A child agent's whole chat: its own messages, after its fork point for a fork. */
async function agentChat(harness: Harness, caller: ConversationId, name: string, context: Context): Promise<string> {
	const child = await harness.commit(async (tx) => {
		const tasks = await allPages((cursor) => tx.scanTasks({ kind: "mochi.agent", conversationId: caller }, 256, cursor));
		const task = tasks.findLast((each) => (each.input as { name?: string }).name === name);
		if (task === undefined) return undefined;
		return (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
	}, context);
	if (child === undefined) return `No agent ${name} here.`;
	const view = await (await harness.conversation(child.id, context))!.context(context);
	const after = child.parent?.at ?? 0;
	const lines: string[] = [];
	view.entries.forEach((entry, k) => {
		if (entry.id <= after) return;
		for (const message of messagesOf(view.contributions[k] ?? [])) lines.push(lines.length + "|" + show(message));
	});
	return lines.length === 0 ? `Agent ${name} has no messages yet.` : lines.join("\n\n");
}

export function zoomTool(harness: () => Harness) {
	return defineTool({
		name: "zoom",
		description: "Open line id+n of your view into the two lines it was made from; n: 1 gives message id whole. name gives a child agent's whole chat.",
		parameters: Type.Object({
			id: Type.Optional(Type.Integer({ minimum: 0 })),
			n: Type.Optional(Type.Integer({ minimum: 1 })),
			name: Type.Optional(Type.String({ minLength: 1 })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			if (args.name !== undefined) return text(await agentChat(harness(), api.conversationId, args.name, context));
			if (args.id === undefined || args.n === undefined) throw new Error("Pass id and n as a view line prints them (id+n), or name.");
			const view = await (await harness().conversation(api.conversationId, context))!.context(context);
			const chat = messagesOf(view.messages);
			const tree = await api.snapshot(ViewDoc, String(api.conversationId), context);
			const node = nodeOf(tree !== undefined && tree.start === chat[0]?.timestamp ? tree : { nodes: {} }, chat);
			return text(zoom(node, (i) => show(chat[i]!), chat.length, args.id, args.n));
		},
	});
}

const MAX_BREAKPOINTS = 4;

type WireBlock = { type: string; text?: string; cache_control?: unknown };
type WireMessage = { role: string; content: unknown };
type WirePayload = { system?: WireBlock[]; tools?: WireBlock[]; messages?: WireMessage[] };

function countBreakpoints(payload: WirePayload): number {
	let count = 0;
	const lists: unknown[] = [payload.system, payload.tools];
	for (const message of payload.messages ?? []) lists.push(message.content);
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const block of list as WireBlock[]) {
			if (block.cache_control !== undefined) count++;
		}
	}
	return count;
}

/**
 * An Anthropic Messages payload with a cache breakpoint on the view's last whole block before its first line not built
 * (uniichat's mark). The view changes only at its end between batches, so the lines before the mark stay cached
 * when the tail moves. Any other payload comes back unchanged.
 */
export function markView(payload: unknown): unknown {
	const wire = payload as WirePayload;
	const view = wire.messages?.find((message) => {
		const first = Array.isArray(message.content) ? (message.content as WireBlock[])[0] : undefined;
		return message.role === "user" && first?.type === "text" && first.text === "<chat>\n";
	});
	if (view === undefined) return undefined;
	const content = view.content as WireBlock[];
	let marked = -1;
	for (let k = 1; k < content.length - 1; k++) {
		if (content[k]!.text?.includes(WAIT)) break;
		marked = k;
	}
	if (marked === -1) return undefined;
	if (content[marked]!.cache_control !== undefined) return undefined;
	if (countBreakpoints(wire) >= MAX_BREAKPOINTS) return undefined;
	content[marked]!.cache_control = { type: "ephemeral" };
	return payload;
}

/** The extension that holds the view. It keeps the name the stored conversations already select. */
const VIEW_EXTENSION = "notes";

/**
 * The memory section and the request hook. A fork sends its parent's view; a fresh child, with no tree to share, sends
 * its context as it is.
 */
export function memoryExtension(harness: () => Harness): Extension {
	return defineExtension({
		name: VIEW_EXTENSION,
		sections: [section("memory", () => VIEW)],
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async ({ messages }, api, context) => {
					const source = await viewSource(harness(), api, context);
					if (source === null) return undefined;
					const replaced = await request(messages, source, api, context);
					return replaced === undefined ? undefined : { messages: replaced };
				},
			}),
		],
	});
}
