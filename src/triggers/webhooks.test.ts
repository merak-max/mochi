import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, UserEntry } from "@earendil-works/pi-durable";
import { messageText } from "../text.ts";
import { endlessChunkedPost, fixedClassify, newFaux, openTestMochi, type TestMochi, tempDir } from "../test-support.ts";
import { liveTrigger, reconcileSeeds } from "./trigger.ts";
import type { Trigger } from "./types.ts";
import { PAYLOAD_CHARS, startWebhookServer, webhookContent } from "./webhooks.ts";

const context = BACKGROUND_CONTEXT;
const SECRET = "s3cret-s3cret-s3cret";
const TOKEN = "token-token-token-token";
const TRIGGERS: Trigger[] = [
	{ kind: "webhook", id: "github", auth: { kind: "hmac-sha256", header: "X-Hub-Signature-256", secret: SECRET }, prompt: "A GitHub event." },
	{ kind: "webhook", id: "plain", auth: { kind: "bearer", token: TOKEN }, prompt: "A plain event." },
];

const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const conversationOf = async (mochi: TestMochi, id: string): Promise<Conversation> =>
	(await mochi.harness.conversation((await mochi.harness.commit((tx) => liveTrigger(tx, id), context))!.conversationId, context))!;

test("webhook server: HMAC and bearer auth, 404, 413, duplicate delivery submitted once", async (t) => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok"), fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
	const mochi = await openTestMochi(await tempDir(), faux);
	await reconcileSeeds(mochi.harness, mochi.trigger, TRIGGERS, mochi.catalog, context);
	const stop = new AbortController();
	t.after(async () => {
		stop.abort();
		await mochi.close();
	});
	const running = withAbortSignal(stop.signal, context);
	const logs: string[] = [];
	const { address } = await startWebhookServer(
		{ harness: mochi.harness, classify: fixedClassify("unused"), log: (event) => logs.push(event) },
		{ host: "127.0.0.1", port: 0 },
		running,
	);
	const post = (path: string, body: string, headers: Record<string, string>) =>
		fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", body, headers });

	const body = JSON.stringify({ action: "opened", number: 7 });
	const delivery = { "X-GitHub-Delivery": "d-1", "Content-Type": "application/json" };
	assert.equal((await post("/hooks/github", body, { ...delivery, "X-Hub-Signature-256": sign(body) })).status, 202);
	assert.equal((await post("/hooks/github", body, { ...delivery, "X-Hub-Signature-256": sign(body) })).status, 202);
	assert.equal((await post("/hooks/github", body, { ...delivery, "X-Hub-Signature-256": sign(body).replace("sha256=", "") })).status, 202);
	assert.equal((await post("/hooks/github", body, { ...delivery, "X-Hub-Signature-256": sign(body, "wrong-secret-wrong") })).status, 401);
	assert.equal((await post("/hooks/github", `${body} `, { ...delivery, "X-Hub-Signature-256": sign(body) })).status, 401);
	assert.equal((await post("/hooks/github", body, delivery)).status, 401);
	assert.equal((await post("/hooks/nope", body, { "X-Hub-Signature-256": sign(body) })).status, 404);
	assert.equal((await post("/hooks/plain", "ping", { Authorization: `Bearer ${TOKEN}` })).status, 202);
	assert.equal((await post("/hooks/plain", "ping 2", { Authorization: "Bearer nope" })).status, 401);
	assert.equal((await post("/hooks/plain", "x".repeat(1024 * 1024 + 1), { Authorization: `Bearer ${TOKEN}` })).status, 413);
	assert.equal(logs.filter((event) => event === "webhook.unauthorized").length, 4);
	const endless = await endlessChunkedPost(address.port, "/hooks/plain");
	assert.match(endless.status, / 413 /);
	assert.equal(endless.closed, true);
	assert.ok(endless.sentBytes < 3_500_000, `server read ${endless.sentBytes} bytes`);
	const [github, plain] = [await conversationOf(mochi, "github"), await conversationOf(mochi, "plain")];
	await Promise.all([github.waitForIdle(context), plain.waitForIdle(context)]);

	const inputs = (await github.entries({}, 50, undefined, context)).items.filter((entry) => UserEntry.is(entry));
	assert.equal(inputs.length, 1);
	assert.equal(messageText(inputs[0]!.model![0]!), `A GitHub event.\n<webhook_payload source="github">\n${body}\n</webhook_payload>`);
	// Without a delivery header the id is the body's SHA-256.
	const sha = createHash("sha256").update("ping").digest("hex");
	assert.equal((await mochi.harness.commit((tx) => tx.submissionByRequest(plain.id, `webhook:plain:${sha}`), context))?.status, "done");
	assert.equal(faux.state.callCount, 2);

});

test("admitWhen: a no is acknowledged without a run; a yes or a classifier error runs", async () => {
	const admitWhen = { question: "Did CI fail?", yes: "Failed", no: "Passed" };
	const trigger: Trigger = { kind: "webhook", id: "ci", auth: { kind: "bearer", token: TOKEN }, prompt: "CI finished.", admitWhen };
	for (const [outcome, runs] of [[0.1, 0], [0.8, 1], ["down", 1]] as const) {
		const faux = newFaux();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const mochi = await openTestMochi(await tempDir(), faux);
		await reconcileSeeds(mochi.harness, mochi.trigger, [trigger], mochi.catalog, context);
		const stop = new AbortController();
		const running = withAbortSignal(stop.signal, context);
		const classify = fixedClassify(outcome);
		const logs: string[] = [];
		const { address } = await startWebhookServer({ harness: mochi.harness, classify, log: (event) => logs.push(event) }, { host: "127.0.0.1", port: 0 }, running);
		const response = await fetch(`http://127.0.0.1:${address.port}/hooks/ci`, {
			method: "POST",
			body: '{"conclusion":"success"}',
			headers: { Authorization: `Bearer ${TOKEN}`, "X-Request-Id": "r-1" },
		});
		assert.equal(response.status, 202);
		const ci = await conversationOf(mochi, "ci");
		await ci.waitForIdle(context);
		assert.equal(faux.state.callCount, runs);
		assert.equal((await mochi.harness.commit((tx) => tx.submissionByRequest(ci.id, "webhook:ci:r-1"), context))?.status, runs === 0 ? undefined : "done");
		assert.deepEqual(classify.calls, [{ webhook: "ci", purpose: "CI finished.", payload: '{"conclusion":"success"}' }]);
		assert.equal(logs.includes("webhook.gate_failed_open"), outcome === "down");
		stop.abort();
		await mochi.close();
	}
});

test("a hung webhook run is aborted at its deadline, so the next delivery runs instead of answering 503", async (t) => {
	const trigger: Trigger = { kind: "webhook", id: "ci", auth: { kind: "bearer", token: TOKEN }, prompt: "CI finished." };
	const faux = newFaux();
	const hang = async (_c: unknown, options: { signal?: AbortSignal } | undefined): Promise<AssistantMessage> =>
		new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
	faux.setResponses([hang, fauxAssistantMessage("ok")]);
	const mochi = await openTestMochi(await tempDir(), faux);
	await reconcileSeeds(mochi.harness, mochi.trigger, [trigger], mochi.catalog, context);
	const stop = new AbortController();
	t.after(async () => {
		stop.abort();
		await mochi.close();
	});
	const logs: string[] = [];
	const { address } = await startWebhookServer(
		{ harness: mochi.harness, classify: fixedClassify("unused"), log: (event) => logs.push(event), deadlineMs: 2000 },
		{ host: "127.0.0.1", port: 0 },
		withAbortSignal(stop.signal, context),
	);
	const post = (id: string) =>
		fetch(`http://127.0.0.1:${address.port}/hooks/ci`, { method: "POST", body: id, headers: { Authorization: `Bearer ${TOKEN}`, "X-Request-Id": id } });
	assert.equal((await post("r-1")).status, 202);
	assert.equal((await post("r-2")).status, 503);
	while (!logs.includes("webhook.timed_out")) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal((await post("r-3")).status, 202);
	const ci = await conversationOf(mochi, "ci");
	await ci.waitForIdle(context);
	assert.equal((await mochi.harness.commit((tx) => tx.submissionByRequest(ci.id, "webhook:ci:r-3"), context))?.status, "done");
});

test("webhook payloads are truncated to 20,000 characters", () => {
	const content = webhookContent("big", "Prompt.", Buffer.from("a".repeat(PAYLOAD_CHARS + 500)));
	assert.ok(content.includes(`${"a".repeat(PAYLOAD_CHARS)}\n[truncated, ${PAYLOAD_CHARS + 500} characters in total]\n</webhook_payload>`));
	assert.ok(!content.includes("a".repeat(PAYLOAD_CHARS + 1)));
});
