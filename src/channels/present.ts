import { Lexer, type Token } from "marked";
import type { Bubble, ChannelProfile } from "./types.ts";

const URL_ONLY = /^https?:\/\/\S+$/;

/** U+200D and U+200C are content in emoji sequences and in Devanagari, Malayalam and Persian, so only these blanks are stripped. */
const TRUE_BLANKS = /[\u200B\uFEFF\u2060]/gu;

/** True when the text opens a quotation it does not close, such as the first paragraph of a quoted draft. */
function opensQuote(text: string): boolean {
	const straight = text.split('"').length - 1;
	const opening = text.split("\u201C").length - 1;
	const closing = text.split("\u201D").length - 1;
	return straight % 2 === 1 || opening > closing;
}

/**
 * The bubbles of a markdown text: one per paragraph, code block, heading, quote or list. A whole list is one bubble, and
 * a paragraph that ends with a colon stays with the list after it. A quotation that spans paragraphs, such as a draft,
 * is one bubble.
 */
function groups(tokens: readonly Token[]): string[] {
	const out: string[] = [];
	let open = "";
	let joinNextList = false;
	for (const token of tokens) {
		if (token.type === "space") continue;
		const text = token.raw.trim();
		if (text === "") continue;
		if (open !== "") {
			open = `${open}\n\n${text}`;
			if (!opensQuote(open)) {
				out.push(open);
				open = "";
			}
			continue;
		}
		if (token.type === "list" && joinNextList) {
			out[out.length - 1] = `${out[out.length - 1]}\n${text}`;
			joinNextList = false;
			continue;
		}
		joinNextList = token.type === "paragraph" && text.endsWith(":");
		if (opensQuote(text)) {
			open = text;
			continue;
		}
		out.push(text);
	}
	if (open !== "") out.push(open);
	return out;
}

/** The bubbles of `text`, as marked parses CommonMark and GFM. */
export function blocks(text: string): string[] {
	return groups(Lexer.lex(text));
}

/** The bubbles of a partial answer that a later bubble has closed; the last one may still grow. */
export function closedBlocks(text: string): string[] {
	const all = blocks(text);
	all.pop();
	return all;
}

export function present(text: string, profile: ChannelProfile): readonly Bubble[] {
	const body = text.replace(TRUE_BLANKS, "").trim();
	if (body === "") return [];
	const pieces = profile.paragraphsAreBubbles ? blocks(body) : [body];
	const kept = pieces.length > profile.maxBubbles ? [...pieces.slice(0, profile.maxBubbles - 1), pieces.slice(profile.maxBubbles - 1).join("\n\n")] : pieces;
	return kept.map((piece): Bubble => (URL_ONLY.test(piece) ? { kind: "link", url: piece } : { kind: "text", text: piece }));
}
