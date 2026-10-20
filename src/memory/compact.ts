import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type ConversationId, type Harness, LiveDoc } from "@earendil-works/pi-durable";

/**
 * Starts pi-durable's own compaction of a conversation once a request sent more than `compactTokens`. pi-durable compacts
 * only near the full window, which on a 1M-token model is never. As in uniichat, the window stays small on every model:
 * compaction keeps the newest turns verbatim and the turn log's summary lines for the rest.
 */
export function watchCompaction(harness: Harness, compactTokens: number, context: Context, onError: (error: unknown) => void): () => void {
	const starting = new Set<ConversationId>();
	const check = async (conversation: ConversationId, used: number): Promise<void> => {
		if (used <= compactTokens) return;
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
