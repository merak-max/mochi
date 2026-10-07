import type { Bubble, ChannelProfile } from "./types.ts";

const SHORT_CHARS = 12;
const URL_ONLY = /^https?:\/\/\S+$/;

/**
 * Only whitespace and the true blanks U+200B, U+FEFF and U+2060. U+200D and U+200C are content in emoji sequences and
 * in Devanagari, Malayalam and Persian, so they never count as blank and are never stripped.
 */
export function stripBlanks(text: string): string {
	return text.replace(/[\u200B\uFEFF\u2060]/gu, "");
}

/**
 * The reply as bubbles, in order. Blank text gives none, so silence sends nothing.
 *
 * - Split on blank lines when `paragraphsAreBubbles`; a line that is only a URL becomes its own link bubble.
 * - Split a paragraph over `maxBubbleChars` at a sentence end, else a space, never inside a word.
 * - Merge text under 12 characters into its neighbour.
 * - Past `maxBubbles`, merge the rest into the last bubble with a blank line between.
 */
export function present(text: string, profile: ChannelProfile): readonly Bubble[] {
	const body = stripBlanks(text).trim();
	if (body === "") return [];
	const parts = profile.paragraphsAreBubbles ? body.split(/\n[ \t]*\n/).flatMap(splitLinks) : [body];
	const pieces = mergeShort(parts.map((part) => part.trim()).filter((part) => part !== "").flatMap((part) => splitLong(part, profile.maxBubbleChars)));
	const kept = pieces.length > profile.maxBubbles ? [...pieces.slice(0, profile.maxBubbles - 1), pieces.slice(profile.maxBubbles - 1).join("\n\n")] : pieces;
	return kept.map((piece): Bubble => (URL_ONLY.test(piece) ? { kind: "link", url: piece } : { kind: "text", text: piece }));
}

/** The pause before a bubble that follows another: 35 ms per character, between 400 and 2,200 ms. */
export function pace(bubble: Bubble): number {
	const chars = bubble.kind === "text" ? bubble.text.length : bubble.kind === "link" ? bubble.url.length : 0;
	return Math.min(2_200, Math.max(400, chars * 35));
}

/** A paragraph with a line that is only a URL: the text before it, the URL, the text after it. */
function splitLinks(paragraph: string): string[] {
	const out: string[] = [];
	let lines: string[] = [];
	for (const line of paragraph.split("\n")) {
		if (!URL_ONLY.test(line.trim())) {
			lines.push(line);
			continue;
		}
		out.push(lines.join("\n"), line.trim());
		lines = [];
	}
	return [...out, lines.join("\n")];
}

function splitLong(paragraph: string, max: number): string[] {
	const out: string[] = [];
	let rest = paragraph;
	while (rest.length > max) {
		const window = rest.slice(0, max);
		const sentence = Math.max(...[". ", "! ", "? ", ".\n", "!\n", "?\n"].map((end) => window.lastIndexOf(end)));
		const cut = sentence > 0 ? sentence + 1 : window.lastIndexOf(" ");
		if (cut <= 0) break;
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	return rest === "" ? out : [...out, rest];
}

function mergeShort(pieces: readonly string[]): string[] {
	const out: string[] = [];
	for (const piece of pieces) {
		const previous = out.at(-1);
		const mergeable = (value: string | undefined): value is string => value !== undefined && !URL_ONLY.test(value);
		if (mergeable(previous) && mergeable(piece) && (piece.length < SHORT_CHARS || previous.length < SHORT_CHARS)) out[out.length - 1] = `${previous}\n\n${piece}`;
		else out.push(piece);
	}
	return out;
}
