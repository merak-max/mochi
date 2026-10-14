import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, type EntryRecord, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { allPages } from "../src/pages.ts";
import { clip, messageText } from "../src/text.ts";

const context = BACKGROUND_CONTEXT;

export type Item =
	| { readonly kind: "owner"; readonly entry: number; readonly text: string }
	| { readonly kind: "reply"; readonly entry: number; readonly text: string; readonly model: string }
	| { readonly kind: "call"; readonly entry: number; readonly id: string; readonly tool: string; readonly args: string }
	| { readonly kind: "result"; readonly entry: number; readonly id: string; readonly tool: string; readonly ok: boolean; readonly text: string }
	| { readonly kind: "system"; readonly entry: number; readonly sections: Readonly<Record<string, string | null>>; readonly tools: readonly string[] }
	| { readonly kind: "reset" | "compaction"; readonly entry: number; readonly text: string }
	| { readonly kind: "notify"; readonly entry: number; readonly text: string };

export type Transcript = {
	readonly conversations: readonly { readonly id: number; readonly owner: string; readonly items: readonly Item[] }[];
	readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly cost: number };
};

/** Every conversation of a stopped mochi data directory, oldest entry first. Opens the storage without resuming work. */
export async function dump(dataDir: string): Promise<Transcript> {
	const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "mochi.sqlite")), { models: createModels(), registry: createRegistry() }, context);
	try {
		const records = await allPages((cursor) => harness.commit((tx) => tx.scanConversations({}, 100, cursor), context));
		const conversations = [];
		for (const record of records.sort((a, b) => a.id - b.id)) {
			const entries = await allPages((cursor) => harness.commit((tx) => tx.scanEntries({ conversationId: record.id }, 200, cursor), context));
			conversations.push({ id: record.id, owner: record.owner === undefined ? "" : `owned by ${record.owner.conversationId}`, items: entries.reverse().flatMap(items) });
		}
		const usage = await harness.usage(context);
		const models = Object.values(usage.models);
		const sum = (pick: (u: (typeof models)[number]) => number) => models.reduce((total, u) => total + pick(u), 0);
		return {
			conversations,
			usage: { input: sum((u) => u.input), output: sum((u) => u.output), cacheRead: sum((u) => u.cacheRead), cacheWrite: sum((u) => u.cacheWrite), cost: sum((u) => u.cost.total) },
		};
	} finally {
		await harness.close(context);
	}
}

const callNames = new Map<string, string>();

function items(entry: EntryRecord): Item[] {
	if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") return [{ kind: entry.kind === "pi.reset" ? "reset" : "compaction", entry: entry.id, text: (entry.model ?? []).map(text).join("\n") }];
	if (entry.kind === "app.notify") return [{ kind: "notify", entry: entry.id, text: String((entry.data as { text?: string } | undefined)?.text ?? "") }];
	return (entry.model ?? []).flatMap((message): Item[] => {
		switch (message.role) {
			case "system":
				return [{ kind: "system", entry: entry.id, sections: message.sections ?? {}, tools: (message.toolsAdded ?? []).map((tool) => tool.name) }];
			case "user":
				return [{ kind: "owner", entry: entry.id, text: text(message) }];
			case "assistant": {
				const out: Item[] = [];
				const said = text(message).trim();
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					callNames.set(part.id, part.name);
					out.push({ kind: "call", entry: entry.id, id: part.id, tool: part.name, args: JSON.stringify(part.arguments) });
				}
				if (said !== "") out.push({ kind: "reply", entry: entry.id, text: said, model: message.model });
				return out;
			}
			case "toolResult":
				return [{ kind: "result", entry: entry.id, id: message.toolCallId, tool: message.toolName ?? callNames.get(message.toolCallId) ?? "?", ok: message.isError !== true, text: text(message) }];
			default:
				return [];
		}
	});
}

function text(message: Message): string {
	if (message.role !== "system") return messageText(message);
	return typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join("");
}

/** A transcript as the owner and a reviewer read it. */
export function render(transcript: Transcript): string {
	const lines: string[] = [];
	for (const conversation of transcript.conversations) {
		lines.push(`## conversation ${conversation.id} ${conversation.owner}`);
		for (const item of conversation.items) {
			switch (item.kind) {
				case "owner":
					lines.push(`\nOWNER: ${item.text}`);
					break;
				case "reply":
					lines.push(`MOCHI: ${item.text}`);
					break;
				case "call":
					lines.push(`  -> ${item.tool} ${clip(item.args, 400)}`);
					break;
				case "result":
					lines.push(`  <- ${item.ok ? "ok" : "ERROR"} ${clip(item.text.replaceAll("\n", " | "), 300)}`);
					break;
				case "system":
					lines.push(`  [system: ${Object.keys(item.sections).join(", ")}${item.tools.length === 0 ? "" : `; ${item.tools.length} tools`}]`);
					break;
				case "notify":
					lines.push(`NOTIFY: ${item.text}`);
					break;
				default:
					lines.push(`  [${item.kind}] ${clip(item.text, 400)}`);
			}
		}
		lines.push("");
	}
	const u = transcript.usage;
	lines.push(`usage: in ${u.input} out ${u.output} cacheRead ${u.cacheRead} cacheWrite ${u.cacheWrite} cost $${u.cost.toFixed(4)}`);
	return lines.join("\n");
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (dir === undefined) throw new Error("Usage: node eval/dump.ts <dataDir>");
	process.stdout.write(`${render(await dump(dir))}\n`);
}
