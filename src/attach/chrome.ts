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

export function splash(facts: () => SplashFacts, theme: Theme): Component {
	const mark = MARK.map((row) => markRow(row, theme));
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

