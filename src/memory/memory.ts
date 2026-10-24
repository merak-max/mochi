import type { Context } from "@earendil-works/chord";
import { contentText, type Message, type TextContent, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineDocFamily,
	defineExtension,
	defineTool,
	type Extension,
	GenerationTask,
	type Harness,
	hook,
	section,
} from "@earendil-works/pi-durable";
import { allPages } from "../pages.ts";
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

/**
 * The request: the system messages as given, the view before the tail as one `<chat>` message, then the tail whole.
 * The tail runs from the last user message, cut to its last `high` bytes as uniichat's `whole` does. It starts on a
 * view line's first message and never on a tool result, so no line is cut and every tool call keeps its result.
 */
function request(messages: readonly Message[], tree: Readonly<Tree>, high: number): Message[] | undefined {
	const system = messages.filter((message) => message.role === "system");
	const chat = messagesOf(messages);
	if (chat.length === 0 || chat[0]!.timestamp !== tree.start) return undefined;
	const node = nodeOf(tree, chat);
	const view: View = { ...tree.view, parts: [...tree.view.parts] };
	const last = Math.max(chat.findLastIndex((message) => message.role === "user"), 0);
	let from = whole(chat.map((message) => bytes(show(message))), last, high);
	for (;;) {
		const before = from;
		const k = cover(view.parts, from);
		if (k < view.parts.length) from = Math.min(from, span(view.parts[k]!)[0]);
		while (from > 0 && chat[from]!.role === "toolResult") from--;
		if (from === before) break;
	}
	if (from === 0) return undefined;
	reach(view, node, from);
	const content: TextContent[] = blocks(view.parts, node, from).map((text) => ({ type: "text", text }));
	return [...system, { role: "user", content, timestamp: tree.start }, ...chat.slice(from)];
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
 * The memory section and the request hook. A conversation with no tree (a child) sends its context
 * as it is.
 */
export function memoryExtension(): Extension {
	return defineExtension({
		name: VIEW_EXTENSION,
		sections: [section("memory", () => VIEW)],
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async ({ messages }, api, context) => {
					const tree = await api.snapshot(ViewDoc, String(api.conversationId), context);
					if (tree === undefined) return undefined;
					const replaced = request(messages, tree, HIGH);
					return replaced === undefined ? undefined : { messages: replaced };
				},
			}),
		],
	});
}
