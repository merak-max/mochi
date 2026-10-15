import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { AgentDoc, AssistantEntry, type ConversationId, type Harness, LiveDoc } from "@earendil-works/pi-durable";

/**
 * Starts pi-durable's own compaction of a conversation once a request used more than `compactAt` of the model's context
 * window. pi-durable compacts only near the full window, which on a 1M-token model is never.
 */
export function watchCompaction(harness: Harness, models: Models, compactAt: number, context: Context, onError: (error: unknown) => void): () => void {
	const starting = new Set<ConversationId>();
	const check = async (conversation: ConversationId, used: number): Promise<void> => {
		const agent = await harness.snapshot(AgentDoc, conversation, context);
		if (agent?.model === undefined) return;
		const model = models.getModel(agent.model.provider, agent.model.modelId);
		if (model === undefined || used <= compactAt * model.contextWindow) return;
		if ((await harness.snapshot(LiveDoc, conversation, context))?.compactions !== undefined) return;
		const target = await harness.conversation(conversation, context);
		await target?.compact(undefined, context);
	};
	return harness.subscribeCommits(({ changes }) => {
		for (const change of changes) {
			if (change.type !== "entry" || !AssistantEntry.is(change.value)) continue;
			const message = change.value.model?.[0];
			if (message?.role !== "assistant") continue;
			const conversation = change.value.conversationId;
			if (starting.has(conversation)) continue;
			starting.add(conversation);
			const { input, cacheRead, cacheWrite } = message.usage;
			check(conversation, input + cacheRead + cacheWrite)
				.catch(onError)
				.finally(() => starting.delete(conversation));
		}
	});
}
