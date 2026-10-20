import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { configure, type ConversationId, defineTask, defineTool, type EntryId, type ModelRef, type TaskId, type TaskOptions, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { copyContext, holdText } from "../context.ts";
import { journaled } from "../journal.ts";
import { inheritProfile } from "../profiles/profiles.ts";
import { forkPoint } from "../seats.ts";
import { answerText } from "../turn/turn.ts";

// Two kinds of child, both a `mochi.agent` task that owns one conversation:
//   fork   a copy of the caller, history and all. Its first request reads the caller's prompt cache, so a fork costs
//          its own new tokens only.
//   fresh  a new conversation with the caller's agent (seat, tools, instructions, profile) and no history, an optional
//          model, and only the context values it is given. For one slice of data whose brief is the whole task.

/**
 * `back`: the conversation a background child merges its answer into, as a new message.
 * `depth`: root and standing conversations are 0, their children 1. Absent on tasks made before depth existed.
 */
type ForkInput = {
	readonly name: string;
	readonly brief: string;
	readonly back?: ConversationId;
	readonly fresh?: true;
	readonly depth?: number;
	readonly model?: ModelRef;
};
type ForkResult = { readonly answer: string } | { readonly failure: string };

/** How many children of one call run at once; the rest wait their turn. */
const FORK_BATCH = 6;
export const MAX_DEPTH = 3;
const TOO_DEEP = `Children are ${MAX_DEPTH} deep here. Do this slice yourself.`;

export function defineForkTask(workDir: string) {
	return defineTask<ForkInput, { readonly phase: "run" }, ForkResult>({
		name: "mochi.agent",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const host = { commit: (change: (tx: Tx) => Promise<void>, context: Context) => runtime.commit(async (tx) => void (await change(tx)), context) };
				let child: ConversationId | undefined;
				await runtime.commit(async (tx) => void (child = await childOf(tx, task.id)), context);
				const brief = await holdText(host, workDir, child!, `in:agent:${task.id}`, task.input.brief, context);
				const submission = await (await runtime.conversation(child!, context))!.submit({ type: "input", content: brief, requestId: `agent:${task.id}` }, context);
				const settled = await submission.wait(context);
				let result = { failure: settled.reason ?? settled.status } as ForkResult;
				if (settled.status === "done" && settled.type === "input") await runtime.commit(async (tx) => void (result = { answer: await answerText(tx, settled.answer) }), context);
				const back = task.input.back === undefined ? undefined : await runtime.conversation(task.input.back, context);
				if (back !== undefined) {
					const body = "answer" in result ? result.answer || "(empty answer)" : `(no answer: ${result.failure})`;
					const held = await holdText(host, workDir, back.id, `in:fork-back:${task.id}`, body, context);
					await back.submit({ type: "input", content: `[from fork ${task.input.name}]\n${held}`, requestId: `fork-back:${task.id}`, whenBusy: "followUp" }, context);
				}
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}
export type ForkTask = ReturnType<typeof defineForkTask>;

const childOf = async (tx: Tx, task: TaskId): Promise<ConversationId> => (await tx.scanConversations({ ownerTaskId: task }, 1)).items[0]!.id;

/** The caller's depth, from its owning child task. Table reads: call before the commit's first write. */
async function depthOf(tx: Tx, caller: ConversationId): Promise<number> {
	const owner = (await tx.conversation(caller))?.owner;
	if (owner === undefined) return 0;
	const task = await tx.task(owner.taskId);
	if (task?.kind !== "mochi.agent") return 0;
	return (task.input as ForkInput).depth ?? 1;
}

/** Call inside the commit that read `forkPoint` and the caller's depth. */
async function startFork(tx: Tx, task: ForkTask, parent: ConversationId, at: EntryId, input: ForkInput, options: TaskOptions): Promise<TaskId<ForkResult>> {
	const id = await tx.createTask(task, input, options);
	// The fork keeps its parent's whole agent and history through `at`, so its first request reuses the parent's cached prompt.
	const child = await tx.forkConversation(parent, at, { ownership: { kind: "task", taskId: id } });
	await inheritProfile(tx, parent, child.id);
	return id;
}

/**
 * A fresh child of `caller`. The new task-owned conversation copies the agent of its owner task's conversation, which
 * `options` sets to the caller. No table reads, so it may follow other writes.
 */
export async function startChild(tx: Tx, task: ForkTask, caller: ConversationId, input: ForkInput, options: TaskOptions, keys: readonly string[]): Promise<TaskId<ForkResult>> {
	const id = await tx.createTask(task, { ...input, fresh: true }, options);
	const child = await tx.createConversation({ ownership: { kind: "task", taskId: id } });
	if (input.model !== undefined) await configure(tx, child.id, { model: input.model });
	await inheritProfile(tx, caller, child.id);
	await copyContext(tx, caller, child.id, keys);
	return id;
}

const briefOf = (name: string, background: boolean, brief: string, scratch: string): string =>
	`You are ${name}, a fork of this conversation made by the script above. ` +
	(background ? "You run in the background. Your answer merges back into the conversation that forked you as a new message, not to the owner. " : "Your answer goes back to that script, not to the owner. ") +
	`Keep your files in ${scratch}; for code, work in a git worktree of your own, never the shared checkout.\n\n${brief}`;

function jobBriefOf(name: string, brief: string, keys: readonly string[], scratch: string): string {
	const lines = [
		`You are ${name}, a fresh agent a script started for one job. You have none of its history: this brief and the context values below are all you have. ` +
			"Your answer goes back to that script, not to the owner, so answer with the result alone. " +
			`Keep your files in ${scratch}; for code, work in a git worktree of your own, never the shared checkout.`,
	];
	if (keys.length > 0) lines.push(`Context values (read them in a script with tools.context_read({ key })): ${keys.join(", ")}`);
	lines.push("", brief);
	return lines.join("\n");
}

async function waitFor(api: ToolExecutionApi, name: string, id: TaskId<ForkResult>, context: Context): Promise<string> {
	const { outcome } = (await api.waitForTask(id, context)).state;
	if (outcome.status !== "completed") return `(${name} was ${outcome.status})`;
	return "answer" in outcome.result ? outcome.result.answer : `(${name} failed: ${outcome.result.failure})`;
}

interface ForkDeps {
	readonly task: ForkTask;
	readonly scratchDir: (name: string) => string;
	/** brain, fast or strongest to a model; throws on an unknown name. */
	readonly ref: (name: string) => ModelRef;
}

const MODELS = ["brain", "fast", "strongest"] as const;

export function forkFns(deps: ForkDeps): ToolRegistration[] {
	const { task, scratchDir } = deps;
	const Name = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" });
	const Brief = Type.Object({ name: Name, brief: Type.String({ minLength: 1 }) });
	const Job = Type.Object({
		name: Name,
		brief: Type.String({ minLength: 1 }),
		context: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		model: Type.Optional(Type.Union(MODELS.map((model) => Type.Literal(model)))),
	});
	const start = (api: ToolExecutionApi, briefs: readonly { name: string; brief: string }[], first: number, background: boolean, context: Context) =>
		api.commit(async (tx) => {
			const at = await forkPoint(tx, api.conversationId);
			const depth = (await depthOf(tx, api.conversationId)) + 1;
			if (depth > MAX_DEPTH) throw new Error(TOO_DEEP);
			const ids: TaskId<ForkResult>[] = [];
			for (const [offset, each] of briefs.entries()) {
				const index = first + offset;
				const options: TaskOptions = background ? { ownership: { kind: "conversation" }, background: true } : { ownership: { kind: "task", taskId: api.taskId } };
				const input: ForkInput = { name: each.name, brief: briefOf(each.name, background, each.brief, scratchDir(each.name)), depth, ...(background ? { back: api.conversationId } : {}) };
				const { id } = await journaled(tx, api.taskId, `fork:${index}`, () => startFork(tx, task, api.conversationId, at, input, options));
				ids.push(id);
			}
			return ids;
		}, context);
	return [
		defineTool({
			name: "fork",
			description:
				`Copies of you with this conversation, one per brief, ${FORK_BATCH} at a time; resolves to answers in brief order. They reuse this chat's prompt cache. ` +
				"The script's timeout (10 min default) cancels unfinished children and loses every answer, so slices that take minutes go to fork_start.",
			parameters: Type.Object({ briefs: Type.Array(Brief, { minItems: 1 }) }),
			structuredOutputSchema: Type.Array(Type.String()),
			replay: "safe",
			execute: async ({ briefs }, api, context) => {
				const answers: string[] = [];
				for (let from = 0; from < briefs.length; from += FORK_BATCH) {
					const batch = briefs.slice(from, from + FORK_BATCH);
					const ids = await start(api, batch, from, false, context);
					answers.push(...(await Promise.all(ids.map((id, i) => waitFor(api, batch[i]!.name, id, context)))));
				}
				return { structuredOutput: answers };
			},
		}),
		defineTool({
			name: "fork_start",
			description: "fork in the background: returns at once, and each fork's answer merges back here as a new message when it finishes.",
			parameters: Type.Object({ briefs: Type.Array(Brief, { minItems: 1 }) }),
			structuredOutputSchema: Type.Array(Type.String()),
			replay: "safe",
			execute: async ({ briefs }, api, context) => {
				await start(api, briefs, 0, true, context);
				return { structuredOutput: briefs.map((each) => each.name) };
			},
		}),
		defineTool({
			name: "agent",
			description:
				`Fresh agents with your tools and none of this conversation, one per job, ${FORK_BATCH} at a time; resolves to [{ name, answer }]. ` +
				"Pass data as context keys (context_put it first); model fast for bulk reading. The script's timeout (10 min default) cancels unfinished jobs and loses every answer: " +
				"work that takes minutes goes to fork_start or profile_send with background.",
			parameters: Type.Object({ jobs: Type.Array(Job, { minItems: 1 }) }),
			structuredOutputSchema: Type.Array(Type.Object({ name: Type.String(), answer: Type.String() })),
			replay: "safe",
			execute: async ({ jobs }, api, context) => {
				const models: (ModelRef | undefined)[] = [];
				for (const job of jobs) {
					if (job.model === undefined) {
						models.push(undefined);
						continue;
					}
					const model = deps.ref(job.model);
					if (api.models.getModel(model.provider, model.modelId) === undefined) throw new Error(`Model ${job.model} (${model.provider}/${model.modelId}) is not configured.`);
					models.push(model);
				}
				const answers: { name: string; answer: string }[] = [];
				for (let from = 0; from < jobs.length; from += FORK_BATCH) {
					const batch = jobs.slice(from, from + FORK_BATCH);
					const ids = await api.commit(async (tx) => {
						const depth = (await depthOf(tx, api.conversationId)) + 1;
						if (depth > MAX_DEPTH) throw new Error(TOO_DEEP);
						const created: TaskId<ForkResult>[] = [];
						for (const [offset, job] of batch.entries()) {
							const index = from + offset;
							const keys = job.context ?? [];
							const model = models[index];
							const input: ForkInput = { name: job.name, brief: jobBriefOf(job.name, job.brief, keys, scratchDir(job.name)), depth, ...(model === undefined ? {} : { model }) };
							const { id } = await journaled(tx, api.taskId, `agent:${index}`, () => startChild(tx, task, api.conversationId, input, { ownership: { kind: "task", taskId: api.taskId } }, keys));
							created.push(id);
						}
						return created;
					}, context);
					const settled = await Promise.all(ids.map((id, i) => waitFor(api, batch[i]!.name, id, context)));
					for (const [i, answer] of settled.entries()) answers.push({ name: batch[i]!.name, answer });
				}
				return { structuredOutput: answers };
			},
		}),
	];
}
