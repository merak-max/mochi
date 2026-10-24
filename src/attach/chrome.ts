import { readFileSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** "~" before a cell draws it in the accent. */
const MARK = [
	"",
	"          ______",
	"         /      \\",
	"  ______/   ~(~)   \\______",
	" /      \\        /      \\",
	"/   ~(~)   \\______/   ~(~)   \\",
	"\\        /      \\        /",
	" \\______/        \\______/",
	"",
];

type SplashFacts = { readonly build: string; readonly pid: number; readonly home: string };

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

/** Pre-colored rows from <home>/mark.ans, used as they are; undefined when the file is absent. */
export function loadMark(home: string): string[] | undefined {
	let text: string;
	try {
		text = readFileSync(`${home}/mark.ans`, "utf8");
	} catch {
		return undefined;
	}
	return text.replace(/\n+$/, "").split("\n");
}

export function splash(facts: () => SplashFacts, theme: Theme, custom?: readonly string[]): Component {
	const mark = custom ?? MARK.map((row) => markRow(row, theme));
	const markWidth = Math.max(...mark.map((row) => visibleWidth(row)));
	return {
		render(width) {
			const meta = [
				`${theme.bold(theme.fg("text", "mochi"))} ${theme.fg("muted", facts().build)}`,
				`${theme.fg("dim", "pid")} ${theme.fg("muted", String(facts().pid))}`,
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

export function spread(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2);
	return truncateToWidth(` ${left}${" ".repeat(gap)}${right} `, width, "");
}

