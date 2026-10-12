import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, defineDoc, defineDocFamily, ResetEntry, ROOT_CONVERSATION_ID, type SubmissionId, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { type Bubble, type Channel, ChannelDown, type ChatChannelId, type OwnerInbound, SendRejected, SendUnknown } from "../channels/types.ts";
import { createSeatConversation } from "../seats.ts";
import { newFaux, openTestMochi, recordingChannel, type TestMochi, tempDir, turnsSettled } from "../test-support.ts";
import { deliveredRecord, UserDoc, ingest, InboundCursorDoc, LastInboundDoc, NOTIFY_ENTRY, nextOutage, openTurn, RETRY, type RunTurn } from "./turn.ts";

const context = BACKGROUND_CONTEXT;
const FAST_RETRY = { firstMs: 20, maxMs: 40, giveUpMs: 5_000 };

function message(channel: ChatChannelId, messageId: string, text = "hi"): OwnerInbound {
	return { kind: "message", channel, messageId, text, at: new Date("2026-10-05T08:32:00Z"), attachments: [] };
}

/** A faux answer that waits for `release`, and aborts with the request. */
function gated(answer: AssistantMessage) {
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const respond = async (_c: unknown, options: { signal?: AbortSignal } | undefined): Promise<AssistantMessage> => {
		started();
		await new Promise<void>((resolve, reject) => {
			void gate.then(resolve);
			options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
		return answer;
	};
	return { respond, release, entered };
}

async function turnResults(mochi: TestMochi): Promise<string[]> {
	const tasks = (await mochi.harness.commit((tx) => tx.scanTasks({ kind: "mochi.turn" }, 100), context)).items;
	return tasks.map((task) => (task.state.status === "terminal" ? (task.state.outcome.status === "completed" ? String(task.state.outcome.result) : task.state.outcome.status) : task.state.status));
}

const notifyRecords = async (mochi: TestMochi) => (await mochi.root.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === NOTIFY_ENTRY);

test("inbound becomes one tagged submission per channel message id, answered once", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Hello!")]);
	const whatsapp = recordingChannel("whatsapp");
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["whatsapp", whatsapp.channel]]));
	await ingest(mochi.line, message("whatsapp", "wamid.1"), context);
	await ingest(mochi.line, message("whatsapp", "wamid.1"), context);
	await turnsSettled(mochi.harness);

	assert.equal(faux.state.callCount, 1);
	assert.deepEqual(whatsapp.sent, ["Hello!"]);
	const users = (await mochi.root.entries({}, 50, undefined, context)).items.filter((entry) => UserEntry.is(entry));
	assert.deepEqual(users.map((entry) => entry.model?.[0]?.role === "user" && entry.model[0].content), ["[whatsapp 2026-10-05 14:02 IST id=wamid.1]\nhi"]);
	assert.deepEqual(await turnResults(mochi), ["sent"]);
	assert.deepEqual((await mochi.harness.snapshot(LastInboundDoc, context))?.last, { channel: "whatsapp", messageId: "wamid.1" });
	await mochi.close();
});

const USER = { id: "user2", handle: "+918423152032", name: "Hemant Singh" };

function userMessage(messageId: string, text: string, sequence?: number): OwnerInbound {
	return { kind: "message", channel: "imessage", messageId, text, at: new Date("2026-10-05T08:32:00Z"), attachments: [], person: USER.handle, ...(sequence === undefined ? {} : { sequence }) };
}

test("a user message runs in the user's own conversation, once per redelivery, and the reply goes to the user", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Hi Hemant!"), fauxAssistantMessage("Hi owner!")]);
	const imessage = recordingChannel("imessage");
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["imessage", imessage.channel]]), undefined, [], { users: [USER] });
	const fromUser = userMessage("g1", "hey", 7);
	const first = await ingest(mochi.line, fromUser, context);
	const again = await ingest(mochi.line, fromUser, context);
	await turnsSettled(mochi.harness);
	assert.equal(again, first);
	assert.equal(faux.state.callCount, 1);

	const userConversation = (await mochi.harness.snapshot(UserDoc, USER.handle, context))?.conversation ?? null;
	assert.notEqual(userConversation, null);
	assert.notEqual(userConversation, ROOT_CONVERSATION_ID);
	const submission = await mochi.harness.commit((tx) => tx.submissionByRequest(userConversation!, "imessage:g1"), context);
	assert.equal(submission?.id, first);
	assert.equal(await mochi.harness.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, "imessage:g1"), context), undefined);
	assert.deepEqual((await mochi.root.entries({}, 50, undefined, context)).items.filter((entry) => UserEntry.is(entry)), []);
	const agent = await mochi.harness.snapshot(AgentDoc, userConversation!, context);
	assert.deepEqual(agent?.extensions, ["identity", "skills", "fast-compaction", "seat-user"]);
	assert.match(agent?.instructions ?? "", /^This conversation is with user2 \(Hemant Singh, iMessage \+918423152032\), a friend of user1, Shaurya Pratap Singh\./);
	assert.deepEqual(imessage.sentTo, [{ person: USER.handle, text: "Hi Hemant!" }]);
	assert.equal((await mochi.harness.snapshot(LastInboundDoc, context))?.last ?? null, null, "a user never becomes notify's or react's target");
	assert.equal((await mochi.harness.snapshot(InboundCursorDoc, "imessage", context))?.sequence, 7);

	await ingest(mochi.line, message("imessage", "o1", "and me"), context);
	await turnsSettled(mochi.harness);
	assert.deepEqual(imessage.sentTo.at(-1), { person: undefined, text: "Hi owner!" });
	assert.equal((await mochi.harness.snapshot(UserDoc, USER.handle, context))?.conversation, userConversation, "one conversation per user");
	await mochi.close();
});

test("a user's /new resets only the user's conversation and replies to the user", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("User answer."), fauxAssistantMessage("Owner answer.")]);
	const imessage = recordingChannel("imessage");
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["imessage", imessage.channel]]), undefined, [], { users: [USER] });
	await ingest(mochi.line, userMessage("g1", "hey"), context);
	await ingest(mochi.line, message("imessage", "o1", "hello"), context);
	await turnsSettled(mochi.harness);
	faux.setResponses([fauxAssistantMessage("")]);
	await ingest(mochi.line, userMessage("g2", "/new"), context);
	await turnsSettled(mochi.harness);

	const userConversation = (await mochi.harness.snapshot(UserDoc, USER.handle, context))!.conversation!;
	const resets = async (id: typeof userConversation) => (await mochi.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 100), context)).items.filter((entry) => entry.kind === ResetEntry.kind).length;
	assert.equal(await resets(userConversation), 1);
	assert.equal(await resets(ROOT_CONVERSATION_ID), 0);
	assert.match(JSON.stringify((await mochi.root.context(context)).messages), /Owner answer\./, "root keeps its thread");
	assert.deepEqual(imessage.sentTo.at(-1), { person: USER.handle, text: "fresh thread." });
	await mochi.close();
});

test("a redelivery racing the first submit opens a second Turn that ends merged", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Only once.")]);
	const whatsapp = recordingChannel("whatsapp");
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["whatsapp", whatsapp.channel]]));
	const [a, b] = await Promise.all([ingest(mochi.line, message("whatsapp", "w1"), context), ingest(mochi.line, message("whatsapp", "w1"), context)]);
	await turnsSettled(mochi.harness);
	assert.equal(a, b);
	assert.deepEqual(whatsapp.sent, ["Only once."]);
	assert.deepEqual((await turnResults(mochi)).sort(), ["merged", "sent"]);
	await mochi.close();
});

test("steers into one run on two channels send the answer once per channel", async () => {
	const answer = gated(fauxAssistantMessage(fauxToolCall("recall", { query: "thing" }), { stopReason: "toolUse" }));
	const faux = newFaux();
	faux.setResponses([answer.respond, fauxAssistantMessage("Both done.")]);
	const telegram = recordingChannel("telegram");
	const whatsapp = recordingChannel("whatsapp");
	const mochi = await openTestMochi(await tempDir(), faux, new Map<ChatChannelId, Channel>([["telegram", telegram.channel], ["whatsapp", whatsapp.channel]]));
	await ingest(mochi.line, message("telegram", "t1", "do the thing"), context);
	await answer.entered;
	await ingest(mochi.line, message("whatsapp", "w1", "and this"), context);
	answer.release();
	await turnsSettled(mochi.harness);

	const steer = await mochi.harness.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, "whatsapp:w1"), context);
	assert.equal(steer?.status, "done");
	assert.deepEqual(telegram.sent, ["Both done."]);
	assert.deepEqual(whatsapp.sent, ["Both done."]);
	assert.deepEqual(await turnResults(mochi), ["sent", "sent"]);
	await mochi.close();
});

test("a steer that arrives after the answer starts the next run and gets its own reply", async () => {
	const answer = gated(fauxAssistantMessage("First answer here."));
	const faux = newFaux();
	faux.setResponses([answer.respond, fauxAssistantMessage("Second answer here.")]);
	const whatsapp = recordingChannel("whatsapp");
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["whatsapp", whatsapp.channel]]));
	await ingest(mochi.line, message("whatsapp", "a", "one"), context);
	await answer.entered;
	await ingest(mochi.line, message("whatsapp", "b", "two"), context);
	answer.release();
	await turnsSettled(mochi.harness);
	assert.deepEqual(whatsapp.sent, ["First answer here.", "Second answer here."]);
	await mochi.close();
});

test("a failed run sends one failure notice", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
	const whatsapp = recordingChannel("whatsapp");
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["whatsapp", whatsapp.channel]]));
	await ingest(mochi.line, message("whatsapp", "x"), context);
	await turnsSettled(mochi.harness);
	assert.equal(whatsapp.sent.length, 1);
	assert.match(whatsapp.sent[0] ?? "", /^Sorry, I couldn't answer that/);
	await mochi.close();
});

test("two answers ready together on one channel go out whole, one after the other", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("A first bubble.\n\nA second bubble.\n\nA third bubble."), fauxAssistantMessage("B first bubble.\n\nB second bubble.")]);
	const sent: string[] = [];
	const imessage: Channel = {
		...recordingChannel("imessage").channel,
		send: async (bubble) => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			sent.push(bubble.kind === "text" ? bubble.text : "");
		},
	};
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["imessage", imessage]]));
	const first = await ingest(mochi.line, message("imessage", "g1", "one"), context);
	await (await mochi.harness.submission(first, context))!.wait(context);
	await ingest(mochi.line, message("imessage", "g2", "two"), context);
	await turnsSettled(mochi.harness);
	assert.deepEqual(sent, ["A first bubble.", "A second bubble.", "A third bubble.", "B first bubble.", "B second bubble."]);
	await mochi.close();
});

test("an iMessage reply goes out as bubbles; a rejected bubble is skipped and a blank answer sends nothing", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Booked the 7pm table.\n\nhttps://example.com/booking\n\nTell me if you want 8 instead."), fauxAssistantMessage("\u{200B}")]);
	const sent: Bubble[] = [];
	const typing: boolean[] = [];
	let linkAttempts = 0;
	const imessage: Channel = {
		...recordingChannel("imessage").channel,
		typing: async (on) => {
			typing.push(on);
			throw new Error("typing is down");
		},
		send: async (bubble) => {
			if (bubble.kind === "link") {
				linkAttempts++;
				throw new SendRejected("no link cards");
			}
			sent.push(bubble);
		},
	};
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["imessage", imessage]]));
	await ingest(mochi.line, message("imessage", "g1", "book it"), context);
	await turnsSettled(mochi.harness);
	await ingest(mochi.line, message("imessage", "g2", "thanks"), context);
	await turnsSettled(mochi.harness);

	assert.deepEqual(sent, [
		{ kind: "text", text: "Booked the 7pm table." },
		{ kind: "text", text: "Tell me if you want 8 instead." },
	]);
	assert.equal(linkAttempts, 1, "a rejected bubble is not retried");
	assert.deepEqual(typing.slice(0, 2), [true, false], "typing starts with the message and stops before the reply");
	assert.equal(typing.at(-1), false, "a silent answer still stops typing");
	assert.deepEqual(await turnResults(mochi), ["sent", "silent"], "typing errors fail nothing");
	await mochi.close();
});

test("an absent channel, then a down one, delivers after it connects with no repeat; SendUnknown retries once", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Back online now.")]);
	const sent: string[] = [];
	let downs = 2;
	let unknowns = 1;
	const telegram: Channel = {
		...recordingChannel("telegram").channel,
		send: async (bubble) => {
			if (downs-- > 0) throw new ChannelDown("reconnecting");
			if (unknowns-- > 0) {
				sent.push(`maybe:${bubble.kind === "text" ? bubble.text : ""}`);
				throw new SendUnknown("timeout");
			}
			sent.push(bubble.kind === "text" ? bubble.text : bubble.kind);
		},
	};
	const channels = new Map<ChatChannelId, Channel>();
	const logs: string[] = [];
	const mochi = await openTestMochi(await tempDir(), faux, channels, undefined, [], { retry: FAST_RETRY, log: (event) => logs.push(event) });
	await ingest(mochi.line, message("telegram", "t1"), context);
	await (await mochi.harness.submission((await mochi.harness.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, "telegram:t1"), context))!.id, context))!.wait(context);
	await new Promise((resolve) => setTimeout(resolve, 30));
	channels.set("telegram", telegram);
	await turnsSettled(mochi.harness);
	assert.deepEqual(sent, ["maybe:Back online now.", "Back online now."]);
	assert.ok(logs.includes("turn.send_unknown"));
	assert.deepEqual(await turnResults(mochi), ["sent"]);
	await mochi.close();
});

test("a channel down past the outage limit ends failed with one log line", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Never arrives.")]);
	const logs: string[] = [];
	const down: Channel = { ...recordingChannel("whatsapp").channel, send: async () => Promise.reject(new ChannelDown("gone")) };
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["whatsapp", down]]), undefined, [], { retry: { firstMs: 10, maxMs: 20, giveUpMs: 100 }, log: (event) => logs.push(event) });
	await ingest(mochi.line, message("whatsapp", "w1"), context);
	await turnsSettled(mochi.harness);
	assert.deepEqual(await turnResults(mochi), ["failed"]);
	assert.equal(logs.filter((event) => event === "turn.undelivered").length, 1);
	await mochi.close();
});

test("nextOutage backs off 5 s doubling to 5 min, counts only back-off, and gives up after an hour of it", () => {
	const first = nextOutage(null, 1_000);
	assert.deepEqual(first, { retryAt: 6_000, attempt: 1, downMs: 0 });
	assert.deepEqual(nextOutage(first as never, 6_000), { retryAt: 16_000, attempt: 2, downMs: 5_000 });
	const twoHoursLater = nextOutage({ retryAt: 6_000, attempt: 1, downMs: 0 }, 6_000 + 2 * 3_600_000);
	assert.notEqual(twoHoursLater, "give-up", "a stopped daemon does not count the stop as outage");
	let outage = nextOutage(null, 0);
	const delays: number[] = [];
	for (let now = 0; outage !== "give-up"; ) {
		delays.push(outage.retryAt - now);
		now = outage.retryAt;
		outage = nextOutage(outage, now);
	}
	assert.deepEqual(delays.slice(0, 8), [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
	assert.ok(delays.slice(0, -1).reduce((sum, delay) => sum + delay, 0) < RETRY.giveUpMs);
	assert.ok(delays.reduce((sum, delay) => sum + delay, 0) >= RETRY.giveUpMs);
});

test("/stop withdraws a reply still being generated, but a reply mid-send and a pending notify both finish", async () => {
	const pending = gated(fauxAssistantMessage("never"));
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Reply first bubble.\n\nReply second bubble."), pending.respond]);
	const sent: string[] = [];
	let entered!: () => void;
	const sending = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const imessage: Channel = {
		...recordingChannel("imessage").channel,
		send: async (bubble) => {
			entered();
			await held;
			sent.push(bubble.kind === "text" ? bubble.text : "");
		},
	};
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["imessage", imessage]]));
	await ingest(mochi.line, message("imessage", "g1", "one"), context);
	await sending;
	await mochi.harness.commit((tx) => openTurn(tx, mochi.line, { source: "run", channel: "imessage", text: "Fare dropped to 5,400.", from: { kind: "trigger", id: "flight-watch" } }), context);
	await ingest(mochi.line, message("imessage", "g2", "two"), context);
	await pending.entered;
	await mochi.root.abort(context, { background: true });
	release();
	await turnsSettled(mochi.harness);

	assert.deepEqual(sent, ["Reply first bubble.", "Reply second bubble.", "Fare dropped to 5,400."]);
	assert.deepEqual(await turnResults(mochi), ["sent", "sent", "silent"]);
	assert.equal((await notifyRecords(mochi)).length, 1);
	await mochi.close();
});

test("a notify sends verbatim and leaves root with exactly one new entry, framed as context", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage(fauxToolCall("notify", { text: "Build failed on main." }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	const whatsapp = recordingChannel("whatsapp");
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["whatsapp", whatsapp.channel]]));
	const run = (await mochi.harness.conversation(await mochi.harness.commit((tx) => createSeatConversation(tx, "run", { kind: "ownerless" }), context), context))!;
	const before = (await mochi.root.entries({}, 100, undefined, context)).items.length;
	await (await run.submit({ type: "input", content: "check the build" }, context)).wait(context);
	await turnsSettled(mochi.harness);

	assert.deepEqual(whatsapp.sent, ["Build failed on main."]);
	const entries = (await mochi.root.entries({}, 100, undefined, context)).items;
	assert.equal(entries.length, before + 1);
	const text = entries[0]?.model?.[0]?.role === "user" ? entries[0].model[0].content : undefined;
	assert.equal(text, `[context, no reply needed: told user1 on whatsapp, from conversation ${run.id}] Build failed on main.`);
	await mochi.close();
});

test("the delivered-record is capped at 280 characters", () => {
	const input: RunTurn = { source: "run", channel: "imessage", text: "x".repeat(300), from: { kind: "trigger", id: "t" } };
	assert.equal(deliveredRecord(input, "user1"), `[context, no reply needed: told user1 on imessage, from trigger t] ${"x".repeat(280)}…`);
});

test("a local process leaves a pending Turn waiting, and the next daemon start delivers it", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	const local = await openTestMochi(dir, faux, new Map(), undefined, [], { scheduling: "local" });
	await local.harness.commit((tx) => openTurn(tx, local.line, { source: "run", channel: "telegram", text: "Your parcel arrived.", from: { kind: "trigger", id: "parcel" } }), context);
	local.harness.resume();
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(await turnResults(local), ["pending"]);
	await local.close();

	const telegram = recordingChannel("telegram");
	const daemon = await openTestMochi(dir, faux, new Map([["telegram", telegram.channel]]));
	daemon.harness.resume();
	await turnsSettled(daemon.harness);
	assert.deepEqual(telegram.sent, ["Your parcel arrived."]);
	assert.equal((await notifyRecords(daemon)).length, 1);
	await daemon.close();
});

test("react defaults to the owner's newest message, takes an explicit id, and fails clearly without reactions", async () => {
	const telegram = recordingChannel("telegram");
	const whatsapp = recordingChannel("whatsapp", { react: false });
	const react = (args: Record<string, string>, id: string) => fauxAssistantMessage(fauxToolCall("react", args, { id }), { stopReason: "toolUse" });
	const faux = newFaux();
	faux.setResponses([react({ reaction: "like" }, "r1"), fauxAssistantMessage(""), react({ reaction: "none", messageId: "m1" }, "r2"), fauxAssistantMessage(""), react({ reaction: "like" }, "r3"), fauxAssistantMessage("ok")]);
	const mochi = await openTestMochi(await tempDir(), faux, new Map<ChatChannelId, Channel>([["telegram", telegram.channel], ["whatsapp", whatsapp.channel]]));
	for (const [channel, id] of [["telegram", "m1"], ["telegram", "m2"], ["whatsapp", "c1"]] as const) {
		await ingest(mochi.line, message(channel, id), context);
		await turnsSettled(mochi.harness);
	}

	assert.deepEqual(telegram.reactions, [
		{ messageId: "m1", reaction: "like" },
		{ messageId: "m1", reaction: "none" },
	]);
	assert.deepEqual(telegram.sent, [], "an empty answer after a reaction sends nothing");
	const results = (await mochi.root.entries({}, 100, undefined, context)).items
		.filter((entry) => ToolResultEntry.is(entry))
		.flatMap((entry) => entry.model ?? [])
		.flatMap((model): ToolResultMessage[] => (model.role === "toolResult" ? [model] : []));
	assert.equal(results[0]?.isError, true);
	assert.match(JSON.stringify(results[0]?.content), /The whatsapp channel does not support reactions/);
	await mochi.close();
});

test("an owner tapback is a passive write with no model turn", async () => {
	const faux = newFaux();
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["imessage", recordingChannel("imessage").channel]]));
	const tapback: OwnerInbound = { kind: "tapback", channel: "imessage", messageId: "tb1", on: "g9", reaction: "love", emoji: "❤️", onText: "Dinner at 8?", fromAgent: true, at: new Date() };
	await ingest(mochi.line, tapback, context);
	await ingest(mochi.line, tapback, context);
	const entries = (await mochi.root.entries({}, 10, undefined, context)).items;
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.model?.[0]?.role === "user" && entries[0].model[0].content, '[context, no reply needed: user1 reacted ❤️ to your message id=g9: "Dinner at 8?"]');
	assert.equal(faux.state.callCount, 0);
	await mochi.close();
});

test("a user's tapback is written to the user's conversation, not root", async () => {
	const faux = newFaux();
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["imessage", recordingChannel("imessage").channel]]), undefined, [], { users: [USER] });
	const tapback: OwnerInbound = { kind: "tapback", channel: "imessage", messageId: "tb2", on: "m4", reaction: "emoji", emoji: "🔥", onText: "", fromAgent: false, person: USER.handle, at: new Date() };
	await ingest(mochi.line, tapback, context);
	await ingest(mochi.line, tapback, context);
	assert.deepEqual((await mochi.root.entries({}, 10, undefined, context)).items, []);
	const userConversation = (await mochi.harness.snapshot(UserDoc, USER.handle, context))!.conversation!;
	const entries = (await mochi.harness.commit((tx) => tx.scanEntries({ conversationId: userConversation }, 100), context)).items.filter((entry) => entry.kind === "mochi.tapback");
	assert.deepEqual(entries.map((entry) => entry.model?.[0]?.role === "user" && entry.model[0].content), ["[context, no reply needed: user2 reacted 🔥 to their message id=m4]"]);
	assert.equal(faux.state.callCount, 0);
	await mochi.close();
});

test("a reply shows its target to the model and threads the first text bubble of the answer", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Yes, still on at 8.\n\nI booked the table for two.")]);
	const sends: { text: string; replyTo: string | undefined }[] = [];
	const imessage = recordingChannel("imessage");
	const channel: Channel = {
		...imessage.channel,
		send: async (bubble, _person, options) => void sends.push({ text: bubble.kind === "text" ? bubble.text : bubble.kind, replyTo: options?.replyTo }),
	};
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["imessage", channel]]));
	const replyTo = { messageId: "a7", text: "Dinner at 8?", fromAgent: true };
	const inbound: OwnerInbound = { kind: "message", channel: "imessage", messageId: "r1", text: "is that still on", at: new Date("2026-10-05T08:32:00Z"), attachments: [], replyTo };
	await ingest(mochi.line, inbound, context);
	await turnsSettled(mochi.harness);
	const users = (await mochi.root.entries({}, 50, undefined, context)).items.filter((entry) => UserEntry.is(entry));
	assert.deepEqual(users.map((entry) => entry.model?.[0]?.role === "user" && entry.model[0].content), [
		"[imessage 2026-10-05 14:02 IST id=r1]\n[replying to your message id=a7] Dinner at 8?\nis that still on",
	]);
	assert.deepEqual(sends, [
		{ text: "Yes, still on at 8.", replyTo: "r1" },
		{ text: "I booked the table for two.", replyTo: undefined },
	]);
	await mochi.close();
});

test("the upgrade turns a pending Router outbox into a delivered Turn, retires outbox and routes, and migrates last-inbound", async () => {
	const dir = await tempDir();
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("Answered before the deploy.")]);
	const OldOutbox = defineDoc<{ pending: SubmissionId[] }>({ kind: "mochi.outbox", version: 1, scope: "session", initial: () => ({ pending: [] }) });
	type Route = { submissionId: SubmissionId; channel: string; messageId: string; recorded: boolean };
	const OldRoute = defineDocFamily<Route, Route>({ kind: "mochi.route", version: 1, scope: "session", family: true, initial: (seed) => seed });
	const OldLast = defineDoc<{ route: Route | null }>({ kind: "mochi.last-inbound", version: 1, scope: "session", initial: () => ({ route: null }) });
	{
		const old = await openTestMochi(dir, faux, new Map(), undefined, [], { scheduling: "local" });
		const submission = await old.root.submit({ type: "input", content: "[whatsapp …] question", requestId: "whatsapp:w7", whenBusy: "steer" }, context);
		await submission.wait(context);
		await old.harness.commit(async (tx) => {
			const route = { submissionId: submission.id, channel: "whatsapp", messageId: "w7", recorded: true };
			await tx.doc(OldRoute, String(submission.id), route);
			await tx.doc(OldRoute, "999", { ...route, submissionId: 999 as SubmissionId });
			(await tx.doc(OldOutbox)).pending.push(submission.id);
			(await tx.doc(OldLast)).route = route;
		}, context);
		await old.close();
	}
	const logged: unknown[] = [];
	const whatsapp = recordingChannel("whatsapp");
	const mochi = await openTestMochi(dir, faux, new Map([["whatsapp", whatsapp.channel]]), undefined, [], { log: (event, fields) => logged.push([event, fields]) });
	mochi.harness.resume();
	await turnsSettled(mochi.harness);
	assert.deepEqual(whatsapp.sent, ["Answered before the deploy."]);
	assert.deepEqual(logged, [["upgrade", { unit: "U5", name: "outbox-to-turns", changed: 4 }]]);
	assert.equal(await mochi.harness.snapshot(OldOutbox, context), undefined);
	assert.equal(await mochi.harness.snapshot(OldRoute, "999", context), undefined);
	assert.deepEqual((await mochi.harness.snapshot(LastInboundDoc, context))?.last, { channel: "whatsapp", messageId: "w7" });
	assert.equal(faux.state.callCount, 1);
	await mochi.close();

	const again: unknown[] = [];
	const second = await openTestMochi(dir, faux, new Map([["whatsapp", recordingChannel("whatsapp").channel]]), undefined, [], { log: (event, fields) => again.push([event, fields]) });
	assert.deepEqual(again, [], "a second boot has nothing to do");
	await second.close();
});
