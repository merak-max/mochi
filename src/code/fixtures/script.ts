// One daemon life for the code kill test: node src/code/fixtures/script.ts <dir> <scenario> <kill point | none>
// Root runs one `code` call whose script calls a recording fake Executor. Each outside effect is appended to
// <dir>/effects.jsonl before it returns, and the life SIGKILLs itself at the kill point. The last life prints a summary.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type CommitChange, ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import type { Apps } from "../../apps/apps.ts";
import { messageText } from "../../text.ts";
import { newFaux, openTestMochi } from "../../test-support.ts";

const [dir, scenario, kill] = process.argv.slice(2) as [string, string, string];
const SCRIPTS: Record<string, string> = {
	chain: `const a = await tools.apps_search({ query: "mail" });
const b = await tools.apps_search({ query: "mail" });
const c = await tools.apps_call({ path: "gmail.send", args: { to: "riya" } });
return { a, b, c };`,
	fanout: `return await Promise.all([0, 1, 2, 3, 4, 5].map((n) => tools.apps_call({ path: "gmail.send", args: { to: n % 3 } })));`,
	agent: `return await tools.agent({ name: "primes", brief: "List the first three primes." });`,
};
const die = () => process.kill(process.pid, "SIGKILL");
const effectsFile = join(dir, "effects.jsonl");
const effects = (): { op: string; args?: unknown }[] => (existsSync(effectsFile) ? readFileSync(effectsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
const record = (op: string, args?: unknown): number => {
	appendFileSync(effectsFile, `${JSON.stringify({ op, args })}\n`);
	return effects().filter((effect) => effect.op === op).length;
};

const apps: Apps = {
	search: async () => {
		const n = record("search");
		if (kill === "search-2" && n === 2) die();
		return { items: [{ path: "gmail.send", signature: `hit ${n}` }] };
	},
	call: async (_path, args) => {
		const n = record("call", args);
		if (kill === "call") die();
		await sleep(scenario === "fanout" ? 150 * n : 0);
		return `sent ${n}`;
	},
	skills: async () => "",
};

const faux = newFaux();
const respond = (transcript: TranscriptContext) => {
	const last = transcript.messages.findLast((message) => message.role !== "system");
	if (last?.role === "toolResult") return fauxAssistantMessage("done");
	if (last !== undefined && messageText(last).includes("first three primes")) return fauxAssistantMessage("2, 3, 5.");
	return fauxAssistantMessage(fauxToolCall("code", { code: SCRIPTS[scenario]! }), { stopReason: "toolUse" });
};
faux.setResponses(Array.from({ length: 6 }, () => respond));

const terminal = new Set<number>();
const call = (change: CommitChange) => (change.type === "task" && change.value.kind === "mochi.call" ? change.value : undefined);
const KILLS: Record<string, (change: CommitChange) => boolean> = {
	done: (change) => call(change)?.state.status === "terminal" && (call(change)?.input as { fn: string }).fn === "apps_call",
	"fanout-3": (change) => call(change)?.state.status === "terminal" && terminal.add(call(change)!.id).size === 3,
	"agent-brief": (change) => change.type === "entry" && change.value.conversationId !== ROOT_CONVERSATION_ID && UserEntry.is(change.value),
};

const mochi = await openTestMochi(dir, faux, new Map(), undefined, [], { apps });
mochi.harness.subscribeCommits(({ changes }) => {
	for (const change of changes) {
		if (change.type === "document" && change.record.kind === "mochi.journal" && change.value !== null) {
			appendFileSync(join(dir, "journal.jsonl"), `${JSON.stringify(Object.values(change.value.created as object).map((id) => typeof id))}\n`);
		}
	}
	if (changes.some((change) => KILLS[kill]?.(change) === true)) die();
});
mochi.harness.resume();
if (!existsSync(join(dir, "submitted"))) {
	writeFileSync(join(dir, "submitted"), "");
	await mochi.root.submit({ type: "input", content: "go", requestId: "go" }, context);
}
await mochi.root.waitForIdle(context);

const entries = [...(await mochi.root.entries({}, 100, undefined, context)).items].reverse();
const tasks = (await mochi.harness.commit((tx) => tx.scanTasks({ kind: "mochi.call" }, 100), context)).items;
const summary = {
	effects: effects(),
	result: entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => (entry.model?.[0] === undefined ? "" : messageText(entry.model[0]))),
	calls: tasks.length,
	journal: [...new Set(existsSync(join(dir, "journal.jsonl")) ? readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").flatMap((line) => JSON.parse(line) as string[]) : [])],
	agents: (await mochi.harness.commit((tx) => tx.scanTasks({ kind: "mochi.agent" }, 100), context)).items.map((task) => task.state.status),
	conversations: (await mochi.harness.commit((tx) => tx.scanConversations({}, 100), context)).items.length,
	replay: mochi.registry.snapshot().extension("seat-owner")?.tools?.find((tool) => tool.name === "code")?.replay,
};
await mochi.close();
process.stdout.write(`${JSON.stringify(summary)}\n`);
