import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig, unknownKeys } from "../config.ts";
import type { Home } from "../home.ts";
import { AttachClient, ProtocolError } from "./client.ts";
import { PROTOCOL } from "./protocol.ts";

/** How the client found the daemon: none listens, one answers in protocol 2, or one answers in another way. */
type Reach =
	| { readonly kind: "absent"; readonly reason: string }
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "ready"; readonly client: AttachClient };

export async function reach(socket: string, watch: boolean): Promise<Reach> {
	try {
		return { kind: "ready", client: await AttachClient.connect(socket, { watch }) };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (error instanceof ProtocolError) return { kind: "refused", reason };
		return { kind: "absent", reason };
	}
}

const UNIT = "mochi";
const UNIT_FILE = join(homedir(), ".config", "systemd", "user", `${UNIT}.service`);

type UnitState = { readonly installed: boolean; readonly active: boolean; readonly mainPid: number; readonly text?: string };

/** The systemd user unit, read with systemctl show. No systemctl: not installed. */
function unitState(): UnitState {
	const text = existsSync(UNIT_FILE) ? readFileSync(UNIT_FILE, "utf8") : undefined;
	let output = "";
	try {
		output = execFileSync("systemctl", ["--user", "show", UNIT, "-p", "ActiveState", "-p", "MainPID"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return { installed: false, active: false, mainPid: 0 };
	}
	let active = false;
	let mainPid = 0;
	for (const line of output.split("\n")) {
		if (line === "ActiveState=active") active = true;
		if (line.startsWith("MainPID=")) mainPid = Number(line.slice("MainPID=".length));
	}
	return { installed: text !== undefined, active, mainPid, ...(text === undefined ? {} : { text }) };
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

const STOP_WAIT_MS = 60_000;

function lockHolder(home: Home): number | undefined {
	const lockFile = join(home.dir, "mochi.lock");
	if (!existsSync(lockFile)) return undefined;
	const pid = Number(readFileSync(lockFile, "utf8").trim());
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function stopUnit(pid: number): number {
	process.stdout.write(`Stopping pid ${pid} through systemd: systemctl --user stop ${UNIT}\n`);
	execFileSync("systemctl", ["--user", "stop", UNIT], { stdio: "inherit" });
	process.stdout.write("Stopped.\n");
	return 0;
}

/**
 * mochi stop. The pid comes from the daemon's own hello, not the lock file. When systemd runs that pid, systemd stops it
 * (a SIGTERM alone would be undone by Restart=always). Otherwise SIGTERM, then wait until the pid and the socket are gone.
 * This command never sends SIGKILL; systemd may, after TimeoutStopSec. Returns the exit code.
 */
export async function stopDaemon(home: Home, socket: string): Promise<number> {
	const found = await reach(socket, false);
	if (found.kind === "absent") {
		process.stdout.write("mochi is not running.\n");
		return 0;
	}
	const unit = unitState();
	if (found.kind === "refused") {
		// An older daemon cannot say its pid. systemd may stop it only when systemd and the lock name the same process.
		const holder = lockHolder(home);
		if (unit.active && holder !== undefined && unit.mainPid === holder) return stopUnit(holder);
		process.stderr.write(`The daemon at ${socket} did not answer as mochi protocol ${PROTOCOL}: ${found.reason}\n`);
		if (holder !== undefined) process.stderr.write(`The lock file names pid ${holder}. Stop that process yourself.\n`);
		return 1;
	}
	const pid = found.client.daemon!.pid;
	found.client.close();
	if (unit.active && unit.mainPid === pid) return stopUnit(pid);
	process.stdout.write(`Sending SIGTERM to pid ${pid}.\n`);
	process.kill(pid, "SIGTERM");
	const deadline = Date.now() + STOP_WAIT_MS;
	while (Date.now() < deadline) {
		if (!isAlive(pid) && !existsSync(socket)) {
			process.stdout.write("Stopped.\n");
			return 0;
		}
		await sleep(200);
	}
	process.stderr.write(`pid ${pid} did not stop in ${STOP_WAIT_MS / 1000} s.\n`);
	return 1;
}

type Check = { readonly name: string; readonly level: "ok" | "warn" | "fail"; readonly detail: string };

const LOG_TAIL_BYTES = 512 * 1024;

/** mochi doctor: independent read-only checks. */
export async function doctor(home: Home, socket: string): Promise<Check[]> {
	const checks: Check[] = [];
	const add = (name: string, level: Check["level"], detail: string) => checks.push({ name, level, detail });

	if (!existsSync(home.dir)) add("home", "fail", `${home.dir} does not exist.`);
	else if ((statSync(home.dir).mode & 0o077) !== 0) add("home", "warn", `${home.dir} is readable by group or others. Fix: chmod 700 ${home.dir}`);
	else add("home", "ok", home.dir);

	try {
		const config = await loadConfig({ ...process.env });
		const unknown = unknownKeys(config.file);
		if (unknown.length > 0) add("config", "warn", `config.toml has keys mochi does not read: ${unknown.join(", ")}`);
		else if (config.modelSetup.missing.length > 0) add("config", "warn", config.modelSetup.missing.join("; "));
		else add("config", "ok", home.configFile);
	} catch (error) {
		add("config", "fail", error instanceof Error ? error.message : String(error));
	}

	const holder = lockHolder(home);
	if (holder === undefined) add("lock", "ok", "no lock file");
	else if (isAlive(holder)) add("lock", "ok", `held by pid ${holder}`);
	else add("lock", "warn", `stale: pid ${holder} is gone. The next start replaces it.`);

	const started = Date.now();
	const found = await reach(socket, false);
	let daemonPid: number | undefined;
	if (found.kind === "absent") add("socket", holder !== undefined && isAlive(holder) ? "fail" : "warn", `no daemon answers at ${socket}`);
	else if (found.kind === "refused") add("socket", "fail", found.reason);
	else {
		const info = found.client.daemon!;
		daemonPid = info.pid;
		found.client.close();
		add("socket", "ok", `pid ${info.pid}, protocol ${info.protocol}, build ${info.build}, ${Date.now() - started} ms`);
		if (holder !== undefined && holder !== info.pid) add("lock", "fail", `the lock names pid ${holder} but pid ${info.pid} answers the socket`);
	}

	const unit = unitState();
	if (!unit.installed) add("systemd", "warn", "no user unit. Fix: mochi service install");
	else {
		const missing: string[] = [];
		for (const setting of ["KillSignal=SIGTERM", "TimeoutStopSec="]) {
			if (!unit.text!.includes(setting)) missing.push(setting);
		}
		if (missing.length > 0) add("systemd", "warn", `the unit lacks ${missing.join(", ")}. Fix: mochi service install`);
		else if (!unit.active) add("systemd", "warn", "the unit is not active");
		else if (daemonPid !== undefined && unit.mainPid !== daemonPid) add("systemd", "warn", `the unit runs pid ${unit.mainPid}, but pid ${daemonPid} answers this home's socket`);
		else add("systemd", "ok", `active, MainPID ${unit.mainPid}`);
	}

	if (!existsSync(home.logFile)) add("log", "ok", "no log file");
	else {
		const size = statSync(home.logFile).size;
		const text = readTail(home.logFile, size);
		let crashes = 0;
		for (const line of text.split("\n")) {
			if (line.includes('"event":"mochi.crashed"')) crashes++;
		}
		add("log", crashes === 0 ? "ok" : "warn", `${crashes} mochi.crashed in the last ${Math.min(size, LOG_TAIL_BYTES)} bytes of ${home.logFile}`);
	}
	return checks;
}

function readTail(path: string, size: number): string {
	const length = Math.min(size, LOG_TAIL_BYTES);
	const buffer = Buffer.alloc(length);
	const file = openSync(path, "r");
	try {
		readSync(file, buffer, 0, length, size - length);
	} finally {
		closeSync(file);
	}
	return buffer.toString("utf8");
}
