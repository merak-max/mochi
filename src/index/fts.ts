import { DatabaseSync } from "node:sqlite";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Note } from "../notes/schema.ts";

type DocKind = "user" | "assistant" | "note";

export interface IndexDoc {
	readonly text: string;
	readonly kind: DocKind;
	/** Entry id for chat text, `note:<slug>` for notes. */
	readonly ref: string;
	readonly at: string;
}

interface SearchQuery {
	readonly query: string;
	readonly after?: string;
	readonly before?: string;
	readonly limit: number;
	/** Chat entries the caller already sees: this conversation's entries from `fromEntry` on are left out. */
	readonly hidden?: { readonly conversation: number; readonly fromEntry: number };
}

export interface SearchHit {
	readonly kind: DocKind;
	readonly ref: string;
	readonly conversation: number | null;
	readonly at: string;
	readonly snippet: string;
}

interface ScrollRow {
	readonly kind: DocKind;
	readonly ref: string;
	readonly at: string;
	readonly text: string;
}

/** FTS5 over notes and chat text. Disposable: deleting the file and reindexing reproduces it. */
export class SearchIndex {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		this.#db = new DatabaseSync(path);
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
				text, kind UNINDEXED, ref UNINDEXED, conversation UNINDEXED, at UNINDEXED,
				tokenize = 'porter unicode61'
			);
			CREATE TABLE IF NOT EXISTS cursors (conversation INTEGER PRIMARY KEY, entry INTEGER NOT NULL);
		`);
	}

	addEntries(conversation: number, docs: readonly IndexDoc[], cursor: number): void {
		const insert = this.#db.prepare("INSERT INTO docs (text, kind, ref, conversation, at) VALUES (?, ?, ?, ?, ?)");
		this.#transaction(() => {
			for (const doc of docs) insert.run(doc.text, doc.kind, doc.ref, conversation, doc.at);
			this.#db
				.prepare("INSERT INTO cursors (conversation, entry) VALUES (?, ?) ON CONFLICT DO UPDATE SET entry = excluded.entry")
				.run(conversation, cursor);
		});
	}

	cursor(conversation: number): number {
		const row = this.#db.prepare("SELECT entry FROM cursors WHERE conversation = ?").get(conversation);
		return typeof row?.entry === "number" ? row.entry : 0;
	}

	replaceNotes(notes: readonly Note[]): void {
		this.#transaction(() => {
			this.#db.exec("DELETE FROM docs WHERE kind = 'note'");
			const insert = this.#db.prepare("INSERT INTO docs (text, kind, ref, conversation, at) VALUES (?, 'note', ?, NULL, ?)");
			for (const note of notes) insert.run(`${note.subject} (${note.kind})\n${note.body}`, `note:${note.slug}`, note.updated);
		});
	}

	search(query: SearchQuery): SearchHit[] {
		const match = toMatchExpression(query.query);
		if (match === undefined) return [];
		const rows = this.#db
			.prepare(`
				SELECT kind, ref, conversation, at, snippet(docs, 0, '[', ']', '…', 16) AS snippet
				FROM docs
				WHERE docs MATCH ? AND at >= ? AND at <= ?
					AND NOT (kind != 'note' AND conversation = ? AND CAST(ref AS INTEGER) >= ?)
				ORDER BY (kind != 'note' AND conversation != ${ROOT_CONVERSATION_ID}), bm25(docs)
				LIMIT ?
			`)
			.all(
				match,
				query.after ?? "",
				query.before ?? "￿",
				query.hidden?.conversation ?? -1,
				query.hidden?.fromEntry ?? 0,
				query.limit,
			);
		return rows.map((row) => ({
			kind: docKind(row.kind),
			ref: String(row.ref),
			conversation: typeof row.conversation === "number" ? row.conversation : null,
			at: String(row.at),
			snippet: String(row.snippet),
		}));
	}

	/** Chat rows in time order, oldest first: the owner's chat, or every conversation's, inside `after`..`before`. */
	range(query: { readonly after?: string; readonly before?: string; readonly everywhere: boolean; readonly limit: number }): (ScrollRow & { readonly conversation: number })[] {
		const rows = this.#db
			.prepare(`
				SELECT kind, ref, at, text, conversation FROM docs
				WHERE kind != 'note' AND at >= ? AND at <= ? AND (? OR conversation = ${ROOT_CONVERSATION_ID})
				ORDER BY at, CAST(ref AS INTEGER) LIMIT ?
			`)
			.all(query.after ?? "", query.before ?? "\uffff", query.everywhere ? 1 : 0, query.limit);
		return rows.map((row) => ({ kind: docKind(row.kind), ref: String(row.ref), at: String(row.at), text: String(row.text), conversation: Number(row.conversation) }));
	}

	/** Indexed chat rows of the entry's conversation, `n` before and after it, oldest first. */
	scroll(entryId: number, n: number): ScrollRow[] | undefined {
		const anchor = this.#db.prepare("SELECT conversation FROM docs WHERE ref = ? AND kind != 'note'").get(String(entryId));
		if (anchor === undefined) return undefined;
		const window = (comparison: string, order: string) =>
			this.#db
				.prepare(`
					SELECT kind, ref, at, text FROM docs
					WHERE kind != 'note' AND conversation = ? AND CAST(ref AS INTEGER) ${comparison} ?
					ORDER BY CAST(ref AS INTEGER) ${order} LIMIT ?
				`)
				.all(anchor.conversation ?? null, entryId, n + (comparison === ">=" ? 1 : 0));
		const rows = [...window("<", "DESC").reverse(), ...window(">=", "ASC")];
		return rows.map((row) => ({ kind: docKind(row.kind), ref: String(row.ref), at: String(row.at), text: String(row.text) }));
	}

	close(): void {
		this.#db.close();
	}

	#transaction(work: () => void): void {
		this.#db.exec("BEGIN");
		try {
			work();
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}
}

function docKind(value: unknown): DocKind {
	if (value === "user" || value === "assistant" || value === "note") return value;
	throw new Error(`Unexpected index kind ${String(value)}`);
}

/** Free text to an FTS5 expression: every word quoted, any word may match, BM25 ranks. */
export function toMatchExpression(text: string): string | undefined {
	const words = text.match(/[\p{L}\p{N}_]+/gu);
	if (words === null) return undefined;
	return words.map((word) => `"${word}"`).join(" OR ");
}
