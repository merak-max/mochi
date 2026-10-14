import {
	type AgentToolResult,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	highlightCode,
	rawKeyHint,
	type Theme,
	type ToolRenderers,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

const CODE_LINES = 10;
const OUTPUT_LINES = 5;
const ARGS_CHARS = 100;

type Renderers = Pick<ToolRenderers, "renderShell" | "renderCall" | "renderResult">;

export function toolRenderers(cwd: string): (name: string) => Renderers {
	const pi = Object.fromEntries(
		[createBashToolDefinition, createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition].map((create) => {
			const { name, renderShell, renderCall, renderResult } = create(cwd);
			return [name, { ...(renderShell === undefined ? {} : { renderShell }), renderCall, renderResult } as Renderers];
		}),
	);
	const own: Record<string, Renderers> = { ...pi, codemode: codeRenderers };
	return (name) => own[name] ?? compactRenderers(name);
}

function preview(text: string, max: number, expanded: boolean, theme: Theme): Component {
	if (expanded) return new Text(text, 0, 0);
	return {
		render(width) {
			const { visualLines, skippedCount } = truncateToVisualLines(text, max, width, 0, "start");
			if (skippedCount === 0) return visualLines;
			const hint = `${theme.fg("muted", `... (${skippedCount} more lines,`)} ${rawKeyHint("ctrl+o", "to expand")}${theme.fg("muted", ")")}`;
			return [...visualLines, truncateToWidth(hint, width, "...")];
		},
		invalidate() {},
	};
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.flatMap((block) => (block.type === "text" ? [block.text] : block.type === "image" ? [`[image ${block.mimeType}]`] : []))
		.join("\n")
		.replace(/\t/g, "   ")
		.trim();
}

function addOutput(component: Container, text: string, isError: boolean, expanded: boolean, theme: Theme): void {
	if (text === "") return;
	const color = isError ? "error" : "toolOutput";
	component.addChild(new Spacer(1));
	component.addChild(preview(text.split("\n").map((line) => theme.fg(color, line)).join("\n"), OUTPUT_LINES, expanded, theme));
}

const codeRenderers: Renderers = {
	renderCall(args, theme, context) {
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		component.addChild(new Text(theme.fg("toolTitle", theme.bold("codemode")), 0, 0));
		const raw = (args as { code?: unknown } | undefined)?.code;
		const code = typeof raw === "string" ? raw.replace(/\r/g, "").replace(/\t/g, "   ").trimEnd() : "";
		if (code !== "") component.addChild(preview(highlightCode(code, "javascript").join("\n"), CODE_LINES, context.expanded, theme));
		return component;
	},
	renderResult(result, options, theme, context) {
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		const text = options.isPartial ? "" : resultText(result).replace(/^Script (completed|failed)\nWall time [^\n]*\nOutput:\n\n?/, "");
		addOutput(component, text, context.isError, options.expanded, theme);
		return component;
	},
};

function compactRenderers(name: string): Renderers {
	return {
		renderCall(args: unknown, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const summary = summarize(args);
			const shown = context.expanded || summary.length <= ARGS_CHARS ? summary : `${summary.slice(0, ARGS_CHARS - 1)}…`;
			text.setText(`${theme.fg("toolTitle", theme.bold(name))}${shown === "" ? "" : ` ${theme.fg("muted", shown)}`}`);
			return text;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			addOutput(component, options.isPartial ? "" : resultText(result), context.isError, options.expanded, theme);
			return component;
		},
	};
}

function summarize(args: unknown): string {
	if (args === null || typeof args !== "object") return args === undefined ? "" : JSON.stringify(args);
	return Object.entries(args)
		.map(([key, value]) => `${key}=${typeof value === "string" ? truncateToWidth(value.replace(/\s+/g, " "), 200, "…") : JSON.stringify(value)}`)
		.join(" ");
}
