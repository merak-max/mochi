import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineDoc, type Harness, type TaskId, type TaskRecord } from "@earendil-works/pi-durable";
import type { Log } from "../log.ts";
import { allPages } from "../pages.ts";
import { parseWith } from "../parse.ts";
import type { Definitions } from "../agents/definitions.ts";
import { addSchedule, live, scanSchedules, type ScheduleTask, validateSchedule } from "./schedule.ts";
import { type Schedule, scheduleOfEntry, TriggerEntrySchema } from "./types.ts";

type BoardTask = {
	id: number;
	title: string;
	due?: string;
	bots: string[];
	status: string;
	log: { at: string; by: string; text: string }[];
};

/** The board as it was stored, read once to carry its open dues over as `at` schedules, then retired. */
const BoardDoc = defineDoc<{ next: number; tasks: Record<string, BoardTask> }>({
	kind: "mochi.board",
	version: 1,
	scope: "session",
	initial: () => ({ next: 1, tasks: {} }),
	checkpointWhen: () => false,
});

const OLD_KINDS = ["mochi.trigger", "mochi.board-sweep", "mochi.proc"] as const;

function boardPrompt(task: BoardTask): string {
	return [
		`A promise from the board is due: ${task.title}`,
		`Due ${task.due}. Owed by ${task.bots.join(", ")}.`,
		...task.log.map((entry) => `- ${entry.at} ${entry.by}: ${entry.text}`),
		"",
		"Do what it needs now. notify the owner only if they must act or asked to be told. When it needs more time, say so in a notify with the date, so root can schedule the next step.",
	].join("\n");
}

function boardSchedule(task: BoardTask): Schedule {
	const lead = task.bots[0] ?? "root";
	const schedule: Schedule = { id: `board-${task.id}`, when: { at: task.due! }, prompt: boardPrompt(task) };
	if (lead === "root") schedule.model = "brain";
	else schedule.agent = lead;
	return schedule;
}

type Plan = { readonly create: { readonly schedule: Schedule; readonly origin: "model" | "config"; readonly here?: ConversationId }[]; readonly abort: TaskId[]; readonly dropped: BoardTask[] };

/**
 * Carries the three old schedulers into `mochi.schedule`, once and idempotently: each live `mochi.trigger` becomes a
 * schedule in its conversation, each live `mochi.proc` a process schedule, and each open or waiting board task with a
 * due an `at` schedule `board-<id>`. A stored trigger's `profile` becomes `agent`. The old tasks are aborted after the
 * commit; with no definition left they end orphaned. A board task with no due has no time to fire and is dropped, and the board document is retired.
 * Delete this file once the live store has run it.
 */
export async function migrateSchedulers(harness: Harness, task: ScheduleTask, catalog: Definitions, log: Log, context: Context): Promise<void> {
	const board = await harness.snapshot(BoardDoc, context);
	const plan = await harness.commit(async (tx): Promise<Plan> => {
		const existing = await scanSchedules(tx);
		const have = new Set(existing.filter(live).map((record) => record.input.schedule.id));
		const plan: Plan = { create: [], abort: [], dropped: [] };
		for (const kind of OLD_KINDS) {
			const records = (await allPages((cursor) => tx.scanTasks({ kind }, 256, cursor))) as TaskRecord<Record<string, unknown>, unknown, unknown>[];
			for (const record of records) {
				if (record.state.status === "terminal" || record.abortRequested) continue;
				plan.abort.push(record.id);
				if (kind === "mochi.trigger") {
					const input = record.input as { trigger: Record<string, unknown>; origin: "model" | "config" };
					const { profile, ...rest } = input.trigger;
					const trigger = profile === undefined ? rest : { ...rest, agent: profile };
					const schedule = validateSchedule(scheduleOfEntry(parseWith(TriggerEntrySchema, trigger, `stored trigger ${record.id}`)));
					if (!have.has(schedule.id)) plan.create.push({ schedule, origin: input.origin, here: record.conversationId });
				}
				if (kind === "mochi.proc") {
					const input = record.input as { name: string; pid: number; watch?: string };
					const schedule: Schedule = { id: `proc-${input.name}`, when: { process: input.watch === undefined ? { name: input.name, pid: input.pid } : input }, prompt: `Output of process ${input.name}, last lines:` };
					if (!have.has(schedule.id)) plan.create.push({ schedule, origin: "model", here: record.conversationId });
				}
			}
		}
		for (const item of Object.values(board?.tasks ?? {})) {
			if (item.status !== "open" && item.status !== "waiting") continue;
			if (item.due === undefined) {
				plan.dropped.push(item);
				continue;
			}
			const schedule = validateSchedule(boardSchedule(item));
			if (!have.has(schedule.id)) plan.create.push({ schedule, origin: "model" });
		}
		for (const { schedule, origin, here } of plan.create) await addSchedule(tx, task, { schedule, origin }, existing, catalog, here);
		if (board !== undefined) await tx.retireDoc(BoardDoc);
		return plan;
	}, context);
	for (const id of plan.abort) await harness.abortTask(id, context);
	for (const item of plan.dropped) log("schedule.board_dropped", { task: item.id, title: item.title, status: item.status, ...(item.due === undefined ? {} : { due: item.due }) });
	if (plan.create.length > 0 || plan.abort.length > 0) log("schedule.migrated", { created: plan.create.map((each) => each.schedule.id), aborted: plan.abort.length, dropped: plan.dropped.length });
}
