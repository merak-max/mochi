import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId, defineDocFamily, type Harness, ROOT_CONVERSATION_ID, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { Config } from "../config.ts";
import { readBody, safeEqual } from "../http.ts";
import { type Log, log } from "../log.ts";
import type { Mochi } from "../mochi.ts";
import { pause } from "../pause.ts";
import { createSeatConversation } from "../seats.ts";
import { broken, ready, type Setup } from "../setup.ts";
import { formatStamp } from "../text.ts";
import { answerText } from "../turn/turn.ts";
import {
	agentCard,
	GetTaskParamsSchema,
	INVALID_PARAMS,
	INVALID_REQUEST,
	METHOD_NOT_FOUND,
	PARSE_ERROR,
	partsText,
	RequestSchema,
	type RpcId,
	rpcError,
	rpcResult,
	SendMessageParamsSchema,
	TASK_COMPLETED,
	TASK_FAILED,
	TASK_NOT_FOUND,
	TASK_WORKING,
	type TaskView,
	taskJson,
	UNAUTHORIZED,
} from "./protocol.ts";

const BODY_LIMIT = 1024 * 1024;
const CARD_PATHS = ["/.well-known/agent-card.json", "/.well-known/agent.json"];

/** The conversation of one peer's A2A context, keyed `<peer>:<contextId>`. One writer: `ensureContext`. */
export const A2AContextDoc = defineDocFamily<{ conversation: ConversationId | null }, null>({
	kind: "mochi.a2a-context",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ conversation: null }),
});

export type A2ATask = { peer: string; contextId: string; conversation: ConversationId; submission: SubmissionId };

/** One A2A task, keyed by task id. One writer: `recordTask`. */
export const A2ATaskDoc = defineDocFamily<{ task: A2ATask | null }, null>({
	kind: "mochi.a2a-task",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ task: null }),
});

export interface A2AServerSettings {
	/** Peer name to bearer token. */
	readonly tokens: ReadonlyMap<string, string>;
	readonly host: string;
	readonly port: number;
	readonly publicUrl: string;
	readonly agentName: string;
	readonly replyTimeoutMs: number;
}

/** The server settings from `MOCHI_A2A_*`. Without peer tokens the server stays off. */
export function a2aServerSetup(env: Config["env"]): Setup<A2AServerSettings> {
	const raw = env.MOCHI_A2A_PEER_TOKENS?.trim() ?? "";
	if (raw === "") return broken("the server is off. Fix: set MOCHI_A2A_PEER_TOKENS=name:token,name2:token2");
	const tokens = new Map<string, string>();
	for (const pair of raw.split(",")) {
		const at = pair.indexOf(":");
		const name = pair.slice(0, at).trim();
		const token = pair.slice(at + 1).trim();
		if (!/^[a-z0-9-]+$/.test(name) || token === "" || tokens.has(name)) {
			return broken("MOCHI_A2A_PEER_TOKENS needs unique name:token pairs, each name in lowercase letters, digits or dashes. Fix: correct it where mochi starts");
		}
		tokens.set(name, token);
	}
	const host = env.MOCHI_A2A_HOST?.trim() || "127.0.0.1";
	const port = Number(env.MOCHI_A2A_PORT?.trim() || 8789);
	const replyTimeoutSeconds = Number(env.MOCHI_A2A_REPLY_TIMEOUT_SECONDS?.trim() || 600);
	if (!Number.isInteger(port) || port < 0 || port > 65535) return broken("MOCHI_A2A_PORT is not a port number. Fix: correct it where mochi starts");
	if (!(replyTimeoutSeconds > 0)) return broken("MOCHI_A2A_REPLY_TIMEOUT_SECONDS is not a positive number. Fix: correct it where mochi starts");
	return ready({
		tokens,
		host,
		port,
		publicUrl: env.MOCHI_A2A_PUBLIC_URL?.trim() || `http://${host}:${port}`,
		agentName: env.MOCHI_A2A_AGENT_NAME?.trim() || "mochi",
		replyTimeoutMs: replyTimeoutSeconds * 1000,
	});
}

export function contextInstructions(peer: string): string {
	return (
		`This conversation is with ${peer}, another AI agent that works for the owner. Its messages are requests from that agent. ` +
		"Do the work with your tools, then answer with the result as plain text."
	);
}

/** Inside a commit: the conversation of one peer's context, created on its first message. */
export async function ensureContext(tx: Tx, peer: string, contextId: string): Promise<ConversationId> {
	const doc = await tx.doc(A2AContextDoc, `${peer}:${contextId}`, null);
	if (doc.conversation === null) {
		// Root's own instructions come first, so a profile answers its peers as itself.
		const own = (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).instructions;
		const instructions = own === undefined || own === "" ? contextInstructions(peer) : `${own}\n\n${contextInstructions(peer)}`;
		doc.conversation = await createSeatConversation(tx, "agent", { kind: "ownerless" }, { instructions });
	}
	return doc.conversation;
}

/** Inside a commit: the task of a submission. A redelivered message finds its task already there. */
export async function recordTask(tx: Tx, taskId: string, task: A2ATask): Promise<void> {
	const doc = await tx.doc(A2ATaskDoc, taskId, null);
	if (doc.task === null) doc.task = task;
}

export const taskIdOf = (submission: SubmissionId): string => `a2a-${submission}`;

export function contextTag(peer: string, at: Date, timeZone: string, contextId: string, messageId: string): string {
	return `[a2a ${peer} ${formatStamp(at, timeZone)} context=${contextId} id=${messageId}]`;
}

interface ServerDeps {
	readonly harness: Harness;
	readonly settings: A2AServerSettings;
	readonly timeZone: string;
	readonly log: Log;
}

/** Serves the agent card and JSON-RPC on `POST /` until `context` aborts. Resolves with the bound address once listening. */
export async function startA2AServer(deps: ServerDeps, context: Context): Promise<{ readonly server: Server; readonly address: AddressInfo }> {
	const server = createServer((request, response) => {
		handle(deps, request, response, context).catch((error: unknown) => {
			deps.log("a2a.failed", { url: request.url, error: String(error) });
			if (!response.headersSent) sendJson(response, 500, rpcError(null, -32603, "internal error"));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(deps.settings.port, deps.settings.host, () => resolve());
	});
	context.abortSignal?.addEventListener("abort", () => server.close(), { once: true });
	return { server, address: server.address() as AddressInfo };
}

/** The peer whose token the request carries, or undefined. */
function peerOf(tokens: ReadonlyMap<string, string>, header: string | undefined): string | undefined {
	if (header === undefined || !header.startsWith("Bearer ")) return undefined;
	const given = header.slice(7).trim();
	let found: string | undefined;
	for (const [name, token] of tokens) {
		if (safeEqual(given, token)) found = name;
	}
	return found;
}

async function handle(deps: ServerDeps, request: IncomingMessage, response: ServerResponse, context: Context): Promise<void> {
	const { settings } = deps;
	const path = new URL(request.url ?? "/", "http://a2a").pathname;
	if (request.method === "GET" && CARD_PATHS.includes(path)) {
		const card = agentCard({ name: settings.agentName, description: "The owner's personal agent, mochi. Ask it to do work with the owner's tools.", url: settings.publicUrl });
		return sendJson(response, 200, card);
	}
	const peer = peerOf(settings.tokens, request.headers.authorization);
	if (peer === undefined) {
		deps.log("a2a.unauthorized", { url: request.url, remote: request.socket.remoteAddress });
		return sendJson(response, 401, rpcError(null, UNAUTHORIZED, "unauthorized"));
	}
	if (request.method !== "POST" || path !== "/") return sendJson(response, 404, { error: "not found" });
	const body = await readBody(request, response, BODY_LIMIT);
	if (body === undefined) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.toString("utf8"));
	} catch {
		return sendJson(response, 200, rpcError(null, PARSE_ERROR, "parse error"));
	}
	if (!Value.Check(RequestSchema, parsed)) return sendJson(response, 200, rpcError(null, INVALID_REQUEST, "invalid JSON-RPC request"));
	const id = parsed.id ?? null;
	const params = parsed.params ?? {};
	switch (parsed.method) {
		case "SendMessage":
		case "message/send":
			return sendJson(response, 200, await sendMessage(deps, peer, id, params, context));
		case "GetTask":
		case "tasks/get":
			return sendJson(response, 200, await getTask(deps, peer, id, params, context));
		default:
			return sendJson(response, 200, rpcError(id, METHOD_NOT_FOUND, `method not found: ${parsed.method}`));
	}
}

async function sendMessage(deps: ServerDeps, peer: string, id: RpcId, params: unknown, context: Context): Promise<object> {
	const { harness } = deps;
	if (!Value.Check(SendMessageParamsSchema, params)) return rpcError(id, INVALID_PARAMS, "params.message needs messageId and parts");
	const { message, configuration } = params;
	const text = partsText(message.parts);
	if (text === "") return rpcError(id, INVALID_PARAMS, "the message has no text");
	const contextId = message.contextId ?? params.contextId ?? randomUUID();
	const conversationId = await harness.commit((tx) => ensureContext(tx, peer, contextId), context);
	const conversation = (await harness.conversation(conversationId, context))!;
	const content = `${contextTag(peer, new Date(), deps.timeZone, contextId, message.messageId)}\n${text}`;
	const submission = await conversation.submit({ type: "input", content, requestId: `a2a:${peer}:${message.messageId}`, whenBusy: "followUp" }, context);
	const taskId = taskIdOf(submission.id);
	const task: A2ATask = { peer, contextId, conversation: conversationId, submission: submission.id };
	await harness.commit((tx) => recordTask(tx, taskId, task), context);
	deps.log("a2a.received", { peer, contextId, messageId: message.messageId, taskId });

	const returnImmediately = configuration?.returnImmediately === true || configuration?.blocking === false;
	if (!returnImmediately) {
		const race = withCancel(context);
		await Promise.race([submission.wait(race.context), pause(deps.settings.replyTimeoutMs, race.context.abortSignal)]).finally(() => race.cancel());
	}
	const view = await taskView(harness, taskId, task, context);
	if (view.state !== TASK_WORKING) deps.log("a2a.answered", { peer, taskId, state: view.state });
	return rpcResult(id, { task: taskJson(view) });
}

async function getTask(deps: ServerDeps, peer: string, id: RpcId, params: unknown, context: Context): Promise<object> {
	if (!Value.Check(GetTaskParamsSchema, params)) return rpcError(id, INVALID_PARAMS, "params.id must be a task id");
	const taskId = params.id ?? params.taskId;
	if (taskId === undefined) return rpcError(id, INVALID_PARAMS, "params.id must be a task id");
	const task = (await deps.harness.snapshot(A2ATaskDoc, taskId, context))?.task ?? null;
	if (task === null || task.peer !== peer) return rpcError(id, TASK_NOT_FOUND, `task not found: ${taskId}`);
	return rpcResult(id, taskJson(await taskView(deps.harness, taskId, task, context)));
}

/** The task's state, read from its submission: queued or placed is working, done is completed, unanswered is failed. */
async function taskView(harness: Harness, taskId: string, task: A2ATask, context: Context): Promise<TaskView> {
	const submission = await harness.submission(task.submission, context);
	if (submission === undefined) return { id: taskId, contextId: task.contextId, state: TASK_FAILED, text: "the submission is gone" };
	const record = await submission.status(context);
	if (record.type !== "input") return { id: taskId, contextId: task.contextId, state: TASK_FAILED, text: "the submission is not an input" };
	if (record.status === "done") {
		const text = await harness.commit((tx) => answerText(tx, record.answer), context);
		return { id: taskId, contextId: task.contextId, state: TASK_COMPLETED, text };
	}
	if (record.status === "unanswered") return { id: taskId, contextId: task.contextId, state: TASK_FAILED, text: record.reason };
	return { id: taskId, contextId: task.contextId, state: TASK_WORKING };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

/** The daemon's A2A component: serve peers until `context` aborts. Off without peer tokens. */
export async function a2aComponent({ harness }: Mochi, config: Config, setup: Setup<A2AServerSettings>, context: Context): Promise<void> {
	if (setup.kind !== "ready") return;
	const { address } = await startA2AServer({ harness, settings: setup.value, timeZone: config.timeZone, log }, context);
	log("a2a.started", { peers: [...setup.value.tokens.keys()], listen: `${address.address}:${address.port}` });
}
