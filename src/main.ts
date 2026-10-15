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
import { createWhatsAppChannel } from "./channels/whatsapp.ts";
import type { Channel, Channels, ChatChannelId, Env, InboundSink } from "./channels/types.ts";
import { type Config, unknownKeys, type ChatUser, loadConfig } from "./config.ts";
import { type Home, resolveHome } from "./home.ts";
import { SearchIndex } from "./index/fts.ts";
import { acquireLock } from "./lock.ts";
import { log, setLogFile } from "./log.ts";
import { broken, off, ready, type Setup, setupReport } from "./setup.ts";
import { type DaemonFacts, listenAttach } from "./attach/server.ts";
import type { ModelRef } from "@earendil-works/pi-durable";
import { AttachClient } from "./attach/client.ts";
import { runLines } from "./attach/lines.ts";
import { runTui } from "./attach/tui.ts";
import { Profiles } from "./profiles/profiles.ts";
import { triggersComponent } from "./triggers/webhooks.ts";
import { a2aComponent, a2aServerSetup } from "./a2a/server.ts";
import { AUTH_COMMAND, authFile, loginApps, storedTokenConnector } from "./auth/apps.ts";
import { connectApps } from "./apps/apps.ts";
import { ingest } from "./turn/turn.ts";
import { runFeed } from "./memory/feed.ts";
import { watchCompaction } from "./memory/compact.ts";
import { fastCompletion } from "./turn/lifecycle.ts";

/** Only iMessage serves users; the other adapters stay owner-only. */
const ADAPTERS: Readonly<Record<ChatChannelId, (env: Env, users: readonly ChatUser[]) => Setup<Channel>>> = {
	imessage: (env, users) => createIMessageChannel(env, users.map((user) => user.handle)),
	whatsapp: (env) => createWhatsAppChannel(env),
};

const REPO = resolve(import.meta.dirname, "..");

type Mode =
	| { readonly kind: "daemon" }
	| { readonly kind: "tui" }
	/** Chat (stdin lines) or print (one prompt); `json` streams view frames instead of replies. */
	| { readonly kind: "lines"; readonly prompt?: string; readonly json: boolean; readonly id?: string };

const USAGE = "Usage: mochi [--headless] | mochi chat [--json] [--id <key>] | mochi -p <prompt> [--json] [--id <key>] | " + AUTH_COMMAND;

function parseMode(all: readonly string[], interactive: boolean): Mode {
	const idAt = all.indexOf("--id");
	const id = idAt < 0 ? undefined : all[idAt + 1];
	if (idAt >= 0 && (id === undefined || !/^[A-Za-z0-9._-]+$/.test(id))) throw new Error(`--id needs a key of letters, digits, dot, dash or underscore. ${USAGE}`);
	const args = idAt < 0 ? all : [...all.slice(0, idAt), ...all.slice(idAt + 2)];
	const json = args.includes("--json");
	const rest = args.filter((arg) => arg !== "--json");
	if (rest.length === 0) return interactive && !json ? { kind: "tui" } : json ? { kind: "lines", json } : { kind: "daemon" };
	if (rest.length === 1 && rest[0] === "--headless") return { kind: "daemon" };
	const keyed = id === undefined ? {} : { id };
	if (rest.length === 1 && rest[0] === "chat") return { kind: "lines", json, ...keyed };
	if (rest.length === 2 && (rest[0] === "-p" || rest[0] === "--print")) return { kind: "lines", prompt: rest[1]!, json, ...keyed };
	throw new Error(`Unknown arguments: ${args.join(" ")}. ${USAGE}`);
}

async function main(args: readonly string[]): Promise<void> {
	if (args[0] === "service" && args[1] === "install") {
		const home = resolveHome(process.env);
		if (process.platform !== "linux") throw new Error("service install writes a systemd user unit, which needs Linux. Run node src/main.ts --headless under your own supervisor.");
		const unit = [
			"[Unit]",
			"Description=mochi",
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
		return;
	}
	if (args[0] === "auth") {
		if (args[1] !== "apps") throw new Error(`Unknown auth target ${args[1] ?? "(none)"}. Usage: ${AUTH_COMMAND}`);
		const config = await loadConfig(process.env);
		if (config.appsUrl === undefined) throw new Error("Set appsUrl in config.toml (or MOCHI_APPS_URL) first.");
		await mkdir(config.home.dir, { recursive: true });
		await loginApps(config.appsUrl, authFile(config.home.dir), (line) => process.stdout.write(`${line}\n`));
		return;
	}
	const mode = parseMode(args, process.stdin.isTTY === true && process.stdout.isTTY === true);
	const config = await loadConfig(process.env);
	await mkdir(config.home.dir, { recursive: true });
	const socket = socketPath(config.home.dir);

	if (mode.kind === "daemon") {
		const daemon = await startDaemon(config, "configured");
		const reason = await new Promise<string>((resolveStop) => {
			for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolveStop(signal));
		});
		await daemon.stop(reason);
		return;
	}

	// A terminal attaches to the running daemon. Without one, this process becomes the daemon for as long as the
	// terminal runs: every channel for the TUI, only the terminal for chat and print.
	let local: Awaited<ReturnType<typeof startDaemon>> | undefined;
	let client: AttachClient;
	try {
		client = await AttachClient.connect(socket, { watch: true });
	} catch {
		if (mode.kind === "tui") setLogFile(config.home.logFile);
		local = await startDaemon(config, mode.kind === "tui" ? "configured" : "terminal");
		client = await AttachClient.connect(socket, { watch: true });
	}
	try {
		if (mode.kind === "tui") await runTui(client, config.home.dir);
		else await runLines(client, mode.prompt, mode);
	} finally {
		client.close();
		await local?.stop("terminal closed");
	}
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
	const index = new SearchIndex(join(config.home.dir, "index.sqlite"));

	const { channels, report: channelReport } = channelSet === "terminal" ? { channels: new Map() as Channels, report: [] } : configuredChannels(config.env, config.users);
	const workDir = join(config.home.dir, "work");
	await mkdir(workDir, { recursive: true });
	const a2a = a2aServerSetup(config.env);
	const setup = [...setupReport([...services(config), ["a2a", a2a]]), ...channelReport];
	for (const line of setup) log("setup", { line });
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
			index,
			skillsDir: join(REPO, "skills"),
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
	const stopCompaction = watchCompaction(mochi.harness, models, config.modelSetup.compactAt, running, (error) => log("compaction.failed", { error: String(error) }));
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
		runFeed(mochi.harness, index, fastCompletion(models, config.modelSetup.fast), mochi.catalog, running, (error) => log("memory.failed", { error: String(error) })),
		...(apps === undefined ? [] : [apps.run(running)]),
		// A terminal-only daemon (chat, print) serves one script; triggers wait for the real daemon.
		...(channelSet === "terminal" ? [] : [triggersComponent(mochi, config, running), a2aComponent(mochi, config, a2a, running)]),
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

	return {
		async stop(reason) {
			log("mochi.stopping", { reason });
			stopCompaction();
			controller.abort();
			await Promise.allSettled(background);
			await mochi.harness.close(BACKGROUND_CONTEXT);
			channelsRunning.abort();
			await Promise.allSettled(inbound);
			index.close();
			rmSync(socketPath(config.home.dir), { force: true });
			releaseLock();
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

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		log("mochi.crashed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
		process.exit(1);
	});
}
