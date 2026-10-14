import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const PROTOCOL_VERSION = "1.0";

export const TASK_WORKING = "TASK_STATE_WORKING";
export const TASK_COMPLETED = "TASK_STATE_COMPLETED";
export const TASK_FAILED = "TASK_STATE_FAILED";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const TASK_NOT_FOUND = -32001;
export const UNAUTHORIZED = -32050;

const PartSchema = Type.Object({
	text: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	raw: Type.Optional(Type.String()),
	data: Type.Optional(Type.Unknown()),
	filename: Type.Optional(Type.String()),
	mediaType: Type.Optional(Type.String()),
});
type Part = Static<typeof PartSchema>;

const MessageSchema = Type.Object({
	messageId: Type.String({ minLength: 1 }),
	role: Type.Optional(Type.String()),
	parts: Type.Array(PartSchema),
	contextId: Type.Optional(Type.String({ minLength: 1 })),
});

export const RequestSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
	method: Type.String(),
	params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type RpcId = string | number | null;

export const SendMessageParamsSchema = Type.Object({
	message: MessageSchema,
	contextId: Type.Optional(Type.String({ minLength: 1 })),
	configuration: Type.Optional(Type.Object({ returnImmediately: Type.Optional(Type.Boolean()), blocking: Type.Optional(Type.Boolean()) })),
});

export const GetTaskParamsSchema = Type.Object({ id: Type.Optional(Type.String({ minLength: 1 })), taskId: Type.Optional(Type.String({ minLength: 1 })) });

const ResponseSchema = Type.Object({
	result: Type.Optional(Type.Unknown()),
	error: Type.Optional(Type.Object({ code: Type.Number(), message: Type.String() })),
});

const TaskOrMessageSchema = Type.Object({
	id: Type.Optional(Type.String()),
	contextId: Type.Optional(Type.String()),
	status: Type.Optional(Type.Object({ state: Type.String(), message: Type.Optional(Type.Object({ parts: Type.Array(PartSchema) })) })),
	artifacts: Type.Optional(Type.Array(Type.Object({ parts: Type.Array(PartSchema) }))),
	parts: Type.Optional(Type.Array(PartSchema)),
});

export function rpcResult(id: RpcId, result: unknown): object {
	return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: RpcId, code: number, message: string): object {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

export function parseResponse(value: unknown): Static<typeof ResponseSchema> | undefined {
	return Value.Check(ResponseSchema, value) ? value : undefined;
}

function fileNote(filename: string | undefined, body: string, mediaType: string | undefined): string {
	const label = filename ? `[file: ${filename}]` : "[file]";
	return mediaType ? `${label} ${body} (${mediaType})` : `${label} ${body}`;
}

export function partsText(parts: readonly Part[]): string {
	const chunks: string[] = [];
	for (const part of parts) {
		if (part.text !== undefined) chunks.push(part.text);
		else if (part.url !== undefined) chunks.push(fileNote(part.filename, part.url, part.mediaType));
		else if (part.raw !== undefined) chunks.push(fileNote(part.filename, `${part.raw.length} bytes base64-encoded`, part.mediaType));
		else if (part.data !== undefined) chunks.push(`[data (${part.mediaType ?? "application/json"})]\n${JSON.stringify(part.data)}`);
	}
	return chunks.join("\n").trim();
}

export function agentCard(name: string, description: string, url: string): object {
	return {
		name,
		description,
		url,
		version: "1.0.0",
		supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: PROTOCOL_VERSION }],
		capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false, extendedAgentCard: false },
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: [{ id: "general", name: "general", description: "Does what the owner's other agents ask, with the owner's tools.", tags: ["general"] }],
		securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
		security: [{ bearer: [] }],
	};
}

export interface TaskView {
	readonly id: string;
	readonly contextId: string;
	readonly state: typeof TASK_WORKING | typeof TASK_COMPLETED | typeof TASK_FAILED;
	readonly text?: string;
}

export function taskJson(view: TaskView): object {
	const status = {
		state: view.state,
		timestamp: new Date().toISOString(),
		...(view.text === undefined ? {} : { message: { role: "ROLE_AGENT", messageId: `${view.id}-status`, contextId: view.contextId, parts: [{ text: view.text }] } }),
	};
	const task = { id: view.id, contextId: view.contextId, status };
	if (view.state !== TASK_COMPLETED || view.text === undefined) return task;
	return { ...task, artifacts: [{ artifactId: `${view.id}-answer`, parts: [{ text: view.text }] }] };
}

export interface ReadResult {
	readonly taskId?: string;
	readonly contextId?: string;
	readonly state: string;
	readonly reply: string;
}

export function readResult(result: unknown): ReadResult | undefined {
	let value = result;
	if (typeof value === "object" && value !== null) {
		const wrapper = value as { task?: unknown; message?: unknown };
		if (typeof wrapper.task === "object" && wrapper.task !== null) value = wrapper.task;
		else if (typeof wrapper.message === "object" && wrapper.message !== null) value = wrapper.message;
	}
	if (!Value.Check(TaskOrMessageSchema, value)) return undefined;
	let reply = "";
	for (const artifact of value.artifacts ?? []) {
		reply = partsText(artifact.parts);
		if (reply !== "") break;
	}
	if (reply === "") reply = partsText(value.status?.message?.parts ?? value.parts ?? []);
	return {
		...(value.id === undefined || value.status === undefined ? {} : { taskId: value.id }),
		...(value.contextId === undefined ? {} : { contextId: value.contextId }),
		state: value.status?.state ?? TASK_COMPLETED,
		reply,
	};
}
