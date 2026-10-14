import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTask, defineTool, type EntryId, type TaskId, type TaskOptions, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { journaled } from "../journal.ts";
import { forkPoint } from "../seats.ts";
import { answerText } from "../turn/turn.ts";

// A fork is a short-lived copy of the calling conversation, history and all, for one slice of a task. Its first
// request reads the caller's prompt cache, so a fork costs its own new tokens only.

type ForkInput = { readonly name: string; readonly brief: string };
type ForkResult = { readonly answer: string } | { readonly failure: string };

/** How many forks of one call run at once; the rest wait their turn. */
const FORK_BATCH = 6;

/** Call inside the commit that read `forkPoint`. The task kind keeps its stored name, `mochi.agent`. */
export async function startFork(
	tx: Tx,
	parent: ConversationId,
	at: EntryId,
	input: ForkInput,
	options: TaskOptions = { ownership: { kind: "conversation" }, conversationId: parent, background: true },
): Promise<TaskId<ForkResult>> {
	const id = await tx.createTask(ForkTask, input, options);
	// The fork keeps its parent's whole agent and history through `at`, so its first request reuses the parent's cached prompt.
	await tx.forkConversation(parent, at, { ownership: { kind: "task", taskId: id } });
	return id;
}

const childOf = async (tx: Tx, task: TaskId): Promise<ConversationId> => (await tx.scanConversations({ ownerTaskId: task }, 1)).items[0]!.id;

export const ForkTask = defineTask<ForkInput, { readonly phase: "run" }, ForkResult>({
	name: "mochi.agent",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			let child: ConversationId | undefined;
			await runtime.commit(async (tx) => void (child = await childOf(tx, task.id)), context);
			const submission = await (await runtime.conversation(child!, context))!.submit({ type: "input", content: task.input.brief, requestId: `agent:${task.id}` }, context);
			const settled = await submission.wait(context);
			await runtime.commit(async (tx) => {
				const result = settled.status === "done" && settled.type === "input" ? { answer: await answerText(tx, settled.answer) } : { failure: settled.reason ?? settled.status };
				return { status: "terminal", outcome: { status: "completed", result } };
			}, context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const briefOf = (name: string, background: boolean, brief: string, scratch: string): string =>
	`You are ${name}, a fork of this conversation made by the script above. ` +
	(background ? "You run in the background: nothing reads your answer, so call notify if the owner needs the result. " : "Your answer goes back to that script, not to the owner. ") +
	`Keep your files in ${scratch}; for code, work in a git worktree of your own, never the shared checkout.\n\n${brief}`;

async function waitFor(api: ToolExecutionApi, name: string, id: TaskId<ForkResult>, context: Context): Promise<string> {
	const { outcome } = (await api.waitForTask(id, context)).state;
	if (outcome.status !== "completed") return `(${name} was ${outcome.status})`;
	return "answer" in outcome.result ? outcome.result.answer : `(${name} did not answer: ${outcome.result.failure})`;
}

export function forkFns(scratchDir: (name: string) => string): ToolRegistration[] {
	const Brief = Type.Object({ name: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" }), brief: Type.String({ minLength: 1 }) });
	const start = (api: ToolExecutionApi, briefs: readonly { name: string; brief: string }[], first: number, background: boolean, context: Context) =>
		api.commit(async (tx) => {
			const at = await forkPoint(tx, api.conversationId);
			const ids: TaskId<ForkResult>[] = [];
			for (const [offset, each] of briefs.entries()) {
				const index = first + offset;
				const options: TaskOptions = background ? { ownership: { kind: "conversation" }, background: true } : { ownership: { kind: "task", taskId: api.taskId } };
				const { id } = await journaled(tx, api.taskId, `fork:${index}`, () => startFork(tx, api.conversationId, at, { name: each.name, brief: briefOf(each.name, background, each.brief, scratchDir(each.name)) }, options));
				ids.push(id);
			}
			return ids;
		}, context);
	return [
		defineTool({
			name: "fork",
			description:
				`Copies of you with this whole conversation, one per brief, ${FORK_BATCH} at a time; resolves to their answers in brief order. ` +
				"Each reuses this chat's prompt cache, so fan one task out in slices: fork({briefs:[{name:'a',brief:'...'},{name:'b',brief:'...'}]}).",
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
			description: "fork in the background: returns at once and posts nothing here. A fork calls notify if the owner needs its result.",
			parameters: Type.Object({ briefs: Type.Array(Brief, { minItems: 1 }) }),
			structuredOutputSchema: Type.Array(Type.String()),
			replay: "safe",
			execute: async ({ briefs }, api, context) => {
				await start(api, briefs, 0, true, context);
				return { structuredOutput: briefs.map((each) => each.name) };
			},
		}),
	];
}
