import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { McpClient, type McpTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
	adaptOAuthProvider,
	authorizeMcp,
	type McpOAuthState,
	type McpOAuthStateStore,
	McpOAuthProvider,
	type OAuthCallback,
	OAuthCallbackServer,
} from "@earendil-works/pi-mcp/oauth";
import { Type } from "typebox";
import { parseWith } from "../parse.ts";

export const AUTH_COMMAND = "node src/main.ts auth apps";

/**
 * Fixed so the redirect URI registered with Executor stays valid across logins; a random port would need a new
 * client registration each time.
 */
const CALLBACK_PORT = 8790;
const CALLBACK_HOST = "127.0.0.1";
const REDIRECT_URL = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/callback`;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

const StateSchema = Type.Object({ serverUrl: Type.String() }, { additionalProperties: true });

export function authFile(dataDir: string): string {
	// The file kept its first name so an existing login still loads.
	return join(dataDir, "executor-auth.json");
}

/** Mochi's own Executor client registration and tokens, in one 0600 JSON file. */
function fileStateStore(path: string): McpOAuthStateStore {
	return {
		load: async () => {
			let text: string;
			try {
				text = await readFile(path, "utf8");
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
				throw error;
			}
			return parseWith(StateSchema, JSON.parse(text), path) as McpOAuthState;
		},
		save: async (state) => {
			const temporary = `${path}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
			await rename(temporary, path);
		},
	};
}

function oauthProvider(serverUrl: string, path: string, redirectUrl: string, onRedirect: (url: URL) => void) {
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: "mochi" },
		store: fileStateStore(path),
		onRedirect,
	});
}

/**
 * Daemon side: a transport that sends the stored token and refreshes it on 401, or undefined when nothing is stored.
 * It never starts an authorization; a refresh that fails surfaces as `McpOAuthAuthorizationRequiredError`.
 */
export function storedTokenConnector(serverUrl: string, path: string): () => Promise<McpTransport | undefined> {
	return async () => {
		const provider = oauthProvider(serverUrl, path, REDIRECT_URL, () => {});
		if ((await provider.tokens()) === undefined) return undefined;
		return new StreamableHttpTransport({ url: serverUrl, authProvider: adaptOAuthProvider(provider) });
	};
}

/** `mochi auth apps`: print the authorization URL, wait for the redirect, store the tokens, list the tools. */
export async function loginApps(serverUrl: string, path: string, print: (line: string) => void): Promise<void> {
	let callback: OAuthCallbackServer;
	try {
		callback = await OAuthCallbackServer.listen({ host: CALLBACK_HOST, port: CALLBACK_PORT, timeoutMs: LOGIN_TIMEOUT_MS });
	} catch (error) {
		throw new Error(`Cannot listen on ${REDIRECT_URL} for the OAuth redirect: ${String(error)}. Is another login running?`);
	}
	const paste = createInterface({ input: process.stdin });
	try {
		let authorizationUrl: URL | undefined;
		const provider = oauthProvider(serverUrl, path, callback.redirectUrl, (url) => {
			authorizationUrl = url;
		});
		const started = await authorizeMcp(provider, { serverUrl, skipRefresh: true });
		if (started !== "REDIRECT" || authorizationUrl === undefined) throw new Error("Executor did not ask for authorization.");
		const state = await provider.state();
		print(`Open this URL and approve mochi:\n\n${authorizationUrl.href}\n`);
		print(`Waiting for the redirect on ${callback.redirectUrl} (10 minutes).`);
		print("If your browser is on another machine, the redirect page fails to load. Paste its full URL here and press Enter.");
		const { code, iss } = await Promise.race([callback.waitForCallback(state), pastedCallback(paste, state)]);
		await authorizeMcp(provider, { serverUrl, authorizationCode: code, ...(iss === undefined ? {} : { iss }) });
		print(`Saved tokens to ${path}.`);

		const client = new McpClient({ name: "mochi", version: "0.0.0" });
		await client.connect(new StreamableHttpTransport({ url: serverUrl, authProvider: adaptOAuthProvider(provider) }));
		const tools = await client.listTools();
		await client.close();
		print(`Executor tools: ${tools.map((tool) => tool.name).join(", ")}`);
	} finally {
		paste.close();
		await callback.close();
	}
}

function pastedCallback(lines: ReturnType<typeof createInterface>, state: string): Promise<OAuthCallback> {
	return new Promise((resolve, reject) => {
		lines.on("line", (line) => {
			let url: URL;
			try {
				url = new URL(line.trim());
			} catch {
				return;
			}
			const error = url.searchParams.get("error");
			if (error !== null) reject(new Error(url.searchParams.get("error_description") ?? error));
			const code = url.searchParams.get("code");
			const iss = url.searchParams.get("iss");
			if (url.searchParams.get("state") !== state || code === null) {
				reject(new Error("The pasted URL is not the redirect for this login (state or code missing)."));
				return;
			}
			resolve({ code, state, ...(iss === null ? {} : { iss }) });
		});
	});
}
