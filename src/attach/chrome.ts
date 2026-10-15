import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Three dango on a skewer. "~" cells draw in the accent, so the top ball reads as the pink one.
const MARK = [
	"            ▗~~~▖",
	"           ▐~~~~~▌",
	"       ▗▄▄▖ ▝~~~▘",
	"      ▐████▌ ╱",
	"  ▗▄▄▖ ▝▀▀▘╱",
	" ▐████▌  ╱",
	"  ▝▀▀▘ ╱",
];
const MARK_WIDTH = Math.max(...MARK.map((row) => row.length));

export type SplashFacts = { readonly build: string; readonly model: string; readonly home: string };

function markRow(row: string, theme: Theme): string {
	let out = "";
	for (const char of row) {
		if (char === "~") out += theme.fg("accent", "█");
		else if (char === "╱") out += theme.fg("dim", char);
		else out += theme.fg("text", char);
	}
	return out;
}

export function splash(facts: () => SplashFacts, theme: Theme): Component {
	return {
		render(width) {
			const meta = [
				`${theme.bold(theme.fg("text", "mochi"))} ${theme.fg("muted", facts().build)}`,
				`${theme.fg("dim", "model")} ${theme.fg("muted", facts().model)}`,
				`${theme.fg("dim", "home")} ${theme.fg("muted", facts().home)}`,
			];
			const showMark = width >= 70;
			const lines = [""];
			const rows = showMark ? MARK.length : meta.length;
			const metaStart = showMark ? Math.floor((MARK.length - meta.length) / 2) : 0;
			for (let index = 0; index < rows; index++) {
				let line = " ";
				if (showMark) line += markRow((MARK[index] ?? "").padEnd(MARK_WIDTH), theme) + "   ";
				line += meta[index - metaStart] ?? "";
				lines.push(truncateToWidth(line, width, ""));
			}
			lines.push("");
			return lines;
		},
		invalidate() {},
	};
}

export function centered(text: string, width: number): string {
	const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
	return truncateToWidth(" ".repeat(pad) + text, width, "");
}

export function spread(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2);
	return truncateToWidth(` ${left}${" ".repeat(gap)}${right} `, width, "");
}

/** Splits "[cli 2026-10-15 23:52 IST id=x]" off the front of an inbound user message. */
export function splitTag(text: string): { readonly body: string; readonly meta: string | undefined } {
	const match = /^\[([a-z-]+) (\d{4}-\d\d-\d\d \d\d:\d\d)[^\]]*\]\s*/.exec(text);
	if (match === null) return { body: text, meta: undefined };
	return { body: text.slice(match[0].length), meta: `${match[1]} · ${match[2]}` };
}
