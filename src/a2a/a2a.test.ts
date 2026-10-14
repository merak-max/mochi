import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc } from "@earendil-works/pi-durable";
import { newFaux, openTestMochi, type TestMochi, tempDir } from "../test-support.ts";
import { A2AContextDoc, type A2AServerSettings, startA2AServer } from "./server.ts";
import { type A2APeer, a2aFns } from "./tools.ts";

const context = BACKGROUND_CONTEXT;

async function serve(t: TestContext, mochi: TestMochi, tokens: Record<string, string>): Promise<string> {
	const stop = new AbortController();
	t.after(() => stop.abort());
	const settings: A2AServerSettings = { tokens: new Map(Object.entries(tokens)), host: "127.0.0.1", port: 0, publicUrl: "", agentName: "mochi", replyTimeoutMs: 30_000 };
	const { address } = await startA2AServer({ harness: mochi.harness, settings, timeZone: "Asia/Kolkata", log: () => {} }, withAbortSignal(stop.signal, context));
	return `http://127.0.0.1:${address.port}`;
}

function rpc(url: string, token: string | undefined, method: string, params: object): Promise<Response> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token !== undefined) headers.Authorization = `Bearer ${token}`;
	return fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

const message = (messageId: string, contextId: string, text: string) => ({ message: { messageId, role: "ROLE_USER", contextId, parts: [{ text }] } });

async function sendText(url: string, token: string, messageId: string, contextId: string, text: string, configuration?: object) {
	const response = await rpc(url, token, "SendMessage", { ...message(messageId, contextId, text), ...(configuration === undefined ? {} : { configuration }) });
	return ((await response.json()) as { result: { task: { id: string; contextId: string; status: { state: string }; artifacts?: { parts: { text: string }[] }[] } } }).result.task;
}

const conversationOf = async (mochi: TestMochi, peer: string, contextId: string) => (await mochi.harness.snapshot(A2AContextDoc, `${peer}:${contextId}`, context))?.conversation ?? null;

test("a2a server: card, bearer auth, one agent conversation per context, redelivery, non-blocking send and GetTask", async (t) => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two"), fauxAssistantMessage("answer three"), fauxAssistantMessage("answer four")]);
	const mochi = await openTestMochi(await tempDir(), faux);
	t.after(() => mochi.close());
	const url = await serve(t, mochi, { hermes: "hermes-token-123", other: "other-token-456" });

	const card = (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as { name: string; supportedInterfaces: { protocolBinding: string }[] };
	assert.equal(card.name, "mochi");
	assert.equal(card.supportedInterfaces[0]?.protocolBinding, "JSONRPC");
	assert.equal((await fetch(`${url}/.well-known/agent.json`)).status, 200);

	assert.equal((await rpc(url, undefined, "SendMessage", message("m0", "c1", "hi"))).status, 401);
	assert.equal((await rpc(url, "wrong-token", "SendMessage", message("m0", "c1", "hi"))).status, 401);

	const first = await sendText(url, "hermes-token-123", "m1", "c1", "first question");
	assert.equal(first.status.state, "TASK_STATE_COMPLETED");
	assert.equal(first.contextId, "c1");
	assert.equal(first.artifacts?.[0]?.parts[0]?.text, "answer one");
	const c1 = await conversationOf(mochi, "hermes", "c1");
	assert.notEqual(c1, null);
	assert.deepEqual((await mochi.harness.snapshot(AgentDoc, c1!, context))?.extensions, ["identity", "notes", "skills", "fast-compaction", "seat-agent"]);

	const again = await sendText(url, "hermes-token-123", "m1", "c1", "first question");
	assert.equal(again.id, first.id);
	assert.equal(again.artifacts?.[0]?.parts[0]?.text, "answer one");

	const second = await sendText(url, "hermes-token-123", "m2", "c1", "follow-up");
	assert.equal(second.artifacts?.[0]?.parts[0]?.text, "answer two");
	assert.equal(await conversationOf(mochi, "hermes", "c1"), c1);

	await sendText(url, "hermes-token-123", "m3", "c2", "new thread");
	const c2 = await conversationOf(mochi, "hermes", "c2");
	assert.notEqual(c2, null);
	assert.notEqual(c2, c1);

	const started = await sendText(url, "hermes-token-123", "m4", "c3", "long job", { returnImmediately: true, blocking: false });
	assert.ok(["TASK_STATE_WORKING", "TASK_STATE_COMPLETED"].includes(started.status.state));
	let state = started.status.state;
	let reply: string | undefined;
	for (let attempt = 0; attempt < 100 && state !== "TASK_STATE_COMPLETED"; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		const body = (await (await rpc(url, "hermes-token-123", "GetTask", { id: started.id })).json()) as { result: { status: { state: string }; artifacts?: { parts: { text: string }[] }[] } };
		state = body.result.status.state;
		reply = body.result.artifacts?.[0]?.parts[0]?.text;
	}
	assert.equal(state, "TASK_STATE_COMPLETED");
	assert.equal(reply, "answer four");

	const stolen = (await (await rpc(url, "other-token-456", "GetTask", { id: started.id })).json()) as { error?: { code: number } };
	assert.equal(stolen.error?.code, -32001);
	const unknown = (await (await rpc(url, "hermes-token-123", "Nope", {})).json()) as { error?: { code: number } };
	assert.equal(unknown.error?.code, -32601);
	const empty = (await (await rpc(url, "hermes-token-123", "SendMessage", message("m5", "c1", ""))).json()) as { error?: { code: number } };
	assert.equal(empty.error?.code, -32602);
});

test("mochi to mochi: each calls the other with a2a_list, a2a_ask, a2a_send and a2a_status", async (t) => {
	const fauxA = newFaux();
	fauxA.setResponses([fauxAssistantMessage("a answers b")]);
	const fauxB = newFaux();
	fauxB.setResponses([fauxAssistantMessage("b answers a"), fauxAssistantMessage("b finished the job")]);
	const a = await openTestMochi(await tempDir(), fauxA);
	const b = await openTestMochi(await tempDir(), fauxB);
	t.after(async () => {
		await a.close();
		await b.close();
	});
	const urlA = await serve(t, a, { b: "token-b-calls-a" });
	const urlB = await serve(t, b, { a: "token-a-calls-b" });
	const peer = (name: string, url: string, token: string): A2APeer => ({ name, url, token, tokenEnv: "UNUSED", timeoutMs: 30_000 });
	const fnsOf = (peers: A2APeer[]) => {
		const fns = new Map(a2aFns(new Map(peers.map((each) => [each.name, each]))).map((fn) => [fn.name, fn]));
		return async (name: string, args: object) => (await fns.get(name)!.execute(args as never, {} as never, context)).structuredOutput as Record<string, unknown>;
	};
	const fromA = fnsOf([peer("b", urlB, "token-a-calls-b"), peer("gone", "http://127.0.0.1:1", "x")]);
	const fromB = fnsOf([peer("a", urlA, "token-b-calls-a")]);

	assert.deepEqual(await fromA("a2a_list", {}), [
		{ name: "b", url: urlB, reachable: true, card: { name: "mochi", description: "The owner's personal agent, mochi. Ask it to do work with the owner's tools." } },
		{ name: "gone", url: "http://127.0.0.1:1", reachable: false },
	]);

	const asked = await fromA("a2a_ask", { agent: "b", message: "hello b" });
	assert.equal(asked.reply, "b answers a");
	assert.equal(asked.state, "TASK_STATE_COMPLETED");
	assert.notEqual(await conversationOf(b, "a", String(asked.contextId)), null);

	const back = await fromB("a2a_ask", { agent: "a", message: "hello a", contextId: "thread-1" });
	assert.equal(back.reply, "a answers b");
	assert.equal(back.contextId, "thread-1");

	const sent = await fromA("a2a_send", { agent: "b", message: "do the job" });
	let status = await fromA("a2a_status", { agent: "b", taskId: String(sent.taskId) });
	for (let attempt = 0; attempt < 100 && status.state !== "TASK_STATE_COMPLETED"; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		status = await fromA("a2a_status", { agent: "b", taskId: String(sent.taskId) });
	}
	assert.deepEqual(status, { state: "TASK_STATE_COMPLETED", reply: "b finished the job" });

	await assert.rejects(fromA("a2a_ask", { agent: "nobody", message: "hi" }), /No A2A peer named nobody/);
	const wrongToken = fnsOf([peer("b", urlB, "bad-token")]);
	await assert.rejects(wrongToken("a2a_ask", { agent: "b", message: "hi" }), /HTTP 401/);
});
