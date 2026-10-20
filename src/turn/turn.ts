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
import { blocks, present } from "../channels/present.ts";
import { type Committer, holdText } from "../context.ts";
import {
	type Attachment,
	type Bubble,
	type Channel,
	ChannelDown,
	type ChannelId,
	type Channels,
	type ChatChannelId,
	DeliveryError,
	type Inbound,
	type ReplyTarget,
	SendRejected,
	SendUnknown,
} from "../channels/types.ts";
import { type ChatUser, OWNER_ID } from "../config.ts";
import type { Log } from "../log.ts";
import { formatStamp, messageText } from "../text.ts";
import { createSeatConversation } from "../seats.ts";
import type { MediaDeps } from "../media/client.ts";
import { loadOutgoing } from "../media/files.ts";
import { prepareInbound } from "../media/inbound.ts";
import { splitDirectives, withEffect } from "../channels/directives.ts";
import { type CommandInput, type CommandReply, type CommandTurn, commandOf } from "./commands.ts";
import { keyedReset } from "./lifecycle.ts";
import { streamParagraphs } from "./stream.ts";

// A Turn is a background task of the ownerless line conversation, so neither Esc nor /stop on root reaches it.
// The claim commit takes `<answer>:<channel>` in ClaimDoc (the first claimer sends) and appends the Turn to its
// channel's chain in ChannelTailDoc; `send` waits for the previous tail to finish, so messages never interleave.

const requestKey = (channel: ChannelId, messageId: string): string => `${channel}:${messageId}`;

type Origin = { readonly kind: "trigger"; readonly id: string } | { readonly kind: "conversation"; readonly id: ConversationId };

export interface SavedFile {
	readonly path: string;
	readonly mimeType: string;
	readonly kind: Attachment["kind"];
	readonly bytes: number;
}

type ChatTurn = {
	readonly source: "chat";
	readonly channel: ChatChannelId;
	readonly key: string;
	readonly tag: string;
	readonly text: string;
	readonly files: readonly SavedFile[];
	readonly preparedMedia?: Awaited<ReturnType<typeof prepareInbound>>;
	readonly conversation?: ConversationId;
	readonly person?: string;
	readonly replyTo?: ReplyTarget;
	readonly threadOn?: string;
};
export type RunTurn = {
	readonly source: "run";
	readonly channel: ChannelId;
	readonly text: string;
	readonly from: Origin;
	readonly person?: string;
};
type TurnInput = ChatTurn | RunTurn | CommandTurn;

type Answer =
	| { readonly kind: "entry"; readonly entry: EntryId }
	| { readonly kind: "failure"; readonly submission: SubmissionId; readonly reason: string }
	| { readonly kind: "input" };

// `downMs` adds up the scheduled back-off only, so a daemon stopped for hours does not count the stop as outage.
type Outage = { readonly retryAt: number; readonly attempt: number; readonly downMs: number };

type TurnState =
	| { readonly phase: "run"; readonly streamed?: readonly string[]; readonly run?: string }
	| { readonly phase: "claim"; readonly channel: ChatChannelId; readonly answer: Answer; readonly streamed?: readonly string[]; readonly run?: string }
	| {
			readonly phase: "send";
			readonly channel: ChatChannelId;
			readonly answer: Answer;
			/** Paragraphs already sent while the answer was written; the final send skips them. */
			readonly streamed?: readonly string[];
			readonly after: TaskId | null;
			readonly sent: number;
			readonly outage: Outage | null;
	  }
	| { readonly phase: "record" };

type TurnResult = "sent" | "silent" | "merged";
type TurnTask = Task<TurnInput, TurnState, TurnResult, object>;

const RETRY = { firstMs: 5_000, maxMs: 5 * 60_000, giveUpMs: 60 * 60_000 };

const delayOf = (attempt: number): number => Math.min(RETRY.firstMs * 2 ** (attempt - 1), RETRY.maxMs);

function nextOutage(outage: Outage | null, now: number): Outage | "give-up" {
	if (outage === null) return { retryAt: now + RETRY.firstMs, attempt: 1, downMs: 0 };
	const downMs = outage.downMs + delayOf(outage.attempt);
	if (downMs >= RETRY.giveUpMs) return "give-up";
	const attempt = outage.attempt + 1;
	return { retryAt: now + delayOf(attempt), attempt, downMs };
}

const taskFamily = (kind: string) => defineDocFamily<{ task: TaskId | null }, null>({ kind, version: 1, scope: "session", family: true, initial: () => ({ task: null }) });
const ClaimDoc = taskFamily("mochi.claim");
const ChannelTailDoc = taskFamily("mochi.channel-tail");
/** The one Turn that streams a root run, by the run's task id; the other Turns in that run send nothing. */
const StreamOwnerDoc = taskFamily("mochi.stream-owner");

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

const LineDoc = defineDoc<{ conversation: ConversationId | null }>({
	kind: "mochi.line",
	version: 1,
	scope: "session",
	initial: () => ({ conversation: null }),
});

const UserDoc = defineDocFamily<{ conversation: ConversationId | null }, null>({
	kind: "mochi.user",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ conversation: null }),
});

function userInstructions(user: ChatUser): string {
	const about = user.name === undefined ? `iMessage ${user.handle}` : `${user.name}, iMessage ${user.handle}`;
	const lines = [
		`This conversation is with ${user.id} (${about}). They are a friend of the owner (${OWNER_ID}), not the owner. ` +
			"Here their messages instruct you. 'The owner' in other sections still means the owner. " +
			"Help them fully, in plain chat style. You cannot reach the owner's apps or accounts from this conversation.",
	];
	if (user.persona !== undefined) lines.push(user.persona);
	return lines.join("\n\n");
}

export async function userConversation(harness: Pick<Harness, "snapshot">, handle: string, context: Context): Promise<ConversationId | null> {
	return (await harness.snapshot(UserDoc, handle, context))?.conversation ?? null;
}

async function ensureUser(tx: Tx, user: ChatUser): Promise<ConversationId> {
	const doc = await tx.doc(UserDoc, user.handle, null);
	if (doc.conversation === null) doc.conversation = await createSeatConversation(tx, "user", { kind: "ownerless" }, { instructions: userInstructions(user) });
	return doc.conversation;
}

export async function ensureLine(harness: Harness, context: Context): Promise<ConversationId> {
	return harness.commit(async (tx) => {
		const line = await tx.doc(LineDoc);
		if (line.conversation === null) line.conversation = await createSeatConversation(tx, "peer", { kind: "ownerless" });
		return line.conversation;
	}, context);
}

export interface Line {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly id: ConversationId;
	readonly turn: TurnTask;
	readonly channels: Channels;
	readonly timeZone: string;
	readonly workDir: string;
	readonly media: Omit<MediaDeps, "workDir">;
	readonly users: readonly ChatUser[];
	readonly command: (input: CommandInput, context: Context) => Promise<CommandReply>;
}

// The record is a passive write, which a task's conversation handle cannot submit, so it uses the host's handles.
type TurnHost = Pick<Line, "root" | "harness" | "users" | "channels" | "workDir" | "media"> & { readonly log: Log };

const NOTIFY_ENTRY = "app.notify";

function deliveredRecord(input: RunTurn, recipient: string): string {
	const from = input.from.kind === "trigger" ? `trigger ${input.from.id}` : `conversation ${input.from.id}`;
	const where = input.channel === "cli" ? "in the terminal" : `on ${input.channel}`;
	return `[context, no reply needed: told ${recipient} ${where}, from ${from}] ${input.text}`;
}

// The only builder of a chat Turn's input, so ingest and `run` submit identical content.
async function inputOf(workDir: string, turn: ChatTurn, media: Omit<MediaDeps, "workDir">, host: Committer, context: Context): Promise<UserInput> {
	const { notes, images } = turn.preparedMedia ?? (await prepareInbound(turn.files, workDir, media, context.abortSignal));
	const lines: string[] = [];
	if (turn.replyTo !== undefined) {
		const whose = turn.replyTo.fromAgent ? "your" : "their";
		const quoted = turn.replyTo.text === "" ? "(text not available; use recall)" : turn.replyTo.text;
		lines.push(`[replying to ${whose} message id=${turn.replyTo.messageId}] ${quoted}`);
	}
	lines.push(turn.text);
	const held = await holdText(host, workDir, turn.conversation ?? ROOT_CONVERSATION_ID, `in:${turn.key}`, lines.join("\n"), context);
	const text = [turn.tag, held, ...notes].join("\n");
	return images.length === 0 ? text : [{ type: "text", text }, ...images];
}

/** A provider usage-policy block poisons the whole window: every later request is blocked too. */
function blockedByPolicy(settled: { readonly status: string; readonly detail?: unknown }): boolean {
	return settled.status === "unanswered" && typeof settled.detail === "string" && settled.detail.includes("Usage Policy");
}

const POLICY_RESET_NOTE = "the provider blocked this thread, so I started a fresh one. memory and the board are kept.";

/** The answer without the blocks already streamed, so the final send never repeats one. */
function unstreamed(text: string, streamed: readonly string[]): string {
	if (streamed.length === 0) return text;
	return blocks(text).filter((block) => !streamed.includes(block)).join("\n\n");
}

/** Steered into a chat run that has sent nothing for `SLOW_NUDGE_MS`, as Claude Code's "it's been a while" reminder. */
const SLOW_NUDGE = "[the owner has waited a while with no reply: tell him in a few words what you are doing, then continue]";
const SLOW_NUDGE_MS = 290_000;



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

export async function answerText(tx: Tx, entry: EntryId): Promise<string> {
	const message = (await tx.entry(AssistantEntry, entry))?.model?.[0];
	return message === undefined ? "" : messageText(message).trim();
}

const TYPING_REFRESH_MS = 5_000;

function keepTyping(channel: Channel | undefined, person: string | undefined): () => void {
	if (channel === undefined) return () => {};
	const typing = (on: boolean) => channel.typing(on, person).catch(() => {});
	const until = Date.now() + channel.profile.typingMaxMs;
	void typing(true);
	const timer = setInterval(() => {
		if (Date.now() < until) return void typing(true);
		clearInterval(timer);
		void typing(false);
	}, TYPING_REFRESH_MS);
	return () => {
		clearInterval(timer);
		void typing(false);
	};
}

// A user's replies chain apart from the owner's, so one never waits behind the other.
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
	const { users, channels, workDir, media, log } = host;
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
				const channel = channels.get(input.channel);
				const conversationId = input.conversation ?? ROOT_CONVERSATION_ID;
				const stopTyping = keepTyping(channel, input.person);
				const streamed = [...(task.state.checkpoint.streamed ?? [])];
				let run = task.state.checkpoint.run;
				const stopStream = channel === undefined || !channel.profile.paragraphsAreBubbles
					? async () => {}
					: streamParagraphs({
						harness: host.harness,
						conversation: conversationId,
						channel,
						person: input.person,
						threadOn: input.threadOn,
						sent: streamed,
						onSent: (sent) => runtime.commit(() => running({ phase: "run", streamed: [...sent], ...(run === undefined ? {} : { run }) }), context).then(() => {}),
						onError: (error) => log("turn.stream_failed", { task: task.id, error: String(error) }),
						own: async (runId) => {
							const won = await host.harness.commit(async (tx) => {
								const owner = await tx.doc(StreamOwnerDoc, runId, null);
								if (owner.task === null) owner.task = task.id;
								return owner.task === task.id;
							}, context);
							return won;
						},
						onRun: (runId) => {
							run = runId;
						},
					});
				let settled;
				let nudge: ReturnType<typeof setTimeout> | undefined;
				try {
					const conversation = (await runtime.conversation(conversationId, context))!;
					const content = await inputOf(workDir, input, media, host.harness, context);
					const submission = await conversation.submit({ type: "input", content, requestId: input.key, whenBusy: "steer" }, context);
					nudge = setTimeout(() => {
						if (streamed.length > 0) return;
						void conversation.submit({ type: "input", content: SLOW_NUDGE, requestId: `${input.key}:nudge`, whenBusy: "steer" }, context).catch(() => {});
					}, SLOW_NUDGE_MS);
					settled = await submission.wait(context);
					if (blockedByPolicy(settled)) {
						log("turn.policy_reset", { task: task.id, conversation: conversationId });
						await keyedReset(conversation, `policy-reset:${input.key}`, undefined, Date.now(), context);
						settled = await (await conversation.submit({ type: "input", content, requestId: `${input.key}:after-reset`, whenBusy: "steer" }, context)).wait(context);
						if (channel !== undefined) await channel.send({ kind: "text", text: POLICY_RESET_NOTE }, input.person).catch(() => {});
					}
				} finally {
					clearTimeout(nudge);
					await stopStream();
					stopTyping();
				}
				const sent = [...streamed];
				const ran = run === undefined ? {} : { run };
				await runtime.commit(() => {
					if (settled.status === "done") return settled.type === "input" ? running({ phase: "claim", channel: input.channel, answer: { kind: "entry", entry: settled.answer }, streamed: sent, ...ran }) : completed("silent");
					if (settled.reason === "aborted") return completed("silent");
					return running({ phase: "claim", channel: input.channel, answer: { kind: "failure", submission: settled.id, reason: settled.reason }, streamed: sent, ...ran });
				}, context);
			},
			claim: async (task, runtime, context) => {
				const { channel, answer, streamed, run } = task.state.checkpoint;
				await runtime.commit(async (tx) => {
					if (run !== undefined) {
						const owner = await tx.doc(StreamOwnerDoc, run, null);
						if (owner.task !== null && owner.task !== task.id) return completed("merged");
					}
					const claim = await tx.doc(ClaimDoc, claimKey(answer, task.id, channel), null);
					if (claim.task !== null && claim.task !== task.id) return completed("merged");
					claim.task = task.id;
					const tail = await tx.doc(ChannelTailDoc, tailKey(channel, task.input.person), null);
					const previous = tail.task;
					tail.task = task.id;
					const live = previous !== null && previous !== task.id && (await tx.task(previous))?.state.status !== "terminal";
					return running({ phase: "send", channel, answer, after: live ? previous : null, sent: 0, outage: null, ...(streamed === undefined ? {} : { streamed }) });
				}, context);
			},
			send: async (task, runtime, context) => {
				const state = task.state.checkpoint;
				const { channel: id, answer } = state;
				const person = task.input.person;
				let { sent, outage } = state;
				if (state.after !== null) await runtime.waitForTask(state.after, context);
				let text = "";
				if (answer.kind === "failure") text = `Sorry, I couldn't answer that (${answer.reason}).`;
				else if (answer.kind === "input") text = task.input.text;
				else await runtime.commit(async (tx) => void (text = await answerText(tx, answer.entry)), context);
				const finished = task.input.source === "run" ? running({ phase: "record" }) : completed("sent");
				const outgoing = splitDirectives(text);
				let retried = false;
				for (;;) {
					const channel = channels.get(id);
					let bubble: Bubble | undefined;
					if (channel !== undefined) {
						// Attachment bubbles are placeholders until their turn to send, so a file read never shifts `sent` indexes.
						const bubbles: Bubble[] = [
							...withEffect(present(unstreamed(outgoing.text, state.streamed ?? []), channel.profile), outgoing.effect),
							...outgoing.files.map((file) => ({ kind: "file" as const, name: file.path, mimeType: "application/octet-stream", bytes: new Uint8Array(), voice: file.voice })),
						];
						if (bubbles.length === 0) return runtime.commit(() => completed("silent"), context);
						if (sent >= bubbles.length) return runtime.commit(() => finished, context);
						bubble = bubbles[sent];
					}
					try {
						if (channel === undefined || bubble === undefined) throw new ChannelDown(`${id} is not running in this process`);
						let outgoingBubble = bubble;
						if (bubble.kind === "file") {
							try {
								outgoingBubble = { ...(await loadOutgoing(bubble.name, workDir)), voice: bubble.voice === true };
							} catch (error) {
								throw new SendRejected(`The attachment ${bubble.name} could not be sent: ${error instanceof Error ? error.message : String(error)}`);
							}
						}
						const chatThread = task.input.source === "chat" && outgoingBubble.kind === "text" ? task.input.threadOn : undefined;
						const threadOn = outgoing.replyTo ?? chatThread;
						const sendStart = Date.now();
						if (sent === 0 && threadOn !== undefined && (state.streamed ?? []).length === 0) await channel.send(outgoingBubble, person, { replyTo: threadOn });
						else await channel.send(outgoingBubble, person);
						log("turn.sent", { task: task.id, bubble: sent, ms: Date.now() - sendStart, sinceStart: Date.now() - (task.startedAt ?? Date.now()) });
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
							const next = nextOutage(outage, runtime.now());
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
				const user = userOf(users, input.person);
				const target = await threadOf(host, user, context);
				const recipient = user === undefined ? OWNER_ID : user.id;
				const model = [{ role: "user" as const, content: deliveredRecord(input, recipient), timestamp: Date.now() }];
				await target.submit({ type: "write", requestId: `record:${task.id}`, entry: { kind: NOTIFY_ENTRY, data: { channel: input.channel, text: input.text }, model } }, context);
				await runtime.commit(() => completed("sent"), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

// Not idempotent by itself: ingest dedupes by request id, notify with the Journal.
export function openTurn(tx: Tx, line: Pick<Line, "id" | "turn">, input: TurnInput): Promise<TaskId<TurnResult>> {
	return tx.createTask(line.turn, input, { ownership: { kind: "conversation" }, conversationId: line.id, background: true });
}

/**
 * Brings `text` into root through a chat Turn on the owner's last chat channel, so root's answer reaches the owner.
 * A bare submit to root runs it with no Turn, and the answer goes nowhere. False when no chat message came yet.
 * Not idempotent by itself: call it in the commit that ends the caller's task.
 */
export async function openRootWake(tx: Tx, line: Pick<Line, "id" | "turn">, key: string, tag: string, text: string): Promise<boolean> {
	const last = (await tx.doc(LastInboundDoc)).last;
	if (last === null) return false;
	await openTurn(tx, line, { source: "chat", channel: last.channel, key, tag, text, files: [] });
	return true;
}

/** `to`: the conversation it goes to; absent, root. */
type CliInbound = {
	readonly kind: "cli";
	readonly messageId: string;
	readonly text: string;
	readonly at: Date;
	readonly to?: ConversationId;
	readonly whenBusy?: "steer" | "followUp";
};

const tagOf = (channel: ChannelId, messageId: string, at: Date, timeZone: string) => `[${channel} ${formatStamp(at, timeZone)} id=${messageId}]`;

// A chat message opens its Turn in the commit that finds no submission for its request key, then submits itself,
// so arrival order is root's order.
export async function ingest(line: Line, inbound: Inbound | CliInbound, context: Context): Promise<SubmissionId> {
	const { root, harness } = line;
	switch (inbound.kind) {
		case "cli": {
			const target = await conversationOf(line, inbound.to ?? root.id, context);
			const key = requestKey("cli", inbound.messageId);
			const text = await holdText(harness, line.workDir, target.id, `in:${key}`, inbound.text, context);
			const content = `${tagOf("cli", inbound.messageId, inbound.at, line.timeZone)}\n${text}`;
			return (await target.submit({ type: "input", content, requestId: key, whenBusy: inbound.whenBusy ?? "steer" }, context)).id;
		}
		case "tapback": {
			const user = userOf(line.users, inbound.person);
			const who = user === undefined ? OWNER_ID : user.id;
			const whose = inbound.fromAgent ? "your" : "their";
			const quoted = inbound.onText === "" ? "" : `: "${inbound.onText}"`;
			const model = [{ role: "user" as const, content: `[context, no reply needed: ${who} reacted ${inbound.emoji} to ${whose} message id=${inbound.on}${quoted}]`, timestamp: inbound.at.getTime() }];
			const target = await threadOf(line, user, context);
			return (await target.submit({ type: "write", requestId: requestKey(inbound.channel, inbound.messageId), entry: { kind: "mochi.tapback", model } }, context)).id;
		}
		case "message": {
			const key = requestKey(inbound.channel, inbound.messageId);
			const user = userOf(line.users, inbound.person);
			const recordInbound = async (tx: Tx) => {
				if (user === undefined) (await tx.doc(LastInboundDoc)).last = { channel: inbound.channel, messageId: inbound.messageId };
			};
			const command = inbound.attachments.length === 0 ? commandOf(inbound.text) : undefined;
			if (command !== undefined) {
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
			const content = await inputOf(line.workDir, user === undefined ? turn : { ...turn, conversation: opened.conversation }, line.media, harness, context);
			return (await target.submit({ type: "input", content, requestId: key, whenBusy: "steer" }, context)).id;
		}
	}
}

// No person means the owner.
function userOf(users: readonly ChatUser[], person: string | undefined): ChatUser | undefined {
	if (person === undefined) return undefined;
	for (const user of users) if (user.handle === person) return user;
	throw new Error(`No user ${person} is configured.`);
}

async function conversationOf(host: Pick<Line, "root" | "harness">, id: ConversationId, context: Context): Promise<Conversation> {
	if (id === ROOT_CONVERSATION_ID) return host.root;
	const conversation = await host.harness.conversation(id, context);
	if (conversation === undefined) throw new Error(`Conversation ${id} is missing.`);
	return conversation;
}

// Root for the owner, else the user's own conversation, made on first use.
async function threadOf(host: Pick<Line, "root" | "harness">, user: ChatUser | undefined, context: Context): Promise<Conversation> {
	if (user === undefined) return host.root;
	const id = await host.harness.commit((tx) => ensureUser(tx, user), context);
	return conversationOf(host, id, context);
}

export function reactTool(channels: Channels): ToolRegistration {
	return defineTool({
				name: "react",
				description:
					"React to an owner message with one emoji, or none to remove it. messageId: the id= in the tag; default the newest. Use it when a reaction says everything.",
				parameters: Type.Object({
					reaction: Type.String({ minLength: 1, maxLength: 16 }),
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
