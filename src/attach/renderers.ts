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
import { Box, type Component, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

const CODE_LINES = 10;
const OUTPUT_LINES = 5;
const ARGS_CHARS = 100;
const PREVIEW_CHARS = 60;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const NOTHING: Component = { render: () => [], invalidate() {} };

type Renderers = Pick<ToolRenderers, "renderShell" | "renderCall" | "renderResult">;

export function toolRenderers(cwd: string): (name: string) => Renderers {
	const pi = Object.fromEntries(
		[createBashToolDefinition, createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition].map((create) => {
			const { name, renderShell, renderCall, renderResult } = create(cwd);
			return [name, { ...(renderShell === undefined ? {} : { renderShell }), renderCall, renderResult } as Renderers];
		}),
	);
	const own: Record<string, Renderers> = { ...pi, codemode: codeRenderers };
	return (name) => collapsible(name, own[name] ?? compactRenderers(name));
}

type LineState = { outputLines?: number; firstLine?: string | undefined };

function collapsible(name: string, full: Renderers): Renderers {
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (context.expanded) return padded(full.renderCall?.(args, theme, { ...context, lastComponent: undefined }));
			return toolLine(name, args, theme, context);
		},
		renderResult(result, options, theme, context) {
			const text = resultText(result).replace(/^Script (completed|failed)\nWall time [^\n]*\nOutput:\n\n?/, "");
			const state = context.state as LineState;
			state.outputLines = text === "" ? 0 : text.split("\n").length;
			state.firstLine = text.split("\n").find((line) => line.trim() !== "")?.trim();
			if (options.expanded) return padded(full.renderResult?.(result, options, theme, { ...context, lastComponent: undefined }));
			return NOTHING;
		},
	};
}

function padded(component: Component | undefined): Component {
	if (component === undefined) return NOTHING;
	const box = new Box(1, 0);
	box.addChild(component);
	return box;
}

function toolLine(name: string, args: unknown, theme: Theme, context: Parameters<NonNullable<Renderers["renderCall"]>>[2]): Component {
	const state = context.state as LineState;
	return {
		render(width) {
			const dot = theme.fg("dim", " · ");
			let marker = theme.fg("dim", "◇");
			if (context.executionStarted) marker = theme.fg("accent", SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!);
			if (!context.isPartial) marker = theme.fg("success", "✓");
			if (context.isError) marker = theme.fg("error", "✗");
			let line = ` ${marker} ${theme.fg("muted", name)}`;
			const shown = firstLine(args);
			if (shown !== "") line += dot + theme.fg("dim", truncateToWidth(shown, PREVIEW_CHARS, "…"));
			if (context.isPartial && context.executionStarted) line += dot + theme.fg("dim", "running");
			if (!context.isPartial && context.isError && state.firstLine !== undefined) line += dot + theme.fg("error", state.firstLine);
			if (!context.isPartial && !context.isError && (state.outputLines ?? 0) > 0) line += dot + theme.fg("dim", `↓ ${state.outputLines} lines`);
			if (context.durationMs !== undefined) line += dot + theme.fg("dim", formatDuration(context.durationMs));
			return [truncateToWidth(line, width, "…")];
		},
		invalidate() {},
	};
}

function firstLine(args: unknown): string {
	if (args === null || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const source = record.code ?? record.command ?? record.path;
	if (typeof source !== "string") return summarize(args);
	const meaningful = source.split("\n").map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("//"));
	return meaningful ?? "";
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
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
