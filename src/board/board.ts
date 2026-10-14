import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineTask, defineTool, type Harness, ROOT_CONVERSATION_ID, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { startFork } from "../fork/fork.ts";
import { journaled } from "../journal.ts";
import type { Log } from "../log.ts";
import { forkPoint } from "../seats.ts";

// The board: what mochi and its profiles owe, so nothing promised is forgotten. One session document in root's home.
// The sweep reads it in code each minute and wakes a model only for a task whose due time has passed: it forks root
// with the task as the brief, once per due time.

const STATUSES = ["open", "waiting", "done", "dropped"] as const;
type Status = (typeof STATUSES)[number];

type BoardTask = {
	id: number;
	title: string;
	/** ISO time with offset. Absent: no reminder, the task waits until someone picks it up. */
	due?: string;
	/** Who works it: `root` or a profile name. The first one is the lead and owns the status. */
	bots: string[];
	/** Who is working it now, until when (ms). A live claim by someone else refuses another claim. */
	claim?: { by: string; until: number };
	status: Status;
	log: { at: string; by: string; text: string }[];
	/** The `due` the sweep last acted on, when, and how often. A woken task left untouched is woken again, up to `WAKES_MAX`. */
	nudged?: string;
	nudgedAt?: number;
	wakes?: number;
};

const BoardDoc = defineDoc<{ next: number; tasks: Record<string, BoardTask> }>({
	kind: "mochi.board",
	version: 1,
	scope: "session",
	initial: () => ({ next: 1, tasks: {} }),
});

/** The task one board_add call made, scoped to that call's task. */
const BoardCallDoc = defineDoc<{ id: number | null }>({ kind: "mochi.board-call", version: 1, scope: "task", initial: () => ({ id: null }) });

const parseDue = (due: string): number => {
	const at = Date.parse(due);
	if (Number.isNaN(at) || !/[zZ]|[+-]\d\d:?\d\d$/.test(due)) throw new Error(`Invalid due "${due}"; use ISO 8601 with an offset, such as 2026-10-15T09:00:00+05:30.`);
	return at;
};

const append = (task: BoardTask, by: string, text: string, now: number) => {
	task.log.push({ at: new Date(now).toISOString(), by, text });
};

const live = (task: BoardTask) => task.status === "open" || task.status === "waiting";

/** A woken task with no log line since is woken again after this long. */
const REWAKE_MS = 24 * 60 * 60_000;
/** Wakes for one due time before the sweep stops trying and tells the owner. */
const WAKES_MAX = 3;

const lastLog = (task: BoardTask) => Date.parse(task.log.at(-1)?.at ?? "1970-01-01T00:00:00Z");

/**
 * Tasks the sweep should wake now: live and due by `now`, and either not yet woken for this due time, or woken, left
 * untouched for `REWAKE_MS` (a fork that crashed or stopped without board_update), and under `WAKES_MAX`.
 */
function dueTasks(tasks: readonly BoardTask[], now: number): BoardTask[] {
	return tasks.filter((task) => {
		if (!live(task) || task.due === undefined || parseDue(task.due) > now) return false;
		if (task.nudged !== task.due) return true;
		const stuck = task.nudgedAt !== undefined && now - task.nudgedAt >= REWAKE_MS && lastLog(task) <= task.nudgedAt;
		return stuck && (task.wakes ?? 1) <= WAKES_MAX;
	});
}

function boardBrief(task: BoardTask): string {
	const tries = task.nudged === task.due ? task.wakes ?? 1 : 0;
	if (tries >= WAKES_MAX) {
		return `Board task #${task.id} (${task.title}) was woken ${tries} times for due ${task.due} and nobody updated it. Read it with tools.board_list, tell the owner in one notify that it is stuck and why if you can see why, then set it to waiting with tools.board_update and no due.`;
	}
	const lines = [
		`Board task #${task.id} is due: ${task.title}`,
		`Due ${task.due}. Bots: ${task.bots.join(", ")} (the first leads).`,
		...task.log.slice(-10).map((entry) => `- ${entry.at} ${entry.by}: ${entry.text}`),
		"",
		"The board woke you for this task. Claim it with tools.board_claim, then do what it needs now. " +
			"Record what happened with tools.board_update: done when finished, waiting with a new due when it needs time, or a log line. " +
			"notify the owner only if they must act or asked to be told. Your answer goes nowhere.",
	];
	return lines.join("\n");
}

const Bot = Type.String({ pattern: "^(root|[a-z0-9]+(-[a-z0-9]+)*)$" });
const TaskSchema = Type.Object({
	id: Type.Number(),
	title: Type.String(),
	due: Type.Optional(Type.String()),
	bots: Type.Array(Type.String()),
	status: Type.String(),
	log: Type.Array(Type.Object({ at: Type.String(), by: Type.String(), text: Type.String() })),
	claim: Type.Optional(Type.Object({ by: Type.String(), until: Type.Number() })),
});

/** Claims last this long unless the claimer says otherwise; a crashed worker's claim lapses. */
const CLAIM_MS = 2 * 60 * 60_000;

/** `by`: who writes, `root` or the calling profile's name. */
export function boardFns(deps: { readonly by: (tx: Tx, conversation: ConversationId) => Promise<string>; readonly now: () => number }): ToolRegistration[] {
	const view = (task: BoardTask) => {
		const { nudged: _nudged, nudgedAt: _at, wakes: _wakes, ...rest } = task;
		return rest;
	};
	return [
		defineTool({
			name: "board_add",
			description:
				"Put a promise or follow-up on the board. due (ISO with offset) wakes the lead then. bots: root or profile paths, lead first.",
			parameters: Type.Object({
				title: Type.String({ minLength: 1 }),
				due: Type.Optional(Type.String()),
				bots: Type.Optional(Type.Array(Bot, { minItems: 1 })),
				note: Type.Optional(Type.String()),
			}),
			structuredOutputSchema: TaskSchema,
			replay: "safe",
			execute: async ({ title, due, bots, note }, api, context) => {
				if (due !== undefined) parseDue(due);
				const task = await api.commit(async (tx) => {
					const board = await tx.doc(BoardDoc);
					// Recorded in the same commit, so a rerun of this call finds its task instead of adding it twice.
					const call = await tx.doc(BoardCallDoc, api.taskId);
					const id = call.id ?? board.next;
					call.id = id;
					if (board.tasks[String(id)] === undefined) {
						const created: BoardTask = { id, title, bots: bots ?? ["root"], status: "open", log: [] };
						if (due !== undefined) created.due = due;
						append(created, await deps.by(tx, api.conversationId), note ?? "added", deps.now());
						board.tasks[String(id)] = created;
						board.next = Math.max(board.next, id + 1);
					}
					return JSON.parse(JSON.stringify(board.tasks[String(id)])) as BoardTask;
				}, context);
				return { structuredOutput: view(task) };
			},
		}),
		defineTool({
			name: "board_list",
			description: "Board tasks, newest first. Default: open and waiting. bot narrows to tasks naming that bot.",
			parameters: Type.Object({
				status: Type.Optional(Type.Union([...STATUSES, "all"].map((status) => Type.Literal(status)))),
				bot: Type.Optional(Bot),
			}),
			structuredOutputSchema: Type.Array(TaskSchema),
			replay: "safe",
			execute: async ({ status, bot }, api, context) => {
				const board = (await api.snapshot(BoardDoc, context)) ?? BoardDoc.definition.initial();
				const tasks = Object.values(board.tasks)
					.filter((task) => (status === undefined ? live(task) : status === "all" || task.status === status))
					.filter((task) => bot === undefined || task.bots.includes(bot))
					.sort((a, b) => b.id - a.id);
				return { structuredOutput: tasks.map(view) };
			},
		}),
		defineTool({
			name: "board_update",
			description: "Change a board task: status, a new due (wakes the lead again), bots, title, and a log line saying what happened.",
			parameters: Type.Object({
				id: Type.Number(),
				status: Type.Optional(Type.Union(STATUSES.map((status) => Type.Literal(status)))),
				due: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				bots: Type.Optional(Type.Array(Bot, { minItems: 1 })),
				title: Type.Optional(Type.String({ minLength: 1 })),
				note: Type.Optional(Type.String()),
			}),
			structuredOutputSchema: TaskSchema,
			replay: "safe",
			execute: async ({ id, status, due, bots, title, note }, api, context) => {
				if (typeof due === "string") parseDue(due);
				const task = await api.commit(async (tx) => {
					const found = (await tx.doc(BoardDoc)).tasks[String(id)];
					if (found === undefined) throw new Error(`No board task #${id}.`);
					const changes: string[] = [];
					if (status !== undefined && status !== found.status) (found.status = status), changes.push(status);
					if (due === null && found.due !== undefined) delete found.due, changes.push("no due");
					if (typeof due === "string" && due !== found.due) (found.due = due), changes.push(`due ${due}`);
					if (bots !== undefined) (found.bots = bots), changes.push(`bots ${bots.join(", ")}`);
					if (title !== undefined) (found.title = title), changes.push("retitled");
					const text = [changes.join("; "), note].filter((part) => part !== undefined && part !== "").join(": ");
					if (status === "done" || status === "dropped") delete found.claim;
					if (text !== "") append(found, await deps.by(tx, api.conversationId), text, deps.now());
					return JSON.parse(JSON.stringify(found)) as BoardTask;
				}, context);
				return { structuredOutput: view(task) };
			},
		}),
		defineTool({
			name: "board_claim",
			description: "Take a board task before you work it, so no other profile or fork takes it too. Fails while someone else holds it. The claim lapses after hours (default 2), or when you set the task done.",
			parameters: Type.Object({ id: Type.Number(), hours: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }),
			structuredOutputSchema: TaskSchema,
			replay: "safe",
			execute: async ({ id, hours }, api, context) => {
				const task = await api.commit(async (tx) => {
					const found = (await tx.doc(BoardDoc)).tasks[String(id)];
					if (found === undefined) throw new Error(`No board task #${id}.`);
					const by = await deps.by(tx, api.conversationId);
					const now = deps.now();
					if (found.claim !== undefined && found.claim.by !== by && found.claim.until > now) throw new Error(`Board task #${id} is claimed by ${found.claim.by} until ${new Date(found.claim.until).toISOString()}.`);
					found.claim = { by, until: now + (hours === undefined ? CLAIM_MS : hours * 60 * 60_000) };
					append(found, by, "claimed", now);
					return JSON.parse(JSON.stringify(found)) as BoardTask;
				}, context);
				return { structuredOutput: view(task) };
			},
		}),
	];
}

/** How often the sweep reads the board. */
export const SWEEP_EVERY_MS = 60_000;

type SweepState = { readonly phase: "sweep"; readonly next: number };

/** The director: one background task of root. It costs no model call until a task is due. */
export function defineSweep(deps: { readonly harness: () => Harness; readonly everyMs: number; readonly log: Log; readonly toProfile: (name: string, brief: string, key: string, context: Context) => Promise<void> }) {
	return defineTask<null, SweepState, null>({
		name: "mochi.board-sweep",
		version: 1,
		initial: () => ({ phase: "sweep", next: 0 }),
		phases: {
			sweep: async (task, runtime, context) => {
				await runtime.sleep(task.state.checkpoint.next, context);
				const harness = deps.harness();
				const now = runtime.now();
				const due = dueTasks(Object.values((await harness.snapshot(BoardDoc, context))?.tasks ?? {}), now);
				for (const item of due) {
					const lead = item.bots[0] ?? "root";
					if (lead !== "root") {
						const wake = item.nudged === item.due ? (item.wakes ?? 1) + 1 : 1;
						await deps.toProfile(lead, boardBrief(item), `board:${item.id}:${item.due}:${wake}`, context);
						await harness.commit(async (tx) => {
							const current = (await tx.doc(BoardDoc)).tasks[String(item.id)];
							if (current === undefined || item.due === undefined || current.due !== item.due) return;
							current.nudged = item.due;
							current.nudgedAt = now;
							current.wakes = wake;
						}, context);
						deps.log("board.woke", { task: item.id, profile: lead });
						continue;
					}
					const { id, created } = await harness.commit(async (tx) => {
						const at = await forkPoint(tx, ROOT_CONVERSATION_ID);
						const board = await tx.doc(BoardDoc);
						const current = board.tasks[String(item.id)];
						const wake = item.nudged === item.due ? (item.wakes ?? 1) + 1 : 1;
						const woken = await journaled(tx, task.id, `board:${item.id}:${item.due}:${wake}`, () => startFork(tx, ROOT_CONVERSATION_ID, at, { name: `board-${item.id}`, brief: boardBrief(item) }), 64);
						if (current !== undefined && item.due !== undefined && current.due === item.due) {
							current.nudged = item.due;
							current.nudgedAt = now;
							current.wakes = wake;
						}
						return woken;
					}, context);
					if (created) deps.log("board.woke", { task: item.id, agent: id });
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "sweep", next: runtime.now() + deps.everyMs } }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

/** One live sweep, a background task of root, so /stop on root reaches it and the next boot starts a fresh one. */
export async function ensureSweep(harness: Harness, task: ReturnType<typeof defineSweep>, context: Context): Promise<void> {
	await harness.commit(async (tx: Tx) => {
		const running = (await tx.scanTasks({ kind: "mochi.board-sweep" }, 8)).items.some((each) => each.state.status !== "terminal" && !each.abortRequested);
		if (!running) await tx.createTask(task, null, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID as ConversationId, background: true });
	}, context);
}
