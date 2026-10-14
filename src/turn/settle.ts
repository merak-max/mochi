import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type ConversationId, defineTask, type Harness, LiveDoc, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { startFork } from "../agents/subagent.ts";
import { journaled } from "../journal.ts";
import type { Log } from "../log.ts";
import { forkPoint } from "../seats.ts";
import { UserDoc } from "./turn.ts";

// Compact a quiet thread while the provider's prompt cache is still warm, so the first message after a long break
// rewrites only the summary to the cache. Before root is compacted, a background fork of it saves what is worth
// keeping with `note`; its first request reads the still-warm cache.

export const SETTLE_AFTER_MS = 4 * 60_000;
export const SETTLE_MIN_TOKENS = 30_000;
export const LOOK_EVERY_MS = 30_000;

const REFLECT_BRIEF =
	"This conversation is about to be compacted, and its detail will be lost. Look back over it and save what is worth keeping with tools.note: " +
	"lasting facts about the owner, their people, projects and preferences, standing rules they gave, and corrections to notes that are now wrong. " +
	"Also put every open promise on the board with tools.board_add and a due: anything you or the owner said would happen later that board_list does not already show. " +
	"Update an existing note rather than adding a near-copy. Skip one-off tasks and anything already saved. Do not message anyone. " +
	"Answer with one line naming what you saved, or nothing new.";

type Thread = { readonly conversation: ConversationId; readonly lastAt: number; readonly tokens: number; readonly busy: boolean };

async function threadOf(tx: Tx, conversation: ConversationId): Promise<Thread | undefined> {
	const recent = (await tx.scanEntries({ conversationId: conversation }, 16)).items;
	for (const entry of recent) {
		if (entry.kind !== AssistantEntry.kind) continue;
		const message = entry.model?.[0];
		if (message?.role !== "assistant" || message.usage === undefined) continue;
		const { input, cacheRead, cacheWrite } = message.usage;
		const busy = (await tx.doc(LiveDoc, conversation)).run !== undefined;
		return { conversation, lastAt: message.timestamp, tokens: input + cacheRead + cacheWrite, busy };
	}
	return undefined;
}

export function due(thread: Thread, settled: number | undefined, now: number, cacheMs: number, minTokens = SETTLE_MIN_TOKENS): boolean {
	const quiet = now - thread.lastAt;
	return !thread.busy && thread.tokens >= minTokens && quiet >= SETTLE_AFTER_MS && quiet < cacheMs && settled !== thread.lastAt;
}

// `settled`: per thread, the turn time it was last compacted after, so one quiet spell compacts once.
type SettleState = { readonly phase: "settle"; readonly settled: Readonly<Record<string, number>>; readonly next: number };

export function defineSettle(deps: { readonly harness: () => Harness; readonly handles: readonly string[]; readonly cacheMs: number; readonly lookEveryMs: number; readonly minTokens: number; readonly reflect: boolean; readonly log: Log }) {
	return defineTask<null, SettleState, null>({
		name: "mochi.settle",
		version: 1,
		initial: () => ({ phase: "settle", settled: {}, next: 0 }),
		phases: {
			settle: async (task, runtime, context) => {
				await runtime.sleep(task.state.checkpoint.next, context);
				const harness = deps.harness();
				const threads = await harness.commit(async (tx) => {
					const ids = [ROOT_CONVERSATION_ID];
					for (const handle of deps.handles) {
						const { conversation } = await tx.doc(UserDoc, handle, null);
						if (conversation !== null) ids.push(conversation);
					}
					const found: Thread[] = [];
					for (const id of ids) {
						const thread = await threadOf(tx, id);
						if (thread !== undefined) found.push(thread);
					}
					return found;
				}, context);
				const settled = { ...task.state.checkpoint.settled };
				for (const thread of threads) {
					if (!due(thread, settled[thread.conversation], runtime.now(), deps.cacheMs, deps.minTokens)) continue;
					const conversation = await harness.conversation(thread.conversation, context);
					if (conversation === undefined) continue;
					if (deps.reflect && thread.conversation === ROOT_CONVERSATION_ID) {
						const { id, created } = await harness.commit(async (tx) => {
							const at = await forkPoint(tx, ROOT_CONVERSATION_ID);
							return journaled(tx, task.id, `reflect:${thread.lastAt}`, () => startFork(tx, ROOT_CONVERSATION_ID, at, { name: "reflect", brief: REFLECT_BRIEF }), 8);
						}, context);
						if (created) deps.log("thread.reflect", { conversation: thread.conversation, task: id });
					}
					await conversation.compact(undefined, context);
					settled[thread.conversation] = thread.lastAt;
					deps.log("thread.settled", { conversation: thread.conversation, tokens: thread.tokens, quietMs: runtime.now() - thread.lastAt });
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "settle", settled, next: runtime.now() + deps.lookEveryMs } }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

// A background task of the line, so no /stop reaches it.
export async function ensureSettle(harness: Harness, task: ReturnType<typeof defineSettle>, line: ConversationId, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const live = (await tx.scanTasks({ kind: "mochi.settle" }, 8)).items.some((each) => each.state.status !== "terminal" && !each.abortRequested);
		if (!live) await tx.createTask(task, null, { ownership: { kind: "conversation" }, conversationId: line, background: true });
	}, context);
}
