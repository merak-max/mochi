import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	DynamicBorder,
	getMarkdownTheme,
	getSelectListTheme,
	initTheme,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentState, EntryRecord, InboxState, LiveState, TaskGraph, TaskGraphNode, UsageState } from "@earendil-works/pi-durable";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	type Focusable,
	fuzzyFilter,
	Input,
	type KeyId,
	Markdown,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	TruncatedText,
	TuiAltScreen,
	visibleWidth,
	VStack,
} from "@earendil-works/pi-tui";
import type { AttachClient } from "./client.ts";
import type { AgentSummary, ModelSummary, Target } from "./protocol.ts";
import { centered, type SplashFacts, splash, splitTag, spread } from "./chrome.ts";
import { toolRenderers } from "./renderers.ts";

type Action = "abort" | "exit" | "model" | "thinking" | "expand" | "followUp";

const KEYS: readonly (readonly [KeyId, Action])[] = [
	["escape", "abort"],
	["ctrl+c", "exit"],
	["ctrl+d", "exit"],
	["ctrl+l", "model"],
	["shift+tab", "thinking"],
	["ctrl+o", "expand"],
	["alt+enter", "followUp"],
];
const THINKING = ["off", "low", "medium", "high", "xhigh", "max"] as const;

const COMMANDS = [
	{ name: "model", description: "Select model", argumentHint: "<provider/model>" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
	{ name: "new", description: "Start a new context in this conversation" },
	{ name: "compact", description: "Summarize earlier context", argumentHint: "<instructions>" },
	{ name: "agents", description: "Switch to another conversation" },
	{ name: "tasks", description: "Show or hide live tasks" },
	{ name: "stop", description: "Stop this conversation and everything it owns" },
	{ name: "quit", description: "Detach; work keeps running in the daemon" },
] as const;
type Command = (typeof COMMANDS)[number]["name"];
let theme: Theme;
const dim = (text: string) => theme.fg("dim", text);
const accent = (text: string) => theme.fg("accent", text);
const EDITOR_RULE = "\u0000rule";

function rule(label: string): Component {
	return {
		render(width) {
			const text = ` ${label} `;
			const side = Math.max(2, Math.floor((width - visibleWidth(text) - 4) / 2));
			return [centered(theme.fg("borderMuted", "─".repeat(side)) + dim(text) + theme.fg("borderMuted", "─".repeat(side)), width)];
		},
		invalidate() {},
	};
}

class UserBlock implements Component {
	readonly #message: UserMessageComponent;
	readonly #meta: string | undefined;

	constructor(text: string) {
		const { body, meta } = splitTag(text);
		this.#message = new UserMessageComponent(body, getMarkdownTheme());
		this.#meta = meta;
	}

	render(width: number): string[] {
		const lines = this.#message.render(width).map((line) => line + theme.bg("userMessageBg", " ".repeat(Math.max(0, width - visibleWidth(line)))));
		if (this.#meta === undefined || lines.length === 0) return lines;
		const meta = this.#meta;
		lines[0] = theme.bg("userMessageBg", spread("", theme.fg("dim", meta), width));
		return lines;
	}

	invalidate(): void {
		this.#message.invalidate();
	}
}

class MochiEditor extends Editor {
	onAction: (action: Action) => void = () => {};

	override render(width: number): string[] {
		const lines = super.render(width - 2);
		const out: string[] = [];
		let inside = false;
		let first = true;
		for (const line of lines) {
			if (line.includes(EDITOR_RULE)) {
				inside = !inside;
				continue;
			}
			if (!inside) {
				out.push(line);
				continue;
			}
			const prompt = first ? theme.fg("accent", "›") + " " : "  ";
			first = false;
			const fill = " ".repeat(Math.max(0, width - 2 - visibleWidth(line)));
			out.push(theme.bg("userMessageBg", `${prompt}${line}${fill}`));
		}
		return out;
	}

	override handleInput(data: string): void {
		const action = KEYS.find(([key]) => matchesKey(data, key))?.[1];
		if (action !== undefined && (action !== "exit" || this.getText() === "")) return this.onAction(action);
		super.handleInput(data);
	}
}

class ListSelector extends Container implements Focusable {
	readonly #input = new Input();
	readonly #listContainer = new Container();
	readonly #items: SelectItem[];
	readonly #onSelect: (value: string) => void;
	readonly #onCancel: () => void;
	#list: SelectList;
	#focused = false;

	constructor(title: string, items: SelectItem[], onSelect: (value: string) => void, onCancel: () => void) {
		super();
		this.#items = items;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.#list = this.#build(items);
		this.addChild(new DynamicBorder());
		this.addChild(new Text(accent(title), 1, 0));
		this.addChild(this.#input);
		this.addChild(this.#listContainer);
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	handleInput(data: string): void {
		if (["up", "down", "enter", "escape"].some((key) => matchesKey(data, key as KeyId))) return this.#list.handleInput(data);
		this.#input.handleInput(data);
		const query = this.#input.getValue();
		this.#list = this.#build(query === "" ? this.#items : fuzzyFilter(this.#items, query, (item) => `${item.label} ${item.value}`));
	}

	#build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 10, getSelectListTheme());
		list.onSelect = (item) => this.#onSelect(item.value);
		list.onCancel = this.#onCancel;
		this.#listContainer.clear();
		this.#listContainer.addChild(list);
		return list;
	}
}

class MochiTui {
	readonly ui = new TuiAltScreen(new ProcessTerminal(), false);
	readonly editor: MochiEditor;
	readonly #chat = new Container();
	readonly #activity = new Container();
	readonly #queue = new Container();
	readonly #notices = new Container();
	readonly #topBar = new Text("", 0, 0);
	readonly #context = new Text("", 0, 0);
	readonly #footer = new Text("", 0, 0);
	readonly #editorSlot = new Container();
	readonly #transcript: ScrollView;
	readonly #cwd: string;
	readonly #renderers: ReturnType<typeof toolRenderers>;
	readonly #tools = new Map<string, ToolExecutionComponent>();
	readonly #cards: ToolExecutionComponent[] = [];
	readonly #streamingCalls = new Set<string>();
	#rendered: number[] = [];
	#streaming: AssistantMessageComponent | undefined;
	#expanded = false;
	#rebuilt = false;
	#shownConversation: number | undefined;
	busy = false;
	splashFacts: SplashFacts = { build: "", model: "", home: "" };

	constructor(cwd: string) {
		this.#cwd = cwd;
		this.#renderers = toolRenderers(cwd);
		this.editor = new MochiEditor(this.ui, { borderColor: () => EDITOR_RULE, selectList: getSelectListTheme() }, { paddingX: 0 });
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				COMMANDS.map((command) =>
					command.name === "thinking"
						? { ...command, getArgumentCompletions: (prefix: string) => THINKING.filter((level) => level.startsWith(prefix)).map((level) => ({ value: level, label: level })) }
						: command,
				),
				cwd,
			),
		);
		this.#editorSlot.addChild(this.editor);
		const content = new Container();
		content.addChild(splash(() => this.splashFacts, theme));
		content.addChild(this.#chat);
		content.addChild(new Spacer(1));
		this.#transcript = new ScrollView(content, { follow: "end", primary: true, overscroll: "chain" });
		const dock = new VStack([
			{ component: this.#activity, shrink: 1, minSize: 0 },
			{ component: this.#queue, shrink: 1, minSize: 0 },
			{ component: this.#notices, shrink: 1, minSize: 0 },
			{ component: this.#context, shrink: 0, minSize: 0 },
			{ component: this.#editorSlot, shrink: 1, minSize: 1 },
			{ component: this.#footer, shrink: 1, minSize: 0 },
		]);
		for (const component of [this.#topBar, this.#chat, this.#activity, this.#queue, this.#notices, this.#context, this.#editorSlot, this.#footer]) {
			this.ui.addChild(component);
		}
		this.ui.setLayoutRoot(
			new VStack([
				{ component: this.#topBar, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
				{ component: this.#transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		this.ui.setFocus(this.editor);
	}

	mount(component: Component & Focusable = this.editor): void {
		this.#editorSlot.clear();
		this.#editorSlot.addChild(component);
		this.ui.setFocus(component);
		this.ui.requestRender();
	}

	toggleExpanded(): void {
		this.#expanded = !this.#expanded;
		for (const card of this.#cards) card.setExpanded(this.#expanded);
		this.ui.requestRender();
	}

	stop(): void {
		for (const card of this.#cards) card.updateResult({ content: [], isError: false }, false);
		this.ui.stop();
	}

	apply(state: Snapshot): void {
		const view = state.client.view;
		if (view === undefined) return;
		if (view.conversation.id !== this.#shownConversation) {
			this.#shownConversation = view.conversation.id;
			this.#rebuild(view.entries);
		}
		const live = (view.docs["pi.live"] ?? {}) as LiveState;
		this.#syncTranscript(view.entries);
		const message = live.generation?.message as AssistantMessage | undefined;
		if (message === undefined && this.#streaming !== undefined) this.#rebuild(view.entries);
		if (message !== undefined) this.#syncStreaming(message);
		for (const slot of live.tools ?? []) {
			if (slot.status === "pending") continue;
			const card = this.#tool(slot.name, slot.callId);
			card.setArgsComplete();
			if (slot.status !== "running") continue;
			card.markExecutionStarted();
			if (slot.output !== undefined) card.updateResult({ content: [{ type: "text", text: slot.output }], details: slot.details, isError: false }, true);
		}
		this.#syncActivity(state);
		this.#queue.clear();
		for (const item of ((view.docs["pi.inbox"] ?? { items: [] }) as InboxState).items) {
			const text = item.mode === "write" ? `<${String(item.entry.kind)}>` : userText(item.content as UserMessage["content"]);
			this.#queue.addChild(new TruncatedText(dim(`[${item.mode}] ${text}`), 1, 0));
		}
		this.#notices.clear();
		for (const notice of state.notices.slice(-4)) this.#notices.addChild(new TruncatedText(theme.fg(notice.error ? "error" : "dim", notice.text), 1, 0));
		this.busy = live.run !== undefined;
		this.#syncFooter(state, statusOf(live));
		if (this.#rebuilt) this.#transcript.scrollToEnd();
		this.ui.requestRender(this.#rebuilt);
		this.#rebuilt = false;
	}

	#syncActivity(state: Snapshot): void {
		this.#activity.clear();
		if (!state.activity || state.client.tasks === undefined) return;
		const nodes = Object.values(state.client.tasks.tasks);
		const lines = [`${nodes.length} live tasks · /tasks hides · /stop stops everything`];
		const owned = new Set(nodes.flatMap((node) => node.conversations));
		const children = (node: TaskGraphNode) =>
			nodes.filter((candidate) => candidate.owner === node.id || (candidate.owner === undefined && node.conversations.includes(candidate.conversationId)));
		const visit = (node: TaskGraphNode, depth: number): void => {
			lines.push(`${"  ".repeat(depth + 1)}${describeTask(node)}`);
			for (const child of children(node)) visit(child, depth + 1);
		};
		for (const node of nodes) if (node.owner === undefined && !owned.has(node.conversationId)) visit(node, 0);
		const spend = Object.entries(state.usage?.models ?? {}).map(([model, usage]) => `${model} $${usage.cost.total.toFixed(3)}`);
		if (spend.length > 0) lines.push(`  spend: ${spend.join(", ")}`);
		for (const line of lines) this.#activity.addChild(new TruncatedText(dim(line), 1, 0));
	}

	#syncFooter(state: Snapshot, status: string): void {
		const view = state.client.view!;
		const agent = (view.docs["pi.agent"] ?? {}) as AgentState;
		const usage = totalUsage((view.docs["pi.usage"] ?? { models: {}, tools: {} }) as UsageState);
		const window = state.models.find((model) => model.provider === agent.model?.provider && model.modelId === agent.model.modelId)?.contextWindow ?? 0;
		const tokens = contextTokens(view.entries) ?? 0;
		const label = state.conversations.find((summary) => summary.id === view.conversation.id)?.label ?? `conversation ${view.conversation.id}`;
		const model = agent.model === undefined ? "no model" : `${agent.model.provider}/${agent.model.modelId}`;
		this.splashFacts = { build: state.client.daemon?.build ?? "", model, home: state.home };
		const width = this.ui.terminal.columns;
		this.#topBar.setText(centered(`${theme.fg("text", label)}  ${dim("$" + usage.cost.toFixed(2))}`, width));
		const mode = this.#expanded ? "Expanded mode (Ctrl+O to collapse)" : "Collapsed mode (Ctrl+O to expand)";
		const left = status === "" ? dim("/ commands") : theme.fg("muted", status);
		let right = `${model}:${agent.thinkingLevel ?? "off"} · ${formatTokens(tokens)}`;
		if (window > 0) right += ` (${Math.round((tokens / window) * 100)}%)`;
		this.#context.setText(`\n${spread("", dim(mode), width)}\n`);
		const lines = ["", spread(left, dim(right), width), theme.fg("borderMuted", "─".repeat(width)), dock(state.client.tasks, width)];
		this.#footer.setText(lines.join("\n"));
	}

	#syncTranscript(entries: readonly EntryRecord[]): void {
		if (this.#rendered.some((id, index) => entries[index]?.id !== id)) this.#rebuild(entries);
		for (const entry of entries.slice(this.#rendered.length)) {
			this.#addEntry(entry);
			this.#rendered.push(entry.id);
		}
	}

	#rebuild(entries: readonly EntryRecord[]): void {
		this.#chat.clear();
		for (const card of this.#cards) card.updateResult({ content: [], isError: false }, false);
		this.#cards.length = 0;
		this.#tools.clear();
		this.#streamingCalls.clear();
		this.#rebuilt = true;
		this.#rendered = [];
		this.#streaming = undefined;
		this.#syncTranscript(entries);
	}

	#addEntry(entry: EntryRecord): void {
		const message = entry.model?.[0];
		if (entry.kind === "pi.user" && message?.role === "user") {
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(new UserBlock(userText(message.content)));
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			const component = this.#streaming ?? new AssistantMessageComponent(undefined, false, getMarkdownTheme());
			if (this.#streaming === undefined) this.#chat.addChild(component);
			this.#streaming = undefined;
			component.updateContent(message, false);
			const ran = message.stopReason === "toolUse";
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const streamed = this.#streamingCalls.has(content.id);
				if (!ran && !streamed) continue;
				const card = this.#tool(content.name, content.id, content.arguments, !streamed);
				card.setArgsComplete();
				if (!ran) card.updateResult({ content: [{ type: "text", text: "Not run: the answer was interrupted." }], isError: true }, false);
			}
			this.#streamingCalls.clear();
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			const result = message as ToolResultMessage;
			this.#tool(result.toolName, result.toolCallId).updateResult(result);
		} else if (entry.kind === "pi.compaction") {
			if (this.#expanded && message?.role === "user") this.#text(userText(message.content));
			else this.#rule("earlier context summarized");
		} else if (entry.kind === "pi.reset") {
			this.#rule("new context");
		} else if (entry.kind === "app.notify" && message?.role === "user") {
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(new Markdown(userText(message.content), 1, 0, getMarkdownTheme()));
		}
	}

	#syncStreaming(message: AssistantMessage): void {
		if (this.#streaming === undefined) {
			this.#streaming = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
			this.#chat.addChild(this.#streaming);
		}
		this.#streaming.updateContent(message, true);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#tool(content.name, content.id, content.arguments, !this.#streamingCalls.has(content.id));
			this.#streamingCalls.add(content.id);
		}
	}

	#rule(label: string): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(rule(label));
	}

	#text(text: string): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new Text(dim(text), 1, 0));
	}

	#tool(name: string, callId: string, args?: unknown, fresh = false): ToolExecutionComponent {
		const existing = fresh ? undefined : this.#tools.get(callId);
		if (existing !== undefined) {
			if (args !== undefined) existing.updateArgs(args);
			return existing;
		}
		const card = new ToolExecutionComponent(name, callId, args ?? {}, {}, this.#renderers(name), this.ui, this.#cwd);
		card.setExpanded(this.#expanded);
		this.#chat.addChild(card);
		this.#cards.push(card);
		this.#tools.set(callId, card);
		return card;
	}
}

interface Snapshot {
	readonly client: AttachClient;
	readonly conversations: readonly AgentSummary[];
	readonly models: readonly ModelSummary[];
	readonly usage: UsageState | undefined;
	readonly activity: boolean;
	readonly home: string;
	readonly notices: readonly { readonly text: string; readonly error: boolean }[];
}

/** `target`: the conversation to open; absent, main. */
export async function runTui(client: AttachClient, cwd: string, target?: Target): Promise<void> {
	if (target !== undefined) await client.request({ op: "show", to: target });
	loadMochiTheme();
	const tui = new MochiTui(cwd);
	let state: Snapshot = {
		client,
		conversations: await client.request({ op: "agents" }),
		models: await client.request({ op: "models" }),
		usage: await client.request({ op: "usage" }),
		activity: false,
		home: cwd.replace(process.env.HOME ?? "\u0000", "~"),
		notices: [],
	};
	const render = () => tui.apply(state);
	const update = (patch: Partial<Snapshot>) => {
		state = { ...state, ...patch };
		render();
	};
	const fail = (error: unknown) => update({ notices: [...state.notices, { text: error instanceof Error ? error.message : String(error), error: true }].slice(-20) });
	const info = (text: string) => update({ notices: [...state.notices, { text, error: false }].slice(-20) });
	const shown = () => state.client.view?.conversation.id ?? 0;

	let tasksSeen: TaskGraph | undefined;
	let refreshing = false;
	const unsubscribe = client.subscribe(() => {
		render();
		if (client.tasks === tasksSeen || refreshing) return;
		tasksSeen = client.tasks;
		refreshing = true;
		void Promise.all([client.request({ op: "usage" }), client.request({ op: "agents" })])
			.then(([usage, conversations]) => update({ usage, conversations }))
			.catch(fail)
			.finally(() => {
				refreshing = false;
			});
	});

	const select = (title: string, items: SelectItem[], onSelect: (value: string) => void) =>
		tui.mount(
			new ListSelector(title, items, (value) => {
				tui.mount();
				onSelect(value);
			}, () => tui.mount()),
		);
	const selectModel = () =>
		select(
			"Select model:",
			state.models.map((model) => ({ value: `${model.provider}/${model.modelId}`, label: model.modelId, description: model.provider })),
			(value) => {
				const slash = value.indexOf("/");
				void client.request({ op: "configure", to: shown(), model: { provider: value.slice(0, slash), modelId: value.slice(slash + 1) } }).catch(fail);
			},
		);
	const selectConversation = () =>
		select(
			"Switch to:",
			[...state.conversations].reverse().map((summary) => ({ value: String(summary.id), label: summary.label, description: summary.title ?? "" })),
			(value) => void client.request({ op: "show", to: Number(value) }).catch(fail),
		);

	let exit = () => {};
	const exited = new Promise<void>((resolve) => {
		exit = resolve;
	});
	const setThinking = (level: string) => {
		if (!(THINKING as readonly string[]).includes(level)) return fail(`Unknown thinking level ${level}. Use one of: ${THINKING.join(", ")}.`);
		void client.request({ op: "configure", to: shown(), thinkingLevel: level }).then(() => info(`Thinking: ${level}.`), fail);
	};
	const runCommand = (name: string, arg: string): void => {
		if (!COMMANDS.some((command) => command.name === name)) return fail(`Unknown command /${name}. Type / to see the commands.`);
		switch (name as Command) {
			case "model": {
				if (arg === "") return selectModel();
				const model = state.models.find((candidate) => `${candidate.provider}/${candidate.modelId}` === arg || candidate.modelId === arg);
				if (model === undefined) return fail(`Unknown model ${arg}. Use /model to pick one.`);
				void client.request({ op: "configure", to: shown(), model: { provider: model.provider, modelId: model.modelId } }).catch(fail);
				return;
			}
			case "thinking":
				return arg === "" ? select("Thinking level:", THINKING.map((level) => ({ value: level, label: level })), setThinking) : setThinking(arg);
			case "new":
				void client.request({ op: "reset", to: shown() }).then(() => info("New context started."), fail);
				return;
			case "compact":
				void client
					.request({ op: "compact", to: shown(), ...(arg === "" ? {} : { instructions: arg }) })
					.then(() => info("Compaction started."), fail);
				return;
			case "agents":
				return selectConversation();
			case "tasks":
				return update({ activity: !state.activity });
			case "stop":
				void client.request({ op: "abort", to: shown(), everything: true }).then(() => info("Stopped everything this conversation owns."), fail);
				return;
			case "quit":
				return exit();
		}
	};
	tui.editor.onSubmit = (raw) => {
		const text = raw.trim();
		if (text === "") return;
		tui.editor.addToHistory(text);
		tui.editor.setText("");
		const slash = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(text);
		if (slash !== null) return runCommand(slash[1]!, slash[2]?.trim() ?? "");
		void client.request({ op: "submit", to: shown(), text, whenBusy: "steer" }).catch(fail);
	};
	tui.editor.onAction = (action) => {
		switch (action) {
			case "abort":
				void client.request({ op: "abort", to: shown(), everything: false }).catch(fail);
				return;
			case "exit":
				exit();
				return;
			case "model":
				selectModel();
				return;
			case "thinking": {
				const current = ((state.client.view?.docs["pi.agent"] ?? {}) as AgentState).thinkingLevel ?? "off";
				const next = THINKING[(THINKING.indexOf(current as (typeof THINKING)[number]) + 1) % THINKING.length] ?? "off";
				void client.request({ op: "configure", to: shown(), thinkingLevel: next }).catch(fail);
				return;
			}
			case "expand":
				tui.toggleExpanded();
				return;
			case "followUp": {
				const text = tui.editor.getText().trim();
				if (text === "") return;
				tui.editor.setText("");
				void client.request({ op: "submit", to: shown(), text, whenBusy: "followUp" }).catch(fail);
				return;
			}
		}
	};

	tui.ui.start();
	render();
	const ticker = setInterval(() => {
		if (tui.busy) tui.ui.requestRender();
	}, 80);
	void client.closed.then(() => {
		fail("The daemon closed the connection.");
		exit();
	});
	await exited;
	clearInterval(ticker);
	unsubscribe();
	tui.stop();
}

/** pi reads custom themes from <PI_CODING_AGENT_DIR>/themes; point it at ours only while the theme loads. */
function loadMochiTheme(): void {
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dirname(fileURLToPath(import.meta.url));
	initTheme("mochi");
	theme = (globalThis as Record<symbol, Theme>)[Symbol.for("@earendil-works/pi-coding-agent:theme")]!;
	if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved;
}

function dock(graph: TaskGraph | undefined, width: number): string {
	const nodes = Object.values(graph?.tasks ?? {}).filter((node) => !node.abortRequested);
	const agents = nodes.filter((node) => node.kind === "mochi.agent").length;
	const triggers = nodes.filter((node) => node.kind === "mochi.trigger" && !(node.state.status !== "completing" && node.state.phase === "wait")).length;
	const procs = nodes.filter((node) => node.kind === "mochi.proc").length;
	const count = (glyph: string, n: number, noun: string) => theme.fg(n > 0 ? "success" : "muted", `${glyph} ${n} ${noun}`);
	const separator = dim("  ·  ");
	const row = ` ${count("◆", agents, "agents")}${separator}${count("◷", triggers, "triggers")}${separator}${count("▸", procs, "procs")}`;
	return row.length > 0 && visibleWidth(row) > width ? row.slice(0, width) : row;
}

function statusOf(live: LiveState): string {
	const generation = live.generation;
	const compaction = live.compactions?.[0];
	const tool = live.tools?.find((slot) => slot.status === "running");
	if (generation?.retry !== undefined) return `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
	if (compaction !== undefined) return `Compacting (${compaction.reason})...`;
	if (tool !== undefined) return `running ${tool.name} · esc abort`;
	if (live.run !== undefined) return "working · esc abort";
	return "";
}

function describeTask(node: TaskGraphNode): string {
	const state = node.state;
	const status =
		state.status === "waiting" ? `waiting on ${state.on.join(", ")}` : state.status === "completing" ? `completing (${state.outcome})` : `${state.status} ${state.phase}`;
	const flags = [node.background ? "background" : "", node.abortRequested ? "aborting" : ""].filter(Boolean);
	const owned = node.conversations.length > 0 ? ` owns conversation ${node.conversations.join(", ")}` : "";
	return `${node.kind} #${node.id} (conversation ${node.conversationId}): ${status}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}${owned}`;
}

function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function totalUsage(state: UsageState): { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cost: number } {
	const all = [...Object.values(state.models), ...Object.values(state.tools)];
	const sum = (pick: (usage: Usage) => number) => all.reduce((total, usage) => total + pick(usage), 0);
	return { input: sum((usage) => usage.input), output: sum((usage) => usage.output), cacheRead: sum((usage) => usage.cacheRead), cost: sum((usage) => usage.cost.total) };
}

function contextTokens(entries: readonly EntryRecord[]): number | undefined {
	const compacted = Math.max(0, ...entries.filter((entry) => entry.kind === "pi.compaction").map((entry) => entry.id));
	for (const entry of [...entries].reverse()) {
		const message = entry.model?.[0];
		if (entry.id < compacted || entry.kind !== "pi.assistant" || message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		return message.usage.totalTokens || message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
	}
	return undefined;
}
