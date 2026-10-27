import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineTool, type DocumentReader, type PromptSection, section, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import { prompt } from "./prompts.ts";

// A context value is text held outside the model's window: an immutable file named by its content hash, and a
// descriptor in the conversation's catalog under an immutable key. Inbound text longer than INLINE_MAX reaches the model
// as a header and a preview; scripts read the rest with context_read. Nothing is dropped.
//
// Keys:
//   in:<request id>   inbound text, held under the request id of the submission that carries it
//   put:<task id>     a script's context_put, keyed by its nested tool task

/** A reading budget, not a storage cap: longer text goes to a file and the model sees its head and tail. */
const INLINE_MAX = 8_192;
const PREVIEW_HEAD = 1_500;
const PREVIEW_TAIL = 500;
const PAGE_CHARS = 65_536;

type ContextDescriptor = {
	/** sha256 of the text, first 32 hex chars. */
	readonly digest: string;
	/** Relative to the work dir. */
	readonly path: string;
	readonly chars: number;
	readonly lines: number;
	/** ms since epoch of the first record; a replay keeps it. */
	readonly at: number;
};

/** Key to descriptor, per conversation. A fork sees its parent's values as of the fork point. */
const ContextDoc = defineDoc<{ values: Record<string, ContextDescriptor> }>({
	kind: "mochi.context",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ values: {} }),
	checkpointWhen: () => false,
});

/** A harness, a tool api, or a task runtime. */
export interface Committer {
	commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<unknown>;
}

const count = (value: number): string => value.toLocaleString("en-US");

/**
 * Writes the file once: a temp name then a rename, so a crash never leaves half a file under the final name. The file
 * and the directory are synced before the catalog commit names the file.
 */
async function writeBody(workDir: string, text: string): Promise<{ digest: string; path: string }> {
	const digest = createHash("sha256").update(text).digest("hex").slice(0, 32);
	const path = join("context", `${digest}.txt`);
	const full = join(workDir, path);
	if (existsSync(full)) return { digest, path };
	await mkdir(join(workDir, "context"), { recursive: true });
	const temp = `${full}.${randomUUID()}.tmp`;
	const file = await open(temp, "w");
	try {
		await file.writeFile(text);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temp, full);
	const dir = await open(join(workDir, "context"), "r");
	try {
		await dir.sync();
	} finally {
		await dir.close();
	}
	return { digest, path };
}

/**
 * The same key and text record once; the same key with other text is a bug, so it throws. Returns a plain copy,
 * because a document draft is unusable once its commit settles.
 */
function record(values: Record<string, ContextDescriptor>, key: string, descriptor: ContextDescriptor): ContextDescriptor {
	const found = values[key];
	if (found === undefined) {
		values[key] = descriptor;
		return descriptor;
	}
	if (found.digest !== descriptor.digest) throw new Error(`Context key ${key} already holds other text.`);
	return { ...found };
}

async function keep(host: Committer, workDir: string, conversation: ConversationId, key: string, text: string, context: Context): Promise<ContextDescriptor> {
	const { digest, path } = await writeBody(workDir, text);
	const fresh: ContextDescriptor = { digest, path, chars: text.length, lines: text.split("\n").length, at: Date.now() };
	let kept = fresh;
	await host.commit(async (tx) => {
		kept = record((await tx.doc(ContextDoc, conversation)).values, key, fresh);
		return undefined;
	}, context);
	return kept;
}

/**
 * The one owner of inbound text. Text up to INLINE_MAX returns as it is. Longer text is kept under key and the model
 * gets a header and a preview. The result depends only on key and text, so a replay submits identical content.
 */
export async function holdText(host: Committer, workDir: string, conversation: ConversationId, key: string, text: string, context: Context): Promise<string> {
	if (text.length <= INLINE_MAX) return text;
	const held = await keep(host, workDir, conversation, key, text, context);
	const hidden = held.chars - PREVIEW_HEAD - PREVIEW_TAIL;
	return [
		`[context ${key}: ${count(held.chars)} chars, ${count(held.lines)} lines, held outside this window. Read it: await tools.context_read({ key: "${key}" })]`,
		text.slice(0, PREVIEW_HEAD),
		`[... ${count(hidden)} chars not shown ...]`,
		text.slice(-PREVIEW_TAIL),
	].join("\n");
}

/** Copies the named descriptors from one conversation to another, after the creating write of the same commit. */
export async function copyContext(tx: Tx, from: ConversationId, to: ConversationId, keys: readonly string[]): Promise<void> {
	if (keys.length === 0) return;
	const source = (await tx.doc(ContextDoc, from)).values;
	const target = (await tx.doc(ContextDoc, to)).values;
	for (const key of keys) {
		const descriptor = source[key];
		if (descriptor === undefined) throw new Error(`No context value ${key} here. Keys: ${Object.keys(source).join(", ") || "none"}.`);
		record(target, key, descriptor);
	}
}

async function catalogOf(read: Pick<DocumentReader, "snapshot">, conversation: ConversationId, context: Context): Promise<Readonly<Record<string, ContextDescriptor>>> {
	return (await read.snapshot(ContextDoc, conversation, context))?.values ?? {};
}

export function contextFns(workDir: string): ToolRegistration[] {
	const Listed = Type.Object({ key: Type.String(), chars: Type.Number(), lines: Type.Number(), path: Type.String(), at: Type.Number() });
	return [
		defineTool({
			name: "context_read",
			description:
				`A page of a context value (long input, or a context_put value). Default page ${count(PAGE_CHARS)} chars; next is the following offset or null. Peek with a small length, then filter in code.`,
			parameters: Type.Object({ key: Type.String({ minLength: 1 }), offset: Type.Optional(Type.Integer({ minimum: 0 })), length: Type.Optional(Type.Integer({ minimum: 1 })) }),
			structuredOutputSchema: Type.Object({ text: Type.String(), next: Type.Union([Type.Integer(), Type.Null()]), chars: Type.Integer() }),
			replay: "safe",
			execute: async ({ key, offset, length }, api, context) => {
				const catalog = await catalogOf(api, api.conversationId, context);
				const descriptor = catalog[key];
				if (descriptor === undefined) throw new Error(`No context value ${key} here. Keys: ${Object.keys(catalog).join(", ") || "none"}.`);
				const text = await readFile(join(workDir, descriptor.path), "utf8");
				const from = offset ?? 0;
				const to = Math.min(text.length, from + (length ?? PAGE_CHARS));
				return { structuredOutput: { text: text.slice(from, to), next: to < text.length ? to : null, chars: text.length } };
			},
		}),
		defineTool({
			name: "context_put",
			description:
				"Keep text of any size outside your window for later scripts and agent jobs. path is the file, for grep.",
			parameters: Type.Object({ text: Type.String() }),
			structuredOutputSchema: Type.Object({ key: Type.String(), chars: Type.Integer(), lines: Type.Integer(), path: Type.String() }),
			replay: "safe",
			execute: async ({ text }, api, context) => {
				const key = `put:${api.taskId}`;
				const kept = await keep(api, workDir, api.conversationId, key, text, context);
				return { structuredOutput: { key, chars: kept.chars, lines: kept.lines, path: join(workDir, kept.path) } };
			},
		}),
		defineTool({
			name: "context_list",
			description: "The context values of this conversation, oldest first, optionally only keys with a prefix.",
			parameters: Type.Object({ prefix: Type.Optional(Type.String()) }),
			structuredOutputSchema: Type.Array(Listed),
			replay: "safe",
			execute: async ({ prefix }, api, context) => {
				const catalog = await catalogOf(api, api.conversationId, context);
				const listed = [];
				for (const [key, descriptor] of Object.entries(catalog)) {
					if (prefix !== undefined && !key.startsWith(prefix)) continue;
					listed.push({ key, chars: descriptor.chars, lines: descriptor.lines, path: join(workDir, descriptor.path), at: descriptor.at });
				}
				listed.sort((a, b) => a.at - b.at);
				return { structuredOutput: listed };
			},
		}),
	];
}

/**
 * The names a conversation still holds outside its window, so they survive compaction: context keys and store() keys.
 * A change reaches the next request as a delta, so the prompt cache stays warm.
 */
export function contextSection(): PromptSection {
	return section("context", async (input, context) => {
		const lines: string[] = [];
		const catalog = await catalogOf(input.read, input.conversationId, context);
		for (const key of Object.keys(catalog).sort()) {
			const descriptor = catalog[key]!;
			lines.push(`${key}  ${count(descriptor.chars)} chars, ${count(descriptor.lines)} lines`);
		}
		const store = (await input.read.snapshot(CodemodeStoreDoc, input.conversationId, context))?.values ?? {};
		const stored: string[] = [];
		for (const key of Object.keys(store).sort()) stored.push(`${key} (${count(JSON.stringify(store[key]).length)} chars)`);
		if (lines.length === 0 && stored.length === 0) return undefined;
		const out = [prompt("sections/context")];
		out.push(...lines);
		if (stored.length > 0) out.push(`store: ${stored.join(", ")}`);
		return out.join("\n");
	});
}
