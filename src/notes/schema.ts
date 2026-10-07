import { type Static, Type } from "typebox";

export const NoteKindSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("rule"),
	Type.Literal("fact"),
	Type.Literal("person"),
	Type.Literal("project"),
	Type.Literal("preference"),
]);
export type NoteKind = Static<typeof NoteKindSchema>;

/** Kinds whose bodies render in every system prompt, under one shared character cap. */
export const OWNER_KINDS: ReadonlySet<NoteKind> = new Set(["user", "rule"]);
export const OWNER_CAP_CHARS = 4000;

export const SlugSchema = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 80 });

/** What a writer supplies; `writeNote` checks every draft against it, whichever caller it came from. */
export const NoteDraftSchema = Type.Object(
	{ slug: SlugSchema, kind: NoteKindSchema, subject: Type.String({ minLength: 1, maxLength: 200 }), body: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
export type NoteDraft = Static<typeof NoteDraftSchema>;

/** The transcript entry a note was written from: the assistant entry whose tool call wrote it. */
export type NoteSource = { conversation: number; entry: number };

export type Note = {
	slug: string;
	kind: NoteKind;
	subject: string;
	writtenBy: "owner" | "mochi";
	/** Absent for a note imported from a file. */
	source?: NoteSource;
	/** ISO date of the last write. */
	updated: string;
	body: string;
};
