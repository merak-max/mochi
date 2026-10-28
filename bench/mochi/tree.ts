import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, contentText, type Message, type Tool, type ToolResultMessage, Type, type UserMessage } from "@earendil-works/pi-ai";
import { createModelSetup, type ModelSetup } from "../../src/brain/providers.ts";
import { compact, fitBoth } from "../../src/memory/compactor.ts";
import { freshTree, nodeOf, show, tailStart, type Tree, viewBefore } from "../../src/memory/memory.ts";
import { VIEW } from "../../src/memory/prompt.ts";
import { bytes, HIGH, NODE, slot, source, todo, type View, zoom } from "../../src/memory/view.ts";
import { fastCompletion } from "../../src/turn/lifecycle.ts";

const PROXY_PORT = 18790;
const MODEL = "azure/gpt-6-luna";
const ANSWER_EFFORT = "medium";
const SMALL_TAIL_HIGH = 16000;
const MAX_ZOOMS = 8;
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000];
const ANSWER_CONCURRENCY = 8;
const CONTENT_FILTER_EXIT = 3;
const VARIANTS = [
	{ system: "mochi-tree", high: HIGH },
	{ system: "mochi-tree-small-tail", high: SMALL_TAIL_HIGH },
];

type Turn = { role: "user" | "assistant"; speaker: string; date: string; timestamp: string; session: number; text: string };
type Question = { qid: string; question: string; message: string };
type Item = { bench: string; item_id: string; turns: Turn[]; questions: Question[]; answer_system: string };

function proxyUrl(system: string, bench: string, item: string, phase: string): string {
	return `http://127.0.0.1:${PROXY_PORT}/t/${system}/${bench}/${item}/${phase}/v1`;
}

async function luna(url: string): Promise<ModelSetup> {
	const full = "bench/" + MODEL;
	return createModelSetup({
		providers: { bench: { api: "openai-responses", url, keyEnv: "BENCH_PROXY_KEY" } },
		models: { brain: full, fast: full, memory: full, overrides: { [full]: { contextWindow: 272000, maxTokens: 128000 } } },
		env: { BENCH_PROXY_KEY: "bench-proxy-injects-the-key" },
	});
}

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function turnText(turn: Turn): string {
	return "[" + turn.date + "] " + turn.speaker + ": " + turn.text;
}

function toMessages(turns: Turn[]): Message[] {
	const messages: Message[] = [];
	for (let k = 0; k < turns.length; k++) {
		const turn = turns[k]!;
		const timestamp = Date.parse(turn.timestamp + "Z") + k;
		if (turn.role === "user") {
			messages.push({ role: "user", content: turnText(turn), timestamp } satisfies UserMessage);
		} else {
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: turnText(turn) }],
				api: "openai-responses",
				provider: "history",
				model: "history",
				usage: NO_USAGE,
				stopReason: "stop",
				timestamp,
			} satisfies AssistantMessage);
		}
	}
	return messages;
}

function saveJson(path: string, value: unknown): void {
	writeFileSync(path + ".tmp", JSON.stringify(value));
	renameSync(path + ".tmp", path);
}

type Trees = { tree: Tree; small: Tree };

function smallTree(tree: Tree): Tree {
	const fresh = freshTree(tree.start);
	return { ...fresh, nodes: tree.nodes, view: { ...fresh.view, high: SMALL_TAIL_HIGH } };
}

function loadTrees(treeFile: string, start: number): Trees {
	if (!existsSync(treeFile)) {
		const tree = freshTree(start);
		return { tree, small: smallTree(tree) };
	}
	const saved = JSON.parse(readFileSync(treeFile, "utf8")) as { tree: Tree; small: { view: View; seen: View } };
	return { tree: saved.tree, small: { ...saved.tree, view: saved.small.view, seen: saved.small.seen } };
}

function saveTrees(treeFile: string, trees: Trees): void {
	saveJson(treeFile, { tree: trees.tree, small: { view: trees.small.view, seen: trees.small.seen } });
}

async function withRetries<T>(label: string, attempt: () => Promise<T>): Promise<T> {
	for (let tries = 0; ; tries++) {
		try {
			return await attempt();
		} catch (error) {
			if (tries >= RETRY_DELAYS_MS.length) throw error;
			console.log(`${label}: attempt ${tries + 1} failed, retrying in ${RETRY_DELAYS_MS[tries]! / 1000} s: ${String(error)}`);
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[tries]));
		}
	}
}

async function buildTree(item: Item, history: Message[], treeFile: string, setup: ModelSetup): Promise<{ storedNodes: number; viewBytes: number; smallViewBytes: number }> {
	const trees = loadTrees(treeFile, history[0]!.timestamp);
	const { tree, small } = trees;
	const memory = fastCompletion(setup.models, setup.memory);
	const complete: typeof memory = (request, context) => withRetries(item.item_id + " compaction", () => memory(request, context));
	const deps = { harness: undefined as never, complete, log: () => {}, notify: async () => {}, now: Date.now };
	for (let arrived = Math.max(tree.count, 1); arrived <= history.length; arrived++) {
		const chat = history.slice(0, arrived);
		for (;;) {
			const node = nodeOf(tree, chat);
			const grew = chat.length > tree.count;
			tree.count = chat.length;
			small.count = chat.length;
			fitBoth(tree, node, grew);
			fitBoth(small, node, grew);
			const next = todo(node, tree.count)[0];
			if (next === undefined) break;
			const input = source(node, (i) => show(chat[i]!), next.l, next.i)!;
			const line = bytes(input) <= NODE ? input : await compact(deps, tree, node, next.l, next.i, input, BACKGROUND_CONTEXT);
			tree.nodes[String(slot(next.l, next.i))] = line;
			fitBoth(tree, nodeOf(tree, chat), false);
			fitBoth(small, nodeOf(tree, chat), false);
			saveTrees(treeFile, trees);
		}
		saveTrees(treeFile, trees);
	}
	console.log(`${item.item_id}: tree has ${Object.keys(tree.nodes).length} stored nodes over ${tree.count} messages; view ${tree.view.size} bytes, small view ${small.view.size} bytes`);
	return { storedNodes: Object.keys(tree.nodes).length, viewBytes: tree.view.size, smallViewBytes: small.view.size };
}

const zoomTool: Tool = {
	name: "zoom",
	description: "Open line id+n of your view into the two lines it was made from; n: 1 gives message id whole.",
	parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
};

async function answerOne(item: Item, history: Message[], tree: Tree, high: number, question: Question, setup: ModelSetup): Promise<{ answer: string; zooms: number; requestBytes: number; tailFrom: number }> {
	const asked: UserMessage = { role: "user", content: question.message, timestamp: history.at(-1)!.timestamp + 1 };
	const chat = [...history, asked];
	const from = tailStart(chat, tree, chat.length, high);
	let messages: Message[] = chat;
	if (from !== 0) {
		const view = viewBefore(chat, tree, from);
		messages = [{ role: "user", content: view.content, timestamp: tree.start }, ...chat.slice(from)];
	}
	let requestBytes = 0;
	for (const message of messages) requestBytes += bytes(typeof message.content === "string" ? message.content : contentText(message.content as never));
	const node = nodeOf(tree, history);
	const model = setup.models.getModel(setup.memory.provider, setup.memory.modelId)!;
	let zooms = 0;
	for (let round = 0; round <= MAX_ZOOMS + 2; round++) {
		const response = await withRetries(question.qid + " answer", async () => {
			const reply = await setup.models.completeSimple(model, { systemPrompt: VIEW + "\n\n" + item.answer_system, messages, tools: [zoomTool] }, { reasoning: ANSWER_EFFORT, maxTokens: model.maxTokens });
			if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(`answer ${question.qid} failed: ${reply.errorMessage ?? reply.stopReason}`);
			return reply;
		});
		messages.push(response);
		const calls = response.content.filter((part) => part.type === "toolCall");
		if (calls.length === 0) return { answer: contentText(response.content).trim(), zooms, requestBytes, tailFrom: from };
		for (const call of calls) {
			let text: string;
			if (zooms >= MAX_ZOOMS) {
				text = `Zoom limit of ${MAX_ZOOMS} reached. Answer now with what you have.`;
			} else {
				zooms++;
				text = zoom(node, (i) => show(history[i]!), history.length, Number(call.arguments.id), Number(call.arguments.n));
			}
			messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() } satisfies ToolResultMessage);
		}
	}
	throw new Error(`answer ${question.qid} kept calling zoom past ${MAX_ZOOMS + 2} rounds`);
}

async function answerAll(runDir: string, item: Item, history: Message[], tree: Tree, variant: { system: string; high: number }): Promise<void> {
	const dir = join(runDir, item.bench, variant.system, item.item_id);
	mkdirSync(dir, { recursive: true });
	const answersFile = join(dir, "answers.jsonl");
	const done = new Set<string>();
	if (existsSync(answersFile)) {
		for (const line of readFileSync(answersFile, "utf8").split("\n")) {
			if (line.trim() !== "") done.add((JSON.parse(line) as { qid: string }).qid);
		}
	}
	const setup = await luna(proxyUrl(variant.system, item.bench, item.item_id, "answer"));
	const pending = item.questions.filter((question) => !done.has(question.qid));
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < pending.length) {
			const question = pending[next++]!;
			const started = Date.now();
			const result = await answerOne(item, history, tree, variant.high, question, setup);
			const row = { qid: question.qid, answer: result.answer, wall_s: (Date.now() - started) / 1000, context_bytes: result.requestBytes, info: { zoom_calls: result.zooms, tail_from: result.tailFrom, messages: history.length, high: variant.high } };
			appendFileSync(answersFile, JSON.stringify(row) + "\n");
		}
	};
	const workers: Promise<void>[] = [];
	for (let k = 0; k < ANSWER_CONCURRENCY; k++) workers.push(worker());
	await Promise.all(workers);
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { "run-dir": { type: "string" }, bench: { type: "string" }, item: { type: "string" } } });
	const runDir = values["run-dir"]!;
	const item = JSON.parse(readFileSync(join(runDir, "items", values.bench!, values.item! + ".json"), "utf8")) as Item;
	const history = toMessages(item.turns);
	const dir = join(runDir, item.bench, "mochi-tree", item.item_id);
	mkdirSync(dir, { recursive: true });
	const treeFile = join(dir, "tree.json");
	const ingestFile = join(dir, "ingest.json");
	if (!existsSync(ingestFile)) {
		const started = Date.now();
		const setup = await luna(proxyUrl("mochi-tree", item.bench, item.item_id, "ingest"));
		const details = await buildTree(item, history, treeFile, setup);
		saveJson(ingestFile, { wall_s: (Date.now() - started) / 1000, details: { messages: history.length, ...details } });
	}
	const trees = loadTrees(treeFile, history[0]!.timestamp);
	await answerAll(runDir, item, history, trees.tree, VARIANTS[0]!);
	await answerAll(runDir, item, history, trees.small, VARIANTS[1]!);
}

try {
	await main();
} catch (error) {
	const text = String(error);
	if (text.includes("content_filter") || text.includes("content management policy")) {
		console.error("content filter blocked this item: " + text);
		process.exit(CONTENT_FILTER_EXIT);
	}
	throw error;
}
