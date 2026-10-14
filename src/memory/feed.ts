import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type ConversationId, type EntryRecord, type Harness, UserEntry } from "@earendil-works/pi-durable";
import type { IndexDoc, SearchIndex } from "../index/fts.ts";
import { allPages } from "../pages.ts";
import { pause } from "../pause.ts";
import { messageText } from "../text.ts";
import type { FastCompletion } from "../turn/lifecycle.ts";
import { maintain, MemoryLog } from "./memory.ts";

const PAGE = 200;
const RETRY_MS = 5000;

/**
 * Subscribes to commits, then catches up, then for each conversation a commit appended entries to: indexes its chat text
 * and folds its turns into memory, until `context` aborts. Subscribing first means no commit falls between the catch-up
 * and the live feed.
 */
export async function runFeed(harness: Harness, index: SearchIndex, fast: FastCompletion, context: Context, onError: (error: unknown) => void): Promise<void> {
	const signal = context.abortSignal;
	const aborted = (): boolean => signal?.aborted === true;
	const dirty = new Set<ConversationId>();
	let wake = (): void => {};
	const unsubscribe = harness.subscribeCommits(({ changes }) => {
		for (const change of changes) if (change.type === "entry") dirty.add(change.value.conversationId);
		if (dirty.size > 0) wake();
	});
	const stop = (): void => wake();
	signal?.addEventListener("abort", stop);
	let all = true;
	try {
		while (!aborted()) {
			const marked = [...dirty];
			dirty.clear();
			try {
				const conversations = all ? await allConversations(harness, context) : marked;
				for (const conversation of conversations) await indexConversation(harness, index, conversation, context);
				await maintain(harness, fast, conversations, context);
				index.replaceMemory((await harness.snapshot(MemoryLog, context))?.lines ?? []);
				all = false;
			} catch (error) {
				if (aborted()) return;
				onError(error);
				all = true;
				await pause(RETRY_MS, signal);
				continue;
			}
			if (dirty.size === 0) await new Promise<void>((resolve) => (wake = resolve));
		}
	} finally {
		unsubscribe();
		signal?.removeEventListener("abort", stop);
	}
}

async function indexConversation(harness: Harness, index: SearchIndex, conversation: ConversationId, context: Context): Promise<number> {
	const entries = await entriesAfter(harness, conversation, index.cursor(conversation), context);
	if (entries.length === 0) return 0;
	const docs = entries.flatMap(toDoc);
	index.addEntries(conversation, docs, Math.max(...entries.map((entry) => entry.id)));
	return docs.length;
}

async function allConversations(harness: Harness, context: Context): Promise<ConversationId[]> {
	return (await allPages((cursor) => harness.commit((tx) => tx.scanConversations({}, PAGE, cursor), context))).map((record) => record.id);
}

/** Oldest first. */
async function entriesAfter(harness: Harness, conversationId: ConversationId, after: number, context: Context): Promise<EntryRecord[]> {
	const query = { conversationId, minEntryId: (after + 1) as EntryRecord["id"] };
	const entries = await allPages((cursor) => harness.commit((tx) => tx.scanEntries(query, PAGE, cursor), context));
	return entries.filter((entry) => entry.conversationId === conversationId).reverse();
}

function toDoc(entry: EntryRecord): IndexDoc[] {
	const message = entry.model?.[0];
	if (message === undefined) return [];
	const kind = UserEntry.is(entry) ? "user" : AssistantEntry.is(entry) ? "assistant" : undefined;
	if (kind === undefined) return [];
	const text = messageText(message).trim();
	if (text === "") return [];
	return [{ text, kind, ref: String(entry.id), at: new Date(message.timestamp).toISOString() }];
}
