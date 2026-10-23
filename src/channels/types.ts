import { broken, off, ready, type Setup } from "../setup.ts";
import type { EffectName } from "./directives.ts";

export type ChatChannelId = "imessage" | "whatsapp";
/** `cli` is a view, not a line: attached terminals render replies from the transcript, and nothing is delivered to it. */
export type ChannelId = ChatChannelId | "cli";

export interface ChannelProfile {
	readonly id: ChatChannelId;
	readonly style: string;
	readonly maxBubbles: number;
	readonly paragraphsAreBubbles: boolean;
	/** The typing indicator stops after this long, so a long job is silent instead of "typing" for minutes. */
	readonly typingMaxMs: number;
}

/** One emoji, as the model picks it: "👍", "😂", "🫡". */
export type Reaction = string;

export interface Attachment {
	readonly kind: "image" | "audio" | "file";
	readonly mimeType: string;
	readonly bytes: Uint8Array;
}

/** The message an inbound message replies to. `text` is "" when the platform did not send it. */
export interface ReplyTarget {
	readonly messageId: string;
	readonly text: string;
	readonly fromAgent: boolean;
}

/** What an adapter hands the sink. The owner or a configured user: the adapter has already dropped everyone else. */
export type Inbound =
	| {
			readonly kind: "message";
			readonly channel: ChatChannelId;
			readonly messageId: string;
			readonly text: string;
			readonly at: Date;
			readonly attachments: readonly Attachment[];
			/** A configured user's normalized handle. Absent: the owner wrote it. */
			readonly person?: string;
			readonly replyTo?: ReplyTarget;
	  }
	/** The owner or a user reacted to a message. It becomes a passive transcript write, never a model turn. */
	| {
			readonly kind: "tapback";
			readonly channel: ChatChannelId;
			/** The reaction event's own id, so a redelivery dedupes. */
			readonly messageId: string;
			readonly on: string;
			readonly emoji: string;
			readonly onText: string;
			readonly fromAgent: boolean;
			/** A configured user's normalized handle. Absent: the owner reacted. */
			readonly person?: string;
			readonly at: Date;
	  };

/** A message mochi sent: the platform's id and the text it showed. */
export interface SentBubble {
	readonly id: string;
	readonly text: string;
}

export type InboundSink = (inbound: Inbound) => Promise<void>;

export type Bubble =
	/** `effect`: an iMessage send effect; other channels ignore it. */
	| { readonly kind: "text"; readonly text: string; readonly effect?: EffectName }
	/** A URL alone. iMessage renders a link card; other channels send the URL as text. */
	| { readonly kind: "link"; readonly url: string }
	/** `voice`: send audio as a voice message where the channel has one, else as a plain file. */
	| { readonly kind: "file"; readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array; readonly voice?: boolean };

/** What the message tool asks of a channel beyond sending bubbles. A channel without `message` supports none of it. */
export type MessageRequest =
	| { readonly action: "sent" }
	| { readonly action: "edit"; readonly messageId?: string; readonly text: string }
	| { readonly action: "unsend"; readonly messageId?: string }
	| { readonly action: "poll"; readonly title: string; readonly options: readonly string[] }
	/** No fields: share mochi's own contact card. */
	| { readonly action: "contact"; readonly name?: string; readonly phone?: string; readonly email?: string }
	| { readonly action: "read" };

export class DeliveryError extends Error {}
/** The bubble never left: reconnecting, service unreachable, or the channel is not running in this process. Retry. */
export class ChannelDown extends DeliveryError {
	override readonly name = "ChannelDown";
}
/** The outcome is unknown, such as a timeout mid-request on a live connection. Retry once and accept a duplicate. */
export class SendUnknown extends DeliveryError {
	override readonly name = "SendUnknown";
}
/** The provider refused this bubble for good, such as an attachment type it will not take. Skip it. */
export class SendRejected extends DeliveryError {
	override readonly name = "SendRejected";
}

export interface Channel {
	readonly profile: ChannelProfile;
	/** Runs until `signal` aborts, never messaging the owner about itself. */
	run(sink: InboundSink, signal: AbortSignal): Promise<void>;
	/** Throws only DeliveryError subclasses for platform failures. `person` absent: the owner. */
	/** Resolves to each platform message it sent, where the platform returns an id. */
	send(bubble: Bubble, person?: string, options?: { readonly replyTo?: string }): Promise<readonly SentBubble[]>;
	typing(on: boolean, person?: string): Promise<void>;
	react?(messageId: string, reaction: Reaction | "none"): Promise<void>;
	/** Resolves to one line for the model. */
	message?(request: MessageRequest): Promise<string>;
}


export type Channels = ReadonlyMap<ChatChannelId, Channel>;

export function attachmentKind(mimeType: string): Attachment["kind"] {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	return "file";
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Splits at the last newline or space before `limit`, else at the last grapheme boundary, so no emoji or letter breaks. */
export function chunkText(text: string, limit: number): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const soft = Math.max(rest.lastIndexOf("\n", limit), rest.lastIndexOf(" ", limit));
		if (soft > 0) {
			chunks.push(rest.slice(0, soft));
			rest = rest.slice(soft + 1);
			continue;
		}
		let hard = 0;
		for (const { index, segment } of graphemes.segment(rest)) {
			const end = index + segment.length;
			if (end > limit && hard > 0) break;
			hard = end;
			if (end >= limit) break;
		}
		chunks.push(rest.slice(0, hard));
		rest = rest.slice(hard);
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * A channel's readiness from its variables: `off` when none is set, `broken` naming the missing ones when some are, and
 * `broken` with the message when `create` rejects a value.
 */
export function channelSetup<const N extends string>(env: Env, names: readonly N[], create: (values: Readonly<Record<N, string>>) => Channel): Setup<Channel> {
	const missing = names.filter((name) => !env[name]);
	if (missing.length === names.length) return off;
	if (missing.length > 0) return broken(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. Fix: export ${missing.length === 1 ? "it" : "them"} where mochi starts`);
	try {
		return ready(create(Object.fromEntries(names.map((name) => [name, env[name]!])) as Record<N, string>));
	} catch (error) {
		return broken(error instanceof Error ? error.message : String(error));
	}
}
