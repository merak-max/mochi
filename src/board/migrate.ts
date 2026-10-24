import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineDoc, type Harness, type TaskId, type TaskRecord } from "@earendil-works/pi-durable";
import type { Log } from "../log.ts";
import { allPages } from "../pages.ts";
import type { Definitions } from "../agents/definitions.ts";
import { BoardDoc, type BoardTasks, checkItem, type Item, putItem, ROOT_OWNER, type WebhookAuth } from "./board.ts";

type OldBoardTask = { id: number; title: string; due?: string; bots: string[]; status: string; log: { at: string; by: string; text: string }[] };

const OldBoardDoc = defineDoc<{ next: number; tasks: Record<string, OldBoardTask> }>({
	kind: "mochi.board",
	version: 1,
	scope: "session",
	initial: () => ({ next: 1, tasks: {} }),
	checkpointWhen: () => false,
});

type OldGate = { question: string; yes: string; no: string; threshold?: number };
type OldTrigger = {
	kind: "cron" | "at" | "webhook";
	id: string;
	prompt: string;
	cron?: string;
	tz?: string;
	at?: string;
	auth?: WebhookAuth;
	check?: string[];
	profile?: string;
	agent?: string;
	notifyWhen?: OldGate;
	steps?: ({ classify: OldGate & { on?: "input" | "output" } } | { model: object })[];
};

const OLD_KINDS = ["mochi.trigger", "mochi.board-sweep", "mochi.proc", "mochi.schedule"] as const;

/** Old prompts end their run with notify; now the final text is the message. */
const NOW = "\n\n(Since 2026-10-24 there is no notify tool: your final text is the message to the owner, verbatim. Reply NO_REPLY when nothing needs them.)";

/** A trigger with no profile ran in a fresh conversation on a strong model; the bundled mochi definition does the same. */
const FRESH = "mochi";

function triggerItem(trigger: OldTrigger): Item {
	const owner = trigger.agent ?? trigger.profile ?? FRESH;
	let text = trigger.prompt;
	let gate: OldGate | undefined = trigger.notifyWhen;
	for (const step of trigger.steps ?? []) {
		if (!("classify" in step)) continue;
		if (step.classify.on === "output") gate = step.classify;
		else text = `First judge this: ${step.classify.question} Yes means ${step.classify.yes}. No means ${step.classify.no}. On no, reply NO_REPLY and do nothing else.\n\n${text}`;
	}
	const item: Item = { id: trigger.id, text: text + NOW, owner };
	if (trigger.kind === "cron") item.when = { cron: trigger.cron!, tz: trigger.tz! };
	if (trigger.kind === "at") item.when = { at: trigger.at! };
	if (trigger.kind === "webhook") item.when = { webhook: { auth: trigger.auth! } };
	if (trigger.check !== undefined) item.check = trigger.check;
	if (gate !== undefined) item.gate = { question: gate.question, yes: gate.yes, no: gate.no, threshold: gate.threshold ?? 0.5 };
	return item;
}

async function boardItem(task: OldBoardTask, definitions: Definitions): Promise<Item> {
	const lead = task.bots[0] ?? ROOT_OWNER;
	const known = (await definitions.all()).some((definition) => definition.name === lead);
	const owner = known ? lead : ROOT_OWNER;
	const lines = [`A promise from the board: ${task.title}`, ...task.log.map((entry) => `- ${entry.at} ${entry.by}: ${entry.text}`)];
	const item: Item = { id: `board-${task.id}`, text: lines.join("\n"), owner };
	if (task.due !== undefined) item.when = { at: task.due };
	return item;
}

/**
 * Carries the old schedulers onto the board, once and idempotently: each live trigger and each open or waiting board
 * task becomes an item, and the old tasks are aborted after the commit. A trigger's model and thinking go: the item runs
 * on its owner's. Delete this file once the live store has run it.
 */
export async function migrateBoard(harness: Harness, tasks: BoardTasks, line: ConversationId, definitions: Definitions, log: Log, context: Context): Promise<void> {
	const old = await harness.snapshot(OldBoardDoc, context);
	const live: TaskRecord<Record<string, unknown>, unknown, unknown>[] = [];
	await harness.commit(async (tx) => {
		for (const kind of OLD_KINDS) {
			const records = (await allPages((cursor) => tx.scanTasks({ kind }, 256, cursor))) as TaskRecord<Record<string, unknown>, unknown, unknown>[];
			for (const record of records) if (record.state.status !== "terminal" && !record.abortRequested) live.push(record);
		}
	}, context);
	const items: Item[] = [];
	for (const record of live) {
		if (record.kind !== "mochi.trigger") continue;
		items.push(triggerItem((record.input as { trigger: OldTrigger }).trigger));
	}
	for (const task of Object.values(old?.tasks ?? {})) {
		if (task.status === "open" || task.status === "waiting") items.push(await boardItem(task, definitions));
	}
	for (const item of items) await checkItem(item, definitions);
	if (items.length === 0 && live.length === 0 && old === undefined) return;
	const now = Date.now();
	const created = await harness.commit(async (tx) => {
		const board = await tx.doc(BoardDoc);
		const created: string[] = [];
		for (const item of items) {
			if (board.items[item.id] !== undefined) continue;
			await putItem(tx, tasks, line, item, now);
			created.push(item.id);
		}
		if (old !== undefined) await tx.retireDoc(OldBoardDoc);
		return created;
	}, context);
	for (const record of live) await harness.abortTask(record.id as TaskId, context);
	log("board.migrated", { created, aborted: live.map((record) => `${record.kind}:${record.id}`) });
}
