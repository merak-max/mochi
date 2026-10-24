import type { Context } from "@earendil-works/chord";
import { McpClient, McpSessionExpiredError, type McpTransport, StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import type { McpServerConfig } from "../config.ts";
import type { Log } from "../log.ts";
import type { McpTools } from "../seats.ts";
import { pause } from "../pause.ts";
import { storedTokenTransport, tokenFile } from "./oauth.ts";

const RETRY_MS = 60_000;
const CALL_TIMEOUT_MS = 15 * 60_000;
/** How long a call whose session expired waits for `run` to reconnect before its one retry. */
const RECONNECT_WAIT_MS = 15_000;

type Link =
	| { readonly status: "unauthorized" }
	| { readonly status: "down"; readonly error: string }
	| { readonly status: "up"; readonly client: McpClient };

export interface McpConnection {
	readonly name: string;
	/** Settles after the first connection attempt, up or not. */
	readonly firstAttempt: Promise<void>;
	/** Connects, publishes the server's tools, and reconnects every 60 s until `context` aborts. */
	run(context: Context): Promise<void>;
}

/**
 * One MCP server for the daemon's life. Each of its tools becomes the script tool `<name>_<tool>`, deferred, so
 * scripts find it with searchTools(). `publish` gets the tools each time the server lists them.
 */
export function connectServer(server: McpServerConfig, homeDir: string, log: Log, publish: (tools: McpTools) => void): McpConnection {
	let link: Link = { status: "down", error: "not connected yet" };
	const loginHint = `mochi auth ${server.name}`;
	const connected = (): McpClient => {
		const current = link;
		if (current.status === "unauthorized") throw new Error(`MCP server ${server.name} is not authorized; the owner runs \`${loginHint}\`.`);
		if (current.status === "down") throw new Error(`MCP server ${server.name} is down (${current.error}), retrying every 60 s.`);
		return current.client;
	};
	const reconnected = async (old: McpClient, context: Context): Promise<McpClient> => {
		for (let waited = 0; waited < RECONNECT_WAIT_MS; waited += 250) {
			if (link.status === "up" && link.client !== old) return link.client;
			await pause(250, context.abortSignal);
		}
		return connected();
	};
	const callOnce = async (client: McpClient, tool: string, args: Record<string, unknown>, context: Context) => {
		const options = { timeoutMs: CALL_TIMEOUT_MS, ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) };
		try {
			return await client.callTool(tool, args, options);
		} catch (error) {
			if (error instanceof McpSessionExpiredError || error instanceof McpOAuthAuthorizationRequiredError) {
				log("mcp.reconnecting", { server: server.name, error: String(error) });
				await client.close();
			}
			throw error;
		}
	};
	// An expired session means the server never ran the call, so it is sent once more on the new session.
	const call = async (tool: string, args: Record<string, unknown>, context: Context) => {
		const client = connected();
		try {
			return await callOnce(client, tool, args, context);
		} catch (error) {
			if (!(error instanceof McpSessionExpiredError)) throw error;
		}
		return callOnce(await reconnected(client, context), tool, args, context);
	};

	let settleFirst: () => void = () => {};
	const firstAttempt = new Promise<void>((resolve) => {
		settleFirst = resolve;
	});
	return {
		name: server.name,
		firstAttempt,
		run: async (context) => {
			let reported: string | undefined;
			while (context.abortSignal?.aborted !== true) {
				link = await open(server, homeDir);
				if (link.status === "up") {
					try {
						const listed = await link.client.listTools();
						publish({ name: server.name, instructions: link.client.instructions, tools: listed.map((tool) => scriptTool(server.name, tool, call)) });
					} catch (error) {
						await link.client.close();
						link = { status: "down", error: `tools/list failed: ${String(error)}` };
					}
				}
				settleFirst();
				const report = link.status === "down" ? `down:${link.error}` : link.status;
				if (report !== reported) {
					reported = report;
					if (link.status === "unauthorized") log("mcp.unauthorized", { server: server.name, hint: `run \`${loginHint}\`` });
					else if (link.status === "down") log("mcp.down", { server: server.name, error: link.error, retryInSeconds: RETRY_MS / 1000 });
					else log("mcp.up", { server: server.name });
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

async function transportOf(server: McpServerConfig, homeDir: string): Promise<McpTransport | undefined> {
	if (server.auth.kind === "oauth") return storedTokenTransport(server.url, tokenFile(homeDir, server.name));
	if (server.auth.token === undefined) throw new Error(`${server.auth.tokenEnv} is not set`);
	return new StreamableHttpTransport({ url: server.url, headers: { Authorization: `Bearer ${server.auth.token}` } });
}

async function open(server: McpServerConfig, homeDir: string): Promise<Link> {
	let transport: McpTransport | undefined;
	try {
		transport = await transportOf(server, homeDir);
	} catch (error) {
		return { status: "down", error: String(error) };
	}
	if (transport === undefined) return { status: "unauthorized" };
	const client = new McpClient({ name: "mochi", version: "0.0.0" });
	try {
		await client.connect(transport);
	} catch (error) {
		await client.close().catch(() => {});
		return error instanceof McpOAuthAuthorizationRequiredError ? { status: "unauthorized" } : { status: "down", error: String(error) };
	}
	return { status: "up", client };
}

type Call = (tool: string, args: Record<string, unknown>, context: Context) => ReturnType<McpClient["callTool"]>;

/**
 * A script gets the result's `structuredContent` when the server sends one, else its text. An error result is an
 * error with its text. Only a tool the server marks read-only runs again after a restart.
 */
function scriptTool(server: string, tool: Tool, call: Call): ToolRegistration {
	const parameters = { ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} } as unknown as TSchema;
	return {
		name: `${server}_${tool.name}`,
		description: tool.description ?? tool.title ?? tool.name,
		parameters,
		structuredOutputSchema: (tool.outputSchema ?? {}) as TSchema,
		replay: tool.annotations?.readOnlyHint === true ? "safe" : "unsafe",
		callers: ["tools"],
		deferred: true,
		execute: async (args, _api, context) => {
			const result = await call(tool.name, args as Record<string, unknown>, context);
			const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			if (result.isError === true) return { isError: true, output: [{ type: "text", text }] };
			return { structuredOutput: result.structuredContent === undefined ? text : (result.structuredContent as never) };
		},
	};
}

function untilClosed(client: McpClient, context: Context): Promise<void> {
	return new Promise((resolve) => {
		if (client.connectionState === "closed" || context.abortSignal?.aborted === true) resolve();
		client.onClose(resolve);
		context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
	});
}
