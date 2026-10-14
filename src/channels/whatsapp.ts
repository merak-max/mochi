import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Type from "typebox";
import { Value } from "typebox/value";
import { readBody, safeEqual, validSha256Signature } from "../http.ts";
import { log } from "../log.ts";
import type { Setup } from "../setup.ts";
import {
	type Attachment,
	attachmentKind,
	type Bubble,
	type Channel,
	ChannelDown,
	type ChannelProfile,
	channelSetup,
	chunkText,
	type DeliveryError,
	type Env,
	type InboundSink,
	SendRejected,
	SendUnknown,
} from "./types.ts";

const GRAPH_API = "https://graph.facebook.com/v25.0";
const TEXT_LIMIT = 4096;
const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);
const SEND_TIMEOUT_MS = 30_000;

const WHATSAPP_PROFILE: ChannelProfile = {
	id: "whatsapp",
	style: "whatsapp: plain text with *bold* and _italic_, no tables, one message per reply, up to 4,096 characters. react sets an emoji reaction.",
	maxBubbles: 3,
	maxBubbleChars: TEXT_LIMIT,
	paragraphsAreBubbles: false,
	typingMaxMs: 90_000,
};

const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_PORT = 8787;

interface WhatsAppConfig {
	readonly token: string;
	readonly phoneNumberId: string;
	readonly verifyToken: string;
	readonly appSecret: string;
	readonly owner: string;
	readonly host: string;
	readonly port: number;
}

const Media = Type.Object({
	id: Type.String(),
	mime_type: Type.String(),
	caption: Type.Optional(Type.String()),
	filename: Type.Optional(Type.String()),
});

const WaMessage = Type.Object({
	from: Type.String(),
	id: Type.String(),
	timestamp: Type.String(),
	type: Type.String(),
	text: Type.Optional(Type.Object({ body: Type.String() })),
	image: Type.Optional(Media),
	sticker: Type.Optional(Media),
	audio: Type.Optional(Media),
	video: Type.Optional(Media),
	document: Type.Optional(Media),
});
type WaMessage = Type.Static<typeof WaMessage>;

const Envelope = Type.Object({
	object: Type.Literal("whatsapp_business_account"),
	entry: Type.Array(
		Type.Object({
			changes: Type.Array(
				Type.Object({
					field: Type.String(),
					value: Type.Object({ messages: Type.Optional(Type.Array(Type.Unknown())) }),
				}),
			),
		}),
	),
});

const MediaUrl = Type.Object({ url: Type.String(), mime_type: Type.String() });

interface MediaRef {
	readonly kind: Attachment["kind"];
	readonly mediaId: string;
	readonly mimeType: string;
}

interface WhatsAppInbound {
	readonly messageId: string;
	readonly at: Date;
	readonly text: string;
	readonly media: readonly MediaRef[];
}

type ParsedMessage =
	| { readonly kind: "message"; readonly message: WhatsAppInbound }
	| { readonly kind: "ignored"; readonly reason: "invalid" | "not-owner" | "unsupported-type"; readonly id?: string };

/**
 * Graph answers 401, 429 and 503 before taking the message, other 5xx may have taken it, and any other 4xx refuses it.
 * A fetch that fails to connect never left; one that times out or breaks after may have.
 */
function classifyWhatsAppError(error: unknown, status?: number): DeliveryError {
	const message = `WhatsApp send failed: ${error instanceof Error ? error.message : String(error)}`;
	if (status !== undefined) {
		if (status === 401 || status === 429 || status === 503) return new ChannelDown(message, { cause: error });
		return status >= 500 ? new SendUnknown(message, { cause: error }) : new SendRejected(message, { cause: error });
	}
	const cause = error instanceof Error ? error.cause : undefined;
	const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
	return typeof code === "string" && UNREACHABLE.has(code) ? new ChannelDown(message, { cause: error }) : new SendUnknown(message, { cause: error });
}

function extractMessages(body: unknown): unknown[] {
	if (!Value.Check(Envelope, body)) return [];
	return body.entry.flatMap((entry) =>
		entry.changes.flatMap((change) => (change.field === "messages" ? (change.value.messages ?? []) : [])),
	);
}

function mediaOf(message: WaMessage): { readonly kind: Attachment["kind"]; readonly media: Type.Static<typeof Media> } | undefined {
	switch (message.type) {
		case "image":
			return message.image && { kind: "image", media: message.image };
		case "sticker":
			return message.sticker && { kind: "image", media: message.sticker };
		case "audio":
			return message.audio && { kind: "audio", media: message.audio };
		case "video":
			return message.video && { kind: "file", media: message.video };
		case "document":
			return message.document && { kind: "file", media: message.document };
		default:
			return undefined;
	}
}

function parseWhatsAppMessage(raw: unknown, owner: string): ParsedMessage {
	if (!Value.Check(WaMessage, raw)) return { kind: "ignored", reason: "invalid" };
	if (raw.from !== owner) return { kind: "ignored", reason: "not-owner", id: raw.id };
	const base = { messageId: raw.id, at: new Date(Number(raw.timestamp) * 1000) };
	if (raw.type === "text" && raw.text) {
		return { kind: "message", message: { ...base, text: raw.text.body, media: [] } };
	}
	const found = mediaOf(raw);
	if (!found) return { kind: "ignored", reason: "unsupported-type", id: raw.id };
	const ref = { kind: found.kind, mediaId: found.media.id, mimeType: found.media.mime_type };
	return { kind: "message", message: { ...base, text: found.media.caption ?? "", media: [ref] } };
}

export function createWhatsAppChannel(env: Env): Setup<Channel> {
	return channelSetup(env, ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_OWNER"], (values) => {
		const owner = values.WHATSAPP_OWNER.replace(/\D/g, "");
		if (owner === "") throw new Error("WHATSAPP_OWNER must be a phone number");
		const port = env.WHATSAPP_PORT ? Number(env.WHATSAPP_PORT) : DEFAULT_PORT;
		if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("WHATSAPP_PORT must be a port number");
		return whatsAppChannel({
			token: values.WHATSAPP_TOKEN,
			phoneNumberId: values.WHATSAPP_PHONE_NUMBER_ID,
			verifyToken: values.WHATSAPP_VERIFY_TOKEN,
			appSecret: values.WHATSAPP_APP_SECRET,
			owner,
			host: env.MOCHI_BIND_HOST ?? "127.0.0.1",
			port,
		});
	});
}

function whatsAppChannel(config: WhatsAppConfig): Channel {
	const auth = { authorization: `Bearer ${config.token}` };
	let lastInbound: string | undefined;

	async function graph(path: string, body: FormData | Record<string, unknown>): Promise<unknown> {
		let res: Response;
		try {
			res = await fetch(`${GRAPH_API}/${config.phoneNumberId}/${path}`, {
				method: "POST",
				headers: body instanceof FormData ? auth : { ...auth, "content-type": "application/json" },
				body: body instanceof FormData ? body : JSON.stringify({ messaging_product: "whatsapp", ...body }),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
		} catch (error) {
			throw classifyWhatsAppError(error);
		}
		if (!res.ok) throw classifyWhatsAppError(new Error(`Graph ${path} answered ${res.status}: ${await res.text()}`), res.status);
		return res.json();
	}

	const postMessage = (payload: Record<string, unknown>) => graph("messages", { recipient_type: "individual", to: config.owner, ...payload });

	async function sendFile(file: Extract<Bubble, { kind: "file" }>): Promise<void> {
		const form = new FormData();
		form.set("messaging_product", "whatsapp");
		form.set("type", file.mimeType);
		form.set("file", new Blob([Buffer.from(file.bytes)], { type: file.mimeType }), file.name);
		const uploaded = await graph("media", form);
		const id = typeof uploaded === "object" && uploaded !== null && "id" in uploaded ? String(uploaded.id) : undefined;
		if (id === undefined) throw new SendUnknown("WhatsApp media upload returned no id");
		const kind = attachmentKind(file.mimeType);
		await postMessage(kind === "file" ? { type: "document", document: { id, filename: file.name } } : { type: kind, [kind]: { id } });
	}

	async function download(ref: MediaRef): Promise<Attachment> {
		const metaRes = await fetch(`${GRAPH_API}/${ref.mediaId}?phone_number_id=${config.phoneNumberId}`, { headers: auth });
		if (!metaRes.ok) throw new Error(`WhatsApp media lookup failed with ${metaRes.status}`);
		const meta: unknown = await metaRes.json();
		if (!Value.Check(MediaUrl, meta)) throw new Error("WhatsApp media lookup returned an unexpected body");
		const bytesRes = await fetch(meta.url, { headers: auth });
		if (!bytesRes.ok) throw new Error(`WhatsApp media download failed with ${bytesRes.status}`);
		return { kind: ref.kind, mimeType: ref.mimeType, bytes: new Uint8Array(await bytesRes.arrayBuffer()) };
	}

	async function deliver(rawBody: Buffer, sink: InboundSink): Promise<void> {
		let body: unknown;
		try {
			body = JSON.parse(rawBody.toString("utf8"));
		} catch {
			log("channel.invalid_json", { channel: "whatsapp" });
			return;
		}
		for (const raw of extractMessages(body)) {
			const parsed = parseWhatsAppMessage(raw, config.owner);
			if (parsed.kind === "ignored") {
				log("channel.message_dropped", { channel: "whatsapp", reason: parsed.reason, id: parsed.id });
				continue;
			}
			const { media, ...message } = parsed.message;
			lastInbound = message.messageId;
			const attachments = await Promise.all(media.map(download));
			await sink({ kind: "message", channel: "whatsapp", ...message, attachments });
		}
	}

	return {
		profile: WHATSAPP_PROFILE,

		async run(sink, signal) {
			let queue = Promise.resolve();
			const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
				if (req.method === "GET") {
					const params = new URL(req.url ?? "/", "http://localhost").searchParams;
					const verified =
						params.get("hub.mode") === "subscribe" && safeEqual(params.get("hub.verify_token") ?? "", config.verifyToken);
					if (verified) res.writeHead(200, { "content-type": "text/plain" }).end(params.get("hub.challenge") ?? "");
					else res.writeHead(403).end();
					return;
				}
				if (req.method !== "POST") {
					res.writeHead(405).end();
					return;
				}
				const rawBody = await readBody(req, res, MAX_BODY_BYTES);
				if (rawBody === undefined) return;
				if (!validSha256Signature(rawBody, req.headers["x-hub-signature-256"]?.toString(), config.appSecret)) {
					log("channel.bad_signature", { channel: "whatsapp" });
					res.writeHead(401).end();
					return;
				}
				res.writeHead(200).end();
				queue = queue
					.then(() => deliver(rawBody, sink))
					.catch((error: unknown) => log("channel.delivery_failed", { channel: "whatsapp", error: String(error) }));
			};
			const server = createServer((req, res) => {
				handle(req, res).catch((error: unknown) => {
					log("channel.request_failed", { channel: "whatsapp", error: String(error) });
					if (!res.headersSent) res.writeHead(500).end();
				});
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(config.port, config.host, () => {
					server.off("error", reject);
					resolve();
				});
			});
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			server.close();
			server.closeAllConnections();
		},

		async send(bubble) {
			if (bubble.kind === "file") return sendFile(bubble);
			for (const body of chunkText(bubble.kind === "text" ? bubble.text : bubble.url, TEXT_LIMIT)) {
				await postMessage({ type: "text", text: { preview_url: bubble.kind === "link", body } });
			}
		},

		async typing(on) {
			if (!on || lastInbound === undefined) return;
			await graph("messages", { status: "read", message_id: lastInbound, typing_indicator: { type: "text" } });
		},

		async react(messageId, reaction) {
			await postMessage({ type: "reaction", reaction: { message_id: messageId, emoji: reaction === "none" ? "" : reaction } });
		},
	};
}
