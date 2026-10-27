import type { Context } from "@earendil-works/chord";
import { contentText, type Models, Type } from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import {
	type Conversation,
	defineTool,
	type ModelRef,
	ResetEntry,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { prompt } from "../prompts.ts";

export type FastCompletion = (request: { readonly system: string; readonly prompt: string }, context: Context) => Promise<string>;

export function fastCompletion(models: Models, fast: ModelRef): FastCompletion {
	return async ({ system, prompt }, context) => {
		const model = models.getModel(fast.provider, fast.modelId);
		if (model === undefined) throw new Error("Fast model is not configured.");
		const response = await models.completeSimple(model, {
			systemPrompt: system,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		}, { ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }), maxTokens: model.maxTokens, cacheRetention: "none" });
		if (response.stopReason !== "stop" || response.content.some((part) => part.type === "toolCall")) throw new Error(`Fast model did not finish: ${response.stopReason}${response.errorMessage === undefined ? "" : ` (${response.errorMessage})`}.`);
		const text = contentText(response.content).trim();
		if (text === "") throw new Error("Fast summary was empty.");
		return text;
	};
}

export async function threadHandoff(root: Conversation, fast: FastCompletion, context: Context): Promise<string | undefined> {
	try {
		const view = await root.context(context);
		const tail = serializeConversation(view.messages.slice(-32));
		if (tail === "") return undefined;
		const note = await fast({
			system: prompt("turn/handoff-note"),
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
