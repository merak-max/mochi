// Runs one scenario's live part against Opus through Bifrost, the way the daemon would: the owner's messages enter
// through ingest as the scenario's phone channel, and what that channel would send is appended to sent.jsonl.
// Message ids are fixed per turn, so rerunning after a kill finds the same submissions instead of asking again.
// Run under eval/clock.ts: node --import ./eval/clock.ts eval/drive.ts <dataDir> <scenario> [--repo <dir>]
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Channel } from "../src/channels/types.ts";
import { scenario as byId, TIME_ZONE } from "./scenarios.ts";

const args = process.argv.slice(2);
const repoAt = args.indexOf("--repo");
const repo = resolve(repoAt < 0 ? join(import.meta.dirname, "..") : args.splice(repoAt, 2)[1]!);
const [dataDir, id] = args;
if (dataDir === undefined || id === undefined) throw new Error("Usage: drive.ts <dataDir> <scenario> [--repo <dir>]");
const scenario = byId(id);

// The code under test comes from `repo`, so the same driver runs the baseline copy and the working tree.
const { openMochi } = (await import(join(repo, "src/mochi.ts"))) as typeof import("../src/mochi.ts");
const { createClassify } = (await import(join(repo, "src/brain/classifier.ts"))) as typeof import("../src/brain/classifier.ts");
const { createBifrostModels, FAST, OPUS } = (await import(join(repo, "src/brain/models.ts"))) as typeof import("../src/brain/models.ts");
const { ingest } = (await import(join(repo, "src/turn/turn.ts"))) as typeof import("../src/turn/turn.ts");
const { PROFILES, turnsSettled } = (await import(join(repo, "src/test-support.ts"))) as typeof import("../src/test-support.ts");
const { SearchIndex } = (await import(join(repo, "src/index/fts.ts"))) as typeof import("../src/index/fts.ts");
const { runFeed } = (await import(join(repo, "src/memory/feed.ts"))) as typeof import("../src/memory/feed.ts");
const { AgentCatalog } = (await import(join(repo, "src/agents/catalog.ts"))) as typeof import("../src/agents/catalog.ts");
const { scanTriggers } = (await import(join(repo, "src/triggers/trigger.ts"))) as typeof import("../src/triggers/trigger.ts");

const out = join(dataDir, "..");
const record = (line: unknown) => appendFileSync(join(out, "sent.jsonl"), `${JSON.stringify(line)}\n`);
const log = (event: string, fields: Record<string, unknown> = {}) => appendFileSync(join(out, "daemon.log"), `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);

const phone: Channel = {
	profile: PROFILES[scenario.channel],
	run: async () => {},
	send: async (bubble) => record({ kind: "send", text: bubble.kind === "text" ? bubble.text : bubble.kind === "link" ? bubble.url : bubble.name }),
	typing: async () => {},
	react: async (messageId, reaction) => record({ kind: "react", messageId, emoji: reaction }),
};
const channels = new Map([[scenario.channel, phone]]);

const controller = new AbortController();
const running = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
const models = createBifrostModels(process.env.BIFROST_VIRTUAL_KEY ?? "", process.env.OPENROUTER_API_KEY || undefined);
const index = new SearchIndex(join(dataDir, "index.sqlite"));
const workDir = join(dataDir, "work");
await mkdir(workDir, { recursive: true });
const mochi = await openMochi(
	{
		storage: await openNodeSqliteStorage(join(dataDir, "mochi.sqlite")),
		models,
		brain: OPUS,
		fast: FAST,
		classify: createClassify(models),
		firecrawlKey: process.env.FIRECRAWL_API_KEY?.trim() || undefined,
		index,
		skillsDir: join(repo, "skills"),
		agents: await AgentCatalog.load(join(repo, "agents")),
		workDir,
		channels,
		timeZone: TIME_ZONE,
		publicUrl: undefined,
		scheduling: "daemon",
		today: () => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date()),
		log,
	},
	BACKGROUND_CONTEXT,
);
mochi.harness.resume();
const indexing = runFeed(mochi.harness, index, running, (error) => log("index.failed", { error: String(error) }));

if (scenario.trigger !== undefined) {
	const [task] = await mochi.harness.commit((tx) => scanTriggers(tx), running);
	await mochi.harness.waitForTask(task!.id, running);
} else {
	for (const [n, text] of (scenario.turns ?? []).entries()) {
		const submissionId = await ingest(mochi.line, { kind: "message", channel: scenario.channel, messageId: `${scenario.id}:${n + 1}`, text, at: new Date(), attachments: [] }, running);
		await (await mochi.harness.submission(submissionId, running))?.wait(running);
		await turnsSettled(mochi.harness, running);
	}
}
await turnsSettled(mochi.harness, running);
controller.abort();
await indexing;
await mochi.harness.close(BACKGROUND_CONTEXT);
index.close();
