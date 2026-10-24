import type { Context } from "@earendil-works/chord";
import { contentText, type Message, type Models, Type } from "@earendil-works/pi-ai";
import {
	type Conversation,
	defineTool,
	type ModelRef,
	ResetEntry,
	type SubmissionId,
} from "@earendil-works/pi-durable";

export type FastCompletion = (request: { readonly system: string; readonly prompt: string }, context: Context) => Promise<string>;

export function fastCompletion(models: Models, fast: ModelRef): FastCompletion {
	return async ({ system, prompt }, context) => {
		const model = models.getModel(fast.provider, fast.modelId);
		if (model === undefined) throw new Error("Fast model is not configured.");
		const response = await models.completeSimple(model, {
			systemPrompt: system,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		}, { ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }), reasoning: "low", cacheRetention: "none", maxTokens: model.maxTokens });
		if (response.stopReason !== "stop" || response.content.some((part) => part.type === "toolCall")) throw new Error(`Fast model did not finish: ${response.stopReason}${response.errorMessage === undefined ? "" : ` (${response.errorMessage})`}.`);
		const text = contentText(response.content).trim();
		if (text === "") throw new Error("Fast summary was empty.");
		return text;
	};
}

function serializeConversation(messages: readonly Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content);
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
			const text = contentText(message.content);
			if (text !== "") parts.push(`[Tool result]: ${text}`);
		}
	}
	return parts.join("\n\n");
}

export async function threadHandoff(root: Conversation, fast: FastCompletion, context: Context): Promise<string | undefined> {
	try {
		const view = await root.context(context);
		const tail = serializeConversation(view.messages.slice(-32));
		if (tail === "") return undefined;
		const note = await fast({
			system: "Write only a handoff note, at most 8 short lines. Keep open threads and promises, exact names and dates. Do not answer or continue the conversation. Omit completed work. No headings. Return an empty string if nothing is open.",
			prompt: `<conversation>\n${tail}\n</conversation>`,
		}, context);
		return note.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n") || undefined;
	} catch {
		return undefined;
	}
}

// reset() has no requestId. This is its exact ResetEntry write with a replay key.
export async function keyedReset(root: Pick<Conversation, "submit">, key: string, handoff: string | undefined, now: number, context: Context): Promise<SubmissionId> {
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

export function handoffTool() {
	return defineTool({
		name: "handoff",
		description: "Start a fresh context from a note and continue. The older messages leave the view.",
		parameters: Type.Object({ note: Type.String({ minLength: 1 }) }),
		replay: "safe",
		execute: async ({ note }, api, context) => {
			const record = await api.commit((tx) => tx.conversation(api.conversationId), context);
			if (record?.owner !== undefined) throw new Error("Your answer goes back to the agent that started you, so finish instead of handing off.");
			const self = await api.conversation(api.conversationId, context);
			if (self === undefined) throw new Error("Handoff conversation is missing.");
			await self.submit({ type: "input", content: "Continue.", requestId: `handoff:${api.taskId}`, whenBusy: "followUp" }, context);
			return { output: [{ type: "text", text: "Handing off." }], control: { handoff: note } };
		},
	});
}
