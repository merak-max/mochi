import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
	type CompactionPolicy,
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	type ModelRef,
	type Registry,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { codingTools } from "./media/read-image.ts";
import type { Channels } from "./channels/types.ts";
import { workEnv } from "./env/work-env.ts";
import type { SearchIndex } from "./index/fts.ts";
import type { Log } from "./log.ts";
import { forkFns, ForkTask } from "./fork/fork.ts";
import { ownerIn, ownerOf, sendToProfile } from "./profiles/profiles.ts";
import { type Apps, appsFns } from "./apps/apps.ts";
import { historyTool, importOldNotes, MemoryLog, memoryExtension, noteTool, recallTool, windowExtension, zoomTool } from "./memory/memory.ts";
import { skillsExtension } from "./skills/skills.ts";
import { defineTrigger, notifyTool, RUN_DEADLINE_MS, scanTriggers, type TriggerTask, triggerFns } from "./triggers/trigger.ts";
import { defaultSelection, seatExtensions, SCRIPT_DEADLINE_MS } from "./seats.ts";
import { reactTool, defineTurn, ensureLine, type Line, openTurn, RETRY, type Retry } from "./turn/turn.ts";
import { webFns } from "./web/web.ts";
import { browserFns } from "./browser/browser.ts";
import { fastBrowserFns } from "./browser/fast.ts";
import { type MediaDeps, mediaFns } from "./media/media.ts";
import { gifFns } from "./media/gif.ts";
import { defineProcWatch, PROC_POLL_MS, procFns } from "./procs/procs.ts";
import { commandTask, runCommand } from "./turn/commands.ts";
import { fastCompletion, handoffTool } from "./turn/lifecycle.ts";
import type { Classify } from "./brain/classifier.ts";
import type { ChatUser } from "./config.ts";
import { thinkFns } from "./brain/think.ts";
import { identityExtension } from "./brain/identity.ts";
import { type A2APeers, a2aFns } from "./a2a/tools.ts";
import { boardFns, defineSweep, ensureSweep, SWEEP_EVERY_MS } from "./board/board.ts";
import { profileFns, type Profiles } from "./profiles/profiles.ts";
import type { WebConfig } from "./config.ts";
import { type Home, homeAt } from "./home.ts";

export interface MochiOptions {
	readonly storage: Storage;
	readonly models: Models;
	readonly brain: ModelRef;
	readonly fast: ModelRef;
	readonly classify: Classify;
	/** The web service for the web and browser functions; without a key they fail with a clear error. */
	readonly web: WebConfig;
	/** Image, video and speech providers; absent, the media functions say they are not configured. */
	readonly media?: Omit<MediaDeps, "workDir">;
	/** Minutes of silence after which an owner message starts a fresh root; 0 never resets. */
	/** The apps MCP server; absent, the apps functions say it is not connected. */
	readonly apps?: Apps;
	/** Wall-clock limit of one `code` script. */
	readonly scriptDeadlineMs?: number;
	/** Wall-clock limit of one trigger run. */
	readonly triggerDeadlineMs?: number;
	/** How often a background process's watcher reads its files. */
	readonly procPollMs?: number;
	/** How often the board sweep looks for due tasks. */
	readonly sweepEveryMs?: number;
	readonly index: SearchIndex;
	/** Bundled skills, `<skillsDir>/<name>/SKILL.md`, listed in the prompt and opened with `read`. */
	readonly skillsDir: string;
	readonly profiles: Profiles;
	/** Where bash, read, edit and write run when a conversation sets no cwd. */
	readonly workDir: string;
	readonly channels: Channels;
	readonly timeZone: string;
	/** `MOCHI_PUBLIC_URL`, the origin webhook senders call. */
	readonly publicUrl: string | undefined;
	/** `daemon` installs the Turn task kind; `local` (a terminal with no daemon) leaves Turns waiting for one. */
	readonly scheduling: "daemon" | "local";
	readonly retry?: Retry;
	readonly now?: () => Date;
	readonly log: Log;
	/** Root's own instructions (`<home>/instructions.md`), rendered after every section; absent leaves root's as they are. */
	readonly instructions?: string;
	/** Users who may write on iMessage, with normalized handles. */
	readonly users?: readonly ChatUser[];
	/** The owner's other agents that root and runs may call over A2A. */
	readonly a2aPeers?: A2APeers;
	/** This mochi's home, whose profiles/ the profile tools manage. Absent in tests: a home in the work directory. */
	readonly home?: Home;
}

export interface Mochi {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly registry: Registry;
	readonly classify: Classify;
	readonly line: Line;
	readonly trigger: TriggerTask;
	readonly catalog: Profiles;
}

/** The one context policy: pi-durable's built-in compaction, at its own defaults, written down. */
const COMPACTION: CompactionPolicy = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 32_768 };

export async function openMochi(options: MochiOptions, context: Context): Promise<Mochi> {
	const { index, log } = options;
	const users = options.users ?? [];
	const a2aPeers = options.a2aPeers ?? new Map();
	const registry = createRegistry();
	const fast = fastCompletion(options.models, options.fast);
	const media: Omit<MediaDeps, "workDir"> = options.media ?? { config: { images: { default: "", providers: [] } }, env: {} };
	let line: Line | undefined;
	const lineOf = (): Line => {
		if (line === undefined) throw new Error("The line is bound before resume.");
		return line;
	};
	const modelTools: ToolRegistration[] = [
		notifyTool({ line: lineOf, channels: [...options.channels.keys()], classify: options.classify, log, users }),
		handoffTool(),
	];
	const now = options.now ?? (() => new Date());
	const trigger = defineTrigger({ timeZone: options.timeZone, deadlineMs: options.triggerDeadlineMs ?? RUN_DEADLINE_MS, log, harness: () => harness, catalog: options.profiles, classify: options.classify });
	const procDir = join(options.workDir, ".procs");
	const procWatch = defineProcWatch({ dir: procDir, line: lineOf, pollMs: options.procPollMs ?? PROC_POLL_MS, log });
	const library: ToolRegistration[] = [
		...(await codingTools()),
		noteTool(index, ownerIn),
		zoomTool(ownerIn),
		recallTool(index),
		historyTool(index),
		reactTool(options.channels),
		...webFns({ apiKey: options.web.key, keyEnv: options.web.keyEnv, ...(options.web.url === undefined ? {} : { baseUrl: options.web.url }), models: options.models, fast: options.fast }),
		...browserFns(browserDeps(options.web)),
		...fastBrowserFns({ ...browserDeps(options.web), models: options.models, fast: options.fast, classify: options.classify }),
		...mediaFns({ ...media, workDir: options.workDir }),
		...gifFns({ workDir: options.workDir }),
		...thinkFns({ models: options.models, fast: options.fast, classify: options.classify }),
		...appsFns(options.apps ?? NO_APPS),
		...forkFns((name) => join(options.workDir, "forks", name)),
		...triggerFns({ task: trigger, catalog: options.profiles, triggers: (context) => harness.commit(scanTriggers, context), abortTask: (id, context) => harness.abortTask(id, context), publicUrl: options.publicUrl, timeZone: options.timeZone, now: () => now().getTime(), users }),
		...procFns({ task: procWatch, dir: procDir, workDir: options.workDir, abortTask: (id, context) => harness.abortTask(id, context) }),
		...a2aFns(a2aPeers),
		...profileFns(options.profiles, () => harness),
		...boardFns({ by: async (tx, conversation) => { const owner = await ownerIn(tx, conversation); return owner === "root" ? "root" : owner.profile; }, now: () => now().getTime() }),
	];
	for (const extension of [
		identityExtension([...options.channels.values()].map((channel) => channel.profile), users, [...a2aPeers.keys()]),
		memoryExtension(ownerOf),
		skillsExtension(options.skillsDir),
		windowExtension(),
		defineExtension({ name: "agents", tasks: [ForkTask] }),
		defineExtension({ name: "procs", tasks: [procWatch] }),
		// Daemon only, so a terminal without a daemon leaves triggers and Turns waiting for one.
		...(options.scheduling === "daemon" ? [defineExtension({ name: "triggers", tasks: [trigger] })] : []),
		...seatExtensions(modelTools, library, options.scriptDeadlineMs ?? SCRIPT_DEADLINE_MS),
	]) {
		registry.install(extension);
	}

	// One environment per directory, shared by every conversation working there.
	const environments = new Map<string, ExecutionEnv>();
	const environment = (cwd: string): ExecutionEnv => {
		const env = environments.get(cwd) ?? workEnv(options.workDir, cwd);
		environments.set(cwd, env);
		return env;
	};
	const harness = await Harness.open(
		options.storage,
		{
			models: options.models,
			registry,
			settings: { extensions: defaultSelection((name) => registry.snapshot().extension(name)), compaction: COMPACTION, steeringMode: "all", followUpMode: "all" },
			env: ({ cwd }) => environment(cwd ?? options.workDir),
			onReport: (error) => log("harness.report", { error: String(error) }),
			now: () => now().getTime(),
		},
		context,
	);

	const root = await harness.root(context, { agent: { model: options.brain, thinkingLevel: "medium" } });
	await root.configure({ model: options.brain, ...(options.instructions === undefined ? {} : { instructions: options.instructions }) }, context);
	const turn = defineTurn({ root, harness, users, channels: options.channels, workDir: options.workDir, media, retry: options.retry ?? RETRY, log });
	if (options.scheduling === "daemon") registry.install(defineExtension({ name: "delivery", tasks: [turn] }));
	const lineId = await ensureLine(harness, context);
	const commands = commandTask({
		harness,
		root,
		lineId: () => lineId,
		fast,
		now: () => now().getTime(),
		timeZone: options.timeZone,
		channels: [...options.channels.keys()],
		openReply: (tx, input) => openTurn(tx, lineOf(), input),
	});
	registry.install(defineExtension({ name: "commands", tasks: [commands] }));
	if (options.scheduling === "daemon") {
		const sweep = defineSweep({ harness: () => harness, everyMs: options.sweepEveryMs ?? SWEEP_EVERY_MS, log, toProfile: async (name, brief, key, context) => void (await sendToProfile(harness, options.profiles, name, brief, key, context)) });
		registry.install(defineExtension({ name: "board", tasks: [sweep] }));
		await ensureSweep(harness, sweep, context);
	}
	line = {
		harness,
		root,
		id: lineId,
		turn,
		channels: options.channels,
		timeZone: options.timeZone,
		workDir: options.workDir,
		media,
		users,
		command: (input, context) => runCommand({ harness, lineId: () => lineId, task: commands }, input, context),
	};
	await harness.commit(importOldNotes, context);
	index.replaceMemory((await harness.snapshot(MemoryLog, context))?.lines ?? []);
	return { harness, root, registry, classify: options.classify, line, trigger, catalog: options.profiles };
}

const browserDeps = (web: WebConfig) => ({ apiKey: web.key, keyEnv: web.keyEnv, ...(web.url === undefined ? {} : { baseUrl: web.url }), ...(web.browserProfile === undefined ? {} : { profile: web.browserProfile }) });

const notConnected = async (): Promise<never> => {
	throw new Error("No apps server is connected in this process.");
};
const NO_APPS: Apps = { search: notConnected, call: notConnected, skills: notConnected };
