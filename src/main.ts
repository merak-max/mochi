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
import { type Config, type ChatUser, loadConfig } from "./config.ts";
import { adoptInstructions, type Home, resolveHome } from "./home.ts";
import { SearchIndex } from "./index/fts.ts";
import { acquireLock } from "./lock.ts";
import { log, setLogFile } from "./log.ts";
import { broken, off, ready, type Setup, setupReport } from "./setup.ts";
import { listenAttach } from "./attach/server.ts";
import { AttachClient } from "./attach/client.ts";
import { runLines } from "./attach/lines.ts";
import { runTui } from "./attach/tui.ts";
import { AgentCatalog } from "./agents/catalog.ts";
import { triggersComponent } from "./triggers/webhooks.ts";
import { a2aComponent, a2aServerSetup } from "./a2a/server.ts";
import { AUTH_COMMAND, authFile, loginExecutor, storedTokenConnector } from "./auth/executor.ts";
import { connectApps } from "./apps/apps.ts";
import { InboundCursorDoc, ingest } from "./turn/turn.ts";
import { runFeed } from "./memory/feed.ts";

/** Only iMessage serves users; the other adapters stay owner-only. */
const ADAPTERS: Readonly<Record<ChatChannelId, (env: Env, users: readonly ChatUser[]) => Setup<Channel>>> = {
	imessage: (env, users) => createIMessageChannel(env, { users: users.map((user) => user.handle) }),
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
		if (args[1] !== "executor") throw new Error(`Unknown auth target ${args[1] ?? "(none)"}. Usage: ${AUTH_COMMAND}`);
		const config = await loadConfig(process.env);
		if (config.executorUrl === undefined) throw new Error("Set executorUrl in config.toml (or EXECUTOR_URL) first.");
		await mkdir(config.dataDir, { recursive: true });
		await loginExecutor(config.executorUrl, authFile(config.dataDir), (line) => process.stdout.write(`${line}\n`));
		return;
	}
	const mode = parseMode(args, process.stdin.isTTY === true && process.stdout.isTTY === true);
	const config = await loadConfig(process.env);
	await mkdir(config.dataDir, { recursive: true });
	const socket = socketPath(config.dataDir);

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
		client = await AttachClient.connect(socket);
	} catch {
		if (mode.kind === "tui") setLogFile(join(config.dataDir, "mochi.log"));
		local = await startDaemon(config, mode.kind === "tui" ? "configured" : "terminal");
		client = await AttachClient.connect(socket);
	}
	try {
		if (mode.kind === "tui") await runTui(client, config.dataDir);
		else await runLines(client, mode.prompt, mode);
	} finally {
		client.close();
		await local?.stop("terminal closed");
	}
}

/** Open storage, the Harness, channels, components and the attach socket. `terminal` runs no outside channel. */
async function startDaemon(config: Config, channelSet: "configured" | "terminal"): Promise<{ stop(reason: string): Promise<void> }> {
	const releaseLock = acquireLock(join(config.dataDir, "mochi.lock"));
	const controller = new AbortController();
	const running = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
	const index = new SearchIndex(join(config.dataDir, "index.sqlite"));

	const { channels, report: channelReport } = channelSet === "terminal" ? { channels: new Map() as Channels, report: [] } : configuredChannels(config.env, config.users);
	const workDir = join(config.dataDir, "work");
	await mkdir(workDir, { recursive: true });
	const a2a = a2aServerSetup(config.env);
	for (const line of [...setupReport([...services(config), ["a2a", a2a]]), ...channelReport]) log("setup", { line });
	const { models } = config.modelSetup;
	const apps = config.executorUrl === undefined ? undefined : connectApps(storedTokenConnector(config.executorUrl, authFile(config.dataDir)), log);

	const mochi = await openMochi(
		{
			storage: await openNodeSqliteStorage(join(config.dataDir, "mochi.sqlite")),
			models,
			brain: config.modelSetup.brain,
			fast: config.modelSetup.fast,
			classify: createClassify(models),
			firecrawlKey: config.firecrawlKey,
			...(config.env.FIRECRAWL_PROFILE?.trim() ? { firecrawlProfile: config.env.FIRECRAWL_PROFILE.trim() } : {}),
			...(config.file.media === undefined ? {} : { media: { config: config.file.media, env: config.env, ...(config.file.providers === undefined ? {} : { providers: config.file.providers }) } }),
			...(config.file.idleResetMinutes === undefined ? {} : { idleResetMinutes: config.file.idleResetMinutes }),
			...(apps === undefined ? {} : { apps }),
			memory: { repo: resolve(config.file.memory?.repo ?? join(config.dataDir, "memory")), ...(config.file.memory?.reflect === undefined ? {} : { reflect: config.file.memory.reflect }) },
			index,
			skillsDir: join(REPO, "skills"),
			agents: await AgentCatalog.load(join(REPO, "agents"), config.home.agentsDir, config.modelSetup.ref),
			workDir,
			channels,
			users: config.users,
			a2aPeers: config.a2aPeers,
			home: config.home,
			timeZone: config.timeZone,
			publicUrl: config.env.MOCHI_PUBLIC_URL,
			scheduling: channelSet === "terminal" ? "local" : "daemon",
			today: () => new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
			log,
			...(await readInstructions(config.home)),
		},
		BACKGROUND_CONTEXT,
	);
	mochi.harness.resume();
	await listenAttach(socketPath(config.dataDir), { line: mochi.line, models, log }, running);

	const background = [
		runFeed(mochi.harness, index, running, (error) => log("index.failed", { error: String(error) })),
		...(apps === undefined ? [] : [apps.run(running)]),
		// A terminal-only daemon (chat, print) serves one script; triggers wait for the real daemon.
		...(channelSet === "terminal" ? [] : [triggersComponent(mochi, config, running), a2aComponent(mochi, config, a2a, running)]),
	];
	// Channels stop after the harness, so no Turn sends on a closed channel.
	const channelsRunning = new AbortController();
	const sink: InboundSink = async (message) => void (await ingest(mochi.line, message, running));
	const inbound = [...channels.values()].map((channel) =>
		channel.run(sink, channelsRunning.signal, async () => (await mochi.harness.snapshot(InboundCursorDoc, channel.profile.id, running))?.sequence ?? null).catch((error: unknown) => {
			log("channel.failed", { channel: channel.profile.id, error: String(error) });
		}),
	);
	log("mochi.started", { channels: [...channels.keys()], pid: process.pid });

	return {
		async stop(reason) {
			log("mochi.stopping", { reason });
			controller.abort();
			await Promise.allSettled(background);
			await mochi.harness.close(BACKGROUND_CONTEXT);
			channelsRunning.abort();
			await Promise.allSettled(inbound);
			index.close();
			rmSync(socketPath(config.dataDir), { force: true });
			releaseLock();
		},
	};
}

/** `<home>/instructions.md`, root's own instructions; no file leaves root's as they are. */
async function readInstructions(home: Home): Promise<{ instructions?: string }> {
	adoptInstructions(home);
	const text = await readFile(home.instructionsFile, "utf8").catch(() => undefined);
	return text === undefined || text.trim() === "" ? {} : { instructions: text.trim() };
}

/** `<dataDir>/mochi.sock`, or a short path in the temp directory when that exceeds the Unix socket limit. */
function socketPath(dataDir: string): string {
	const path = join(dataDir, "mochi.sock");
	if (Buffer.byteLength(path) <= 100) return path;
	return join(tmpdir(), `mochi-${createHash("sha256").update(dataDir).digest("hex").slice(0, 16)}.sock`);
}

/** The outside services mochi calls. Models and the web need a key; without OpenRouter the trigger gates pass. */
export function services(config: Pick<Config, "modelSetup" | "openRouterKey" | "firecrawlKey" | "dataDir" | "executorUrl">): readonly (readonly [string, Setup<void>])[] {
	const missing = config.modelSetup.missing;
	return [
		["models", missing.length === 0 ? ready(undefined) : broken(`${missing.join("; ")}. Fix: put the key in ~/.mochi/.env`)],
		["classifier", config.openRouterKey === undefined ? off : ready(undefined)],
		["firecrawl", config.firecrawlKey === undefined ? broken("FIRECRAWL_API_KEY is not set. Fix: put it in ~/.mochi/.env") : ready(undefined)],
		["executor", config.executorUrl === undefined ? off : existsSync(authFile(config.dataDir)) ? ready(undefined) : broken(`not logged in. Fix: ${AUTH_COMMAND}`)],
	];
}

/** Every ready adapter, and one readiness line per adapter. */
export function configuredChannels(env: Env, users: readonly ChatUser[] = []): { readonly channels: Channels; readonly report: readonly string[] } {
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
