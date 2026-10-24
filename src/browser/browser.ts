import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { Type, type Static, type ClassifierQuestion, type ClassifierAnswer } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Classify } from "../brain/classifier.ts";
import { parseWith } from "../parse.ts";
import { BrowserClient, type BrowserDeps } from "./client.ts";
import { Cdp } from "./cdp.ts";
import { PageSnapshot, elementTable, type Action } from "./elements.ts";
import { acquireProfile } from "./profile.ts";
import { SNAPSHOT } from "./snapshot.ts";

// browse drives the owner's browser. The classifier picks each click, select and scroll. It hands the page back to the
// agent when a field needs text, when it judges the goal done, when it asks for help, or when three actions change
// nothing. The agent answers with the same session: text for the field, a new instruction, or close.

interface BrowseDeps extends BrowserDeps {
	readonly classify: Classify;
}

const STEPS_PER_CALL = 40;

type Open = {
	readonly client: BrowserClient;
	readonly cdp: Cdp;
	readonly page: string;
	readonly stop: () => Promise<void>;
	readonly liveViewUrl: string | undefined;
	goal: string;
	snapshot: PageSnapshot;
	history: { action: string; kind: string; text: string | null; page_changed: boolean }[];
	/** The field the agent was asked to fill, if the last hand-back was for text. */
	pending: Action | undefined;
};

const sessions = new Map<string, Open>();

function noProgress(history: readonly { kind: string; page_changed: boolean }[]): boolean {
	const repeated = history.slice(-3);
	return repeated.length === 3 && repeated.every((h) => !h.page_changed && h.kind !== "wait");
}

function choice(answer: ClassifierAnswer | undefined, question: ClassifierQuestion | undefined): string {
	if (answer?.type !== "choice" || question?.type !== "choice") throw new Error("No valid classifier choice; no action executed.");
	const values = Object.values(answer.probabilities);
	const selected = answer.probabilities[answer.choice];
	if (!Object.hasOwn(question.criteria, answer.choice) || selected === undefined ||
		JSON.stringify(Object.keys(answer.probabilities).sort()) !== JSON.stringify(Object.keys(question.criteria).sort()) ||
		values.some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
		Math.abs(values.reduce((a, b) => a + b, 0) - 1) >= 0.02 || selected < Math.max(...values) - 1e-6 ||
		!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) throw new Error("Invalid classifier probabilities; no action executed.");
	return answer.choice;
}

const Handback = Type.Object({
	session: Type.String(),
	reason: Type.Union([Type.Literal("needs_text"), Type.Literal("done"), Type.Literal("stuck"), Type.Literal("closed")]),
	note: Type.String(),
	url: Type.String(),
	title: Type.String(),
	text: Type.String(),
	elements: Type.Array(Type.Object({ index: Type.String(), role: Type.String(), label: Type.String(), value: Type.String(), operations: Type.Array(Type.String()) }, { additionalProperties: true })),
	field: Type.Optional(Type.String()),
	liveViewUrl: Type.Optional(Type.String()),
	steps: Type.Integer(),
});
type Handback = Static<typeof Handback>;

function handback(id: string, open: Open, reason: Handback["reason"], note: string, field?: Action): Handback {
	const { elements } = elementTable(open.snapshot, open.goal);
	const out: Handback = { session: id, reason, note, url: open.snapshot.url, title: open.snapshot.title, text: open.snapshot.text.slice(0, 6000), elements: JSON.parse(JSON.stringify(elements)), steps: open.history.length };
	if (field !== undefined) out.field = field.label;
	if (open.liveViewUrl !== undefined) out.liveViewUrl = open.liveViewUrl;
	return out;
}

async function start(deps: BrowseDeps, url: URL, goal: string, context: Context): Promise<[string, Open]> {
	const client = new BrowserClient(deps);
	const lease = await acquireProfile(client.key, context.abortSignal);
	let session;
	try { session = await client.createSession(context.abortSignal); } catch (error) { lease.uncertain(); throw error; }
	const cdp = await Cdp.connect(session.cdpUrl);
	const target = parseWith(Type.Object({ targetId: Type.String() }), await cdp.call("Target.createTarget", { url: "about:blank" }), "CDP target");
	const attached = parseWith(Type.Object({ sessionId: Type.String() }), await cdp.call("Target.attachToTarget", { targetId: target.targetId, flatten: true }), "CDP session");
	const page = attached.sessionId;
	await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1120, height: 780, deviceScaleFactor: 1, mobile: false }, page);
	await cdp.call("Page.navigate", { url: url.href }, page);
	await cdp.evaluate("new Promise(resolve => { const started = Date.now(); const check = () => document.readyState === 'complete' || Date.now() - started > 15000 ? resolve(true) : setTimeout(check, 25); check(); })", page);
	const id = randomBytes(6).toString("hex");
	const stop = async (): Promise<void> => {
		sessions.delete(id);
		cdp.close();
		await lease.stop(() => client.stopSession(session.id));
	};
	const snapshot = parseWith(PageSnapshot, await cdp.evaluate(SNAPSHOT, page), "browser snapshot");
	const open: Open = { client, cdp, page, stop, liveViewUrl: session.interactiveLiveViewUrl ?? undefined, goal, snapshot, history: [], pending: undefined };
	sessions.set(id, open);
	return [id, open];
}

/** The classifier's loop: act until it hands back. */
async function drive(deps: BrowseDeps, id: string, open: Open, context: Context): Promise<Handback> {
	const { cdp, page } = open;
	for (let step = 0; step < STEPS_PER_CALL; step++) {
		context.abortSignal?.throwIfAborted();
		const table = elementTable(open.snapshot, open.goal);
		const result = await deps.classify({ page: { url: open.snapshot.url, title: open.snapshot.title, text: open.snapshot.text }, elements: table.elements, recent_actions: open.history.slice(-10) }, table.questions, context);
		if (!result.ok) throw new Error(result.error);
		const operation = choice(result.answers.operation, table.questions.operation);
		const current = parseWith(PageSnapshot, await cdp.evaluate(SNAPSHOT, page), "browser snapshot");
		if (JSON.stringify(current.marker) !== JSON.stringify(open.snapshot.marker)) {
			open.snapshot = current;
			continue;
		}
		if (operation === "DONE") return handback(id, open, "done", "The classifier judges the goal done. Check the page, then close or give a new instruction.");
		if (operation === "ASK_AGENT") return handback(id, open, "stuck", "The classifier asked for help. Give an instruction, fill text, or close.");
		const candidates = table.targets.get(operation);
		const head = `${operation.toLowerCase()}_target`;
		const action = candidates === undefined ? table.controls.get(operation) : candidates.get(choice(result.answers[head], table.questions[head]));
		if (action === undefined) throw new Error("No observed target; no action executed.");
		if (action.kind === "fill") {
			open.pending = action;
			return handback(id, open, "needs_text", `Field "${action.label}" needs text. Call browse again with this session and fill.`, action);
		}
		await act(cdp, page, open.snapshot, action, null);
		const before = JSON.stringify([open.snapshot.url, open.snapshot.text, open.snapshot.actions, open.snapshot.page_key]);
		open.snapshot = parseWith(PageSnapshot, await cdp.evaluate(SNAPSHOT, page), "browser snapshot");
		open.history.push({ action: action.label, kind: action.kind, text: null, page_changed: before !== JSON.stringify([open.snapshot.url, open.snapshot.text, open.snapshot.actions, open.snapshot.page_key]) });
		if (noProgress(open.history)) return handback(id, open, "stuck", "Three actions changed nothing. Give an instruction, fill text, or close.");
	}
	return handback(id, open, "stuck", `${STEPS_PER_CALL} steps in this call. Give an instruction to go on, or close.`);
}

async function act(cdp: Cdp, sessionId: string, page: PageSnapshot, action: Action, text: string | null): Promise<void> {
	const current = parseWith(PageSnapshot, await cdp.evaluate(SNAPSHOT, sessionId), "browser snapshot");
	if (JSON.stringify(current.marker) !== JSON.stringify(page.marker)) throw new Error("Page changed since decision; no action executed.");
	if (action.kind === "wait") {
		await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 100))", sessionId);
		return;
	}
	if (action.kind === "scroll") {
		await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 550, y: 650, deltaX: 0, deltaY: action.delta ?? 0 }, sessionId);
		return;
	}
	const target = parseWith(Type.Union([Type.Null(), Type.Object({ x: Type.Number(), y: Type.Number() })]), await cdp.evaluate(`(action => {
		const e = window.__mochiFast?.nodes.get(action.node);
		if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
		if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
		const r = e.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
		if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !e.contains(document.elementFromPoint(x,y))) return null;
		if (action.kind === 'select') {
			if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value && !o.disabled && !o.closest('optgroup[disabled]'))) return null;
			e.value = action.value; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
		}
		return {x,y};
	})(${JSON.stringify(action)})`, sessionId), "observed target");
	if (target === null) throw new Error("Observed target is stale or covered; no action executed.");
	if (action.kind !== "select") {
		for (const type of ["mousePressed", "mouseReleased"]) await cdp.call("Input.dispatchMouseEvent", { type, ...target, button: "left", clickCount: 1 }, sessionId);
		if (action.kind === "fill") {
			if (text === null) throw new Error("No field text; nothing typed.");
			await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, commands: ["selectAll"] }, sessionId);
			await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 }, sessionId);
			await cdp.call("Input.insertText", { text }, sessionId);
		}
	}
	await cdp.evaluate("new Promise(resolve => setTimeout(resolve, 200))", sessionId);
}

const BrowseInput = Type.Object({
	url: Type.Optional(Type.String({ minLength: 1 })),
	task: Type.Optional(Type.String({ minLength: 1 })),
	session: Type.Optional(Type.String({ minLength: 1 })),
	fill: Type.Optional(Type.String()),
	instruction: Type.Optional(Type.String({ minLength: 1 })),
	close: Type.Optional(Type.Boolean()),
});

async function browse(deps: BrowseDeps, args: Static<typeof BrowseInput>, context: Context): Promise<Handback> {
	if (args.session === undefined) {
		if (args.url === undefined || args.task === undefined) throw new Error("browse needs url and task to start, or session to continue.");
		const url = new URL(args.url);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("browse needs an HTTP(S) URL without credentials.");
		const [id, open] = await start(deps, url, args.task, context);
		try {
			return await drive(deps, id, open, context);
		} catch (error) {
			await open.stop();
			throw error;
		}
	}
	const open = sessions.get(args.session);
	if (open === undefined) throw new Error(`Browser session ${args.session} has ended (closed, idle past its limit, or the daemon restarted). Start again with url and task.`);
	if (args.close === true) {
		const out = handback(args.session, open, "closed", "Session closed.");
		await open.stop();
		return out;
	}
	try {
		if (args.fill !== undefined) {
			if (open.pending === undefined) throw new Error("No field is waiting for text. Give an instruction or close.");
			const field = open.pending;
			open.pending = undefined;
			await act(open.cdp, open.page, open.snapshot, field, args.fill);
			const before = JSON.stringify([open.snapshot.url, open.snapshot.text]);
			open.snapshot = parseWith(PageSnapshot, await open.cdp.evaluate(SNAPSHOT, open.page), "browser snapshot");
			open.history.push({ action: field.label, kind: "fill", text: args.fill, page_changed: before !== JSON.stringify([open.snapshot.url, open.snapshot.text]) });
		}
		if (args.instruction !== undefined) open.goal = `${open.goal}\nThe agent now says: ${args.instruction}`;
		return await drive(deps, args.session, open, context);
	} catch (error) {
		await open.stop();
		throw error;
	}
}

export function browserFns(deps: BrowseDeps): readonly ToolRegistration[] {
	return [defineTool({
		name: "browse",
		description:
			"Drive the owner's logged-in browser. Start with {url, task}: a fast classifier clicks, selects and scrolls toward the task, then hands the page back to you. " +
			"reason needs_text: call again with {session, fill: '<text>'} and the classifier goes on. done: check the page, then {session, close: true}. stuck: {session, instruction} to steer it, fill, or close. " +
			"You decide every typed value and every one-way door; the classifier never types. liveViewUrl lets the owner take over. A session ends after a few idle minutes; always close it when finished.",
		parameters: BrowseInput,
		structuredOutputSchema: Handback,
		replay: "unsafe",
		execute: async (args, _api, context) => ({ structuredOutput: await browse(deps, args, context) }),
	})];
}
