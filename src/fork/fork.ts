import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { configure, type ConversationId, defineTask, defineTool, type EntryId, type ModelRef, type TaskId, type TaskOptions, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { copyContext, holdText } from "../context.ts";
import { journaled } from "../journal.ts";
import { inheritProfile } from "../profiles/profiles.ts";
import { forkPoint } from "../seats.ts";
import { answerText, submitNote } from "../turn/turn.ts";

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
				const done = { status: "terminal", outcome: { status: "completed", result } } as const;
				const back = task.input.back === undefined ? undefined : await runtime.conversation(task.input.back, context);
				if (back !== undefined) {
					const body = "answer" in result ? result.answer || "(empty answer)" : `(no answer: ${result.failure})`;
					const key = `fork-back:${task.id}`;
					const held = await holdText(host, workDir, back.id, `in:${key}`, body, context);
					await submitNote(back, key, `[${task.input.name}]\n${held}`, context);
				}
				await runtime.commit(() => done, context);
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
	(background ? "You run in the background. Your answer reaches the conversation that forked you as a note on its next turn, not the owner. " : "Your answer goes back to that script, not to the owner. ") +
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
	const Job = Type.Object({
		name: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" }),
		brief: Type.String({ minLength: 1 }),
		fork: Type.Optional(Type.Boolean()),
		context: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		model: Type.Optional(Type.Union(MODELS.map((model) => Type.Literal(model)))),
	});

	/** Starts one batch of children in one commit, journaled so a replay starts none twice. */
	const start = (api: ToolExecutionApi, jobs: readonly Static<typeof Job>[], first: number, background: boolean, models: readonly (ModelRef | undefined)[], context: Context) =>
		api.commit(async (tx) => {
			const depth = (await depthOf(tx, api.conversationId)) + 1;
			const at = await forkPoint(tx, api.conversationId);
			const options: TaskOptions = background ? { ownership: { kind: "conversation" }, background: true } : { ownership: { kind: "task", taskId: api.taskId } };
			const ids: TaskId<ForkResult>[] = [];
			for (const [offset, job] of jobs.entries()) {
				const index = first + offset;
				const scratch = scratchDir(job.name);
				const back = background ? { back: api.conversationId } : {};
				const model = models[index];
				const withModel = model === undefined ? {} : { model };
				let started;
				if (job.fork === true) {
					const input: ForkInput = { name: job.name, brief: briefOf(job.name, background, job.brief, scratch), depth, ...back, ...withModel };
					started = await journaled(tx, api.taskId, `agent:${index}`, () => startFork(tx, task, api.conversationId, at, input, options));
				} else {
					const keys = job.context ?? [];
					const input: ForkInput = { name: job.name, brief: jobBriefOf(job.name, job.brief, keys, scratch), depth, ...back, ...withModel };
					started = await journaled(tx, api.taskId, `agent:${index}`, () => startChild(tx, task, api.conversationId, input, options, keys));
				}
				ids.push(started.id);
			}
			return ids;
		}, context);

	return [
		defineTool({
			name: "agent",
			description:
				`Starts child agents, one per job, ${FORK_BATCH} at a time, and resolves to [{ name, answer }] in job order. ` +
				"fork: true copies this conversation, so the child knows everything here and reuses the prompt cache; otherwise the child starts fresh with only its brief and the context keys you pass. " +
				"background: true returns the names at once, and each answer arrives later as a [name] note on your next turn. The script's timeout (10 min default) cancels unfinished foreground children, so work that takes minutes runs in the background. " +
				"model fast suits bulk reading.",
			parameters: Type.Object({ jobs: Type.Array(Job, { minItems: 1 }), background: Type.Optional(Type.Boolean()) }),
			structuredOutputSchema: Type.Array(Type.Object({ name: Type.String(), answer: Type.String() })),
			replay: "safe",
			execute: async ({ jobs, background }, api, context) => {
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
				if (background === true) {
					await start(api, jobs, 0, true, models, context);
					return { structuredOutput: jobs.map((job) => ({ name: job.name, answer: "started in the background" })) };
				}
				const answers: { name: string; answer: string }[] = [];
				for (let from = 0; from < jobs.length; from += FORK_BATCH) {
					const batch = jobs.slice(from, from + FORK_BATCH);
					const ids = await start(api, batch, from, false, models, context);
					const settled = await Promise.all(ids.map((id, i) => waitFor(api, batch[i]!.name, id, context)));
					for (const [i, answer] of settled.entries()) answers.push({ name: batch[i]!.name, answer });
				}
				return { structuredOutput: answers };
			},
		}),
	];
}
