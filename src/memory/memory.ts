import type { Context } from "@earendil-works/chord";
import { type Message, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	ToolResultEntry,
	CompactionTask,
	type ConversationId,
	defineDoc,
	defineDocFamily,
	type DocumentReader,
	defineExtension,
	defineTool,
	type EntryRecord,
	type Extension,
	type Harness,
	hook,
	LiveDoc,
	AgentDoc,
	ROOT_CONVERSATION_ID,
	section,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { SearchIndex } from "../index/fts.ts";
import { messageText } from "../text.ts";
import type { FastCompletion } from "../turn/lifecycle.ts";
import { type Block, blockKey, cover, halves, pending, RAW_MAX } from "./tree.ts";

// Two OptMem logs share one tree shape. The memory log holds lines the model chose to keep (`note`); a conversation's
// log holds one line per turn. Raw lines never change; each complete block gets one summary line, written once. The
// prompt shows `cover()` of the memory log, and a compaction replaces old turns with `cover()` of the turn log, so
// nothing is summarized twice and every line can be opened again with `zoom`.

/** How many lines the wake view and a compacted window show. A reading size, not a storage limit. */
const WAKE_LINES = 96;

/** `from`: in a turn log, the first entry of the turn. Memory lines have none. */
type Line = { readonly at: string; readonly text: string; readonly from?: number };
type Tree = { readonly lines: Line[]; readonly blocks: Record<string, string> };

const empty = (): Tree => ({ lines: [], blocks: {} });

export const MemoryLog = defineDoc<Tree>({ kind: "mochi.memory-log", version: 1, scope: "session", initial: empty });

/** A profile's own memory log, by profile name. Root's is `MemoryLog`. */
const ProfileMemoryLog = defineDocFamily<Tree, null>({ kind: "mochi.profile-memory", version: 1, scope: "session", family: true, initial: empty });

/** Whose memory a conversation reads and writes: a profile's name, or root. */
export type Owner = { readonly profile: string } | "root";

type MemoryReader = Pick<DocumentReader, "snapshot">;

async function readTree(read: MemoryReader, owner: Owner, context: Context): Promise<Tree> {
	const tree = owner === "root" ? await read.snapshot(MemoryLog, context) : await read.snapshot(ProfileMemoryLog, owner.profile, context);
	return tree ?? empty();
}

const writeTree = (tx: Tx, owner: Owner): Promise<Tree> => (owner === "root" ? tx.doc(MemoryLog) : tx.doc(ProfileMemoryLog, owner.profile, null));

/** One turn log per conversation; `upTo` is the newest entry folded into it. */
const TurnLog = defineDoc<Tree & { readonly upTo: number }>({
	kind: "mochi.turn-log",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ ...empty(), upTo: 0 }),
});

const OldMemoryDoc = defineDoc<{ notes: Record<string, { subject: string; kind: string; body: string; updated: string }> }>({
	kind: "mochi.memory",
	version: 2,
	scope: "conversation",
	history: "rewindable",
	fork: "current",
	initial: () => ({ notes: {} }),
});

function render(tree: Tree, [lo, hi]: Block): string {
	if (hi - lo === 1) return `#${lo} ${tree.lines[lo]!.at} ${clipBytes(tree.lines[lo]!.text, LINE_BYTES)}`;
	const summary = tree.blocks[blockKey([lo, hi])];
	if (summary !== undefined) return `#${lo}-${hi - 1} ${clipBytes(summary, LINE_BYTES)}`;
	return tree.lines.slice(lo, hi).map((line, i) => `#${lo + i} ${line.at} ${clipBytes(line.text, LINE_BYTES)}`).join("\n");
}

function wake(tree: Tree, upTo = tree.lines.length): string {
	return cover(upTo, WAKE_LINES).map((block) => render(tree, block)).join("\n");
}

function zoom(tree: Tree, block: Block): string {
	const parts = halves(block);
	if (parts === undefined) return render(tree, block);
	return parts.filter(([lo]) => lo < tree.lines.length).map((part) => render(tree, part)).join("\n");
}

function parseBlock(id: string): Block {
	const match = /^#?(\d+)-(\d+)$/.exec(id.trim());
	if (match === null) throw new Error(`Not a block id: ${id}. Use lo-hi as the view prints it, like 0-7.`);
	const lo = Number(match[1]);
	const hi = Number(match[2]) + 1;
	const size = hi - lo;
	if (size < 2 || (size & (size - 1)) !== 0 || lo % size !== 0) throw new Error(`${id} is not a block. Blocks are aligned powers of two, like 0-7 or 8-15.`);
	return [lo, hi];
}

/** Every line `merge()` makes fits in this many bytes of UTF-8; a turn line longer than this goes through `merge()`. */
export const LINE_BYTES = 512;
const MERGE_TRIES = 3;
const TOOL_ARGS_CHARS = 120;
const TOOL_RESULT_CHARS = 160;

/** A ruler, not a sample line: a sample's content gets copied into the answer. */
const RULER = "-".repeat(LINE_BYTES);

const MERGE_SYSTEM =
	`Merge the input into one line of at most ${LINE_BYTES} bytes (about 70 words), the length of this ruler:\n${RULER}\n` +
	"Keep what has lasting effect: rules, preferences, facts about people and projects. " +
	"Invent nothing; keep names, dates, numbers, ids, decisions, promises, what was sent or submitted. " +
	"Drop what does not last. Answer with the one line only.";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** The longest head of `text` that fits in `max` bytes of UTF-8, cut on a character boundary. */
export function clipBytes(text: string, max: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= max) return text;
	let end = max;
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

function clipChars(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function tooLong(line: string): string {
	return (
		`Too long: your last line was ${bytes(line)} bytes, over the ${LINE_BYTES}-byte limit. ` +
		`Write the whole line again, cutting just enough of the least valuable items to fit before this cut:\n${clipBytes(line, LINE_BYTES)}| ← LIMIT`
	);
}

/** The source a block's summary is made from: its raw lines while small, else its two halves' summaries. */
function mergeInput(tree: Tree, block: Block): string | undefined {
	const [lo, hi] = block;
	if (hi - lo <= RAW_MAX) return tree.lines.slice(lo, hi).map((line, i) => `#${lo + i} ${line.at} ${line.text}`).join("\n");
	const parts = halves(block)!;
	const texts = parts.map((part) => tree.blocks[blockKey(part)]);
	if (texts.some((text) => text === undefined)) return undefined;
	return parts.map((part, i) => `#${part[0]}-${part[1] - 1} ${texts[i]}`).join("\n");
}

/**
 * One line of at most `LINE_BYTES` bytes. An answer too long is asked again with its size and where the limit cuts it,
 * `MERGE_TRIES` answers in total, and the shortest is kept; one still too long is clipped.
 */
export async function merge(fast: FastCompletion, input: string, context: Context): Promise<string> {
	let shortest: string | undefined;
	let prompt = input;
	for (let attempt = 0; attempt < MERGE_TRIES; attempt++) {
		const line = oneLine(await fast({ system: MERGE_SYSTEM, prompt }, context));
		if (shortest === undefined || bytes(line) < bytes(shortest)) shortest = line;
		if (bytes(line) <= LINE_BYTES) break;
		prompt = `${input}\n\n${tooLong(line)}`;
	}
	return clipBytes(shortest!, LINE_BYTES);
}

/** A tool call in short form: its name and key arguments; for codemode, the script's head and the tools it calls. */
function toolCallLine(name: string, args: Record<string, unknown>): string {
	if (name === "codemode" && typeof args.code === "string") {
		const calls: string[] = [];
		for (const match of args.code.matchAll(/tools\.([A-Za-z_$][\w$]*)\s*\(/g)) {
			const call = `tools.${match[1]}(`;
			if (!calls.includes(call)) calls.push(call);
		}
		const head = clipChars(oneLine(args.code), TOOL_ARGS_CHARS);
		return calls.length === 0 ? `codemode(${head})` : `codemode(${head}) calls ${calls.join(" ")}`;
	}
	const pairs: string[] = [];
	for (const [key, value] of Object.entries(args)) pairs.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
	return `${name}(${clipChars(oneLine(pairs.join(", ")), TOOL_ARGS_CHARS)})`;
}

/** The turn's words and what was done in it: the owner's text, mochi's text, each tool call and the head of its result. */
export function turnLine(entries: readonly EntryRecord[]): string | undefined {
	const parts: string[] = [];
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (message === undefined) continue;
		const text = oneLine(messageText(message));
		if (UserEntry.is(entry)) {
			if (text !== "") parts.push(`owner: ${text}`);
		} else if (AssistantEntry.is(entry) && message.role === "assistant") {
			if (text !== "") parts.push(`mochi: ${text}`);
			for (const part of message.content) {
				if (part.type === "toolCall") parts.push(`tool ${toolCallLine(part.name, part.arguments)}`);
			}
		} else if (ToolResultEntry.is(entry) && message.role === "toolResult") {
			const head = clipChars(text, TOOL_RESULT_CHARS);
			parts.push(`${message.toolName} ${message.isError ? "error" : "result"}: ${head === "" ? "(no text)" : head}`);
		}
	}
	return parts.length === 0 ? undefined : parts.join(" | ");
}

const stamp = (message: Message | undefined): string => new Date(message?.timestamp ?? Date.now()).toISOString().slice(0, 16).replace("T", " ");

/**
 * Folds every turn committed after `upTo` into the conversation's turn log, one line per user message and what
 * followed it. Turns are digested by the fast model, so a long turn is one line too.
 */
async function foldTurns(harness: Harness, fast: FastCompletion, conversation: ConversationId, context: Context): Promise<void> {
	const log = (await harness.snapshot(TurnLog, conversation, context)) ?? { ...empty(), upTo: 0 };
	const fresh = await harness.commit(async (tx) => {
		const found: EntryRecord[] = [];
		let cursor;
		do {
			const page = await tx.scanEntries({ conversationId: conversation, minEntryId: (log.upTo + 1) as EntryRecord["id"] }, 200, cursor);
			found.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		return found.reverse();
	}, context);
	const turns: EntryRecord[][] = [];
	for (const entry of fresh) {
		if (UserEntry.is(entry) || turns.length === 0) turns.push([]);
		turns.at(-1)!.push(entry);
	}
	const busy = (await harness.snapshot(LiveDoc, conversation, context))?.run !== undefined;
	if (busy) turns.pop();
	for (const turn of turns) {
		const raw = turnLine(turn);
		const upTo = turn.at(-1)!.id;
		const line = raw === undefined ? undefined : bytes(raw) <= LINE_BYTES ? raw : await merge(fast, raw, context);
		await harness.commit(async (tx) => {
			const doc = await tx.doc(TurnLog, conversation);
			if (doc.upTo >= upTo) return;
			if (line !== undefined) doc.lines.push({ at: stamp(turn[0]!.model?.[0]), text: line, from: turn[0]!.id });
			(doc as { upTo: number }).upTo = upTo;
		}, context);
	}
}

/**
 * A trigger run starts each run from a reset and a fork lives for one task, so neither ever compacts a long history;
 * only the conversations that do get a turn log.
 */
async function keepsHistory(harness: Harness, conversation: ConversationId, context: Context): Promise<boolean> {
	const record = await harness.commit((tx) => tx.conversation(conversation), context);
	if (record?.owner !== undefined) return false;
	const extensions = (await harness.snapshot(AgentDoc, conversation, context))?.extensions;
	return !(Array.isArray(extensions) && extensions.includes("seat-trigger"));
}

/**
 * Builds every block that is due, smallest first, one commit each, so a crash resumes at the next missing block. A summary
 * over `LINE_BYTES`, written before that limit, counts as missing and is written again.
 */
async function buildBlocks(read: () => Promise<Tree>, write: (key: string, summary: string) => Promise<void>, fast: FastCompletion, context: Context): Promise<void> {
	for (;;) {
		const tree = await read();
		const built = (block: Block): boolean => {
			const summary = tree.blocks[blockKey(block)];
			return summary !== undefined && bytes(summary) <= LINE_BYTES;
		};
		const next = pending(tree.lines.length, built)[0];
		if (next === undefined) return;
		const input = mergeInput(tree, next);
		if (input === undefined) return;
		await write(blockKey(next), await merge(fast, input, context));
	}
}

/** Copies the notes of the retired note document into the memory log once, oldest first. */
export async function importOldNotes(tx: Tx): Promise<void> {
	const log = await tx.doc(MemoryLog);
	if (log.lines.length > 0) return;
	const old = await tx.doc(OldMemoryDoc, ROOT_CONVERSATION_ID);
	const notes = Object.values(old.notes).sort((a, b) => a.updated.localeCompare(b.updated));
	for (const note of notes) log.lines.push({ at: note.updated, text: `${note.subject} (${note.kind}): ${note.body.replace(/\s+/g, " ").trim()}` });
}

/** One pass over memory: fold new turns, then build due blocks in every memory log. The feed runs it after commits. */
export async function maintain(harness: Harness, fast: FastCompletion, owners: readonly Owner[], conversations: readonly ConversationId[], context: Context): Promise<void> {
	for (const owner of owners) {
		await buildBlocks(
			() => readTree(harness, owner, context),
			(key, summary) => harness.commit(async (tx) => void ((await writeTree(tx, owner)).blocks[key] = summary), context),
			fast,
			context,
		);
	}
	for (const conversation of conversations) {
		if (!(await keepsHistory(harness, conversation, context))) continue;
		await foldTurns(harness, fast, conversation, context);
		await buildBlocks(
			async () => (await harness.snapshot(TurnLog, conversation, context)) ?? empty(),
			(key, summary) => harness.commit(async (tx) => void ((await tx.doc(TurnLog, conversation)).blocks[key] = summary), context),
			fast,
			context,
		);
	}
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/** Whose memory the conversation uses, read in a commit. */
type OwnerOf = (tx: Tx, conversation: ConversationId) => Promise<Owner>;

export function noteTool(index: SearchIndex, ownerOf: OwnerOf) {
	return defineTool({
		name: "note",
		description:
			"Keep one line in memory for good: a fact about the owner, their people or projects, a preference, a standing rule, a decision, " +
			"or an event of lasting effect. New conversations see it in the memory section; this one sees it from the next compaction. Do not repeat what memory already holds.",
		parameters: Type.Object({ line: Type.String({ minLength: 1 }) }),
		replay: "safe",
		execute: async ({ line }, api, context) => {
			const at = new Date().toISOString().slice(0, 10);
			const one = line.replace(/\s+/g, " ").trim();
			let position = await api.memo<number>("note.position", context);
			if (position === undefined) {
				const appended = await api.commit(async (tx) => {
					const log = await writeTree(tx, await ownerOf(tx, api.conversationId));
					log.lines.push({ at, text: one });
					return log.lines.length - 1;
				}, context);
				position = await api.memo("note.position", appended, context);
			}
			if ((await api.commit((tx) => ownerOf(tx, api.conversationId), context)) === "root") index.addMemory(position, at, one);
			return text(`Kept as #${position}.`);
		},
	});
}

export function zoomTool(ownerOf: OwnerOf) {
	return defineTool({
		name: "zoom",
		description: "Open one block of memory, or of this conversation's earlier turns, into its two halves, down to the raw lines. Pass the id as the view prints it, like 0-7. In a profile, own: true opens a block of the profile's own memory.",
		parameters: Type.Object({ block: Type.String(), turns: Type.Optional(Type.Boolean()), own: Type.Optional(Type.Boolean()) }),
		replay: "safe",
		execute: async (args, api, context) => {
			const block = parseBlock(args.block);
			const owner = await api.commit((tx) => ownerOf(tx, api.conversationId), context);
			const tree = args.turns === true ? await api.snapshot(TurnLog, api.conversationId, context) : await readTree(api, args.own === true ? owner : "root", context);
			if (tree === undefined || block[0] >= tree.lines.length) throw new Error(`#${args.block} is past the end of the log.`);
			return text(zoom(tree, block));
		},
	});
}

export function recallTool(index: SearchIndex) {
	return defineTool({
		name: "recall",
		description:
			"Search memory and past chats by words, the owner's chat first. Search before you say the owner never told you something. " +
			"Pass entry instead of query to read the messages around one chat hit.",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			entry: Type.Optional(Type.Integer({ minimum: 1 })),
			after: Type.Optional(Type.String()),
			before: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			if (args.entry !== undefined) {
				const rows = index.scroll(args.entry, 5);
				if (rows === undefined) throw new Error(`Entry ${args.entry} is not in the chat index.`);
				return text(rows.map((row) => `--- entry ${row.ref} ${row.kind} ${row.at}\n${row.text}`).join("\n"));
			}
			if (args.query === undefined) throw new Error("Pass query or entry.");
			const marker = await api.commit((tx) => tx.latestHeadMarker(api.conversationId), context);
			const hits = index.search({
				query: args.query,
				limit: args.limit ?? 10,
				hidden: { conversation: api.conversationId, fromEntry: marker?.head ?? 0 },
				...(args.after === undefined ? {} : { after: args.after }),
				...(args.before === undefined ? {} : { before: args.before }),
			});
			const lines = hits.map((hit) => (hit.kind === "memory" ? `${hit.at} memory ${hit.ref}: ${hit.snippet}` : `${hit.at} ${hit.kind} entry ${hit.ref}: ${hit.snippet}`));
			return text(lines.length === 0 ? "No matches." : lines.join("\n"));
		},
	});
}

export function historyTool(index: SearchIndex) {
	return defineTool({
		name: "history",
		description:
			"Past chat as rows { at, kind, entry, conversation, text }, oldest first, for a script to filter, chunk and hand to llm; " +
			"print only the result. after/before are ISO times. everywhere also reads trigger and agent runs. Page with after.",
		parameters: Type.Object({
			after: Type.Optional(Type.String()),
			before: Type.Optional(Type.String()),
			everywhere: Type.Optional(Type.Boolean()),
			limit: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
		structuredOutputSchema: Type.Array(Type.Object({ at: Type.String(), kind: Type.String(), entry: Type.Integer(), conversation: Type.Integer(), text: Type.String() })),
		replay: "safe",
		execute: async (args) => {
			const rows = index.range({ ...(args.after === undefined ? {} : { after: args.after }), ...(args.before === undefined ? {} : { before: args.before }), everywhere: args.everywhere ?? false, limit: args.limit ?? 2000 });
			return { structuredOutput: rows.map((row) => ({ at: row.at, kind: row.kind, entry: Number(row.ref), conversation: row.conversation, text: row.text })) };
		},
	});
}

/**
 * Root's memory holds the owner's rules and facts, so every conversation sees it. A profile sees its own log after it;
 * its `note` calls write there.
 */
async function renderMemory(read: MemoryReader, owner: Owner, context: Context): Promise<string> {
	const root = wake(await readTree(read, "root", context)) || "Nothing kept yet. Keep the first line with tools.note.";
	if (owner === "root") return root;
	const own = wake(await readTree(read, owner, context)) || "Nothing kept yet.";
	return `${root}\n\n## ${owner.profile}'s own memory\n${own}`;
}

/**
 * The memory section: the wake view of the memory log. It always renders, so the section set never changes. While the
 * log only grows, the section stays as shown until a compaction or reset drops it: a fresh copy after each note would add
 * the whole section to the transcript again. A rewritten log, whose first line changed, shows at once. The extension
 * keeps the name the stored conversations already select.
 */
export function memoryExtension(ownerOf: (read: DocumentReader, conversation: ConversationId, context: Context) => Promise<Owner>): Extension {
	return defineExtension({
		name: "notes",
		sections: [
			section("memory", async (input, context) => {
				const fresh = await renderMemory(input.read, await ownerOf(input.read, input.conversationId, context), context);
				const shown = input.shown.memory?.slice("<memory>\n".length, -"\n</memory>".length);
				const firstLine = fresh.split("\n", 1)[0]!;
				return shown?.startsWith(firstLine) ? shown : fresh;
			}),
		],
	});
}

/**
 * Compaction keeps the newest turns verbatim and replaces the rest with the cover of this conversation's turn log, up to
 * the first kept entry. Blocks the feed has not built yet show as raw lines, so compaction never waits on a model. When
 * the feed has not folded every replaced turn yet, the hook declines, and pi-durable's own summary covers the gap.
 */
export function windowExtension(): Extension {
	return defineExtension({
		name: "fast-compaction",
		hooks: [hook(CompactionTask, {
			beforeCompact: async (input, api, context) => {
				const log = await api.snapshot(TurnLog, api.conversationId, context);
				if (log === undefined || log.upTo < input.firstKept - 1) return undefined;
				let replaced = 0;
				while (replaced < log.lines.length && (log.lines[replaced]!.from ?? 0) < input.firstKept) replaced++;
				if (replaced === 0) return undefined;
				const view = wake(log, replaced);
				return { summary: `Earlier turns of this conversation, oldest first. Each #lo-hi line merges turns; open one with tools.zoom({ block, turns: true }).\n${view}` };
			},
		})],
	});
}

