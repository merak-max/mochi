#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openMochi } from "./mochi.ts";
import { createClassify } from "./brain/classifier.ts";
import { createIMessageChannel } from "./channels/imessage.ts";
import type { Channel, ChannelId, Env, InboundSink } from "./channels/types.ts";
import { createCliChannel, type DaemonFacts, WIRE, watchLive } from "./channels/cli.ts";
import { type Config, unknownKeys, type ChatUser, loadConfig, type McpServerConfig } from "./config.ts";
import { type Home, resolveHome } from "./home.ts";
import { FileIndexes } from "./search/search.ts";
import { acquireLock } from "./lock.ts";
import { log, setLogFile } from "./log.ts";
import { broken, off, ready, type Setup, setupReport } from "./setup.ts";
import { doctor, printStatus, reach, stopDaemon, table } from "./attach/daemon.ts";
import { type Cli, helpText, parseCli } from "./cli.ts";
import { runLines } from "./attach/lines.ts";
import { runTui } from "./attach/tui.ts";
import { Definitions } from "./agents/definitions.ts";
import { webhooksComponent } from "./board/webhooks.ts";
import { login, tokenFile } from "./mcp/oauth.ts";
import { ingest, notifyOwner } from "./turn/turn.ts";
import { runCompactor } from "./memory/compactor.ts";
import { fastCompletion } from "./turn/lifecycle.ts";

/** The channels config turns on. The terminal channel always runs. */
const ADAPTERS: Readonly<Record<Exclude<ChannelId, "cli">, (env: Env, users: readonly ChatUser[]) => Setup<Channel>>> = {
	imessage: (env, users) => createIMessageChannel(env, users.map((user) => user.handle)),
};

const REPO = resolve(import.meta.dirname, "..");

async function main(cli: Cli): Promise<number> {
	const home = resolveHome(process.env);
	const socket = socketPath(home.dir);
	switch (cli.kind) {
		case "help":
			process.stdout.write(`${helpText(cli.command)}\n`);
			return 0;
		case "version":
			process.stdout.write(`mochi ${buildOf()}\n`);
			return 0;
		case "service-install":
			await installService(home);
			return 0;
		case "auth": {
			const config = await loadConfig(process.env);
			const server = config.mcp.find((each) => each.name === cli.server);
			if (server === undefined) throw new Error(`config.toml has no [mcp.${cli.server}].`);
			if (server.auth.kind !== "oauth") throw new Error(`[mcp.${cli.server}] has auth = "${server.auth.kind}"; only an oauth server logs in.`);
			await login(server.name, server.url, tokenFile(config.home.dir, server.name), (line) => process.stdout.write(`${line}\n`));
			return 0;
		}
		case "daemon": {
			const config = await loadConfig(process.env);
			await mkdir(config.home.dir, { recursive: true });
			const daemon = await startDaemon(config, "configured");
			stopOnSignal(daemon, () => {});
			return new Promise<number>(() => {});
		}
		case "stop":
			return stopDaemon(home, socket);
		case "doctor": {
			const checks = await doctor(home, socket);
			if (cli.json) process.stdout.write(`${JSON.stringify(checks)}\n`);
			else process.stdout.write(`${table(checks.map((check) => [check.level, check.name, check.detail]))}\n`);
			return checks.some((check) => check.level === "fail") ? 1 : 0;
		}
		case "status": {
			const found = await reach(socket, false);
			if (found.kind === "refused") throw new Error(found.reason);
			if (found.kind === "absent") {
				process.stderr.write("mochi is not running.\n");
				return 1;
			}
			printStatus(found.terminal.facts, cli.json);
			found.terminal.close();
			return 0;
		}
		case "tui":
		case "lines":
			return attach(cli, home, socket);
		default: {
			const _exhaustive: never = cli;
			throw new Error(`Unhandled command ${JSON.stringify(_exhaustive)}`);
		}
	}
}

// A terminal attaches to the running daemon. Without one, this process becomes the daemon for as long as the
// terminal runs: every channel for the TUI, only the terminal for chat and print.
async function attach(cli: Extract<Cli, { kind: "tui" | "lines" }>, home: Home, socket: string): Promise<number> {
	const watch = cli.kind === "tui";
	let found = await reach(socket, watch);
	if (found.kind === "refused") throw new Error(found.reason);
	let local: Daemon | undefined;
	if (found.kind === "absent") {
		const config = await loadConfig(process.env);
		await mkdir(config.home.dir, { recursive: true });
		if (cli.kind === "tui") setLogFile(config.home.logFile);
		local = await startDaemon(config, cli.kind === "tui" ? "configured" : "terminal");
		found = await reach(socket, watch);
		if (found.kind !== "ready") throw new Error(found.reason);
	}
	const terminal = found.terminal;
	if (local !== undefined) stopOnSignal(local, () => terminal.close());
	try {
		if (cli.kind === "tui") await runTui(terminal, home.dir);
		else await runLines(terminal, cli.prompt);
	} finally {
		terminal.close();
		await local?.stop("terminal closed");
	}
	return 0;
}

type Daemon = Awaited<ReturnType<typeof startDaemon>>;

/** Each process that owns a daemon, a terminal included, ends its terminal, stops the daemon and exits on SIGINT or SIGTERM. */
function stopOnSignal(daemon: Daemon, endTerminal: () => void): void {
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			endTerminal();
			void daemon.stop(signal).then(() => process.exit(0));
		});
	}
}

async function installService(home: Home): Promise<void> {
	if (process.platform !== "linux") throw new Error("service install writes a systemd user unit, which needs Linux. Run node src/main.ts --headless under your own supervisor.");
	const unit = [
		"[Unit]",
		"Description=mochi",
		"Wants=network-online.target",
		"After=network-online.target",
		"StartLimitIntervalSec=0",
		"",
		"[Service]",
		"Type=simple",
		`WorkingDirectory=${REPO}`,
		`Environment=MOCHI_HOME=${home.dir}`,
		`Environment=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
		`ExecStart=${process.execPath} src/main.ts --headless`,
		"Restart=always",
		"RestartSec=5",
		"KillSignal=SIGTERM",
		"TimeoutStopSec=60",
		`StandardOutput=append:${home.logFile}`,
		`StandardError=append:${home.logFile}`,
		"UMask=0077",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
	const dir = join(homedir(), ".config", "systemd", "user");
	await mkdir(dir, { recursive: true });
	await mkdir(home.dir, { recursive: true });
	await writeFile(join(dir, "mochi.service"), unit);
	process.stdout.write(`Wrote ${join(dir, "mochi.service")}. Start it: systemctl --user daemon-reload && systemctl --user enable --now mochi\n`);
}

/** The git short hash of this checkout, with "+dirty" for uncommitted changes. */
function buildOf(): string {
	try {
		const hash = execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
		return dirty ? `${hash}+dirty` : hash;
	} catch {
		return "unknown";
	}
}

/** Open storage, the Harness, the channels and the components. `terminal` runs no outside channel and no board tasks. */
async function startDaemon(config: Config, channelSet: "configured" | "terminal"): Promise<{ stop(reason: string): Promise<void> }> {
	const releaseLock = acquireLock(join(config.home.dir, "mochi.lock"));
	const controller = new AbortController();
	const running = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
	const files = new FileIndexes();

	const configured = channelSet === "terminal" ? { channels: new Map<ChannelId, Channel>(), report: [] } : configuredChannels(config.env, config.users);
	const setup = [...setupReport(services(config)), ...configured.report];
	const facts: DaemonFacts = {
		wire: WIRE,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		build: buildOf(),
		home: config.home.dir,
		channels: ["cli", ...configured.channels.keys()],
		setup,
	};
	const cli = createCliChannel(socketPath(config.home.dir), facts);
	const channels = new Map<ChannelId, Channel>([["cli", cli], ...configured.channels]);
	const workDir = join(config.home.dir, "work");
	await mkdir(workDir, { recursive: true });
	log("setup", { ok: setup.filter((line) => line.startsWith("ok")).map((line) => line.slice(5)), other: setup.filter((line) => !line.startsWith("ok")) });
	const { models } = config.modelSetup;
	const definitions = new Definitions(config.home.agentsDir, join(REPO, "agents"), config.modelSetup.ref);

	const mochi = await openMochi(
		{
			storage: await openNodeSqliteStorage(join(config.home.dir, "mochi.sqlite")),
			models,
			fast: config.modelSetup.fast,
			classify: createClassify(models, config.modelSetup.classifier),
			web: config.web,
			...(config.file.media === undefined ? {} : { media: { config: config.file.media, env: config.env, ...(config.file.providers === undefined ? {} : { providers: config.file.providers }) } }),
			mcp: config.mcp,
			homeDir: config.home.dir,
			files,
			skillDirs: [join(REPO, "skills"), config.home.skillsDir],
			toolsDir: config.home.toolsDir,
			memoryDir: config.home.memoryDir,
			definitions,
			workDir,
			channels,
			users: config.users,
			timeZone: config.timeZone,
			webhookUrl: config.file.webhooks?.url,
			scheduling: channelSet === "terminal" ? "local" : "daemon",
			log,
			...(await readInstructions(config.home)),
		},
		BACKGROUND_CONTEXT,
	);
	const mcpRunning = mochi.mcp.map((connection) => connection.run(running));
	// The first turn sees every server that answers at boot.
	await Promise.all(mochi.mcp.map((connection) => connection.firstAttempt));
	mochi.harness.resume();
	const stopWatching = watchLive(mochi.harness, mochi.line.root.id, (status) => cli.status(status));

	const background = [
		runCompactor({ harness: mochi.harness, complete: fastCompletion(models, config.modelSetup.memory), log, notify: (text, context) => notifyOwner(mochi.harness, mochi.line, text, context), now: Date.now }, running),
		...mcpRunning,
		// A terminal-only daemon (chat, print) serves one script; webhooks wait for the real daemon.
		...(channelSet === "terminal" || config.file.webhooks === undefined ? [] : [webhooksComponent(mochi, config.file.webhooks, running)]),
	];
	// Channels stop after the harness, so no Turn sends on a closed channel.
	const channelsRunning = new AbortController();
	const sink: InboundSink = async (message) => {
		const turn = await ingest(mochi.line, message, running);
		return { answered: turn === undefined ? Promise.resolve() : mochi.harness.waitForTask(turn, BACKGROUND_CONTEXT).then(() => {}) };
	};
	const inbound = [...configured.channels.values()].map((channel) =>
		channel.run(sink, channelsRunning.signal).catch((error: unknown) => {
			log("channel.failed", { channel: channel.profile.id, error: String(error) });
		}),
	);
	// The socket listens before startDaemon returns, so a terminal that started this daemon can connect at once.
	await cli.run(sink, channelsRunning.signal);
	log("mochi.started", { channels: [...channels.keys()], pid: process.pid });

	let stopped: Promise<void> | undefined;
	const stop = async (reason: string): Promise<void> => {
		log("mochi.stopping", { reason });
		controller.abort();
		stopWatching();
		await Promise.allSettled(background);
		await mochi.harness.close(BACKGROUND_CONTEXT);
		channelsRunning.abort();
		await Promise.allSettled(inbound);
		files.close();
		releaseLock();
	};
	// The signal handler and the terminal's own exit can both ask; the daemon stops once.
	return {
		stop(reason) {
			stopped ??= stop(reason);
			return stopped;
		},
	};
}

async function readInstructions(home: Home): Promise<{ instructions?: string }> {
	const text = await readFile(home.instructionsFile, "utf8").catch(() => undefined);
	return text === undefined || text.trim() === "" ? {} : { instructions: text.trim() };
}

/** `<home>/mochi.sock`, or a short path in the temp directory when that exceeds the Unix socket limit. */
function socketPath(homeDir: string): string {
	const path = join(homeDir, "mochi.sock");
	if (Buffer.byteLength(path) <= 100) return path;
	return join(tmpdir(), `mochi-${createHash("sha256").update(homeDir).digest("hex").slice(0, 16)}.sock`);
}

/** The outside services mochi calls. Models and the web need a key; without a classifier, classify and gates fail. */
function services(config: Pick<Config, "modelSetup" | "web" | "home" | "mcp" | "file">): readonly (readonly [string, Setup<void>])[] {
	const missing = config.modelSetup.missing;
	const unknown = unknownKeys(config.file);
	return [
		["models", missing.length === 0 ? ready(undefined) : broken(`${missing.join("; ")}. Fix: put the key in ~/.mochi/.env`)],
		["classifier", config.modelSetup.classifier === undefined ? off : ready(undefined)],
		["config", unknown.length === 0 ? ready(undefined) : broken(`config.toml has keys mochi does not read: ${unknown.join(", ")}. They are ignored; remove them.`)],
		["web", config.web === undefined ? off : config.web.key === undefined ? broken(`${config.web.keyEnv} is not set. Fix: put it in ~/.mochi/.env`) : ready(undefined)],
		...config.mcp.map((server) => [`mcp ${server.name}`, mcpSetup(server, config.home.dir)] as const),
	];
}

function mcpSetup(server: McpServerConfig, homeDir: string): Setup<void> {
	if (server.auth.kind === "bearer") return server.auth.token === undefined ? broken(`${server.auth.tokenEnv} is not set. Fix: put it in ~/.mochi/.env`) : ready(undefined);
	return existsSync(tokenFile(homeDir, server.name)) ? ready(undefined) : broken(`no token file. Fix: mochi auth ${server.name}`);
}

function configuredChannels(env: Env, users: readonly ChatUser[]): { readonly channels: ReadonlyMap<ChannelId, Channel>; readonly report: readonly string[] } {
	const setups = (Object.keys(ADAPTERS) as (keyof typeof ADAPTERS)[]).map((id) => [id, ADAPTERS[id](env, users)] as const);
	const channels = new Map(setups.flatMap(([id, setup]) => (setup.kind === "ready" ? [[id, setup.value] as const] : [])));
	return { channels, report: setupReport(setups) };
}

async function run(args: readonly string[]): Promise<void> {
	let cli: Cli;
	try {
		cli = parseCli(args, process.stdin.isTTY === true && process.stdout.isTTY === true);
	} catch (error) {
		process.stderr.write(`mochi: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
		return;
	}
	try {
		process.exitCode = await main(cli);
	} catch (error) {
		if (cli.kind === "daemon") log("mochi.crashed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
		else process.stderr.write(`mochi: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}

if (import.meta.main) {
	// A reader such as head can close stdout early. That ends the output, not the command.
	process.stdout.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
		throw error;
	});
	await run(process.argv.slice(2));
}
