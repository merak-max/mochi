import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type JsonRpcMessage, type JsonRpcRequest, McpSessionExpiredError, type McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { type Connect, connectApps, toolExpression } from "./apps.ts";

const context = BACKGROUND_CONTEXT;

/** A scripted Executor on the in-memory transport: each tools/call goes to `onCall`, which may ask mochi for approval. */
function fakeExecutor(onCall: (name: string, args: Record<string, unknown>, ask: (message: string) => Promise<unknown>) => Promise<unknown>) {
	const { client, server } = createInMemoryTransportPair();
	const capabilities: unknown[] = [];
	const replies = new Map<number, (result: unknown) => void>();
	const ask = (message: string) =>
		new Promise<unknown>((resolve) => {
			replies.set(9, resolve);
			void server.send({ jsonrpc: "2.0", id: 9, method: "elicitation/create", params: { message } });
		});
	server.onMessage(async (message: JsonRpcMessage) => {
		if (!("method" in message)) {
			if ("id" in message) replies.get(message.id as number)?.("result" in message ? message.result : undefined);
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

test("apps functions run Executor programs and return parsed results; mochi accepts every approval", async () => {
	const seen: unknown[] = [];
	const answers: unknown[] = [];
	const executor = fakeExecutor(async (name, args, ask) => {
		seen.push({ name, args });
		if (name === "resume") return text(JSON.stringify({ status: "completed", execution: { ok: true, value: "posted" } }));
		if (String(args.code).includes("notion.update")) return text(JSON.stringify({ status: "approval-required", requestId: "apr_1" }));
		if (String(args.code).includes("bank.pay")) {
			answers.push(await ask("Pay Rs 500?"));
			return text("paid");
		}
		return name === "skills" ? text("Gmail: use search first.") : text(JSON.stringify({ items: [{ path: "gmail.send", signature: "(to: string) => void" }] }));
	});
	const { apps, until, logs, stop } = start(executor.connect);
	await until("executor.up");
	assert.deepEqual(await apps.search("mail", context), { items: [{ path: "gmail.send", signature: "(to: string) => void" }] });
	assert.equal(await apps.skills("gmail", context), "Gmail: use search first.");
	assert.equal(await apps.call("bank.pay", {}, context), "paid");
	assert.deepEqual(answers, [{ action: "accept", content: {} }]);
	assert.deepEqual(await apps.call("notion.update", {}, context), { status: "completed", execution: { ok: true, value: "posted" } });
	assert.deepEqual(seen.at(-1), { name: "resume", args: { requestId: "apr_1", response: { action: "accept", content: {} } } });
	assert.ok(logs.includes("executor.approved"));
	assert.deepEqual(executor.capabilities, [{ elicitation: {} }]);
	await stop();
});

test("an expired Executor session reconnects and retries the call once", async () => {
	let calls = 0;
	let expireNext = true;
	const expiring: Connect = async () => {
		const executor = fakeExecutor(async () => {
			calls++;
			return text("ok");
		});
		const transport = (await executor.connect()) as McpTransport;
		const send = transport.send.bind(transport);
		transport.send = async (message) => {
			if ("method" in message && message.method === "tools/call" && expireNext) {
				expireNext = false;
				throw new McpSessionExpiredError();
			}
			return send(message);
		};
		return transport;
	};
	const { apps, until, logs, stop } = start(expiring);
	await until("executor.up");
	assert.equal(await apps.call("gmail.send", {}, context), "ok");
	assert.equal(calls, 1);
	assert.ok(logs.includes("executor.reconnecting"));
	await stop();
});

test("a path from apps_search, with or without the tools prefix, becomes one callable expression", () => {
	assert.equal(toolExpression("gmail.send"), "tools.gmail.send");
	assert.equal(toolExpression('tools["approval-probe"].ping'), 'tools["approval-probe"].ping');
	assert.equal(toolExpression('["approval-probe"].ping'), 'tools["approval-probe"].ping');
	assert.equal(toolExpression('tools.notion.profiles["ins_1"]["notion-fetch"]'), 'tools.notion.profiles["ins_1"]["notion-fetch"]');
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
