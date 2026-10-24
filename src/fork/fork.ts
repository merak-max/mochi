import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { configure, type ConversationId, defineDocFamily, defineTask, defineTool, type EntryId, LiveDoc, type ModelRef, type TaskId, type TaskOptions, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { agentOf, applyAgent, type Definition, type Definitions, inheritOwner, ownerIn, residentConversation } from "../agents/definitions.ts";
import { copyContext, holdText } from "../context.ts";
import { journaled } from "../journal.ts";
import { forkPoint } from "../seats.ts";
import { answerText, submitNote } from "../turn/turn.ts";

// Every job is a `mochi.agent` task:
//   fork      a copy of the caller, history and all, in a conversation the task owns. Its first request reads the
//             caller's prompt cache, so a fork costs its own new tokens only.
//   fresh     a new conversation the task owns, with no history and only the context values it is given. It runs as
//             the caller's agent, or as the named definition (its model, thinking, tools and instructions).
//   resident  a job for a resident definition. The task owns no conversation: it submits the brief to the
//             definition's standing conversation and waits for that answer.

/**
 * `back`: the caller's conversation. A background child always merges its answer there as a new message; a foreground
 * child does so only when `waiter`, the tool call that waits for it, ended first (its script timed out or the daemon
 * restarted past it). A child never belongs to the script, so a script's end never aborts it.
 * `depth`: root and standing conversations are 0, their children 1.
 * `resident`: the standing conversation a resident job's brief goes to.
 */
type ForkInput = {
	readonly name: string;
	readonly brief: string;
	readonly back?: ConversationId;
	readonly waiter?: TaskId;
	readonly fresh?: true;
	readonly depth: number;
	readonly model?: ModelRef;
	readonly resident?: ConversationId;
};
type ForkResult = { readonly answer: string } | { readonly failure: string };

/** How many children of one call run at once; the rest wait their turn. */
const FORK_BATCH = 6;

/**
 * Resident answers already sent back, by caller and answer. Queued jobs merge into one resident turn and settle with
 * the same answer, so it goes back once. The kind keeps its stored name.
 */
const DeliveredDoc = defineDocFamily<{ delivered: boolean }, null>({
	kind: "mochi.reply-delivered",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ delivered: false }),
	checkpointWhen: () => false,
});

export function defineForkTask(workDir: string) {
	return defineTask<ForkInput, { readonly phase: "run" }, ForkResult>({
		name: "mochi.agent",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const host = { commit: (change: (tx: Tx) => Promise<void>, context: Context) => runtime.commit(async (tx) => void (await change(tx)), context) };
				let child = task.input.resident;
				if (child === undefined) await runtime.commit(async (tx) => void (child = await childOf(tx, task.id)), context);
				const brief = await holdText(host, workDir, child!, `in:agent:${task.id}`, task.input.brief, context);
				const submission = await (await runtime.conversation(child!, context))!.submit({ type: "input", content: brief, requestId: `agent:${task.id}`, whenBusy: "followUp" }, context);
				const settled = await submission.wait(context);
				let result = { failure: settled.reason ?? settled.status } as ForkResult;
				let duplicate = false;
				if (settled.status === "done" && settled.type === "input") {
					await runtime.commit(async (tx) => {
						result = { answer: await answerText(tx, settled.answer) };
						if (task.input.resident === undefined || task.input.back === undefined) return;
						const seen = await tx.doc(DeliveredDoc, `${task.input.back}:${String(settled.answer)}`, null);
						duplicate = seen.delivered;
						seen.delivered = true;
					}, context);
				}
				const done = { status: "terminal", outcome: { status: "completed", result } } as const;
				const waiter = task.input.waiter;
				let waiting = false;
				if (waiter !== undefined) await runtime.commit(async (tx) => void (waiting = (await tx.task(waiter))?.state.status !== "terminal"), context);
				const back = task.input.back === undefined || duplicate || waiting ? undefined : await runtime.conversation(task.input.back, context);
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
	return (task.input as ForkInput).depth;
}

/** Call inside the commit that read `forkPoint` and the caller's depth. */
async function startFork(tx: Tx, task: ForkTask, parent: ConversationId, at: EntryId, input: ForkInput, options: TaskOptions): Promise<TaskId<ForkResult>> {
	const id = await tx.createTask(task, input, options);
	// The fork keeps its parent's whole agent and history through `at`, so its first request reuses the parent's cached prompt.
	const child = await tx.forkConversation(parent, at, { ownership: { kind: "task", taskId: id } });
	await inheritOwner(tx, parent, child.id);
	return id;
}

/**
 * A fresh child of `caller`. The new task-owned conversation copies the agent of its owner task's conversation, which
 * `options` sets to the caller; a definition then replaces its model, thinking, tools and instructions. No table
 * reads, so it may follow other writes.
 */
async function startChild(tx: Tx, task: ForkTask, caller: ConversationId, input: ForkInput, options: TaskOptions, keys: readonly string[], definition: Definition | undefined, definitions: Definitions): Promise<TaskId<ForkResult>> {
	const id = await tx.createTask(task, { ...input, fresh: true }, options);
	const child = await tx.createConversation({ ownership: { kind: "task", taskId: id } });
	if (definition === undefined) await inheritOwner(tx, caller, child.id);
	else await applyAgent(tx, child.id, agentOf(definition, definitions, ""));
	if (input.model !== undefined) await configure(tx, child.id, { model: input.model });
	await copyContext(tx, caller, child.id, keys);
	return id;
}

const briefOf = (name: string, background: boolean, brief: string, scratch: string): string =>
	`You are ${name}, a fork of this conversation made by the script above. ` +
	(background ? "You run in the background. Your answer reaches the conversation that forked you as a note on its next turn, not the owner. " : "Your answer goes back to that script, not to the owner. ") +
	`Keep your files in ${scratch}; for code, work in a git worktree of your own, never the shared checkout.\n\n${brief}`;

const contextLine = (keys: readonly string[]): string => `Context values (read them in a script with tools.context_read({ key })): ${keys.join(", ")}`;

function jobBriefOf(name: string, brief: string, keys: readonly string[], scratch: string): string {
	const lines = [
		`You are ${name}, a fresh agent a script started for one job. You have none of its history: this brief and the context values below are all you have. ` +
			"Your answer goes back to that script, not to the owner, so answer with the result alone. " +
			`Keep your files in ${scratch}; for code, work in a git worktree of your own, never the shared checkout.`,
	];
	if (keys.length > 0) lines.push(contextLine(keys));
	lines.push("", brief);
	return lines.join("\n");
}

function residentBriefOf(sender: string, brief: string, keys: readonly string[]): string {
	const lines = [`[from ${sender}] ${brief}`];
	if (keys.length > 0) lines.push("", contextLine(keys));
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
	readonly definitions: Definitions;
}

/** One job, checked before any child exists: its model override and its definition. */
type Planned = { readonly model: ModelRef | undefined; readonly definition: Definition | undefined };

/** A started job. `queued`: a busy resident took it into its queue, so its answer comes back later as a note. */
type Started = { readonly id: TaskId<ForkResult>; readonly queued: boolean };

const queuedAnswer = (name: string, definition: string) =>
	`NOT STARTED: ${definition} is busy with an earlier turn, so job ${name} waits in its queue until that turn ends. Its answer comes back here as a [${name}] note. If this is urgent, give it to a fork or a fresh agent, or call agent_stop first.`;

export function forkFns(deps: ForkDeps): ToolRegistration[] {
	const { task, scratchDir, definitions } = deps;
	const Job = Type.Object({
		name: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" }),
		brief: Type.String({ minLength: 1 }),
		fork: Type.Optional(Type.Boolean()),
		definition: Type.Optional(Type.String({ minLength: 1 })),
		context: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		model: Type.Optional(Type.String({ minLength: 1 })),
	});

	/** Starts one batch of children in one commit, journaled so a replay starts none twice. */
	const start = (api: ToolExecutionApi, jobs: readonly Static<typeof Job>[], first: number, background: boolean, planned: readonly Planned[], context: Context) =>
		api.commit(async (tx) => {
			const depth = (await depthOf(tx, api.conversationId)) + 1;
			const at = await forkPoint(tx, api.conversationId);
			const sender = await ownerIn(tx, api.conversationId);
			const detached: TaskOptions = { ownership: { kind: "conversation" }, background: true };
			// A foreground child waits on this call, but owns itself: when the call ends first, the answer becomes a note.
			const reply = background ? { back: api.conversationId } : { back: api.conversationId, waiter: api.taskId };
			const started: Started[] = [];
			for (const [offset, job] of jobs.entries()) {
				const index = first + offset;
				const scratch = scratchDir(job.name);
				const { model, definition } = planned[index]!;
				const withModel = model === undefined ? {} : { model };
				const keys = job.context ?? [];
				const key = `agent:${index}`;
				if (definition?.resident === true) {
					if (sender === definition.name) throw new Error(`You are ${definition.name}; give this job to another definition.`);
					const resident = await residentConversation(tx, definition, definitions);
					// A busy resident may be waiting on this very caller, so a foreground wait could never end: its answer comes back as a note.
					const busy = (await tx.doc(LiveDoc, resident)).run !== undefined;
					const queued = busy && !background;
					const input: ForkInput = { name: job.name, brief: residentBriefOf(sender, job.brief, keys), depth, resident, ...(background || queued ? { back: api.conversationId } : reply) };
					const made = await journaled(tx, api.taskId, key, async () => {
						await copyContext(tx, api.conversationId, resident, keys);
						return tx.createTask(task, input, detached);
					});
					started.push({ id: made.id, queued });
					continue;
				}
				const options = detached;
				const back = reply;
				let made;
				if (job.fork === true) {
					const input: ForkInput = { name: job.name, brief: briefOf(job.name, background, job.brief, scratch), depth, ...back, ...withModel };
					made = await journaled(tx, api.taskId, key, () => startFork(tx, task, api.conversationId, at, input, options));
				} else {
					const input: ForkInput = { name: job.name, brief: jobBriefOf(job.name, job.brief, keys, scratch), depth, ...back, ...withModel };
					made = await journaled(tx, api.taskId, key, () => startChild(tx, task, api.conversationId, input, options, keys, definition, definitions));
				}
				started.push({ id: made.id, queued: false });
			}
			return started;
		}, context);

	return [
		defineTool({
			name: "agent",
			description:
				`Starts child agents, one per job, ${FORK_BATCH} at a time, and resolves to [{ name, answer }] in job order. ` +
				"fork: true copies this conversation, so the child knows everything here and reuses the prompt cache; otherwise the child starts fresh with only its brief and the context keys you pass. " +
				"definition names an agent definition: the fresh child runs with its model, thinking, tools and instructions. A resident definition keeps one standing conversation; the job goes there, and a busy one queues it and answers NOT STARTED. " +
				"background: true returns the names at once, and each answer arrives later as a [name] note on your next turn. A foreground child outlives its script: if the script times out first, the child's answer still arrives as a [name] note. " +
				"model: a name from [models] (brain, fast, or the owner's own); it overrides the definition's, and fast suits bulk reading.",
			parameters: Type.Object({ jobs: Type.Array(Job, { minItems: 1 }), background: Type.Optional(Type.Boolean()) }),
			structuredOutputSchema: Type.Array(Type.Object({ name: Type.String(), answer: Type.String() })),
			replay: "safe",
			execute: async ({ jobs, background }, api, context) => {
				const planned: Planned[] = [];
				for (const job of jobs) {
					const definition = job.definition === undefined ? undefined : await definitions.get(job.definition);
					if (definition !== undefined && job.fork === true) throw new Error(`Job ${job.name}: a fork is a copy of this conversation, so it takes no definition.`);
					if (definition?.resident === true && job.model !== undefined) throw new Error(`Job ${job.name}: ${definition.name} is resident and runs on its own model; drop model.`);
					const modelName = job.model ?? definition?.model;
					const model = modelName === undefined ? undefined : definitions.model(modelName);
					if (model !== undefined && api.models.getModel(model.provider, model.modelId) === undefined) throw new Error(`Model ${modelName} (${model.provider}/${model.modelId}) is not configured.`);
					planned.push({ model: job.model === undefined ? undefined : model, definition });
				}
				if (background === true) {
					await start(api, jobs, 0, true, planned, context);
					return { structuredOutput: jobs.map((job) => ({ name: job.name, answer: "started in the background" })) };
				}
				const answers: { name: string; answer: string }[] = [];
				for (let from = 0; from < jobs.length; from += FORK_BATCH) {
					const batch = jobs.slice(from, from + FORK_BATCH);
					const started = await start(api, batch, from, false, planned, context);
					const settled = await Promise.all(
						started.map(({ id, queued }, i) => (queued ? Promise.resolve(queuedAnswer(batch[i]!.name, planned[from + i]!.definition!.name)) : waitFor(api, batch[i]!.name, id, context))),
					);
					for (const [i, answer] of settled.entries()) answers.push({ name: batch[i]!.name, answer });
				}
				return { structuredOutput: answers };
			},
		}),
	];
}
