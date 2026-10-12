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
	type TaskId,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { MochiCodingTools } from "./media/read-image.ts";
import type { Channels } from "./channels/types.ts";
import { workEnv } from "./env/work-env.ts";
import type { SearchIndex } from "./index/fts.ts";
import type { Log } from "./log.ts";
import type { AgentCatalog } from "./agents/catalog.ts";
import { agentFns, AgentTask } from "./agents/subagent.ts";
import { type Apps, appsFns } from "./apps/apps.ts";
import { callTask, SCRIPT_DEADLINE_MS } from "./code/code.ts";
import { noteTool, notesExtension, readMemory, recallTool, sortedNotes } from "./memory/memory.ts";
import { skillsExtension } from "./skills/skills.ts";
import { defineTrigger, notifyTool, RUN_DEADLINE_MS, scanTriggers, type TriggerTask, triggerFns } from "./triggers/trigger.ts";
import { defaultSelection, seatExtensions } from "./seats.ts";
import { channelsExtension, defineTurn, ensureLine, type Line, openTurn, RETRY, type Retry } from "./turn/turn.ts";
import { UPGRADES } from "./upgrade.ts";
import { webFns } from "./web/web.ts";
import { browserFns } from "./browser/browser.ts";
import { fastBrowserFns } from "./browser/fast.ts";
import { type MediaDeps, mediaFns } from "./media/media.ts";
import { gifFns } from "./media/gif.ts";
import { commandTask, runCommand } from "./turn/commands.ts";
import { compactionExtension, fastCompletion, handoffTool, idleResetIfStale } from "./turn/lifecycle.ts";
import type { Classify } from "./brain/classifier.ts";
import type { ChatUser } from "./config.ts";
import { thinkFns } from "./brain/think.ts";
import { identityExtension } from "./brain/identity.ts";
import { bindRepo, PublisherTask } from "./memory/publication.ts";
import { defineDream, dreamConfig, type DreamConfigInput, reconcileDream } from "./memory/dream.ts";

export interface MochiOptions {
	readonly memory?: { repo: string; dreaming?: DreamConfigInput };
	readonly storage: Storage;
	readonly models: Models;
	readonly brain: ModelRef;
	readonly fast: ModelRef;
	readonly classify: Classify;
	/** `FIRECRAWL_API_KEY` for the web functions; absent, they fail with a clear error. */
	readonly firecrawlKey: string | undefined;
	/** `FIRECRAWL_PROFILE`, the persistent browser profile `browse` logs in with. */
	readonly firecrawlProfile?: string;
	/** Image, video and speech providers; absent, the media functions say they are not configured. */
	readonly media?: Omit<MediaDeps, "workDir">;
	/** Minutes of silence after which an owner message starts a fresh root; 0 never resets. */
	readonly idleResetMinutes?: number;
	/** Executor; absent, the apps functions say it is not connected. */
	readonly apps?: Apps;
	/** Wall-clock limit of one `code` script. */
	readonly scriptDeadlineMs?: number;
	/** Wall-clock limit of one trigger run. */
	readonly triggerDeadlineMs?: number;
	readonly index: SearchIndex;
	/** Bundled skills, `<skillsDir>/<name>/SKILL.md`, listed in the prompt and opened with `read`. */
	readonly skillsDir: string;
	readonly agents: AgentCatalog;
	/** Where bash, read, edit and write run when a conversation sets no cwd. */
	readonly workDir: string;
	readonly channels: Channels;
	readonly timeZone: string;
	/** `MOCHI_PUBLIC_URL`, the origin webhook senders call. */
	readonly publicUrl: string | undefined;
	/** `daemon` installs the Turn task kind; `local` (a terminal with no daemon) leaves Turns waiting for one. */
	readonly scheduling: "daemon" | "local";
	readonly retry?: Retry;
	readonly today: () => string;
	readonly now?: () => Date;
	readonly log: Log;
	/** Root's own instructions (`data/persona.md`), rendered after every section; absent leaves root's as they are. */
	readonly persona?: string;
	/** Users who may write on iMessage, with normalized handles. */
	readonly users?: readonly ChatUser[];
}

export interface Mochi {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly registry: Registry;
	readonly classify: Classify;
	readonly line: Line;
	readonly trigger: TriggerTask;
}

/** The one context policy: pi-durable's built-in compaction, at its own defaults, written down. */
const COMPACTION: CompactionPolicy = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 32_768 };

export async function openMochi(options: MochiOptions, context: Context): Promise<Mochi> {
	const { index, log } = options;
	const dreaming = dreamConfig(options.memory?.dreaming, options.timeZone);
	const registry = createRegistry();
	const fast = fastCompletion(options.models, options.fast);
	const media: Omit<MediaDeps, "workDir"> = options.media ?? { config: { images: { default: "", providers: [] } }, env: {} };
	let line: Line | undefined;
	const lineOf = (): Line => {
		if (line === undefined) throw new Error("The line is bound before resume.");
		return line;
	};
	const providers = [
		MochiCodingTools,
		defineExtension({ name: "memory", tools: [noteTool({ index, today: options.today }), recallTool(index)] }),
		channelsExtension(options.channels),
		defineExtension({ name: "notify", tools: [notifyTool({ line: lineOf, channels: [...options.channels.keys()], classify: options.classify, log, users: options.users ?? [] })] }),
		defineExtension({ name: "handoff", tools: [handoffTool()] }),
	];
	const now = options.now ?? (() => new Date());
	const dream = defineDream({ models: { brain: options.brain, fast: options.fast }, today: options.today, log });
	const trigger = defineTrigger({ timeZone: options.timeZone, deadlineMs: options.triggerDeadlineMs ?? RUN_DEADLINE_MS, log });
	const fns = [
		...webFns({ apiKey: options.firecrawlKey, models: options.models, fast: options.fast }),
		...browserFns({ apiKey: options.firecrawlKey, profile: options.firecrawlProfile }),
		...fastBrowserFns({ apiKey: options.firecrawlKey, profile: options.firecrawlProfile, models: options.models, fast: options.fast, classify: options.classify }),
		...mediaFns({ ...media, workDir: options.workDir }),
		...gifFns({ workDir: options.workDir }),
		...thinkFns({ models: options.models, fast: options.fast, classify: options.classify }),
		...appsFns(options.apps ?? NO_APPS),
		...agentFns({ catalog: options.agents, read: (read, context) => harness.commit(read, context), abortTask: (id, context) => harness.abortTask(id, context) }),
		...triggerFns({ task: trigger, triggers: (context) => harness.commit(scanTriggers, context), abortTask: (id, context) => harness.abortTask(id, context), publicUrl: options.publicUrl, timeZone: options.timeZone, now: () => now().getTime(), users: options.users ?? [] }),
	];
	const call = callTask(new Map(fns.map((fn) => [fn.name, fn])));
	const code = { call, concurrency: 8, deadlineMs: options.scriptDeadlineMs ?? SCRIPT_DEADLINE_MS, abortTask: (id: TaskId, context: Context) => harness.abortTask(id, context) };
	for (const extension of [
		identityExtension([...options.channels.values()].map((channel) => channel.profile), options.users ?? []),
		notesExtension(),
		skillsExtension(options.skillsDir),
		compactionExtension(fast),
		...providers,
		defineExtension({ name: "work", tasks: [call] }),
		defineExtension({ name: "agents", tasks: [AgentTask] }),
		defineExtension({ name: "memory-maintenance", tasks: [PublisherTask, dream] }),
		// Daemon only, so a terminal without a daemon leaves triggers and Turns waiting for one.
		...(options.scheduling === "daemon" ? [defineExtension({ name: "triggers", tasks: [trigger] })] : []),
		...seatExtensions(providers.flatMap((extension) => extension.tools ?? []), fns, code),
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
			settings: { extensions: defaultSelection((name) => registry.snapshot().extension(name)), compaction: COMPACTION },
			env: ({ cwd }) => environment(cwd ?? options.workDir),
			onReport: (error) => log("harness.report", { error: String(error) }),
			now: () => now().getTime(),
		},
		context,
	);

	const root = await harness.root(context, { agent: { model: options.brain, thinkingLevel: "medium" } });
	await root.configure({ model: options.brain, ...(options.persona === undefined ? {} : { instructions: options.persona }) }, context);
	const turn = defineTurn({ root, harness, users: options.users ?? [], channels: options.channels, workDir: options.workDir, media, retry: options.retry ?? RETRY, log });
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
	const idleResetMinutes = options.idleResetMinutes ?? 60;
	line = {
		harness,
		root,
		id: lineId,
		turn,
		channels: options.channels,
		timeZone: options.timeZone,
		workDir: options.workDir,
		media,
		users: options.users ?? [],
		command: (input, context) => runCommand({ harness, lineId: () => lineId, task: commands }, input, context),
		...(idleResetMinutes > 0 ? { idleReset: (conversation: Conversation, key: string, context: Context) => idleResetIfStale({ harness, fast, idleResetMinutes, now: () => now().getTime() }, conversation, key, context) } : {}),
	};
	for (const step of UPGRADES) {
		const { changed } = await step.run({ storage: options.storage, line, trigger }, context);
		if (changed > 0) log("upgrade", { unit: step.unit, name: step.name, changed });
	}
	await bindRepo(harness, options.memory?.repo, context);
	await reconcileDream(harness, dream, dreaming, options.scheduling, context);
	index.replaceNotes(sortedNotes(await readMemory(harness, context)));
	return { harness, root, registry, classify: options.classify, line, trigger };
}

const notConnected = async (): Promise<never> => {
	throw new Error("Executor is not connected in this process.");
};
const NO_APPS: Apps = { search: notConnected, call: notConnected, skills: notConnected };
