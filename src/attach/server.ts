import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { Context } from "@earendil-works/chord";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type ConversationWatch,
	type Harness,
	type SubmissionId,
	type TaskGraphWatch,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { Log } from "../log.ts";
import { allPages } from "../pages.ts";
import { messageText } from "../text.ts";
import { answerText, ingest, type Line } from "../turn/turn.ts";
import { type Answer, type ClientMessage, type ConversationSummary, type Request, type Results, readLines, type ServerMessage, writeLine } from "./protocol.ts";

export async function listenAttach(path: string, { line, models, log }: { readonly line: Line; readonly models: Models; readonly log: Log }, context: Context): Promise<Server> {
	const { harness, root } = line;
	const sockets = new Set<Socket>();
	let sequence = 0;
	const conversation = async (id: number) => {
		const found = await harness.conversation(id as ConversationId, context);
		if (found === undefined) throw new Error(`Conversation ${id} does not exist.`);
		return found;
	};

	const handle = async (request: Request, show: (id: ConversationId) => Promise<void>): Promise<Results[keyof Results]> => {
		switch (request.op) {
			case "show":
				await show(request.conversationId as ConversationId);
				return null;
			case "submit": {
				if (request.conversationId === root.id) {
					const messageId = request.messageId ?? `${Date.now()}-${++sequence}`;
					return { submissionId: await ingest(line, { kind: "cli", messageId, text: request.text, at: new Date() }, context) };
				}
				const target = await conversation(request.conversationId);
				return { submissionId: (await target.submit({ type: "input", content: request.text, whenBusy: request.whenBusy }, context)).id };
			}
			case "abort":
				await (await conversation(request.conversationId)).abort(context, { background: request.everything });
				return null;
			case "compact":
				await (await conversation(request.conversationId)).compact(request.instructions, context);
				return null;
			case "reset":
				await (await conversation(request.conversationId)).reset(undefined, context);
				return null;
			case "configure": {
				const target = await conversation(request.conversationId);
				await target.configure(
					{
						...(request.model === undefined ? {} : { model: request.model }),
						...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel as ModelThinkingLevel }),
					},
					context,
				);
				return null;
			}
			case "conversations":
				return summaries(harness, root.id, line.id, context);
			case "models":
				return models.getModels().map((model) => ({ provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow }));
			case "usage":
				return harness.usage(context);
			case "wait":
				return answerOf(harness, request.submissionId as SubmissionId, context);
			default: {
				const _exhaustive: never = request;
				throw new Error(`Unknown request ${JSON.stringify(_exhaustive)}`);
			}
		}
	};

	const accept = (socket: Socket): void => {
		let view: ConversationWatch | undefined;
		let tasks: TaskGraphWatch | undefined;
		const send = (message: ServerMessage) => writeLine(socket, message);
		const show = async (id: ConversationId): Promise<void> => {
			const next = await (await conversation(id)).watch(context);
			await view?.stop();
			view = next;
			send({ t: "view", value: next.value });
			next.start(async (_value, ops) => send({ t: "view-ops", ops }));
		};
		const watchTasks = async (): Promise<void> => {
			tasks = await harness.watchTaskGraph(context);
			send({ t: "tasks", value: tasks.value });
			tasks.start(async (_value, ops) => send({ t: "tasks-ops", ops }));
		};
		sockets.add(socket);
		readLines(socket, (raw) => {
			const message = raw as ClientMessage;
			void handle(message.request, show)
				.then((value) => send({ t: "reply", id: message.id, ok: true, value }))
				.catch((error: unknown) => send({ t: "reply", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
		});
		socket.on("close", () => {
			sockets.delete(socket);
			void view?.stop();
			void tasks?.stop();
		});
		socket.on("error", () => socket.destroy());
		void show(root.id).then(watchTasks).catch((error: unknown) => log("attach.failed", { error: String(error) }));
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

async function answerOf(harness: Harness, id: SubmissionId, context: Context): Promise<Answer> {
	const submission = await harness.submission(id, context);
	if (submission === undefined) throw new Error(`No submission ${id}.`);
	const settled = await submission.wait(context);
	if (settled.status === "unanswered") return { status: "unanswered", reason: settled.reason ?? "unknown" };
	if (settled.type !== "input") return { status: "done", text: "" };
	return { status: "done", text: await harness.commit((tx) => answerText(tx, settled.answer), context) };
}

async function summaries(harness: Harness, rootId: ConversationId, lineId: ConversationId, context: Context): Promise<ConversationSummary[]> {
	const result: ConversationSummary[] = [];
	for (const { id } of await allPages((cursor) => harness.commit((tx) => tx.scanConversations({}, 256, cursor), context))) {
		if (id === lineId) continue;
		if (id === rootId) {
			result.push({ id, label: "main" });
			continue;
		}
		const first = await firstInput(harness, id, context);
		result.push({ id, label: `conversation ${id}`, ...(first === undefined ? {} : { title: first }) });
	}
	return result;
}

async function firstInput(harness: Harness, id: ConversationId, context: Context): Promise<string | undefined> {
	const conversation = await harness.conversation(id, context);
	if (conversation === undefined) return undefined;
	let first: string | undefined;
	for (const entry of await allPages((cursor) => conversation.entries({}, 256, cursor, context))) {
		if (UserEntry.is(entry) && entry.model?.[0] !== undefined) first = messageText(entry.model[0]);
	}
	return first?.replace(/\s+/g, " ").trim().slice(0, 120);
}
