import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Context, JsonValue } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { type Static, Type } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc, ResetEntry, type Conversation, type ConversationId, defineTask, defineTool, type Harness, ROOT_CONVERSATION_ID, type NextTaskState, type Task, type TaskId, type TaskRecord, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { ChannelId } from "../channels/types.ts";
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
import { assertTimeZone, nextCronSlot, parseCron } from "./cron.ts";
import { classifyYes, type Classify, type ClassifyStep } from "../brain/classifier.ts";
import { Id, type Step, StepSchema, stepsOf, type Trigger, TriggerSchema } from "./types.ts";

const LATE_MS = 15 * 60_000;
export const RUN_DEADLINE_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const CHECK_TIMEOUT_MS = 5 * 60_000;

type LastSlot = { readonly at: number; readonly result: "done" | "unanswered" | "skipped-busy" | "missed" | "timed-out" | "quiet" | "check-failed" | "stopped" };

const run = promisify(execFile);

async function runCheck(argv: readonly string[]): Promise<string | null> {
	const [file, ...args] = argv as [string, ...string[]];
	const { stdout } = await run(file, args, { timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
	return stdout.trim() === "" ? null : stdout.trim();
}

type Plan = { readonly kind: "fire" | "miss"; readonly slot: number } | { readonly kind: "listen" | "done" };

const late = (trigger: Trigger, slot: number, now: number): boolean => trigger.kind === "cron" && now - slot > LATE_MS;

export function plan(trigger: Trigger, last: LastSlot | null, now: number): Plan {
	if (trigger.kind === "webhook") return { kind: "listen" };
	const cron = parseCron(trigger.cron);
	let due: number | undefined;
	let next = nextCronSlot(cron, trigger.tz, new Date(last?.at ?? now));
	for (; next !== undefined && next.getTime() <= now; next = nextCronSlot(cron, trigger.tz, next)) due = next.getTime();
	if (due !== undefined) return { kind: late(trigger, due, now) ? "miss" : "fire", slot: due };
	return next === undefined ? { kind: "done" } : { kind: "fire", slot: next.getTime() };
}

type TriggerState =
	| { readonly phase: "wait"; readonly last: LastSlot | null }
	| { readonly phase: "fire"; readonly slot: number; readonly last: LastSlot | null }
	| { readonly phase: "run"; readonly slot: number; readonly deadline: number; readonly last: LastSlot | null };

type TriggerInput = { readonly trigger: Trigger; readonly origin: "model" | "config" };
export type TriggerTask = Task<TriggerInput, TriggerState, null, object>;
type TriggerRecord = TaskRecord<TriggerInput, TriggerState, null>;

const iso = (at: number): string => new Date(at).toISOString();

export function defineTrigger({ timeZone, deadlineMs, log, harness, catalog, classify, workDir }: { readonly timeZone: string; readonly deadlineMs: number; readonly log: Log; readonly harness: () => Pick<Harness, "commit">; readonly catalog: Profiles; readonly classify: Classify; readonly workDir: string }): TriggerTask {
	const wait = (last: LastSlot): NextTaskState<TriggerState, null> => ({ status: "running", checkpoint: { phase: "wait", last } });
	const missed = (trigger: Trigger, slot: number): NextTaskState<TriggerState, null> => {
		log("trigger.missed", { id: trigger.id, slot: iso(slot) });
		return wait({ at: slot, result: "missed" });
	};
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
						return runtime.commit(() => missed(task.input.trigger, next.slot), context);
					case "fire":
						return runtime.commit(() => ({ status: "running", checkpoint: { phase: "fire", slot: next.slot, last } }), context);
				}
			},
			fire: async (task, runtime, context) => {
				const { slot, last } = task.state.checkpoint;
				await runtime.sleep(slot, context);
				const now = runtime.now();
				if (late(task.input.trigger, slot, now)) return runtime.commit(() => missed(task.input.trigger, slot), context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run", slot, deadline: now + deadlineMs, last } }), context);
			},
			run: async (task, runtime, context) => {
				const { trigger } = task.input;
				const { slot, deadline } = task.state.checkpoint;
				const conversation = (await runtime.conversation(runtime.conversationId, context))!;
				const requestId = `${trigger.kind}:${trigger.id}:${iso(slot)}`;
				let payload = "";
				if (trigger.kind === "cron" && trigger.check !== undefined) {
					const key = `check:${iso(slot)}`;
					let found = await runtime.memo<{ out: string | null } | { failed: string }>(key, context);
					if (found === undefined) {
						const result = await runCheck(trigger.check).then((out) => ({ out }), (error: unknown) => ({ failed: String(error).slice(0, 500) }));
						found = await runtime.memo(key, result, context);
					}
					if ("failed" in found) {
						log("trigger.check_failed", { id: trigger.id, slot: iso(slot), error: found.failed });
						return runtime.commit(() => wait({ at: slot, result: "check-failed" }), context);
					}
					if (found.out === null) return runtime.commit(() => wait({ at: slot, result: "quiet" }), context);
					payload = `\n<check_output source="${trigger.id}">\n${found.out}\n</check_output>`;
				}
				const memo = (key: string, value?: number) => (value === undefined ? runtime.memo<number>(`${key}:${iso(slot)}`, context) : runtime.memo(`${key}:${iso(slot)}`, value, context));
				if (!(await inputPasses(trigger, payload === "" ? trigger.prompt : payload, classify, memo, log, context))) return runtime.commit(() => wait({ at: slot, result: "stopped" }), context);
				const run = await runAgent(trigger, catalog);
				await harness().commit((tx) => applyAgent(tx, conversation.id, run), context);
				await freshRun(harness(), conversation, requestId, runtime.now(), context);
				const body = await holdText(harness(), workDir, conversation.id, `in:${requestId}`, `${trigger.prompt}${payload}`, context);
				const content = `[${trigger.kind} ${trigger.id}] Current time: ${formatStamp(new Date(slot), timeZone)}\n${body}`;
				const submission = await conversation.submit({ type: "input", content, requestId, whenBusy: "followUp" }, context);
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

export async function scanTriggers(tx: Pick<Tx, "scanTasks">, conversationId?: ConversationId): Promise<TriggerRecord[]> {
	const query = { kind: "mochi.trigger", ...(conversationId === undefined ? {} : { conversationId }) };
	return (await allPages((cursor) => tx.scanTasks(query, 256, cursor))) as unknown as TriggerRecord[];
}

export const liveTrigger = async (tx: Pick<Tx, "scanTasks">, id: string): Promise<TriggerRecord | undefined> =>
	(await scanTriggers(tx)).findLast((task) => live(task) && task.input.trigger.id === id);

const INSTRUCTIONS =
	"This conversation is an unattended trigger run, not a chat with the owner. Nobody reads your answers here. " +
	"The only way to reach the owner is the notify tool; call it only when something needs the owner's attention, " +
	"and otherwise finish with a short note of what you checked and what you already reported. Each run starts fresh " +
	"from the last run's note; use recall for anything older. End a trigger that has served its purpose with tools.trigger_remove in code.";

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

const CARRIED = "Your previous run of this trigger ended with:";

async function freshRun(harness: Pick<Harness, "commit">, conversation: Pick<Conversation, "id" | "submit">, requestId: string, now: number, context: Context): Promise<void> {
	const { busy, note } = await harness.commit(async (tx) => ({ busy: (await tx.doc(LiveDoc, conversation.id)).run !== undefined, note: await lastRunNote(tx, conversation.id) }), context);
	if (busy || note === "") return;
	const handoff = note.startsWith(CARRIED) ? note : `${CARRIED}\n${note}`;
	await keyedReset(conversation, `reset:${requestId}`, handoff, now, context);
}

/** `existing` is `scanTriggers`, read before the commit's first write. A replaced live trigger is for the caller to abort after the commit. */
async function addTrigger(
	tx: Tx,
	task: TriggerTask,
	input: TriggerInput,
	existing: readonly TriggerRecord[],
	catalog: Profiles,
	conversation?: ConversationId,
): Promise<{ readonly id: TaskId; readonly replaced: TaskId | undefined }> {
	const previous = existing.findLast((record) => record.input.trigger.id === input.trigger.id);
	const run = await runAgent(input.trigger, catalog);
	const conversationId = conversation ?? previous?.conversationId ?? (await createSeatConversation(tx, "trigger", { kind: "ownerless" }));
	await applyAgent(tx, conversationId, run);
	const id = await tx.createTask(task, input, { ownership: { kind: "conversation" }, conversationId, background: true });
	return { id, replaced: previous !== undefined && live(previous) ? previous.id : undefined };
}

/**
 * Runs the classify steps before the model step on `input`, in order, each verdict memoized under `classify:<index>` so a replay
 * decides the same way. False when one judges no: the chain stops and the model never runs.
 */
export async function inputPasses(
	trigger: Trigger,
	input: string,
	classify: Classify,
	memo: (key: string, value?: number) => Promise<number | undefined>,
	log: Log,
	context: Context,
): Promise<boolean> {
	for (const [index, step] of stepsOf(trigger).entries()) {
		if ("model" in step) return true;
		if (step.classify.on === "output") continue;
		const yes = (await memo(`classify:${index}`)) ?? (await memo(`classify:${index}`, await classifyYes(classify, step.classify, { trigger: trigger.id, input }, log, context)))!;
		if (yes < (step.classify.threshold ?? 0.5)) {
			log("trigger.stopped", { id: trigger.id, step: index, yes });
			return false;
		}
	}
	return true;
}

/** The classify steps that judge a trigger's notify text, in order. */
const outputSteps = (trigger: Trigger): readonly ClassifyStep[] =>
	stepsOf(trigger).flatMap((step: Step) => ("classify" in step && step.classify.on === "output" ? [step.classify] : []));

async function runAgent(trigger: Trigger, catalog: Profiles): Promise<RunAgent> {
	const header = `${INSTRUCTIONS}
Trigger: ${trigger.id}.`;
	const name = trigger.profile ?? trigger.role;
	const run: RunAgent = name === undefined ? { profile: undefined, agent: { model: catalog.model("fast") }, tools: undefined, instructions: header } : agentOf(await catalog.get(name), catalog, header);
	const thinking = trigger.thinking ?? run.agent.thinkingLevel;
	return { ...run, agent: { model: trigger.model === undefined ? run.agent.model : catalog.model(trigger.model), ...(thinking === undefined ? {} : { thinkingLevel: thinking }) } };
}

function validateTrigger(trigger: Trigger): Trigger {
	if (trigger.kind === "cron") {
		parseCron(trigger.cron);
		assertTimeZone(trigger.tz);
	}
	return trigger;
}

function checkRecipients(notify: readonly string[], users: readonly ChatUser[]): void {
	const valid = [OWNER_ID, ...users.map((user) => user.id)];
	for (const recipient of notify) {
		if (!valid.includes(recipient)) throw new Error(`Unknown notify recipient "${recipient}". Valid ids: ${valid.join(", ")}.`);
	}
}

export function parseSeeds(file: Readonly<Record<string, unknown>>, users: readonly ChatUser[]): Trigger[] {
	const seeds = parseWith(Type.Array(TriggerSchema), file.triggers ?? [], "triggers in config.toml").map(validateTrigger);
	for (const seed of seeds) {
		if (seed.notify !== undefined) checkRecipients(seed.notify, users);
	}
	return seeds;
}

export async function reconcileSeeds(harness: Harness, task: TriggerTask, seeds: readonly Trigger[], catalog: Profiles, context: Context): Promise<void> {
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
			const { replaced } = await addTrigger(tx, task, { trigger: seed, origin: "config" }, existing, catalog);
			if (replaced !== undefined) stale.push(replaced);
		}
		return stale;
	}, context);
	for (const id of stale) await harness.abortTask(id, context);
}

const AddParams = Type.Object({
	id: Id,
	prompt: Type.String({ minLength: 1 }),
	when: Type.String({ minLength: 1 }),
	tz: Type.Optional(Type.String()),
	auth: Type.Optional(Type.Union([Type.Literal("hmac"), Type.Literal("bearer")])),
	notify: Type.Optional(Type.Array(Type.String())),
	steps: Type.Optional(Type.Array(StepSchema, { minItems: 1 })),
	profile: Type.Optional(Id),
	model: Type.Optional(Type.String({ minLength: 1 })),
});

function parseWhen(args: Static<typeof AddParams>, timeZone: string, users: readonly ChatUser[]): Trigger {
	const { id, prompt, when, notify, steps, profile, model } = args;
	if (notify !== undefined) checkRecipients(notify, users);
	const secret = randomBytes(32).toString("hex");
	const draft =
		when === "webhook"
			? { kind: "webhook", id, prompt, notify, steps, profile, model, auth: args.auth === "bearer" ? { kind: "bearer", token: secret } : { kind: "hmac-sha256", header: "X-Hub-Signature-256", secret } }
			: { kind: "cron", id, prompt, notify, steps, profile, model, cron: when.trim(), tz: args.tz ?? timeZone };
	return validateTrigger(parseWith(TriggerSchema, JSON.parse(JSON.stringify(draft)), "trigger"));
}

const nextSlot = (trigger: Trigger, last: LastSlot | null, now: number): string | undefined => {
	const next = plan(trigger, last, now);
	return "slot" in next ? iso(next.slot) : undefined;
};

function listed({ input: { trigger, origin }, state }: TriggerRecord, now: number): JsonValue {
	const { checkpoint } = state;
	const next = checkpoint !== undefined && checkpoint.phase !== "wait" ? iso(checkpoint.slot) : nextSlot(trigger, checkpoint?.last ?? null, now);
	const when = trigger.kind === "cron" ? `${trigger.cron} ${trigger.tz}` : `webhook (${trigger.auth.kind})`;
	const last = checkpoint?.last == null ? undefined : `${checkpoint.last.result} at ${iso(checkpoint.last.at)}`;
	return JSON.parse(JSON.stringify({ id: trigger.id, when, origin, next, last }));
}

interface TriggerFnDeps {
	readonly task: TriggerTask;
	readonly catalog: Profiles;
	readonly triggers: (context: Context) => Promise<TriggerRecord[]>;
	readonly abortTask: (id: TaskId, context: Context) => Promise<unknown>;
	readonly publicUrl: string | undefined;
	readonly timeZone: string;
	readonly now: () => number;
	readonly users: readonly ChatUser[];
}

export function triggerFns(deps: TriggerFnDeps): ToolRegistration[] {
	return [
		defineTool({
			name: "trigger_add",
			description:
				"Run a prompt on a schedule or a webhook, each run fresh from the last run's note; a one-off reminder or follow-up is board_add. Silent unless it calls notify (to notify ids, default user1). " +
				"when: cron 'm h dom mon dow' in the owner's zone, or 'webhook' (returns URL and secret; hmac checks X-Hub-Signature-256, bearer the Authorization header). " +
				"steps: an ordered chain; {model:{}} is the run of prompt, a classify step is a fast yes/no classifier that stops the chain on no, so the model never runs for junk. " +
				"Gate example: steps [{classify:{question:'Does this payload need the owner?',yes:'a person waits or money is due',no:'newsletter, receipt, noise',threshold:0.6}},{model:{}}]; " +
				"add on:'output' to judge the notify text instead. Without steps it is one model step. profile: whose instructions, model and memory the run uses; model overrides; default fast. Same id replaces.",
			parameters: AddParams,
			structuredOutputSchema: Type.Object({ id: Type.String(), next: Type.Optional(Type.String()), url: Type.Optional(Type.String()), secret: Type.Optional(Type.String()) }),
			replay: "safe",
			execute: async (args, api, context) => {
				const draft = parseWhen(args, deps.timeZone, deps.users);
				const { trigger, replaced } = await api.commit(async (tx) => {
					const existing = await scanTriggers(tx);
					let replaced: TaskId | undefined;
					const { id, created } = await journaled(tx, api.taskId, "trigger", async () => {
						const added = await addTrigger(tx, deps.task, { trigger: draft, origin: "model" }, existing, deps.catalog);
						replaced = added.replaced;
						return added.id;
					});
					const trigger = created ? draft : existing.find((record) => record.id === id)!.input.trigger;
					return { trigger, replaced };
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
			"Message the owner now, or in a trigger run the trigger's recipients, only when it needs their attention. Refused in root: there, your reply is the message. " +
			"channel defaults to where the owner last wrote; users get iMessage. attachments: work-relative or absolute paths under home, each under 100 MB.",
		parameters: Type.Object({
			text: Type.String({ minLength: 1 }),
			channel: Type.Optional(Type.Union(channelNames.map((id) => Type.Literal(id)))),
			attachments: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			if (api.conversationId === ROOT_CONVERSATION_ID) throw new Error("This is the owner's own thread: your reply reaches them. notify is for agents working out of their sight.");
			const trigger = await api.commit(async (tx) => (await scanTriggers(tx, api.conversationId)).at(-1)?.input.trigger, context);
			for (const [index, step] of (trigger === undefined ? [] : outputSteps(trigger)).entries()) {
				const key = `classify:${index}`;
				const yes = (await api.memo<number>(key, context)) ?? (await api.memo(key, await classifyYes(deps.classify, step, { trigger: trigger!.id, purpose: trigger!.prompt, message: args.text }, deps.log, context), context));
				if (yes < (step.threshold ?? 0.5)) {
					deps.log("notify.stopped", { trigger: trigger!.id, step: index, yes });
					return { output: [{ type: "text", text: `Not sent: the trigger's classify step judged no to "${step.question}" (p=${yes.toFixed(2)}). Finish without notifying.` }] };
				}
			}
			const text = await withAttachments(args.text, args.attachments ?? [], deps.line().workDir);
			const last = (await api.snapshot(LastInboundDoc, context))?.last?.channel;
			const channel = (args.channel as ChannelId | undefined) ?? (last !== undefined && deps.channels.includes(last) ? last : (deps.channels[0] ?? "cli"));
			const from = trigger === undefined ? ({ kind: "conversation", id: api.conversationId } as const) : ({ kind: "trigger", id: trigger.id } as const);
			const turns: RunTurn[] = [];
			const queued: string[] = [];
			for (const recipient of trigger?.notify ?? [OWNER_ID]) {
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
