import { broken, off, ready, type Setup } from "../setup.ts";

export type ChatChannelId = "imessage" | "telegram" | "whatsapp";
/** `cli` is a view, not a line: attached terminals render replies from the transcript, and nothing is delivered to it. */
export type ChannelId = ChatChannelId | "cli";

/**
 * What a platform can show and how mochi writes for it. The single source for `present()`, typing, tapbacks and the
 * `channels` prompt line.
 */
export interface ChannelProfile {
	readonly id: ChatChannelId;
	/** One line for the `channels` section. Names the bubble rule, so the model and `present()` agree. */
	readonly style: string;
	/** A reply with more bubbles than this merges the rest into the last one. */
	readonly maxBubbles: number;
	/** A longer paragraph is split at a sentence end. */
	readonly maxBubbleChars: number;
	/** Blank-line-separated paragraphs become separate messages. */
	readonly paragraphsAreBubbles: boolean;
	/** Reactions this platform can show. Empty: the channel has no `react`. */
	readonly reactions: readonly Reaction[];
	/** The typing indicator stops after this long, so a long job is silent instead of "typing" for minutes. */
	readonly typingMaxMs: number;
}

/** The six iMessage tapbacks, the common set every channel maps to its own reaction. */
export const REACTIONS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
export type Reaction = (typeof REACTIONS)[number];

export interface Attachment {
	readonly kind: "image" | "audio" | "file";
	readonly mimeType: string;
	readonly bytes: Uint8Array;
}

/** What an adapter hands the sink. The owner or a configured guest: the adapter has already dropped everyone else. */
export type OwnerInbound =
	| {
			readonly kind: "message";
			readonly channel: ChatChannelId;
			readonly messageId: string;
			readonly text: string;
			readonly at: Date;
			readonly attachments: readonly Attachment[];
			/** The platform's durable event sequence, where it has one (iMessage). */
			readonly sequence?: number;
			/** A configured guest's normalized handle. Absent: the owner wrote it. */
			readonly person?: string;
	  }
	/** The owner reacted to a message. It becomes a passive transcript write, never a model turn. */
	| {
			readonly kind: "tapback";
			readonly channel: ChatChannelId;
			readonly messageId: string;
			readonly on: string;
			readonly reaction: Reaction | "none";
			readonly at: Date;
	  };

export type InboundSink = (inbound: OwnerInbound) => Promise<void>;

export type Bubble =
	| { readonly kind: "text"; readonly text: string }
	/** A URL alone. iMessage renders a link card; other channels send the URL as text. */
	| { readonly kind: "link"; readonly url: string }
	| { readonly kind: "file"; readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array };

/** Why a send failed. Each adapter maps every platform error to exactly one subclass. */
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
	/** Runs until `signal` aborts, never messaging the owner about itself. `cursor` reads the sequence `ingest` stored, for replay. */
	run(sink: InboundSink, signal: AbortSignal, cursor?: () => Promise<number | null>): Promise<void>;
	/** Throws only DeliveryError subclasses for platform failures. `person` absent: the owner. */
	send(bubble: Bubble, person?: string): Promise<void>;
	typing(on: boolean, person?: string): Promise<void>;
	/** Present only when `profile.reactions` is non-empty. `none` removes the reaction. */
	react?(messageId: string, reaction: Reaction | "none"): Promise<void>;
}

export type Channels = ReadonlyMap<ChatChannelId, Channel>;

export function attachmentKind(mimeType: string): Attachment["kind"] {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	return "file";
}

/** Splits at the last newline or space before `limit`, never inside a surrogate pair. */
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
		const code = rest.charCodeAt(limit - 1);
		const hard = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
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
