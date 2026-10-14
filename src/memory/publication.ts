import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineTask, type Harness, type ConversationId, ROOT_CONVERSATION_ID, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { createMemoryConversation } from "../seats.ts";
import type { Note } from "../notes/schema.ts";
import type { Memory } from "./memory.ts";
import { MemoryDoc } from "./memory.ts";
import { type Files, MemoryGit, type PublicationPlan, renderRepo } from "./repo.ts";

type Revision = { revision: number; key: string; at: number; memory: Memory };
type Receipt = { note: Note | null };
type RepoState = {
	repo: string | null; changed: number; next: number; published: number; head: string | null;
	files: Files; queue: Revision[]; receipts: Record<string, Receipt>;
	pending: { revision: number; plan: PublicationPlan } | null;
	task: TaskId | null; conversation: ConversationId | null; blocked: string | null;
};
export const RepoDoc = defineDoc<RepoState>({
	kind: "mochi.memory-repo", version: 1, scope: "session",
	initial: () => ({ repo: null, changed: 0, next: 0, published: 0, head: null, files: {}, queue: [], receipts: {}, pending: null, task: null, conversation: null, blocked: null }),
});

export async function replayed(tx: Tx, key: string | undefined): Promise<Receipt | undefined> {
	if (key === undefined) return undefined;
	const state = await tx.doc(RepoDoc);
	if (!Object.hasOwn(state.receipts, key)) return undefined;
	const receipt: Receipt = JSON.parse(JSON.stringify(state.receipts[key]));
	return receipt;
}
export async function memoryChanged(tx: Tx, memory: Memory, note: Note | undefined, key?: string, at = Date.now()): Promise<void> {
	const state = await tx.doc(RepoDoc);
	state.changed++;
	if (key !== undefined) state.receipts[key] = { note: note ?? null };
	if (state.repo !== null) await ensurePublisher(tx, state);
	await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "mochi.memory-change", data: { at } });
	if (state.repo === null) return;
	const revision = ++state.next;
	state.queue.push({ revision, key: key ?? `revision:${revision}`, at, memory: JSON.parse(JSON.stringify(memory)) });
}

const publisherChecked = new WeakSet<Tx>();
async function ensurePublisher(tx: Tx, state: RepoState): Promise<void> {
	if (publisherChecked.has(tx)) return;
	publisherChecked.add(tx);
	if (state.task !== null) {
		const task = await tx.task(state.task);
		if (task !== undefined && task.state.status !== "terminal" && !task.abortRequested) return;
	}
	state.conversation ??= await createMemoryConversation(tx, { model: { provider: "unused", modelId: "unused" }, instructions: "Local memory publication. No model input." });
	state.task = await tx.createTask(PublisherTask, {}, { ownership: { kind: "conversation" }, conversationId: state.conversation, background: true });
}

export const PublisherTask = defineTask<Record<string, never>, { phase: "publish"; tick: number }, null>({
	name: "mochi.memory-publisher", version: 1, initial: () => ({ phase: "publish", tick: 0 }),
	phases: {
		publish: async (task, runtime, context) => {
			const state = await runtime.snapshot(RepoDoc, context);
			if (state?.repo == null) return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			try {
				const result = await publishNext(runtime, context);
				if (result === "empty") return runtime.commit(async (tx) => {
					const doc = await tx.doc(RepoDoc);
					if (doc.queue.length > 0) return { status: "running", checkpoint: { phase: "publish", tick: task.state.checkpoint.tick + 1 } };
					doc.task = null;
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
			} catch (error) {
				await runtime.commit(async (tx) => {
					(await tx.doc(RepoDoc)).blocked = String(error).slice(0, 1000);
					return undefined;
				}, context);
				await runtime.sleep(runtime.now() + 60_000, context);
			}
			return runtime.commit(() => ({ status: "running", checkpoint: { phase: "publish", tick: task.state.checkpoint.tick + 1 } }), context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type Publisher = Pick<Harness, "snapshot"> & { commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<unknown> };
export type CrashWindow = "intent" | "objects" | "ref" | "worktree" | "accepted";

export async function publishNext(owner: Publisher, context: Context, crash?: (window: CrashWindow) => Promise<void>): Promise<"published" | "empty"> {
	let state = await owner.snapshot(RepoDoc, context);
	if (state?.repo == null || state.queue.length === 0) return "empty";
	const git = new MemoryGit(state.repo);
	await git.init();
	return git.lock(async () => {
		state = await owner.snapshot(RepoDoc, context);
		if (state === undefined) throw new Error("Memory repo disappeared");
		if (state.pending === null) {
			const revision = state.queue[0];
			if (revision === undefined) return "empty";
			const plan = await git.prepare(state.head, state.files, renderRepo(revision.memory), revision.revision, revision.at);
			await owner.commit(async (tx) => {
				const doc = await tx.doc(RepoDoc);
				if (doc.pending !== null || doc.head !== plan.base || doc.queue[0]?.revision !== revision.revision) throw new Error("Memory publication moved");
				doc.pending = { revision: revision.revision, plan };
				return undefined;
			}, context);
			await crash?.("intent");
			state = await owner.snapshot(RepoDoc, context);
		}
		const pending = state?.pending;
		if (pending == null) throw new Error("Memory publication intent missing");
		await git.publish(pending.plan, crash);
		await owner.commit(async (tx) => {
			const doc = await tx.doc(RepoDoc);
			if (doc.pending?.plan.target !== pending.plan.target || doc.queue[0]?.revision !== pending.revision) throw new Error("Memory publication acceptance moved");
			doc.head = pending.plan.target;
			doc.files = pending.plan.files;
			doc.published = pending.revision;
			doc.queue.shift();
			doc.pending = null;
			doc.blocked = null;
			return undefined;
		}, context);
		await crash?.("accepted");
		return "published";
	});
}

/** The directory a path names, through symlinks; the path itself when it does not exist yet. */
const realDir = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

export async function bindRepo(harness: Harness, repo: string | undefined, context: Context): Promise<void> {
	if (repo !== undefined) repo = resolve(repo);
	await harness.commit(async (tx) => {
		const doc = await tx.doc(RepoDoc);
		// A home move leaves the old path a symlink to the new one: the same repository under a new name.
		const moved = doc.repo !== null && repo !== undefined && doc.repo !== repo && realDir(doc.repo) === realDir(repo);
		if (doc.repo !== null && repo !== undefined && doc.repo !== repo && !moved) throw new Error("Changing an initialized memory repo path is not supported");
		if (repo === undefined) return;
		doc.repo = repo;
		if (doc.next === 0) await memoryChanged(tx, await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID), undefined);
		else if (doc.queue.length > 0) await ensurePublisher(tx, doc);
	}, context);
}
