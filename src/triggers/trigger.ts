import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Context, JsonValue } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { type Static, Type } from "@earendil-works/pi-ai";
import { type ConversationId, ConversationBusy, configure, defineTask, defineTool, type Harness, type NextTaskState, type Task, type TaskId, type TaskRecord, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { admits, checkGate, type Classify } from "../brain/classifier.ts";
import { bifrostRef } from "../brain/models.ts";
import type { ChannelId } from "../channels/types.ts";
import { journaled } from "../journal.ts";
import type { Log } from "../log.ts";
import { allPages } from "../pages.ts";
import { parseWith } from "../parse.ts";
import { createSeatConversation } from "../seats.ts";
import { type ChatUser, OWNER_ID } from "../config.ts";
import { formatStamp } from "../text.ts";
import { LastInboundDoc, type Line, openTurn, type RunTurn } from "../turn/turn.ts";
import { assertTimeZone, nextCronSlot, parseCron } from "./cron.ts";
import { GateSchema, SeedsSchema, type Trigger, TriggerSchema } from "./types.ts";

// A trigger is a background task of its own ownerless conversation: the input is the definition and the checkpoint the
// next slot, so the task record is the only copy of the schedule. Nothing owns the conversation, so /stop on root never
// reaches it, and trigger_remove aborts the task, not the conversation, so a run that removes its own trigger finishes.

/** A cron slot this late is recorded missed. A once trigger always fires, late if it must. */
export const LATE_MS = 15 * 60_000;
/** A run still going this long after it started is aborted, so a hung run cannot turn every later slot into skipped-busy. */
export const RUN_DEADLINE_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

export type LastSlot = { readonly at: number; readonly result: "done" | "unanswered" | "skipped-busy" | "missed" | "timed-out" | "quiet" | "check-failed" };

const CHECK_TIMEOUT_MS = 5 * 60_000;
const run = promisify(execFile);

/** A cron trigger's `check`: its stdout when it has something, `null` for nothing to do. A failing check throws. */
export async function runCheck(argv: readonly string[]): Promise<string | null> {
	const [file, ...args] = argv as [string, ...string[]];
	const { stdout } = await run(file, args, { timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
	return stdout.trim() === "" ? null : stdout.trim();
}
export type Plan = { readonly kind: "fire" | "miss"; readonly slot: number } | { readonly kind: "listen" | "done" };

export const late = (trigger: Trigger, slot: number, now: number): boolean => trigger.kind === "cron" && now - slot > LATE_MS;

/** What a trigger does next. Without a last slot only slots after `now` count. */
export function plan(trigger: Trigger, last: LastSlot | null, now: number): Plan {
	if (trigger.kind === "webhook") return { kind: "listen" };
	if (trigger.kind === "once") return last === null ? { kind: "fire", slot: Date.parse(trigger.at) } : { kind: "done" };
	const cron = parseCron(trigger.cron);
	let due: number | undefined;
	let next = nextCronSlot(cron, trigger.tz, new Date(last?.at ?? now));
	for (; next !== undefined && next.getTime() <= now; next = nextCronSlot(cron, trigger.tz, next)) due = next.getTime();
	if (due !== undefined) return { kind: late(trigger, due, now) ? "miss" : "fire", slot: due };
	return next === undefined ? { kind: "done" } : { kind: "fire", slot: next.getTime() };
}

export type TriggerState =
	| { readonly phase: "wait"; readonly last: LastSlot | null }
	/** Sleeping to `slot`, so a restart sleeps to the same instant. */
	| { readonly phase: "fire"; readonly slot: number; readonly last: LastSlot | null }
	| { readonly phase: "run"; readonly slot: number; readonly deadline: number; readonly last: LastSlot | null };

/** `origin` lets seed reconcile touch only seeds, never a trigger the model made. */
export type TriggerInput = { readonly trigger: Trigger; readonly origin: "model" | "config" };
export type TriggerTask = Task<TriggerInput, TriggerState, null, object>;
export type TriggerRecord = TaskRecord<TriggerInput, TriggerState, null>;

const iso = (at: number): string => new Date(at).toISOString();

export function defineTrigger({
	timeZone,
	deadlineMs,
	log,
	check = runCheck,
}: { readonly timeZone: string; readonly deadlineMs: number; readonly log: Log; readonly check?: typeof runCheck }): TriggerTask {
	const wait = (last: LastSlot): NextTaskState<TriggerState, null> => ({ status: "running", checkpoint: { phase: "wait", last } });
	return defineTask<TriggerInput, TriggerState, null>({
		name: "mochi.trigger",
		version: 1,
		initial: () => ({ phase: "wait", last: null }),
		phases: {
			wait: async (task, runtime, context) => {
				const { last } = task.state.checkpoint;
				const next = plan(task.input.trigger, last, runtime.now());
				switch (next.kind) {
					case "listen":
						for (;;) await runtime.sleep(runtime.now() + DAY_MS, context);
					case "done":
						return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
					case "miss":
						log("trigger.missed", { id: task.input.trigger.id, slot: iso(next.slot) });
						return runtime.commit(() => wait({ at: next.slot, result: "missed" }), context);
					case "fire":
						return runtime.commit(() => ({ status: "running", checkpoint: { phase: "fire", slot: next.slot, last } }), context);
				}
			},
			fire: async (task, runtime, context) => {
				const { slot, last } = task.state.checkpoint;
				await runtime.sleep(slot, context);
				const now = runtime.now();
				if (late(task.input.trigger, slot, now)) {
					log("trigger.missed", { id: task.input.trigger.id, slot: iso(slot) });
					return runtime.commit(() => wait({ at: slot, result: "missed" }), context);
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run", slot, deadline: now + deadlineMs, last } }), context);
			},
			run: async (task, runtime, context) => {
				const { trigger } = task.input;
				const { slot, deadline } = task.state.checkpoint;
				let payload = "";
				if (trigger.kind === "cron" && trigger.check !== undefined) {
					// Memoized per slot: a check usually advances its own state (mail UIDs), so a restart must not run it twice.
					const key = `check:${iso(slot)}`;
					let found = await runtime.memo<{ out: string | null } | { failed: string }>(key, context);
					if (found === undefined) {
						const argv = trigger.check;
						const result = await check(argv).then((out) => ({ out }), (error: unknown) => ({ failed: String(error).slice(0, 500) }));
						found = await runtime.memo(key, result, context);
					}
					if ("failed" in found) {
						log("trigger.check_failed", { id: trigger.id, slot: iso(slot), error: found.failed });
						return runtime.commit(() => wait({ at: slot, result: "check-failed" }), context);
					}
					if (found.out === null) return runtime.commit(() => wait({ at: slot, result: "quiet" }), context);
					payload = `\n<check_output source="${trigger.id}">\n${found.out}\n</check_output>`;
				}
				const conversation = (await runtime.conversation(runtime.conversationId, context))!;
				const content = `[${trigger.kind} ${trigger.id}] Current time: ${formatStamp(new Date(slot), timeZone)}\n${trigger.prompt}${payload}`;
				let submission;
				try {
					submission = await conversation.submit({ type: "input", content, requestId: `${trigger.kind}:${trigger.id}:${iso(slot)}`, whenBusy: "reject" }, context);
				} catch (error) {
					if (!(error instanceof ConversationBusy)) throw error;
					log("trigger.skipped_busy", { id: trigger.id, slot: iso(slot) });
					return runtime.commit(() => wait({ at: slot, result: "skipped-busy" }), context);
				}
				const race = withCancel(context);
				const settled = await Promise.race([submission.wait(race.context), runtime.sleep(deadline, race.context).then(() => undefined)]).finally(() => race.cancel());
				if (settled === undefined) {
					await conversation.abort(context);
					log("trigger.timed_out", { id: trigger.id, slot: iso(slot) });
				}
				await runtime.commit(() => wait({ at: slot, result: settled?.status ?? "timed-out" }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

const live = (task: TriggerRecord): boolean => task.state.status !== "terminal" && !task.abortRequested;

/** Trigger tasks in creation order, live and settled. */
export async function scanTriggers(tx: Pick<Tx, "scanTasks">, conversationId?: ConversationId): Promise<TriggerRecord[]> {
	const query = { kind: "mochi.trigger", ...(conversationId === undefined ? {} : { conversationId }) };
	return (await allPages((cursor) => tx.scanTasks(query, 256, cursor))) as unknown as TriggerRecord[];
}

export const liveTrigger = async (tx: Pick<Tx, "scanTasks">, id: string): Promise<TriggerRecord | undefined> =>
	(await scanTriggers(tx)).findLast((task) => live(task) && task.input.trigger.id === id);

const INSTRUCTIONS =
	"This conversation is an unattended trigger run, not a chat with the owner. Nobody reads your answers here. " +
	"The only way to reach the owner is the notify tool; call it only when something needs the owner's attention, " +
	"and otherwise finish with a one-line note of what you checked. Read your earlier runs here before repeating anything. " +
	"End a trigger that has served its purpose with tools.trigger_remove in code.";

/**
 * Creates the trigger task in the caller's commit; `existing` is `scanTriggers`, read before the commit's first write.
 * The newest earlier trigger with the same id lends its conversation, so an edited trigger keeps its runs to read; a
 * live one is returned for the caller to abort after the commit.
 */
export async function addTrigger(
	tx: Tx,
	task: TriggerTask,
	input: TriggerInput,
	existing: readonly TriggerRecord[],
	conversation?: ConversationId,
): Promise<{ readonly id: TaskId; readonly replaced: TaskId | undefined }> {
	const previous = existing.findLast((record) => record.input.trigger.id === input.trigger.id);
	const { model, thinking } = input.trigger;
	const agent = { ...(model === undefined ? {} : { model: bifrostRef(model) }), ...(thinking === undefined ? {} : { thinkingLevel: thinking }) };
	const reused = conversation ?? previous?.conversationId;
	// The definition owns the run's model: a re-added trigger applies it to the conversation it keeps.
	if (reused !== undefined && Object.keys(agent).length > 0) await configure(tx, reused, agent);
	const conversationId = reused ?? (await createSeatConversation(tx, "run", { kind: "ownerless" }, { instructions: `${INSTRUCTIONS}\nTrigger: ${input.trigger.id}.`, ...agent }));
	const id = await tx.createTask(task, input, { ownership: { kind: "conversation" }, conversationId, background: true });
	return { id, replaced: previous !== undefined && live(previous) ? previous.id : undefined };
}

/** Throws a readable error for a cron expression, time zone or `once` time a trigger cannot run with. */
function validateTrigger(trigger: Trigger): Trigger {
	if (trigger.kind === "cron") {
		parseCron(trigger.cron);
		assertTimeZone(trigger.tz);
	}
	if (trigger.kind === "once" && Number.isNaN(Date.parse(trigger.at))) throw new Error(`Invalid time "${trigger.at}"; use ISO 8601 with an offset.`);
	return trigger;
}

function checkRecipients(notify: readonly string[], users: readonly ChatUser[]): void {
	const valid = [OWNER_ID, ...users.map((user) => user.id)];
	for (const recipient of notify) {
		if (!valid.includes(recipient)) throw new Error(`Unknown notify recipient "${recipient}". Valid ids: ${valid.join(", ")}.`);
	}
}

/** Seeds from data/config.json `triggers`. Each notify id must be the owner or a configured user. */
export function parseSeeds(file: Readonly<Record<string, unknown>>, users: readonly ChatUser[]): Trigger[] {
	const seeds = parseWith(SeedsSchema, file.triggers ?? [], "triggers in data/config.json").map(validateTrigger);
	for (const seed of seeds) {
		if (seed.notify !== undefined) checkRecipients(seed.notify, users);
	}
	return seeds;
}

/**
 * Idempotent: an equal seed is left alone, a changed one is re-added in its conversation, a config trigger whose seed
 * is gone is aborted, and so is any live trigger a newer one with its id replaced. A model trigger is touched only when
 * config claims its id.
 */
export async function reconcileSeeds(harness: Harness, task: TriggerTask, seeds: readonly Trigger[], context: Context): Promise<void> {
	const stale = await harness.commit(async (tx) => {
		const existing = await scanTriggers(tx);
		const current = new Map<string, TriggerRecord>();
		const stale: TaskId[] = [];
		for (const record of existing.filter(live)) {
			const older = current.get(record.input.trigger.id);
			if (older !== undefined) stale.push(older.id);
			current.set(record.input.trigger.id, record);
		}
		const seeded = new Set(seeds.map((seed) => seed.id));
		for (const [id, record] of current) if (record.input.origin === "config" && !seeded.has(id)) stale.push(record.id);
		for (const seed of seeds) {
			const record = current.get(seed.id);
			if (record?.input.origin === "config" && JSON.stringify(record.input.trigger) === JSON.stringify(seed)) continue;
			const { replaced } = await addTrigger(tx, task, { trigger: seed, origin: "config" }, existing);
			if (replaced !== undefined) stale.push(replaced);
		}
		return stale;
	}, context);
	for (const id of stale) await harness.abortTask(id, context);
}

const Id = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 });
const AddParams = Type.Object({
	id: Id,
	prompt: Type.String({ minLength: 1 }),
	when: Type.String({ minLength: 1 }),
	tz: Type.Optional(Type.String()),
	auth: Type.Optional(Type.Union([Type.Literal("hmac"), Type.Literal("bearer")])),
	admitWhen: Type.Optional(GateSchema),
	notifyWhen: Type.Optional(GateSchema),
	notify: Type.Optional(Type.Array(Type.String())),
});

function parseWhen(args: Static<typeof AddParams>, timeZone: string, users: readonly ChatUser[]): Trigger {
	const { id, prompt, when, admitWhen, notifyWhen, notify } = args;
	if (admitWhen !== undefined && when !== "webhook") throw new Error("admitWhen applies only to webhook triggers.");
	if (notify !== undefined) checkRecipients(notify, users);
	const secret = randomBytes(32).toString("hex");
	const draft =
		when === "webhook"
			? { kind: "webhook", id, prompt, admitWhen, notifyWhen, notify, auth: args.auth === "bearer" ? { kind: "bearer", token: secret } : { kind: "hmac-sha256", header: "X-Hub-Signature-256", secret } }
			: when.trim().split(/\s+/).length === 5
				? { kind: "cron", id, prompt, notifyWhen, notify, cron: when.trim(), tz: args.tz ?? timeZone }
				: { kind: "once", id, prompt, notifyWhen, notify, at: when };
	return validateTrigger(parseWith(TriggerSchema, JSON.parse(JSON.stringify(draft)), "trigger"));
}

const nextSlot = (trigger: Trigger, last: LastSlot | null, now: number): string | undefined => {
	const next = plan(trigger, last, now);
	return "slot" in next ? iso(next.slot) : undefined;
};

function listed({ input: { trigger, origin }, state }: TriggerRecord, now: number): JsonValue {
	const { checkpoint } = state;
	const next = checkpoint !== undefined && checkpoint.phase !== "wait" ? iso(checkpoint.slot) : nextSlot(trigger, checkpoint?.last ?? null, now);
	const when = trigger.kind === "cron" ? `${trigger.cron} ${trigger.tz}` : trigger.kind === "once" ? trigger.at : `webhook (${trigger.auth.kind})`;
	const last = checkpoint?.last == null ? undefined : `${checkpoint.last.result} at ${iso(checkpoint.last.at)}`;
	return JSON.parse(JSON.stringify({ id: trigger.id, when, origin, next, last }));
}

export interface TriggerFnDeps {
	readonly task: TriggerTask;
	readonly triggers: (context: Context) => Promise<TriggerRecord[]>;
	readonly abortTask: (id: TaskId, context: Context) => Promise<unknown>;
	/** `MOCHI_PUBLIC_URL`, the origin webhook senders call. */
	readonly publicUrl: string | undefined;
	readonly timeZone: string;
	readonly now: () => number;
	/** Configured users, whose ids a trigger may notify. */
	readonly users: readonly ChatUser[];
}

export function triggerFns(deps: TriggerFnDeps): ToolRegistration[] {
	return [
		defineTool({
			name: "trigger_add",
			description:
				"Run a prompt later in its own conversation. The run is silent unless it calls notify, which goes to the ids in notify (default user1). " +
				"when is a cron 'm h dom mon dow' in the owner's time zone, an ISO time with an offset, or 'webhook'. A webhook returns its URL " +
				"and secret (hmac checks GitHub's X-Hub-Signature-256; bearer checks the Authorization header). admitWhen and notifyWhen are yes/no " +
				"classifier questions: admitWhen is asked of each payload and notifyWhen of each notify text, and yes lets it through. " +
				"Adding an existing id replaces that trigger and keeps its conversation.",
			parameters: AddParams,
			structuredOutputSchema: Type.Object({ id: Type.String(), next: Type.Optional(Type.String()), url: Type.Optional(Type.String()), secret: Type.Optional(Type.String()) }),
			replay: "safe",
			execute: async (args, api, context) => {
				const draft = parseWhen(args, deps.timeZone, deps.users);
				let trigger = draft;
				let replaced: TaskId | undefined;
				await api.commit(async (tx) => {
					const existing = await scanTriggers(tx);
					const { id, created } = await journaled(tx, api.taskId, "trigger", async () => {
						const added = await addTrigger(tx, deps.task, { trigger: draft, origin: "model" }, existing);
						replaced = added.replaced;
						return added.id;
					});
					if (!created) trigger = existing.find((record) => record.id === id)!.input.trigger;
				}, context);
				if (replaced !== undefined) await deps.abortTask(replaced, context);
				if (trigger.kind === "webhook") {
					const secret = trigger.auth.kind === "bearer" ? trigger.auth.token : trigger.auth.secret;
					return { structuredOutput: { id: trigger.id, url: `${deps.publicUrl ?? "<MOCHI_PUBLIC_URL unset>"}/hooks/${trigger.id}`, secret } };
				}
				return { structuredOutput: JSON.parse(JSON.stringify({ id: trigger.id, next: nextSlot(trigger, null, deps.now()) })) };
			},
		}),
		defineTool({
			name: "trigger_list",
			description: "List live triggers with their origin (model or config), next run and last run.",
			parameters: Type.Object({}),
			structuredOutputSchema: Type.Array(Type.Object({ id: Type.String(), when: Type.String(), origin: Type.String(), next: Type.Optional(Type.String()), last: Type.Optional(Type.String()) })),
			replay: "safe",
			execute: async (_args, _api, context) => ({ structuredOutput: (await deps.triggers(context)).filter(live).map((task) => listed(task, deps.now())) }),
		}),
		defineTool({
			name: "trigger_remove",
			description: "Stop a trigger. A run may stop its own trigger. Its conversation stays for history. A config trigger comes back at the next start.",
			parameters: Type.Object({ id: Id }),
			structuredOutputSchema: Type.Literal("removed"),
			replay: "safe",
			execute: async ({ id }, _api, context) => {
				const found = (await deps.triggers(context)).findLast((task) => task.input.trigger.id === id);
				if (found === undefined) throw new Error(`No trigger named ${id}.`);
				await deps.abortTask(found.id, context);
				return { structuredOutput: "removed" };
			},
		}),
	];
}

/** The `notifyWhen` verdict, memoized so a replayed call reaches the same decision. */
const GATE_MEMO = "notify.gate";

export interface NotifyDeps {
	readonly line: () => Pick<Line, "id" | "turn">;
	/** Chat channels running in this process; with none, notify writes only the record in root. */
	readonly channels: readonly ChannelId[];
	readonly classify: Classify;
	readonly log: Log;
	/** Configured users, the ids a trigger's `notify` may name. */
	readonly users: readonly ChatUser[];
}

export function notifyTool(deps: NotifyDeps): ToolRegistration {
	const channelNames = deps.channels.length === 0 ? ["cli"] : deps.channels;
	return defineTool({
		name: "notify",
		description:
			"Send a message now to the owner, or in a trigger run to the trigger's recipients. In a trigger run this is the only way to reach " +
			"them, so call it only when something needs their attention. channel applies to the owner and defaults to where the owner last wrote. Users always get iMessage.",
		parameters: Type.Object({
			text: Type.String({ minLength: 1, maxLength: 4000 }),
			channel: Type.Optional(Type.Union(channelNames.map((id) => Type.Literal(id)))),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const trigger = await api.commit(async (tx) => (await scanTriggers(tx, api.conversationId)).at(-1)?.input.trigger, context);
			if (trigger?.notifyWhen !== undefined) {
				let held = await api.memo<number | null>(GATE_MEMO, context);
				if (held === undefined) {
					const verdict = await checkGate(deps.classify, trigger.notifyWhen, { trigger: trigger.id, purpose: trigger.prompt, message: args.text }, context);
					if (verdict.kind === "failed-open") deps.log("notify.gate_failed_open", { trigger: trigger.id, error: verdict.error });
					held = await api.memo<number | null>(GATE_MEMO, admits(verdict) ? null : verdict.probability, context);
				}
				if (held !== null) {
					deps.log("notify.filtered", { trigger: trigger.id, probability: held });
					const text = `Not sent: this trigger's notifyWhen gate judged it does not meet "${trigger.notifyWhen.question}" (p=${held.toFixed(2)}). Finish without notifying.`;
					return { output: [{ type: "text", text }] };
				}
			}
			const last = (await api.snapshot(LastInboundDoc, context))?.last?.channel;
			const channel = (args.channel as ChannelId | undefined) ?? (last !== undefined && deps.channels.includes(last) ? last : (deps.channels[0] ?? "cli"));
			const from = trigger === undefined ? ({ kind: "conversation", id: api.conversationId } as const) : ({ kind: "trigger", id: trigger.id } as const);
			const turns: RunTurn[] = [];
			const queued: string[] = [];
			for (const recipient of trigger?.notify ?? [OWNER_ID]) {
				if (recipient === OWNER_ID) {
					turns.push({ source: "run", channel, text: args.text, from });
					queued.push(`${OWNER_ID} on ${channel}`);
					continue;
				}
				const user = deps.users.find((candidate) => candidate.id === recipient);
				if (user === undefined) throw new Error(`Notify recipient ${recipient} is not configured.`);
				turns.push({ source: "run", channel: "imessage", text: args.text, from, person: user.handle });
				queued.push(`${recipient} on imessage`);
			}
			await api.commit(async (tx) => {
				for (const turn of turns) {
					const key = turn.person === undefined ? "turn" : `turn:${turn.person}`;
					await journaled(tx, api.taskId, key, () => openTurn(tx, deps.line(), turn));
				}
			}, context);
			// The run is done once its message is queued; ending here skips a model request that would only narrate the send.
			return { output: [{ type: "text", text: `Queued for ${queued.join(" and ")}; it goes out verbatim.` }], control: { terminate: true } };
		},
	});
}
