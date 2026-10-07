import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { type Static, type TSchema, Type, type Usage } from "@earendil-works/pi-ai";
import { type CodemodeJsonSchema, CodemodeSandbox, type CodemodeTool, renderDeclarations } from "@earendil-works/pi-codemode";
import { defineDoc, defineTask, defineTool, type JsonObject, type Task, type TaskId, type TaskRuntime, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { parseWith } from "../parse.ts";

/** What a task created under each key, so a replayed call finds its child instead of creating a second one. */
export const Journal = defineDoc<{ created: Record<string, TaskId> }>({
	kind: "mochi.journal",
	version: 1,
	scope: "task",
	initial: () => ({ created: {} }),
});

/** Inside one commit: the task recorded under `key` on `owner`, or a new one from `create`, recorded in that commit. */
export async function journaled<R>(tx: Tx, owner: TaskId, key: string, create: () => Promise<TaskId<R>>): Promise<{ readonly id: TaskId<R>; readonly created: boolean }> {
	const journal = await tx.doc(Journal, owner);
	const found = journal.created[key];
	if (found !== undefined) return { id: found as TaskId<R>, created: false };
	const id = await create();
	journal.created[key] = id;
	return { id, created: true };
}

/**
 * What a crash after a nested call's intent does. `read` has no outside effect and reruns. `keyed` reruns because its
 * effect is recorded under its own call task or is idempotent. `once` has neither, so it is reported interrupted and
 * never rerun.
 */
export type Replay = "read" | "keyed" | "once";

export type CallInput = { readonly fn: string; readonly args: JsonObject };
type CallState = { readonly phase: "call" } | { readonly phase: "execute"; readonly replay: Replay };
export type CallResult = { readonly ok: true; readonly value: JsonValue; readonly usage?: Usage } | { readonly ok: false; readonly error: string };

/** What a script function may use: the runtime of its own `mochi.call` task. */
export type CallApi = Pick<TaskRuntime<CallInput, CallState, CallResult, object>, "taskId" | "conversationId" | "commit" | "waitForTask" | "conversation" | "env">;

/** A function a script calls as `tools.<name>(args)`, each call a durable `mochi.call` child task. */
export interface ScriptFn<P extends TSchema = TSchema> {
	readonly name: string;
	readonly description: string;
	readonly parameters: P;
	/** Rendered as the declaration's return type. */
	readonly output: TSchema;
	readonly replay: Replay;
	run(args: Static<P>, call: CallApi, context: Context): Promise<{ readonly value: JsonValue; readonly usage?: Usage }>;
}

export const defineFn = <P extends TSchema>(fn: ScriptFn<P>): ScriptFn => fn as unknown as ScriptFn;

export type Library = ReadonlyMap<string, ScriptFn>;

/** A nested call's key is `<fingerprint>#<occurrence>`, counted when the script makes the call, so a fan-out replays onto the same children. */
export function fingerprint(fn: string, args: JsonValue): string {
	const canonical = (value: JsonValue): JsonValue =>
		Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key]!)])) : value;
	return createHash("sha256").update(JSON.stringify([fn, canonical(args)])).digest("base64url").slice(0, 16);
}

const settle = (result: CallResult) => ({ status: "terminal", outcome: { status: "completed", result } }) as const;

/** `mochi.call`: intent is committed before the function runs, so a crash mid-call recovers in `execute`. */
export function callTask(library: Library): Task<CallInput, CallState, CallResult, object> {
	const run = async (fn: ScriptFn, input: CallInput, runtime: CallApi, context: Context): Promise<void> => {
		let result: CallResult;
		try {
			result = { ok: true, ...(await fn.run(input.args, runtime, context)) };
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		await runtime.commit(() => settle(result), context);
	};
	return defineTask<CallInput, CallState, CallResult>({
		name: "mochi.call",
		version: 1,
		initial: () => ({ phase: "call" }),
		phases: {
			call: async (task, runtime, context) => {
				const fn = library.get(task.input.fn);
				if (fn === undefined) return runtime.commit(() => settle({ ok: false, error: `No function ${task.input.fn}.` }), context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "execute", replay: fn.replay } }), context);
				await run(fn, task.input, runtime, context);
			},
			execute: async (task, runtime, context) => {
				const fn = library.get(task.input.fn);
				if (fn === undefined || task.state.checkpoint.replay === "once") {
					return runtime.commit(() => settle({ ok: false, error: `${task.input.fn} was interrupted and may have partially run. It was not run again.` }), context);
				}
				await run(fn, task.input, runtime, context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

/** A seat's functions: `inline` ones are declared in the description, the rest are found with `search()`. */
export interface SeatLibrary {
	readonly inline: readonly ScriptFn[];
	readonly tail: readonly ScriptFn[];
}

export const SCRIPT_DEADLINE_MS = 10 * 60_000;
const MEMORY_BYTES = 256 * 1024 * 1024;
const OUTPUT_CHARS = 40_000;

/** `store()` values of the conversation's scripts, kept across calls and restarts. */
const StoreDoc = defineDoc<{ values: { [key: string]: JsonValue } }>({
	kind: "mochi.codemode-store",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ values: {} }),
});

const INTRO =
	"Run JavaScript, an async function body, for everything beyond your direct tools. Only what it returns or prints " +
	"reaches you, so loop, filter and fan out with Promise.all inside it. tools.* calls are durable: after a restart the " +
	"script reruns and finished calls return their recorded result. Calls are real and not undone if the script fails; " +
	"a failed script lists the completed actions, so read it before rerunning. Scripts stop after 10 minutes. Pass times " +
	"in as arguments, never Date.now(). store(key, value) and load(key) keep small JSON between scripts; writes land on success.";

const declare = (fns: readonly ScriptFn[]): string =>
	renderDeclarations({
		tools: fns.map((fn) => ({ name: fn.name, description: fn.description, inputSchema: fn.parameters as CodemodeJsonSchema, outputSchema: fn.output as CodemodeJsonSchema, execute: () => undefined })),
	});

export interface CodeDeps {
	readonly call: Task<CallInput, CallState, CallResult, object>;
	/** Nested calls in flight per script, taken before each child is created: the scheduler starts every created task at once. */
	readonly concurrency: number;
	readonly deadlineMs: number;
	readonly abortTask: (id: TaskId, context: Context) => Promise<unknown>;
}

/** The `code` tool over one seat's library. Every nested call is a `mochi.call` child of this call's task. */
export function codeTool(library: SeatLibrary, deps: CodeDeps): ToolRegistration {
	const fns = [...library.inline, ...library.tail];
	return defineTool({
		name: "code",
		// Constant per seat, so it never churns the prompt cache.
		description: `${INTRO}\n\n${declare(library.inline)}\n/** Declarations of more functions: ${library.tail.map((fn) => fn.name).join(", ")}. */\ndeclare function search(query: string): Promise<string>;`,
		parameters: Type.Object({ code: Type.String({ minLength: 1 }) }),
		replay: "safe",
		execute: async (args, api, context) => {
			const seen = new Map<string, number>();
			const children: TaskId[] = [];
			const finished: { readonly fn: ScriptFn; readonly result: CallResult }[] = [];
			let stopped = false;
			let free = deps.concurrency;
			const queue: (() => void)[] = [];
			const release = () => (queue.length > 0 ? queue.shift()!() : free++);
			const nested = (fn: ScriptFn): CodemodeTool => ({
				name: fn.name,
				execute: async (raw) => {
					const input = parseWith(fn.parameters, raw ?? {}, `arguments for ${fn.name}`) as JsonObject;
					const print = fingerprint(fn.name, input);
					const occurrence = seen.get(print) ?? 0;
					seen.set(print, occurrence + 1);
					if (free > 0) free--;
					else await new Promise<void>((resolve) => queue.push(resolve));
					try {
						if (stopped) throw new Error("The script has ended.");
						const id = await api.commit(
							async (tx) =>
								(await journaled(tx, api.taskId, `${print}#${occurrence}`, () => tx.createTask(deps.call, { fn: fn.name, args: input }, { ownership: { kind: "task", taskId: api.taskId } }))).id,
							context,
						);
						children.push(id);
						if (stopped) await deps.abortTask(id, context);
						const outcome = (await api.waitForTask(id, context)).state.outcome;
						if (outcome.status !== "completed") throw new Error(`${fn.name} was ${outcome.status}.`);
						finished.push({ fn, result: outcome.result });
						if (!outcome.result.ok) throw new Error(outcome.result.error);
						return outcome.result.value;
					} finally {
						release();
					}
				},
			});
			const search: CodemodeTool = {
				name: "search",
				spread: true,
				execute: ([query]) => {
					const words = String(query).toLowerCase().split(/\W+/).filter(Boolean);
					const found = library.tail.filter((fn) => words.some((word) => `${fn.name} ${fn.description}`.toLowerCase().includes(word)));
					return declare(found.length > 0 ? found : library.tail);
				},
			};
			const sandbox = new CodemodeSandbox({ timeoutMs: deps.deadlineMs, memoryLimitBytes: MEMORY_BYTES, tools: fns.map(nested), globals: [search] });
			try {
				const store = (await api.snapshot(StoreDoc, api.conversationId, context))?.values ?? {};
				const signal = context.abortSignal;
				const result = await sandbox.execute(args.code, { store, ...(signal === undefined ? {} : { signal }) });
				stopped = true;
				await Promise.all(children.map((id) => deps.abortTask(id, context)));
				if (result.ok && (result.storeWrites.delete.length > 0 || Object.keys(result.storeWrites.set).length > 0)) {
					const writes = result.storeWrites;
					await api.commit(async (tx) => {
						const doc = await tx.doc(StoreDoc, api.conversationId);
						for (const key of writes.delete) delete doc.values[key];
						Object.assign(doc.values, writes.set as Record<string, JsonValue>);
					}, context);
				}
				const parts = result.output.map((item) => (item.type === "text" ? item.text : `[image ${item.mimeType} omitted]`));
				if (result.ok && result.value !== undefined) parts.push(typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 1));
				if (!result.ok) {
					parts.push(`Script error: ${result.error.stack ?? result.error.message}`);
					const acted = new Map<string, number>();
					for (const { fn, result } of finished) if (fn.replay === "once" && result.ok) acted.set(fn.name, (acted.get(fn.name) ?? 0) + 1);
					if (acted.size > 0) parts.push(`Completed before the error: ${[...acted].map(([name, count]) => `${name} ×${count}`).join(", ")}.`);
				}
				const usage = sumUsage(finished.flatMap(({ result }) => (result.ok && result.usage !== undefined ? [result.usage] : [])));
				return {
					content: [{ type: "text", text: bound([result.ok ? "Script completed." : `Script failed (${result.error.kind}).`, ...parts].join("\n")) }],
					isError: !result.ok,
					...(usage === undefined ? {} : { usage }),
				};
			} finally {
				await sandbox.close();
			}
		},
	});
}

function sumUsage(all: readonly Usage[]): Usage | undefined {
	type Counters = { [key: string]: number | Counters };
	const add = (total: Counters, next: Counters): Counters => {
		for (const [key, value] of Object.entries(next)) total[key] = typeof value === "number" ? ((total[key] as number | undefined) ?? 0) + value : add((total[key] as Counters | undefined) ?? {}, value);
		return total;
	};
	return all.length === 0 ? undefined : (all.slice(1).reduce((total, next) => add(total, next as unknown as Counters), structuredClone(all[0]) as unknown as Counters) as unknown as Usage);
}

function bound(text: string): string {
	if (text.length <= OUTPUT_CHARS) return text;
	const marker = `\n[... ${text.length - OUTPUT_CHARS} characters omitted; filter inside the script ...]\n`;
	const half = Math.floor((OUTPUT_CHARS - marker.length) / 2);
	return text.slice(0, half) + marker + text.slice(-half);
}
