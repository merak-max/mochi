import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { parseResponse, PROTOCOL_VERSION, type ReadResult, readResult } from "./protocol.ts";

const CARD_TIMEOUT_MS = 5_000;

export interface A2APeer {
	readonly name: string;
	readonly url: string;
	readonly token: string | undefined;
	readonly tokenEnv: string;
	readonly timeoutMs: number;
}

export type A2APeers = ReadonlyMap<string, A2APeer>;

const signalOf = (timeoutMs: number, signal: AbortSignal | undefined): AbortSignal =>
	signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

function peerOf(peers: A2APeers, name: string): A2APeer & { readonly token: string } {
	const peer = peers.get(name);
	if (peer === undefined) throw new Error(`No A2A peer named ${name}. Configured: ${[...peers.keys()].join(", ") || "none"}.`);
	if (peer.token === undefined) throw new Error(`A2A peer ${name}: ${peer.tokenEnv} is not set.`);
	return { ...peer, token: peer.token };
}

async function call(peer: A2APeer & { readonly token: string }, method: string, params: object, signal: AbortSignal | undefined): Promise<ReadResult> {
	const response = await fetch(peer.url, {
		method: "POST",
		headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json", "A2A-Version": PROTOCOL_VERSION },
		body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
		signal: signalOf(peer.timeoutMs, signal),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`A2A peer ${peer.name}: HTTP ${response.status}: ${text.slice(0, 300)}`);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`A2A peer ${peer.name}: HTTP ${response.status}: the answer is not JSON`);
	}
	const parsed = parseResponse(body);
	if (parsed?.error !== undefined) throw new Error(`A2A peer ${peer.name}: error ${parsed.error.code}: ${parsed.error.message}`);
	const result = readResult(parsed?.result);
	if (result === undefined) throw new Error(`A2A peer ${peer.name}: HTTP ${response.status}: the result is no task or message`);
	return result;
}

function sendParams(message: string, contextId: string, returnImmediately: boolean): object {
	const params = { message: { messageId: randomUUID(), role: "ROLE_USER", contextId, parts: [{ text: message }] } };
	return returnImmediately ? { ...params, configuration: { returnImmediately: true, blocking: false } } : params;
}

const Ask = Type.Object({
	agent: Type.String({ minLength: 1 }),
	message: Type.String({ minLength: 1 }),
	contextId: Type.Optional(Type.String({ minLength: 1 })),
});

export function a2aFns(peers: A2APeers): readonly ToolRegistration[] {
	return [
		defineTool({
			name: "a2a_list",
			description: "The owner's other agents reachable over A2A, with whether each answers now.",
			parameters: Type.Object({}),
			structuredOutputSchema: Type.Array(
				Type.Object({ name: Type.String(), url: Type.String(), reachable: Type.Boolean(), card: Type.Optional(Type.Object({ name: Type.String(), description: Type.String() })) }),
			),
			replay: "safe",
			execute: async (_args, _api, context) => {
				const listed = await Promise.all(
					[...peers.values()].map(async (peer) => {
						try {
							const response = await fetch(`${peer.url.replace(/\/+$/, "")}/.well-known/agent-card.json`, { signal: signalOf(CARD_TIMEOUT_MS, context.abortSignal) });
							if (!response.ok) return { name: peer.name, url: peer.url, reachable: false };
							const card = (await response.json()) as { name?: unknown; description?: unknown };
							return { name: peer.name, url: peer.url, reachable: true, card: { name: String(card.name ?? ""), description: String(card.description ?? "") } };
						} catch {
							return { name: peer.name, url: peer.url, reachable: false };
						}
					}),
				);
				return { structuredOutput: listed };
			},
		}),
		defineTool({
			name: "a2a_ask",
			description: "Ask another of the owner's agents and wait for its reply. Pass contextId again to continue that thread.",
			parameters: Ask,
			structuredOutputSchema: Type.Object({ reply: Type.String(), contextId: Type.String(), state: Type.String(), taskId: Type.Optional(Type.String()) }),
			replay: "unsafe",
			execute: async ({ agent, message, contextId }, _api, context) => {
				const thread = contextId ?? randomUUID();
				const result = await call(peerOf(peers, agent), "SendMessage", sendParams(message, thread, false), context.abortSignal);
				return { structuredOutput: { reply: result.reply, contextId: result.contextId ?? thread, state: result.state, ...(result.taskId === undefined ? {} : { taskId: result.taskId }) } };
			},
		}),
		defineTool({
			name: "a2a_send",
			description: "Send work to another of the owner's agents without waiting. Check it later with a2a_status.",
			parameters: Ask,
			structuredOutputSchema: Type.Object({ taskId: Type.Optional(Type.String()), contextId: Type.String(), state: Type.String() }),
			replay: "unsafe",
			execute: async ({ agent, message, contextId }, _api, context) => {
				const thread = contextId ?? randomUUID();
				const result = await call(peerOf(peers, agent), "SendMessage", sendParams(message, thread, true), context.abortSignal);
				return { structuredOutput: { contextId: result.contextId ?? thread, state: result.state, ...(result.taskId === undefined ? {} : { taskId: result.taskId }) } };
			},
		}),
		defineTool({
			name: "a2a_status",
			description: "The state of a task sent with a2a_send, and its reply once done.",
			parameters: Type.Object({ agent: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }) }),
			structuredOutputSchema: Type.Object({ state: Type.String(), reply: Type.Optional(Type.String()) }),
			replay: "safe",
			execute: async ({ agent, taskId }, _api, context) => {
				const result = await call(peerOf(peers, agent), "GetTask", { id: taskId }, context.abortSignal);
				return { structuredOutput: { state: result.state, ...(result.reply === "" ? {} : { reply: result.reply }) } };
			},
		}),
	];
}
