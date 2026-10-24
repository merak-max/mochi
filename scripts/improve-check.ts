// The improve trigger's check: counts failure signals over the last day of the store and writes the evidence for
// the run. Prints a short JSON summary, or nothing when the window holds fewer than 10 owner turns;
// then the window grows until it does.
// The window starts at the last run (<home>/improve/last-run), so a verdict reads only work done after the edits it
// judges; without a last run it is the last [hours].
// Usage: node scripts/improve-check.ts [home] [hours] [store home]. The store home defaults to home; a test points it at a copy.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[2] ?? process.env.MOCHI_HOME ?? join(process.env.HOME ?? "", ".mochi");
const hours = Number(process.argv[3] ?? "24");
const now = Date.now();
const lastRunFile = join(home, "improve", "last-run");
const lastRun = existsSync(lastRunFile) ? Date.parse(readFileSync(lastRunFile, "utf8").trim()) : Number.NaN;
const since = Number.isNaN(lastRun) ? now - hours * 3600_000 : lastRun;
const storeHome = process.argv[4] ?? home;
const day = new Date(now).toISOString().slice(0, 10);
const runDir = join(home, "improve", "runs", day);
const libraryFile = join(home, "improve", "library.md");

const PER_CONVERSATION_CHARS = 60_000;
const TOTAL_CHARS = 400_000;

const SIGNALS = {
	owner_turns: "Owner messages on a chat channel or the cli.",
	owner_chase: "Owner messages that chase or complain: status, still, why not, too slow, its been. Heuristic.",
	busy_queued: "agent results that say a resident agent was busy and the job only queued.",
	notify_refused: "notify calls refused in the owner's own thread.",
	side_scheduler: "Model scripts that schedule work outside mochi: systemd-run, crontab, at, nohup.",
	script_failed: "codemode scripts that failed.",
	script_timeout: "codemode scripts that hit their time limit.",
	child_lost: "fork or agent children that were aborted or cancelled before they answered.",
	validation_failed: "Tool calls rejected by argument validation.",
	duplicate_reply: "The same teammate answer delivered twice to one conversation.",
} as const;
type Signal = keyof typeof SIGNALS;

const counts = Object.fromEntries(Object.keys(SIGNALS).map((key) => [key, 0])) as Record<Signal, number>;
const examples: Record<string, string[]> = {};
const bump = (key: Signal, where: string) => {
	counts[key] += 1;
	const list = (examples[key] ??= []);
	if (list.length < 5) list.push(where);
};

const trunc = (text: string, size: number) => (text.length > size ? text.slice(0, size) + " ...[" + (text.length - size) + " more]" : text);

const db = new DatabaseSync(join(storeHome, "mochi.sqlite"), { readOnly: true });
const transcripts = new Map<number, string[]>();
const seenReplies = new Set<string>();

for (const row of db.prepare("select id, conversation_id, record from entries order by id").iterate() as Iterable<{ id: number; conversation_id: number; record: string }>) {
	const entry = JSON.parse(row.record);
	const where = row.conversation_id + "#" + row.id;
	for (const message of entry.model ?? []) {
		if (typeof message.timestamp !== "number" || message.timestamp < since) continue;
		const lines = transcripts.get(row.conversation_id) ?? [];
		transcripts.set(row.conversation_id, lines);
		if (typeof message.content === "string") {
			const text = message.content;
			if (message.role === "user") {
				if (/^\[(imessage|whatsapp|cli) /.test(text)) {
					bump("owner_turns", where);
					const body = text.split("\n").slice(1).join(" ").toLowerCase();
					if (/\b(status|still|too slow|its been|it's been|why (wasnt|wasn't|isnt|isn't|didnt|didn't|not))\b/.test(body)) bump("owner_chase", where);
				}
				if (/^\[from [^\]]+\] re: /.test(text)) {
					const key = row.conversation_id + "|" + text.replace(/^\[from [^\]]+\] re: [^\n]*\n/, "").slice(0, 500);
					if (seenReplies.has(key)) bump("duplicate_reply", where);
					seenReplies.add(key);
				}
				lines.push("#" + row.id + " [" + message.role + "] " + trunc(text, 2000));
			}
			continue;
		}
		for (const part of message.content ?? []) {
			if (part.type === "text") {
				const text: string = part.text ?? "";
				if (message.role === "toolResult") {
					if (/NOT STARTED: |is busy; your message is queued/.test(text)) bump("busy_queued", where);
					if (/notify is for agents working out of their sight/.test(text)) bump("notify_refused", where);
					if (/Validation failed for tool/.test(text)) bump("validation_failed", where);
					if (/Script error|Script failed/.test(text)) bump("script_failed", where);
					if (/Script timed out|timed out after/i.test(text)) bump("script_timeout", where);
					if (/ was aborted\)|\(cancelled\)/.test(text)) bump("child_lost", where);
					lines.push("#" + row.id + " [result] " + trunc(text, 600));
				} else lines.push("#" + row.id + " [" + message.role + "] " + trunc(text, 2000));
			} else if (part.type === "toolCall") {
				const code: string = part.arguments?.code ?? JSON.stringify(part.arguments ?? {});
				if (/systemd-run|crontab|\bnohup\b|\bat now\b/.test(code)) bump("side_scheduler", where);
				lines.push("#" + row.id + " [call " + part.name + "] " + trunc(code, 1200));
			}
		}
	}
}

const pending = existsSync(libraryFile) ? (readFileSync(libraryFile, "utf8").match(/\| pending \|/g) ?? []).length : 0;
const MIN_OWNER_TURNS = 10;
if (counts.owner_turns < MIN_OWNER_TURNS) process.exit(0);

mkdirSync(runDir, { recursive: true });
const ordered = [...transcripts.entries()].sort((a, b) => (a[0] === 1 ? -1 : b[0] === 1 ? 1 : b[1].length - a[1].length));
let total = 0;
const files: string[] = [];
for (const [conversation, lines] of ordered) {
	if (total >= TOTAL_CHARS || lines.length === 0) break;
	let text = lines.join("\n");
	if (text.length > PER_CONVERSATION_CHARS) text = "...[earlier entries cut]\n" + text.slice(-PER_CONVERSATION_CHARS);
	text = text.slice(0, TOTAL_CHARS - total);
	total += text.length;
	const file = join(runDir, "conversation-" + conversation + ".txt");
	writeFileSync(file, text);
	files.push(file);
}
const signals = { day, since: new Date(since).toISOString(), counts, rates: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, counts.owner_turns === 0 ? 0 : Number((value / counts.owner_turns).toFixed(3))])), examples, definitions: SIGNALS };
writeFileSync(join(runDir, "signals.json"), JSON.stringify(signals, null, 2));
writeFileSync(lastRunFile, new Date(now).toISOString() + "\n");
console.log(JSON.stringify({ home, library: libraryFile, runDir, pendingEdits: pending, counts, transcripts: files.length }));
