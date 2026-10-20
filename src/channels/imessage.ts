import { setTimeout as sleep } from "node:timers/promises";
import type { Content, ContentInput } from "spectrum-ts";
import type { EffectName } from "./directives.ts";
import { log } from "../log.ts";
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
	type MessageRequest,
	type ReplyTarget,
	SendRejected,
	SendUnknown,
} from "./types.ts";

const TEXT_LIMIT = 4000;
const REMEMBERED_MESSAGES = 200;

const IMESSAGE_PROFILE: ChannelProfile = {
	id: "imessage",
	style:
		"imessage: short text. **bold**, *italic*, ~~strike~~ and - lists render natively; no tables or headings. Each blank-line-separated paragraph is its own bubble, so write one to three short ones. " +
		"A link alone on its line shows a link card. react sends a tapback. Lines: attach: <path> sends a file (work path or absolute under home). " +
		"voice: <path> sends a voice note. effect: <slam|loud|gentle|invisible|confetti|fireworks|lasers|heart|balloons|echo|sparkles|spotlight> animates the reply. " +
		"reply: <id> threads it. tools.message edits, unsends, polls.",
	maxBubbles: 3,
	maxBubbleChars: 400,
	paragraphsAreBubbles: true,
	typingMaxMs: 90_000,
};

const REMEMBERED_SENDS = 50;
const SENT_LIST = 5;
const SENT_PREVIEW_CHARS = 80;

interface ReactionHandle {
	unsend(): Promise<void>;
}

interface IMessageMessage {
	readonly id: string;
	readonly direction: "inbound" | "outbound";
	readonly sender: { readonly id: string } | undefined;
	readonly timestamp: Date;
	readonly content: Content;
	react(emoji: string): Promise<ReactionHandle | undefined>;
	/** Sends a read receipt. Only inbound messages can be marked read. */
	read?(): Promise<void>;
}

/** A message mochi sent, as the SDK returns it: the handle to edit or unsend it later. */
interface SentHandle {
	readonly id: string;
	edit(text: string): Promise<void>;
	unsend(): Promise<void>;
}

type FileToSend = { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array };

type ContactCard = { readonly name?: string; readonly phone?: string; readonly email?: string };

/** Each send resolves to the sent message, a SentHandle, where the SDK returns one. `replyTo` threads; a missing target sends plain. */
interface IMessageSpace {
	send(text: string): Promise<unknown>;
	/** A threaded reply to `targetMessageId`; a plain send when the target cannot be found. */
	sendReply(text: string, targetMessageId: string): Promise<unknown>;
	sendLink(url: string): Promise<unknown>;
	sendFile(file: FileToSend, replyTo?: string): Promise<unknown>;
	sendVoice?(file: FileToSend, replyTo?: string): Promise<unknown>;
	sendEffect?(text: string, effect: EffectName, replyTo?: string): Promise<unknown>;
	sendPoll?(title: string, options: readonly string[]): Promise<unknown>;
	/** No card: share mochi's own contact card. */
	sendContact?(card: ContactCard | undefined): Promise<unknown>;
	startTyping(): Promise<void>;
	stopTyping(): Promise<void>;
	getMessage(id: string): Promise<IMessageMessage | undefined>;
}

interface IMessageApp {
	readonly messages: AsyncIterable<readonly [IMessageSpace, IMessageMessage]>;
	dm(handle: string): Promise<IMessageSpace>;
	stop(): Promise<void>;
}

const LINK = { tickMs: 30_000, silentProbeMs: 5 * 60_000, failedProbesToRebuild: 2, rebuildDelayMs: 5_000 };

/** Silence alone never rebuilds, it only earns a probe. */
function judge(health: { readonly lastSignalAt: number; readonly failedProbes: number; readonly ended: boolean }, now: number): "none" | "probe" | "rebuild" {
	if (health.ended || health.failedProbes >= LINK.failedProbesToRebuild) return "rebuild";
	return now - health.lastSignalAt >= LINK.silentProbeMs ? "probe" : "none";
}

type Credentials = { readonly projectId: string; readonly projectSecret: string };


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
		case "poll_option":
			into.text.push(`[poll "${content.poll.title}": ${content.selected ? "voted" : "took back a vote for"} "${content.option.title}"]`);
			return;
		default:
			return;
	}
}

type ParsedIMessage = { readonly kind: "message"; readonly message: Inbound } | { readonly kind: "ignored"; readonly reason: "outbound" | "not-owner" | "empty" };

async function toInbound(message: IMessageMessage, owner: string, users: readonly string[]): Promise<ParsedIMessage> {
	if (message.direction === "outbound") return { kind: "ignored", reason: "outbound" };
	const sender = message.sender?.id === undefined ? "" : normalizeHandle(message.sender.id);
	if (sender === "" || (sender !== owner && !users.includes(sender))) return { kind: "ignored", reason: "not-owner" };
	const person = sender === owner ? {} : { person: sender };
	const content = message.content;
	if (content.type === "reaction") {
		const target = content.target;
		const onText = contentText(target.content);
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
		message: { kind: "message", channel: "imessage", messageId: message.id, text: collected.text.join("\n"), at: message.timestamp, attachments: collected.attachments, ...person, ...replyTo },
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
	const { Spectrum, attachment, contact, markdown, poll, reply, richlink, voice } = await import("spectrum-ts");
	const { effect, imessage, nativeContactCard } = await import("spectrum-ts/providers/imessage");
	// @ts-expect-error spectrum-ts 12.10.1 provider types do not resolve under exactOptionalPropertyTypes; runtime accepts an empty config.
	const app = await Spectrum({ ...credentials, providers: [imessage.config()], options: { logLevel: "error" } });
	const platform = imessage(app);
	const wrap = (space: Awaited<ReturnType<typeof platform.space.create>>): IMessageSpace => {
		const sendThreaded = async (content: ContentInput, targetMessageId: string | undefined) => {
			const target = targetMessageId === undefined ? undefined : await space.getMessage(targetMessageId).catch(() => undefined);
			if (target === undefined) return space.send(content);
			return space.send(reply(content, target));
		};
		// Markdown renders as native bold, italic and lists; text that renders to nothing goes plain.
		const styled = (text: string): ContentInput => (/[*_~`#\[]|^\s*[-+]\s/m.test(text) ? markdown(text) : text);
		const sendStyled = async (text: string, targetMessageId: string | undefined) => {
			try {
				return await sendThreaded(styled(text), targetMessageId);
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("renders to empty text")) throw error;
				return sendThreaded(text, targetMessageId);
			}
		};
		return {
		send: (text) => sendStyled(text, undefined),
		sendReply: (text, targetMessageId) => sendStyled(text, targetMessageId),
		sendLink: (url) => space.send(richlink(url)),
		sendFile: (file, replyTo) => sendThreaded(attachment(Buffer.from(file.bytes), { name: file.name, mimeType: file.mimeType }), replyTo),
		sendVoice: (file, replyTo) => sendThreaded(voice(Buffer.from(file.bytes), { name: file.name, mimeType: file.mimeType }), replyTo),
		sendEffect: (text, name, replyTo) => sendThreaded(effect(styled(text), imessage.effect.message[name]), replyTo),
		sendPoll: (title, options) => space.send(poll(title, [...options])),
		sendContact: (card) => {
			if (card === undefined) return space.send(nativeContactCard());
			const name = card.name === undefined ? {} : { name: { formatted: card.name } };
			const phones = card.phone === undefined ? {} : { phones: [{ value: card.phone }] };
			const emails = card.email === undefined ? {} : { emails: [{ value: card.email }] };
			return space.send(contact({ ...name, ...phones, ...emails }));
		},
		startTyping: () => space.startTyping(),
		stopTyping: () => space.stopTyping(),
		getMessage: (id) => space.getMessage(id) as Promise<IMessageMessage | undefined>,
		};
	};
	return {
		messages: (async function* () {
			for await (const [space, message] of app.messages) yield [wrap(space as Parameters<typeof wrap>[0]), message as unknown as IMessageMessage] as const;
		})(),
		dm: async (handle) => wrap(await platform.space.create(handle)),
		stop: () => app.stop(),
	};
}

type SentEntry = { readonly handle: SentHandle; readonly kind: "text" | "link" | "file" | "poll"; readonly text: string; readonly person: string };

function isSentHandle(value: unknown): value is SentHandle {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<SentHandle>;
	return typeof candidate.id === "string" && typeof candidate.edit === "function" && typeof candidate.unsend === "function";
}

/** `users`: normalized handles of the users who may write besides the owner. */
export function createIMessageChannel(env: Env, users: readonly string[]): Setup<Channel> {
	return channelSetup(env, ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET", "IMESSAGE_OWNER"], (values) => {
		const credentials = { projectId: values.PHOTON_PROJECT_ID, projectSecret: values.PHOTON_PROJECT_SECRET };
		return iMessageChannel(credentials, normalizeHandle(values.IMESSAGE_OWNER), users);
	});
}

function iMessageChannel(credentials: Credentials, owner: string, users: readonly string[]): Channel {
	let app: IMessageApp | undefined;
	const spaces = new Map<string, IMessageSpace>();
	const recent = new Map<string, IMessageMessage>();
	const reactions = new Map<string, ReactionHandle>();
	const sent = new Map<string, SentEntry>();
	let lastInbound: IMessageMessage | undefined;

	function remember(message: IMessageMessage): void {
		recent.set(message.id, message);
		if (recent.size > REMEMBERED_MESSAGES) recent.delete(recent.keys().next().value!);
	}

	function rememberSent(result: unknown, kind: SentEntry["kind"], text: string, person: string): void {
		if (!isSentHandle(result)) return;
		sent.set(result.id, { handle: result, kind, text, person });
		if (sent.size > REMEMBERED_SENDS) sent.delete(sent.keys().next().value!);
	}

	function sentTarget(messageId: string | undefined, kind?: SentEntry["kind"]): { id: string; entry: SentEntry } {
		const id = messageId ?? [...sent.entries()].findLast(([, entry]) => entry.person === owner && (kind === undefined || entry.kind === kind))?.[0];
		const entry = id === undefined ? undefined : sent.get(id);
		if (id === undefined || entry === undefined) {
			throw new Error(messageId === undefined ? "mochi has sent nothing on iMessage since it started." : `No message ${messageId} that mochi sent since it started. Use action sent to list them.`);
		}
		return { id, entry };
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

	async function runMessage(request: MessageRequest): Promise<string> {
		switch (request.action) {
			case "sent": {
				const mine = [...sent.entries()].filter(([, entry]) => entry.person === owner).slice(-SENT_LIST);
				if (mine.length === 0) return "mochi has sent nothing on iMessage since it started.";
				return mine.map(([id, entry]) => `${id}: ${entry.text.slice(0, SENT_PREVIEW_CHARS)}`).join("\n");
			}
			case "edit": {
				const target = sentTarget(request.messageId, "text");
				if (target.entry.kind !== "text") throw new Error(`iMessage can edit only text, and ${target.id} is a ${target.entry.kind}.`);
				await target.entry.handle.edit(request.text);
				sent.set(target.id, { ...target.entry, text: request.text });
				return `Edited ${target.id}.`;
			}
			case "unsend": {
				const target = sentTarget(request.messageId);
				if (target.entry.kind === "poll") throw new Error("iMessage polls cannot be unsent.");
				await target.entry.handle.unsend();
				sent.delete(target.id);
				return `Unsent ${target.id}.`;
			}
			case "poll": {
				const to = await space();
				if (to.sendPoll === undefined) throw new Error("This iMessage connection cannot send polls.");
				rememberSent(await to.sendPoll(request.title, request.options), "poll", `[poll ${request.title}]`, owner);
				return `Sent the poll "${request.title}". Votes arrive as owner messages.`;
			}
			case "contact": {
				const to = await space();
				if (to.sendContact === undefined) throw new Error("This iMessage connection cannot send contact cards.");
				const { action: _action, ...card } = request;
				const mine = card.name === undefined && card.phone === undefined && card.email === undefined;
				await to.sendContact(mine ? undefined : card);
				return mine ? "Shared mochi's own contact card." : "Sent the contact card.";
			}
			case "read": {
				if (lastInbound?.read === undefined) throw new Error("The owner has not written on iMessage since mochi started.");
				await lastInbound.read();
				return "Marked the owner's chat read.";
			}
		}
	}

	return {
		profile: IMESSAGE_PROFILE,

		async run(sink, signal) {
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
					if (parsed.message.person === undefined && message.read !== undefined) lastInbound = message;
					if (parsed.message.kind === "message") message.read?.().catch(() => {});
					await sink(parsed.message);
				} catch (error) {
					log("channel.handler_failed", { channel: "imessage", error: String(error) });
				}
			};
			const supervise = async (connected: IMessageApp) => {
				app = connected;
				const health = { lastSignalAt: Date.now(), failedProbes: 0, ended: false };
				void (async () => {
					for await (const [from, message] of connected.messages) {
						health.lastSignalAt = Date.now();
						await handle(from, message);
					}
				})()
					.catch((error: unknown) => log("channel.stream_failed", { channel: "imessage", error: String(error) }))
					.finally(() => (health.ended = true));
				while (!signal.aborted) {
					await sleep(LINK.tickMs, undefined, { signal }).catch(() => {});
					const action = signal.aborted ? "none" : judge(health, Date.now());
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
				}
				return "stopped";
			};
			for (let failures = 0; !signal.aborted; ) {
				const connected = await connectPhoton(credentials).catch((error: unknown) => void log("channel.connect_failed", { channel: "imessage", error: String(error) }));
				failures = connected ? 0 : failures + 1;
				const reason =
					connected &&
					(await supervise(connected).finally(() => {
						app = undefined;
						spaces.clear();
						return connected.stop();
					}));
				if (reason && !signal.aborted) log("imessage.rebuilt", { reason });
				await sleep(Math.min(LINK.rebuildDelayMs * 2 ** failures, 5 * 60_000), undefined, { signal }).catch(() => {});
			}
		},

		async send(bubble, person, options) {
			const to = person ?? owner;
			try {
				const target = await space(person);
				if (bubble.kind === "text") {
					const chunks = chunkText(bubble.text, TEXT_LIMIT);
					for (let index = 0; index < chunks.length; index++) {
						const chunk = chunks[index]!;
						const replyTo = index === 0 ? options?.replyTo : undefined;
						const effect = index === 0 ? bubble.effect : undefined;
						let result: unknown;
						if (effect !== undefined && target.sendEffect !== undefined) result = await target.sendEffect(chunk, effect, replyTo);
						else if (replyTo === undefined) result = await target.send(chunk);
						else result = await target.sendReply(chunk, replyTo);
						rememberSent(result, "text", chunk, to);
					}
				} else if (bubble.kind === "link") {
					rememberSent(await target.sendLink(bubble.url), "link", bubble.url, to);
				} else if (bubble.voice === true && bubble.mimeType.startsWith("audio/") && target.sendVoice !== undefined) {
					rememberSent(await target.sendVoice(bubble, options?.replyTo), "file", `[voice ${bubble.name}]`, to);
				} else {
					rememberSent(await target.sendFile(bubble, options?.replyTo), "file", `[file ${bubble.name}]`, to);
				}
			} catch (error) {
				throw classifyIMessageError(error);
			}
		},

		async message(request) {
			return runMessage(request);
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
