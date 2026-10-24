#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openMochi } from "./mochi.ts";
import { createClassify } from "./brain/classifier.ts";
import { createIMessageChannel } from "./channels/imessage.ts";
import type { Channel, Channels, ChatChannelId, Env, InboundSink } from "./channels/types.ts";
import { type Config, unknownKeys, type ChatUser, loadConfig } from "./config.ts";
import { type Home, resolveHome } from "./home.ts";
import { FileIndexes } from "./search/search.ts";
import { acquireLock } from "./lock.ts";
import { log, setLogFile } from "./log.ts";
import { broken, off, ready, type Setup, setupReport } from "./setup.ts";
import { type DaemonFacts, listenAttach, modelSummaries } from "./attach/server.ts";
import type { AttachClient } from "./attach/client.ts";
import { doctor, reach, stopDaemon } from "./attach/daemon.ts";
import { printModels, runAgents, runExport, runStatus, table } from "./attach/inspect.ts";
import { type Cli, helpText, parseCli } from "./cli.ts";
import type { ModelRef } from "@earendil-works/pi-durable";
import { runLines } from "./attach/lines.ts";
import { runTui } from "./attach/tui.ts";
import { Profiles } from "./profiles/profiles.ts";
import { schedulesComponent } from "./schedule/webhooks.ts";
import { a2aComponent, a2aServerSetup } from "./a2a/server.ts";
import { AUTH_COMMAND, authFile, loginApps, storedTokenConnector } from "./auth/apps.ts";
import { connectApps } from "./apps/apps.ts";
import { ingest } from "./turn/turn.ts";
import { runCompactor } from "./memory/compactor.ts";
import { notifyOwner } from "./schedule/schedule.ts";
import { fastCompletion } from "./turn/lifecycle.ts";

const ADAPTERS: Readonly<Record<ChatChannelId, (env: Env, users: readonly ChatUser[]) => Setup<Channel>>> = {
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
		case "auth-apps": {
			const config = await loadConfig(process.env);
			if (config.appsUrl === undefined) throw new Error("Set appsUrl in config.toml (or MOCHI_APPS_URL) first.");
			await mkdir(config.home.dir, { recursive: true });
			await loginApps(config.appsUrl, authFile(config.home.dir), (line) => process.stdout.write(`${line}\n`));
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
		case "models": {
			const found = await reach(socket, false);
			if (found.kind === "refused") throw new Error(found.reason);
			if (found.kind === "ready") {
				printModels(await found.client.request({ op: "models" }), cli.search, cli.json);
				found.client.close();
				return 0;
			}
			const config = await loadConfig(process.env);
			printModels(modelSummaries(config.modelSetup.models, modelRoles(config)), cli.search, cli.json);
			return 0;
		}
		case "agents":
		case "status":
		case "export":
			return inspect(socket, async (client) => {
				if (cli.kind === "agents") await runAgents(client, cli.json);
				else if (cli.kind === "status") await runStatus(client, cli.json);
				else await runExport(client, cli.to, cli.out);
			});
		case "tui":
		case "lines":
			return attach(cli, home, socket);
		default: {
			const _exhaustive: never = cli;
			throw new Error(`Unhandled command ${JSON.stringify(_exhaustive)}`);
		}
	}
}

/** Commands that only read: they need a running daemon and never become one. */
async function inspect(socket: string, run: (client: AttachClient) => Promise<void>): Promise<number> {
	const found = await reach(socket, false);
	if (found.kind === "refused") throw new Error(found.reason);
	if (found.kind === "absent") {
		process.stderr.write("mochi is not running.\n");
		return 1;
	}
	try {
		await run(found.client);
	} finally {
		found.client.close();
	}
	return 0;
}

// A terminal attaches to the running daemon. Without one, this process becomes the daemon for as long as the
// terminal runs: every channel for the TUI, only the terminal for chat and print. attach needs a running daemon.
async function attach(cli: Extract<Cli, { kind: "tui" | "lines" }>, home: Home, socket: string): Promise<number> {
	const watch = cli.kind === "tui" || cli.json;
	let found = await reach(socket, watch);
	if (found.kind === "refused") throw new Error(found.reason);
	let local: Daemon | undefined;
	if (found.kind === "absent") {
		if (cli.kind === "tui" && cli.to !== undefined) {
			process.stderr.write("mochi is not running.\n");
			return 1;
		}
		const config = await loadConfig(process.env);
		await mkdir(config.home.dir, { recursive: true });
		if (cli.kind === "tui") setLogFile(config.home.logFile);
		local = await startDaemon(config, cli.kind === "tui" ? "configured" : "terminal");
		found = await reach(socket, watch);
		if (found.kind !== "ready") throw new Error(found.reason);
	}
	const client = found.client;
	if (local !== undefined) stopOnSignal(local, () => client.close());
	try {
		if (cli.kind === "tui") await runTui(client, home.dir, cli.to);
		else await runLines(client, cli.prompt, cli);
	} finally {
		client.close();
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

/** Each config name for a model (brain, fast, strongest, classifier, aliases) and the model it picks. */
function modelRoles(config: Config): Record<string, ModelRef> {
	const { modelSetup } = config;
	const roles: Record<string, ModelRef> = { brain: modelSetup.brain, fast: modelSetup.fast, strongest: modelSetup.ref("strongest") };
	if (modelSetup.classifier !== undefined) roles.classifier = modelSetup.classifier;
	for (const alias of Object.keys(config.file.models?.aliases ?? {})) roles[alias] = modelSetup.ref(alias);
	return roles;
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

/** Open storage, the Harness, channels, components and the attach socket. `terminal` runs no outside channel. */
async function startDaemon(config: Config, channelSet: "configured" | "terminal"): Promise<{ stop(reason: string): Promise<void> }> {
	const releaseLock = acquireLock(join(config.home.dir, "mochi.lock"));
	const controller = new AbortController();
	const running = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
	const files = new FileIndexes();

	const { channels, report: channelReport } = channelSet === "terminal" ? { channels: new Map() as Channels, report: [] } : configuredChannels(config.env, config.users);
	const workDir = join(config.home.dir, "work");
	await mkdir(workDir, { recursive: true });
	const a2a = a2aServerSetup(config.env);
	const setup = [...setupReport([...services(config), ["a2a", a2a]]), ...channelReport];
	log("setup", { ok: setup.filter((line) => line.startsWith("ok")).map((line) => line.slice(5)), other: setup.filter((line) => !line.startsWith("ok")) });
	const { models } = config.modelSetup;
	const profiles = new Profiles(config.home.profilesDir, join(REPO, "agents"), config.modelSetup.ref);
	const apps = config.appsUrl === undefined ? undefined : connectApps(storedTokenConnector(config.appsUrl, authFile(config.home.dir)), log);

	const mochi = await openMochi(
		{
			storage: await openNodeSqliteStorage(join(config.home.dir, "mochi.sqlite")),
			models,
			brain: config.modelSetup.brain,
			fast: config.modelSetup.fast,
			classify: createClassify(models, config.modelSetup.classifier),
			web: config.web,
			...(config.file.media === undefined ? {} : { media: { config: config.file.media, env: config.env, ...(config.file.providers === undefined ? {} : { providers: config.file.providers }) } }),
			...(apps === undefined ? {} : { apps }),
			files,
			skillDirs: [join(REPO, "skills"), config.home.skillsDir],
			profiles,
			workDir,
			channels,
			users: config.users,
			a2aPeers: config.a2aPeers,
			timeZone: config.timeZone,
			publicUrl: config.env.MOCHI_PUBLIC_URL,
			scheduling: channelSet === "terminal" ? "local" : "daemon",
			log,
			...(await readInstructions(config.home)),
		},
		BACKGROUND_CONTEXT,
	);
	mochi.harness.resume();
	const facts: DaemonFacts = {
		startedAt: new Date(),
		build: buildOf(),
		home: config.home.dir,
		scheduling: channelSet === "terminal" ? "local" : "daemon",
		channels: [...channels.keys()],
		setup,
		roles: modelRoles(config),
	};
	await listenAttach(socketPath(config.home.dir), { line: mochi.line, models, log, profiles, users: config.users, facts }, running);

	const background = [
		runCompactor({ harness: mochi.harness, fast: fastCompletion(models, config.modelSetup.fast), log, notify: (text, context) => notifyOwner(mochi.harness, mochi.line, text, context), now: Date.now }, running),
		...(apps === undefined ? [] : [apps.run(running)]),
		// A terminal-only daemon (chat, print) serves one script; schedules wait for the real daemon.
		...(channelSet === "terminal" ? [] : [schedulesComponent(mochi, config, running), a2aComponent(mochi, config, a2a, running)]),
	];
	// Channels stop after the harness, so no Turn sends on a closed channel.
	const channelsRunning = new AbortController();
	const sink: InboundSink = async (message) => void (await ingest(mochi.line, message, running));
	const inbound = [...channels.values()].map((channel) =>
		channel.run(sink, channelsRunning.signal).catch((error: unknown) => {
			log("channel.failed", { channel: channel.profile.id, error: String(error) });
		}),
	);
	log("mochi.started", { channels: [...channels.keys()], pid: process.pid });

	let stopped: Promise<void> | undefined;
	const stop = async (reason: string): Promise<void> => {
		log("mochi.stopping", { reason });
		controller.abort();
		await Promise.allSettled(background);
		await mochi.harness.close(BACKGROUND_CONTEXT);
		channelsRunning.abort();
		await Promise.allSettled(inbound);
		files.close();
		rmSync(socketPath(config.home.dir), { force: true });
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

/** The outside services mochi calls. Models and the web need a key; without a classifier, classify steps fail. */
function services(config: Pick<Config, "modelSetup" | "web" | "home" | "appsUrl" | "file">): readonly (readonly [string, Setup<void>])[] {
	const missing = config.modelSetup.missing;
	const unknown = unknownKeys(config.file);
	return [
		["models", missing.length === 0 ? ready(undefined) : broken(`${missing.join("; ")}. Fix: put the key in ~/.mochi/.env`)],
		["classifier", config.modelSetup.classifier === undefined ? off : ready(undefined)],
		["config", unknown.length === 0 ? ready(undefined) : broken(`config.toml has keys mochi does not read: ${unknown.join(", ")}. They are ignored; remove them.`)],
		["web", config.web.key === undefined ? broken(`${config.web.keyEnv} is not set. Fix: put it in ~/.mochi/.env`) : ready(undefined)],
		["apps", config.appsUrl === undefined ? off : existsSync(authFile(config.home.dir)) ? ready(undefined) : broken(`not logged in. Fix: ${AUTH_COMMAND}`)],
	];
}

function configuredChannels(env: Env, users: readonly ChatUser[]): { readonly channels: Channels; readonly report: readonly string[] } {
	const setups = (Object.keys(ADAPTERS) as ChatChannelId[]).map((id) => [id, ADAPTERS[id](env, users)] as const);
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
		// Only a daemon logs a crash; a client command prints one line.
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
