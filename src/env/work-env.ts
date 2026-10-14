import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, ExecutionError, FileError, ok, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

// bash, read, edit and write run as the daemon's user with its whole environment and every path it can reach.

const EXEC_TIMEOUT_SECONDS = 600;

/**
 * The environment for one working directory. A bash call with no `timeout` of its own gets `EXEC_TIMEOUT_SECONDS`, so a hung
 * command cannot hold a run forever. Temp and spill files go to `workDir/.tmp`, so the model finds what a tool points to.
 */
export function workEnv(workDir: string, cwd: string): WorkEnv {
	mkdirSync(tmpDir(workDir), { recursive: true });
	return new WorkEnv(workDir, resolve(cwd));
}

class WorkEnv extends NodeExecutionEnv {
	readonly #workDir: string;

	constructor(workDir: string, cwd: string) {
		super({ cwd });
		this.#workDir = workDir;
	}

	override async createTempDir(prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
		const parent = tmpDir(this.#workDir);
		try {
			return ok(await mkdtemp(join(parent, prefix ?? "tmp-")));
		} catch (error) {
			return err(new FileError("unknown", String(error), parent));
		}
	}

	override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const result = await super.exec(command, { ...options, timeout: options?.timeout ?? EXEC_TIMEOUT_SECONDS }, context);
		if (result.ok || result.error.code !== "timeout" || options?.timeout !== undefined) return result;
		const timedOut = new ExecutionError("unknown", `Command timed out after ${EXEC_TIMEOUT_SECONDS} seconds, the default limit. Pass a timeout if it needs longer.`);
		if (result.error.spillPath !== undefined) timedOut.spillPath = result.error.spillPath;
		return err(timedOut);
	}
}

const tmpDir = (workDir: string): string => join(workDir, ".tmp");
