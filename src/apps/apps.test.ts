import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonRpcMessage, JsonRpcRequest } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { type Connect, connectApps } from "./apps.ts";

const context = BACKGROUND_CONTEXT;

/** A scripted Executor on the in-memory transport: each tools/call goes to `onCall`, which may ask mochi for approval. */
function fakeExecutor(onCall: (name: string, args: Record<string, unknown>, ask: (message: string) => Promise<void>) => Promise<unknown>) {
	const { client, server } = createInMemoryTransportPair();
	const capabilities: unknown[] = [];
	const replies = new Map<number, () => void>();
	const ask = (message: string) =>
		new Promise<void>((resolve) => {
			replies.set(9, resolve);
			void server.send({ jsonrpc: "2.0", id: 9, method: "elicitation/create", params: { message } });
		});
	server.onMessage(async (message: JsonRpcMessage) => {
		if (!("method" in message)) {
			if ("id" in message) replies.get(message.id as number)?.();
			return;
		}
		if (!("id" in message)) return;
		const request = message as JsonRpcRequest;
		const params = (request.params ?? {}) as Record<string, unknown>;
		const reply = (result: unknown) => server.send({ jsonrpc: "2.0", id: request.id, result: result as Record<string, unknown> });
		if (request.method === "initialize") {
			capabilities.push(params.capabilities);
			await reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "executor", version: "1" } });
		} else if (request.method === "tools/call") {
			await reply(await onCall(params.name as string, (params.arguments ?? {}) as Record<string, unknown>, ask));
		}
	});
	return { connect: async () => (await server.start(), client), capabilities };
}

function start(connect: Connect) {
	const logs: string[] = [];
	const controller = new AbortController();
	const apps = connectApps(connect, (event) => logs.push(event));
	const running = apps.run(withAbortSignal(controller.signal, context));
	const until = async (event: string) => {
		while (!logs.includes(event)) await new Promise((resolve) => setTimeout(resolve, 5));
	};
	return { apps, logs, until, stop: async () => (controller.abort(), await running) };
}

const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], isError });

test("apps functions run Executor programs and return parsed results; approvals are declined and named", async () => {
	const seen: unknown[] = [];
	const executor = fakeExecutor(async (name, args, ask) => {
		seen.push({ name, args });
		if (String(args.code).includes("bank.pay")) {
			await ask("Pay Rs 500?");
			return text("approval required", true);
		}
		return name === "skills" ? text("Gmail: use search first.") : text(JSON.stringify({ items: [{ path: "gmail.send", signature: "(to: string) => void" }] }));
	});
	const { apps, until, stop } = start(executor.connect);
	await until("executor.up");
	assert.deepEqual(await apps.search("mail", context), { items: [{ path: "gmail.send", signature: "(to: string) => void" }] });
	await apps.call("gmail.send", { to: "riya" }, context);
	assert.equal(await apps.skills("gmail", context), "Gmail: use search first.");
	await assert.rejects(apps.call("bank.pay", {}, context), /declined Executor approval prompts \(approvals are off\): Pay Rs 500\?\napproval required/);
	assert.deepEqual(seen.slice(0, 3), [
		{ name: "execute", args: { code: 'return await tools.search({"query":"mail"});' } },
		{ name: "execute", args: { code: 'return await tools.gmail.send({"to":"riya"});' } },
		{ name: "skills", args: { app: "gmail" } },
	]);
	assert.deepEqual(executor.capabilities, [{ elicitation: {} }]);
	await stop();
});

test("without tokens or with Executor unreachable, each function throws one line and the state is logged once", async () => {
	const unauthorized = start(async () => undefined);
	await unauthorized.until("executor.unauthorized");
	await assert.rejects(unauthorized.apps.search("mail", context), /not authorized; the owner runs `node src\/main.ts auth executor`/);
	await unauthorized.stop();

	const down = start(async () => {
		throw new Error("ECONNREFUSED");
	});
	await down.until("executor.down");
	await assert.rejects(down.apps.call("gmail.send", {}, context), /Executor is down \(Error: ECONNREFUSED\), retrying every 60 s/);
	assert.deepEqual(down.logs, ["executor.down"]);
	await down.stop();
});
