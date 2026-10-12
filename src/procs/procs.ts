import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTask, defineTool, type NextTaskState, ROOT_CONVERSATION_ID, type Task, type TaskId, type ToolExecutionApi, type ToolRegistration, type TaskRuntime } from "@earendil-works/pi-durable";
import type { Log } from "../log.ts";
import { allPages } from "../pages.ts";
import { parseWith } from "../parse.ts";
import { clip } from "../text.ts";
import { LastInboundDoc, type Line, openTurn } from "../turn/turn.ts";

export const PROC_POLL_MS = 1000;
const WAKE_LINES = 30;
const LINE_CHARS = 300;
const TAIL_BYTES = 256 * 1024;
const STOP_GRACE_MS = 3000;

const KIND = "mochi.proc";

/** The wrapper keeps running through a TERM to its group, so it can write the exit code once the command ends. */
const WRAPPER = `trap 'true' TERM INT HUP
sh -c "$1"
code=$?
printf '%s\\n' "$code" > "$2.tmp" && mv "$2.tmp" "$2"`;

const Name = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 40 });

const MetaSchema = Type.Object({
	name: Type.String(),
	command: Type.String(),
	cwd: Type.String(),
	pid: Type.Integer(),
	startedAt: Type.String(),
	watch: Type.Optional(Type.String()),
});
type Meta = Static<typeof MetaSchema>;

type ProcInput = { readonly name: string; readonly pid: number; readonly watch?: string };
type ProcState = { readonly phase: "watch"; readonly fired: boolean };
type ProcResult = { readonly code: number | null };
export type ProcTask = Task<ProcInput, ProcState, ProcResult, object>;

type Status = { readonly state: "running" } | { readonly state: "exited"; readonly code: number } | { readonly state: "lost" };

interface ProcFiles {
	readonly log: string;
	readonly meta: string;
	readonly exit: string;
}

const filesOf = (dir: string, name: string): ProcFiles => ({ log: join(dir, `${name}.log`), meta: join(dir, `${name}.json`), exit: join(dir, `${name}.exit`) });

async function exitCode(files: ProcFiles): Promise<number | undefined> {
	const text = await readFile(files.exit, "utf8").catch(() => undefined);
	if (text === undefined || text.trim() === "") return undefined;
	return Number(text.trim());
}

function signal(pid: number, name: NodeJS.Signals | 0): boolean {
	try {
		process.kill(pid, name);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function statusOf(files: ProcFiles, pid: number): Promise<Status> {
	const code = await exitCode(files);
	if (code !== undefined) return { state: "exited", code };
	if (signal(pid, 0)) return { state: "running" };
	const late = await exitCode(files);
	if (late !== undefined) return { state: "exited", code: late };
	return { state: "lost" };
}

async function readMeta(files: ProcFiles): Promise<Meta | undefined> {
	const text = await readFile(files.meta, "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	return parseWith(MetaSchema, JSON.parse(text), files.meta);
}

/** The last `count` lines of the log, read from at most its last TAIL_BYTES. */
async function tailLines(path: string, count: number): Promise<string[]> {
	const file = await open(path, "r").catch(() => undefined);
	if (file === undefined) return [];
	try {
		const { size } = await file.stat();
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		await file.read(buffer, 0, length, size - length);
		const lines = buffer.toString("utf8").split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines.slice(-count);
	} finally {
		await file.close();
	}
}

/** Bytes appended to the log since `offset`. */
async function readFrom(path: string, offset: number): Promise<Buffer> {
	const file = await open(path, "r").catch(() => undefined);
	if (file === undefined) return Buffer.alloc(0);
	try {
		const { size } = await file.stat();
		if (size <= offset) return Buffer.alloc(0);
		const buffer = Buffer.alloc(size - offset);
		await file.read(buffer, 0, buffer.length, offset);
		return buffer;
	} finally {
		await file.close();
	}
}

/** TERM to the whole group, KILL after a grace period. Writes 137 when the wrapper died before it wrote a code. */
async function stopGroup(pid: number, files: ProcFiles): Promise<void> {
	if (!signal(-pid, 0)) return;
	signal(-pid, "SIGTERM");
	const until = Date.now() + STOP_GRACE_MS;
	while (Date.now() < until) {
		await sleep(50);
		if (!signal(-pid, 0)) return;
	}
	signal(-pid, "SIGKILL");
	if ((await exitCode(files)) === undefined) await writeFile(files.exit, "137\n");
}

/** Under systemd, a scope of its own keeps the process alive when the daemon's unit stops or restarts. */
function launcher(argv: readonly string[]): { file: string; args: string[] } {
	if (process.env.INVOCATION_ID === undefined) return { file: argv[0]!, args: argv.slice(1) };
	return { file: "systemd-run", args: ["--user", "--scope", "--quiet", "--collect", "--", ...argv] };
}

async function startProcess(files: ProcFiles, command: string, cwd: string): Promise<number> {
	await rm(files.exit, { force: true });
	const { file, args } = launcher(["sh", "-c", WRAPPER, "mochi-proc", command, files.exit]);
	const log = openSync(files.log, "w");
	let child;
	try {
		child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", log, log] });
	} finally {
		closeSync(log);
	}
	await new Promise<void>((resolveSpawn, reject) => {
		child.once("spawn", resolveSpawn);
		child.once("error", reject);
	});
	child.unref();
	if (child.pid === undefined) throw new Error(`${file} did not start.`);
	return child.pid;
}

function checkPattern(watch: string): void {
	try {
		new RegExp(watch);
	} catch (error) {
		throw new Error(`watch is not a valid regex: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function wakeBody(lines: readonly string[]): string {
	if (lines.length === 0) return "(no output)";
	return lines.map((line) => clip(line, LINE_CHARS)).join("\n");
}

export interface ProcWatchDeps {
	readonly dir: string;
	readonly line: () => Line;
	readonly pollMs: number;
	readonly log: Log;
}

type ProcRuntime = TaskRuntime<ProcInput, ProcState, ProcResult, object>;

/**
 * The watcher. A wake into root goes through an owner Turn on the owner's last chat channel, so the reply reaches
 * them; any other conversation, or a root with no chat yet, gets the input directly. Both use a request id per task
 * and event, so a rerun after a crash delivers nothing twice.
 */
export function defineProcWatch(deps: ProcWatchDeps): ProcTask {
	const wake = async (task: { readonly id: TaskId }, runtime: ProcRuntime, event: "watch" | "exit", tag: string, body: string, next: NextTaskState<ProcState, ProcResult>, context: Context) => {
		const key = `proc:${task.id}:${event}`;
		deps.log("proc.wake", { task: task.id, event, tag });
		const last = runtime.conversationId === ROOT_CONVERSATION_ID ? (await runtime.snapshot(LastInboundDoc, context))?.last : undefined;
		if (last !== undefined && last !== null) {
			await runtime.commit(async (tx) => {
				await openTurn(tx, deps.line(), { source: "owner", channel: last.channel, key, tag, text: body, files: [] });
				return next;
			}, context);
			return;
		}
		const conversation = await runtime.conversation(runtime.conversationId, context);
		if (conversation === undefined) throw new Error(`Conversation ${runtime.conversationId} is missing.`);
		await conversation.submit({ type: "input", content: `${tag}\n${body}`, requestId: key, whenBusy: "followUp" }, context);
		await runtime.commit(() => next, context);
	};

	return defineTask<ProcInput, ProcState, ProcResult>({
		name: KIND,
		version: 1,
		initial: () => ({ phase: "watch", fired: false }),
		phases: {
			watch: async (task, runtime, context) => {
				const { name, pid, watch } = task.input;
				const files = filesOf(deps.dir, name);
				const pattern = watch === undefined || task.state.checkpoint.fired ? undefined : new RegExp(watch);
				let offset = 0;
				let partial = "";
				for (;;) {
					const status = await statusOf(files, pid);
					const ended = status.state !== "running";
					if (pattern !== undefined) {
						const appended = await readFrom(files.log, offset);
						offset += appended.length;
						const lines = (partial + appended.toString("utf8")).split("\n");
						partial = ended ? "" : lines.pop()!;
						if (lines.some((line) => pattern.test(line))) {
							const tag = `[process ${name} matched /${watch}/, ${ended ? "now ended" : "still running"}]`;
							const body = wakeBody(await tailLines(files.log, WAKE_LINES));
							return wake(task, runtime, "watch", tag, body, { status: "running", checkpoint: { phase: "watch", fired: true } }, context);
						}
					}
					if (ended) {
						const code = status.state === "exited" ? status.code : null;
						const tag = code === null ? `[process ${name} ended, exit code unknown]` : `[process ${name} exited code=${code}]`;
						const body = wakeBody(await tailLines(files.log, WAKE_LINES));
						return wake(task, runtime, "exit", tag, body, { status: "terminal", outcome: { status: "completed", result: { code } } }, context);
					}
					await runtime.sleep(runtime.now() + deps.pollMs, context);
				}
			},
		},
		abort: async (task, runtime, context) => {
			await stopGroup(task.input.pid, filesOf(deps.dir, task.input.name));
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}

export interface ProcFnDeps {
	readonly task: ProcTask;
	readonly dir: string;
	/** Where a relative `cwd` resolves, and the default one. */
	readonly workDir: string;
	readonly abortTask: (id: TaskId, context: Context) => Promise<unknown>;
}

const StatusRow = Type.Object({
	name: Type.String(),
	state: Type.Union([Type.Literal("running"), Type.Literal("exited"), Type.Literal("lost")]),
	code: Type.Optional(Type.Number()),
	pid: Type.Number(),
	command: Type.String(),
	startedAt: Type.String(),
	log: Type.String(),
});

export function procFns(deps: ProcFnDeps): ToolRegistration[] {
	const liveWatchers = async (api: ToolExecutionApi, name: string, context: Context): Promise<TaskId[]> => {
		const found: TaskId[] = [];
		await api.commit(async (tx) => {
			const tasks = await allPages((cursor) => tx.scanTasks({ kind: KIND }, 256, cursor));
			for (const task of tasks) {
				const input = task.input as ProcInput;
				if (input.name === name && task.state.status !== "terminal") found.push(task.id);
			}
		}, context);
		return found;
	};

	return [
		defineTool({
			name: "proc_start",
			description:
				"Run a shell command in the background and return at once. Use it for any command that can take more than 30 seconds. This conversation wakes with the log tail when the command exits, and once when a line first matches the watch regex.",
			parameters: Type.Object({ name: Name, command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String()), watch: Type.Optional(Type.String({ minLength: 1 })) }),
			structuredOutputSchema: Type.Object({ name: Type.String(), pid: Type.Number(), log: Type.String() }),
			replay: "unsafe",
			execute: async ({ name, command, cwd, watch }, api, context) => {
				if (watch !== undefined) checkPattern(watch);
				const files = filesOf(deps.dir, name);
				if ((await liveWatchers(api, name, context)).length > 0) throw new Error(`Process ${name} is still running. Stop it or pick another name.`);
				const previous = await readMeta(files);
				if (previous !== undefined && (await statusOf(files, previous.pid)).state === "running") throw new Error(`Process ${name} is still running. Stop it or pick another name.`);
				const directory = cwd === undefined ? deps.workDir : isAbsolute(cwd) ? cwd : resolve(deps.workDir, cwd);
				await mkdir(deps.dir, { recursive: true });
				const pid = await startProcess(files, command, directory);
				const meta: Meta = { name, command, cwd: directory, pid, startedAt: new Date().toISOString(), ...(watch === undefined ? {} : { watch }) };
				await writeFile(files.meta, `${JSON.stringify(meta)}\n`);
				const input: ProcInput = { name, pid, ...(watch === undefined ? {} : { watch }) };
				await api.commit(async (tx) => {
					await tx.createTask(deps.task, input, { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true });
				}, context);
				return { structuredOutput: { name, pid, log: files.log } };
			},
		}),
		defineTool({
			name: "proc_status",
			description: "State of one background process, or of every one: running, exited with its code, or lost.",
			parameters: Type.Object({ name: Type.Optional(Name) }),
			structuredOutputSchema: Type.Array(StatusRow),
			replay: "safe",
			execute: async ({ name }) => {
				const names = name !== undefined ? [name] : (await readdir(deps.dir).catch(() => [])).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -".json".length)).sort();
				const rows = [];
				for (const each of names) {
					const files = filesOf(deps.dir, each);
					const meta = await readMeta(files);
					if (meta === undefined) throw new Error(`No process named ${each}.`);
					const status = await statusOf(files, meta.pid);
					rows.push({ name: each, ...status, pid: meta.pid, command: meta.command, startedAt: meta.startedAt, log: files.log });
				}
				return { structuredOutput: rows };
			},
		}),
		defineTool({
			name: "proc_logs",
			description: "The last lines of a background process's output, stdout and stderr together.",
			parameters: Type.Object({ name: Name, tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
			structuredOutputSchema: Type.String(),
			replay: "safe",
			execute: async ({ name, tail }) => {
				const files = filesOf(deps.dir, name);
				if ((await readMeta(files)) === undefined) throw new Error(`No process named ${name}.`);
				return { structuredOutput: (await tailLines(files.log, tail ?? 50)).join("\n") };
			},
		}),
		defineTool({
			name: "proc_stop",
			description: "Stop a background process and its children. No wake-up follows.",
			parameters: Type.Object({ name: Name }),
			structuredOutputSchema: Type.Object({ name: Type.String(), code: Type.Union([Type.Number(), Type.Null()]) }),
			replay: "safe",
			execute: async ({ name }, api, context) => {
				const files = filesOf(deps.dir, name);
				const meta = await readMeta(files);
				if (meta === undefined) throw new Error(`No process named ${name}.`);
				for (const id of await liveWatchers(api, name, context)) {
					await deps.abortTask(id, context);
					await api.waitForTask(id, context);
				}
				await stopGroup(meta.pid, files);
				return { structuredOutput: { name, code: (await exitCode(files)) ?? null } };
			},
		}),
	];
}
