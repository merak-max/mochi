import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId, type Harness, LiveDoc } from "@earendil-works/pi-durable";
import type { Bubble, Channel } from "../channels/types.ts";
import { messageText } from "../text.ts";

/** A paragraph is done once a blank line follows it; the last paragraph of a partial may still grow. */
const PARAGRAPH_END = /\n[ \t]*\n/;

/** The paragraphs of a partial answer that a blank line has closed. */
export function closedParagraphs(text: string): string[] {
	const parts = text.split(PARAGRAPH_END);
	parts.pop();
	const closed: string[] = [];
	for (const part of parts) {
		const trimmed = part.trim();
		if (trimmed !== "") closed.push(trimmed);
	}
	return closed;
}

/** A line that holds a directive (attach:, voice:, effect:, reply:) waits for the full answer. */
const DIRECTIVE = /^[ \t]*(attach|voice|effect|reply):/m;

/**
 * Sends each closed paragraph of the conversation's in-flight answers as soon as it closes, while the run goes on.
 * `sent` lists the paragraph texts already sent, for the final send to skip; `onSent` saves it after each one.
 */
export function streamParagraphs(input: {
	readonly harness: Harness;
	readonly conversation: ConversationId;
	readonly channel: Channel;
	readonly person: string | undefined;
	readonly threadOn: string | undefined;
	readonly sent: string[];
	readonly onSent: (sent: readonly string[]) => Promise<void>;
	readonly onError: (error: unknown) => void;
}): () => Promise<void> {
	let queue = Promise.resolve();
	// The closed paragraphs already handled in the current generation; a new generation's text does not start with them.
	let handled: string[] = [];
	const unsubscribe = input.harness.subscribeCommits(({ changes }) => {
		for (const change of changes) {
			if (change.type !== "document" || change.record.kind !== LiveDoc.definition.kind || change.conversationId !== input.conversation) continue;
			const message = (change.value as { generation?: { message?: AssistantMessage } } | null)?.generation?.message;
			if (message === undefined) continue;
			const closed = closedParagraphs(messageText(message));
			let same = closed.length >= handled.length;
			for (let index = 0; same && index < handled.length; index++) same = closed[index] === handled[index];
			if (!same) handled = [];
			const fresh = closed.slice(handled.length);
			handled = closed;
			for (const paragraph of fresh) {
				if (DIRECTIVE.test(paragraph)) continue;
				queue = queue.then(async () => {
					const bubble: Bubble = { kind: "text", text: paragraph };
					const first = input.sent.length === 0 && input.threadOn !== undefined;
					await input.channel.send(bubble, input.person, first ? { replyTo: input.threadOn } : undefined);
					input.sent.push(paragraph);
					await input.onSent(input.sent);
				}).catch(input.onError);
			}
		}
	});
	return async () => {
		unsubscribe();
		await queue;
	};
}
