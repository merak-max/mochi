import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Context, JsonValue } from "@earendil-works/chord";
import { awaitWithContext, withCancel } from "@earendil-works/chord/context";
import { type Static, Type } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc, ResetEntry, type Conversation, type ConversationId, defineTask, defineTool, type Harness, ROOT_CONVERSATION_ID, type NextTaskState, type Task, type TaskId, type TaskRecord, type TaskRuntime, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { ChannelId, ChatChannelId } from "../channels/types.ts";
import { holdText } from "../context.ts";
import { journaled } from "../journal.ts";
import { withAttachments } from "../media/files.ts";
import type { Log } from "../log.ts";
import { allPages } from "../pages.ts";
import { parseWith } from "../parse.ts";
import { createSeatConversation } from "../seats.ts";
import { type ChatUser, OWNER_ID } from "../config.ts";
import { formatStamp, messageText } from "../text.ts";
import { keyedReset } from "../turn/lifecycle.ts";
import { answerText, LastInboundDoc, type Line, openTurn, type RunTurn } from "../turn/turn.ts";
import { agentOf, applyAgent, type Profiles, type RunAgent } from "../profiles/profiles.ts";
import { filesOf, procStatus, readFrom, stopGroup, tailLines } from "../procs/procs.ts";
import { assertTimeZone, nextCronSlot, parseCron } from "./cron.ts";
import { classifyYes, type Classify, type ClassifyStep } from "../brain/classifier.ts";
import { describeWhen, Id, type Schedule, ScheduleSchema, type Step, StepSchema, stepsOf, TriggerEntrySchema, scheduleOfEntry, type WebhookAuth } from "./types.ts";

const LATE_MS = 15 * 60_000;
export const RUN_DEADLINE_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const CHECK_TIMEOUT_MS = 5 * 60_000;
const WAKE_LINES = 30;

export const KIND = "mochi.schedule";

type LastSlot = { readonly at: number; readonly result: "done" | "unanswered" | "skipped-busy" | "missed" | "timed-out" | "quiet" | "check-failed" | "stopped" };

const run = promisify(execFile);

async function runCheck(argv: readonly string[]): Promise<string | null> {
	const [file, ...args] = argv as [string, ...string[]];
	const { stdout } = await run(file, args, { timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
	return stdout.trim() === "" ? null : stdout.trim();
}

type Plan = { readonly kind: "fire" | "miss"; readonly slot: number } | { readonly kind: "listen" | "watch" | "done" };

/** Only a cron slot can be missed: a late `at` still fires, since its promise is still owed. */
const late = (schedule: Schedule, slot: number, now: number): boolean => "cron" in schedule.when && now - slot > LATE_MS;

export function plan(schedule: Schedule, last: LastSlot | null, now: number): Plan {
	const { when } = schedule;
	if ("webhook" in when) return { kind: "listen" };
	if ("process" in when) return { kind: "watch" };
	if ("at" in when) return last === null ? { kind: "fire", slot: Date.parse(when.at) } : { kind: "done" };
	const cron = parseCron(when.cron);
	let due: number | undefined;
	let next = nextCronSlot(cron, when.tz, new Date(last?.at ?? now));
	for (; next !== undefined && next.getTime() <= now; next = nextCronSlot(cron, when.tz, next)) due = next.getTime();
	if (due !== undefined) return { kind: late(schedule, due, now) ? "miss" : "fire", slot: due };
	return next === undefined ? { kind: "done" } : { kind: "fire", slot: next.getTime() };
}

/** `watch` follows a background process; `matched` records that its watch regex already fired. */
type ScheduleState =
	| { readonly phase: "wait"; readonly last: LastSlot | null }
	| { readonly phase: "watch"; readonly matched: boolean }
	| { readonly phase: "fire"; readonly slot: number; readonly last: LastSlot | null }
	| { readonly phase: "run"; readonly slot: number; readonly deadline: number; readonly last: LastSlot | null };

type ScheduleInput = { readonly schedule: Schedule; readonly origin: "model" | "config" };
export type ScheduleTask = Task<ScheduleInput, ScheduleState, null, object>;
type ScheduleRecord = TaskRecord<ScheduleInput, ScheduleState, null>;
type ScheduleRuntime = TaskRuntime<ScheduleInput, ScheduleState, null, object>;

const iso = (at: number): string => new Date(at).toISOString();

/** A wake's text and destination, fixed on first run so a replay submits the same content to the same place. */
type WakeMemo = { readonly body: string; readonly last: { readonly channel: ChatChannelId; readonly messageId: string } | null };

interface ScheduleDeps {
	readonly timeZone: string;
	readonly deadlineMs: number;
	readonly pollMs: number;
	readonly procDir: string;
	readonly log: Log;
	readonly harness: () => Pick<Harness, "commit">;
	readonly line: () => Line;
	readonly catalog: Profiles;
	readonly classify: Classify;
	readonly workDir: string;
}

export function defineSchedule(deps: ScheduleDeps): ScheduleTask {
	const { timeZone, deadlineMs, log, harness, catalog, classify, workDir } = deps;
	const wait = (last: LastSlot): NextTaskState<ScheduleState, null> => ({ status: "running", checkpoint: { phase: "wait", last } });
	const ended: NextTaskState<ScheduleState, null> = { status: "terminal", outcome: { status: "completed", result: null } };
	const missed = (schedule: Schedule, slot: number): NextTaskState<ScheduleState, null> => {
		log("schedule.missed", { id: schedule.id, slot: iso(slot) });
		return wait({ at: slot, result: "missed" });
	};
	/** After a run: a cron or webhook waits for its next slot, an `at` is spent. */
	const after = (schedule: Schedule, last: LastSlot): NextTaskState<ScheduleState, null> => ("at" in schedule.when ? ended : wait(last));

	/** A process wake enters the conversation that started the process; into root it goes through a chat Turn, so the reply reaches the owner. */
	const wake = async (runtime: ScheduleRuntime, schedule: Schedule, key: string, tag: string, next: NextTaskState<ScheduleState, null>, context: Context): Promise<void> => {
		const name = "process" in schedule.when ? schedule.when.process.name : schedule.id;
		log("schedule.wake", { id: schedule.id, key });
		let frozen = await runtime.memo<WakeMemo>(`wake:${key}`, context);
		if (frozen === undefined) {
			const lines = await tailLines(filesOf(deps.procDir, name).log, WAKE_LINES);
			const output = lines.length === 0 ? "(no output)" : lines.join("\n");
			const last = runtime.conversationId === ROOT_CONVERSATION_ID ? (await runtime.snapshot(LastInboundDoc, context))?.last : undefined;
			frozen = await runtime.memo<WakeMemo>(`wake:${key}`, { body: `${schedule.prompt}\n${output}`, last: last ?? null }, context);
		}
		const requestId = `schedule:${runtime.taskId}:${key}`;
		const { body, last } = frozen;
		if (last !== null) {
			await runtime.commit(async (tx) => {
				await openTurn(tx, deps.line(), { source: "chat", channel: last.channel, key: requestId, tag, text: body, files: [] });
				return next;
			}, context);
			return;
		}
		const conversation = (await runtime.conversation(runtime.conversationId, context))!;
		const held = await holdText(harness(), workDir, conversation.id, `in:${requestId}`, body, context);
		await conversation.submit({ type: "input", content: `${tag}\n${held}`, requestId, whenBusy: "followUp" }, context);
		await runtime.commit(() => next, context);
	};

	return defineTask<ScheduleInput, ScheduleState, null>({
		name: KIND,
		version: 1,
		initial: ({ schedule }) => ("process" in schedule.when ? { phase: "watch", matched: false } : { phase: "wait", last: null }),
		phases: {
			wait: async (task, runtime, context) => {
				const { last } = task.state.checkpoint;
				const next = plan(task.input.schedule, last, runtime.now());
				switch (next.kind) {
					case "listen":
						return runtime.sleepUntil(runtime.now() + DAY_MS, { phase: "wait", last }, context);
					case "watch":
						return runtime.commit(() => ({ status: "running", checkpoint: { phase: "watch", matched: false } }), context);
					case "done":
						return runtime.commit(() => ended, context);
					case "miss":
						return runtime.commit(() => missed(task.input.schedule, next.slot), context);
					case "fire":
						return runtime.commit(() => ({ status: "running", checkpoint: { phase: "fire", slot: next.slot, last } }), context);
				}
			},
			watch: async (task, runtime, context) => {
				const { schedule } = task.input;
				if (!("process" in schedule.when)) throw new Error(`Schedule ${schedule.id} has no process.`);
				const { name, pid, watch } = schedule.when.process;
				const files = filesOf(deps.procDir, name);
				const pattern = watch === undefined || task.state.checkpoint.matched ? undefined : new RegExp(watch);
				let offset = 0;
				let partial = "";
				for (;;) {
					const status = await procStatus(files, pid);
					const over = status.state !== "running";
					if (pattern !== undefined) {
						const appended = await readFrom(files.log, offset);
						offset += appended.length;
						const lines = (partial + appended.toString("utf8")).split("\n");
						partial = over ? "" : lines.pop()!;
						if (lines.some((line) => pattern.test(line))) {
							const tag = `[process ${name} matched /${watch}/, ${over ? "now ended" : "still running"}]`;
							return wake(runtime, schedule, "watch", tag, { status: "running", checkpoint: { phase: "watch", matched: true } }, context);
						}
					}
					if (over) {
						const code = status.state === "exited" ? status.code : null;
						const tag = code === null ? `[process ${name} ended, exit code unknown]` : `[process ${name} exited code=${code}]`;
						return wake(runtime, schedule, "exit", tag, ended, context);
					}
					await awaitWithContext(new Promise<void>((resolve) => runtime.setTimer(resolve, deps.pollMs)), context);
				}
			},
			fire: async (task, runtime, context) => {
				const { slot, last } = task.state.checkpoint;
				if (runtime.now() < slot) return runtime.sleepUntil(slot, task.state.checkpoint, context);
				const now = runtime.now();
				if (late(task.input.schedule, slot, now)) return runtime.commit(() => missed(task.input.schedule, slot), context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run", slot, deadline: now + deadlineMs, last } }), context);
			},
			run: async (task, runtime, context) => {
				const { schedule } = task.input;
				const { slot, deadline } = task.state.checkpoint;
				const conversation = (await runtime.conversation(runtime.conversationId, context))!;
				const requestId = `schedule:${schedule.id}:${iso(slot)}`;
				let payload = "";
				if (schedule.check !== undefined) {
					const key = `check:${iso(slot)}`;
					let found = await runtime.memo<{ out: string | null } | { failed: string }>(key, context);
					if (found === undefined) {
						const result = await runCheck(schedule.check).then((out) => ({ out }), (error: unknown) => ({ failed: String(error).slice(0, 500) }));
						found = await runtime.memo(key, result, context);
					}
					if ("failed" in found) {
						log("schedule.check_failed", { id: schedule.id, slot: iso(slot), error: found.failed });
						return runtime.commit(() => after(schedule, { at: slot, result: "check-failed" }), context);
					}
					if (found.out === null) {
						log("schedule.quiet", { id: schedule.id, slot: iso(slot) });
						return runtime.commit(() => after(schedule, { at: slot, result: "quiet" }), context);
					}
					payload = `\n<check_output source="${schedule.id}">\n${found.out}\n</check_output>`;
				}
				const memo = (key: string, value?: number) => (value === undefined ? runtime.memo<number>(`${key}:${iso(slot)}`, context) : runtime.memo(`${key}:${iso(slot)}`, value, context));
				if (!(await inputPasses(schedule, payload === "" ? schedule.prompt : payload, classify, memo, log, context))) return runtime.commit(() => after(schedule, { at: slot, result: "stopped" }), context);
				const agent = await runAgent(schedule, catalog);
				await harness().commit((tx) => applyAgent(tx, conversation.id, agent), context);
				await freshRun(harness(), conversation, requestId, runtime.now(), context);
				const body = await holdText(harness(), workDir, conversation.id, `in:${requestId}`, `${schedule.prompt}${payload}`, context);
				const content = `[schedule ${schedule.id}] Current time: ${formatStamp(new Date(slot), timeZone)}\n${body}`;
				const submission = await conversation.submit({ type: "input", content, requestId, whenBusy: "followUp" }, context);
				const race = withCancel(context);
				let disarm = (): void => {};
				const timedOut = new Promise<undefined>((resolve) => {
					disarm = runtime.setTimer(() => resolve(undefined), deadline - runtime.now());
				});
				const settled = await Promise.race([submission.wait(race.context), timedOut]).finally(() => {
					race.cancel();
					disarm();
				});
				if (settled === undefined) {
					await conversation.abort(context);
					log("schedule.timed_out", { id: schedule.id, slot: iso(slot) });
				}
				await runtime.commit(() => after(schedule, { at: slot, result: settled?.status ?? "timed-out" }), context);
			},
		},
		abort: async (task, runtime, context) => {
			const { when } = task.input.schedule;
			if ("process" in when) await stopGroup(when.process.pid, filesOf(deps.procDir, when.process.name));
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}

export const live = (task: ScheduleRecord): boolean => task.state.status !== "terminal" && !task.abortRequested;

export async function scanSchedules(tx: Pick<Tx, "scanTasks">, conversationId?: ConversationId): Promise<ScheduleRecord[]> {
	const query = { kind: KIND, ...(conversationId === undefined ? {} : { conversationId }) };
	return (await allPages((cursor) => tx.scanTasks(query, 256, cursor))) as unknown as ScheduleRecord[];
}

export const liveSchedule = async (tx: Pick<Tx, "scanTasks">, id: string): Promise<ScheduleRecord | undefined> =>
	(await scanSchedules(tx)).findLast((task) => live(task) && task.input.schedule.id === id);

const INSTRUCTIONS =
	"This conversation is an unattended schedule run, not a chat with the owner. Nobody reads your answers here. " +
	"The only way to reach the owner is the notify tool; call it only when something needs the owner's attention, " +
	"and otherwise finish with a short note of what you checked and what you already reported. Each run starts fresh " +
	"from the last run's note; use recall for anything older. End a repeating schedule that has served its purpose with tools.schedule_remove in code.";

async function lastRunNote(tx: Tx, conversationId: ConversationId): Promise<string> {
	const recent = (await tx.scanEntries({ conversationId, order: "descending" }, 32)).items;
	for (const entry of recent) {
		if (entry.kind === ResetEntry.kind) return messageText(entry.model?.[0] ?? { role: "user", content: "", timestamp: 0 }).trim();
		if (entry.kind !== AssistantEntry.kind) continue;
		const text = await answerText(tx, entry.id);
		if (text !== "") return text;
		const notified = (entry.model ?? []).flatMap((message) => message.role === "assistant" ? message.content : []).find((part) => part.type === "toolCall" && part.name === "notify");
		if (notified?.type === "toolCall") return `Notified the owner: ${String(notified.arguments.text)}`;
	}
	return "";
}

const CARRIED = "Your previous run of this schedule ended with:";

async function freshRun(harness: Pick<Harness, "commit">, conversation: Pick<Conversation, "id" | "submit">, requestId: string, now: number, context: Context): Promise<void> {
	const { busy, note } = await harness.commit(async (tx) => ({ busy: (await tx.doc(LiveDoc, conversation.id)).run !== undefined, note: await lastRunNote(tx, conversation.id) }), context);
	if (busy || note === "") return;
	const handoff = note.startsWith(CARRIED) ? note : `${CARRIED}\n${note}`;
	await keyedReset(conversation, `reset:${requestId}`, handoff, now, context);
}

/**
 * `existing` is `scanSchedules`, read before the commit's first write. A process schedule lives in `here`, the
 * conversation that started the process. Every other schedule runs in `here` when given (a migrated trigger keeps its
 * conversation), else in the conversation of the schedule it replaces, else in a new trigger-seat one. A replaced live
 * schedule is for the caller to abort after the commit.
 */
export async function addSchedule(
	tx: Tx,
	task: ScheduleTask,
	input: ScheduleInput,
	existing: readonly ScheduleRecord[],
	catalog: Profiles,
	here?: ConversationId,
): Promise<{ readonly id: TaskId; readonly replaced: TaskId | undefined }> {
	const previous = existing.findLast((record) => record.input.schedule.id === input.schedule.id);
	const isProcess = "process" in input.schedule.when;
	if (isProcess && here === undefined) throw new Error("A process schedule needs the conversation that started the process.");
	const reuse = previous !== undefined && !("process" in previous.input.schedule.when) ? previous.conversationId : undefined;
	const conversationId = here ?? reuse ?? (await createSeatConversation(tx, "trigger", { kind: "ownerless" }));
	if (!isProcess) await applyAgent(tx, conversationId, await runAgent(input.schedule, catalog));
	const id = await tx.createTask(task, input, { ownership: { kind: "conversation" }, conversationId, background: true });
	return { id, replaced: previous !== undefined && live(previous) ? previous.id : undefined };
}

/**
 * Runs the classify steps before the model step on `input`, in order, each verdict memoized under `classify:<index>` so a replay
 * decides the same way. False when one judges no: the chain stops and the model never runs.
 */
export async function inputPasses(
	schedule: Schedule,
	input: string,
	classify: Classify,
	memo: (key: string, value?: number) => Promise<number | undefined>,
	log: Log,
	context: Context,
): Promise<boolean> {
	for (const [index, step] of stepsOf(schedule).entries()) {
		if ("model" in step) return true;
		if (step.classify.on === "output") continue;
		const yes = (await memo(`classify:${index}`)) ?? (await memo(`classify:${index}`, await classifyYes(classify, step.classify, { trigger: schedule.id, input }, log, context)))!;
		if (yes < (step.classify.threshold ?? 0.5)) {
			log("schedule.stopped", { id: schedule.id, step: index, yes });
			return false;
		}
	}
	return true;
}

/** The classify steps that judge a schedule's notify text, in order. */
const outputSteps = (schedule: Schedule): readonly ClassifyStep[] =>
	stepsOf(schedule).flatMap((step: Step) => ("classify" in step && step.classify.on === "output" ? [step.classify] : []));

export async function runAgent(schedule: Schedule, catalog: Profiles): Promise<RunAgent> {
	const header = `${INSTRUCTIONS}
Schedule: ${schedule.id}.`;
	const run: RunAgent = schedule.profile === undefined ? { profile: undefined, agent: { model: catalog.model("fast") }, tools: undefined, instructions: header } : agentOf(await catalog.get(schedule.profile), catalog, header);
	const thinking = schedule.thinking ?? run.agent.thinkingLevel;
	return { ...run, agent: { model: schedule.model === undefined ? run.agent.model : catalog.model(schedule.model), ...(thinking === undefined ? {} : { thinkingLevel: thinking }) } };
}

const OFFSET = /[zZ]|[+-]\d\d:?\d\d$/;

export function validateSchedule(schedule: Schedule): Schedule {
	const { when } = schedule;
	if ("cron" in when) {
		parseCron(when.cron);
		assertTimeZone(when.tz);
	}
	if ("at" in when && (Number.isNaN(Date.parse(when.at)) || !OFFSET.test(when.at))) throw new Error(`Invalid at "${when.at}"; use ISO 8601 with an offset, such as 2026-10-15T09:00:00+05:30.`);
	if ("process" in when && when.process.watch !== undefined) new RegExp(when.process.watch);
	return schedule;
}

function checkRecipients(notify: readonly string[], users: readonly ChatUser[]): void {
	const valid = [OWNER_ID, ...users.map((user) => user.id)];
	for (const recipient of notify) {
		if (!valid.includes(recipient)) throw new Error(`Unknown notify recipient "${recipient}". Valid ids: ${valid.join(", ")}.`);
	}
}

/** `[[triggers]]` in config.toml: the flat entries of before, read as schedules. The key keeps its name so existing configs load. */
export function parseSeeds(file: Readonly<Record<string, unknown>>, users: readonly ChatUser[]): Schedule[] {
	const seeds = parseWith(Type.Array(TriggerEntrySchema), file.triggers ?? [], "triggers in config.toml").map((entry) => validateSchedule(scheduleOfEntry(entry)));
	for (const seed of seeds) {
		if (seed.notify !== undefined) checkRecipients(seed.notify, users);
	}
	return seeds;
}

export async function reconcileSeeds(harness: Harness, task: ScheduleTask, seeds: readonly Schedule[], catalog: Profiles, context: Context): Promise<void> {
	const stale = await harness.commit(async (tx) => {
		const existing = await scanSchedules(tx);
		const current = new Map<string, ScheduleRecord>();
		const stale: TaskId[] = [];
		for (const record of existing.filter(live)) {
			const older = current.get(record.input.schedule.id);
			if (older !== undefined) stale.push(older.id);
			current.set(record.input.schedule.id, record);
		}
		const seeded = new Set(seeds.map((seed) => seed.id));
		for (const [id, record] of current) if (record.input.origin === "config" && !seeded.has(id)) stale.push(record.id);
		for (const seed of seeds) {
			const record = current.get(seed.id);
			if (record?.input.origin === "config" && JSON.stringify(record.input.schedule) === JSON.stringify(seed)) continue;
			const { replaced } = await addSchedule(tx, task, { schedule: seed, origin: "config" }, existing, catalog);
			if (replaced !== undefined) stale.push(replaced);
		}
		return stale;
	}, context);
	for (const id of stale) await harness.abortTask(id, context);
}

const AddParams = Type.Object({
	id: Id,
	prompt: Type.String({ minLength: 1 }),
	when: Type.Union([
		Type.Object({ cron: Type.String({ minLength: 1 }), tz: Type.Optional(Type.String()) }),
		Type.Object({ at: Type.String({ minLength: 1 }) }),
		Type.Object({ webhook: Type.Object({ auth: Type.Optional(Type.Union([Type.Literal("hmac"), Type.Literal("bearer")])) }) }),
	]),
	notify: Type.Optional(Type.Array(Type.String())),
	steps: Type.Optional(Type.Array(StepSchema, { minItems: 1 })),
	profile: Type.Optional(Id),
	model: Type.Optional(Type.String({ minLength: 1 })),
	check: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
});

function draftOf(args: Static<typeof AddParams>, timeZone: string, users: readonly ChatUser[]): Schedule {
	if (args.notify !== undefined) checkRecipients(args.notify, users);
	let when: Schedule["when"];
	if ("cron" in args.when) {
		when = { cron: args.when.cron.trim(), tz: args.when.tz ?? timeZone };
	} else if ("at" in args.when) {
		when = { at: args.when.at };
	} else {
		const secret = randomBytes(32).toString("hex");
		const auth: WebhookAuth = args.when.webhook.auth === "bearer" ? { kind: "bearer", token: secret } : { kind: "hmac-sha256", header: "X-Hub-Signature-256", secret };
		when = { webhook: { auth } };
	}
	const draft = { ...args, when };
	return validateSchedule(parseWith(ScheduleSchema, JSON.parse(JSON.stringify(draft)), "schedule"));
}

const nextSlot = (schedule: Schedule, last: LastSlot | null, now: number): string | undefined => {
	const next = plan(schedule, last, now);
	return "slot" in next ? iso(next.slot) : undefined;
};

function listed({ input: { schedule, origin }, state }: ScheduleRecord, now: number): JsonValue {
	const { checkpoint } = state;
	let next: string | undefined;
	let last: string | undefined;
	if (checkpoint !== undefined && (checkpoint.phase === "fire" || checkpoint.phase === "run")) next = iso(checkpoint.slot);
	if (checkpoint !== undefined && checkpoint.phase === "wait") next = nextSlot(schedule, checkpoint.last, now);
	if (checkpoint !== undefined && checkpoint.phase !== "watch" && checkpoint.last != null) last = `${checkpoint.last.result} at ${iso(checkpoint.last.at)}`;
	return JSON.parse(JSON.stringify({ id: schedule.id, when: describeWhen(schedule.when), origin, next, last, prompt: schedule.prompt.slice(0, 200) }));
}

interface ScheduleFnDeps {
	readonly task: ScheduleTask;
	readonly catalog: Profiles;
	readonly schedules: (context: Context) => Promise<ScheduleRecord[]>;
	readonly abortTask: (id: TaskId, context: Context) => Promise<unknown>;
	readonly publicUrl: string | undefined;
	readonly timeZone: string;
	readonly now: () => number;
	readonly users: readonly ChatUser[];
}

export function scheduleFns(deps: ScheduleFnDeps): ToolRegistration[] {
	return [
		defineTool({
			name: "schedule_add",
			description:
				"Run a prompt later, in its own conversation, fresh from the last run's note. Silent unless it calls notify (to notify ids, default user1). " +
				"when: {at:'<ISO with offset>'} once, for a promise, a reminder or a follow-up (put the whole task in prompt, for a cold reader); " +
				"{cron:'m h dom mon dow', tz?} repeating, default the owner's zone; {webhook:{auth?:'hmac'|'bearer'}} on each POST (returns URL and secret; hmac checks X-Hub-Signature-256, bearer the Authorization header). " +
				"check: argv of a script run first at each slot; empty output ends the run with no model call. " +
				"steps: an ordered chain; {model:{}} is the run of prompt, a classify step is a fast yes/no classifier that stops the chain on no, so the model never runs for junk. " +
				"Gate example: steps [{classify:{question:'Does this payload need the owner?',yes:'a person waits or money is due',no:'newsletter, receipt, noise',threshold:0.6}},{model:{}}]; " +
				"add on:'output' to judge the notify text instead. profile: whose instructions, model and memory the run uses; model overrides; default fast. Same id replaces.",
			parameters: AddParams,
			structuredOutputSchema: Type.Object({ id: Type.String(), next: Type.Optional(Type.String()), url: Type.Optional(Type.String()), secret: Type.Optional(Type.String()) }),
			replay: "safe",
			execute: async (args, api, context) => {
				const draft = draftOf(args, deps.timeZone, deps.users);
				const { schedule, replaced } = await api.commit(async (tx) => {
					const existing = await scanSchedules(tx);
					let replaced: TaskId | undefined;
					const { id, created } = await journaled(tx, api.taskId, "schedule", async () => {
						const added = await addSchedule(tx, deps.task, { schedule: draft, origin: "model" }, existing, deps.catalog);
						replaced = added.replaced;
						return added.id;
					});
					const schedule = created ? draft : existing.find((record) => record.id === id)!.input.schedule;
					return { schedule, replaced };
				}, context);
				if (replaced !== undefined) await deps.abortTask(replaced, context);
				if ("webhook" in schedule.when) {
					const { auth } = schedule.when.webhook;
					const secret = auth.kind === "bearer" ? auth.token : auth.secret;
					return { structuredOutput: { id: schedule.id, url: `${deps.publicUrl ?? "<MOCHI_PUBLIC_URL unset>"}/hooks/${schedule.id}`, secret } };
				}
				return { structuredOutput: JSON.parse(JSON.stringify({ id: schedule.id, next: nextSlot(schedule, null, deps.now()) })) };
			},
		}),
		defineTool({
			name: "schedule_list",
			description: "List live schedules: id, when, origin (model or config), next and last run, and the prompt's start. Each `at` schedule is an open promise.",
			parameters: Type.Object({}),
			structuredOutputSchema: Type.Array(Type.Object({ id: Type.String(), when: Type.String(), origin: Type.String(), next: Type.Optional(Type.String()), last: Type.Optional(Type.String()), prompt: Type.String() })),
			replay: "safe",
			execute: async (_args, _api, context) => ({ structuredOutput: (await deps.schedules(context)).filter(live).map((task) => listed(task, deps.now())) }),
		}),
		defineTool({
			name: "schedule_remove",
			description: "Stop a schedule: a kept promise, a watch that served its purpose. A run may stop its own schedule. Its conversation stays for history. A config schedule comes back at the next start.",
			parameters: Type.Object({ id: Id }),
			structuredOutputSchema: Type.Literal("removed"),
			replay: "safe",
			execute: async ({ id }, _api, context) => {
				const found = (await deps.schedules(context)).findLast((task) => live(task) && task.input.schedule.id === id);
				if (found === undefined) throw new Error(`No live schedule named ${id}.`);
				await deps.abortTask(found.id, context);
				return { structuredOutput: "removed" };
			},
		}),
	];
}

interface NotifyDeps {
	readonly line: () => Pick<Line, "id" | "turn" | "workDir">;
	readonly channels: readonly ChannelId[];
	readonly classify: Classify;
	readonly log: Log;
	readonly users: readonly ChatUser[];
}

export function notifyTool(deps: NotifyDeps): ToolRegistration {
	const channelNames = deps.channels.length === 0 ? ["cli"] : deps.channels;
	return defineTool({
		name: "notify",
		description:
			"Message the owner now, or in a schedule run the schedule's recipients, only when it needs their attention. Refused in root: there, your reply is the message. " +
			"channel defaults to where the owner last wrote; users get iMessage. attachments: work-relative or absolute paths under home, each under 100 MB.",
		parameters: Type.Object({
			text: Type.String({ minLength: 1 }),
			channel: Type.Optional(Type.Union(channelNames.map((id) => Type.Literal(id)))),
			attachments: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			if (api.conversationId === ROOT_CONVERSATION_ID) throw new Error("This is the owner's own thread: your reply reaches them. notify is for agents working out of their sight.");
			const schedule = await api.commit(async (tx) => (await scanSchedules(tx, api.conversationId)).filter((record) => !("process" in record.input.schedule.when)).at(-1)?.input.schedule, context);
			for (const [index, step] of (schedule === undefined ? [] : outputSteps(schedule)).entries()) {
				const key = `classify:${index}`;
				const yes = (await api.memo<number>(key, context)) ?? (await api.memo(key, await classifyYes(deps.classify, step, { trigger: schedule!.id, purpose: schedule!.prompt, message: args.text }, deps.log, context), context));
				if (yes < (step.threshold ?? 0.5)) {
					deps.log("notify.stopped", { schedule: schedule!.id, step: index, yes });
					return { output: [{ type: "text", text: `Not sent: the schedule's classify step judged no to "${step.question}" (p=${yes.toFixed(2)}). Finish without notifying.` }] };
				}
			}
			const text = await withAttachments(args.text, args.attachments ?? [], deps.line().workDir);
			const last = (await api.snapshot(LastInboundDoc, context))?.last?.channel;
			const channel = (args.channel as ChannelId | undefined) ?? (last !== undefined && deps.channels.includes(last) ? last : (deps.channels[0] ?? "cli"));
			const from = schedule === undefined ? ({ kind: "conversation", id: api.conversationId } as const) : ({ kind: "trigger", id: schedule.id } as const);
			const turns: RunTurn[] = [];
			const queued: string[] = [];
			for (const recipient of schedule?.notify ?? [OWNER_ID]) {
				if (recipient === OWNER_ID) {
					turns.push({ source: "run", channel, text, from });
					queued.push(`${OWNER_ID} on ${channel}`);
					continue;
				}
				const user = deps.users.find((candidate) => candidate.id === recipient);
				if (user === undefined) throw new Error(`Notify recipient ${recipient} is not configured.`);
				turns.push({ source: "run", channel: "imessage", text, from, person: user.handle });
				queued.push(`${recipient} on imessage`);
			}
			deps.log("notify.queued", { schedule: schedule?.id, to: queued });
			await api.commit(async (tx) => {
				for (const turn of turns) {
					const key = turn.person === undefined ? "turn" : `turn:${turn.person}`;
					await journaled(tx, api.taskId, key, () => openTurn(tx, deps.line(), turn));
				}
			}, context);
			return { output: [{ type: "text", text: `Queued for ${queued.join(" and ")}; it goes out verbatim.` }], control: { terminate: true } };
		},
	});
}
