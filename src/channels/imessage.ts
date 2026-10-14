import { setTimeout as sleep } from "node:timers/promises";
import type { Content } from "spectrum-ts";
import { type Log, log as defaultLog } from "../log.ts";
import { clip } from "../text.ts";
import type { Setup } from "../setup.ts";
import {
	type Attachment,
	attachmentKind,
	type Channel,
	ChannelDown,
	type ChannelProfile,
	channelSetup,
	chunkText,
	DeliveryError,
	type Env,
	type Inbound,
	type ReplyTarget,
	SendRejected,
	SendUnknown,
} from "./types.ts";

const TEXT_LIMIT = 4000;
const REMEMBERED_MESSAGES = 200;

export const IMESSAGE_PROFILE: ChannelProfile = {
	id: "imessage",
	style:
		"imessage: plain text. Each blank-line-separated paragraph is its own bubble, so write one to three short ones. " +
		"A link alone on its line shows a link card. react sends a tapback.",
	maxBubbles: 3,
	maxBubbleChars: 400,
	paragraphsAreBubbles: true,
	typingMaxMs: 90_000,
};

const TAPBACK_TEXT_CHARS = 80;

export interface ReactionHandle {
	unsend(): Promise<void>;
}

export interface IMessageMessage {
	readonly id: string;
	readonly sequence?: number;
	readonly direction: "inbound" | "outbound";
	readonly sender: { readonly id: string } | undefined;
	readonly timestamp: Date;
	readonly content: Content;
	react(emoji: string): Promise<ReactionHandle | undefined>;
	/** Sends a read receipt. Only inbound messages can be marked read. */
	read?(): Promise<void>;
}

export interface IMessageSpace {
	send(text: string): Promise<unknown>;
	/** A threaded reply to `targetMessageId`; a plain send when the target cannot be found. */
	sendReply(text: string, targetMessageId: string): Promise<unknown>;
	sendLink(url: string): Promise<unknown>;
	sendFile(file: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array }): Promise<unknown>;
	startTyping(): Promise<void>;
	stopTyping(): Promise<void>;
	getMessage(id: string): Promise<IMessageMessage | undefined>;
}

export interface IMessageApp {
	readonly messages: AsyncIterable<readonly [IMessageSpace, IMessageMessage]>;
	/** Owner events after `since`, ending at catchup.complete. Absent when the stack cannot replay. */
	catchUp?(since: number): AsyncIterable<readonly [IMessageSpace, IMessageMessage]>;
	dm(handle: string): Promise<IMessageSpace>;
	stop(): Promise<void>;
}

export const LINK = { tickMs: 30_000, silentProbeMs: 5 * 60_000, failedProbesToRebuild: 2, catchUpEveryMs: 10 * 60_000, rebuildDelayMs: 5_000 };

/** Silence alone never rebuilds, it only earns a probe; the periodic catch-up heals a stall that probes cannot see. */
export function judge(health: { readonly lastSignalAt: number; readonly failedProbes: number; readonly ended: boolean }, now: number, config: typeof LINK): "none" | "probe" | "rebuild" {
	if (health.ended || health.failedProbes >= config.failedProbesToRebuild) return "rebuild";
	return now - health.lastSignalAt >= config.silentProbeMs ? "probe" : "none";
}

type Credentials = { readonly projectId: string; readonly projectSecret: string };

export interface IMessageDeps {
	readonly connect?: (credentials: Credentials) => Promise<IMessageApp>;
	readonly link?: typeof LINK;
	readonly log?: Log;
	/** Normalized handles of the users who may write besides the owner. */
	readonly users?: readonly string[];
}

export function normalizeHandle(handle: string): string {
	const trimmed = handle.trim().toLowerCase();
	return trimmed.includes("@") ? trimmed : trimmed.replace(/[^\d+]/g, "");
}

interface Collected {
	readonly text: string[];
	readonly attachments: Attachment[];
	replyTo?: ReplyTarget;
}

/** The text a message shows: its text, its link, or its group's texts. "" for anything else, such as a stub reply target. */
function contentText(content: Content): string {
	switch (content.type) {
		case "text":
			return content.text;
		case "richlink":
			return content.url;
		case "reply":
		case "effect":
			return contentText(content.content);
		case "group": {
			const texts: string[] = [];
			for (const item of content.items) {
				const text = contentText(item.content);
				if (text !== "") texts.push(text);
			}
			return texts.join("\n");
		}
		default:
			return "";
	}
}

async function collect(content: Content, into: Collected): Promise<void> {
	switch (content.type) {
		case "text":
			into.text.push(content.text);
			return;
		case "attachment":
			into.attachments.push({ kind: attachmentKind(content.mimeType), mimeType: content.mimeType, bytes: new Uint8Array(await content.read()) });
			return;
		case "voice":
			into.attachments.push({ kind: "audio", mimeType: content.mimeType, bytes: new Uint8Array(await content.read()) });
			return;
		case "richlink":
			into.text.push(content.url);
			return;
		case "reply":
			into.replyTo = { messageId: content.target.id, text: contentText(content.target.content), fromAgent: content.target.direction === "outbound" };
			await collect(content.content, into);
			return;
		case "effect":
			await collect(content.content, into);
			return;
		case "group":
			for (const item of content.items) await collect(item.content, into);
			return;
		default:
			return;
	}
}

type ParsedIMessage = { readonly kind: "message"; readonly message: Inbound } | { readonly kind: "ignored"; readonly reason: "outbound" | "not-owner" | "empty" };

export async function toInbound(message: IMessageMessage, owner: string, users: readonly string[] = []): Promise<ParsedIMessage> {
	if (message.direction === "outbound") return { kind: "ignored", reason: "outbound" };
	const sender = message.sender?.id === undefined ? "" : normalizeHandle(message.sender.id);
	if (sender === "" || (sender !== owner && !users.includes(sender))) return { kind: "ignored", reason: "not-owner" };
	const person = sender === owner ? {} : { person: sender };
	const sequence = message.sequence === undefined ? {} : { sequence: message.sequence };
	const content = message.content;
	if (content.type === "reaction") {
		const target = content.target;
		const onText = clip(contentText(target.content), TAPBACK_TEXT_CHARS);
		return {
			kind: "message",
			message: { kind: "tapback", channel: "imessage", messageId: message.id, on: target.id, emoji: content.emoji, onText, fromAgent: target.direction === "outbound", at: message.timestamp, ...person },
		};
	}
	const collected: Collected = { text: [], attachments: [] };
	await collect(content, collected);
	if (collected.text.length === 0 && collected.attachments.length === 0) return { kind: "ignored", reason: "empty" };
	const replyTo = collected.replyTo === undefined ? {} : { replyTo: collected.replyTo };
	return {
		kind: "message",
		message: { kind: "message", channel: "imessage", messageId: message.id, text: collected.text.join("\n"), at: message.timestamp, attachments: collected.attachments, ...sequence, ...person, ...replyTo },
	};
}

/**
 * The advanced-imessage SDK sets a numeric gRPC `grpcCode` on every error it surfaces: UNAVAILABLE, RESOURCE_EXHAUSTED
 * and the auth codes never left; DEADLINE_EXCEEDED may have; INVALID_ARGUMENT, NOT_FOUND and FAILED_PRECONDITION are
 * refusals. Anything else from the platform call has an unknown outcome.
 */
const GRPC_CLASS: Readonly<Record<number, new (message: string, options: ErrorOptions) => DeliveryError>> = {
	14: ChannelDown,
	8: ChannelDown,
	16: ChannelDown,
	7: ChannelDown,
	4: SendUnknown,
	3: SendRejected,
	5: SendRejected,
	9: SendRejected,
};

function classifyIMessageError(error: unknown): DeliveryError {
	if (error instanceof DeliveryError) return error;
	const code = typeof error === "object" && error !== null && "grpcCode" in error && typeof error.grpcCode === "number" ? error.grpcCode : undefined;
	const Class = (code === undefined ? undefined : GRPC_CLASS[code]) ?? SendUnknown;
	return new Class(`iMessage send failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

async function connectPhoton(credentials: Credentials): Promise<IMessageApp> {
	const { Spectrum, attachment, reply, richlink } = await import("spectrum-ts");
	const { imessage } = await import("spectrum-ts/providers/imessage");
	// @ts-expect-error spectrum-ts 12.10.1 provider types do not resolve under exactOptionalPropertyTypes; runtime accepts an empty config.
	const app = await Spectrum({ ...credentials, providers: [imessage.config()] });
	const platform = imessage(app);
	const wrap = (space: Awaited<ReturnType<typeof platform.space.create>>): IMessageSpace => ({
		send: (text) => space.send(text),
		sendReply: async (text, targetMessageId) => {
			const target = await space.getMessage(targetMessageId).catch(() => undefined);
			if (target === undefined) return space.send(text);
			return space.send(reply(text, target));
		},
		sendLink: (url) => space.send(richlink(url)),
		sendFile: (file) => space.send(attachment(Buffer.from(file.bytes), { name: file.name, mimeType: file.mimeType })),
		startTyping: () => space.startTyping(),
		stopTyping: () => space.stopTyping(),
		getMessage: (id) => space.getMessage(id) as Promise<IMessageMessage | undefined>,
	});
	return {
		messages: (async function* () {
			for await (const [space, message] of app.messages) yield [wrap(space as Parameters<typeof wrap>[0]), message as unknown as IMessageMessage] as const;
		})(),
		dm: async (handle) => wrap(await platform.space.create(handle)),
		stop: () => app.stop(),
	};
}

export function createIMessageChannel(env: Env, deps: IMessageDeps = {}): Setup<Channel> {
	return channelSetup(env, ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET", "IMESSAGE_OWNER"], (values) => {
		const credentials = { projectId: values.PHOTON_PROJECT_ID, projectSecret: values.PHOTON_PROJECT_SECRET };
		return iMessageChannel(credentials, normalizeHandle(values.IMESSAGE_OWNER), deps);
	});
}

function iMessageChannel(credentials: Credentials, owner: string, deps: IMessageDeps): Channel {
	const connect = deps.connect ?? connectPhoton;
	const log = deps.log ?? defaultLog;
	const link = deps.link ?? LINK;
	const users = deps.users ?? [];
	let app: IMessageApp | undefined;
	const spaces = new Map<string, IMessageSpace>();
	const recent = new Map<string, IMessageMessage>();
	const reactions = new Map<string, ReactionHandle>();

	function remember(message: IMessageMessage): void {
		recent.set(message.id, message);
		if (recent.size > REMEMBERED_MESSAGES) recent.delete(recent.keys().next().value!);
	}

	async function space(person = owner): Promise<IMessageSpace> {
		if (!app) throw new ChannelDown("iMessage is not connected");
		let found = spaces.get(person);
		if (found === undefined) {
			found = await app.dm(person);
			spaces.set(person, found);
		}
		return found;
	}

	return {
		profile: IMESSAGE_PROFILE,

		async run(sink, signal, cursor = async () => null) {
			const handle = async (from: IMessageSpace, message: IMessageMessage) => {
				try {
					const parsed = await toInbound(message, owner, users);
					if (parsed.kind === "ignored") {
						// Read receipts and typing arrive as messages with no content; only a real drop is worth a log line.
						const quiet = parsed.reason === "outbound" || message.content.type === "read" || message.content.type === "typing";
						if (!quiet) log("channel.message_dropped", { channel: "imessage", reason: parsed.reason, content: message.content.type });
						return;
					}
					spaces.set(parsed.message.person ?? owner, from);
					remember(message);
					if (parsed.message.kind === "message") message.read?.().catch(() => {});
					await sink(parsed.message);
				} catch (error) {
					log("channel.handler_failed", { channel: "imessage", error: String(error) });
				}
			};
			const catchUp = (connected: IMessageApp) =>
				(async () => {
					const since = await cursor();
					if (since !== null && connected.catchUp) for await (const [from, message] of connected.catchUp(since)) await handle(from, message);
				})().catch((error: unknown) => log("channel.catch_up_failed", { channel: "imessage", error: String(error) }));
			const supervise = async (connected: IMessageApp) => {
				app = connected;
				const health = { lastSignalAt: Date.now(), failedProbes: 0, ended: false };
				void (async () => {
					await catchUp(connected);
					for await (const [from, message] of connected.messages) {
						health.lastSignalAt = Date.now();
						await handle(from, message);
					}
				})()
					.catch((error: unknown) => log("channel.stream_failed", { channel: "imessage", error: String(error) }))
					.finally(() => (health.ended = true));
				for (let caughtUpAt = Date.now(); !signal.aborted; ) {
					await sleep(link.tickMs, undefined, { signal }).catch(() => {});
					const action = signal.aborted ? "none" : judge(health, Date.now(), link);
					if (action === "rebuild") return health.ended ? "stream ended" : "probes failed";
					if (action === "probe") {
						// Photon refuses the made-up id with a gRPC refusal (INVALID_ARGUMENT); any answer from the server proves the link.
						const alive = await space()
							.then((target) => target.getMessage("mochi-probe"))
							.then(
								() => true,
								(error: unknown) => !(classifyIMessageError(error) instanceof ChannelDown),
							);
						Object.assign(health, alive ? { lastSignalAt: Date.now(), failedProbes: 0 } : { failedProbes: health.failedProbes + 1 });
					}
					if (Date.now() - caughtUpAt < link.catchUpEveryMs) continue;
					await catchUp(connected);
					caughtUpAt = Date.now();
				}
				return "stopped";
			};
			for (let failures = 0; !signal.aborted; ) {
				const connected = await connect(credentials).catch((error: unknown) => void log("channel.connect_failed", { channel: "imessage", error: String(error) }));
				failures = connected ? 0 : failures + 1;
				const reason =
					connected &&
					(await supervise(connected).finally(() => {
						app = undefined;
						spaces.clear();
						return connected.stop();
					}));
				if (reason && !signal.aborted) log("imessage.rebuilt", { reason });
				await sleep(Math.min(link.rebuildDelayMs * 2 ** failures, 5 * 60_000), undefined, { signal }).catch(() => {});
			}
		},

		async send(bubble, person, options) {
			try {
				const target = await space(person);
				if (bubble.kind === "text") {
					const chunks = chunkText(bubble.text, TEXT_LIMIT);
					for (let index = 0; index < chunks.length; index++) {
						const replyTo = index === 0 ? options?.replyTo : undefined;
						if (replyTo === undefined) await target.send(chunks[index]!);
						else await target.sendReply(chunks[index]!, replyTo);
					}
				} else if (bubble.kind === "link") await target.sendLink(bubble.url);
				else await target.sendFile(bubble);
			} catch (error) {
				throw classifyIMessageError(error);
			}
		},

		async typing(on, person) {
			const target = await space(person);
			await (on ? target.startTyping() : target.stopTyping());
		},

		async react(messageId, reaction) {
			const previous = reactions.get(messageId);
			if (reaction === "none") {
				await previous?.unsend();
				reactions.delete(messageId);
				return;
			}
			const target = recent.get(messageId) ?? (await (await space()).getMessage(messageId));
			if (!target) throw new Error(`iMessage message ${messageId} not found`);
			await previous?.unsend();
			const handle = await target.react(reaction);
			if (handle) reactions.set(messageId, handle);
			else reactions.delete(messageId);
		},
	};
}
