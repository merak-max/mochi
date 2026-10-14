import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { newFaux, openTestMochi, tempDir, turnsSettled } from "../test-support.ts";
import { InboundCursorDoc, ingest } from "../turn/turn.ts";
import * as fx from "./fixtures/imessage.ts";
import { createIMessageChannel, type IMessageApp, type IMessageDeps, type IMessageMessage, judge, LINK, toInbound } from "./imessage.ts";
import type { Content } from "spectrum-ts";
import { type Channel, ChannelDown, type Inbound, SendRejected, SendUnknown } from "./types.ts";

const env = { PHOTON_PROJECT_ID: "proj", PHOTON_PROJECT_SECRET: "secret", IMESSAGE_OWNER: "+1 555 010 0001" };
const OWNER = "+15550100001";

function channelWith(app: IMessageApp, deps: IMessageDeps = {}): Channel {
	const setup = createIMessageChannel(env, { connect: async () => app, log: () => {}, ...deps });
	assert.equal(setup.kind, "ready");
	return setup.value;
}

describe("imessage config", () => {
	it("is off with no variable and broken naming the missing ones with some", () => {
		assert.deepEqual(createIMessageChannel({}), { kind: "off" });
		assert.deepEqual(createIMessageChannel({ PHOTON_PROJECT_ID: "p", PHOTON_PROJECT_SECRET: "s" }), {
			kind: "broken",
			fix: "IMESSAGE_OWNER is not set. Fix: export it where mochi starts",
		});
	});
});

describe("imessage message mapping", () => {
	const log = fx.events();

	it("maps owner text with the provider message id and no sender", async () => {
		const parsed = await toInbound(fx.message(log, { id: "p:0/GUID-1", sender: fx.OWNER, content: fx.contents.text }), OWNER);
		assert.deepEqual(parsed, {
			kind: "message",
			message: { kind: "message", channel: "imessage", messageId: "p:0/GUID-1", text: "hey mochi", at: new Date("2026-10-05T08:32:00Z"), attachments: [] },
		});
	});

	it("drops other senders, missing senders and the agent's own outbound echoes", async () => {
		const stranger = fx.message(log, { id: "x", sender: "+15551234567", content: fx.contents.text });
		const anonymous = fx.message(log, { id: "y", content: fx.contents.text });
		const echo = fx.message(log, { id: "z", sender: fx.OWNER, direction: "outbound", content: fx.contents.text });
		assert.deepEqual(await toInbound(stranger, OWNER), { kind: "ignored", reason: "not-owner" });
		assert.deepEqual(await toInbound(anonymous, OWNER), { kind: "ignored", reason: "not-owner" });
		assert.deepEqual(await toInbound(echo, OWNER), { kind: "ignored", reason: "outbound" });
	});

	it("accepts a configured user with person set, still drops strangers, and never marks the owner a user", async () => {
		const USER = "+15550100002";
		const fromUser = fx.message(log, { id: "g", sender: "+1 555 010 0002", content: fx.contents.text });
		const parsed = await toInbound(fromUser, OWNER, [USER]);
		assert.equal(parsed.kind === "message" && parsed.message.kind === "message" ? parsed.message.person : "dropped", USER);
		assert.deepEqual(await toInbound(fx.message(log, { id: "x", sender: "+15551234567", content: fx.contents.text }), OWNER, [USER]), { kind: "ignored", reason: "not-owner" });
		const fromOwner = await toInbound(fx.message(log, { id: "o", sender: fx.OWNER, content: fx.contents.text }), OWNER, [USER, OWNER]);
		assert.equal(fromOwner.kind === "message" && fromOwner.message.kind === "message" && "person" in fromOwner.message, false);
	});

	it("records the target of a reply, with its text and whether mochi sent it", async () => {
		const target = fx.message(log, { id: "GUID-A", sender: fx.OWNER, direction: "outbound", content: { type: "text", text: "Dinner at 8?" } });
		const stub = { id: "GUID-S", content: { type: "custom", raw: { imessage_type: "reply-target", stub: true } }, direction: "inbound" } as unknown as IMessageMessage;
		const replyWith = (to: IMessageMessage) => fx.message(log, { id: "GUID-R", sender: fx.OWNER, content: { type: "reply", content: fx.contents.text, target: to } as unknown as Content });
		const parsed = await toInbound(replyWith(target), OWNER);
		assert.deepEqual(parsed.kind === "message" && parsed.message.kind === "message" ? [parsed.message.text, parsed.message.replyTo] : parsed, ["hey mochi", { messageId: "GUID-A", text: "Dinner at 8?", fromAgent: true }]);
		const fromStub = await toInbound(replyWith(stub), OWNER);
		assert.deepEqual(fromStub.kind === "message" && fromStub.message.kind === "message" ? fromStub.message.replyTo : fromStub, { messageId: "GUID-S", text: "", fromAgent: false });
	});

	it("maps a reaction from the owner or a user to a tapback and drops a stranger's", async () => {
		const USER = "+15550100002";
		const target = fx.message(log, { id: "GUID-A", direction: "outbound", content: { type: "text", text: "Dinner at 8?" } });
		const reactionFrom = (sender: string, emoji: string) => fx.message(log, { id: `GUID-A:reaction:${emoji}`, sender, content: { type: "reaction", emoji, target } as unknown as Content });
		assert.deepEqual(await toInbound(reactionFrom("+1 555 010 0002", "👍"), OWNER, [USER]), {
			kind: "message",
			message: { kind: "tapback", channel: "imessage", messageId: "GUID-A:reaction:👍", on: "GUID-A", emoji: "👍", onText: "Dinner at 8?", fromAgent: true, at: new Date("2026-10-05T08:32:00Z"), person: USER },
		});
		const fromOwner = await toInbound(reactionFrom(fx.OWNER, "🔥"), OWNER, [USER]);
		assert.deepEqual(fromOwner.kind === "message" && fromOwner.message.kind === "tapback" ? [fromOwner.message.emoji, "person" in fromOwner.message] : fromOwner, ["🔥", false]);
		assert.deepEqual(await toInbound(reactionFrom("+15551234567", "👍"), OWNER, [USER]), { kind: "ignored", reason: "not-owner" });
	});

	it("maps image, file and voice content to attachments and ignores signal-only content", async () => {
		const map = async (content: Parameters<typeof fx.message>[1]["content"]) => {
			const parsed = await toInbound(fx.message(log, { id: "m", sender: fx.OWNER, content }), OWNER);
			return parsed.kind === "message" && parsed.message.kind === "message" ? parsed.message.attachments : parsed.kind === "ignored" ? parsed.reason : undefined;
		};
		assert.deepEqual(await map(fx.contents.photo), [{ kind: "image", mimeType: "image/heic", bytes: new Uint8Array(Buffer.from("heic")) }]);
		assert.deepEqual(await map(fx.contents.pdf), [{ kind: "file", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("pdf")) }]);
		assert.deepEqual(await map(fx.contents.voice), [{ kind: "audio", mimeType: "audio/x-caf", bytes: new Uint8Array(Buffer.from("caf")) }]);
		assert.equal(await map(fx.contents.typing), "empty");
	});
});

describe("imessage adapter", () => {
	it("delivers only owner messages, then sends bubbles, types and reacts with typed tapbacks in the owner's space", async () => {
		const log = fx.events();
		const ownerSpace = fx.space(log, fx.OWNER_DM);
		const fake = fx.app(ownerSpace, [
			fx.message(log, { id: "GUID-STRANGER", sender: "+15551234567", content: fx.contents.text }),
			fx.message(log, { id: "GUID-OWNER", sender: fx.OWNER, content: fx.contents.text }),
		]);
		const channel = channelWith(fake);
		const received: Inbound[] = [];
		const controller = new AbortController();
		let arrived: () => void = () => {};
		const done = new Promise<void>((resolve) => (arrived = resolve));
		const running = channel.run(async (m) => {
			received.push(m);
			arrived();
		}, controller.signal);
		await done;
		assert.deepEqual(received.map((m) => m.messageId), ["GUID-OWNER"]);
		assert.deepEqual(log.read, ["GUID-OWNER"], "only the accepted message gets a read receipt");

		await channel.send({ kind: "text", text: `${"a".repeat(4000)} tail` });
		await channel.send({ kind: "link", url: "https://example.com" });
		await channel.send({ kind: "file", name: "plan.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) });
		await channel.typing(true);
		await channel.typing(false);
		await channel.react?.("GUID-OWNER", "laugh");
		await channel.react?.("GUID-OWNER", "love");
		await channel.react?.("GUID-OWNER", "none");
		assert.deepEqual(log.sent, [
			{ space: fx.OWNER_DM, text: "a".repeat(4000) },
			{ space: fx.OWNER_DM, text: "tail" },
			{ space: fx.OWNER_DM, link: "https://example.com" },
			{ space: fx.OWNER_DM, file: "plan.pdf" },
		]);
		assert.deepEqual(log.typing, [`${fx.OWNER_DM}:on`, `${fx.OWNER_DM}:off`]);
		assert.deepEqual(log.reacted, [
			{ id: "GUID-OWNER", emoji: "😂" },
			{ id: "GUID-OWNER", emoji: "❤️" },
		]);
		assert.deepEqual(log.unsent, ["GUID-OWNER:😂", "GUID-OWNER:❤️"]);

		controller.abort();
		await running;
		assert.equal(await fake.stopped(), true);
		await assert.rejects(channel.send({ kind: "text", text: "after stop" }), ChannelDown);
	});

	it("replies to a user in the user's own DM and to the owner in the owner's", async () => {
		const USER = "+15550100002";
		const USER_DM = "any;-;+15550100002";
		const log = fx.events();
		const ownerSpace = fx.space(log, fx.OWNER_DM);
		const userSpace = fx.space(log, USER_DM);
		const fake = { ...fx.app(ownerSpace, []), dm: async (handle: string) => (handle === USER ? userSpace : ownerSpace) };
		const channel = channelWith(fake, { users: [USER] });
		const controller = new AbortController();
		const running = channel.run(async () => {}, controller.signal);
		await new Promise((resolve) => setImmediate(resolve));
		await channel.send({ kind: "text", text: "for the user" }, USER);
		await channel.typing(true, USER);
		await channel.send({ kind: "text", text: "for the owner" }, undefined, { replyTo: "GUID-R" });
		assert.deepEqual(log.sent, [
			{ space: USER_DM, text: "for the user" },
			{ space: fx.OWNER_DM, text: "for the owner", replyTo: "GUID-R" },
		]);
		assert.deepEqual(log.typing, [`${USER_DM}:on`]);
		controller.abort();
		await running;
	});

	it("opens the owner's DM before any message and looks up a message it did not receive", async () => {
		const log = fx.events();
		const old = fx.message(log, { id: "GUID-OLD", sender: fx.OWNER, content: fx.contents.text });
		const channel = channelWith(fx.app(fx.space(log, fx.OWNER_DM, [old]), []));
		const controller = new AbortController();
		const running = channel.run(async () => {}, controller.signal);
		await new Promise((resolve) => setImmediate(resolve));
		await channel.send({ kind: "text", text: "morning" });
		await channel.react?.("GUID-OLD", "like");
		assert.deepEqual(log.sent, [{ space: fx.OWNER_DM, text: "morning" }]);
		assert.deepEqual(log.reacted, [{ id: "GUID-OLD", emoji: "👍" }]);
		await assert.rejects(channel.react?.("GUID-MISSING", "like") ?? Promise.resolve(), /not found/);
		controller.abort();
		await running;
	});

	it("maps every send failure to one delivery error class", async () => {
		const sendWith = async (fail: unknown) => {
			const log = fx.events();
			const channel = channelWith(fx.app(fx.space(log, fx.OWNER_DM, [], fail), []));
			const controller = new AbortController();
			const running = channel.run(async () => {}, controller.signal);
			await new Promise((resolve) => setImmediate(resolve));
			const error = await channel.send({ kind: "file", name: "a.heic", mimeType: "image/heic", bytes: new Uint8Array([1]) }).then(() => undefined, (e: unknown) => e);
			controller.abort();
			await running;
			return error;
		};
		const grpc = (grpcCode: number) => Object.assign(new Error(`grpc ${grpcCode}`), { grpcCode });
		assert.ok((await sendWith(grpc(14))) instanceof ChannelDown, "UNAVAILABLE never left");
		assert.ok((await sendWith(grpc(4))) instanceof SendUnknown, "a timed-out send has an unknown outcome");
		assert.ok((await sendWith(grpc(3))) instanceof SendRejected, "a refused attachment is rejected");
		assert.ok((await sendWith(new Error("socket hang up"))) instanceof SendUnknown);
		await assert.rejects(channelWith(fx.app(fx.space(fx.events(), fx.OWNER_DM), [])).send({ kind: "text", text: "before run" }), ChannelDown);
	});
});

const until = async (done: () => boolean) => {
	while (!done()) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("imessage link", () => {
	it("judges an ended stream or failed probes a rebuild, and silence only a probe", () => {
		const at = (lastSignalAt: number, failedProbes = 0, ended = false) => judge({ lastSignalAt, failedProbes, ended }, 10 * 60_000, LINK);
		assert.deepEqual([at(10 * 60_000 - 1), at(0), at(0, 1), at(0, 2), at(10 * 60_000, 0, true)], ["none", "probe", "probe", "rebuild", "rebuild"]);
	});

	it("answers messages sent while mochi was down once each after it restarts and catches up", async () => {
		const dir = await tempDir();
		const log = fx.events();
		const all = [1, 2, 3, 4, 5].map((sequence) => ({ ...fx.message(log, { id: `GUID-${sequence}`, sender: fx.OWNER, content: fx.contents.text }), sequence }));
		const life = async (live: readonly IMessageMessage[], answers: readonly string[]) => {
			const faux = newFaux();
			faux.setResponses(answers.map((answer) => fauxAssistantMessage(answer)));
			const line = fx.app(fx.space(log, fx.OWNER_DM), live, all);
			const channel = channelWith(line);
			const mochi = await openTestMochi(dir, faux, new Map([["imessage", channel]]));
			const cursor = async () => (await mochi.harness.snapshot(InboundCursorDoc, "imessage", BACKGROUND_CONTEXT))?.sequence ?? null;
			const controller = new AbortController();
			const sink = async (message: Inbound) => {
				await ingest(mochi.line, message, BACKGROUND_CONTEXT);
				await turnsSettled(mochi.harness);
			};
			const running = channel.run(sink, controller.signal, cursor);
			await until(() => faux.state.callCount === answers.length);
			await turnsSettled(mochi.harness);
			const result = { calls: faux.state.callCount, catchUps: [...line.catchUps], cursor: await cursor() };
			controller.abort();
			await running;
			await mochi.close();
			return result;
		};
		assert.deepEqual(await life(all.slice(0, 3), ["re 1", "re 2", "re 3"]), { calls: 3, catchUps: [], cursor: 3 });
		assert.deepEqual(await life([all[2]!], ["re 4", "re 5"]), { calls: 2, catchUps: [3], cursor: 5 }, "a replay of 3 changes nothing");
		assert.deepEqual(log.sent.map((sent) => sent.text), ["re 1", "re 2", "re 3", "re 4", "re 5"]);
	});

	it("rebuilds only after failed probes, sends the owner nothing, and is down meanwhile", async () => {
		const log = fx.events();
		let probes = 0;
		const grpc = (code: number, message: string) => Object.assign(new Error(message), { grpcCode: code });
		// Photon answers the made-up probe id with INVALID_ARGUMENT while the link is up, then UNAVAILABLE once it drops.
		const getMessage = async () => {
			throw ++probes > 4 ? grpc(14, "UNAVAILABLE") : grpc(3, "Expected message resource GUID");
		};
		const space = { ...fx.space(log, fx.OWNER_DM), getMessage };
		const logged: string[] = [];
		const channel = channelWith(fx.app(space, []), { link: { ...LINK, tickMs: 5, silentProbeMs: 20 }, log: (event) => void logged.push(event) });
		const controller = new AbortController();
		const running = channel.run(async () => {}, controller.signal);
		await until(() => logged.length > 0);
		await assert.rejects(channel.send({ kind: "text", text: "while rebuilding" }), ChannelDown);
		controller.abort();
		await running;
		assert.deepEqual({ probes, logged, sent: log.sent }, { probes: 6, logged: ["imessage.rebuilt"], sent: [] }, "four idle probes passed without a rebuild");
	});
});
