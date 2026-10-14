import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type JsonRpcMessage, type JsonRpcRequest, McpSessionExpiredError, type McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { type Connect, connectApps, searchProgram, toolExpression } from "./apps.ts";

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
	assert.equal(await apps.call("notion.update", {}, context), "posted");
	assert.deepEqual(seen.at(-1), { name: "resume", args: { requestId: "apr_1", response: { action: "accept", content: {} } } });
	assert.ok(logs.includes("executor.approved"));
	assert.deepEqual(executor.capabilities, [{ elicitation: {} }]);
	await stop();
});

test("Executor's completed envelope unwraps to its value, a failed one throws its message, and a raw value passes through", async () => {
	const items = { items: [{ path: "gmail.send", signature: "(to: string) => void" }] };
	const envelope = (execution: unknown) => {
		const body = { status: "completed", execution: { ...(execution as object), toolCalls: [] }, unavailableApps: [] };
		return { ...text(JSON.stringify(body)), structuredContent: body };
	};
	const executor = fakeExecutor(async (_name, args) => {
		const code = String(args.code);
		if (code.includes("tools.search")) return envelope({ ok: true, value: items });
		if (code.includes("gmail.send")) return envelope({ ok: true, value: { id: "m1" } });
		if (code.includes("gmail.fail")) return envelope({ ok: false, error: { kind: "ExecutionFailure", message: "Uncaught: boom" } });
		return text(JSON.stringify({ id: "raw" }));
	});
	const { apps, until, stop } = start(executor.connect);
	await until("executor.up");
	assert.deepEqual(await apps.search("mail", context), items);
	assert.deepEqual(await apps.call("gmail.send", {}, context), { id: "m1" });
	await assert.rejects(apps.call("gmail.fail", {}, context), (error: Error) => error.message === "Uncaught: boom");
	assert.deepEqual(await apps.call("gmail.old", {}, context), { id: "raw" });
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

test("the search program gives every item a path and signature when Executor's search returns only an input type", async () => {
	const described: unknown[] = [];
	const search = Object.assign(
		async () => ({
			items: [
				{ path: "tools.email.send", description: "Send mail", input: "{ to: string }" },
				{ path: 'tools["cal-com"].book', description: "Book", input: "{ start: string }" },
			],
			namespaces: [],
		}),
		{
			describe: async ({ paths }: { paths: string[] }) => {
				described.push(paths);
				return { items: [{ path: "tools.email.send", description: "Send mail", signature: "(input: { to: string }) => Promise<unknown>" }], missing: [] };
			},
		},
	);
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
	const result = await new AsyncFunction("tools", searchProgram("mail"))({ search });
	assert.deepEqual(described, [["tools.email.send", 'tools["cal-com"].book']]);
	assert.deepEqual(result.items, [
		{ path: "tools.email.send", description: "Send mail", signature: "(input: { to: string }) => Promise<unknown>" },
		{ path: 'tools["cal-com"].book', description: "Book", signature: "(input: { start: string }) => Promise<unknown>" },
	]);
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
