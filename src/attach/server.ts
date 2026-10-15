import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { Context } from "@earendil-works/chord";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type ConversationId, type ConversationWatch, type Cursor, type Harness, type ModelRef, type SubmissionId, type TaskGraphWatch } from "@earendil-works/pi-durable";
import type { ChatUser } from "../config.ts";
import type { Log } from "../log.ts";
import type { Profiles } from "../profiles/profiles.ts";
import { answerText, ingest, type Line } from "../turn/turn.ts";
import {
	type Answer,
	type DaemonInfo,
	type ModelSummary,
	opOf,
	PROTOCOL,
	parseClientMessage,
	type Request,
	type Results,
	readLines,
	type Target,
	type ServerMessage,
	writeLine,
} from "./protocol.ts";
import { resolveTarget, roster, type RosterDeps } from "./roster.ts";

/** What only startDaemon knows. `roles` maps each config model name (brain, fast, an alias) to its model. */
export type DaemonFacts = {
	readonly startedAt: Date;
	readonly build: string;
	readonly home: string;
	readonly scheduling: "daemon" | "local";
	readonly channels: readonly string[];
	readonly setup: readonly string[];
	readonly roles: Readonly<Record<string, ModelRef>>;
};

export type AttachDeps = {
	readonly line: Line;
	readonly models: Models;
	readonly log: Log;
	readonly profiles: Profiles;
	readonly users: readonly ChatUser[];
	readonly facts: DaemonFacts;
};

const EXPORT_PAGE = 256;

export const protocolMismatch = (theirs: number): string =>
	`This daemon speaks mochi protocol ${PROTOCOL} and the client speaks protocol ${theirs}. Restart the older side: mochi stop, then start mochi again.`;

export async function listenAttach(path: string, deps: AttachDeps, context: Context): Promise<Server> {
	const { line, models, log, facts } = deps;
	const { harness, root } = line;
	const rosterDeps: RosterDeps = { harness, root: root.id, line: line.id, profiles: deps.profiles, users: deps.users };
	const sockets = new Set<Socket>();
	let sequence = 0;
	const info: DaemonInfo = { protocol: PROTOCOL, pid: process.pid, startedAt: facts.startedAt.toISOString(), build: facts.build };
	const conversation = async (to: Target) => {
		const id = await resolveTarget(rosterDeps, to, context);
		const found = await harness.conversation(id, context);
		if (found === undefined) throw new Error(`Conversation ${id} does not exist.`);
		return found;
	};

	const handle = async (request: Request, show: (id: ConversationId) => Promise<void>, watchTasks: () => Promise<void>): Promise<Results[keyof Results]> => {
		switch (request.op) {
			case "hello":
				if (request.watch) {
					await show(root.id);
					await watchTasks();
				}
				return info;
			case "show":
				await show((await conversation(request.to)).id);
				return null;
			case "submit": {
				const target = await conversation(request.to);
				const messageId = request.messageId ?? `${Date.now()}-${++sequence}`;
				const inbound = { kind: "cli", messageId, text: request.text, at: new Date(), to: target.id, whenBusy: request.whenBusy } as const;
				return { submissionId: await ingest(line, inbound, context) };
			}
			case "abort":
				await (await conversation(request.to)).abort(context, { background: request.everything });
				return null;
			case "compact":
				await (await conversation(request.to)).compact(request.instructions, context);
				return null;
			case "reset":
				await (await conversation(request.to)).reset(undefined, context);
				return null;
			case "configure": {
				const target = await conversation(request.to);
				await target.configure(
					{
						...(request.model === undefined ? {} : { model: request.model }),
						...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel as ModelThinkingLevel }),
					},
					context,
				);
				return null;
			}
			case "agents":
				return roster(rosterDeps, context);
			case "models":
				return modelSummaries(models, facts.roles);
			case "usage":
				return harness.usage(context);
			case "status": {
				const graph = await harness.taskGraph(context);
				const liveTasks = Object.keys(graph.value.tasks).length;
				graph.dispose();
				const { home, scheduling, channels, setup } = facts;
				return { ...info, home, scheduling, channels, setup, usage: await harness.usage(context), liveTasks };
			}
			case "wait":
				return answerOf(harness, request.submissionId as SubmissionId, context);
			case "export": {
				const target = await conversation(request.to);
				return target.entries({ order: "ascending" }, EXPORT_PAGE, request.cursor as Cursor | undefined, context);
			}
			default: {
				const _exhaustive: never = request;
				throw new Error(`Unknown request ${JSON.stringify(_exhaustive)}`);
			}
		}
	};

	const accept = (socket: Socket): void => {
		let view: ConversationWatch | undefined;
		let tasks: TaskGraphWatch | undefined;
		let greeted = false;
		const send = (message: ServerMessage) => writeLine(socket, message);
		const show = async (id: ConversationId): Promise<void> => {
			const found = await harness.conversation(id, context);
			if (found === undefined) throw new Error(`Conversation ${id} does not exist.`);
			const next = await found.watch(context);
			await view?.stop();
			view = next;
			send({ t: "view", value: next.value });
			next.start(async (_value, ops) => send({ t: "view-ops", ops }));
		};
		const watchTasks = async (): Promise<void> => {
			if (tasks !== undefined) return;
			tasks = await harness.watchTaskGraph(context);
			send({ t: "tasks", value: tasks.value });
			tasks.start(async (_value, ops) => send({ t: "tasks-ops", ops }));
		};
		// One error frame, then this connection closes. A reply carries the text too when the line had an id, so an
		// older client that waits on that id shows it.
		const refuse = (problem: string, id: unknown): void => {
			log("attach.refused", { problem });
			if (typeof id === "number") send({ t: "reply", id, ok: false, error: problem });
			send({ t: "error", error: problem });
			socket.end();
		};
		sockets.add(socket);
		readLines(
			socket,
			(raw) => {
				const id = typeof raw === "object" && raw !== null && "id" in raw ? raw.id : undefined;
				// A protocol 1 client sends no hello: its first request names another op.
				if (!greeted && opOf(raw) !== undefined && opOf(raw) !== "hello") {
					refuse(protocolMismatch(1), id);
					return;
				}
				const parsed = parseClientMessage(raw);
				if (!parsed.ok) {
					refuse(parsed.problem, id);
					return;
				}
				const message = parsed.value;
				if (!greeted && message.request.op !== "hello") {
					refuse(protocolMismatch(1), message.id);
					return;
				}
				if (message.request.op === "hello" && message.request.protocol !== PROTOCOL) {
					refuse(protocolMismatch(message.request.protocol), message.id);
					return;
				}
				greeted = true;
				void handle(message.request, show, watchTasks)
					.then((value) => send({ t: "reply", id: message.id, ok: true, value }))
					.catch((error: unknown) => send({ t: "reply", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
			},
			(problem) => refuse(problem, undefined),
		);
		socket.on("close", () => {
			sockets.delete(socket);
			void view?.stop();
			void tasks?.stop();
		});
		socket.on("error", () => socket.destroy());
	};

	rmSync(path, { force: true });
	const server = createServer(accept);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			chmodSync(path, 0o600);
			resolve();
		});
	});
	context.abortSignal?.addEventListener("abort", () => {
		server.close();
		for (const socket of sockets) socket.destroy();
	}, { once: true });
	return server;
}

export function modelSummaries(models: Models, roles: Readonly<Record<string, ModelRef>>): ModelSummary[] {
	const result: ModelSummary[] = [];
	for (const model of models.getModels()) {
		const names: string[] = [];
		for (const [name, ref] of Object.entries(roles)) {
			if (ref.provider === model.provider && ref.modelId === model.id) names.push(name);
		}
		result.push({ provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow, roles: names });
	}
	return result;
}

async function answerOf(harness: Harness, id: SubmissionId, context: Context): Promise<Answer> {
	const submission = await harness.submission(id, context);
	if (submission === undefined) throw new Error(`No submission ${id}.`);
	const settled = await submission.wait(context);
	if (settled.status === "unanswered") return { status: "unanswered", reason: settled.reason ?? "unknown" };
	if (settled.type !== "input") return { status: "done", text: "" };
	return { status: "done", text: await harness.commit((tx) => answerText(tx, settled.answer), context) };
}
