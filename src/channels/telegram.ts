import { Bot, GrammyError, HttpError, InputFile } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import Type from "typebox";
import { Value } from "typebox/value";
import { type Log, log as defaultLog } from "../log.ts";
import type { Setup } from "../setup.ts";
import {
	type Attachment,
	attachmentKind,
	type Channel,
	ChannelDown,
	type ChannelProfile,
	channelSetup,
	chunkText,
	type DeliveryError,
	type Env,
	type InboundSink,
	type Reaction,
	REACTIONS,
	SendRejected,
	SendUnknown,
} from "./types.ts";

const TEXT_LIMIT = 4096;
const SEND_TIMEOUT_MS = 30_000;

export const TELEGRAM_PROFILE: ChannelProfile = {
	id: "telegram",
	style: "telegram: plain text, one message per reply, up to 4,096 characters. react sets an emoji reaction.",
	maxBubbles: 3,
	maxBubbleChars: TEXT_LIMIT,
	paragraphsAreBubbles: false,
	reactions: REACTIONS,
	typingMaxMs: 90_000,
};

type TelegramEmoji = ReactionTypeEmoji["emoji"];

export interface TelegramDeps {
	readonly apiRoot?: string;
	readonly log?: Log;
	readonly sendTimeoutMs?: number;
}

const FileRef = Type.Object({ file_id: Type.String(), mime_type: Type.Optional(Type.String()) });

const TgMessage = Type.Object({
	message_id: Type.Integer(),
	date: Type.Integer(),
	chat: Type.Object({ id: Type.Integer() }),
	from: Type.Optional(Type.Object({ id: Type.Integer() })),
	text: Type.Optional(Type.String()),
	caption: Type.Optional(Type.String()),
	photo: Type.Optional(Type.Array(Type.Object({ file_id: Type.String(), width: Type.Integer(), height: Type.Integer() }))),
	voice: Type.Optional(FileRef),
	audio: Type.Optional(FileRef),
	document: Type.Optional(FileRef),
	video: Type.Optional(FileRef),
});

interface FileToFetch {
	readonly kind: Attachment["kind"];
	readonly fileId: string;
	readonly mimeType: string;
}

interface TelegramInbound {
	readonly messageId: string;
	readonly at: Date;
	readonly text: string;
	readonly files: readonly FileToFetch[];
}

type ParsedTelegram =
	| { readonly kind: "message"; readonly message: TelegramInbound }
	| { readonly kind: "ignored"; readonly reason: "invalid" | "not-owner" | "empty" };

const TELEGRAM_ENV = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID"] as const;

function formatMessageId(chatId: number, messageId: number): string {
	return `${chatId}:${messageId}`;
}

export function parseMessageId(messageId: string): { readonly chatId: number; readonly messageId: number } {
	const match = /^(-?\d+):(\d+)$/.exec(messageId);
	if (!match?.[1] || !match[2]) throw new Error(`Not a Telegram messageId: ${messageId}`);
	return { chatId: Number(match[1]), messageId: Number(match[2]) };
}

export function parseTelegramMessage(raw: unknown, ownerId: number): ParsedTelegram {
	if (!Value.Check(TgMessage, raw)) return { kind: "ignored", reason: "invalid" };
	if (raw.from?.id !== ownerId) return { kind: "ignored", reason: "not-owner" };
	const files: FileToFetch[] = [];
	const largestPhoto = raw.photo?.at(-1);
	if (largestPhoto) files.push({ kind: "image", fileId: largestPhoto.file_id, mimeType: "image/jpeg" });
	if (raw.voice) files.push({ kind: "audio", fileId: raw.voice.file_id, mimeType: raw.voice.mime_type ?? "audio/ogg" });
	if (raw.audio) files.push({ kind: "audio", fileId: raw.audio.file_id, mimeType: raw.audio.mime_type ?? "audio/mpeg" });
	if (raw.document) {
		const mimeType = raw.document.mime_type ?? "application/octet-stream";
		files.push({ kind: attachmentKind(mimeType), fileId: raw.document.file_id, mimeType });
	}
	if (raw.video) files.push({ kind: "file", fileId: raw.video.file_id, mimeType: raw.video.mime_type ?? "video/mp4" });
	const text = raw.text ?? raw.caption ?? "";
	if (text === "" && files.length === 0) return { kind: "ignored", reason: "empty" };
	return {
		kind: "message",
		message: {
			messageId: formatMessageId(raw.chat.id, raw.message_id),
			at: new Date(raw.date * 1000),
			text,
			files,
		},
	};
}

const TELEGRAM_REACTIONS: Readonly<Record<Reaction, TelegramEmoji>> = { love: "❤", like: "👍", dislike: "👎", laugh: "🤣", emphasize: "🔥", question: "🤔" };

const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * Bot API refusals carry `error_code`: 429 and 401 never left, a 5xx may have, any other 4xx is a refusal. A network
 * failure before connecting never left; one after (a reset, the send timeout) may have.
 */
export function classifyTelegramError(error: unknown): DeliveryError {
	const message = `Telegram send failed: ${error instanceof Error ? error.message : String(error)}`;
	if (error instanceof GrammyError) {
		if (error.error_code === 429 || error.error_code === 401) return new ChannelDown(message, { cause: error });
		return error.error_code >= 500 ? new SendUnknown(message, { cause: error }) : new SendRejected(message, { cause: error });
	}
	const code = error instanceof HttpError && typeof error.error === "object" && error.error !== null && "code" in error.error ? error.error.code : undefined;
	return typeof code === "string" && UNREACHABLE.has(code) ? new ChannelDown(message, { cause: error }) : new SendUnknown(message, { cause: error });
}

export function createTelegramChannel(env: Env, deps: TelegramDeps = {}): Setup<Channel> {
	return channelSetup(env, TELEGRAM_ENV, (values) => {
		const ownerId = Number(values.TELEGRAM_OWNER_ID);
		if (!Number.isSafeInteger(ownerId)) throw new Error("TELEGRAM_OWNER_ID must be a numeric Telegram user id");
		return telegramChannel(values.TELEGRAM_BOT_TOKEN, ownerId, deps);
	});
}

/** The owner's private chat with the bot has the owner's user id. */
function telegramChannel(token: string, ownerId: number, deps: TelegramDeps): Channel {
	const apiRoot = deps.apiRoot ?? "https://api.telegram.org";
	const log = deps.log ?? defaultLog;
	// grammY types its signal parameter with the abort-controller polyfill; the native signal is what it uses at runtime.
	const timeout = () => AbortSignal.timeout(deps.sendTimeoutMs ?? SEND_TIMEOUT_MS) as unknown as Parameters<typeof bot.api.sendMessage>[3];
	const bot = new Bot(token, { client: { apiRoot } });

	async function download(file: FileToFetch): Promise<Attachment> {
		const info = await bot.api.getFile(file.fileId);
		if (!info.file_path) throw new Error(`Telegram returned no file_path for ${file.fileId}`);
		const res = await fetch(`${apiRoot}/file/bot${token}/${info.file_path}`);
		if (!res.ok) throw new Error(`Telegram file download failed with ${res.status}`);
		return { kind: file.kind, mimeType: file.mimeType, bytes: new Uint8Array(await res.arrayBuffer()) };
	}

	async function handle(raw: unknown, sink: InboundSink): Promise<void> {
		const parsed = parseTelegramMessage(raw, ownerId);
		if (parsed.kind === "ignored") {
			log("channel.message_dropped", { channel: "telegram", reason: parsed.reason });
			return;
		}
		const { files, ...message } = parsed.message;
		const attachments = await Promise.all(files.map(download));
		await sink({ kind: "message", channel: "telegram", ...message, attachments });
	}

	return {
		profile: TELEGRAM_PROFILE,

		async run(sink, signal) {
			bot.on("message", (ctx) => handle(ctx.message, sink));
			bot.catch((error) => log("channel.handler_failed", { channel: "telegram", error: String(error.error) }));
			const stopped = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			const polling = bot.start({ allowed_updates: ["message"] }).catch((error: unknown) => log("channel.polling_stopped", { channel: "telegram", error: String(error) }));
			await stopped;
			await bot.stop().catch((error: unknown) => log("channel.stop_failed", { channel: "telegram", error: String(error) }));
			await polling;
		},

		async send(bubble) {
			try {
				if (bubble.kind === "file") await bot.api.sendDocument(ownerId, new InputFile(bubble.bytes, bubble.name), undefined, timeout());
				else for (const text of chunkText(bubble.kind === "text" ? bubble.text : bubble.url, TEXT_LIMIT)) await bot.api.sendMessage(ownerId, text, undefined, timeout());
			} catch (error) {
				throw classifyTelegramError(error);
			}
		},

		async typing(on) {
			if (on) await bot.api.sendChatAction(ownerId, "typing");
		},

		async react(messageId, reaction) {
			await bot.api.setMessageReaction(ownerId, parseMessageId(messageId).messageId, reaction === "none" ? [] : [{ type: "emoji", emoji: TELEGRAM_REACTIONS[reaction] }]);
		},
	};
}
