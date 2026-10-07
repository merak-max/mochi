import type { Item, Transcript } from "./dump.ts";
import type { Scenario } from "./scenarios.ts";

/** One line of sent.jsonl: what the owner's channel sent or reacted. */
export type Sent = { readonly kind: "send"; readonly text: string } | { readonly kind: "react"; readonly messageId: string; readonly emoji: string };

export type Check = { readonly name: string; readonly pass: boolean; readonly detail: string };

export type Grade = {
	readonly id: string;
	readonly pass: boolean;
	readonly checks: readonly Check[];
	/** What the owner received: each live turn's delivered answer, then any notifications. */
	readonly delivered: readonly string[];
	readonly toolCalls: readonly string[];
	readonly turns: number;
	readonly promptTokensPerTurn: number;
	readonly outputTokensPerTurn: number;
	readonly cost: number;
};

/** Voice-spec bans that code can see. The judge and a human reread cover the rest. */
export const BANNED: readonly string[] = [
	"great question",
	"happy to help",
	"i'd be happy to",
	"let me know if",
	"feel free to",
	"as an ai",
	"i hope this",
	"hope that helps",
	"absolutely!",
	"certainly!",
	"how can i (help|assist)",
	"is there anything else",
	"—",
	"\\bdelve",
	"hack the planet",
	"\\bpunk\\b",
	"\\brad\\b",
	"don't hesitate",
];

/** Tools that only read; a claim of having acted needs a successful call of some other tool. */
const READ_ONLY = new Set(["recall", "read"]);
/** First-person or bare past-tense reports of an act ("sent.", "i've booked", "reminder set"), not offers ("i can set a reminder"). */
const CLAIMS = [
	/\b(i've|i have|i just|i)\s+(sent|booked|held|scheduled|saved|added|set up|set|forwarded|emailed|moved|created|replied|cancelled|paid|noted)\b/i,
	/(^|[.!?]\s+)(sent|booked|held|scheduled|saved|added|done|moved|noted|forwarded|cancelled|paid|on it)\b[.!,:]/im,
	/\b(reminder|alarm|trigger)s? (is |are )?set\b|\ball set\b/i,
];
const claimIn = (text: string): string | undefined => CLAIMS.map((pattern) => text.match(pattern)?.[0]).find((match) => match !== undefined);
const MARKDOWN = [/^\s*\|.*\|\s*$/m, /^#{1,6}\s/m];
const DEFAULT_MAX = 700;

export function grade(scenario: Scenario, transcript: Transcript, extra: { readonly sent: readonly Sent[]; readonly bookings?: number; /** The run's date, `YYYY-MM-DD`; a section that contains it is a timestamp. */ readonly today?: string }): Grade {
	const root = transcript.conversations[0];
	const all = transcript.conversations.flatMap((conversation) => conversation.items);
	const live = root === undefined ? [] : liveTurns(root.items, scenario.id);
	const notifies = all.filter((item) => item.kind === "notify").map((item) => item.text);
	const delivered = extra.sent.flatMap((item) => (item.kind === "send" ? [item.text] : []));
	const reacted = extra.sent.some((item) => item.kind === "react");
	const expect = scenario.expect;
	const checks: Check[] = [];
	const add = (name: string, pass: boolean, detail = "") => checks.push({ name, pass, detail });

	if (scenario.turns !== undefined) {
		const answered = live.filter((turn) => turn.answer !== undefined).length;
		const quiet = expect.reactionOk === true && reacted;
		add(
			"every turn answered and sent once",
			live.length === scenario.turns.length && (answered === live.length || quiet) && delivered.length === answered + notifies.length && new Set(delivered).size === delivered.length,
			`turns ${live.length}, answers ${answered}, sent ${delivered.length}, notifies ${notifies.length}`,
		);
	}
	const max = expect.maxChars ?? DEFAULT_MAX;
	const longest = Math.max(0, ...delivered.map((text) => text.length));
	add(`length <= ${max}`, longest <= max, `longest ${longest}`);
	const banned = BANNED.filter((phrase) => delivered.some((text) => new RegExp(phrase, "i").test(text)));
	add("no banned phrase", banned.length === 0, banned.join(" | "));
	add("no blank or invisible message", !delivered.some((text) => text.replace(/[\s\u200b-\u200d\u2060\ufeff]/g, "") === ""), delivered.filter((text) => text.trim().length < 2).map((text) => JSON.stringify(text)).join(" "));
	add("no markdown table or heading", !delivered.some((text) => MARKDOWN.some((pattern) => pattern.test(text))));
	const stamps = [extra.today, "current time", "current date"].filter((stamp): stamp is string => stamp !== undefined);
	const timed = all.flatMap((item) =>
		item.kind === "system" ? Object.entries(item.sections).filter(([, text]) => text !== null && stamps.some((stamp) => text.toLowerCase().includes(stamp.toLowerCase()))).map(([name]) => name) : [],
	);
	add("no timestamp in prompt sections", timed.length === 0, [...new Set(timed)].join(","));
	for (const turn of live) {
		const claim = turn.answer === undefined ? undefined : claimIn(turn.answer);
		if (claim === undefined) continue;
		const acted = turn.results.some((result) => result.ok && !READ_ONLY.has(result.tool));
		add("claims backed by a committed tool result", acted, `"${claim}"`);
	}
	const joined = delivered.join("\n");
	for (const pattern of expect.mention ?? []) add(`mentions /${pattern}/`, new RegExp(pattern, "i").test(joined));
	for (const pattern of expect.avoid ?? []) add(`avoids /${pattern}/`, !new RegExp(pattern, "im").test(joined));
	const results = all.filter((item): item is Extract<Item, { kind: "result" }> => item.kind === "result");
	for (const tool of expect.tools ?? []) add(`calls ${tool}`, results.some((result) => result.ok && new RegExp(`^(${tool})$`).test(result.tool)));
	const calls = all.filter((item): item is Extract<Item, { kind: "call" }> => item.kind === "call");
	for (const rule of expect.forbidden ?? []) {
		const hit = calls.find((call) => call.tool === rule.tool && new RegExp(rule.args, "i").test(call.args));
		add(`never ${rule.tool} /${rule.args}/`, hit === undefined, hit?.args.slice(0, 200) ?? "");
	}
	if (expect.notify !== undefined) add(`notify ${expect.notify}`, expect.notify === "none" ? notifies.length === 0 : notifies.length === 1, `${notifies.length} sent`);
	if (expect.bookings !== undefined) add(`bookings.log has ${expect.bookings} line(s)`, extra.bookings === expect.bookings, `${extra.bookings ?? "missing"}`);

	const turns = Math.max(1, scenario.turns?.length ?? 1);
	const u = transcript.usage;
	return {
		id: scenario.id,
		pass: checks.every((check) => check.pass),
		checks,
		delivered,
		toolCalls: calls.map((call) => call.tool),
		turns,
		promptTokensPerTurn: Math.round((u.input + u.cacheRead + u.cacheWrite) / turns),
		outputTokensPerTurn: Math.round(u.output / turns),
		cost: u.cost,
	};
}

type LiveTurn = { readonly answer: string | undefined; readonly results: readonly Extract<Item, { kind: "result" }>[] };

/** The scenario's live owner turns, each with the answer its Turn delivered (a reply with no tool calls) and its tool results. */
function liveTurns(items: readonly Item[], id: string): LiveTurn[] {
	const turns: LiveTurn[] = [];
	let current: { replies: string[]; results: Extract<Item, { kind: "result" }>[] } | undefined;
	const close = () => {
		if (current !== undefined) turns.push({ answer: current.replies.at(-1), results: current.results });
	};
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		if (item.kind === "owner" && item.text.includes(` id=${id}:`)) {
			close();
			current = { replies: [], results: [] };
		} else if (current !== undefined && item.kind === "reply") {
			const previous = items[i - 1];
			if (previous?.kind === "call" && previous.entry === item.entry) continue;
			current.replies.push(item.text);
		} else if (current !== undefined && item.kind === "result") {
			current.results.push(item);
		}
	}
	close();
	return turns;
}
