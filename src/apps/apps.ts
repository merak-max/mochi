import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { McpClient, McpConnectionClosedError, McpSessionExpiredError, type McpTransport } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { AUTH_COMMAND } from "../auth/apps.ts";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Log } from "../log.ts";
import { pause } from "../pause.ts";

const RETRY_MS = 60_000;
const CALL_TIMEOUT_MS = 15 * 60_000;
const MAX_APPROVALS = 20;
/** How long a call whose MCP session expired waits for `run` to reconnect before its one retry. */
const RECONNECT_WAIT_MS = 15_000;
const ACCEPT = { action: "accept", content: {} };

/** Resolves to undefined when mochi holds no Executor tokens. */
type Connect = () => Promise<McpTransport | undefined>;

/** The owner's apps through Executor. Each method throws one line while Executor is not up. */
export interface Apps {
	search(query: string, context: Context): Promise<JsonValue>;
	call(path: string, args: JsonValue, context: Context): Promise<JsonValue>;
	skills(app: string | undefined, context: Context): Promise<string>;
}

type Link =
	| { readonly status: "unauthorized" }
	| { readonly status: "down"; readonly error: string }
	| { readonly status: "up"; readonly client: McpClient };

/** One Executor connection for the daemon's life; `run` reconnects every 60 s. Nothing the model sees changes with it. */
export function connectApps(connect: Connect, log: Log): Apps & { run(context: Context): Promise<void> } {
	let link: Link = { status: "down", error: "not connected yet" };
	const connected = (): McpClient => {
		const current = link;
		if (current.status === "unauthorized") throw new Error(`The apps server is not authorized; the owner runs \`${AUTH_COMMAND}\`.`);
		if (current.status === "down") throw new Error(`The apps server is down (${current.error}), retrying every 60 s.`);
		return current.client;
	};
	const reconnected = async (old: McpClient, context: Context): Promise<McpClient> => {
		for (let waited = 0; waited < RECONNECT_WAIT_MS; waited += 250) {
			if (link.status === "up" && link.client !== old) return link.client;
			await pause(250, context.abortSignal);
		}
		return connected();
	};
	const callOnce = async (client: McpClient, name: string, args: Record<string, unknown>, context: Context): Promise<ToolResult> => {
		const options = { timeoutMs: CALL_TIMEOUT_MS, onProgress: () => {}, ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) };
		try {
			return await client.callTool(name, args, options);
		} catch (error) {
			if (error instanceof McpSessionExpiredError || error instanceof McpConnectionClosedError || error instanceof McpOAuthAuthorizationRequiredError) {
				log("apps.reconnecting", { error: String(error) });
				await client.close();
			}
			throw error;
		}
	};
	const callTool = async (name: string, args: Record<string, unknown>, context: Context): Promise<JsonValue> => {
		const client = connected();
		try {
			return parseResult(await callOnce(client, name, args, context));
		} catch (error) {
			if (!(error instanceof McpSessionExpiredError)) throw error instanceof ExecutorResultError ? error : new Error(`Apps call failed: ${String(error)}`);
		}
		return parseResult(await callOnce(await reconnected(client, context), name, args, context));
	};
	const tool = async (name: string, args: Record<string, unknown>, context: Context): Promise<JsonValue> => {
		let value = await callTool(name, args, context);
		for (let approvals = 0; ; approvals++) {
			const requestId = approvalRequest(value);
			if (requestId === undefined) return value;
			if (approvals >= MAX_APPROVALS) throw new Error(`The apps server asked for more than ${MAX_APPROVALS} approvals in one call.`);
			log("apps.approved", { requestId });
			value = await callTool("resume", { requestId, response: ACCEPT }, context);
		}
	};
	const execute = async (code: string, context: Context): Promise<JsonValue> => completedValue(await tool("execute", { code }, context));
	return {
		search: (query, context) => execute(searchProgram(query), context),
		call: (path, args, context) => execute(`return await ${toolExpression(path)}(${JSON.stringify(args)});`, context),
		skills: async (app, context) => {
			const value = await tool("skills", app === undefined ? {} : { app }, context);
			return typeof value === "string" ? value : JSON.stringify(value, null, 1);
		},
		run: async (context) => {
			let reported: string | undefined;
			while (context.abortSignal?.aborted !== true) {
				link = await open(connect);
				const report = link.status === "down" ? `down:${link.error}` : link.status;
				if (report !== reported) {
					reported = report;
					if (link.status === "unauthorized") log("apps.unauthorized", { hint: `run \`${AUTH_COMMAND}\`` });
					else if (link.status === "down") log("apps.down", { error: link.error, retryInSeconds: RETRY_MS / 1000 });
					else log("apps.up", {});
				}
				if (link.status === "up") {
					await untilClosed(link.client, context);
					await link.client.close();
					link = { status: "down", error: "connection closed" };
					reported = undefined;
				} else {
					await pause(RETRY_MS, context.abortSignal);
				}
			}
		},
	};
}

async function open(connect: Connect): Promise<Link> {
	let transport: McpTransport | undefined;
	try {
		transport = await connect();
	} catch (error) {
		return { status: "down", error: String(error) };
	}
	if (transport === undefined) return { status: "unauthorized" };
	const client = new McpClient({ name: "mochi", version: "0.0.0", capabilities: { elicitation: {} } });
	client.setRequestHandler("elicitation/create", () => ACCEPT);
	try {
		await client.connect(transport);
	} catch (error) {
		await client.close().catch(() => {});
		return error instanceof McpOAuthAuthorizationRequiredError ? { status: "unauthorized" } : { status: "down", error: String(error) };
	}
	return { status: "up", client };
}

/** An error result from an Executor tool: the call reached Executor and failed there. */
class ExecutorResultError extends Error {}

/**
 * An Executor program that searches, then adds each item's full signature from `tools.search.describe`.
 * Search returns only the input type; an item that describe misses gets a signature built from it.
 */
function searchProgram(query: string): string {
	return `const found = await tools.search(${JSON.stringify({ query })});
const items = found.items ?? [];
const described = items.length === 0 ? { items: [] } : await tools.search.describe({ paths: items.map((item) => item.path) });
const signatures = new Map();
for (const item of described.items ?? []) signatures.set(item.path, item.signature);
for (const item of items) {
  const signature = signatures.get(item.path) ?? item.signature ?? \`(input: \${item.input ?? "unknown"}) => Promise<unknown>\`;
  item.signature = signature;
  delete item.input;
}
return found;`;
}

/** A path as apps_search returns it ("tools[\"a-b\"].x") or without the prefix ("gmail.send", "[\"a-b\"].x"), as a callable expression. */
function toolExpression(path: string): string {
	const trimmed = path.trim();
	if (trimmed.startsWith("tools.") || trimmed.startsWith("tools[")) return trimmed;
	if (trimmed.startsWith("[")) return `tools${trimmed}`;
	return `tools.${trimmed}`;
}

type ToolResult = Awaited<ReturnType<McpClient["callTool"]>>;

/** A tool result as JSON: structured content, else parsed text, else the text. An error result throws its text. */
function parseResult(result: ToolResult): JsonValue {
	const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	if (result.isError === true) throw new ExecutorResultError(text);
	if (result.structuredContent !== undefined) return result.structuredContent as JsonValue;
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return text;
	}
}

/** The requestId of an `execute` or `resume` result that paused for approval (model elicitation mode). */
function approvalRequest(value: JsonValue): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (value.status !== "approval-required") return undefined;
	return typeof value.requestId === "string" ? value.requestId : undefined;
}

/**
 * The program's value from an `execute` or `resume` result. Executor wraps it as
 * `{ status: "completed", execution: { ok, value | error } }`; older Executors return the value raw.
 */
function completedValue(value: JsonValue): JsonValue {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	if (value.status !== "completed") return value;
	const execution = value.execution;
	if (typeof execution !== "object" || execution === null || Array.isArray(execution)) return value;
	if (execution.ok === true) return execution.value ?? null;
	if (execution.ok === false) throw new ExecutorResultError(errorText(execution.error));
	return value;
}

function errorText(error: JsonValue | undefined): string {
	if (typeof error === "string") return error;
	if (typeof error === "object" && error !== null && !Array.isArray(error) && typeof error.message === "string") return error.message;
	return JSON.stringify(error ?? "Executor program failed");
}

function untilClosed(client: McpClient, context: Context): Promise<void> {
	return new Promise((resolve) => {
		if (client.connectionState === "closed" || context.abortSignal?.aborted === true) resolve();
		client.onClose(resolve);
		context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
	});
}

export function appsFns(apps: Apps): readonly ToolRegistration[] {
	return [
		defineTool({
			name: "apps_search",
			description: "Find tools in the owner's apps (mail, calendar, GitHub, browser). Read the apps skill first.",
			parameters: Type.Object({ query: Type.String() }),
			structuredOutputSchema: Type.Object({ items: Type.Array(Type.Object({ path: Type.String(), signature: Type.String() })) }),
			replay: "safe",
			execute: async ({ query }, _api, context) => ({ structuredOutput: await apps.search(query, context) }),
		}),
		defineTool({
			name: "apps_call",
			description: "Call an app tool by its apps_search path. Acts for real; an interrupted call is reported, never rerun.",
			parameters: Type.Object({ path: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }),
			structuredOutputSchema: Type.Unknown(),
			replay: "unsafe",
			execute: async ({ path, args }, _api, context) => ({ structuredOutput: await apps.call(path, args as JsonValue, context) }),
		}),
		defineTool({
			name: "apps_skills",
			description: "The apps server's instructions for one app, or the list of apps.",
			parameters: Type.Object({ app: Type.Optional(Type.String()) }),
			structuredOutputSchema: Type.String(),
			replay: "safe",
			execute: async ({ app }, _api, context) => ({ structuredOutput: await apps.skills(app, context) }),
		}),
	];
}
