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
import { type FileIndexes, searchFns } from "./search/search.ts";
import type { Log } from "./log.ts";
import { contextFns, contextSection } from "./context.ts";
import { defineForkTask, forkFns } from "./fork/fork.ts";
import { addContextReaders, defineReply, ownerIn, ownerOf } from "./profiles/profiles.ts";
import { type Apps, appsFns } from "./apps/apps.ts";
import { memoryExtension, selectView, zoomTool } from "./memory/memory.ts";
import { skillsExtension } from "./skills/skills.ts";
import { defineSchedule, notifyTool, RUN_DEADLINE_MS, scanSchedules, type ScheduleTask, scheduleFns } from "./schedule/schedule.ts";
import { migrateSchedulers } from "./schedule/migrate.ts";
import { defaultSelection, rootSelection, seatExtensions } from "./seats.ts";
import { reactTool, sendTool, defineTurn, ensureLine, type Line, openTurn } from "./turn/turn.ts";
import { webFns } from "./web/web.ts";
import { browserFns } from "./browser/browser.ts";
import { fastBrowserFns } from "./browser/fast.ts";
import type { MediaDeps } from "./media/client.ts";
import { mediaFns } from "./media/media.ts";
import { gifFns } from "./media/gif.ts";
import { messageTool } from "./channels/message-tool.ts";
import { PROC_POLL_MS, procFns } from "./procs/procs.ts";
import { commandTask, runCommand } from "./turn/commands.ts";
import { fastCompletion, handoffTool } from "./turn/lifecycle.ts";
import type { Classify } from "./brain/classifier.ts";
import type { ChatUser } from "./config.ts";
import { thinkFns } from "./brain/think.ts";
import { identityExtension } from "./brain/identity.ts";
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
	/** fff file indexes for find and grep, one per root. */
	readonly files: FileIndexes;
	/** Skill directories, `<dir>/<name>/SKILL.md`: bundled first, then the owner's, which replace bundled ones by name. */
	readonly skillDirs: readonly string[];
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
}

export interface Mochi {
	readonly harness: Harness;
	readonly classify: Classify;
	readonly line: Line;
	readonly schedule: ScheduleTask;
	readonly catalog: Profiles;
}

export async function openMochi(options: MochiOptions, context: Context): Promise<Mochi> {
	const { log, users } = options;
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
	const procDir = join(options.workDir, ".procs");
	const schedule = defineSchedule({ timeZone: options.timeZone, deadlineMs: RUN_DEADLINE_MS, pollMs: PROC_POLL_MS, procDir, log, harness: () => harness, line: lineOf, catalog: options.profiles, classify: options.classify, workDir: options.workDir });
	const reply = defineReply(() => harness, options.workDir);
	const forkTask = defineForkTask(options.workDir);
	const library: ToolRegistration[] = [
		...(await codingTools()),
		...searchFns(options.files),
		zoomTool(() => harness),
		reactTool(options.channels),
		sendTool(options.channels),
		...webFns({ apiKey: options.web.key, keyEnv: options.web.keyEnv, ...(options.web.url === undefined ? {} : { baseUrl: options.web.url }), models: options.models, fast: options.fast }),
		...browserFns(browserDeps(options.web)),
		...fastBrowserFns({ ...browserDeps(options.web), models: options.models, fast: options.fast, classify: options.classify }),
		...mediaFns({ ...media, workDir: options.workDir }),
		...gifFns(options.workDir),
		messageTool(options.channels),
		...thinkFns({ models: options.models, ref: options.profiles.model, classify: options.classify }),
		...appsFns(options.apps ?? NO_APPS),
		...contextFns(options.workDir),
		...forkFns({ task: forkTask, scratchDir: (name) => join(options.workDir, "forks", name), ref: options.profiles.model }),
		...scheduleFns({ task: schedule, catalog: options.profiles, schedules: (context) => harness.commit(scanSchedules, context), abortTask: (id, context) => harness.abortTask(id, context), publicUrl: options.publicUrl, timeZone: options.timeZone, now: Date.now, users }),
		...procFns({ task: schedule, catalog: options.profiles, dir: procDir, workDir: options.workDir, abortTask: (id, context) => harness.abortTask(id, context) }),
		...profileFns(options.profiles, () => harness, reply, options.workDir),
	];
	for (const extension of [
		identityExtension([...options.channels.values()].map((channel) => channel.profile), users),
		memoryExtension(),
		skillsExtension(options.skillDirs),
		defineExtension({ name: "agents", tasks: [forkTask, reply] }),
		// Daemon only, so a terminal without a daemon leaves schedules and Turns waiting for one.
		...(options.scheduling === "daemon" ? [defineExtension({ name: "schedules", tasks: [schedule] })] : []),
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
			settings: { extensions: defaultSelection((name) => registry.snapshot().extension(name)), steeringMode: "all", followUpMode: "all", compaction: { enabled: false } },
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
	if (options.scheduling === "daemon") await migrateSchedulers(harness, schedule, options.profiles, log, context);
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
	await harness.commit(selectView, context);
	await harness.commit(addContextReaders, context);
	return { harness, classify: options.classify, line, schedule, catalog: options.profiles };
}

const browserDeps = (web: WebConfig) => ({ apiKey: web.key, keyEnv: web.keyEnv, ...(web.url === undefined ? {} : { baseUrl: web.url }), ...(web.browserProfile === undefined ? {} : { profile: web.browserProfile }) });

const notConnected = async (): Promise<never> => {
	throw new Error("No apps server is connected in this process.");
};
const NO_APPS: Apps = { search: notConnected, call: notConnected, skills: notConnected };
