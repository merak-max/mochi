import type { Context } from "@earendil-works/chord";
import { type Message, type Models, Type } from "@earendil-works/pi-ai";
import {
	CompactionTask,
	type Conversation,
	defineExtension,
	defineTool,
	type EntryRecord,
	type Harness,
	hook,
	LiveDoc,
	type ModelRef,
	ResetEntry,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { messageText } from "../text.ts";

export type FastCompletion = (request: { readonly system: string; readonly prompt: string; readonly maxTokens: number }, context: Context) => Promise<string>;

export function fastCompletion(models: Models, fast: ModelRef): FastCompletion {
	return async ({ system, prompt, maxTokens }, context) => {
		const model = models.getModel(fast.provider, fast.modelId);
		if (model === undefined) throw new Error("Fast model is not configured.");
		const response = await models.completeSimple(model, {
			systemPrompt: system,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		}, { ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }), reasoning: "low", cacheRetention: "none", maxTokens: Math.min(model.maxTokens, maxTokens) });
		if (response.stopReason !== "stop" || response.content.some((part) => part.type === "toolCall")) throw new Error("Fast summary did not finish.");
		const text = messageText(response).trim();
		if (text === "") throw new Error("Fast summary was empty.");
		return text;
	};
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work. If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export function serializeConversation(messages: readonly Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = messageText(message);
			if (text !== "") parts.push(`[User]: ${text}`);
		} else if (message.role === "assistant") {
			const thinking = message.content.flatMap((part) => part.type === "thinking" ? [part.thinking] : []);
			const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
			const calls = message.content.flatMap((part) => part.type === "toolCall" ? [
				`${part.name}(${Object.entries(part.arguments).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")})`,
			] : []);
			if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
			if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`);
			if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (message.role === "toolResult") {
			const text = messageText(message);
			if (text !== "") parts.push(`[Tool result]: ${text.length <= 2000 ? text : `${text.slice(0, 2000)}\n\n[... ${text.length - 2000} more characters truncated]`}`);
		}
	}
	return parts.join("\n\n");
}

export function compactionExtension(fast: FastCompletion) {
	return defineExtension({
		name: "fast-compaction",
		hooks: [hook(CompactionTask, {
			beforeCompact: async (input, api, context) => {
				try {
					const existing = await api.memo<string>("mochi.compaction.summary", context);
					if (existing !== undefined) return { summary: existing };
					const focus = input.instructions === undefined ? "" : `\n\nAdditional focus: ${input.instructions}`;
					const summary = await fast({
						system: SUMMARIZATION_SYSTEM_PROMPT,
						prompt: `<conversation>\n${serializeConversation(input.messages)}\n</conversation>\n\n${SUMMARIZATION_PROMPT}${focus}`,
						maxTokens: 12_000,
					}, context);
					if (summary.trim() === "") return undefined;
					return { summary: await api.memo("mochi.compaction.summary", summary, context) };
				} catch {
					return undefined;
				}
			},
		})],
	});
}

export const newestEntryTime = (entries: readonly EntryRecord[]): number | undefined => {
	const newest = entries.at(-1);
	if (newest === undefined) return undefined;
	const timestamps = (newest.model ?? []).map((message) => message.timestamp);
	if (timestamps.length > 0) return Math.max(...timestamps);
	if (newest.data !== null && typeof newest.data === "object" && "at" in newest.data && typeof newest.data.at === "number") return newest.data.at;
	return undefined;
};

export async function threadHandoff(root: Conversation, fast: FastCompletion, context: Context): Promise<string | undefined> {
	try {
		const view = await root.context(context);
		const tail = serializeConversation(view.messages.slice(-32)).slice(-24_000);
		if (tail === "") return undefined;
		const note = await fast({
			system: "Write only a handoff note, at most 8 short lines. Keep open threads and promises, exact names and dates. Do not answer or continue the conversation. Omit completed work. No headings. Return an empty string if nothing is open.",
			prompt: `<conversation>\n${tail}\n</conversation>`,
			maxTokens: 600,
		}, context);
		return note.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 8).join("\n") || undefined;
	} catch {
		return undefined;
	}
}

// reset() has no requestId. This is its exact ResetEntry write with a replay key.
export async function keyedReset(root: Conversation, key: string, handoff: string | undefined, now: number, context: Context): Promise<SubmissionId> {
	const submission = await root.submit({
		type: "write",
		requestId: key,
		entry: {
			kind: ResetEntry.kind,
			head: "self",
			data: { at: now },
			...(handoff === undefined ? {} : { model: [{ role: "user", content: handoff, timestamp: now }] }),
		},
	}, context);
	await submission.wait(context);
	return submission.id;
}

export async function idleResetIfStale(
	deps: { readonly harness: Harness; readonly root: Conversation; readonly fast: FastCompletion; readonly idleResetMinutes: number; readonly now: () => number },
	key: string,
	context: Context,
): Promise<boolean> {
	const resetKey = `idle-reset:${key}`;
	const existing = await deps.harness.commit((tx) => tx.submissionByRequest(deps.root.id, resetKey), context);
	if (existing !== undefined) {
		await (await deps.harness.submission(existing.id, context))?.wait(context);
		return true;
	}
	if (deps.idleResetMinutes <= 0) return false;
	const live = await deps.harness.snapshot(LiveDoc, deps.root.id, context);
	if (live?.run !== undefined) return false;
	const view = await deps.root.context(context);
	const at = newestEntryTime(view.entries);
	if (at === undefined || deps.now() - at <= deps.idleResetMinutes * 60_000) return false;
	const handoff = await threadHandoff(deps.root, deps.fast, context);
	const current = await deps.root.context(context);
	const busy = await deps.harness.snapshot(LiveDoc, deps.root.id, context);
	if (busy?.run !== undefined || current.entries.at(-1)?.id !== view.entries.at(-1)?.id) return false;
	await keyedReset(deps.root, resetKey, handoff, deps.now(), context);
	return true;
}

export function handoffTool() {
	return defineTool({
		name: "handoff",
		description: "Start a fresh context from a note and continue. Older messages stay searchable.",
		parameters: Type.Object({ note: Type.String({ minLength: 1, maxLength: 4000 }) }),
		replay: "safe",
		execute: async ({ note }, api, context) => {
			const self = await api.conversation(api.conversationId, context);
			if (self === undefined) throw new Error("Handoff conversation is missing.");
			await self.submit({ type: "input", content: "Continue.", requestId: `handoff:${api.taskId}`, whenBusy: "followUp" }, context);
			return { content: [{ type: "text", text: "Handing off." }], control: { handoff: note } };
		},
	});
}
