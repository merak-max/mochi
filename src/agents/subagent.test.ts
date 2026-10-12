import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, type JsonObject, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { messageText } from "../text.ts";
import { NOTIFY_ENTRY } from "../turn/turn.ts";
import { FAUX, newFaux, openTestMochi, recordingChannel, tempDir, type TestMochi, turnsSettled } from "../test-support.ts";
import { AgentCatalog, parseAgentFile } from "./catalog.ts";

const tool = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const hang = (_t: TranscriptContext, options?: { signal?: AbortSignal }) => new Promise<AssistantMessage>((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

/** Each conversation answers its latest scripted input: one step before a tool result, one after. */
type Seen = { direct: string[]; scripted: string[] };

/** The tools a request offers: the model's own, and the ones the `codemode` section lists for scripts. */
function toolsOf(transcript: TranscriptContext): Seen {
	const direct: string[] = [];
	let section = "";
	for (const message of transcript.messages) {
		if (message.role !== "system") continue;
		for (const each of message.toolsAdded ?? []) direct.push(each.name);
		section = message.sections?.codemode ?? section;
	}
	const scripted = [...section.matchAll(/^### `(\w+)`$/gm)].map((match) => match[1]!);
	return { direct, scripted };
}

function scripted(faux: ReturnType<typeof newFaux>, plays: Record<string, readonly [AssistantMessage | typeof hang, string]>, seen: Map<string, Seen>) {
	const step = (transcript: TranscriptContext, options?: { signal?: AbortSignal }) => {
		const { messages } = transcript;
		const at = messages.findLastIndex((message) => message.role === "user" && Object.hasOwn(plays, messageText(message)));
		const input = messageText(messages[at]!);
		seen.set(input, toolsOf(transcript));
		const [before, after] = plays[input]!;
		if (messages.slice(at).some((message) => message.role === "toolResult")) return fauxAssistantMessage(after);
		return typeof before === "function" ? before(transcript, options) : before;
	};
	faux.setResponses(Array.from({ length: 30 }, () => step));
}

const agentTasks = async (mochi: TestMochi): Promise<TaskId[]> => (await mochi.harness.commit((tx) => tx.scanTasks({ kind: "mochi.agent" }, 64), context)).items.map((task) => task.id);
const rootEntries = async (mochi: TestMochi) => (await mochi.root.entries({}, 100, undefined, context)).items;

test("agent files give instructions, model and thinking; the real catalog resolves tiers onto Bifrost", async () => {
	assert.deepEqual(parseAgentFile("x", "---\nmodel: fast\nthinking: low\n---\n\n# X\nDo it.\n"), { name: "x", instructions: "# X\nDo it.", model: "fast", thinking: "low" });
	assert.throws(() => parseAgentFile("y", "---\nthinking: huge\n---\nbody"), /thinking "huge"/);
	const catalog = await AgentCatalog.load(new URL("../../agents", import.meta.url).pathname);
	assert.deepEqual(catalog.model("fast"), { provider: "bifrost-openai", modelId: "azure/gpt-6-luna" });
	assert.throws(() => catalog.model("panel"), /is a list/);
});

test("a foreground agent answers through the calling script, in seat worker with no agent functions", async () => {
	const faux = newFaux();
	const seen = new Map<string, Seen>();
	scripted(faux, { go: [tool("codemode", { code: `return await tools.agent({ name: "primes", brief: "Name three primes.", type: "tester" })` }), "done"], "Name three primes.": [fauxAssistantMessage("2, 3, 5."), ""] }, seen);
	const mochi = await openTestMochi(await tempDir(), faux, new Map(), undefined, [{ name: "tester", instructions: "You test things.", thinking: "high" }]);
	await (await mochi.root.submit({ type: "input", content: "go" }, context)).wait(context);
	const result = (await rootEntries(mochi)).find((entry) => entry.kind === "pi.tool-result");
	assert.match(messageText(result!.model![0]!), /^Script completed\nWall time [\d.]+ seconds\nOutput:\n\n2, 3, 5\.$/);
	const child = seen.get("Name three primes.")!;
	assert.deepEqual(child.direct, ["codemode"]);
	assert.deepEqual(child.scripted, ["read", "write", "edit", "bash", "recall", "web_search", "web_fetch", "llm", "apps_search", "apps_call"]);
	await mochi.close();
});

test("background agents post nothing into root: a notify reaches the channel verbatim and leaves one record, a silent one leaves nothing", async () => {
	const faux = newFaux();
	const seen = new Map<string, Seen>();
	const start = `return [await tools.agent_start({ name: "loud", brief: "Check the build." }), await tools.agent_start({ name: "quiet", brief: "Check the weather." })]`;
	scripted(faux, { go: [tool("codemode", { code: start }), "started"], "Check the build.": [tool("notify", { text: "Build failed on main." }), "told"], "Check the weather.": [fauxAssistantMessage("Sunny."), ""] }, seen);
	const whatsapp = recordingChannel("whatsapp");
	const mochi = await openTestMochi(await tempDir(), faux, new Map([["whatsapp", whatsapp.channel]]));
	await (await mochi.root.submit({ type: "input", content: "go" }, context)).wait(context);
	for (const id of await agentTasks(mochi)) await mochi.harness.waitForTask(id, context);
	await turnsSettled(mochi.harness);

	const entries = await rootEntries(mochi);
	assert.deepEqual(whatsapp.sent, ["Build failed on main."]);
	const kinds = entries.map((entry) => entry.kind);
	assert.deepEqual([kinds.filter((kind) => kind === "pi.user").length, kinds.filter((kind) => kind === "pi.assistant").length], [1, 2]);
	const records = entries.filter((entry) => entry.kind === NOTIFY_ENTRY);
	assert.equal(records.length, 1);
	assert.match(messageText(records[0]!.model![0]!), /^\[context, no reply needed: told user1 on whatsapp, from conversation \d+\] Build failed on main\.$/);
	const run = seen.get("Check the build.")!;
	assert.deepEqual(run.direct, ["notify", "codemode"]);
	assert.ok(run.scripted.includes("trigger_list"));
	assert.ok(!run.scripted.some((name) => name.startsWith("agent") || name === "trigger_add"), run.scripted.join(", "));
	await mochi.close();
});

test("Esc stops a foreground agent; only /stop reaches a background one", async () => {
	const faux = newFaux();
	scripted(faux, { fg: [tool("codemode", { code: `return await tools.agent({ name: "fg", brief: "Hang in front." })` }), ""], bg: [tool("codemode", { code: `return await tools.agent_start({ name: "bg", brief: "Hang behind." })` }), "started"], "Hang in front.": [hang, ""], "Hang behind.": [hang, ""] }, new Map());
	const mochi = await openTestMochi(await tempDir(), faux);
	await (await mochi.root.submit({ type: "input", content: "bg" }, context)).wait(context);
	void mochi.root.submit({ type: "input", content: "fg" }, context);
	while ((await agentTasks(mochi)).length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
	const [bg, fg] = await agentTasks(mochi);
	await mochi.root.abort(context);
	assert.equal((await mochi.harness.waitForTask(fg!, context)).state.outcome.status, "aborted");
	assert.equal((await mochi.harness.getTask(bg!, context))?.state.status, "running");
	await mochi.root.abort(context, { background: true });
	assert.equal((await mochi.harness.waitForTask(bg!, context)).state.outcome.status, "aborted");
	await mochi.close();
});

test("the boot upgrade settles a live Reporter task once and retires the old agent documents", async () => {
	const dir = await tempDir();
	const reporter = defineTask<null, { phase: "deliver" }, null>({ name: "mochi.agent-reporter", version: 1, initial: () => ({ phase: "deliver" }), phases: { deliver: async () => {} }, abort: async () => {} });
	const agents = defineDoc({ kind: "mochi.agents", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ agents: {} as Record<string, string> }) });
	const registry = createRegistry();
	registry.install(defineExtension({ name: "old", tasks: [reporter] }));
	const old = await Harness.open(await openNodeSqliteStorage(join(dir, "mochi.sqlite")), { models: createModels(), registry }, context);
	await old.root(context, { agent: { model: FAUX, thinkingLevel: "high" } });
	const id = await old.commit(async (tx) => {
		(await tx.doc(agents, ROOT_CONVERSATION_ID)).agents.a = "x";
		return tx.createTask(reporter, null, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
	}, context);
	await old.close(context);
	const logs: unknown[] = [];
	const mochi = await openTestMochi(dir, newFaux(), new Map(), undefined, [], { log: (event, fields) => logs.push({ event, ...fields }) });
	assert.deepEqual(logs.at(-1), { event: "upgrade", unit: "U9", name: "drain-agent-kinds", changed: 2 });
	assert.deepEqual((await mochi.harness.getTask(id, context))?.state, { status: "terminal", outcome: { status: "orphaned", reason: "missing_task" } });
	assert.equal(await mochi.harness.snapshot(agents, ROOT_CONVERSATION_ID, context), undefined);
	await mochi.close();
	const again: unknown[] = [];
	await (await openTestMochi(dir, newFaux(), new Map(), undefined, [], { log: (event) => again.push(event) })).close();
	assert.deepEqual(again, []);
});
