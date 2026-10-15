import { readFileSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// One daifuku: a soft dome with a flat base. The cut-out at its upper left is the highlight; "~" cells draw in the accent.
const MARK = [
	"",
	"     ▗▄▄▄▄▄▄▖",
	"  ▗▟█~▀~▜███████▙▖",
	" ▗██▙▄▄█████████▖",
	" ▐██████████████▌",
	" ▝██████████████▘",
	"",
];

export type SplashFacts = { readonly build: string; readonly model: string; readonly home: string };

/** Pre-colored rows from <home>/mark.ans, used as they are; the built-in mark when the file is absent. */
export function loadMark(homeDir: string): string[] | undefined {
	let text: string;
	try {
		text = readFileSync(`${homeDir}/mark.ans`, "utf8");
	} catch {
		return undefined;
	}
	const rows = text.replace(/\n+$/, "").split("\n");
	return rows.length === 0 ? undefined : rows;
}

function markRow(row: string, theme: Theme): string {
	let out = "";
	let accent = false;
	for (const char of row) {
		if (char === "~") {
			accent = true;
			continue;
		}
		out += theme.fg(accent ? "accent" : "text", char);
		accent = false;
	}
	return out;
}

export function splash(facts: () => SplashFacts, theme: Theme, custom?: readonly string[]): Component {
	const mark = custom ?? MARK.map((row) => markRow(row, theme));
	const markWidth = Math.max(...mark.map((row) => visibleWidth(row)));
	return {
		render(width) {
			const meta = [
				`${theme.bold(theme.fg("text", "mochi"))} ${theme.fg("muted", facts().build)}`,
				`${theme.fg("dim", "model")} ${theme.fg("muted", facts().model)}`,
				`${theme.fg("dim", "home")} ${theme.fg("muted", facts().home)}`,
			];
			const showMark = width >= markWidth + 40;
			const lines = [""];
			const rows = showMark ? mark.length : meta.length;
			const metaStart = showMark ? Math.floor((mark.length - meta.length) / 2) : 0;
			for (let index = 0; index < rows; index++) {
				let line = " ";
				if (showMark) {
					const row = mark[index] ?? "";
					line += row + "\x1b[0m" + " ".repeat(markWidth - visibleWidth(row)) + "   ";
				}
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
