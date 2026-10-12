import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	defineDoc,
	defineDocFamily,
	defineTask,
	defineTool,
	type EntryId,
	type ToolRegistration,
	type Harness,
	type NextTaskState,
	ROOT_CONVERSATION_ID,
	type SubmissionId,
	type Task,
	type TaskId,
	type ToolExecutionApi,
	type Tx,
	type UserInput,
} from "@earendil-works/pi-durable";
import { pace, present } from "../channels/present.ts";
import {
	type Attachment,
	type Channel,
	ChannelDown,
	type ChannelId,
	type Channels,
	type ChatChannelId,
	DeliveryError,
	type Inbound,
	REACTIONS,
	type ReplyTarget,
	SendRejected,
	SendUnknown,
} from "../channels/types.ts";
import { type ChatUser, OWNER_ID } from "../config.ts";
import type { Log } from "../log.ts";
import { clip, formatStamp, messageText } from "../text.ts";
import { createSeatConversation } from "../seats.ts";
import { loadAttachment, type MediaDeps, prepareInbound, splitAttachments } from "../media/media.ts";
import { type CommandInput, type CommandReply, type CommandTurn, commandOf } from "./commands.ts";

// A Turn is one thing owed to the owner, and the only place that holds delivery state. Every Turn is a background task
// of the line conversation, which nothing owns, so neither Esc nor /stop on root reaches it.
//
//   owner wrote  run (submit to root, wait) -> claim -> send
//   a run wrote  claim -> send -> record (one passive line in root); to `cli`, record only
//
// The claim commit takes `<answer>:<channel>` in ClaimDoc (the first claimer sends) and appends the Turn to its
// channel's chain in ChannelTailDoc; `send` waits for the previous tail to finish, so messages never interleave.

export const requestKey = (channel: ChannelId, messageId: string): string => `${channel}:${messageId}`;

/** Who wrote text that goes to the owner unprompted. */
export type Origin = { readonly kind: "trigger"; readonly id: string } | { readonly kind: "conversation"; readonly id: ConversationId };

/** An inbound attachment saved under `<workDir>/inbox/<messageId>/`; `path` is relative to the work directory. */
export interface SavedFile {
	readonly path: string;
	readonly mimeType: string;
	readonly kind: Attachment["kind"];
	readonly bytes: number;
}

export type ChatTurn = {
	readonly source: "chat";
	readonly channel: ChatChannelId;
	readonly key: string;
	readonly tag: string;
	readonly text: string;
	readonly files: readonly SavedFile[];
	/** Images and transcripts prepared once at ingest, so a rerun of `run` never transcribes again. */
	readonly preparedMedia?: Awaited<ReturnType<typeof prepareInbound>>;
	/** A user's own conversation. Absent: root. */
	readonly conversation?: ConversationId;
	/** The user's normalized handle, where the reply goes. Absent: the owner. */
	readonly person?: string;
	/** The message this one replies to, shown to the model. */
	readonly replyTo?: ReplyTarget;
	/** The inbound message id. The first text bubble of the answer is a threaded reply to it. */
	readonly threadOn?: string;
};
export type RunTurn = {
	readonly source: "run";
	readonly channel: ChannelId;
	readonly text: string;
	readonly from: Origin;
	/** A configured user's normalized handle, on imessage. Absent: the owner. */
	readonly person?: string;
};
export type TurnInput = ChatTurn | RunTurn | CommandTurn;

/** What `send` sends. `input` is a notify's own text, read from the task input, not copied. */
export type Answer =
	| { readonly kind: "entry"; readonly entry: EntryId }
	| { readonly kind: "failure"; readonly submission: SubmissionId; readonly reason: string }
	| { readonly kind: "input" };

/** `downMs` adds up the scheduled back-off only, so a daemon stopped for hours does not count the stop as outage. */
export type Outage = { readonly retryAt: number; readonly attempt: number; readonly downMs: number };

export type TurnState =
	| { readonly phase: "run" }
	| { readonly phase: "claim"; readonly channel: ChatChannelId; readonly answer: Answer }
	| {
			readonly phase: "send";
			readonly channel: ChatChannelId;
			readonly answer: Answer;
			/** The previous Turn of this channel's chain, awaited before the first bubble. */
			readonly after: TaskId | null;
			readonly sent: number;
			readonly outage: Outage | null;
	  }
	| { readonly phase: "record" };

export type TurnResult = "sent" | "silent" | "merged";
export type TurnTask = Task<TurnInput, TurnState, TurnResult, object>;

export type Retry = { readonly firstMs: number; readonly maxMs: number; readonly giveUpMs: number };
/** 5 s doubling to 5 min; give up after an hour of back-off. */
export const RETRY: Retry = { firstMs: 5_000, maxMs: 5 * 60_000, giveUpMs: 60 * 60_000 };

const delayOf = (retry: Retry, attempt: number): number => Math.min(retry.firstMs * 2 ** (attempt - 1), retry.maxMs);

export function nextOutage(outage: Outage | null, now: number, retry: Retry = RETRY): Outage | "give-up" {
	if (outage === null) return { retryAt: now + retry.firstMs, attempt: 1, downMs: 0 };
	const downMs = outage.downMs + delayOf(retry, outage.attempt);
	if (downMs >= retry.giveUpMs) return "give-up";
	const attempt = outage.attempt + 1;
	return { retryAt: now + delayOf(retry, attempt), attempt, downMs };
}

const taskFamily = (kind: string) => defineDocFamily<{ task: TaskId | null }, null>({ kind, version: 1, scope: "session", family: true, initial: () => ({ task: null }) });
/** Who sends one answer on one channel. Written only by the claim commit. */
export const ClaimDoc = taskFamily("mochi.claim");
/** The newest Turn that joined each channel's delivery chain. Written only by the claim commit. */
export const ChannelTailDoc = taskFamily("mochi.channel-tail");

/** Highest handled inbound event sequence per channel. One writer: `ingest`. */
export const InboundCursorDoc = defineDocFamily<{ sequence: number | null }, null>({
	kind: "mochi.inbound-cursor",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ sequence: null }),
});

/** The owner's newest chat message: notify's default channel and react's default target. One writer: `ingest`. */
export const LastInboundDoc = defineDoc<{ last: { channel: ChatChannelId; messageId: string } | null }>({
	kind: "mochi.last-inbound",
	version: 2,
	scope: "session",
	initial: () => ({ last: null }),
	migrate: (value) => {
		const route = (value as { route?: { channel?: string; messageId?: string } | null }).route;
		const chat = route?.channel !== undefined && route.channel !== "cli" && route.messageId !== undefined;
		return { last: chat ? { channel: route.channel as ChatChannelId, messageId: route.messageId! } : null };
	},
});

/** The ownerless conversation that holds every Turn. One writer: `ensureLine`. */
export const LineDoc = defineDoc<{ conversation: ConversationId | null }>({
	kind: "mochi.line",
	version: 1,
	scope: "session",
	initial: () => ({ conversation: null }),
});

/** Each user's own conversation, keyed by normalized handle. One writer: `ensureUser`. */
export const UserDoc = defineDocFamily<{ conversation: ConversationId | null }, null>({
	kind: "mochi.user",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ conversation: null }),
});

export function userInstructions(user: ChatUser): string {
	const about = user.name === undefined ? `iMessage ${user.handle}` : `${user.name}, iMessage ${user.handle}`;
	const lines = [
		`This conversation is with ${user.id} (${about}). They are a friend of the owner (${OWNER_ID}), not the owner. ` +
			"Here their messages instruct you. 'The owner' in other sections still means the owner. " +
			"Help them fully, in plain chat style. You cannot reach the owner's apps or accounts from this conversation.",
	];
	if (user.persona !== undefined) lines.push(user.persona);
	return lines.join("\n\n");
}

/** Inside ingest's commit: the user's conversation, created on their first message with root's model and thinking. */
export async function ensureUser(tx: Tx, user: ChatUser): Promise<ConversationId> {
	const doc = await tx.doc(UserDoc, user.handle, null);
	if (doc.conversation === null) doc.conversation = await createSeatConversation(tx, "user", { kind: "ownerless" }, { instructions: userInstructions(user) });
	return doc.conversation;
}

export async function ensureLine(harness: Harness, context: Context): Promise<ConversationId> {
	return harness.commit(async (tx) => {
		const line = await tx.doc(LineDoc);
		if (line.conversation === null) line.conversation = await createSeatConversation(tx, "worker", { kind: "ownerless" });
		return line.conversation;
	}, context);
}

/** Everything `ingest`, `notify` and the upgrade need to open Turns. */
export interface Line {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly id: ConversationId;
	readonly turn: TurnTask;
	readonly channels: Channels;
	readonly timeZone: string;
	readonly workDir: string;
	readonly media: Omit<MediaDeps, "workDir">;
	/** Users who may write on iMessage, each in a conversation of their own. */
	readonly users: readonly ChatUser[];
	/** Runs a command (`/new`, `/stop`, `/status`) instead of a model turn. */
	readonly command?: (input: CommandInput, context: Context) => Promise<CommandReply>;
	/** Resets a stale conversation before a message to it; true when it reset. */
	readonly idleReset?: (conversation: Conversation, key: string, context: Context) => Promise<boolean>;
}

/** What the Turn task needs from the host, captured once. */
export interface TurnHost {
	/** The host root Conversation: the record is a passive write, which a task's conversation handle cannot submit. */
	readonly root: Conversation;
	/** Opens a user's conversation for a notify record, for the same reason. */
	readonly harness: Harness;
	readonly users: readonly ChatUser[];
	/** Channels running in this process. An absent one is ChannelDown. */
	readonly channels: Channels;
	readonly workDir: string;
	readonly media: Omit<MediaDeps, "workDir">;
	readonly retry: Retry;
	readonly log: Log;
}

export const NOTIFY_ENTRY = "app.notify";
export const DELIVERED_RECORD_CHARS = 280;

/** The one passive line a notify leaves in the recipient's conversation, framed as context so it is not answered. */
export function deliveredRecord(input: RunTurn, recipient: string): string {
	const from = input.from.kind === "trigger" ? `trigger ${input.from.id}` : `conversation ${input.from.id}`;
	const where = input.channel === "cli" ? "in the terminal" : `on ${input.channel}`;
	return `[context, no reply needed: told ${recipient} ${where}, from ${from}] ${clip(input.text, DELIVERED_RECORD_CHARS)}`;
}

/** A conversation's input for a chat Turn, and the only builder of it, so ingest and `run` submit identical content. */
async function inputOf(workDir: string, turn: ChatTurn, media: Omit<MediaDeps, "workDir">, signal?: AbortSignal): Promise<UserInput> {
	const { notes, images } = turn.preparedMedia ?? (await prepareInbound(turn.files, workDir, media, signal));
	const lines = [turn.tag];
	if (turn.replyTo !== undefined) lines.push(replyLine(turn.replyTo));
	const text = [...lines, turn.text, ...notes].join("\n");
	return images.length === 0 ? text : [{ type: "text", text }, ...images];
}

const REPLY_TEXT_CHARS = 80;

function replyLine(target: ReplyTarget): string {
	const whose = target.fromAgent ? "your" : "their";
	const text = target.text === "" ? "(text not available; use recall)" : clip(target.text, REPLY_TEXT_CHARS);
	return `[replying to ${whose} message id=${target.messageId}] ${text}`;
}

async function saveFiles(workDir: string, message: Extract<Inbound, { kind: "message" }>): Promise<SavedFile[]> {
	if (message.attachments.length === 0) return [];
	const dir = join("inbox", message.messageId.replace(/[^A-Za-z0-9._-]/g, "_"));
	await mkdir(join(workDir, dir), { recursive: true });
	return Promise.all(
		message.attachments.map(async (attachment, index) => {
			const extension = attachment.mimeType.split("/")[1]?.split(/[;+]/)[0]?.replace(/[^A-Za-z0-9.-]/g, "") || "bin";
			const path = join(dir, `${index + 1}.${extension}`);
			await writeFile(join(workDir, path), attachment.bytes);
			return { path, mimeType: attachment.mimeType, kind: attachment.kind, bytes: attachment.bytes.length };
		}),
	);
}

/** The text of an answer entry, or "" when there is none. */
export async function answerText(tx: Tx, entry: EntryId): Promise<string> {
	const message = (await tx.entry(AssistantEntry, entry))?.model?.[0];
	return message === undefined ? "" : messageText(message).trim();
}

const TYPING_REFRESH_MS = 5_000;

/** Typing on, refreshed until the profile's cap; errors are swallowed. Returns the stop. */
function keepTyping(channel: Channel | undefined, person: string | undefined): () => Promise<void> {
	if (channel === undefined) return async () => {};
	const typing = (on: boolean) => channel.typing(on, person).catch(() => {});
	const until = Date.now() + channel.profile.typingMaxMs;
	void typing(true);
	const timer = setInterval(() => {
		if (Date.now() < until) return void typing(true);
		clearInterval(timer);
		void typing(false);
	}, TYPING_REFRESH_MS);
	return async () => {
		clearInterval(timer);
		await typing(false);
	};
}

/** Who a Turn's bubbles go to. Absent: the owner. */
const personOf = (input: TurnInput): string | undefined => input.person;

/** A user's replies chain apart from the owner's, so one never waits behind the other. */
const tailKey = (channel: ChatChannelId, person: string | undefined): string => (person === undefined ? channel : `${channel}:${person}`);

const running = (checkpoint: TurnState): NextTaskState<TurnState, TurnResult> => ({ status: "running", checkpoint });
const completed = (result: TurnResult): NextTaskState<TurnState, TurnResult> => ({ status: "terminal", outcome: { status: "completed", result } });

function claimKey(answer: Answer, task: TaskId, channel: ChatChannelId): string {
	switch (answer.kind) {
		case "entry":
			return `${answer.entry}:${channel}`;
		case "failure":
			return `submission-${answer.submission}:${channel}`;
		case "input":
			return `task-${task}:${channel}`;
	}
}

export function defineTurn(host: TurnHost): TurnTask {
	const { root, harness, users, channels, workDir, media, retry, log } = host;
	return defineTask<TurnInput, TurnState, TurnResult>({
		name: "mochi.turn",
		version: 2,
		migrate: (input, checkpoint) => {
			const turn = input as { source: string };
			const source = turn.source === "owner" ? "chat" : turn.source;
			return { input: { ...turn, source } as TurnInput, checkpoint: checkpoint as TurnState };
		},
		initial: (input) => {
			if (input.source === "chat") return { phase: "run" };
			return input.channel === "cli" ? { phase: "record" } : { phase: "claim", channel: input.channel, answer: { kind: "input" } };
		},
		phases: {
			run: async (task, runtime, context) => {
				const input = task.input;
				if (input.source !== "chat") throw new Error("Only a chat Turn runs a conversation.");
				const stopTyping = keepTyping(channels.get(input.channel), input.person);
				let settled;
				try {
					const conversation = (await runtime.conversation(input.conversation ?? ROOT_CONVERSATION_ID, context))!;
					const content = await inputOf(workDir, input, media, context.abortSignal);
					settled = await (await conversation.submit({ type: "input", content, requestId: input.key, whenBusy: "steer" }, context)).wait(context);
				} finally {
					await stopTyping();
				}
				const channel = input.channel;
				await runtime.commit(() => {
					if (settled.status === "done") return settled.type === "input" ? running({ phase: "claim", channel, answer: { kind: "entry", entry: settled.answer } }) : completed("silent");
					if (settled.reason === "aborted") return completed("silent");
					return running({ phase: "claim", channel, answer: { kind: "failure", submission: settled.id, reason: settled.reason } });
				}, context);
			},
			claim: async (task, runtime, context) => {
				const { channel, answer } = task.state.checkpoint;
				await runtime.commit(async (tx) => {
					const claim = await tx.doc(ClaimDoc, claimKey(answer, task.id, channel), null);
					if (claim.task !== null && claim.task !== task.id) return completed("merged");
					claim.task = task.id;
					const tail = await tx.doc(ChannelTailDoc, tailKey(channel, personOf(task.input)), null);
					const previous = tail.task;
					tail.task = task.id;
					const live = previous !== null && previous !== task.id && (await tx.task(previous))?.state.status !== "terminal";
					return running({ phase: "send", channel, answer, after: live ? previous : null, sent: 0, outage: null });
				}, context);
			},
			send: async (task, runtime, context) => {
				const state = task.state.checkpoint;
				const { channel: id, answer } = state;
				const person = personOf(task.input);
				let { sent, outage } = state;
				if (state.after !== null) await runtime.waitForTask(state.after, context);
				let text = "";
				if (answer.kind === "failure") text = `Sorry, I couldn't answer that (${answer.reason}).`;
				else if (answer.kind === "input") text = task.input.text;
				else await runtime.commit(async (tx) => void (text = await answerText(tx, answer.entry)), context);
				const finished = task.input.source === "run" ? running({ phase: "record" }) : completed("sent");
				const outgoing = splitAttachments(text);
				let retried = false;
				for (;;) {
					const channel = channels.get(id);
					// Attachment bubbles are placeholders until their turn to send, so a file read never shifts `sent` indexes.
					const bubbles =
						channel === undefined
							? undefined
							: [
									...present(outgoing.text, channel.profile),
									...outgoing.attachments.map((path) => ({ kind: "file" as const, name: path, mimeType: "application/octet-stream", bytes: new Uint8Array() })),
								];
					if (bubbles?.length === 0) return runtime.commit(() => completed("silent"), context);
					if (bubbles !== undefined && sent >= bubbles.length) return runtime.commit(() => finished, context);
					const bubble = bubbles?.[sent];
					if (channel !== undefined && bubble !== undefined && sent > 0) {
						void channel.typing(true, person).catch(() => {});
						await runtime.sleep(runtime.now() + pace(bubble), context);
					}
					try {
						if (channel === undefined || bubble === undefined) throw new ChannelDown(`${id} is not running in this process`);
						let outgoingBubble = bubble;
						if (bubble.kind === "file") {
							try {
								outgoingBubble = await loadAttachment(bubble.name, workDir);
							} catch {
								throw new SendRejected(`The attachment ${bubble.name} could not be read inside the work directory.`);
							}
						}
						const threadOn = task.input.source === "chat" ? task.input.threadOn : undefined;
						if (sent === 0 && outgoingBubble.kind === "text" && threadOn !== undefined) await channel.send(outgoingBubble, person, { replyTo: threadOn });
						else await channel.send(outgoingBubble, person);
					} catch (error) {
						if (!(error instanceof DeliveryError)) {
							log("turn.faulted", { task: task.id, answer, error: String(error) });
							throw error;
						}
						if (error instanceof SendUnknown && !retried) {
							retried = true;
							log("turn.send_unknown", { task: task.id, channel: id, bubble: sent });
							continue;
						}
						if (error instanceof SendRejected) {
							log("turn.rejected", { task: task.id, channel: id, bubble: sent, error: error.message });
						} else {
							const next = nextOutage(outage, runtime.now(), retry);
							if (next === "give-up") {
								log("turn.undelivered", { task: task.id, channel: id, answer, sent });
								return runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: `${id} stayed down` } } }), context);
							}
							outage = next;
							await runtime.commit(() => running({ ...state, sent, outage }), context);
							await runtime.sleep(next.retryAt, context);
							continue;
						}
					}
					sent++;
					outage = null;
					retried = false;
					await runtime.commit(() => running({ ...state, sent, outage }), context);
				}
			},
			record: async (task, runtime, context) => {
				const input = task.input;
				if (input.source !== "run") throw new Error("Only a notify Turn records.");
				let target = root;
				let recipient = OWNER_ID;
				if (input.person !== undefined) {
					const user = userOf(users, input.person);
					const id = await harness.commit((tx) => ensureUser(tx, user), context);
					const found = await harness.conversation(id, context);
					if (found === undefined) throw new Error(`Conversation ${id} is missing.`);
					target = found;
					recipient = user.id;
				}
				const model = [{ role: "user" as const, content: deliveredRecord(input, recipient), timestamp: Date.now() }];
				await target.submit({ type: "write", requestId: `record:${task.id}`, entry: { kind: NOTIFY_ENTRY, data: { channel: input.channel, text: input.text }, model } }, context);
				await runtime.commit(() => completed("sent"), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

/** Inside one commit. Not idempotent by itself: ingest dedupes by request id, notify with the Journal. */
export function openTurn(tx: Tx, line: Pick<Line, "id" | "turn">, input: TurnInput): Promise<TaskId<TurnResult>> {
	return tx.createTask(line.turn, input, { ownership: { kind: "conversation" }, conversationId: line.id, background: true });
}

/** A line typed in an attached terminal. Nothing is delivered for it: terminals render the transcript. */
export type CliInbound = { readonly kind: "cli"; readonly messageId: string; readonly text: string; readonly at: Date };

const tagOf = (channel: ChannelId, messageId: string, at: Date, timeZone: string) => `[${channel} ${formatStamp(at, timeZone)} id=${messageId}]`;

/**
 * The one entry for owner input. A chat message opens its Turn in the commit that finds no submission for its request
 * key, then submits itself, so arrival order is root's order. A tapback is a passive write.
 */
export async function ingest(line: Line, inbound: Inbound | CliInbound, context: Context): Promise<SubmissionId> {
	const { root, harness } = line;
	switch (inbound.kind) {
		case "cli": {
			const content = `${tagOf("cli", inbound.messageId, inbound.at, line.timeZone)}\n${inbound.text}`;
			return (await root.submit({ type: "input", content, requestId: requestKey("cli", inbound.messageId), whenBusy: "steer" }, context)).id;
		}
		case "tapback": {
			const user = inbound.person === undefined ? undefined : userOf(line.users, inbound.person);
			const who = user === undefined ? OWNER_ID : user.id;
			const whose = inbound.fromAgent ? "your" : "their";
			const quoted = inbound.onText === "" ? "" : `: "${inbound.onText}"`;
			const model = [{ role: "user" as const, content: `[context, no reply needed: ${who} reacted ${inbound.emoji} to ${whose} message id=${inbound.on}${quoted}]`, timestamp: inbound.at.getTime() }];
			const id = user === undefined ? ROOT_CONVERSATION_ID : await harness.commit((tx) => ensureUser(tx, user), context);
			const target = await conversationOf(line, id, context);
			return (await target.submit({ type: "write", requestId: requestKey(inbound.channel, inbound.messageId), entry: { kind: "mochi.tapback", model } }, context)).id;
		}
		case "message": {
			const key = requestKey(inbound.channel, inbound.messageId);
			const user = inbound.person === undefined ? undefined : userOf(line.users, inbound.person);
			// Only the owner's messages move notify's default channel and react's default target.
			const recordInbound = async (tx: Tx) => {
				if (user === undefined) (await tx.doc(LastInboundDoc)).last = { channel: inbound.channel, messageId: inbound.messageId };
				if (inbound.sequence !== undefined) {
					const cursor = await tx.doc(InboundCursorDoc, inbound.channel, null);
					cursor.sequence = Math.max(cursor.sequence ?? inbound.sequence, inbound.sequence);
				}
			};
			const command = inbound.attachments.length === 0 ? commandOf(inbound.text) : undefined;
			if (command !== undefined && line.command !== undefined) {
				const conversation = await harness.commit(async (tx) => {
					await recordInbound(tx);
					return user === undefined ? undefined : ensureUser(tx, user);
				}, context);
				const forUser = user === undefined || conversation === undefined ? {} : { conversation, person: user.handle };
				return (await line.command({ key, command, channel: inbound.channel, ...forUser }, context)).submission;
			}
			const known = user === undefined ? ROOT_CONVERSATION_ID : ((await harness.snapshot(UserDoc, user.handle, context))?.conversation ?? null);
			if (known !== null) {
				const prior = await harness.commit((tx) => tx.submissionByRequest(known, key), context);
				if (prior !== undefined) return prior.id;
				// Before the Turn opens: its run phase can submit at once, and a stale thread must not be resent.
				if (line.idleReset !== undefined) await line.idleReset(await conversationOf(line, known, context), key, context);
			}
			const tag = tagOf(inbound.channel, inbound.messageId, inbound.at, line.timeZone);
			const files = await saveFiles(line.workDir, inbound);
			const preparedMedia = files.length === 0 ? undefined : await prepareInbound(files, line.workDir, line.media, context.abortSignal);
			const thread = inbound.replyTo === undefined ? {} : { replyTo: inbound.replyTo, threadOn: inbound.messageId };
			const turn: ChatTurn = { source: "chat", channel: inbound.channel, key, tag, text: inbound.text, files, ...(preparedMedia === undefined ? {} : { preparedMedia }), ...thread };
			const opened = await harness.commit(async (tx) => {
				const known = user === undefined ? ROOT_CONVERSATION_ID : (await tx.doc(UserDoc, user.handle, null)).conversation;
				if (known !== null) {
					const submission = await tx.submissionByRequest(known, key);
					if (submission !== undefined) return { kind: "existing" as const, submission: submission.id };
				}
				const conversation = known ?? (await ensureUser(tx, user!));
				await openTurn(tx, line, user === undefined ? turn : { ...turn, conversation, person: user.handle });
				await recordInbound(tx);
				return { kind: "opened" as const, conversation };
			}, context);
			if (opened.kind === "existing") return opened.submission;
			const target = await conversationOf(line, opened.conversation, context);
			const content = await inputOf(line.workDir, turn, line.media, context.abortSignal);
			return (await target.submit({ type: "input", content, requestId: key, whenBusy: "steer" }, context)).id;
		}
	}
}

function userOf(users: readonly ChatUser[], person: string): ChatUser {
	for (const user of users) if (user.handle === person) return user;
	throw new Error(`No user ${person} is configured.`);
}

async function conversationOf(line: Line, id: ConversationId, context: Context): Promise<Conversation> {
	if (id === ROOT_CONVERSATION_ID) return line.root;
	const conversation = await line.harness.conversation(id, context);
	if (conversation === undefined) throw new Error(`Conversation ${id} is missing.`);
	return conversation;
}

/** `react` on the owner's chat messages. Only the owner seat's scripts get it. */
export function reactTool(channels: Channels): ToolRegistration {
	return defineTool({
				name: "react",
				description:
					"React to an owner message with a tapback. none removes it. messageId is the id= in the message tag; the default is the owner's newest message. " +
					"Use it to acknowledge a long job, or when a reaction says everything.",
				parameters: Type.Object({
					reaction: Type.Union([...REACTIONS, "none"].map((reaction) => Type.Literal(reaction))),
					messageId: Type.Optional(Type.String({ minLength: 1 })),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const target = args.messageId === undefined ? (await api.snapshot(LastInboundDoc, context))?.last : await ownerMessage(api, channels, args.messageId, context);
					if (target == null) {
						throw new Error(args.messageId === undefined ? "The owner has not written on a chat channel yet, so there is nothing to react to." : `No owner message with id ${args.messageId}.`);
					}
					const channel = channels.get(target.channel);
					if (channel === undefined) throw new Error(`Channel ${target.channel} is not running.`);
					if (channel.react === undefined) throw new Error(`The ${target.channel} channel does not support reactions.`);
					await channel.react(target.messageId, args.reaction);
					const done = args.reaction === "none" ? "Removed the reaction" : `Reacted ${args.reaction}`;
					return { output: [{ type: "text", text: `${done} on ${target.channel} message ${target.messageId}.` }] };
				},
	});
}

async function ownerMessage(api: ToolExecutionApi, channels: Channels, messageId: string, context: Context): Promise<{ channel: ChatChannelId; messageId: string } | undefined> {
	for (const channel of channels.keys()) {
		const found = await api.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, requestKey(channel, messageId)), context);
		if (found !== undefined) return { channel, messageId };
	}
	return undefined;
}
