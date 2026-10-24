import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { Log } from "../log.ts";
import { allPages } from "../pages.ts";
import { pause } from "../pause.ts";
import type { FastCompletion } from "../turn/lifecycle.ts";
import { freshTree, messagesOf, nodeOf, show, type Tree, ViewDoc } from "./memory.ts";
import { COMPACTION } from "./prompt.ts";
import { blocks, bytes, ctx, fit, NODE, type Node, over, size, slot, source, task, todo, TRIES } from "./view.ts";

const FIRST_DELAY_MS = 5_000;
const MAX_DELAY_MS = 5 * 60_000;
const NOTIFY_AFTER_MS = 30 * 60_000;

interface CompactorDeps {
	readonly harness: Harness;
	/** The memory model. */
	readonly complete: FastCompletion;
	readonly log: Log;
	/** Tells the owner, once per outage, that memory stopped being written. */
	readonly notify: (text: string, context: Context) => Promise<void>;
	readonly now: () => number;
}

/** The first message whose node is not built: the compactions' view reaches only this far. */
function firstUnbuilt(node: Node, count: number): number {
	for (let i = 0; i < count; i++) {
		if (node({ l: 0, i }) === null) return i;
	}
	return count;
}

/**
 * The messages that will not change: up to the first tool result pi-durable synthesized for a call still running. Its
 * real result replaces it, and messages that came meanwhile move after that result.
 */
function settled(chat: readonly Message[]): Message[] {
	const open = chat.findIndex((message) => message.role === "toolResult" && (message.details as { reason?: string } | undefined)?.reason === "missing_result");
	return open === -1 ? [...chat] : chat.slice(0, open);
}

/** Both views to the messages, their sizes counted anew: a line built since it joined a view now has bytes. */
function fitBoth(tree: Tree, node: Node, next: boolean): void {
	for (const [view, to] of [[tree.view, tree.count], [tree.seen, firstUnbuilt(node, tree.count)]] as const) {
		let total = 0;
		for (const part of view.parts) total += size(node, part);
		view.size = total;
		fit(view, node, to, next);
	}
}

/** Node (l,i)'s line: its view to the node and its task, asked till a line fits, TRIES lines at most, the shortest kept. */
async function compact(deps: CompactorDeps, tree: Readonly<Tree>, node: Node, l: number, i: number, input: string, context: Context): Promise<string> {
	const upto = Math.min(ctx(l, i), firstUnbuilt(node, tree.count));
	const prompt = blocks(tree.seen.parts, node, upto).join("") + task(l, i) + input + "\n</input>";
	const lines: string[] = [];
	let note = "";
	while (lines.length < TRIES) {
		const line = (await deps.complete({ system: COMPACTION, prompt: prompt + note }, context)).trim();
		lines.push(line);
		if (bytes(line) <= NODE) break;
		note = "\n" + over(line);
	}
	let shortest = lines[0]!;
	for (const line of lines) {
		if (bytes(line) < bytes(shortest)) shortest = line;
	}
	return shortest;
}

/**
 * Brings one conversation's tree to its messages, then builds its due nodes oldest first, one commit per node, so a
 * crash resumes at the next missing node. A reset or a compaction starts a new context: its first message differs.
 */
async function build(deps: CompactorDeps, id: ConversationId, context: Context): Promise<number> {
	const { harness } = deps;
	const key = String(id);
	const conversation = await harness.conversation(id, context);
	if (conversation === undefined) return 0;
	let built = 0;
	for (;;) {
		const chat = settled(messagesOf((await conversation.context(context)).messages));
		if (chat.length === 0) return built;
		const tree = await harness.commit(async (tx) => {
			const doc = await tx.doc(ViewDoc, key, null);
			if (doc.start !== chat[0]!.timestamp || doc.count > chat.length) {
				const fresh = freshTree(chat[0]!.timestamp);
				doc.start = fresh.start;
				doc.count = 0;
				doc.nodes = fresh.nodes;
				doc.view = fresh.view;
				doc.seen = fresh.seen;
			}
			const plain = JSON.parse(JSON.stringify(doc)) as Tree;
			const node = nodeOf(plain, chat);
			const arrived = chat.length > plain.count;
			plain.count = chat.length;
			fitBoth(plain, node, arrived);
			doc.count = plain.count;
			doc.view = plain.view;
			doc.seen = plain.seen;
			return plain;
		}, context);
		const node = nodeOf(tree, chat);
		const next = todo(node, tree.count)[0];
		if (next === undefined) return built;
		const input = source(node, (i) => show(chat[i]!), next.l, next.i)!;
		const line = bytes(input) <= NODE ? input : await compact(deps, tree, node, next.l, next.i, input, context);
		await harness.commit(async (tx) => {
			const doc = await tx.doc(ViewDoc, key, null);
			if (doc.start !== tree.start) return;
			doc.nodes[String(slot(next.l, next.i))] = line;
			const plain = JSON.parse(JSON.stringify(doc)) as Tree;
			const after = nodeOf(plain, chat);
			fitBoth(plain, after, false);
			doc.view = plain.view;
			doc.seen = plain.seen;
		}, context);
		built++;
	}
}

/** Root and the standing conversations keep a tree. A child does not, nor an old trigger-run conversation, which the store still holds. */
async function standing(harness: Harness, id: ConversationId, context: Context): Promise<boolean> {
	const record = await harness.commit((tx) => tx.conversation(id), context);
	if (record === undefined || record.owner !== undefined) return false;
	const extensions = (await harness.snapshot(AgentDoc, id, context))?.extensions;
	return !(Array.isArray(extensions) && extensions.includes("seat-trigger"));
}

/**
 * The compactor: after commits that add entries, builds the due nodes of each standing conversation on the memory
 * model. A failed pass waits, from 5 s doubling to 5 min, and runs again. After 30 minutes of failing it tells the
 * owner once, and again only after it has worked in between. Runs until `context` aborts.
 */
export async function runCompactor(deps: CompactorDeps, context: Context): Promise<void> {
	const { harness, log } = deps;
	const signal = context.abortSignal;
	const aborted = (): boolean => signal?.aborted === true;
	const dirty = new Set<ConversationId>();
	const kept = new Map<ConversationId, boolean>();
	let wake = (): void => {};
	const unsubscribe = harness.subscribeCommits(({ changes }) => {
		for (const change of changes) {
			if (change.type === "entry") dirty.add(change.value.conversationId);
		}
		if (dirty.size > 0) wake();
	});
	const stop = (): void => wake();
	signal?.addEventListener("abort", stop);
	let all = true;
	let delay = FIRST_DELAY_MS;
	let failingSince: number | undefined;
	let notified = false;
	try {
		while (!aborted()) {
			const marked = [...dirty];
			dirty.clear();
			try {
				const ids = all ? (await allPages((cursor) => harness.commit((tx) => tx.scanConversations({}, 256, cursor), context))).map((record) => record.id) : marked;
				for (const id of ids) {
					if (!kept.has(id)) kept.set(id, await standing(harness, id, context));
					if (!kept.get(id)) continue;
					const built = await build(deps, id, context);
					if (built > 0) log("view.built", { conversation: id, nodes: built });
				}
				all = false;
				delay = FIRST_DELAY_MS;
				failingSince = undefined;
				notified = false;
			} catch (error) {
				if (aborted()) return;
				failingSince ??= deps.now();
				log("view.failed", { error: String(error), retryMs: delay });
				if (!notified && deps.now() - failingSince >= NOTIFY_AFTER_MS) {
					notified = true;
					await deps.notify(`Memory is not being written: the compactor has failed for 30 minutes. Last error: ${String(error)}`, context).catch((notifyError: unknown) => log("view.notify_failed", { error: String(notifyError) }));
				}
				all = true;
				await pause(delay, signal);
				delay = Math.min(delay * 2, MAX_DELAY_MS);
				continue;
			}
			if (dirty.size === 0) await new Promise<void>((resolve) => (wake = resolve));
		}
	} finally {
		unsubscribe();
		signal?.removeEventListener("abort", stop);
	}
}
