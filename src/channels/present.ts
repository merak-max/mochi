import { Lexer, type Token } from "marked";
import type { Bubble, ChannelProfile } from "./types.ts";

const URL_ONLY = /^https?:\/\/\S+$/;

/** U+200D and U+200C are content in emoji sequences and in Devanagari, Malayalam and Persian, so only these blanks are stripped. */
const TRUE_BLANKS = /[​﻿⁠]/gu;

/** A markdown block's own text: one per paragraph, code block, heading or quote, and one per list item. */
function blockTexts(tokens: readonly Token[]): string[] {
	const out: string[] = [];
	for (const token of tokens) {
		if (token.type === "space") continue;
		if (token.type === "list") {
			for (const item of token.items) out.push(item.raw.trim());
			continue;
		}
		const text = token.raw.trim();
		if (text !== "") out.push(text);
	}
	return out;
}

/** The blocks of `text`, as marked parses CommonMark and GFM. */
export function blocks(text: string): string[] {
	return blockTexts(Lexer.lex(text));
}

/** The blocks of a partial answer that a later block has closed; the last one may still grow. */
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
