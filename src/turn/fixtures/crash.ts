// One daemon life for the kill test: node src/turn/fixtures/crash.ts <dir> <scenario> <kill point | none>
// It SIGKILLs itself at the kill point, so the next life resumes from whatever the store holds. Bubbles are appended
// to <dir>/sent.jsonl before send returns; the last life prints a summary line.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { JsonValue } from "@earendil-works/chord";
import { type CommitChange, type ConversationId, ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import { type Attachment, type Channel, ChannelDown, type OwnerInbound } from "../../channels/types.ts";
import { messageText } from "../../text.ts";
import { fixedClassify, newFaux, openTestMochi, PROFILES, turnsSettled } from "../../test-support.ts";
import { createSeatConversation } from "../../seats.ts";
import { InboundCursorDoc, ingest, NOTIFY_ENTRY } from "../turn.ts";

const context = BACKGROUND_CONTEXT;
const [dir, scenario, kill] = process.argv.slice(2) as [string, string, string];
const ANSWERS = { m1: "A first bubble.\n\nA second bubble.\n\nA third bubble.", m2: "B first bubble.\n\nB second bubble." };
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const die = () => process.kill(process.pid, "SIGKILL");

const faux = newFaux();
const respond = (transcript: TranscriptContext) => {
	const last = transcript.messages.findLast((message) => message.role !== "system");
	if (last?.role === "toolResult") return fauxAssistantMessage("done");
	const text = last === undefined ? "" : messageText(last);
	if (text.includes("please notify")) return fauxAssistantMessage(fauxToolCall("notify", { text: "N first bubble.\n\nN second bubble." }), { stopReason: "toolUse" });
	return fauxAssistantMessage(text.includes("id=m2") ? ANSWERS.m2 : ANSWERS.m1);
};
faux.setResponses(Array.from({ length: 20 }, () => respond));

let sends = 0;
const imessage: Channel = {
	profile: PROFILES.imessage,
	run: async () => {},
	typing: async () => {},
	send: async (bubble) => {
		if (scenario === "down" && kill !== "none") throw new ChannelDown("offline");
		appendFileSync(join(dir, "sent.jsonl"), `${JSON.stringify(bubble.kind === "text" ? bubble.text : bubble.kind)}\n`);
		if (kill === "bubble-sent" && ++sends === 1) die();
	},
};

type Turn = { kind: string; input: { source: string; key?: string }; state: { status: string; checkpoint?: { phase: string; sent?: number; outage?: JsonValue } } };
const turn = (change: CommitChange): Turn | undefined => (change.type === "task" && change.value.kind === "mochi.turn" ? (change.value as unknown as Turn) : undefined);
const KILLS: Record<string, (change: CommitChange) => boolean> = {
	"ingest-commit": (change) => turn(change)?.input.source === "owner" && turn(change)?.state.status === "pending",
	submit: (change) => change.type === "submission" && change.value.requestId === "imessage:m1",
	settled: (change) => turn(change)?.state.checkpoint?.phase === "claim",
	"bubble-checkpoint": (change) => turn(change)?.state.checkpoint?.sent === 1,
	"down-sleep": (change) => turn(change)?.state.checkpoint?.outage != null,
	"notify-open": (change) => turn(change)?.input.source === "run" && turn(change)?.state.status === "pending",
	record: (change) => change.type === "submission" && change.value.requestId?.startsWith("record:") === true,
	"between-turns": (change) => turn(change)?.input.key === "imessage:m1" && turn(change)?.state.status === "terminal",
};

const mochi = await openTestMochi(dir, faux, new Map([["imessage", imessage]]), fixedClassify(1), [], { retry: { firstMs: 200, maxMs: 400, giveUpMs: 60_000 } });
const killAt = KILLS[kill];
if (killAt !== undefined) mochi.harness.subscribeCommits(({ changes }) => void (changes.some(killAt) && die()));
mochi.harness.resume();

/** Each step runs once across lives: its marker is written before it starts. */
async function once(name: string, step: () => Promise<unknown>): Promise<void> {
	const marker = join(dir, `started-${name}`);
	if (existsSync(marker)) return;
	writeFileSync(marker, "");
	await step();
}

const owner = (messageId: string, attachments: readonly Attachment[] = []): OwnerInbound => ({
	kind: "message",
	channel: "imessage",
	messageId,
	text: `question ${messageId}`,
	at: new Date("2026-10-05T08:32:00Z"),
	attachments,
	sequence: Number(messageId.slice(1)),
});

if (scenario === "notify") {
	const file = join(dir, "run-conversation");
	await once("run", async () => {
		const run = await mochi.harness.commit((tx) => createSeatConversation(tx, "run", { kind: "ownerless" }), context);
		writeFileSync(file, String(run));
		await (await mochi.harness.conversation(run, context))!.submit({ type: "input", content: "please notify", requestId: "run:1" }, context);
	});
	await (await mochi.harness.conversation(Number(readFileSync(file, "utf8")) as ConversationId, context))!.waitForIdle(context);
} else {
	const attachments = scenario === "image" ? [{ kind: "image" as const, mimeType: "image/png", bytes: PIXEL }] : [];
	await once("m1", () => ingest(mochi.line, owner("m1", attachments), context));
	if (scenario === "ordered") {
		await once("m2", async () => {
			const first = await mochi.harness.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, "imessage:m1"), context);
			await (await mochi.harness.submission(first!.id, context))!.wait(context);
			await ingest(mochi.line, owner("m2"), context);
		});
	}
}
await turnsSettled(mochi.harness);

const tasks = (await mochi.harness.commit((tx) => tx.scanTasks({ kind: "mochi.turn" }, 100), context)).items;
const entries = [...(await mochi.root.entries({}, 100, undefined, context)).items].reverse();
const summary = {
	sent: existsSync(join(dir, "sent.jsonl")) ? readFileSync(join(dir, "sent.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string) : [],
	turns: tasks.map((task) => (task.state.status === "terminal" && task.state.outcome.status === "completed" ? task.state.outcome.result : task.state.status)),
	records: entries.filter((entry) => entry.kind === NOTIFY_ENTRY).length,
	inputs: entries.filter((entry) => UserEntry.is(entry)).map((entry) => entry.model?.[0]?.content ?? null),
	modelCalls: faux.state.callCount,
	cursor: (await mochi.harness.snapshot(InboundCursorDoc, "imessage", context))?.sequence ?? null,
};
await mochi.close();
process.stdout.write(`${JSON.stringify(summary)}\n`);
