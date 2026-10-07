import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTask, type TaskId, type TaskRecord, type Tx } from "@earendil-works/pi-durable";
import { type CallApi, defineFn, journaled, type ScriptFn } from "../code/code.ts";
import { allPages } from "../pages.ts";
import { createSeatConversation } from "../seats.ts";
import { answerText } from "../turn/turn.ts";
import { type AgentCatalog, THINKING } from "./catalog.ts";

// One task kind for both modes. `agent` is owned by its mochi.call task, so Esc cascades to the child and the call
// resolves to the answer. `agent_start` is a background task of root: only /stop reaches it, and it posts nothing back;
// its child sits in seat `run` and may notify the owner itself. Only root's `code` has these functions, so depth is 1.

export type AgentInput = { readonly name: string; readonly brief: string };
export type AgentResult = { readonly answer: string } | { readonly failure: string };
type AgentRecord = TaskRecord<AgentInput, { readonly phase: "run" }, AgentResult>;

const KIND = "mochi.agent";

const childOf = async (tx: Tx, task: TaskId): Promise<ConversationId> => (await tx.scanConversations({ ownerTaskId: task }, 1)).items[0]!.id;

export const AgentTask = defineTask<AgentInput, { readonly phase: "run" }, AgentResult>({
	name: KIND,
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

const scanAgents = async (tx: Pick<Tx, "scanTasks">, conversationId: ConversationId): Promise<AgentRecord[]> =>
	(await allPages((cursor) => tx.scanTasks({ kind: KIND, conversationId }, 256, cursor))) as unknown as AgentRecord[];

const Name = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 40 });

export interface AgentFnDeps {
	readonly catalog: AgentCatalog;
	readonly read: <T>(read: (tx: Tx) => Promise<T>, context: Context) => Promise<T>;
	readonly abortTask: (id: TaskId, context: Context) => Promise<unknown>;
}

export function agentFns({ catalog, read, abortTask }: AgentFnDeps): ScriptFn[] {
	const types = [...catalog.types.keys()].join(" | ");
	const StartParams = Type.Object({
		name: Name,
		brief: Type.String({ minLength: 1 }),
		type: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.Union(THINKING.map((level) => Type.Literal(level)))),
	});
	const find = async (tx: Pick<Tx, "scanTasks">, conversationId: ConversationId, name: string): Promise<AgentRecord> => {
		const found = (await scanAgents(tx, conversationId)).findLast((task) => task.input.name === name);
		if (found === undefined) throw new Error(`No agent named ${name}.`);
		return found;
	};
	const start = async (background: boolean, args: Static<typeof StartParams>, call: CallApi, context: Context) => {
		const type = catalog.types.get(args.type ?? "worker");
		if (type === undefined) throw new Error(`Unknown type "${args.type}". Use ${types}.`);
		const [modelName, thinking] = [args.model ?? type.model, args.thinking ?? type.thinking];
		const model = modelName === undefined ? undefined : catalog.model(modelName);
		let id: TaskId<AgentResult> | undefined;
		await call.commit(async (tx) => {
			({ id } = await journaled(tx, call.taskId, "agent", async () => {
				const options = background ? ({ ownership: { kind: "conversation" }, background: true } as const) : { ownership: { kind: "task", taskId: call.taskId } as const };
				const id = await tx.createTask(AgentTask, { name: args.name, brief: args.brief }, options);
				await createSeatConversation(tx, background ? "run" : "worker", { kind: "task", taskId: id }, {
					...(model === undefined ? {} : { model }),
					...(thinking === undefined ? {} : { thinkingLevel: thinking }),
					...(type.instructions === "" ? {} : { instructions: type.instructions }),
				});
				return id;
			}));
		}, context);
		if (background) return { value: { name: args.name } };
		const { outcome } = (await call.waitForTask(id!, context)).state;
		if (outcome.status !== "completed") throw new Error(`Agent ${args.name} was ${outcome.status}.`);
		if ("failure" in outcome.result) throw new Error(`Agent ${args.name} did not answer: ${outcome.result.failure}.`);
		return { value: outcome.result.answer };
	};
	return [
		defineFn({
			name: "agent",
			description: `A subagent in its own conversation; resolves to its answer. It sees nothing of this chat: brief it on the goal, what done looks like and what to return. type: ${types} (default worker). model: fast, default, strongest or an alias.`,
			parameters: StartParams,
			output: Type.String(),
			replay: "keyed",
			run: (args, call, context) => start(false, args, call, context),
		}),
		defineFn({
			name: "agent_start",
			description: "agent in the background, for work longer than a script. Returns at once and posts nothing here; it may notify the owner. Check with agent_status.",
			parameters: StartParams,
			output: Type.Object({ name: Type.String() }),
			replay: "keyed",
			run: (args, call, context) => start(true, args, call, context),
		}),
		defineFn({
			name: "agent_send",
			description: "Steer a running subagent. A finished one cannot be resumed; start a fresh one with its last answer.",
			parameters: Type.Object({ name: Name, brief: Type.String({ minLength: 1 }) }),
			output: Type.Literal("sent"),
			replay: "keyed",
			run: async ({ name, brief }, call, context) => {
				const child = await read(async (tx) => {
					const agent = await find(tx, call.conversationId, name);
					if (agent.state.status === "terminal") throw new Error(`Agent ${name} has finished.`);
					return childOf(tx, agent.id);
				}, context);
				await (await call.conversation(child, context))!.submit({ type: "input", content: brief, whenBusy: "steer", requestId: `send:${call.taskId}` }, context);
				return { value: "sent" };
			},
		}),
		defineFn({
			name: "agent_stop",
			description: "Stop a subagent and its work.",
			parameters: Type.Object({ name: Name }),
			output: Type.Literal("stopped"),
			replay: "keyed",
			run: async ({ name }, call, context) => {
				await abortTask((await read((tx) => find(tx, call.conversationId, name), context)).id, context);
				return { value: "stopped" };
			},
		}),
		defineFn({
			name: "agent_status",
			description: "One subagent's state and answer, or every subagent of this conversation.",
			parameters: Type.Object({ name: Type.Optional(Name) }),
			output: Type.Array(Type.Object({ name: Type.String(), state: Type.String(), answer: Type.Optional(Type.String()) })),
			replay: "read",
			run: async ({ name }, call, context) => {
				const agents = (await read((tx) => scanAgents(tx, call.conversationId), context)).filter((task) => name === undefined || task.input.name === name);
				const row = ({ input, state }: AgentRecord) =>
					state.status !== "terminal" ? { name: input.name, state: "running" }
					: state.outcome.status !== "completed" ? { name: input.name, state: state.outcome.status }
					: "answer" in state.outcome.result ? { name: input.name, state: "answered", answer: state.outcome.result.answer }
					: { name: input.name, state: "failed", answer: state.outcome.result.failure };
				return { value: agents.map(row) };
			},
		}),
	];
}
