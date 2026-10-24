import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { type Static, Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineDocFamily, defineTask, defineTool, type Harness, type NextTaskState, type TaskId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { ChannelId } from "../channels/types.ts";
import { holdText } from "../context.ts";
import type { Log } from "../log.ts";
import { parseWith } from "../parse.ts";
import { createSeatConversation } from "../seats.ts";
import { formatStamp } from "../text.ts";
import { answerText, LastInboundDoc, type Line, NO_REPLY, openTurn } from "../turn/turn.ts";
import { agentOf, applyAgent, type Definitions, residentConversation } from "../agents/definitions.ts";
import { classifyYes, type Classify } from "../brain/classifier.ts";
import { assertTimeZone, nextCronSlot, parseCron } from "./cron.ts";

// The board holds what is owed. An item stays on it until board_done removes it. An item with `when` fires: a clock
// task sleeps until each slot and starts one fire task per slot; a webhook delivery starts a fire task directly. A fire
// runs `check`, then messages the item's owner. Root gets a chat Turn, so its final text reaches the owner. A definition
// gets the message in its conversation, and its final text goes to the owner as a run Turn, after the gate passes.

const Id = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 });

const WebhookAuthSchema = Type.Union([
	Type.Object({ kind: Type.Literal("hmac-sha256"), header: Type.String({ minLength: 1 }), secret: Type.String({ minLength: 16 }) }),
	Type.Object({ kind: Type.Literal("bearer"), token: Type.String({ minLength: 16 }) }),
]);
export type WebhookAuth = Static<typeof WebhookAuthSchema>;

const AtSchema = Type.Object({ at: Type.String({ minLength: 1 }) });
const CronSchema = Type.Object({ cron: Type.String({ minLength: 1 }), tz: Type.String({ minLength: 1 }) });
const WebhookSchema = Type.Object({ webhook: Type.Object({ auth: WebhookAuthSchema }) });
type Clocked = Static<typeof AtSchema> | Static<typeof CronSchema>;

const GateSchema = Type.Object({
	question: Type.String({ minLength: 1 }),
	yes: Type.String({ minLength: 1 }),
	no: Type.String({ minLength: 1 }),
	threshold: Type.Number({ minimum: 0, maximum: 1 }),
});

const ItemSchema = Type.Object({
	id: Id,
	text: Type.String({ minLength: 1 }),
	owner: Id,
	when: Type.Optional(Type.Union([AtSchema, CronSchema, WebhookSchema])),
	check: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	gate: Type.Optional(GateSchema),
});
type Item = Static<typeof ItemSchema>;

const ROOT_OWNER = "root";

/** The board. `clocks`: the clock task of each item with an `at` or `cron`. */
export const BoardDoc = defineDoc<{ items: Record<string, Item>; clocks: Record<string, TaskId> }>({
	kind: "mochi.board-items",
	version: 1,
	scope: "session",
	initial: () => ({ items: {}, clocks: {} }),
	checkpointWhen: () => false,
});

/** The fire task each webhook delivery started, so a redelivery starts none. */
const DeliveryDoc = defineDocFamily<{ task: TaskId | null }, null>({
	kind: "mochi.board-delivery",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ task: null }),
	checkpointWhen: () => false,
});

const CHECK_TIMEOUT_MS = 5 * 60_000;
const OFFSET = /[zZ]|[+-]\d\d:?\d\d$/;

const iso = (at: number): string => new Date(at).toISOString();

function describeWhen(when: Item["when"]): string {
	if (when === undefined) return "no time";
	if ("cron" in when) return `${when.cron} ${when.tz}`;
	if ("at" in when) return `at ${when.at}`;
	return `webhook (${when.webhook.auth.kind})`;
}

/** The first slot after `after`; undefined when none is left. */
function slotAfter(when: Clocked, after: number): number | undefined {
	if ("at" in when) {
		const at = Date.parse(when.at);
		return at > after ? at : undefined;
	}
	return nextCronSlot(parseCron(when.cron), when.tz, new Date(after))?.getTime();
}

/** Throws when an item cannot be kept: an unknown owner, a bad cron, zone or time, or a gate on root. */
async function checkItem(item: Item, definitions: Definitions): Promise<void> {
	const { when } = item;
	if (item.owner !== ROOT_OWNER) await definitions.get(item.owner);
	if (item.owner === ROOT_OWNER && item.gate !== undefined) throw new Error(`Item ${item.id}: a gate judges a definition's answer; root answers the owner directly, so give the item to a definition or drop the gate.`);
	if (when !== undefined && "cron" in when) {
		parseCron(when.cron);
		assertTimeZone(when.tz);
	}
	if (when !== undefined && "at" in when && (Number.isNaN(Date.parse(when.at)) || !OFFSET.test(when.at))) throw new Error(`Invalid at "${when.at}"; use ISO 8601 with an offset, such as 2026-10-15T09:00:00+05:30.`);
}

type ClockInput = { readonly id: string; readonly when: Clocked; readonly since: number };
type ClockState = { readonly phase: "wait"; readonly covered: number };

type FireInput = { readonly id: string; readonly key: string; readonly payload?: string; readonly missed?: number };
type FireState =
	| { readonly phase: "check" }
	| { readonly phase: "start"; readonly item: Item; readonly message: string }
	| { readonly phase: "ask"; readonly item: Item; readonly message: string; readonly conversation: ConversationId }
	| { readonly phase: "send"; readonly item: Item; readonly answer: string };
type FireResult = "sent" | "quiet" | "silent" | "gated" | "gone";

export interface BoardTasks {
	readonly clock: ReturnType<typeof defineClock>;
	readonly fire: ReturnType<typeof defineFire>;
}

interface BoardDeps {
	readonly line: () => Line;
	readonly definitions: Definitions;
	readonly classify: Classify;
	readonly timeZone: string;
	readonly workDir: string;
	readonly log: Log;
}

export function defineBoard(deps: BoardDeps): BoardTasks {
	const fire = defineFire(deps);
	return { fire, clock: defineClock(fire, deps.line) };
}

/** Starts a fire of item `id` as a background task of the line, so no conversation's abort reaches it. Call inside a commit. */
function startFire(tx: Tx, fire: BoardTasks["fire"], line: ConversationId, input: FireInput): Promise<TaskId<FireResult>> {
	return tx.createTask(fire, input, { ownership: { kind: "conversation" }, conversationId: line, background: true });
}

/**
 * Sleeps until the next slot after `covered`. When slots passed while the daemon was down, it fires once for the
 * latest and says how many it skipped. An `at` ends after its one fire; its item stays owed until board_done.
 */
function defineClock(fire: ReturnType<typeof defineFire>, line: () => Line) {
	return defineTask<ClockInput, ClockState, null>({
		name: "mochi.clock",
		version: 1,
		initial: ({ since }) => ({ phase: "wait", covered: since }),
		phases: {
			wait: async (task, runtime, context) => {
				const { id, when } = task.input;
				const { covered } = task.state.checkpoint;
				const now = runtime.now();
				let latest: number | undefined;
				let passed = 0;
				for (let slot = slotAfter(when, covered); slot !== undefined && slot <= now; slot = slotAfter(when, slot)) {
					latest = slot;
					passed++;
				}
				if (latest !== undefined) {
					const due = latest;
					const input: FireInput = passed > 1 ? { id, key: iso(due), missed: passed - 1 } : { id, key: iso(due) };
					return runtime.commit(async (tx) => {
						await startFire(tx, fire, line().id, input);
						return { status: "running", checkpoint: { phase: "wait", covered: due } };
					}, context);
				}
				const next = slotAfter(when, covered);
				if (next === undefined) return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
				return runtime.sleepUntil(next, task.state.checkpoint, context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

type CheckResult = { readonly out: string } | { readonly failed: string };

function runCheck(argv: readonly string[], stdin: string): Promise<CheckResult> {
	const [file, ...args] = argv as [string, ...string[]];
	return new Promise((resolve) => {
		const child = execFile(file, args, { timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error === null) resolve({ out: stdout.trim() });
			else resolve({ failed: `${error.message}\n${stderr}`.trim().slice(0, 2000) });
		});
		child.stdin?.end(stdin);
	});
}

const DEFINITION_HEADER = (id: string) =>
	`You own the board item ${id}. Each time it fires, its message comes here. Your final text goes to the owner verbatim; reply ${NO_REPLY} when nothing needs them. ` +
	"When the item has served its purpose, remove it with tools.board_done.";

/** The last chat channel the owner wrote on; a fire needs one to reach the owner. */
async function ownerChannel(tx: Tx, line: Line): Promise<ChannelId> {
	const last = (await tx.doc(LastInboundDoc)).last;
	if (last === null || !line.channels.has(last.channel)) throw new Error("The owner has not written on a chat channel yet, so a board fire has nowhere to reach them.");
	return last.channel;
}

function defineFire(deps: BoardDeps) {
	const { line, definitions, classify, timeZone, workDir, log } = deps;
	const done = (result: FireResult): NextTaskState<FireState, FireResult> => ({ status: "terminal", outcome: { status: "completed", result } });
	return defineTask<FireInput, FireState, FireResult>({
		name: "mochi.fire",
		version: 1,
		initial: () => ({ phase: "check" }),
		phases: {
			check: async (task, runtime, context) => {
				const { id, key, payload, missed } = task.input;
				const item = (await runtime.snapshot(BoardDoc, context))?.items[id];
				if (item === undefined) return runtime.commit(() => done("gone"), context);
				const parts = [item.text];
				if (item.check !== undefined) {
					const result = (await runtime.memo<CheckResult>("check", context)) ?? (await runtime.memo<CheckResult>("check", await runCheck(item.check, payload ?? ""), context));
					if ("out" in result && result.out === "") {
						log("board.quiet", { id, key });
						return runtime.commit(() => done("quiet"), context);
					}
					if ("failed" in result) log("board.check_failed", { id, key, error: result.failed });
					parts.push("out" in result ? `<check_output>\n${result.out}\n</check_output>` : `<check_failed>\n${result.failed}\n</check_failed>`);
				}
				if (payload !== undefined && item.check === undefined) parts.push(`<webhook_payload>\n${payload}\n</webhook_payload>`);
				if (missed !== undefined) parts.push(`(${missed} earlier slots passed while the daemon was down; this one fires for all of them.)`);
				return runtime.commit(() => ({ status: "running", checkpoint: { phase: "start", item, message: parts.join("\n") } }), context);
			},
			start: async (task, runtime, context) => {
				const { item, message } = task.state.checkpoint;
				const requestId = `board:${item.id}:${task.input.key}`;
				const stamp = formatStamp(new Date(runtime.now()), timeZone);
				if (item.owner === ROOT_OWNER) {
					return runtime.commit(async (tx) => {
						const channel = await ownerChannel(tx, line());
						await openTurn(tx, line(), { source: "chat", channel, key: requestId, tag: `[board ${item.id} ${stamp}]`, text: message, files: [], followUp: true });
						return done("sent");
					}, context);
				}
				const definition = await definitions.get(item.owner);
				return runtime.commit(async (tx) => {
					let conversation: ConversationId;
					if (definition.resident) {
						conversation = await residentConversation(tx, definition, definitions);
					} else {
						conversation = await createSeatConversation(tx, "agent", { kind: "task", taskId: task.id });
						await applyAgent(tx, conversation, agentOf(definition, definitions, DEFINITION_HEADER(item.id)));
					}
					const body = definition.resident ? `[from board] ${DEFINITION_HEADER(item.id)}\n[board ${item.id} ${stamp}]\n${message}` : `[board ${item.id} ${stamp}]\n${message}`;
					return { status: "running", checkpoint: { phase: "ask", item, message: body, conversation } };
				}, context);
			},
			ask: async (task, runtime, context) => {
				const { item, message, conversation } = task.state.checkpoint;
				const requestId = `board:${item.id}:${task.input.key}`;
				const host = { commit: (change: (tx: Tx) => Promise<void>, context: Context) => runtime.commit(async (tx) => void (await change(tx)), context) };
				const content = await holdText(host, workDir, conversation, `in:${requestId}`, message, context);
				const submission = await (await runtime.conversation(conversation, context))!.submit({ type: "input", content, requestId, whenBusy: "followUp" }, context);
				const settled = await submission.wait(context);
				return runtime.commit(async (tx) => {
					const answer = settled.status === "done" && settled.type === "input" ? await answerText(tx, settled.answer) : `(no answer from ${item.owner}: ${settled.reason ?? settled.status})`;
					return { status: "running", checkpoint: { phase: "send", item, answer } };
				}, context);
			},
			send: async (task, runtime, context) => {
				const { item, answer } = task.state.checkpoint;
				if (answer.trim() === NO_REPLY || answer.trim() === "") return runtime.commit(() => done("silent"), context);
				if (item.gate !== undefined) {
					type Verdict = { readonly yes: number } | { readonly failed: string };
					let verdict = await runtime.memo<Verdict>("gate", context);
					if (verdict === undefined) {
						const judged = await classifyYes(classify, item.gate, { item: item.id, purpose: item.text, message: answer }, log, context).then(
							(yes): Verdict => ({ yes }),
							(error: unknown): Verdict => ({ failed: String(error) }),
						);
						verdict = await runtime.memo<Verdict>("gate", judged, context);
					}
					if ("failed" in verdict) {
						log("board.gate_failed", { id: item.id, key: task.input.key, error: verdict.failed });
						return runtime.commit(() => done("gated"), context);
					}
					if (verdict.yes < item.gate.threshold) {
						log("board.gated", { id: item.id, key: task.input.key, yes: verdict.yes });
						return runtime.commit(() => done("gated"), context);
					}
				}
				return runtime.commit(async (tx) => {
					const channel = await ownerChannel(tx, line());
					await openTurn(tx, line(), { source: "run", channel, text: answer, from: { kind: "board", id: item.id } });
					return done("sent");
				}, context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

/**
 * Puts `item` on the board, replacing one with the same id, and starts its clock when it has an `at` or `cron`. Returns
 * the clock it replaced, for the caller to abort after the commit.
 */
async function putItem(tx: Tx, tasks: BoardTasks, line: ConversationId, item: Item, now: number): Promise<TaskId | undefined> {
	const board = await tx.doc(BoardDoc);
	const same = JSON.stringify(board.items[item.id]) === JSON.stringify(item);
	if (same) return undefined;
	const replaced = board.clocks[item.id];
	delete board.clocks[item.id];
	board.items[item.id] = item;
	const { when } = item;
	if (when === undefined || "webhook" in when) return replaced;
	// A cron counts from now. An `at` counts from the start of time, so one already past fires late, at once.
	const since = "at" in when ? 0 : now;
	board.clocks[item.id] = await tx.createTask(tasks.clock, { id: item.id, when, since }, { ownership: { kind: "conversation" }, conversationId: line, background: true });
	return replaced;
}

/** A webhook delivery of item `id`: one fire per delivery id, so a redelivery starts nothing. */
export async function deliverWebhook(tx: Tx, tasks: BoardTasks, line: ConversationId, id: string, delivery: string, payload: string): Promise<boolean> {
	const seen = await tx.doc(DeliveryDoc, `${id}:${delivery}`, null);
	if (seen.task !== null) return false;
	seen.task = await startFire(tx, tasks.fire, line, { id, key: `webhook:${delivery}`, payload });
	return true;
}

export const boardItems = async (harness: Pick<Harness, "snapshot">, context: Context): Promise<Item[]> => Object.values((await harness.snapshot(BoardDoc, context))?.items ?? {});

/** The next slot of a timed item after `now`, as an ISO string; a spent `at` has none. */
export function nextOf(item: Item, now: number): string | undefined {
	const { when } = item;
	if (when === undefined || "webhook" in when) return undefined;
	const next = slotAfter(when, now);
	return next === undefined ? undefined : iso(next);
}

const AddParams = Type.Object({
	id: Id,
	text: Type.String({ minLength: 1 }),
	owner: Id,
	when: Type.Optional(
		Type.Union([
			AtSchema,
			CronSchema,
			Type.Object({ webhook: Type.Object({ auth: Type.Union([Type.Literal("hmac"), Type.Literal("bearer")]) }) }),
		]),
	),
	check: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	gate: Type.Optional(GateSchema),
});

function itemOf(args: Static<typeof AddParams>): Item {
	const { when, ...rest } = args;
	if (when === undefined || !("webhook" in when)) return parseWith(ItemSchema, JSON.parse(JSON.stringify(args)), "item");
	const secret = randomBytes(32).toString("hex");
	const auth: WebhookAuth = when.webhook.auth === "bearer" ? { kind: "bearer", token: secret } : { kind: "hmac-sha256", header: "X-Hub-Signature-256", secret };
	return parseWith(ItemSchema, JSON.parse(JSON.stringify({ ...rest, when: { webhook: { auth } } })), "item");
}

interface BoardFnDeps {
	readonly tasks: BoardTasks;
	readonly line: () => Line;
	readonly definitions: Definitions;
	readonly abortTask: (id: TaskId, context: Context) => Promise<unknown>;
	/** Absent: no `[webhooks]` in config, so webhook items are refused. */
	readonly webhookUrl: string | undefined;
}

export function boardFns(deps: BoardFnDeps): ToolRegistration[] {
	return [
		defineTool({
			name: "board_add",
			description:
				"Put an item on the board: something owed, until board_done removes it. Same id replaces. owner: root (you) or a definition name. " +
				"No when: it is listed, never fires. when: {at:'<ISO with offset>'} fires once, for a promise or a follow-up; {cron:'m h dom mon dow', tz:'<IANA zone>'} fires each slot; " +
				"{webhook:{auth:'hmac'|'bearer'}} fires on each POST and returns the URL and secret. A fire messages the owner with text, so write text for a cold reader. " +
				"Root's final text then reaches the owner; a definition's final text goes to the owner verbatim, and NO_REPLY stays silent. " +
				"check: argv run first at each fire, with the webhook body on stdin; its stdout joins the message, empty stdout ends the fire with no model call, a failure is in the message. " +
				"gate (definition owners only): {question, yes, no, threshold} for the classifier on the definition's final text; below threshold or a classifier error, nothing is sent.",
			parameters: AddParams,
			structuredOutputSchema: Type.Object({ id: Type.String(), next: Type.Optional(Type.String()), url: Type.Optional(Type.String()), secret: Type.Optional(Type.String()) }),
			replay: "safe",
			execute: async (args, api, context) => {
				const draft = itemOf(args);
				if (draft.when !== undefined && "webhook" in draft.when && deps.webhookUrl === undefined) throw new Error("Webhooks are off: config.toml has no [webhooks] section.");
				await checkItem(draft, deps.definitions);
				// The memo keeps a webhook's secret across a replay; putItem leaves an unchanged item and its clock alone.
				const item = (await api.memo<Item>("item", context)) ?? (await api.memo<Item>("item", draft, context));
				const replaced = await api.commit((tx) => putItem(tx, deps.tasks, deps.line().id, item, api.now()), context);
				if (replaced !== undefined) await deps.abortTask(replaced, context);
				if (item.when !== undefined && "webhook" in item.when) {
					const { auth } = item.when.webhook;
					return { structuredOutput: { id: item.id, url: `${deps.webhookUrl}/hooks/${item.id}`, secret: auth.kind === "bearer" ? auth.token : auth.secret } };
				}
				return { structuredOutput: JSON.parse(JSON.stringify({ id: item.id, next: nextOf(item, api.now()) })) };
			},
		}),
		defineTool({
			name: "board_list",
			description: "Everything owed: each item's id, owner, when, next fire, and the start of its text.",
			parameters: Type.Object({}),
			structuredOutputSchema: Type.Array(Type.Object({ id: Type.String(), owner: Type.String(), when: Type.String(), next: Type.Optional(Type.String()), check: Type.Boolean(), gate: Type.Boolean(), text: Type.String() })),
			replay: "safe",
			execute: async (_args, api, context) => {
				const items = await boardItems(api, context);
				const rows: JsonValue[] = items.map((item) => JSON.parse(JSON.stringify({ id: item.id, owner: item.owner, when: describeWhen(item.when), next: nextOf(item, api.now()), check: item.check !== undefined, gate: item.gate !== undefined, text: item.text.slice(0, 200) })));
				return { structuredOutput: rows as never };
			},
		}),
		defineTool({
			name: "board_done",
			description: "Take an item off the board: the promise is kept, or the watch has served its purpose. Its clock stops; a fire already running finishes.",
			parameters: Type.Object({ id: Id }),
			structuredOutputSchema: Type.Literal("done"),
			replay: "safe",
			execute: async ({ id }, api, context) => {
				const clock = await api.commit(async (tx) => {
					const board = await tx.doc(BoardDoc);
					if (board.items[id] === undefined) throw new Error(`No board item ${id}.`);
					const clock = board.clocks[id];
					delete board.items[id];
					delete board.clocks[id];
					return clock;
				}, context);
				if (clock !== undefined) await deps.abortTask(clock, context);
				return { structuredOutput: "done" };
			},
		}),
	];
}
