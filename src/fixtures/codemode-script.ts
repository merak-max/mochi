// One daemon life for the codemode kill test: node src/fixtures/codemode-script.ts <dir> <scenario> <kill point | none>
// Root runs one `codemode` call whose script calls a recording fake Executor. Each outside effect is appended to
// <dir>/effects.jsonl before it returns, and the life SIGKILLs itself at the kill point. The last life prints a summary.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type CommitChange, type TaskId, ToolTask, type ToolTaskInput } from "@earendil-works/pi-durable";
import type { Apps } from "../apps/apps.ts";
import { messageText } from "../text.ts";
import { newFaux, openTestMochi } from "../test-support.ts";

const [dir, scenario, kill] = process.argv.slice(2) as [string, string, string];
const SCRIPTS: Record<string, string> = {
	chain: `const a = await tools.apps_search({ query: "mail" });
const b = await tools.apps_search({ query: "mail" });
const c = await tools.apps_call({ path: "gmail.send", args: { to: "riya" } });
return { a, b, c };`,
	fanout: `return await Promise.all([0, 1, 2, 3, 4, 5].map((n) => tools.apps_call({ path: "gmail.send", args: { to: n % 3 } })));`,
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
	return fauxAssistantMessage(fauxToolCall("codemode", { code: SCRIPTS[scenario]! }), { stopReason: "toolUse" });
};
faux.setResponses(Array.from({ length: 6 }, () => respond));

const terminal = new Set<TaskId>();
const nestedName = (change: CommitChange): string | undefined => {
	if (change.type !== "task" || change.value.kind !== ToolTask.definition.name) return undefined;
	const input = change.value.input as ToolTaskInput;
	return input.kind === "nested" ? input.call.name : undefined;
};
const finished = (change: CommitChange, name: string): boolean => nestedName(change) === name && change.type === "task" && change.value.state.status === "terminal";
const KILLS: Record<string, (change: CommitChange) => boolean> = {
	done: (change) => finished(change, "apps_call"),
	"fanout-3": (change) => finished(change, "apps_call") && change.type === "task" && terminal.add(change.value.id).size === 3,
};

const mochi = await openTestMochi(dir, faux, new Map(), undefined, [], { apps });
mochi.harness.subscribeCommits(({ changes }) => {
	if (changes.some((change) => KILLS[kill]?.(change) === true)) die();
});
mochi.harness.resume();
if (!existsSync(join(dir, "submitted"))) {
	writeFileSync(join(dir, "submitted"), "");
	await mochi.root.submit({ type: "input", content: "go", requestId: "go" }, context);
}
await mochi.root.waitForIdle(context);

const entries = [...(await mochi.root.entries({}, 100, undefined, context)).items].reverse();
const tools = (await mochi.harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
const summary = {
	effects: effects(),
	result: entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => (entry.model?.[0] === undefined ? "" : messageText(entry.model[0]))),
	calls: tools.filter((task) => (task.input as ToolTaskInput).kind === "nested").length,
	replay: mochi.registry.snapshot().extension("seat-owner")?.tools?.find((tool) => tool.name === "codemode")?.replay,
};
await mochi.close();
process.stdout.write(`${JSON.stringify(summary)}\n`);
