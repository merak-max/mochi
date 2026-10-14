import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { type Channel, ChannelDown, chunkText, type Inbound, SendRejected, SendUnknown } from "./types.ts";
import { createWhatsAppChannel, extractMessages, GRAPH_API, parseWhatsAppMessage } from "./whatsapp.ts";
import { validSha256Signature } from "../http.ts";
import { endlessChunkedPost } from "../test-support.ts";

const OWNER = "16505551234";
const SECRET = "app-secret";
const fixture = (name: string): string => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const sign = (body: string, secret = SECRET): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

interface Call {
	readonly url: string;
	readonly method: string;
	readonly auth: string | null;
	readonly body: unknown;
}

function fakeGraph(): { readonly fetch: typeof fetch; readonly calls: Call[] } {
	const calls: Call[] = [];
	const fakeFetch: typeof fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		const headers = new Headers(init?.headers);
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body instanceof FormData ? Object.fromEntries([...init.body].map(([key, value]) => [key, typeof value === "string" ? value : value.name])) : undefined;
		calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), body });
		if (url.endsWith("/media")) return Response.json({ id: "MEDIA1" });
		const mediaId = /\/v25\.0\/(\d+)\?phone_number_id=/.exec(url)?.[1];
		if (mediaId) return Response.json({ url: `https://lookaside.fbsbx.com/media/${mediaId}`, mime_type: "image/jpeg", id: mediaId });
		if (url.startsWith("https://lookaside.fbsbx.com/media/")) return new Response(new Uint8Array([1, 2, 3]));
		return Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.OUT" }] });
	};
	return { fetch: fakeFetch, calls };
}

async function startChannel(): Promise<{
	readonly base: string;
	readonly channel: Channel;
	readonly received: Inbound[];
	readonly graph: ReturnType<typeof fakeGraph>;
	readonly waitFor: (count: number) => Promise<void>;
	readonly stop: () => void;
}> {
	const port = await freePort();
	const graph = fakeGraph();
	const channel = createWhatsAppChannel(
		{
			WHATSAPP_TOKEN: "token",
			WHATSAPP_PHONE_NUMBER_ID: "106540352242922",
			WHATSAPP_VERIFY_TOKEN: "verify-me",
			WHATSAPP_APP_SECRET: SECRET,
			WHATSAPP_OWNER: `+${OWNER}`,
			WHATSAPP_PORT: String(port),
		},
		{ fetch: graph.fetch, log: () => {} },
	);
	assert.equal(channel.kind, "ready");
	const received: Inbound[] = [];
	const waiters: Array<() => void> = [];
	const controller = new AbortController();
	void channel.value.run(async (message) => {
		received.push(message);
		for (const wake of waiters.splice(0)) wake();
	}, controller.signal);
	while (!(await fetch(`http://127.0.0.1:${port}/`, { method: "PUT" }).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 10));
	const waitFor = async (count: number): Promise<void> => {
		while (received.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
	};
	return { base: `http://127.0.0.1:${port}`, channel: channel.value, received, graph, waitFor, stop: () => controller.abort() };
}

const post = (base: string, body: string, signature: string | undefined): Promise<Response> =>
	fetch(base, {
		method: "POST",
		headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
		body,
	});

describe("whatsapp config", () => {
	it("is off with no variable and broken naming every missing one", () => {
		assert.deepEqual(createWhatsAppChannel({}), { kind: "off" });
		assert.deepEqual(createWhatsAppChannel({ WHATSAPP_TOKEN: "t" }), {
			kind: "broken",
			fix: "WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_OWNER are not set. Fix: export them where mochi starts",
		});
	});
});

describe("whatsapp payload parsing", () => {
	it("extracts text, sender and a stable messageId from the messages change", () => {
		const [raw] = extractMessages(JSON.parse(fixture("whatsapp-text.json")));
		assert.deepEqual(parseWhatsAppMessage(raw, OWNER), {
			kind: "message",
			message: {
				messageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
				at: new Date(1749416383 * 1000),
				text: "Does it come in another color?",
				media: [],
			},
		});
	});

	it("ignores status changes", () => {
		assert.deepEqual(extractMessages(JSON.parse(fixture("whatsapp-status.json"))), []);
	});

	it("drops a sender other than the owner", () => {
		const [raw] = extractMessages(JSON.parse(fixture("whatsapp-stranger.json")));
		assert.deepEqual(parseWhatsAppMessage(raw, OWNER), { kind: "ignored", reason: "not-owner", id: "wamid.STRANGER" });
	});

	it("maps image, voice and document media to attachment kinds with captions as text", () => {
		const parse = (name: string) => parseWhatsAppMessage(extractMessages(JSON.parse(fixture(name)))[0], OWNER);
		const image = parse("whatsapp-image.json");
		const voice = parse("whatsapp-voice.json");
		const doc = parse("whatsapp-document.json");
		assert.ok(image.kind === "message" && voice.kind === "message" && doc.kind === "message");
		assert.equal(image.message.text, "Taj Mahal");
		assert.deepEqual(image.message.media, [{ kind: "image", mediaId: "1003383421387256", mimeType: "image/jpeg" }]);
		assert.deepEqual(voice.message.media, [{ kind: "audio", mediaId: "1908647269898587", mimeType: "audio/ogg; codecs=opus" }]);
		assert.deepEqual(doc.message.media, [{ kind: "file", mediaId: "622684793477189", mimeType: "application/pdf" }]);
	});
});

describe("whatsapp signature", () => {
	it("accepts the app-secret HMAC and rejects a wrong secret or truncated digest", () => {
		const body = fixture("whatsapp-text.json");
		const raw = Buffer.from(body);
		assert.equal(validSha256Signature(raw, sign(body), SECRET), true);
		assert.equal(validSha256Signature(raw, sign(body, "other"), SECRET), false);
		assert.equal(validSha256Signature(raw, sign(body).slice(0, -2), SECRET), false);
		assert.equal(validSha256Signature(raw, undefined, SECRET), false);
	});
});

describe("chunkText", () => {
	it("splits on whitespace under the limit and keeps every character", () => {
		const text = `${"a".repeat(3000)} ${"b".repeat(3000)}\n${"c".repeat(100)}`;
		const chunks = chunkText(text, 4096);
		assert.deepEqual(chunks.map((c) => c.length), [3000, 3101]);
		assert.ok(chunks.every((c) => c.length <= 4096));
	});

	it("hard-splits a long word without cutting a surrogate pair", () => {
		const chunks = chunkText(`${"x".repeat(4095)}😀${"y".repeat(10)}`, 4096);
		assert.deepEqual(chunks.map((c) => c.length), [4095, 12]);
		assert.equal(chunks.join(""), `${"x".repeat(4095)}😀${"y".repeat(10)}`);
	});

	it("returns no chunks for empty text", () => {
		assert.deepEqual(chunkText("", 10), []);
	});
});

describe("whatsapp webhook server", () => {
	it("answers the GET verify handshake only with the right token", async (t) => {
		const server = await startChannel();
		t.after(server.stop);
		const ok = await fetch(`${server.base}/?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444`);
		assert.equal(ok.status, 200);
		assert.equal(await ok.text(), "1158201444");
		const bad = await fetch(`${server.base}/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
		assert.equal(bad.status, 403);
	});

	it("answers an endless chunked body with 413 and closes the connection before reading 3 MB", async (t) => {
		const server = await startChannel();
		t.after(server.stop);
		const result = await endlessChunkedPost(Number(new URL(server.base).port), "/");
		assert.match(result.status, / 413 /);
		assert.equal(result.closed, true);
		assert.ok(result.sentBytes < 3_500_000, `server read ${result.sentBytes} bytes`);
		assert.deepEqual(server.received, []);
	});

	it("rejects a bad signature with 401 and delivers nothing", async (t) => {
		const server = await startChannel();
		t.after(server.stop);
		const body = fixture("whatsapp-text.json");
		assert.equal((await post(server.base, body, sign(body, "forged"))).status, 401);
		assert.equal((await post(server.base, body, undefined)).status, 401);
		assert.deepEqual(server.received, []);
	});

	it("accepts a signed message, downloads its media through Graph with the bearer token and delivers it", async (t) => {
		const server = await startChannel();
		t.after(server.stop);
		const stranger = fixture("whatsapp-stranger.json");
		const image = fixture("whatsapp-image.json");
		assert.equal((await post(server.base, stranger, sign(stranger))).status, 200);
		assert.equal((await post(server.base, image, sign(image))).status, 200);
		await server.waitFor(1);
		assert.equal(server.received.length, 1);
		assert.deepEqual(server.received, [
			{ kind: "message", channel: "whatsapp", messageId: "wamid.IMAGE1", at: new Date(1749416383 * 1000), text: "Taj Mahal", attachments: [{ kind: "image", mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }] },
		]);
		assert.deepEqual(
			server.graph.calls.map((c) => [c.url, c.auth]),
			[
				[`${GRAPH_API}/1003383421387256?phone_number_id=106540352242922`, "Bearer token"],
				["https://lookaside.fbsbx.com/media/1003383421387256", "Bearer token"],
			],
		);
	});
});

describe("whatsapp outbound", () => {
	const channel = (graph: { readonly fetch: typeof fetch }): Channel => {
		const setup = createWhatsAppChannel(
			{ WHATSAPP_TOKEN: "token", WHATSAPP_PHONE_NUMBER_ID: "106540352242922", WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_APP_SECRET: SECRET, WHATSAPP_OWNER: OWNER },
			{ fetch: graph.fetch, log: () => {}, sendTimeoutMs: 200 },
		);
		assert.equal(setup.kind, "ready");
		return setup.value;
	};
	const text = (body: string, preview = false) => ({ messaging_product: "whatsapp", recipient_type: "individual", to: OWNER, type: "text", text: { preview_url: preview, body } });

	it("sends chunked text, a link with its preview, and a file by its upload id to the owner", async () => {
		const graph = fakeGraph();
		const wa = channel(graph);
		await wa.send({ kind: "text", text: `${"a".repeat(4096)} tail` });
		await wa.send({ kind: "link", url: "https://example.com" });
		await wa.send({ kind: "file", name: "plan.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) });
		const messages = `${GRAPH_API}/106540352242922/messages`;
		assert.deepEqual(
			graph.calls.map((c) => [c.method, c.url, c.auth, c.body]),
			[
				["POST", messages, "Bearer token", text("a".repeat(4096))],
				["POST", messages, "Bearer token", text("tail")],
				["POST", messages, "Bearer token", text("https://example.com", true)],
				["POST", `${GRAPH_API}/106540352242922/media`, "Bearer token", { messaging_product: "whatsapp", type: "application/pdf", file: "plan.pdf" }],
				["POST", messages, "Bearer token", { messaging_product: "whatsapp", recipient_type: "individual", to: OWNER, type: "document", document: { id: "MEDIA1", filename: "plan.pdf" } }],
			],
		);
	});

	it("sends a typed reaction, and none to remove it", async () => {
		const graph = fakeGraph();
		const wa = channel(graph);
		await wa.react?.("wamid.IMAGE1", "👍");
		await wa.react?.("wamid.IMAGE1", "none");
		assert.deepEqual(
			graph.calls.map((c) => c.body),
			[
				{ messaging_product: "whatsapp", recipient_type: "individual", to: OWNER, type: "reaction", reaction: { message_id: "wamid.IMAGE1", emoji: "👍" } },
				{ messaging_product: "whatsapp", recipient_type: "individual", to: OWNER, type: "reaction", reaction: { message_id: "wamid.IMAGE1", emoji: "" } },
			],
		);
	});

	it("maps every send failure to one delivery error class", async () => {
		const status = (code: number) => ({ fetch: (async () => new Response("no", { status: code })) as typeof fetch });
		const refused = { fetch: (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }); }) as typeof fetch };
		const hang = { fetch: ((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch };
		const file = { kind: "file", name: "a.exe", mimeType: "application/octet-stream", bytes: new Uint8Array([1]) } as const;
		await assert.rejects(channel(status(400)).send(file), SendRejected, "a refused attachment is rejected");
		await assert.rejects(channel(status(429)).send({ kind: "text", text: "hi" }), ChannelDown);
		await assert.rejects(channel(status(500)).send({ kind: "text", text: "hi" }), SendUnknown);
		await assert.rejects(channel(refused).send({ kind: "text", text: "hi" }), ChannelDown, "unreachable never left");
		await assert.rejects(channel(hang).send({ kind: "text", text: "hi" }), SendUnknown, "a timed-out send has an unknown outcome");
	});

	it("sends the typing indicator against the owner's last inbound message, and skips it before any", async (t) => {
		const server = await startChannel();
		t.after(server.stop);
		await server.channel.typing(true);
		assert.equal(server.graph.calls.length, 0);
		const body = fixture("whatsapp-text.json");
		await post(server.base, body, sign(body));
		await server.waitFor(1);
		await server.channel.typing(true);
		assert.deepEqual(
			server.graph.calls.map((c) => [c.url, c.body]),
			[
				[
					`${GRAPH_API}/106540352242922/messages`,
					{
						messaging_product: "whatsapp",
						status: "read",
						message_id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
						typing_indicator: { type: "text" },
					},
				],
			],
		);
	});
});
