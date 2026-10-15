import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	Harness,
	type ModelRef,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { codingTools } from "./media/read-image.ts";
import type { Channels } from "./channels/types.ts";
import { workEnv } from "./env/work-env.ts";
import type { SearchIndex } from "./index/fts.ts";
import type { Log } from "./log.ts";
import { contextFns, contextSection } from "./context.ts";
import { defineForkTask, forkFns } from "./fork/fork.ts";
import { defineReply, ownerIn, ownerOf, sendToProfile } from "./profiles/profiles.ts";
import { type Apps, appsFns } from "./apps/apps.ts";
import { historyTool, importOldNotes, MemoryLog, memoryExtension, noteTool, recallTool, windowExtension, zoomTool } from "./memory/memory.ts";
import { skillsExtension } from "./skills/skills.ts";
import { defineTrigger, notifyTool, RUN_DEADLINE_MS, scanTriggers, type TriggerTask, triggerFns } from "./triggers/trigger.ts";
import { defaultSelection, rootSelection, seatExtensions } from "./seats.ts";
import { reactTool, defineTurn, ensureLine, type Line, openTurn } from "./turn/turn.ts";
import { webFns } from "./web/web.ts";
import { browserFns } from "./browser/browser.ts";
import { fastBrowserFns } from "./browser/fast.ts";
import type { MediaDeps } from "./media/client.ts";
import { mediaFns } from "./media/media.ts";
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
import { profileFns, type Profiles, rosterSection } from "./profiles/profiles.ts";
import type { WebConfig } from "./config.ts";

interface MochiOptions {
	readonly storage: Storage;
	readonly models: Models;
	readonly brain: ModelRef;
	readonly fast: ModelRef;
	readonly classify: Classify;
	/** The web service for the web and browser functions; without a key they fail with a clear error. */
	readonly web: WebConfig;
	/** Image, video and speech providers; absent, the media functions say they are not configured. */
	readonly media?: Omit<MediaDeps, "workDir">;
	/** The apps MCP server; absent, the apps functions say it is not connected. */
	readonly apps?: Apps;
	readonly index: SearchIndex;
	/** Bundled skills, `<skillsDir>/<name>/SKILL.md`, listed in the prompt and opened with `read`. */
	readonly skillsDir: string;
	readonly profiles: Profiles;
	/** Where bash, read, edit and write run when a conversation sets no cwd. */
	readonly workDir: string;
	readonly channels: Channels;
	readonly timeZone: string;
	readonly publicUrl: string | undefined;
	/** `daemon` installs the Turn task kind; `local` (a terminal with no daemon) leaves Turns waiting for one. */
	readonly scheduling: "daemon" | "local";
	readonly log: Log;
	/** Root's own instructions (`<home>/instructions.md`), rendered after every section; absent leaves root's as they are. */
	readonly instructions?: string;
	readonly users: readonly ChatUser[];
	readonly a2aPeers: A2APeers;
}

export interface Mochi {
	readonly harness: Harness;
	readonly classify: Classify;
	readonly line: Line;
	readonly trigger: TriggerTask;
	readonly catalog: Profiles;
}

export async function openMochi(options: MochiOptions, context: Context): Promise<Mochi> {
	const { index, log, users, a2aPeers } = options;
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
	const trigger = defineTrigger({ timeZone: options.timeZone, deadlineMs: RUN_DEADLINE_MS, log, harness: () => harness, catalog: options.profiles, classify: options.classify, workDir: options.workDir });
	const procDir = join(options.workDir, ".procs");
	const procWatch = defineProcWatch({ dir: procDir, workDir: options.workDir, harness: () => harness, line: lineOf, pollMs: PROC_POLL_MS, log });
	const reply = defineReply(() => harness, options.workDir);
	const forkTask = defineForkTask(options.workDir);
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
		...gifFns(options.workDir),
		...thinkFns({ models: options.models, fast: options.fast, classify: options.classify }),
		...appsFns(options.apps ?? NO_APPS),
		...contextFns(options.workDir),
		...forkFns({ task: forkTask, scratchDir: (name) => join(options.workDir, "forks", name), ref: options.profiles.model }),
		...triggerFns({ task: trigger, catalog: options.profiles, triggers: (context) => harness.commit(scanTriggers, context), abortTask: (id, context) => harness.abortTask(id, context), publicUrl: options.publicUrl, timeZone: options.timeZone, now: Date.now, users }),
		...procFns({ task: procWatch, dir: procDir, workDir: options.workDir, abortTask: (id, context) => harness.abortTask(id, context) }),
		...a2aFns(a2aPeers),
		...profileFns(options.profiles, () => harness, reply, options.workDir),
		...boardFns({ by: async (tx, conversation) => { const owner = await ownerIn(tx, conversation); return owner === "root" ? "root" : owner.profile; }, now: Date.now }),
	];
	for (const extension of [
		identityExtension([...options.channels.values()].map((channel) => channel.profile), users, [...a2aPeers.keys()]),
		memoryExtension(ownerOf),
		skillsExtension(options.skillsDir),
		windowExtension(),
		defineExtension({ name: "agents", tasks: [forkTask, reply] }),
		defineExtension({ name: "procs", tasks: [procWatch] }),
		// Daemon only, so a terminal without a daemon leaves triggers and Turns waiting for one.
		...(options.scheduling === "daemon" ? [defineExtension({ name: "triggers", tasks: [trigger] })] : []),
		...seatExtensions(modelTools, library, [rosterSection(options.profiles)], [contextSection()]),
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
			settings: { extensions: defaultSelection((name) => registry.snapshot().extension(name)), steeringMode: "all", followUpMode: "all" },
			env: ({ cwd }) => environment(cwd ?? options.workDir),
			onReport: (error) => log("harness.report", { error: String(error) }),
		},
		context,
	);

	const root = await harness.root(context, { agent: { model: options.brain, thinkingLevel: "medium", extensions: rootSelection((name) => registry.snapshot().extension(name)) } });
	await root.configure({ model: options.brain, ...(options.instructions === undefined ? {} : { instructions: options.instructions }) }, context);
	const turn = defineTurn({ root, harness, users, channels: options.channels, workDir: options.workDir, media, log });
	if (options.scheduling === "daemon") registry.install(defineExtension({ name: "delivery", tasks: [turn] }));
	const lineId = await ensureLine(harness, context);
	const commands = commandTask({
		harness,
		root,
		lineId: () => lineId,
		fast,
		now: Date.now,
		timeZone: options.timeZone,
		channels: [...options.channels.keys()],
		openReply: (tx, input) => openTurn(tx, lineOf(), input),
	});
	registry.install(defineExtension({ name: "commands", tasks: [commands] }));
	if (options.scheduling === "daemon") {
		const sweep = defineSweep({ harness: () => harness, forkTask, everyMs: SWEEP_EVERY_MS, log, toProfile: async (name, brief, key, context) => void (await sendToProfile(harness, options.profiles, options.workDir, name, `[from board] ${brief}`, key, context)) });
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
	return { harness, classify: options.classify, line, trigger, catalog: options.profiles };
}

const browserDeps = (web: WebConfig) => ({ apiKey: web.key, keyEnv: web.keyEnv, ...(web.url === undefined ? {} : { baseUrl: web.url }), ...(web.browserProfile === undefined ? {} : { profile: web.browserProfile }) });

const notConnected = async (): Promise<never> => {
	throw new Error("No apps server is connected in this process.");
};
const NO_APPS: Apps = { search: notConnected, call: notConnected, skills: notConnected };
