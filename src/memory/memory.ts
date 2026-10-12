import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	type Cursor,
	type DocumentReader,
	defineDoc,
	defineExtension,
	defineTool,
	type EntryRecord,
	type Extension,
	type Harness,
	ROOT_CONVERSATION_ID,
	section,
	type ToolExecutionApi,
	type ToolTaskInput,
	type Tx,
} from "@earendil-works/pi-durable";
import type { SearchIndex } from "../index/fts.ts";
import { type Note, type NoteDraft, NoteDraftSchema, NoteKindSchema, OWNER_CAP_CHARS, OWNER_KINDS, SlugSchema } from "../notes/schema.ts";
import { type Env, findSecret, secretRejection } from "../notes/secrets.ts";
import { parseWith } from "../parse.ts";
import { memoryChanged, replayed, RepoDoc } from "./publication.ts";

/**
 * The owner's memory: one rewindable document on the root conversation that every conversation writes through. A write
 * commits with its source entry id, `snapshotAsOf` reads what mochi believed when any root entry was written, and the
 * prompt renders it live (pi-durable sends only a changed section, which keeps the provider cache).
 */
export type Memory = { notes: Record<string, Note> };

export const MemoryDoc = defineDoc<Memory>({
	kind: "mochi.memory",
	version: 2,
	scope: "conversation",
	history: "rewindable",
	fork: "current",
	initial: () => ({ notes: {} }),
	/** v1 also carried `imported`, the hashes of the `data/notes` files it had read. */
	migrate: (value) => ({ notes: (value.notes ?? {}) as Memory["notes"] }),
});

/** A section that appears and disappears makes pi-durable re-add every section, so both always render. */
export const OWNER_EMPTY = "no user note yet";
export const INDEX_EMPTY = "no other notes yet";

const MAX_ROW_CHARS = 2000;

/** Committed reads plus a read-only commit for scanning entries; a Harness and a tool api both fit. */
export type MemoryReader = DocumentReader & Pick<Harness, "commit">;

export async function readMemory(read: DocumentReader, context: Context): Promise<Memory> {
	return (await read.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context)) ?? MemoryDoc.definition.initial();
}

/** Memory as of `date` (ISO date or timestamp): the document when the newest root entry at or before it committed. */
export async function memoryAsOf(harness: MemoryReader, date: string, context: Context): Promise<Memory> {
	const at = Date.parse(date.length === 10 ? `${date}T23:59:59.999Z` : date);
	if (Number.isNaN(at)) throw new Error(`Not a date: ${date}.`);
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 200, cursor), context);
		const entry = page.items.find((candidate) => entryTime(candidate) <= at);
		if (entry !== undefined) return (await harness.snapshotAsOf(MemoryDoc, ROOT_CONVERSATION_ID, entry.id, context)) ?? MemoryDoc.definition.initial();
		cursor = page.next;
	} while (cursor !== undefined);
	return MemoryDoc.definition.initial();
}

const entryTime = (entry: EntryRecord): number =>
	entry.kind === "mochi.memory-change" && entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data) && typeof entry.data?.at === "number"
		? entry.data.at : entry.model?.[0]?.timestamp ?? Number.POSITIVE_INFINITY;

export function sortedNotes(memory: Memory): Note[] {
	return Object.values(memory.notes).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Create or replace a note as mochi. Owner notes are read-only, and owner-kind bodies share one cap. */
export async function writeNote(tx: Tx, input: NoteDraft, source: Note["source"], today: string, key?: string): Promise<Note> {
	const receipt = await replayed(tx, key);
	if (receipt?.note != null) return { ...receipt.note };
	const draft = parseWith(NoteDraftSchema, { slug: input.slug, kind: input.kind, subject: input.subject, body: input.body }, "note");
	const secret = findSecret(`${draft.subject}\n${draft.body}`, process.env);
	if (secret !== undefined) throw new Error(secretRejection(secret));
	const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
	const existing = Object.hasOwn(memory.notes, draft.slug) ? memory.notes[draft.slug] : undefined;
	if (existing?.writtenBy === "owner") throw new Error(`Note "${draft.slug}" was written by the owner and cannot be edited by mochi.`);
	if (OWNER_KINDS.has(draft.kind)) {
		const total = Object.values(memory.notes)
			.filter((other) => other.slug !== draft.slug && OWNER_KINDS.has(other.kind))
			.reduce((sum, other) => sum + other.body.length, draft.body.length);
		if (total > OWNER_CAP_CHARS) {
			throw new Error(
				`user and rule notes would total ${total} characters, over the ${OWNER_CAP_CHARS} cap. ` +
					"Consolidate or shorten existing user/rule notes first, or store this as another kind.",
			);
		}
	}
	const note: Note = { ...draft, body: draft.body.trim(), writtenBy: "mochi", updated: today, ...(source === undefined ? {} : { source }) };
	memory.notes[note.slug] = note;
	await memoryChanged(tx, memory, note, key);
	return note;
}

/** Remove a note mochi wrote; owner notes stay. Undefined when there was none. */
export async function forgetNote(tx: Tx, slug: string, key?: string): Promise<Note | undefined> {
	const receipt = await replayed(tx, key);
	if (receipt !== undefined) return receipt.note === null ? undefined : { ...receipt.note };
	const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
	const existing = Object.hasOwn(memory.notes, slug) ? memory.notes[slug] : undefined;
	if (existing?.writtenBy === "owner") throw new Error(`Note "${slug}" was written by the owner and cannot be removed by mochi.`);
	delete memory.notes[slug];
	if (existing !== undefined || key !== undefined) await memoryChanged(tx, memory, existing, key);
	return existing;
}

/** The assistant entry whose tool call is running: this call's, or for a script's call, its codemode call's. */
async function sourceOf(api: Pick<ToolExecutionApi, "getTask" | "taskId" | "conversationId">, context: Context): Promise<Note["source"]> {
	let input = (await api.getTask(api.taskId, context))?.input as ToolTaskInput | undefined;
	if (input?.kind === "nested") input = (await api.getTask(input.parent, context))?.input as ToolTaskInput | undefined;
	if (input?.kind !== "model") return undefined;
	return { conversation: api.conversationId, entry: input.assistant };
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

export function noteTool(deps: { readonly index: SearchIndex; readonly today: () => string; readonly env?: Env }) {
	const { index, today, env = process.env } = deps;
	return defineTool({
		name: "note",
		description:
			"Save a lasting fact about the owner, their people, projects, preferences or standing rules. The note shows in your " +
			"prompt from the next request. user and rule notes are always visible and share 4,000 characters, so merge them " +
			"before you add one. An empty body forgets a note you wrote. Never store a credential.",
		parameters: Type.Object({ slug: SlugSchema, kind: NoteKindSchema, subject: Type.String({ maxLength: 200 }), body: Type.String({ maxLength: 4000 }) }),
		replay: "safe",
		execute: async (args, api, context) => {
			if (args.body.trim() === "") {
				const gone = await api.commit((tx) => forgetNote(tx, args.slug, `tool:${api.taskId}`), context);
				index.replaceNotes(sortedNotes(await readMemory(api, context)));
				const status = await publicationStatus(api, context);
				return text((gone === undefined ? `No note ${args.slug}; nothing to forget.` : `Forgot note ${args.slug}.`) + status);
			}
			const secret = findSecret(`${args.subject}\n${args.body}`, env);
			if (secret !== undefined) throw new Error(secretRejection(secret));
			const source = await sourceOf(api, context);
			const note = await api.commit((tx) => writeNote(tx, args, source, today(), `tool:${api.taskId}`), context);
			index.replaceNotes(sortedNotes(await readMemory(api, context)));
			return text(`Saved note ${note.slug}.` + await publicationStatus(api, context));
		},
	});
}

async function publicationStatus(read: DocumentReader, context: Context): Promise<string> {
	const repo = await read.snapshot(RepoDoc, context);
	if (repo?.repo == null) return "";
	return repo.queue.length === 0 ? " Durably saved; local Git published." : ` Durably saved; local Git pending (${repo.queue.length} revisions).${repo.blocked === null ? "" : ` ${repo.blocked}`}`;
}

export function recallTool(index: SearchIndex) {
	return defineTool({
		name: "recall",
		description:
			"Search past chats and notes by words, the owner's chat first. Search before you say the owner never told you " +
			"something. Pass entry instead of query to read the messages around one hit. asOf (a date) reads memory as it was on that date.",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			entry: Type.Optional(Type.Integer({ minimum: 1 })),
			after: Type.Optional(Type.String()),
			before: Type.Optional(Type.String()),
			asOf: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			if (args.entry !== undefined) {
				const rows = index.scroll(args.entry, 5);
				if (rows === undefined) throw new Error(`Entry ${args.entry} is not in the chat index.`);
				return text(rows.map((row) => `--- entry ${row.ref} ${row.kind} ${row.at}\n${clip(row.text)}`).join("\n"));
			}
			if (args.asOf !== undefined) {
				const notes = sortedNotes(await memoryAsOf(api, args.asOf, context));
				return text(notes.length === 0 ? `No notes as of ${args.asOf}.` : notes.map((note) => `${note.slug}: ${note.subject} (${note.kind})\n${note.body}`).join("\n\n"));
			}
			if (args.query === undefined) throw new Error("Pass query, entry or asOf.");
			// The caller's context runs from its newest reset or compaction head; hits it already sees are left out.
			const marker = await api.commit((tx) => tx.latestHeadMarker(api.conversationId), context);
			const hits = index.search({
				query: args.query,
				limit: args.limit ?? 10,
				hidden: { conversation: api.conversationId, fromEntry: marker?.head ?? 0 },
				...(args.after === undefined ? {} : { after: args.after }),
				...(args.before === undefined ? {} : { before: args.before }),
			});
			const notes = (await readMemory(api, context)).notes;
			const lines = hits.map((hit) => {
				if (hit.kind !== "note") return `${hit.at} ${hit.kind} entry ${hit.ref}: ${hit.snippet}`;
				const found = notes[hit.ref.slice("note:".length)];
				return found === undefined ? `${hit.at} ${hit.ref}: ${hit.snippet}` : `${hit.at} ${hit.ref}: ${found.subject} (${found.kind})\n${found.body}`;
			});
			return text(lines.length === 0 ? "No matches." : lines.join("\n"));
		},
	});
}

const clip = (value: string): string => (value.length > MAX_ROW_CHARS ? `${value.slice(0, MAX_ROW_CHARS)}…` : value);

/** `owner`: every user and rule note in full. `notes-index`: one line per other note. Sorted by slug, so equal memory renders equal bytes. */
export function notesExtension(): Extension {
	const notes = async (read: DocumentReader, context: Context, owner: boolean): Promise<Note[]> =>
		sortedNotes(await readMemory(read, context)).filter((note) => OWNER_KINDS.has(note.kind) === owner);
	return defineExtension({
		name: "notes",
		sections: [
			section("owner", async (input, context) =>
				(await notes(input.read, context, true)).map((note) => `## ${note.subject} (${note.kind})\n${note.body}`).join("\n\n") || OWNER_EMPTY,
			),
			section("notes-index", async (input, context) =>
				(await notes(input.read, context, false)).map((note) => `${note.slug}: ${note.subject} (${note.kind})`).join("\n") || INDEX_EMPTY,
			),
		],
	});
}
