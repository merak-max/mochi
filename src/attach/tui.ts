import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getMarkdownTheme, getSelectListTheme, initTheme, type Theme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Editor, Markdown, matchesKey, ProcessTerminal, ScrollView, Spacer, Text, TuiAltScreen, visibleWidth, VStack } from "@earendil-works/pi-tui";
import type { Terminal } from "./client.ts";
import { loadMark, splash, spread } from "./chrome.ts";

const EDITOR_RULE = "\u0000rule";
const HINT = "/new starts a fresh thread · /stop stops main · ctrl+c leaves";

class UserBlock implements Component {
	readonly #message: UserMessageComponent;
	readonly #theme: Theme;

	constructor(text: string, theme: Theme) {
		this.#message = new UserMessageComponent(text, getMarkdownTheme());
		this.#theme = theme;
	}

	render(width: number): string[] {
		const fill = (line: string) => this.#theme.bg("userMessageBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
		// The component pads itself with blank rows; drop them so the block is the body and one padding row.
		const body = this.#message.render(width).filter((line) => line.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "").trim() !== "");
		return [fill(""), ...body.map(fill), fill("")];
	}

	invalidate(): void {
		this.#message.invalidate();
	}
}

/** A padded panel on the user-block background: a blank row, " > " and the text, a blank row. */
class MochiEditor extends Editor {
	readonly #theme: Theme;
	onExit: () => void = () => {};

	constructor(ui: TuiAltScreen, theme: Theme) {
		super(ui, { borderColor: () => EDITOR_RULE, selectList: getSelectListTheme() }, { paddingX: 0 });
		this.#theme = theme;
	}

	override render(width: number): string[] {
		const lines = super.render(width - 4);
		const panel = (text: string) => this.#theme.bg("userMessageBg", text + " ".repeat(Math.max(0, width - visibleWidth(text))));
		const out: string[] = [];
		let inside = false;
		let first = true;
		for (const line of lines) {
			if (line.includes(EDITOR_RULE)) {
				if (!inside) out.push(panel(""));
				inside = !inside;
				if (!inside) out.push(panel(""));
				continue;
			}
			if (!inside) {
				out.push(line);
				continue;
			}
			const prompt = first ? ` ${this.#theme.fg("muted", ">")} ` : "   ";
			first = false;
			out.push(panel(prompt + line));
		}
		return out;
	}

	override handleInput(data: string): void {
		const leaving = matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d");
		if (leaving && this.getText() === "") return this.onExit();
		super.handleInput(data);
	}
}

/** The full-screen chat with main: the owner's lines, mochi's bubbles, and what main is doing now. */
export async function runTui(terminal: Terminal, home: string): Promise<void> {
	const theme = loadMochiTheme();
	const ui = new TuiAltScreen(new ProcessTerminal(), false);
	const chat = new Container();
	const status = new Text("", 0, 0);
	const footer = new Text("", 0, 0);
	const editor = new MochiEditor(ui, theme);
	const content = new Container();
	const facts = { build: terminal.facts.build, pid: terminal.facts.pid, home: home.replace(process.env.HOME ?? "\u0000", "~") };
	content.addChild(splash(() => facts, theme, loadMark(home)));
	content.addChild(chat);
	content.addChild(new Spacer(1));
	const transcript = new ScrollView(content, { follow: "end", primary: true, overscroll: "chain" });
	for (const component of [chat, status, editor, footer]) ui.addChild(component);
	ui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: status, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
			{ component: editor, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			{ component: footer, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
		]),
	);
	ui.setFocus(editor);

	const showStatus = (text: string, kind: "muted" | "error" = "muted") => {
		status.setText(`\n${spread(theme.fg(kind, text), "", ui.terminal.columns)}`);
		ui.requestRender();
	};
	footer.setText(spread("", theme.fg("dim", HINT), ui.terminal.columns));
	showStatus("");

	let exit = (): void => {};
	const exited = new Promise<void>((resolve) => {
		exit = resolve;
	});
	terminal.onFrame = (frame) => {
		if (frame.t === "bubble") {
			chat.addChild(new Spacer(1));
			chat.addChild(new Markdown(frame.text, 1, 0, getMarkdownTheme()));
			transcript.scrollToEnd();
			ui.requestRender();
		}
		if (frame.t === "live") showStatus(frame.status);
		if (frame.t === "error") showStatus(frame.error, "error");
	};
	editor.onSubmit = (raw) => {
		const text = raw.trim();
		if (text === "") return;
		editor.addToHistory(text);
		editor.setText("");
		chat.addChild(new Spacer(1));
		chat.addChild(new UserBlock(text, theme));
		transcript.scrollToEnd();
		ui.requestRender();
		terminal.send(text);
	};
	editor.onExit = () => exit();
	void terminal.closed.then(() => exit());

	ui.start();
	ui.requestRender();
	await exited;
	ui.stop();
}

/** pi reads custom themes from <PI_CODING_AGENT_DIR>/themes; point it at ours only while the theme loads. */
function loadMochiTheme(): Theme {
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dirname(fileURLToPath(import.meta.url));
	initTheme("mochi");
	const theme = (globalThis as Record<symbol, Theme>)[Symbol.for("@earendil-works/pi-coding-agent:theme")]!;
	if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved;
	return theme;
}
