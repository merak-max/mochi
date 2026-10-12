import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	defineDocFamily,
	defineTask,
	type Harness,
	LiveDoc,
	ResetEntry,
	type SubmissionId,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import type { ChatChannelId } from "../channels/types.ts";
import { allPages } from "../pages.ts";
import { plan, scanTriggers } from "../triggers/trigger.ts";
import { keyedReset, threadHandoff, type FastCompletion } from "./lifecycle.ts";

export const CommandSchema = Type.Union([Type.Literal("new"), Type.Literal("stop"), Type.Literal("status")]);
export type Command = "new" | "stop" | "status";
export const commandOf = (text: string): Command | undefined => {
	switch (text.trim().toLowerCase()) {
		case "/new": return "new";
		case "/stop": return "stop";
		case "/status": return "status";
		default: return undefined;
	}
};

/** `conversation` and `person` are set for a guest's command, which acts on the guest's own conversation. */
export type CommandInput = { readonly key: string; readonly command: Command; readonly channel: ChatChannelId; readonly conversation?: ConversationId; readonly person?: string };
export type CommandTurn = { readonly source: "command"; readonly key: string; readonly channel: ChatChannelId; readonly text: string; readonly person?: string };
export type CommandReply = { readonly submission: SubmissionId; readonly text: string };
type State =
	| { readonly phase: "prepare" }
	| { readonly phase: "abort"; readonly tasks: readonly TaskId[]; readonly submissions: readonly SubmissionId[]; readonly running: boolean }
	| { readonly phase: "reset"; readonly handoff: string | null }
	| { readonly phase: "reply"; readonly text: string; readonly submission: SubmissionId | null };

export const CommandDoc = defineDocFamily<{ task: TaskId<CommandReply> | null }, null>({
	kind: "mochi.command",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ task: null }),
});

export interface CommandDeps {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly lineId: () => Conversation["id"];
	readonly fast: FastCompletion;
	readonly now: () => number;
	readonly timeZone: string;
	readonly channels: readonly string[];
	readonly openReply: (tx: Tx, input: CommandTurn) => Promise<TaskId>;
}

const plain = (text: string): string => text.toLowerCase().replace(/[\u2014\u2013*_#`]/g, "").replace(/\s+/g, " ").trim();
export function relativeTime(at: number, now: number): string {
	const minutes = Math.max(1, Math.round(Math.abs(at - now) / 60_000));
	const span = minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
	return Math.abs(at - now) < 30_000 ? "now" : at > now ? `in ${span}` : `${span} ago`;
}

export async function statusText(deps: Pick<CommandDeps, "harness" | "root" | "now" | "timeZone" | "channels">, context: Context): Promise<string> {
	const now = deps.now();
	const [live, view, usage, triggers] = await Promise.all([
		deps.harness.snapshot(LiveDoc, deps.root.id, context),
		deps.root.context(context),
		deps.harness.usage(context),
		deps.harness.commit(scanTriggers, context),
	]);
	const assistant = view.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
	const tokens = assistant === undefined ? 0 : assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite;
	const reset = (await allPages((cursor) => deps.root.entries({}, 256, cursor, context))).find((entry) => entry.kind === ResetEntry.kind);
	const resetAt = reset?.data !== null && typeof reset?.data === "object" && "at" in reset.data && typeof reset.data.at === "number" ? reset.data.at : reset?.model?.[0]?.timestamp;
	const active = triggers.filter((task) => task.state.status !== "terminal" && !task.abortRequested);
	const slots = active.flatMap((task) => {
		if (task.state.status === "terminal" || task.state.status === "completing") return [];
		const checkpoint = task.state.checkpoint;
		if (checkpoint.phase !== "wait") return [checkpoint.slot];
		const next = plan(task.input.trigger, checkpoint.last, now);
		return next.kind === "fire" || next.kind === "miss" ? [next.slot] : [];
	});
	const next = slots.length === 0 ? "no timed slot" : `next ${relativeTime(Math.min(...slots), now)}`;
	const day = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: deps.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
	const entries = await deps.harness.commit(async (tx) => {
		const conversations = await allPages((cursor) => tx.scanConversations({}, 256, cursor));
		return (await Promise.all(conversations.map((conversation) => allPages((cursor) => tx.scanEntries({ conversationId: conversation.id }, 256, cursor))))).flat();
	}, context);
	const older = entries.flatMap((entry) => entry.model ?? []).reduce((sum, message) => {
		if (day(message.timestamp) >= day(now)) return sum;
		return sum + (message.role === "assistant" ? message.usage.cost.total : message.role === "toolResult" ? message.usage?.cost.total ?? 0 : 0);
	}, 0);
	const total = [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((sum, value) => sum + value.cost.total, 0);
	const activity = live?.run === undefined ? "idle" : `busy, ${plain(live.tools?.filter((tool) => tool.status !== "done").map((tool) => tool.name).join(", ") || "answering")}`;
	return [
		`${activity}. thread about ${Math.round(tokens).toLocaleString("en-US")} tokens.`,
		`reset ${resetAt === undefined ? "not yet" : relativeTime(resetAt, now)}. today about $${Math.max(0, total - older).toFixed(2)}.`,
		`${active.length} live triggers, ${next}.`,
		`channels ${deps.channels.length === 0 ? "none" : deps.channels.map(plain).sort().join(", ")}.`,
	].join("\n");
}

async function abortTargets(deps: CommandDeps, target: Conversation, context: Context) {
	const graph = await deps.harness.taskGraph(context);
	try {
		const owned = new Set([target.id]);
		let added = true;
		while (added) {
			added = false;
			for (const task of Object.values(graph.value.tasks)) {
				if (!owned.has(task.conversationId)) continue;
				for (const id of task.conversations) if (!owned.has(id)) { owned.add(id); added = true; }
			}
		}
		const tasks = Object.values(graph.value.tasks).filter((task) => owned.has(task.conversationId)).map((task) => task.id);
		const submissions = (await deps.harness.inspect(context)).submissions.filter((submission) => owned.has(submission.conversationId)).map((submission) => submission.id);
		return { tasks, submissions, running: tasks.length > 0 || submissions.length > 0 };
	} finally {
		graph.dispose();
	}
}

export function commandTask(deps: CommandDeps) {
	const targetOf = async (input: CommandInput, context: Context): Promise<Conversation> => {
		if (input.conversation === undefined) return deps.root;
		const conversation = await deps.harness.conversation(input.conversation, context);
		if (conversation === undefined) throw new Error(`Command conversation ${input.conversation} is missing.`);
		return conversation;
	};
	return defineTask<CommandInput, State, CommandReply>({
		name: "mochi.command",
		version: 1,
		initial: () => ({ phase: "prepare" }),
		phases: {
			prepare: async (task, runtime, context) => {
				const target = await targetOf(task.input, context);
				if (task.input.command === "status") {
					const text = await statusText({ ...deps, root: target }, context);
					return runtime.commit(() => ({ status: "running", checkpoint: { phase: "reply", text, submission: null } }), context);
				}
				const targets = await abortTargets(deps, target, context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "abort", ...targets } }), context);
			},
			abort: async (task, runtime, context) => {
				const targets = task.state.checkpoint;
				// Snapshot IDs make a replay abort only the work the command originally saw.
				for (const id of targets.submissions) await deps.harness.abortSubmission(id, context);
				for (const id of targets.tasks) await deps.harness.abortTask(id, context);
				for (const id of targets.tasks) await deps.harness.waitForTask(id, context);
				if (task.input.command === "stop") {
					const text = targets.running ? "stopped." : "nothing was running.";
					return runtime.commit(() => ({ status: "running", checkpoint: { phase: "reply", text, submission: null } }), context);
				}
				const handoff = await threadHandoff(await targetOf(task.input, context), deps.fast, context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "reset", handoff: handoff ?? null } }), context);
			},
			reset: async (task, runtime, context) => {
				const { handoff } = task.state.checkpoint;
				const submission = await keyedReset(await targetOf(task.input, context), `command-reset:${task.input.key}`, handoff ?? undefined, deps.now(), context);
				const kept = handoff === null ? "" : plain(handoff.split("\n")[0] ?? "").slice(0, 120);
				const text = kept === "" ? "fresh thread." : `fresh thread. kept: ${kept}`;
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "reply", text, submission } }), context);
			},
			reply: async (task, runtime, context) => {
				const { text, submission: resetSubmission } = task.state.checkpoint;
				const line = await deps.harness.conversation(deps.lineId(), context);
				if (line === undefined) throw new Error("Command line is missing.");
				const submission = resetSubmission ?? (await line.submit({
					type: "write", requestId: `command-receipt:${task.input.key}`, entry: { kind: "mochi.command.receipt", data: { key: task.input.key } },
				}, context)).id;
				await runtime.commit(async (tx) => {
					const person = task.input.person;
					await deps.openReply(tx, { source: "command", key: task.input.key, channel: task.input.channel, text, ...(person === undefined ? {} : { person }) });
					return { status: "terminal", outcome: { status: "completed", result: { submission, text } } };
				}, context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export async function runCommand(
	deps: Pick<CommandDeps, "harness" | "lineId"> & { readonly task: ReturnType<typeof commandTask> },
	input: CommandInput,
	context: Context,
): Promise<CommandReply> {
	const id = await deps.harness.commit(async (tx) => {
		const receipt = await tx.doc(CommandDoc, input.key, null);
		if (receipt.task !== null) return receipt.task;
		const id = await tx.createTask(deps.task, input, { ownership: { kind: "conversation" }, conversationId: deps.lineId(), background: true });
		receipt.task = id;
		return id;
	}, context);
	const settled = await deps.harness.waitForTask(id, context);
	if (settled.state.outcome.status !== "completed") throw new Error(`Command ${input.key} ${settled.state.outcome.status}.`);
	return settled.state.outcome.result;
}
