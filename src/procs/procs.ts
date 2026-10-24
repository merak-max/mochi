import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool, type TaskId, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { parseWith } from "../parse.ts";
import { addSchedule, live, scanSchedules, type ScheduleTask } from "../schedule/schedule.ts";
import { ProcName } from "../schedule/types.ts";
import type { Definitions } from "../agents/definitions.ts";

export const PROC_POLL_MS = 1000;
const TAIL_BYTES = 256 * 1024;
const STOP_GRACE_MS = 3000;

const WRAPPER = `trap 'true' TERM INT HUP
sh -c "$1"
code=$?
printf '%s\\n' "$code" > "$2.tmp" && mv "$2.tmp" "$2"`;

const Name = ProcName;

const MetaSchema = Type.Object({
	name: Type.String(),
	command: Type.String(),
	cwd: Type.String(),
	pid: Type.Integer(),
	startedAt: Type.String(),
	watch: Type.Optional(Type.String()),
});
type Meta = Static<typeof MetaSchema>;

type Status = { readonly state: "running" } | { readonly state: "exited"; readonly code: number } | { readonly state: "lost" };

interface ProcFiles {
	readonly log: string;
	readonly meta: string;
	readonly exit: string;
}

export const filesOf = (dir: string, name: string): ProcFiles => ({ log: join(dir, `${name}.log`), meta: join(dir, `${name}.json`), exit: join(dir, `${name}.exit`) });

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

export async function procStatus(files: ProcFiles, pid: number): Promise<Status> {
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

export async function readFrom(path: string, offset: number): Promise<Buffer> {
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

export async function tailLines(path: string, count: number): Promise<string[]> {
	const size = (await stat(path).catch(() => undefined))?.size ?? 0;
	const lines = (await readFrom(path, Math.max(0, size - TAIL_BYTES))).toString("utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.slice(-count);
}

export async function stopGroup(pid: number, files: ProcFiles): Promise<void> {
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

async function startProcess(files: ProcFiles, command: string, cwd: string): Promise<number> {
	await rm(files.exit, { force: true });
	const argv = ["sh", "-c", WRAPPER, "mochi-proc", command, files.exit];
	const underSystemd = process.env.INVOCATION_ID !== undefined;
	const file = underSystemd ? "systemd-run" : "sh";
	const args = underSystemd ? ["--user", "--scope", "--quiet", "--collect", "--", ...argv] : argv.slice(1);
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

interface ProcFnDeps {
	readonly task: ScheduleTask;
	readonly catalog: Definitions;
	readonly dir: string;
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
	const liveWatchers = (api: ToolExecutionApi, name: string, context: Context): Promise<TaskId[]> =>
		api.commit(async (tx) => {
			const watching = (await scanSchedules(tx)).filter((task) => live(task) && "process" in task.input.schedule.when && task.input.schedule.when.process.name === name);
			return watching.map((task) => task.id);
		}, context);

	return [
		defineTool({
			name: "proc_start",
			description:
				"Run a shell command in the background and return at once. Use it for any command that can take more than 30 seconds. This conversation wakes with the log tail when the command exits, and once when a line first matches the watch regex: proc_start adds a process schedule, proc-<name>, that schedule_list shows.",
			parameters: Type.Object({ name: Name, command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String()), watch: Type.Optional(Type.String({ minLength: 1 })) }),
			structuredOutputSchema: Type.Object({ name: Type.String(), pid: Type.Number(), log: Type.String() }),
			replay: "unsafe",
			execute: async ({ name, command, cwd, watch }, api, context) => {
				if (watch !== undefined) checkPattern(watch);
				const files = filesOf(deps.dir, name);
				if ((await liveWatchers(api, name, context)).length > 0) throw new Error(`Process ${name} is still running. Stop it or pick another name.`);
				const previous = await readMeta(files);
				if (previous !== undefined && (await procStatus(files, previous.pid)).state === "running") throw new Error(`Process ${name} is still running. Stop it or pick another name.`);
				const directory = cwd === undefined ? deps.workDir : isAbsolute(cwd) ? cwd : resolve(deps.workDir, cwd);
				await mkdir(deps.dir, { recursive: true });
				const pid = await startProcess(files, command, directory);
				const meta: Meta = { name, command, cwd: directory, pid, startedAt: new Date().toISOString(), ...(watch === undefined ? {} : { watch }) };
				await writeFile(files.meta, `${JSON.stringify(meta)}\n`);
				const process = { name, pid, ...(watch === undefined ? {} : { watch }) };
				const schedule = { id: `proc-${name}`, when: { process }, prompt: `Output of process ${name} (${command}), last lines:` };
				await api.commit(async (tx) => {
					const existing = await scanSchedules(tx);
					await addSchedule(tx, deps.task, { schedule, origin: "model" }, existing, deps.catalog, api.conversationId);
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
					const status = await procStatus(files, meta.pid);
					rows.push({ name: each, ...status, pid: meta.pid, command: meta.command, startedAt: meta.startedAt, log: files.log });
				}
				return { structuredOutput: rows };
			},
		}),
		defineTool({
			name: "proc_logs",
			description: "The last lines of a background process's output, stdout and stderr together.",
			parameters: Type.Object({ name: Name, tail: Type.Optional(Type.Integer({ minimum: 1 })) }),
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
