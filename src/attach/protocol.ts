import type { Socket } from "node:net";
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView, Cursor, EntryRecord, ModelRef, Page, TaskGraph, UsageState } from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

/** Bump on every change to Request, Results or ServerMessage. A client says its number in hello; the daemon refuses another. */
export const PROTOCOL = 3;

/** A conversation id, or a label such as "main" or "profile:relay". Only the daemon resolves labels. */
const TargetSchema = Type.Union([Type.Integer({ minimum: 1 }), Type.String({ minLength: 1, maxLength: 200 })]);
export type Target = Static<typeof TargetSchema>;

const WhenBusySchema = Type.Union([Type.Literal("steer"), Type.Literal("followUp")]);

export const RequestSchema = Type.Union([
	/** First request on every connection. `watch`: stream main's view and the task graph from now on. */
	Type.Object({ op: Type.Literal("hello"), protocol: Type.Integer(), watch: Type.Boolean() }),
	Type.Object({ op: Type.Literal("show"), to: TargetSchema }),
	Type.Object({
		op: Type.Literal("submit"),
		to: TargetSchema,
		text: Type.String(),
		whenBusy: WhenBusySchema,
		messageId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._:-]+$", maxLength: 200 })),
	}),
	Type.Object({ op: Type.Literal("abort"), to: TargetSchema, everything: Type.Boolean() }),
	Type.Object({ op: Type.Literal("compact"), to: TargetSchema, instructions: Type.Optional(Type.String()) }),
	Type.Object({ op: Type.Literal("reset"), to: TargetSchema }),
	Type.Object({
		op: Type.Literal("configure"),
		to: TargetSchema,
		model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
		thinkingLevel: Type.Optional(Type.String()),
	}),
	Type.Object({ op: Type.Literal("agents") }),
	Type.Object({ op: Type.Literal("models") }),
	Type.Object({ op: Type.Literal("usage") }),
	Type.Object({ op: Type.Literal("status") }),
	Type.Object({ op: Type.Literal("wait"), submissionId: Type.Integer() }),
	/** One page of a conversation's fork-aware history, oldest first. */
	Type.Object({ op: Type.Literal("export"), to: TargetSchema, cursor: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
]);
export type Request = Static<typeof RequestSchema>;

const ClientMessageSchema = Type.Object({ id: Type.Integer(), request: RequestSchema });
export type ClientMessage = Static<typeof ClientMessageSchema>;

export type AgentKind = "root" | "line" | "profile" | "trigger" | "fork" | "agent" | "user" | "conversation";

/**
 * One conversation as the CLI names it. Labels: main, line, profile:<name>, trigger:<id>, fork:<name>@<id>,
 * agent:<name>@<id>, user:<user id>, else conversation:<id>.
 */
export type AgentSummary = {
	readonly id: number;
	readonly kind: AgentKind;
	readonly label: string;
	/** The conversation that made this one: its owner task's conversation, else its fork parent. */
	readonly parent?: number;
	readonly state: "busy" | "idle";
	/** "<provider>/<model id>". */
	readonly model?: string;
	readonly title?: string;
};

/** `roles`: the config names that pick this model, such as brain, fast, strongest, classifier or an alias. */
export type ModelSummary = ModelRef & { readonly name: string; readonly contextWindow: number; readonly roles: readonly string[] };

/** Tokens one model or tool used. mochi carries no prices; the model provider bills. */
export type TokenCounts = { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly total: number };
export type TokenUsage = { readonly models: Readonly<Record<string, TokenCounts>>; readonly tools: Readonly<Record<string, TokenCounts>> };

/** pi-durable's usage ledger with its cost fields left out. */
export function tokenUsage(state: UsageState): TokenUsage {
	const counts = (bucket: UsageState["models"]): Record<string, TokenCounts> => {
		const out: Record<string, TokenCounts> = {};
		for (const [key, usage] of Object.entries(bucket)) {
			out[key] = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.totalTokens };
		}
		return out;
	};
	return { models: counts(state.models), tools: counts(state.tools) };
}

export type DaemonInfo = { readonly protocol: number; readonly pid: number; readonly startedAt: string; readonly build: string };

export type DaemonStatus = DaemonInfo & {
	readonly home: string;
	/** "local": a terminal became the daemon, so no triggers, board or delivery run. */
	readonly scheduling: "daemon" | "local";
	readonly channels: readonly string[];
	/** The boot setup report, one line per boundary. */
	readonly setup: readonly string[];
	readonly usage: TokenUsage;
	readonly liveTasks: number;
};

export type Answer =
	| { readonly status: "done"; readonly text: string }
	| { readonly status: "unanswered"; readonly reason: string };

export type Results = {
	hello: DaemonInfo;
	show: null;
	submit: { readonly submissionId: number };
	abort: null;
	compact: null;
	reset: null;
	configure: null;
	agents: readonly AgentSummary[];
	models: readonly ModelSummary[];
	usage: TokenUsage;
	status: DaemonStatus;
	wait: Answer;
	export: Page<EntryRecord, Cursor>;
};

export type ServerMessage =
	| { readonly t: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
	| { readonly t: "reply"; readonly id: number; readonly ok: false; readonly error: string }
	/** The daemon could not read a line. It closes the connection after this frame. */
	| { readonly t: "error"; readonly error: string }
	| { readonly t: "view"; readonly value: ConversationView }
	| { readonly t: "view-ops"; readonly ops: readonly Op[] }
	| { readonly t: "tasks"; readonly value: TaskGraph }
	| { readonly t: "tasks-ops"; readonly ops: readonly Op[] };

// Checks only the frame shape; the payloads come from the daemon's own types.
const ServerMessageSchema = Type.Union([
	Type.Object({ t: Type.Literal("reply"), id: Type.Integer(), ok: Type.Literal(true), value: Type.Unknown() }),
	Type.Object({ t: Type.Literal("reply"), id: Type.Integer(), ok: Type.Literal(false), error: Type.String() }),
	Type.Object({ t: Type.Literal("error"), error: Type.String() }),
	Type.Object({ t: Type.Union([Type.Literal("view"), Type.Literal("tasks")]), value: Type.Object({}) }),
	Type.Object({ t: Type.Union([Type.Literal("view-ops"), Type.Literal("tasks-ops")]), ops: Type.Array(Type.Unknown()) }),
]);

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

function check<T>(schema: TSchema, raw: unknown, what: string): Parsed<T> {
	if (Value.Check(schema, raw)) return { ok: true, value: raw as T };
	const first = Value.Errors(schema, raw)[0];
	const where = first === undefined ? "" : `: ${first.instancePath || "/"} ${first.message}`;
	return { ok: false, problem: `not a ${what}${where}` };
}

export function opOf(raw: unknown): unknown {
	const request = typeof raw === "object" && raw !== null && "request" in raw ? raw.request : undefined;
	return typeof request === "object" && request !== null && "op" in request ? request.op : undefined;
}

// A union's errors describe its first variant, so each message is checked against the variant its op names.
const MESSAGE_BY_OP = new Map<string, TSchema>();
for (const variant of RequestSchema.anyOf) MESSAGE_BY_OP.set(variant.properties.op.const, Type.Object({ id: Type.Integer(), request: variant }));

export function parseClientMessage(raw: unknown): Parsed<ClientMessage> {
	const op = opOf(raw);
	if (typeof op !== "string") return check(ClientMessageSchema, raw, "mochi request");
	const schema = MESSAGE_BY_OP.get(op);
	if (schema === undefined) return { ok: false, problem: `unknown op "${op.slice(0, 40)}"` };
	return check(schema, raw, `mochi ${op} request`);
}
export const parseServerMessage = (raw: unknown): Parsed<ServerMessage> => check(ServerMessageSchema, raw, "mochi frame");

/**
 * Splits the stream into lines and parses each one. Never throws out of the socket listener: a bad line goes to
 * `onBadLine`. Once `refused()` is true, the rest of the stream is dropped, buffered lines included.
 */
export function readLines(socket: Socket, onMessage: (message: unknown) => void, onBadLine: (problem: string) => void, refused: () => boolean = () => false): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		if (refused()) return;
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			if (refused()) {
				buffer = "";
				return;
			}
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim() === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				onBadLine(`not JSON: ${line.slice(0, 80)}`);
				continue;
			}
			try {
				onMessage(parsed);
			} catch (error) {
				onBadLine(error instanceof Error ? error.message : String(error));
			}
		}
	});
}

export function writeLine(socket: Socket, message: ClientMessage | ServerMessage): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}
