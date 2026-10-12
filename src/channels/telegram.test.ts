import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createTelegramChannel, parseMessageId, parseTelegramMessage } from "./telegram.ts";
import { type Channel, ChannelDown, type Inbound, SendRejected, SendUnknown } from "./types.ts";

const OWNER = 7712345678;
const TOKEN = "123:abc";
const fixture = (name: string): { readonly update_id: number; readonly message: unknown } =>
	JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));

interface ApiCall {
	readonly method: string;
	readonly params: Record<string, unknown>;
}

/** `failSends` answers sendMessage and sendDocument with that Bot API error code, or never answers them when "hang". */
async function fakeBotApi(updates: readonly unknown[], failSends?: number | "hang"): Promise<{ readonly root: string; readonly calls: ApiCall[]; readonly close: () => void }> {
	const calls: ApiCall[] = [];
	let pending = [...updates];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const url = req.url ?? "";
			if (url.startsWith(`/file/bot${TOKEN}/`)) {
				res.end(Buffer.from(url.slice(`/file/bot${TOKEN}/`.length)));
				return;
			}
			const method = url.split("/").at(-1) ?? "";
			const text = Buffer.concat(chunks).toString("utf8");
			const params = text && req.headers["content-type"]?.startsWith("application/json") ? JSON.parse(text) : {};
			const reply = (result: unknown) => res.setHeader("content-type", "application/json").end(JSON.stringify({ ok: true, result }));
			if (method !== "getUpdates") calls.push({ method, params });
			if (failSends !== undefined && (method === "sendMessage" || method === "sendDocument")) {
				if (failSends === "hang") return;
				return void res.setHeader("content-type", "application/json").end(JSON.stringify({ ok: false, error_code: failSends, description: "refused" }));
			}
			switch (method) {
				case "getMe":
					return reply({ id: 1, is_bot: true, first_name: "mochi", username: "mochi_bot" });
				case "getUpdates": {
					const batch = pending;
					pending = [];
					if (batch.length > 0) return reply(batch);
					return void setTimeout(() => reply([]), 50);
				}
				case "getFile":
					return reply({ file_id: params.file_id, file_unique_id: "u", file_path: `files/${params.file_id}` });
				case "sendMessage":
					return reply({ message_id: 100, date: 0, chat: { id: params.chat_id, type: "private" }, text: params.text });
				default:
					return reply(true);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		root: `http://127.0.0.1:${port}`,
		calls,
		close: () => {
			server.close();
			server.closeAllConnections();
		},
	};
}

const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_ID: String(OWNER) };

function channelFor(root: string): Channel {
	const setup = createTelegramChannel(env, { apiRoot: root, log: () => {}, sendTimeoutMs: 300 });
	assert.equal(setup.kind, "ready");
	return setup.value;
}

describe("telegram config", () => {
	it("is off with no variable and broken naming a missing one", () => {
		assert.deepEqual(createTelegramChannel({}), { kind: "off" });
		assert.deepEqual(createTelegramChannel({ TELEGRAM_BOT_TOKEN: TOKEN }), { kind: "broken", fix: "TELEGRAM_OWNER_ID is not set. Fix: export it where mochi starts" });
	});

	it("is broken with a non-numeric owner id", () => {
		assert.deepEqual(createTelegramChannel({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_ID: "@me" }), { kind: "broken", fix: "TELEGRAM_OWNER_ID must be a numeric Telegram user id" });
	});
});

describe("telegram payload parsing", () => {
	it("extracts text and a chat-scoped messageId that maps back to message_id", () => {
		const parsed = parseTelegramMessage(fixture("telegram-text.json").message, OWNER);
		assert.deepEqual(parsed, {
			kind: "message",
			message: { messageId: "7712345678:42", at: new Date(1759653720 * 1000), text: "hello mochi", files: [] },
		});
		assert.deepEqual(parseMessageId("7712345678:42"), { chatId: OWNER, messageId: 42 });
		assert.deepEqual(parseMessageId("-1001234:7"), { chatId: -1001234, messageId: 7 });
	});

	it("drops a sender other than the owner", () => {
		assert.deepEqual(parseTelegramMessage(fixture("telegram-stranger.json").message, OWNER), { kind: "ignored", reason: "not-owner" });
	});

	it("maps the largest photo to an image, a voice note to audio and a document to a file", () => {
		const photo = parseTelegramMessage(fixture("telegram-photo.json").message, OWNER);
		const voice = parseTelegramMessage(fixture("telegram-voice.json").message, OWNER);
		const doc = parseTelegramMessage(fixture("telegram-document.json").message, OWNER);
		assert.ok(photo.kind === "message" && voice.kind === "message" && doc.kind === "message");
		assert.equal(photo.message.text, "look at this");
		assert.deepEqual(photo.message.files, [{ kind: "image", fileId: "AgACAgLarge", mimeType: "image/jpeg" }]);
		assert.deepEqual(voice.message.files, [{ kind: "audio", fileId: "AwACAgVoice", mimeType: "audio/ogg" }]);
		assert.deepEqual(doc.message.files, [{ kind: "file", fileId: "BQACAgDoc", mimeType: "application/pdf" }]);
	});
});

describe("telegram adapter against a fake Bot API", () => {
	it("long-polls, drops strangers, downloads voice bytes and delivers owner messages", async (t) => {
		const api = await fakeBotApi(["telegram-stranger.json", "telegram-voice.json"].map(fixture));
		const received: Inbound[] = [];
		const controller = new AbortController();
		let arrived: () => void = () => {};
		const done = new Promise<void>((resolve) => (arrived = resolve));
		const running = channelFor(api.root).run(async (message) => {
			received.push(message);
			arrived();
		}, controller.signal);
		t.after(async () => {
			controller.abort();
			await running;
			api.close();
		});
		await done;
		assert.deepEqual(received, [
			{
				kind: "message",
				channel: "telegram",
				messageId: "7712345678:44",
				at: new Date(1759653722 * 1000),
				text: "",
				attachments: [{ kind: "audio", mimeType: "audio/ogg", bytes: new Uint8Array(Buffer.from("files/AwACAgVoice")) }],
			},
		]);
		assert.deepEqual(api.calls.find((c) => c.method === "getFile")?.params, { file_id: "AwACAgVoice" });
	});

	it("chunks text, sends a link as text and a file as a document, types, and sets and clears a typed reaction", async (t) => {
		const api = await fakeBotApi([]);
		t.after(api.close);
		const channel = channelFor(api.root);
		await channel.send({ kind: "text", text: `${"a".repeat(4096)} tail` });
		await channel.send({ kind: "link", url: "https://example.com" });
		await channel.send({ kind: "file", name: "plan.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) });
		await channel.typing(true);
		await channel.typing(false);
		await channel.react?.("7712345678:42", "emphasize");
		await channel.react?.("7712345678:42", "none");
		assert.deepEqual(api.calls, [
			{ method: "sendMessage", params: { chat_id: OWNER, text: "a".repeat(4096) } },
			{ method: "sendMessage", params: { chat_id: OWNER, text: "tail" } },
			{ method: "sendMessage", params: { chat_id: OWNER, text: "https://example.com" } },
			{ method: "sendDocument", params: {} },
			{ method: "sendChatAction", params: { chat_id: OWNER, action: "typing" } },
			{ method: "setMessageReaction", params: { chat_id: OWNER, message_id: 42, reaction: [{ type: "emoji", emoji: "🔥" }] } },
			{ method: "setMessageReaction", params: { chat_id: OWNER, message_id: 42, reaction: [] } },
		]);
	});

	it("maps every send failure to one delivery error class", async (t) => {
		const failWith = async (failSends: number | "hang") => {
			const api = await fakeBotApi([], failSends);
			t.after(api.close);
			return channelFor(api.root).send({ kind: "file", name: "a.exe", mimeType: "application/octet-stream", bytes: new Uint8Array([1]) });
		};
		await assert.rejects(failWith(400), SendRejected, "a refused attachment is rejected");
		await assert.rejects(failWith(429), ChannelDown, "rate limited never left");
		await assert.rejects(failWith("hang"), SendUnknown, "a timed-out send has an unknown outcome");
		await assert.rejects(channelFor("http://127.0.0.1:1").send({ kind: "text", text: "hi" }), ChannelDown, "unreachable never left");
	});
});
