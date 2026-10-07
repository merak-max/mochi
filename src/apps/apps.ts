import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { McpClient, McpConnectionClosedError, McpSessionExpiredError, type McpTransport } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { AUTH_COMMAND } from "../auth/executor.ts";
import { defineFn, type ScriptFn } from "../code/code.ts";
import type { Log } from "../log.ts";
import { pause } from "../pause.ts";

const RETRY_MS = 60_000;
const CALL_TIMEOUT_MS = 15 * 60_000;

/** Resolves to undefined when mochi holds no Executor tokens. */
export type Connect = () => Promise<McpTransport | undefined>;

/** The owner's apps through Executor. Each method throws one line while Executor is not up. */
export interface Apps {
	search(query: string, context: Context): Promise<JsonValue>;
	call(path: string, args: JsonValue, context: Context): Promise<JsonValue>;
	skills(app: string | undefined, context: Context): Promise<string>;
}

type Link =
	| { readonly status: "unauthorized" }
	| { readonly status: "down"; readonly error: string }
	| { readonly status: "up"; readonly client: McpClient; readonly declined: string[] };

/** One Executor connection for the daemon's life; `run` reconnects every 60 s. Nothing the model sees changes with it. */
export function connectApps(connect: Connect, log: Log): Apps & { run(context: Context): Promise<void> } {
	let link: Link = { status: "down", error: "not connected yet" };
	const tool = async (name: string, args: Record<string, unknown>, context: Context): Promise<JsonValue> => {
		const current = link;
		if (current.status === "unauthorized") throw new Error(`Executor is not authorized; the owner runs \`${AUTH_COMMAND}\`.`);
		if (current.status === "down") throw new Error(`Executor is down (${current.error}), retrying every 60 s.`);
		const before = current.declined.length;
		let result;
		try {
			result = await current.client.callTool(name, args, { timeoutMs: CALL_TIMEOUT_MS, onProgress: () => {}, ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) });
		} catch (error) {
			if (error instanceof McpSessionExpiredError || error instanceof McpConnectionClosedError || error instanceof McpOAuthAuthorizationRequiredError) {
				log("executor.reconnecting", { error: String(error) });
				await current.client.close();
			}
			throw new Error(`Executor call failed: ${String(error)}`);
		}
		const declined = current.declined.splice(before);
		const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		if (result.isError === true) throw new Error([...(declined.length > 0 ? [`Mochi declined Executor approval prompts (approvals are off): ${declined.join("; ")}`] : []), text].join("\n"));
		if (result.structuredContent !== undefined) return result.structuredContent as JsonValue;
		try {
			return JSON.parse(text) as JsonValue;
		} catch {
			return text;
		}
	};
	return {
		search: (query, context) => tool("execute", { code: `return await tools.search(${JSON.stringify({ query })});` }, context),
		call: (path, args, context) => tool("execute", { code: `return await tools.${path}(${JSON.stringify(args)});` }, context),
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
					if (link.status === "unauthorized") log("executor.unauthorized", { hint: `run \`${AUTH_COMMAND}\`` });
					else if (link.status === "down") log("executor.down", { error: link.error, retryInSeconds: RETRY_MS / 1000 });
					else log("executor.up", {});
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
	const declined: string[] = [];
	client.setRequestHandler("elicitation/create", (params) => {
		const message = typeof params === "object" && params !== null && "message" in params && typeof params.message === "string" ? params.message : "an approval prompt";
		declined.push(message);
		return { action: "decline" };
	});
	try {
		await client.connect(transport);
	} catch (error) {
		await client.close().catch(() => {});
		return error instanceof McpOAuthAuthorizationRequiredError ? { status: "unauthorized" } : { status: "down", error: String(error) };
	}
	return { status: "up", client, declined };
}

function untilClosed(client: McpClient, context: Context): Promise<void> {
	return new Promise((resolve) => {
		if (client.connectionState === "closed" || context.abortSignal?.aborted === true) resolve();
		client.onClose(resolve);
		context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
	});
}

export function appsFns(apps: Apps): readonly ScriptFn[] {
	return [
		defineFn({
			name: "apps_search",
			description: "Find tools in the owner's apps (mail, calendar, GitHub, browser). Read the apps skill first.",
			parameters: Type.Object({ query: Type.String() }),
			output: Type.Object({ items: Type.Array(Type.Object({ path: Type.String(), signature: Type.String() })) }),
			replay: "read",
			run: async ({ query }, _call, context) => ({ value: await apps.search(query, context) }),
		}),
		defineFn({
			name: "apps_call",
			description: "Call an app tool by its apps_search path. Acts for real; an interrupted call is reported, never rerun.",
			parameters: Type.Object({ path: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }),
			output: Type.Unknown(),
			replay: "once",
			run: async ({ path, args }, _call, context) => ({ value: await apps.call(path, args as JsonValue, context) }),
		}),
		defineFn({
			name: "apps_skills",
			description: "Executor's instructions for one app, or the list of apps.",
			parameters: Type.Object({ app: Type.Optional(Type.String()) }),
			output: Type.String(),
			replay: "read",
			run: async ({ app }, _call, context) => ({ value: await apps.skills(app, context) }),
		}),
	];
}
