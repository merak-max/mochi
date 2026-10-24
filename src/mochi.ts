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
import { addContextReaders, agentStopTool, type Definitions, definitionsSection } from "./agents/definitions.ts";
import { connectServer, type McpConnection } from "./mcp/servers.ts";
import { memoryExtension, selectView, zoomTool } from "./memory/memory.ts";
import { skillsExtension } from "./skills/skills.ts";
import { defineSchedule, notifyTool, RUN_DEADLINE_MS, scanSchedules, type ScheduleTask, scheduleFns } from "./schedule/schedule.ts";
import { migrateSchedulers } from "./schedule/migrate.ts";
import { migrateKeptLines } from "./memory/migrate.ts";
import { defaultSelection, type LiveTools, type McpTools, rootSelection, SEATS, seatExtensions } from "./seats.ts";
import { homeTools } from "./tools/home-tools.ts";
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
import type { ChatUser, McpServerConfig } from "./config.ts";
import { thinkFns } from "./brain/think.ts";
import { identityExtension } from "./brain/identity.ts";
import type { WebConfig } from "./config.ts";

interface MochiOptions {
	readonly storage: Storage;
	readonly models: Models;
	readonly brain: ModelRef;
	readonly fast: ModelRef;
	readonly classify: Classify;
	/** The web service for the web and browser functions; without a key they fail with a clear error. */
	/** Absent: no web or browser tools. */
	readonly web: WebConfig | undefined;
	/** Image, video and speech providers; absent, the media functions say they are not configured. */
	readonly media?: Omit<MediaDeps, "workDir">;
	/** The owner's MCP servers; `run` each returned connection to publish its tools. */
	readonly mcp: readonly McpServerConfig[];
	/** Where OAuth servers keep their tokens: `<homeDir>/mcp/<name>.json`. */
	readonly homeDir: string;
	/** fff file indexes for find and grep, one per root. */
	readonly files: FileIndexes;
	/** Skill directories, `<dir>/<name>/SKILL.md`: bundled first, then the owner's, which replace bundled ones by name. */
	readonly skillDirs: readonly string[];
	/** The owner's own tools, `<dir>/<name>.ts`; `tools_reload` loads them. */
	readonly toolsDir: string;
	/** Lasting facts, plain markdown files the agent reads and edits. */
	readonly memoryDir: string;
	readonly definitions: Definitions;
	/** Where bash, read, edit and write run when a conversation sets no cwd. */
	readonly workDir: string;
	readonly channels: Channels;
	readonly timeZone: string;
	readonly publicUrl: string | undefined;
	/** `daemon` runs schedules; `local` (a terminal with no daemon) leaves them waiting for one. Both run Turns. */
	readonly scheduling: "daemon" | "local";
	readonly log: Log;
	/** The owner's facts (`<home>/instructions.md`), after root's definition in root's instructions. */
	readonly instructions?: string;
	readonly users: readonly ChatUser[];
}

export interface Mochi {
	readonly harness: Harness;
	readonly classify: Classify;
	readonly line: Line;
	readonly schedule: ScheduleTask;
	readonly catalog: Definitions;
	/** One connection per configured MCP server; the daemon runs each. */
	readonly mcp: readonly McpConnection[];
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
	const schedule = defineSchedule({ timeZone: options.timeZone, deadlineMs: RUN_DEADLINE_MS, pollMs: PROC_POLL_MS, procDir, log, harness: () => harness, line: lineOf, catalog: options.definitions, classify: options.classify, workDir: options.workDir });
	const forkTask = defineForkTask(options.workDir);
	let seat: ReturnType<typeof seatExtensions> | undefined;
	let live: LiveTools = { home: [], mcp: [] };
	const home = homeTools(options.toolsDir, registry, (tools) => {
		live = { ...live, home: tools };
		return seat!("agent", live);
	});
	const library: ToolRegistration[] = [
		home.tool,
		...(await codingTools()),
		...searchFns(options.files),
		zoomTool(() => harness),
		reactTool(options.channels),
		sendTool(options.channels),
		...webTools(options),
		...mediaFns({ ...media, workDir: options.workDir }),
		...gifFns(options.workDir),
		messageTool(options.channels),
		...thinkFns({ models: options.models, ref: options.definitions.model, classify: options.classify }),
		...contextFns(options.workDir),
		...forkFns({ task: forkTask, scratchDir: (name) => join(options.workDir, "forks", name), definitions: options.definitions }),
		...scheduleFns({ task: schedule, catalog: options.definitions, schedules: (context) => harness.commit(scanSchedules, context), abortTask: (id, context) => harness.abortTask(id, context), publicUrl: options.publicUrl, timeZone: options.timeZone, now: Date.now, users }),
		...procFns({ task: schedule, catalog: options.definitions, dir: procDir, workDir: options.workDir, abortTask: (id, context) => harness.abortTask(id, context) }),
		agentStopTool(options.definitions, () => harness),
	];
	for (const extension of [
		identityExtension([...options.channels.values()].map((channel) => channel.profile), users, options.toolsDir, options.memoryDir),
		memoryExtension(),
		skillsExtension(options.skillDirs),
		defineExtension({ name: "agents", tasks: [forkTask] }),
		// Daemon only, so a terminal without a daemon leaves schedules waiting for one.
		...(options.scheduling === "daemon" ? [defineExtension({ name: "schedules", tasks: [schedule] })] : []),
	]) {
		registry.install(extension);
	}
	seat = seatExtensions(modelTools, library, [definitionsSection(options.definitions)], [contextSection()]);
	for (const name of SEATS) registry.install(seat(name, live));
	const builtIn = [...modelTools, ...library].map((each) => each.name);
	for (const server of options.mcp) {
		const taken = builtIn.filter((name) => name.startsWith(`${server.name}_`));
		if (taken.length > 0) throw new Error(`[mcp.${server.name}] would share the prefix ${server.name}_ with ${taken.join(", ")}. Rename the server.`);
	}
	const mcpServers = new Map<string, McpTools>();
	const mcp = options.mcp.map((server) =>
		connectServer(server, options.homeDir, log, (tools) => {
			mcpServers.set(server.name, tools);
			live = { ...live, mcp: [...mcpServers.values()] };
			for (const name of SEATS) registry.install(seat!(name, live));
		}),
	);
	const loaded = await home.reload([...modelTools, ...library].map((each) => each.name));
	if (loaded.length > 0) log("tools.loaded", { tools: loaded });

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

	const rootDefinition = await options.definitions.root();
	if (rootDefinition.tools !== undefined) throw new Error("agents/root.md sets tools, but root's tools come from its seat. Remove the tools line.");
	const rootModel = options.definitions.model(rootDefinition.model ?? "brain");
	const rootThinking = rootDefinition.thinking === undefined ? {} : { thinkingLevel: rootDefinition.thinking };
	const rootInstructions = [rootDefinition.instructions, options.instructions ?? ""].filter((part) => part !== "").join("\n\n");
	const root = await harness.root(context, { agent: { model: rootModel, ...rootThinking, extensions: rootSelection((name) => registry.snapshot().extension(name)) } });
	await root.configure({ model: rootModel, ...rootThinking, instructions: rootInstructions }, context);
	const turn = defineTurn({ root, harness, users, channels: options.channels, workDir: options.workDir, media, log });
	registry.install(defineExtension({ name: "delivery", tasks: [turn] }));
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
		await migrateSchedulers(harness, schedule, options.definitions, log, context);
		await migrateKeptLines(harness, options.memoryDir, (await options.definitions.all()).map((definition) => definition.name), log, context);
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
	await harness.commit(selectView, context);
	await harness.commit(addContextReaders, context);
	return { harness, classify: options.classify, line, schedule, catalog: options.definitions, mcp };
}

function webTools(options: MochiOptions): ToolRegistration[] {
	const web = options.web;
	if (web === undefined) return [];
	return [
		...webFns({ apiKey: web.key, keyEnv: web.keyEnv, baseUrl: web.url, models: options.models, fast: options.fast }),
		...browserFns(browserDeps(web)),
		...fastBrowserFns({ ...browserDeps(web), models: options.models, fast: options.fast, classify: options.classify }),
	];
}

const browserDeps = (web: WebConfig) => ({ apiKey: web.key, keyEnv: web.keyEnv, baseUrl: web.url, ...(web.browserProfile === undefined ? {} : { profile: web.browserProfile }) });
