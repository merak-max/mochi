import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTask, defineTool, type TaskId, type TaskRecord, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { journaled } from "../journal.ts";
import { allPages } from "../pages.ts";
import { createSeatConversation, forkPoint, forkSeatConversation } from "../seats.ts";
import { answerText } from "../turn/turn.ts";
import { type AgentCatalog, THINKING } from "./catalog.ts";

// One task kind for every mode. `agent` and `fork` are owned by the calling tool task, so Esc cascades to the child and
// the call resolves to the answer. `agent_start` and `fork_start` are background tasks of the calling conversation: only
// /stop reaches them, and they post nothing back; the child may notify the owner itself. Every agent conversation has
// these functions, so an agent can start or fork agents at any depth.
//
// `agent` starts a fresh conversation from a brief. `fork` copies the calling conversation: its history, its agent and
// its code-mode state, as of the call. The fork's first request repeats the parent's prompt, so it reads the parent's
// cache instead of paying for the context again.

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

export function agentFns({ catalog, read, abortTask }: AgentFnDeps): ToolRegistration[] {
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
	const ForkParams = Type.Object({ name: Name, brief: Type.String({ minLength: 1 }) });
	const fork = async (background: boolean, args: Static<typeof ForkParams>, api: ToolExecutionApi, context: Context) => {
		let id: TaskId<AgentResult> | undefined;
		await api.commit(async (tx) => {
			const at = await forkPoint(tx, api.conversationId);
			({ id } = await journaled(tx, api.taskId, "fork", async () => {
				const brief = `You are ${args.name}, a fork of this conversation made by the script above. Your answer goes back to that script, not to the owner.\n\n${args.brief}`;
				const id = await tx.createTask(AgentTask, { name: args.name, brief }, background ? { ownership: { kind: "conversation" }, background: true } : { ownership: { kind: "task", taskId: api.taskId } });
				await forkSeatConversation(tx, api.conversationId, at, { kind: "task", taskId: id });
				return id;
			}));
		}, context);
		return settle(background, args.name, id!, api, context);
	};
	const settle = async (background: boolean, name: string, id: TaskId<AgentResult>, api: ToolExecutionApi, context: Context) => {
		if (background) return { structuredOutput: { name } };
		const { outcome } = (await api.waitForTask(id, context)).state;
		if (outcome.status !== "completed") throw new Error(`Agent ${name} was ${outcome.status}.`);
		if ("failure" in outcome.result) throw new Error(`Agent ${name} did not answer: ${outcome.result.failure}.`);
		return { structuredOutput: outcome.result.answer };
	};
	const start = async (background: boolean, args: Static<typeof StartParams>, api: ToolExecutionApi, context: Context) => {
		const type = catalog.types.get(args.type ?? "worker");
		if (type === undefined) throw new Error(`Unknown type "${args.type}". Use ${types}.`);
		const [modelName, thinking] = [args.model ?? type.model, args.thinking ?? type.thinking];
		const model = modelName === undefined ? undefined : catalog.model(modelName);
		let id: TaskId<AgentResult> | undefined;
		await api.commit(async (tx) => {
			({ id } = await journaled(tx, api.taskId, "agent", async () => {
				const options = background ? ({ ownership: { kind: "conversation" }, background: true } as const) : { ownership: { kind: "task", taskId: api.taskId } as const };
				const id = await tx.createTask(AgentTask, { name: args.name, brief: args.brief }, options);
				await createSeatConversation(tx, "agent", { kind: "task", taskId: id }, {
					...(model === undefined ? {} : { model }),
					...(thinking === undefined ? {} : { thinkingLevel: thinking }),
					...(type.instructions === "" ? {} : { instructions: type.instructions }),
				});
				return id;
			}));
		}, context);
		return settle(background, args.name, id!, api, context);
	};
	return [
		defineTool({
			name: "agent",
			description: `A fresh agent; resolves to its answer. It sees nothing of this chat, so brief it fully. type: ${types} (default worker). model: fast, default, strongest or an alias.`,
			parameters: StartParams,
			structuredOutputSchema: Type.String(),
			replay: "safe",
			execute: (args, api, context) => start(false, args, api, context),
		}),
		defineTool({
			name: "agent_start",
			description: "agent in the background, for work longer than a script. Returns at once and posts nothing here; it may notify the owner. Check with agent_status.",
			parameters: StartParams,
			structuredOutputSchema: Type.Object({ name: Type.String() }),
			replay: "safe",
			execute: (args, api, context) => start(true, args, api, context),
		}),
		defineTool({
			name: "fork",
			description: "A copy of you with this whole conversation; resolves to its answer. The brief is its next message. Reuses this chat's prompt cache, so Promise.all several to try paths at once.",
			parameters: ForkParams,
			structuredOutputSchema: Type.String(),
			replay: "safe",
			execute: (args, api, context) => fork(false, args, api, context),
		}),
		defineTool({
			name: "fork_start",
			description: "fork in the background. Returns at once and posts nothing here; it may notify the owner. Check with agent_status.",
			parameters: ForkParams,
			structuredOutputSchema: Type.Object({ name: Type.String() }),
			replay: "safe",
			execute: (args, api, context) => fork(true, args, api, context),
		}),
		defineTool({
			name: "agent_send",
			description: "Steer a running subagent. A finished one cannot be resumed; start a fresh one with its last answer.",
			parameters: Type.Object({ name: Name, brief: Type.String({ minLength: 1 }) }),
			structuredOutputSchema: Type.Literal("sent"),
			replay: "safe",
			execute: async ({ name, brief }, api, context) => {
				const child = await read(async (tx) => {
					const agent = await find(tx, api.conversationId, name);
					if (agent.state.status === "terminal") throw new Error(`Agent ${name} has finished.`);
					return childOf(tx, agent.id);
				}, context);
				await (await api.conversation(child, context))!.submit({ type: "input", content: brief, whenBusy: "steer", requestId: `send:${api.taskId}` }, context);
				return { structuredOutput: "sent" };
			},
		}),
		defineTool({
			name: "agent_stop",
			description: "Stop a subagent and its work.",
			parameters: Type.Object({ name: Name }),
			structuredOutputSchema: Type.Literal("stopped"),
			replay: "safe",
			execute: async ({ name }, api, context) => {
				await abortTask((await read((tx) => find(tx, api.conversationId, name), context)).id, context);
				return { structuredOutput: "stopped" };
			},
		}),
		defineTool({
			name: "agent_status",
			description: "One subagent's state and answer, or every subagent of this conversation.",
			parameters: Type.Object({ name: Type.Optional(Name) }),
			structuredOutputSchema: Type.Array(Type.Object({ name: Type.String(), state: Type.String(), answer: Type.Optional(Type.String()) })),
			replay: "safe",
			execute: async ({ name }, api, context) => {
				const agents = (await read((tx) => scanAgents(tx, api.conversationId), context)).filter((task) => name === undefined || task.input.name === name);
				const row = ({ input, state }: AgentRecord) =>
					state.status !== "terminal" ? { name: input.name, state: "running" }
					: state.outcome.status !== "completed" ? { name: input.name, state: state.outcome.status }
					: "answer" in state.outcome.result ? { name: input.name, state: "answered", answer: state.outcome.result.answer }
					: { name: input.name, state: "failed", answer: state.outcome.result.failure };
				return { structuredOutput: agents.map(row) };
			},
		}),
	];
}
