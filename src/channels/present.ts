import type { Bubble, ChannelProfile } from "./types.ts";

const SHORT_CHARS = 12;
const URL_ONLY = /^https?:\/\/\S+$/;

/** U+200D and U+200C are content in emoji sequences and in Devanagari, Malayalam and Persian, so only these blanks are stripped. */
const TRUE_BLANKS = /[\u200B\uFEFF\u2060]/gu;

export function present(text: string, profile: ChannelProfile): readonly Bubble[] {
	const body = text.replace(TRUE_BLANKS, "").trim();
	if (body === "") return [];
	const parts = profile.paragraphsAreBubbles ? body.split(/\n[ \t]*\n/).flatMap(splitLinks) : [body];
	const pieces = mergeShort(parts.map((part) => part.trim()).filter((part) => part !== "").flatMap((part) => splitLong(part, profile.maxBubbleChars)));
	const kept = pieces.length > profile.maxBubbles ? [...pieces.slice(0, profile.maxBubbles - 1), pieces.slice(profile.maxBubbles - 1).join("\n\n")] : pieces;
	return kept.map((piece): Bubble => (URL_ONLY.test(piece) ? { kind: "link", url: piece } : { kind: "text", text: piece }));
}

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
		const bothText = previous !== undefined && !URL_ONLY.test(previous) && !URL_ONLY.test(piece);
		if (bothText && (piece.length < SHORT_CHARS || previous.length < SHORT_CHARS)) out[out.length - 1] = `${previous}\n\n${piece}`;
		else out.push(piece);
	}
	return out;
}
