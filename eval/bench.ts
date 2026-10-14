// Per-tool latency through the whole stack: a faux model (no network, no token delay) calls one tool, then answers.
// `tool` is the gap between the model's call and its next request (commit intent, run, commit result, rebuild the
// prompt); `turn` is submit to settled. Each sample opens a fresh mochi so history never grows. Scenarios interleave
// round by round. Every sample checks the tool result is not an error and carries the expected text.
// Usage: node eval/bench.ts [rounds] [only,these]
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Apps } from "../src/apps/apps.ts";
import { createSeatConversation } from "../src/seats.ts";
import { messageText } from "../src/text.ts";
import { LastInboundDoc } from "../src/turn/turn.ts";
import { newFaux, openTestMochi, recordingChannel, tempDir, type TestMochi } from "../src/test-support.ts";

type Args = Parameters<typeof fauxToolCall>[1];
interface Scenario {
	readonly name: string;
	readonly tool?: string;
	readonly args?: Args;
	/** Extra faux replies the tool itself consumes (a subagent's answer), placed between the call and the final reply. */
	readonly inner?: number;
	readonly expect?: RegExp;
	readonly seat?: "trigger";
	readonly setup?: (mochi: TestMochi, dir: string) => Promise<void>;
}

const LINES = Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
const apps: Apps = { search: async (query) => ({ items: [{ path: query, signature: "" }] }), call: async () => "ok", skills: async () => "" };

const seedIndex = async (mochi: TestMochi) => {
	const words = ["dentist", "flight", "rent", "mom", "invoice", "gym", "lease", "passport", "visa", "salary"];
	for (let c = 0; c < 10; c++) {
		const docs = Array.from({ length: 1000 }, (_, i) => ({ text: `talked about ${words[i % 10]} and ${words[(i * 7) % 10]} on day ${i}`, kind: "user" as const, ref: String(i + 1), at: `2026-0${1 + (i % 9)}-10T00:00:00Z` }));
		mochi.index.addEntries(c + 2, docs, 1000);
	}
};

const SCENARIOS: Scenario[] = [
	{ name: "baseline (no tool)" },
	{ name: "read 2000 lines", tool: "read", args: { path: "big.txt" }, expect: /line 700 /, setup: (_m, dir) => writeFile(join(dir, "work", "big.txt"), LINES) },
	{ name: "write 130 KB", tool: "write", args: { path: "out.txt", content: LINES }, expect: /Successfully|[Ww]rote/ },
	{ name: "edit one line", tool: "edit", args: { path: "big.txt", edits: [{ oldText: "line 1000 ", newText: "LINE 1000 " }] }, expect: /Successfully|[Ee]dited/, setup: (_m, dir) => writeFile(join(dir, "work", "big.txt"), LINES) },
	{ name: "bash echo", tool: "bash", args: { command: "echo hi" }, expect: /hi/ },
	{ name: "note", tool: "note", args: { slug: "dentist", kind: "user", subject: "Dentist", body: "Dr. Rao, Tuesdays." }, expect: /Saved note/ },
	{ name: "recall 10k docs", tool: "recall", args: { query: "dentist lease" }, expect: /entry/, setup: seedIndex },
	{ name: "react", tool: "react", args: { reaction: "👍" }, expect: /Reacted/, setup: async (m) => void (await m.harness.commit(async (tx) => void ((await tx.doc(LastInboundDoc)).last = { channel: "imessage", messageId: "m1" }), context)) },
	{ name: "notify (trigger seat)", tool: "notify", args: { text: "build broke" }, expect: /Queued/, seat: "trigger" },
	{ name: "code return 1", tool: "code", args: { code: "return 1;" }, expect: /completed[\s\S]*1/ },
	{ name: "code 1 nested call", tool: "code", args: { code: `return (await tools.apps_search({ query: "q" })).items.length;` }, expect: /completed\.\n1/ },
	{ name: "code 20 nested calls", tool: "code", args: { code: `return (await Promise.all(Array.from({ length: 20 }, (_, i) => tools.apps_search({ query: "q" + i })))).length;` }, expect: /completed\.\n20/ },
	{ name: "code agent (subagent)", tool: "code", args: { code: `return await tools.agent({ name: "p", brief: "say hi" });` }, inner: 1, expect: /completed\.\nsub-answer/ },
];

interface Sample { readonly open: number; readonly turn: number; readonly tool: number; readonly ok: boolean; readonly why?: string }

async function sample(s: Scenario): Promise<Sample> {
	const dir = await tempDir();
	const faux = newFaux();
	const { channel } = recordingChannel("imessage");
	const t0 = performance.now();
	const mochi = await openTestMochi(dir, faux, new Map([["imessage", channel]]), undefined, [], { apps });
	const opened = performance.now();
	await s.setup?.(mochi, dir);
	let called = 0;
	let answered = 0;
	if (s.tool === undefined) faux.setResponses([() => ((called = answered = performance.now()), fauxAssistantMessage("done"))]);
	else
		faux.setResponses([
			() => ((called = performance.now()), fauxAssistantMessage(fauxToolCall(s.tool!, s.args!), { stopReason: "toolUse" })),
			...Array.from({ length: s.inner ?? 0 }, () => fauxAssistantMessage("sub-answer")),
			() => ((answered = performance.now()), fauxAssistantMessage("done")),
		]);
	let conversation = mochi.root;
	if (s.seat === "trigger") {
		const id = await mochi.harness.commit((tx) => createSeatConversation(tx, "trigger", { kind: "ownerless" }), context);
		conversation = (await mochi.harness.conversation(id, context))!;
	}
	const start = performance.now();
	await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
	const end = performance.now();
	let ok = faux.getPendingResponseCount() === 0;
	let why = ok ? undefined : `${faux.getPendingResponseCount()} faux replies unused`;
	if (s.tool !== undefined && ok) {
		const items = (await conversation.entries({}, 200, undefined, context)).items;
		const result = items.find((item) => item.kind === "pi.tool-result")?.model?.[0];
		const text = result === undefined ? "" : messageText(result);
		const isError = (result as { isError?: boolean } | undefined)?.isError === true;
		ok = !isError && (s.expect?.test(text) ?? true);
		if (!ok) why = `${isError ? "error: " : "unexpected: "}${text.slice(0, 160)}`;
	}
	await mochi.close();
	return { open: opened - t0, turn: end - start, tool: answered - called, ok, ...(why === undefined ? {} : { why }) };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const rounds = Number(process.argv[2] ?? 7);
const only = process.argv[3]?.split(",");
const chosen = SCENARIOS.filter((s) => only === undefined || only.some((o) => s.name.startsWith(o)));
const results = new Map<string, Sample[]>(chosen.map((s) => [s.name, []]));
await sample(SCENARIOS[0]!); // warm the module graph and JIT; not reported
for (let r = 0; r < rounds; r++) for (const s of chosen) results.get(s.name)!.push(await sample(s));

const f = (x: number) => x.toFixed(1).padStart(7);
console.log(`${"scenario".padEnd(24)} ${"tool p50".padStart(8)} ${"range".padStart(17)} ${"turn p50".padStart(8)} ${"open p50".padStart(8)}  errors (n=${rounds})`);
for (const [name, xs] of results) {
	const tools = xs.map((x) => x.tool);
	const bad = xs.filter((x) => !x.ok);
	console.log(`${name.padEnd(24)} ${f(median(tools))} ${f(Math.min(...tools))} – ${f(Math.max(...tools))} ${f(median(xs.map((x) => x.turn)))} ${f(median(xs.map((x) => x.open)))}  ${bad.length}${bad[0]?.why ? ` (${bad[0].why})` : ""}`);
}
